import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { CodexAppServerClient, type CodexTransport } from "./codexAppServer.js";
import type { TimelineItem, AgentSessionStatus, PendingServerRequest } from "@perch/shared";

// A scripted codex app-server over PassThrough streams: parses the client's
// NDJSON requests, auto-replies to lifecycle methods, and can push arbitrary
// notifications / server->client approval requests. No child process, no codex.
class MockCodexServer {
  toClient = new PassThrough(); // the client's stdout
  fromClient = new PassThrough(); // the client's stdin
  requests: Array<{ id?: string | number; method?: string; params?: any; result?: any }> = [];
  private buf = "";
  private responders = new Map<string, (params: any) => unknown>();

  constructor() {
    this.fromClient.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString();
      let idx: number;
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        this.requests.push(msg);
        if (msg.id != null && msg.method && this.responders.has(msg.method)) {
          this.reply(msg.id, this.responders.get(msg.method)!(msg.params));
        }
      }
    });
    // Sensible defaults; individual tests override as needed.
    this.auto("initialize", () => ({}));
    this.auto("thread/start", () => ({ thread: { id: "thr_1" }, model: "gpt-5.5" }));
    this.auto("thread/resume", () => ({ thread: { id: "thr_1" }, model: "gpt-5.5" }));
    this.auto("turn/start", () => ({ turn: { id: "turn_1" } }));
    this.auto("turn/interrupt", () => ({ abortReason: "interrupted" }));
    this.auto("model/list", () => ({ models: [{ id: "gpt-5.5" }, { id: "gpt-5.5-codex" }] }));
  }

  auto(method: string, fn: (params: any) => unknown): void {
    this.responders.set(method, fn);
  }
  reply(id: string | number, result: unknown): void {
    this.toClient.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }
  push(method: string, params: unknown): void {
    this.toClient.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  requestToClient(id: string | number, method: string, params: unknown): void {
    this.toClient.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  }
  find(method: string): { id?: string | number; params?: any } | undefined {
    return this.requests.find((r) => r.method === method);
  }
  transport(): CodexTransport {
    return {
      stdin: this.fromClient,
      stdout: this.toClient,
      stderr: null,
      pid: undefined,
      onExit: () => {},
      kill: () => {}
    };
  }
}

function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectedClient(overrides: Partial<{
  onTimelineItem: (i: TimelineItem) => void;
  onStatus: (s: AgentSessionStatus) => void;
  approvalHandler: (r: any) => Promise<any>;
  onServerRequest: (request: PendingServerRequest) => void;
  onServerRequestResolved: (request: PendingServerRequest) => void;
  onAssistantStream: (ev: { itemId: string; text: string; done: boolean }) => void;
  onTurnComplete: (ev: { message: string }) => void;
  onTurnStarted: () => void;
  onUsageLimit: (ev: { provider: string; retryAt?: string; source?: string }) => void;
}> = {}): Promise<{ client: CodexAppServerClient; server: MockCodexServer }> {
  const server = new MockCodexServer();
  const client = new CodexAppServerClient({
    sessionId: "sess_1",
    spawn: () => server.transport(),
    ...overrides
  });
  await client.connect();
  return { client, server };
}

test("structured app-server usageLimitExceeded fires without terminal text", async () => {
  const limits: Array<{ provider: string; retryAt?: string; source?: string }> = [];
  const { server } = await connectedClient({ onUsageLimit: (limit) => limits.push(limit) });
  server.push("turn/error", { type: "usageLimitExceeded", message: "out of credits", retryAt: "2026-07-10T22:00:00Z" });
  await tick();
  assert.deepEqual(limits, [{ provider: "codex", message: "out of credits", retryAt: "2026-07-10T22:00:00Z", source: "app_server" }]);
});

test("connect performs the initialize handshake then initialized notification", async () => {
  const { server } = await connectedClient();
  await tick();
  assert.equal(server.find("initialize")?.params?.capabilities?.experimentalApi, true);
  assert.ok(server.requests.some((r) => r.method === "initialized" && r.id == null));
});

test("startThread returns the thread id/model and remembers it", async () => {
  const { client } = await connectedClient();
  const result = await client.startThread({ cwd: "/repo" });
  assert.equal(result.threadId, "thr_1");
  assert.equal(result.model, "gpt-5.5");
  assert.equal(client.threadId, "thr_1");
});

test("submitTurn folds model + effort into turn/start", async () => {
  const { client, server } = await connectedClient();
  await client.startThread();
  await client.submitTurn("do it", { model: "gpt-5.5-codex", effort: "high" });
  const params = server.find("turn/start")?.params;
  assert.equal(params.model, "gpt-5.5-codex");
  assert.equal(params.effort, "high");
  assert.deepEqual(params.input, [{ type: "text", text: "do it" }]);
  assert.equal(params.threadId, "thr_1");
});

test("submitTurn omits an empty/blank model (never sends model='')", async () => {
  const { client, server } = await connectedClient();
  await client.startThread();
  await client.submitTurn("hello", { model: "   " });
  const params = server.find("turn/start")?.params;
  assert.ok(!("model" in params), "empty model must be omitted, not sent as ''");
});

test("submitTurn rejects provider-prefixed gateway ids before turn/start", async () => {
  const { client, server } = await connectedClient();
  await client.startThread();
  const turnStartsBefore = server.requests.filter((r) => r.method === "turn/start").length;
  await assert.rejects(
    () => client.submitTurn("hello", { model: "openai/gpt-5.6-sol" }),
    /not a local runtime id/
  );
  const turnStartsAfter = server.requests.filter((r) => r.method === "turn/start").length;
  assert.equal(turnStartsAfter, turnStartsBefore);
});

test("setModelForNextTurn applies to the next turn only, then clears", async () => {
  const { client, server } = await connectedClient();
  await client.startThread();
  client.setModelForNextTurn("gpt-5.5-codex", "medium");
  await client.submitTurn("first");
  assert.equal(server.find("turn/start")?.params?.model, "gpt-5.5-codex");

  server.requests.length = 0; // forget the first turn
  await client.submitTurn("second");
  const second = server.find("turn/start")?.params;
  assert.ok(!("model" in second), "override must not persist to a later turn");
});

test("setModelForNextTurn drops an empty model", async () => {
  const { client, server } = await connectedClient();
  await client.startThread();
  client.setModelForNextTurn("");
  await client.submitTurn("hi");
  assert.ok(!("model" in server.find("turn/start")!.params));
});

test("submitTurnAndWait resolves on legacy task_complete", async () => {
  const { client, server } = await connectedClient();
  await client.startThread();
  const waiting = client.submitTurnAndWait("go");
  await tick();
  server.push("codex/event/task_started", { msg: { type: "task_started", turn_id: "turn_1" } });
  server.push("codex/event/task_complete", { msg: { type: "task_complete", turn_id: "turn_1" } });
  const result = await waiting;
  assert.equal(result.aborted, false);
});

test("submitTurnAndWait reports aborted on turn_aborted", async () => {
  const done: Array<{ message: string }> = [];
  const { client, server } = await connectedClient({ onTurnComplete: (ev) => done.push(ev) });
  await client.startThread();
  const waiting = client.submitTurnAndWait("go");
  await tick();
  server.push("codex/event/turn_aborted", { msg: { type: "turn_aborted", turn_id: "turn_1" } });
  assert.equal((await waiting).aborted, true);
  assert.deepEqual(done, []);
});

test("submitTurnAndWait resolves via raw v2 turn/completed", async () => {
  const { client, server } = await connectedClient();
  await client.startThread();
  const waiting = client.submitTurnAndWait("go");
  await tick();
  server.push("turn/started", { turn: { id: "turn_1" } });
  server.push("turn/completed", { turn: { id: "turn_1", status: "completed" } });
  assert.equal((await waiting).aborted, false);
});

test("a stale completion for a different turn does not resolve the current wait", async () => {
  const done: Array<{ message: string }> = [];
  const statuses: AgentSessionStatus[] = [];
  const { client, server } = await connectedClient({
    onTurnComplete: (ev) => done.push(ev),
    onStatus: (status) => statuses.push(status)
  });
  await client.startThread();
  const waiting = client.submitTurnAndWait("go", { turnTimeoutMs: 200 });
  await tick();
  server.push("codex/event/task_started", { msg: { type: "task_started", turn_id: "turn_1" } });
  // A completion for an unrelated turn must be ignored.
  server.push("codex/event/task_complete", { msg: { type: "task_complete", turn_id: "turn_OTHER" } });
  const result = await waiting; // resolves via the 200ms timeout as aborted
  assert.equal(result.aborted, true);
  assert.deepEqual(done, []);
  assert.equal(statuses.at(-1), "running");
});

test("legacy notifications normalize to timeline items", async () => {
  const items: TimelineItem[] = [];
  const { client, server } = await connectedClient({ onTimelineItem: (i) => items.push(i) });
  await client.startThread();
  server.push("codex/event/agent_message", { msg: { type: "agent_message", message: "hi there" } });
  server.push("codex/event/exec_command_begin", { msg: { type: "exec_command_begin", command: ["ls", "-la"] } });
  server.push("codex/event/exec_command_end", { msg: { type: "exec_command_end", output: "total 0" } });
  await tick();
  const kinds = items.map((i) => i.kind);
  assert.ok(kinds.includes("assistant"));
  assert.ok(kinds.includes("tool_call"));
  assert.ok(kinds.includes("tool_result"));
  const call = items.find((i) => i.kind === "tool_call");
  assert.equal(call?.tool?.name, "shell");
  assert.equal(call?.tool?.input, "ls -la");
});

test("raw v2 item/completed agentMessage normalizes to an assistant item", async () => {
  const items: TimelineItem[] = [];
  const { client, server } = await connectedClient({ onTimelineItem: (i) => items.push(i) });
  await client.startThread();
  server.push("item/completed", { item: { type: "agentMessage", id: "a1", text: "done", phase: "final_answer" } });
  await tick();
  assert.ok(items.some((i) => i.kind === "assistant" && i.text === "done"));
});

test("submitTurn echoes the user turn with provenance", async () => {
  const items: TimelineItem[] = [];
  const { client } = await connectedClient({ onTimelineItem: (i) => items.push(i) });
  await client.startThread();
  await client.submitTurn("hello", { source: "agent" });
  const user = items.find((i) => i.kind === "user");
  assert.equal(user?.text, "hello");
  assert.equal(user?.source, "agent");
});

test("exec approval maps our decision to the v2 wire format", async () => {
  const { client, server } = await connectedClient({
    approvalHandler: async () => "approved"
  });
  await client.startThread();
  server.requestToClient(99, "item/commandExecution/requestApproval", { itemId: "call_1", command: ["rm", "-rf", "x"] });
  await tick();
  const reply = server.requests; // approvals are answered on stdin -> captured as requests-without-method
  // The client's response is written to stdin; find the JSON-RPC response with id 99.
  const resp = reply.find((r) => (r as any).id === 99 && (r as any).result);
  assert.equal((resp as any)?.result?.decision, "accept");
});

test("legacy exec approval keeps the legacy wire decision", async () => {
  const { client, server } = await connectedClient({
    approvalHandler: async () => "denied"
  });
  await client.startThread();
  server.requestToClient(100, "execCommandApproval", { callId: "c", command: ["ls"] });
  await tick();
  const resp = server.requests.find((r) => (r as any).id === 100 && (r as any).result);
  assert.equal((resp as any)?.result?.decision, "denied");
});

test("missing approval handler denies by default", async () => {
  const { client, server } = await connectedClient();
  await client.startThread();
  server.requestToClient(101, "item/fileChange/requestApproval", { itemId: "p1" });
  await tick();
  const resp = server.requests.find((r) => (r as any).id === 101 && (r as any).result);
  assert.equal((resp as any)?.result?.decision, "decline");
});

test("structured requests preserve identity, cover every 0.144.1 family, and clear only when resolved", async () => {
  const opened: PendingServerRequest[] = [];
  const resolved: PendingServerRequest[] = [];
  const statuses: AgentSessionStatus[] = [];
  const { client, server } = await connectedClient({
    onServerRequest: (request) => opened.push(request),
    onServerRequestResolved: (request) => resolved.push(request),
    onStatus: (status) => statuses.push(status)
  });
  await client.startThread();
  server.push("turn/started", { turn: { id: "turn_1" } });
  await tick();

  const cases: Array<{
    id: string | number;
    method: string;
    params: Record<string, unknown>;
    decision?: string;
    content?: Record<string, unknown>;
    expected: Record<string, unknown>;
  }> = [
    {
      id: "cmd-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thr_1", turnId: "turn_1", itemId: "item-c", approvalId: "call-c", command: "rm x", cwd: "/repo", reason: "delete x" },
      decision: "acceptForSession",
      expected: { decision: "acceptForSession" }
    },
    {
      id: 2,
      method: "item/fileChange/requestApproval",
      params: { threadId: "thr_1", turnId: "turn_1", itemId: "item-f", reason: "write outside workspace" },
      decision: "decline",
      expected: { decision: "decline" }
    },
    {
      id: 3,
      method: "item/permissions/requestApproval",
      params: { threadId: "thr_1", turnId: "turn_1", itemId: "item-p", reason: "network", permissions: { network: { enabled: true }, fileSystem: null } },
      decision: "allow_session",
      expected: { permissions: { network: { enabled: true }, fileSystem: null }, scope: "session" }
    },
    {
      id: 4,
      method: "mcpServer/elicitation/request",
      params: { threadId: "thr_1", turnId: "turn_1", serverName: "computer-use", mode: "form", message: "Allow computer use?", requestedSchema: {}, _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"] } },
      decision: "accept",
      content: { approved: true },
      expected: { action: "accept", content: { approved: true }, _meta: null }
    },
    {
      id: 5,
      method: "item/tool/requestUserInput",
      params: { threadId: "thr_1", turnId: "turn_1", itemId: "item-q", questions: [{ id: "q", header: "Choice", question: "Pick", isOther: false, isSecret: false, options: [{ label: "A", description: "" }] }], autoResolutionMs: null },
      content: { answers: { q: { answers: ["A"] } } },
      expected: { answers: { q: { answers: ["A"] } } }
    }
  ];

  for (const entry of cases) {
    server.requestToClient(entry.id, entry.method, entry.params);
    server.requestToClient(entry.id, entry.method, entry.params);
    await tick();
    const pending = opened.at(-1)!;
    assert.equal(opened.filter((request) => request.requestId === entry.id).length, 1, "duplicate request is idempotent");
    assert.equal(pending.requestId, entry.id);
    assert.equal(pending.threadId, "thr_1");
    assert.equal(pending.turnId, "turn_1");
    assert.equal(statuses.at(-1), "needs_approval");
    assert.equal(client.respondToServerRequest(entry.id, "not-advertised"), false);
    assert.equal(client.respondToServerRequest(entry.id, entry.decision, entry.content), true);
    await tick();
    const response = server.requests.find((request) => request.id === entry.id && request.result);
    assert.deepEqual(response?.result, entry.expected);
    assert.equal(statuses.at(-1), "needs_approval", "response write is not resolution");
    server.push("serverRequest/resolved", { threadId: "thr_1", requestId: entry.id });
    server.push("serverRequest/resolved", { threadId: "thr_1", requestId: entry.id });
    await tick();
    assert.equal(resolved.filter((request) => request.requestId === entry.id).length, 1);
    assert.equal(statuses.at(-1), "running");
    assert.equal(client.respondToServerRequest(entry.id, entry.decision, entry.content), false, "stale response is rejected");
  }

  assert.deepEqual(opened.map((request) => request.family), [
    "command_execution", "file_change", "permissions", "mcp_elicitation", "request_user_input"
  ]);
  assert.equal(opened[0]?.itemId, "item-c");
  assert.equal(opened[0]?.callId, "call-c");
  assert.equal(opened[3]?.persistence?.metadata?.codex_approval_kind, "mcp_tool_call");
  assert.equal(opened[3]?.persistence?.session, true);
  assert.equal(opened[3]?.persistence?.always, true);
});

test("turn completion cannot clear a structured request; disconnect cleanup can", async () => {
  const resolved: PendingServerRequest[] = [];
  const statuses: AgentSessionStatus[] = [];
  const { client, server } = await connectedClient({
    onServerRequest: () => {},
    onServerRequestResolved: (request) => resolved.push(request),
    onStatus: (status) => statuses.push(status)
  });
  await client.startThread();
  server.push("turn/started", { turn: { id: "turn_1" } });
  server.requestToClient(91, "item/fileChange/requestApproval", { threadId: "thr_1", turnId: "turn_1", itemId: "f" });
  await tick();
  server.push("turn/completed", { turn: { id: "turn_1", status: "interrupted" } });
  await tick();
  assert.equal(statuses.at(-1), "needs_approval");
  assert.equal(resolved.length, 0);
  await client.disconnect();
  assert.equal(resolved.length, 1, "transport cleanup retracts the orphaned request");
});

test("status flips running -> needs_approval -> idle across a turn with an approval", async () => {
  const statuses: AgentSessionStatus[] = [];
  let releaseApproval: (d: string) => void = () => {};
  const { client, server } = await connectedClient({
    onStatus: (s) => statuses.push(s),
    approvalHandler: () => new Promise((resolve) => { releaseApproval = resolve as (d: string) => void; })
  });
  await client.startThread();
  server.push("codex/event/task_started", { msg: { type: "task_started", turn_id: "turn_1" } });
  await tick();
  server.requestToClient(5, "item/commandExecution/requestApproval", { itemId: "c", command: ["ls"] });
  await tick();
  releaseApproval("approved");
  await tick();
  server.push("codex/event/task_complete", { msg: { type: "task_complete", turn_id: "turn_1" } });
  await tick();
  assert.ok(statuses.includes("running"));
  assert.ok(statuses.includes("needs_approval"));
  assert.equal(statuses[statuses.length - 1], "idle");
});

test("onTurnStarted fires per actual turn start, never on approval resolution", async () => {
  // Approval resolution transitions needs_approval -> running in the MIDDLE of
  // a turn; treating that status churn as a turn start let it clobber a
  // deliberate worker-reported blocked verb. Only task_started / turn/started
  // count as turn starts.
  let turnStarts = 0;
  const statuses: AgentSessionStatus[] = [];
  let releaseApproval: (d: string) => void = () => {};
  const { client, server } = await connectedClient({
    onStatus: (s) => statuses.push(s),
    onTurnStarted: () => { turnStarts += 1; },
    approvalHandler: () => new Promise((resolve) => { releaseApproval = resolve as (d: string) => void; })
  });
  await client.startThread();
  server.push("codex/event/task_started", { msg: { type: "task_started", turn_id: "turn_1" } });
  await tick();
  assert.equal(turnStarts, 1);
  server.requestToClient(5, "item/commandExecution/requestApproval", { itemId: "c", command: ["ls"] });
  await tick();
  assert.equal(statuses.at(-1), "needs_approval");
  releaseApproval("approved");
  await tick();
  assert.equal(statuses.at(-1), "running", "approval resolution resumes the running status");
  assert.equal(turnStarts, 1, "approval resolution is not a turn start");
  server.push("codex/event/task_complete", { msg: { type: "task_complete", turn_id: "turn_1" } });
  await tick();
  assert.equal(turnStarts, 1);
  server.push("codex/event/task_started", { msg: { type: "task_started", turn_id: "turn_2" } });
  await tick();
  assert.equal(turnStarts, 2, "the next actual turn start fires again");
});

test("a daemon-owned thread idle notification clears the fleet status without a local pending turn", async () => {
  const statuses: AgentSessionStatus[] = [];
  const { client, server } = await connectedClient({ onStatus: (status) => statuses.push(status) });
  await client.startThread();
  server.push("turn/started", { turn: { id: "remote-turn" } });
  await tick();
  server.push("thread/status/changed", { status: { type: "idle" } });
  await tick();
  assert.deepEqual(statuses, ["running", "idle"]);
});

test("protocol auto-detect: once legacy is seen, raw notifications are ignored", async () => {
  const items: TimelineItem[] = [];
  const done: Array<{ message: string }> = [];
  const { client, server } = await connectedClient({
    onTimelineItem: (i) => items.push(i),
    onTurnComplete: (ev) => done.push(ev)
  });
  await client.startThread();
  server.push("codex/event/agent_message", { msg: { type: "agent_message", message: "legacy" } });
  await tick();
  // A raw item after legacy was locked in must be dropped.
  server.push("item/completed", { item: { type: "agentMessage", id: "x", text: "raw" } });
  server.push("turn/completed", { turn: { id: "raw-turn", status: "completed" } });
  await tick();
  assert.ok(items.some((i) => i.text === "legacy"));
  assert.ok(!items.some((i) => i.text === "raw"), "raw notifications ignored once legacy is detected");
  assert.deepEqual(done, [], "non-authoritative raw completion is ignored once legacy is detected");
});

test("interrupt with no active turn is a no-op", async () => {
  const { client } = await connectedClient();
  await client.startThread();
  const result = await client.interrupt();
  assert.equal(result.hadActiveTurn, false);
});

test("interrupt settles when the turn completes within the grace period", async () => {
  const { client, server } = await connectedClient();
  await client.startThread();
  const waiting = client.submitTurnAndWait("go");
  await tick();
  server.push("codex/event/task_started", { msg: { type: "task_started", turn_id: "turn_1" } });
  await tick();
  const interrupting = client.interrupt({ gracePeriodMs: 500 });
  await tick();
  server.push("codex/event/turn_aborted", { msg: { type: "turn_aborted", turn_id: "turn_1" } });
  const result = await interrupting;
  assert.equal(result.hadActiveTurn, true);
  assert.equal(result.aborted, true);
  assert.equal(result.forcedRestart, false);
  await waiting;
});

test("listModels issues model/list", async () => {
  const { client, server } = await connectedClient();
  await client.listModels();
  assert.ok(server.find("model/list"));
});

test("raw v2 agentMessage deltas stream live, then finalize on item/completed", async () => {
  const frames: Array<{ itemId: string; text: string; done: boolean }> = [];
  const items: TimelineItem[] = [];
  const { client, server } = await connectedClient({
    onAssistantStream: (ev) => frames.push({ ...ev }),
    onTimelineItem: (i) => items.push(i)
  });
  await client.startThread();

  // Deltas fired in a tight loop coalesce (only the first + subsequent frames
  // past the throttle window emit), but each frame carries the FULL text so far.
  server.push("item/agentMessage/delta", { itemId: "msg_1", turnId: "turn_1", delta: "Hel" });
  await tick(40);
  server.push("item/agentMessage/delta", { itemId: "msg_1", turnId: "turn_1", delta: "lo w" });
  await tick(40);
  server.push("item/agentMessage/delta", { itemId: "msg_1", turnId: "turn_1", delta: "orld" });
  await tick();
  server.push("item/completed", { item: { id: "msg_1", type: "agentMessage", text: "Hello world" } });
  await tick();

  // At least one live (non-done) frame streamed before completion.
  assert.ok(frames.some((f) => !f.done), "expected a live streaming frame");
  // Accumulation is monotonic and carries the full text so far.
  assert.ok(frames.every((f) => "Hello world".startsWith(f.text)), "frames must be prefixes of the full reply");
  // The final frame is the authoritative full message, marked done.
  const last = frames.at(-1)!;
  assert.equal(last.done, true);
  assert.equal(last.text, "Hello world");
  assert.equal(last.itemId, "msg_1");
  // The finished message still persists as a timeline item (the durable record).
  assert.equal(items.at(-1)?.kind, "assistant");
  assert.equal(items.at(-1)?.text, "Hello world");
});

test("legacy agent_message_delta streams then finalizes on agent_message", async () => {
  const frames: Array<{ itemId: string; text: string; done: boolean }> = [];
  const { client, server } = await connectedClient({
    onAssistantStream: (ev) => frames.push({ ...ev })
  });
  await client.startThread();

  server.push("codex/event/agent_message_delta", { msg: { type: "agent_message_delta", item_id: "m1", delta: "Par" } });
  await tick(40);
  server.push("codex/event/agent_message_delta", { msg: { type: "agent_message_delta", item_id: "m1", delta: "tial" } });
  await tick();
  server.push("codex/event/agent_message", { msg: { type: "agent_message", message: "Partial" } });
  await tick();

  assert.ok(frames.some((f) => !f.done && f.text.length > 0), "expected a live legacy frame");
  const last = frames.at(-1)!;
  assert.equal(last.done, true);
  assert.equal(last.text, "Partial");
});

test("onTurnComplete fires once with the final assistant message when a raw turn completes", async () => {
  const done: Array<{ message: string }> = [];
  const { client, server } = await connectedClient({ onTurnComplete: (ev) => done.push(ev) });
  await client.startThread();
  server.push("turn/started", { turn: { id: "turn_1" } });
  server.push("item/completed", { item: { type: "agentMessage", id: "a1", text: "shipped the fix in PR #99" } });
  // The turn settling via more than one notification must still report once.
  server.push("turn/completed", { turn: { id: "turn_1", status: "completed" } });
  server.push("thread/status/changed", { status: { type: "idle" } });
  await tick();
  assert.deepEqual(done, [{ message: "shipped the fix in PR #99" }]);
});

test("onTurnComplete fires once for a raw tool-result-ending turn with no assistant message", async () => {
  const done: Array<{ message: string }> = [];
  const { client, server } = await connectedClient({ onTurnComplete: (ev) => done.push(ev) });
  await client.startThread();
  server.push("turn/started", { turn: { id: "turn_1" } });
  server.push("item/completed", {
    item: { type: "commandExecution", id: "tool_1", aggregatedOutput: "tests passed" }
  });
  server.push("turn/completed", { turn: { id: "turn_1", status: "completed" } });
  server.push("turn/completed", { turn: { id: "turn_1", status: "completed" } });
  await tick();
  assert.deepEqual(done, [{ message: "" }]);
});

test("onTurnComplete stays silent on an aborted turn", async () => {
  const done: Array<{ message: string }> = [];
  const { client, server } = await connectedClient({ onTurnComplete: (ev) => done.push(ev) });
  await client.startThread();
  server.push("turn/started", { turn: { id: "turn_1" } });
  server.push("item/completed", { item: { type: "agentMessage", id: "a1", text: "half-done" } });
  server.push("turn/completed", { turn: { id: "turn_1", status: "cancelled" } });
  await tick();
  assert.deepEqual(done, []);
});

test("onTurnComplete fires on legacy task_complete with the agent_message", async () => {
  const done: Array<{ message: string }> = [];
  const { client, server } = await connectedClient({ onTurnComplete: (ev) => done.push(ev) });
  await client.startThread();
  server.push("codex/event/task_started", { msg: { type: "task_started", turn_id: "turn_1" } });
  server.push("codex/event/agent_message", { msg: { type: "agent_message", message: "all green" } });
  server.push("codex/event/task_complete", { msg: { type: "task_complete", turn_id: "turn_1" } });
  await tick();
  assert.deepEqual(done, [{ message: "all green" }]);
});

test("onTurnComplete fires once on legacy task_complete with no agent_message", async () => {
  const done: Array<{ message: string }> = [];
  const { client, server } = await connectedClient({ onTurnComplete: (ev) => done.push(ev) });
  await client.startThread();
  server.push("codex/event/task_started", { msg: { type: "task_started", turn_id: "turn_1" } });
  server.push("codex/event/exec_command_end", {
    msg: { type: "exec_command_end", turn_id: "turn_1", output: "tests passed" }
  });
  server.push("codex/event/task_complete", { msg: { type: "task_complete", turn_id: "turn_1" } });
  server.push("codex/event/task_complete", { msg: { type: "task_complete", turn_id: "turn_1" } });
  await tick();
  assert.deepEqual(done, [{ message: "" }]);
});

test("onTurnComplete clears a prior turn's message before a later empty turn", async () => {
  const done: Array<{ message: string }> = [];
  const { client, server } = await connectedClient({ onTurnComplete: (ev) => done.push(ev) });
  await client.startThread();
  server.push("turn/started", { turn: { id: "turn_1" } });
  server.push("item/completed", { item: { type: "agentMessage", id: "a1", text: "first result" } });
  server.push("turn/completed", { turn: { id: "turn_1", status: "completed" } });
  // A second turn with no assistant message must not re-report the first.
  server.push("turn/started", { turn: { id: "turn_2" } });
  server.push("turn/completed", { turn: { id: "turn_2", status: "completed" } });
  await tick();
  assert.deepEqual(done, [{ message: "first result" }, { message: "" }]);
});

test("a completed turn with no deltas emits no streaming frames", async () => {
  const frames: Array<{ itemId: string; text: string; done: boolean }> = [];
  const { client, server } = await connectedClient({
    onAssistantStream: (ev) => frames.push({ ...ev })
  });
  await client.startThread();
  server.push("turn/completed", { turn: { id: "turn_1", status: "completed" } });
  await tick();
  assert.equal(frames.length, 0);
});
