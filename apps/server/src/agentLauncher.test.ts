import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession, FleetEvent, PendingServerRequest, RecentEventsResult, ServerRequestResponse, StartAgentRequest } from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import type { CodexControlPlane } from "./codexControl.js";
import { AuditLog } from "./audit.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { HookRegistry } from "./hooks.js";
import { createControlServer, handleWebSocketRpcRequest } from "./http.js";
import { DeviceRegistry } from "./pairing.js";
import { PrPoller } from "./prPoller.js";
import { ProjectRegistry } from "./projects.js";
import { FleetSettings } from "./settings.js";
import { TaskStore } from "./tasks.js";
import { TimelineStore } from "./timeline.js";
import { WorktreePool } from "./worktrees.js";
import { InjectedCrash } from "./failureInjection.js";
import { TaskScheduler } from "./taskScheduler.js";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeCodexControl {
  prepareReturns = true;
  prepared: Array<{ cwd: string; effort?: string; env?: Record<string, string> }> = [];
  attached: Array<{ sessionId: string; socketPath: string; cwd: string }> = [];
  detached: string[] = [];
  transferred: Array<{ from: string; to: string }> = [];
  private readonly live = new Set<string>();
  callbacks = new Map<string, {
    onServerRequest?: (request: PendingServerRequest) => void;
    onServerRequestResolved?: (request: PendingServerRequest) => void;
  }>();
  responses: Array<{ sessionId: string; response: ServerRequestResponse }> = [];

  isEnabled(): boolean {
    return true;
  }

  async prepareRemote(cwd: string, opts: { effort?: string; env?: Record<string, string> } = {}) {
    this.prepared.push({ cwd, effort: opts.effort, env: opts.env });
    if (!this.prepareReturns) return null;
    return { socketPath: join(cwd, ".codex.sock"), cwd };
  }

  async attach(sessionId: string, args: {
    socketPath: string;
    cwd: string;
    onServerRequest?: (request: PendingServerRequest) => void;
    onServerRequestResolved?: (request: PendingServerRequest) => void;
  }): Promise<boolean> {
    this.live.add(sessionId);
    this.attached.push({ sessionId, socketPath: args.socketPath, cwd: args.cwd });
    this.callbacks.set(sessionId, args);
    return true;
  }

  has(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  switchModel(): boolean {
    return false;
  }

  async submitTurn(): Promise<boolean> {
    return false;
  }

  respondToServerRequest(sessionId: string, response: ServerRequestResponse): boolean {
    if (!this.live.has(sessionId)) return false;
    this.responses.push({ sessionId, response });
    return true;
  }

  async detach(sessionId: string): Promise<void> {
    this.detached.push(sessionId);
    this.live.delete(sessionId);
  }

  transferDaemon(fromSessionId: string, toSessionId: string): void {
    this.transferred.push({ from: fromSessionId, to: toSessionId });
  }

  stop(): void {}
}

class CapturingAdapter implements AgentAdapter {
  readonly name = "fake-pty";
  requests: StartAgentRequest[] = [];
  sessions: AgentSession[] = [];
  controlAttachedAtSpawn: boolean[] = [];
  // When set, startAgent records the (already control-attached, id-minted,
  // lease-bound) request and then throws, exercising reverse-order unwinding.
  failStartAgent = false;
  stopped: string[] = [];

  constructor(private readonly control?: FakeCodexControl) {}

  async stopSession(sessionId: string): Promise<void> {
    this.stopped.push(sessionId);
  }

  async getTopology() {
    return { windows: [], generatedAt: "" };
  }

  async listSessions(): Promise<AgentSession[]> {
    return this.sessions;
  }

  async readRecentEvents(sessionId: string): Promise<RecentEventsResult> {
    return { events: [{ type: "terminal_output", sessionId, text: `out:${sessionId}`, at: "" }], terminal: true };
  }

  async sendInput(): Promise<void> {}
  async sendEnter(): Promise<void> {}
  async interrupt(): Promise<void> {}

  async startAgent(request: StartAgentRequest): Promise<AgentSession> {
    this.requests.push({ ...request, args: request.args ? [...request.args] : undefined });
    this.controlAttachedAtSpawn.push(request.sessionId ? Boolean(this.control?.has(request.sessionId)) : false);
    if (this.failStartAgent) {
      throw new Error("pty spawn failed");
    }
    const id = request.sessionId ?? `pty:${randomUUID()}`;
    const session: AgentSession = {
      id,
      title: request.title ?? request.command,
      workerName: request.labels?.workerName,
      agent: request.agent ?? (request.command.includes("codex") ? "codex" : "claude"),
      cwd: request.cwd,
      labels: request.labels,
      workspaceId: "perch-pty",
      paneId: id,
      surfaceId: id,
      kind: "terminal",
      status: "running",
      lastActivityAt: new Date().toISOString()
    };
    this.sessions.push(session);
    return session;
  }
}

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  terminate(): void {}

  fleets(): Array<Record<string, unknown>> {
    return this.sent.filter((message) => message.type === "fleet");
  }

  events(): Array<Record<string, unknown>> {
    return this.sent.filter((message) => message.type === "event");
  }
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "perch-launch-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init", "--allow-empty"], {
    cwd: repo
  });
  return repo;
}

function fixture(durableBoundary?: "afterLaunch" | "durable") {
  const home = mkdtempSync(join(tmpdir(), "perch-launch-home-"));
  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  const control = new FakeCodexControl();
  const adapter = new CapturingAdapter(control);
  const auditLog = new AuditLog(join(home, "audit.jsonl"));
  const tasks = new TaskStore(env);
  const timeline = new TimelineStore();
  const monitor = new FleetMonitor(adapter, { auditLog, broadcastMs: 5, tailThrottleMs: 1, detailThrottleMs: 1 });
  let injected = false;
  const taskScheduler = durableBoundary
    ? new TaskScheduler({
        stateDb: tasks.stateDb,
        claimTtlMs: 5,
        boundary: (name) => {
          if (durableBoundary !== "durable" && !injected && name === durableBoundary) {
            injected = true;
            throw new InjectedCrash(name);
          }
        },
        onFailure: (operation, error) => {
          const task = tasks.find(operation.taskId);
          if (task && task.state !== "failed") {
            tasks.recordEvent(task.id, {
              kind: "failed",
              source: "system",
              message: `dispatch failed: ${error instanceof Error ? error.message : String(error)}`
            });
          }
        }
      })
    : undefined;
  const options = {
    adapter,
    auditLog,
    authToken: "test-token",
    boxSecretKey: new Uint8Array(32),
    monitor,
    devices: new DeviceRegistry(env),
    port: 0,
    hooks: new HookRegistry(),
    timeline,
    projects: new ProjectRegistry(env),
    worktrees: new WorktreePool({ env }),
    // Trust seeding targets a scratch state file, never the real ~/.claude.json.
    claudeStateFile: join(home, ".claude.json"),
    tasks,
    prPoller: new PrPoller(tasks, async () => {
      throw new Error("gh disabled in tests");
    }),
    settings: new FleetSettings(env),
    codexControl: control as unknown as CodexControlPlane,
    codexOnPath: () => true,
    ...(taskScheduler ? { taskScheduler } : {})
  };
  const server = createControlServer(options);
  return {
    home,
    control,
    adapter,
    monitor,
    options,
    server,
    cleanup: async (...extra: string[]) => {
      timeline.stop();
      monitor.stop();
      await taskScheduler?.stop();
      server.closeAllConnections?.();
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      tasks.close();
      rmSync(home, { recursive: true, force: true });
      for (const dir of extra) rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function listen(server: ReturnType<typeof createControlServer>, options: { port: number }) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  options.port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${options.port}`;
}

const authed = { headers: { authorization: "Bearer test-token", "content-type": "application/json" } };

test("direct HTTP POST /agents/pty uses Codex remote control before spawning the TUI", async () => {
  const fx = fixture();
  const repo = makeRepo();
  const baseUrl = await listen(fx.server, fx.options);

  try {
    const response = await fetch(`${baseUrl}/agents/pty`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ command: "codex", agent: "codex", cwd: repo, model: "gpt-5.5", effort: "xhigh" })
    });
    assert.equal(response.status, 201, await response.text());
    const request = fx.adapter.requests[0];
    assert.equal(request?.args?.[0], "--remote");
    assert.equal(request?.args?.[1], `unix://${join(repo, ".codex.sock")}`);
    assert.equal(request?.sessionId, fx.control.attached[0]?.sessionId);
    assert.equal(fx.adapter.controlAttachedAtSpawn[0], true);
    assert.equal(fx.control.prepared[0]?.cwd, repo);
    assert.equal(fx.control.prepared[0]?.effort, "xhigh");
    assert.equal(fx.control.prepared[0]?.env?.PERCH_SESSION_ID, request?.sessionId);
    assert.match(readFileSync(join(fx.home, "audit.jsonl"), "utf8"), /"action":"start_agent"/);
  } finally {
    await fx.cleanup(repo);
  }
});

test("Codex launch falls back to the plain PTY path when remote preparation is unavailable", async () => {
  const fx = fixture();
  const repo = makeRepo();
  const baseUrl = await listen(fx.server, fx.options);
  fx.control.prepareReturns = false;

  try {
    const response = await fetch(`${baseUrl}/agents/pty`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ command: "codex", agent: "codex", cwd: repo })
    });
    assert.equal(response.status, 201, await response.text());
    const request = fx.adapter.requests[0];
    assert.ok(!request?.args?.includes("--remote"), "fallback spawn is plain PTY codex");
    assert.equal(fx.control.prepared.length, 1);
    assert.equal(fx.control.attached.length, 0);
    assert.equal(fx.adapter.controlAttachedAtSpawn[0], false);
  } finally {
    await fx.cleanup(repo);
  }
});

test("FleetMonitor start_agent delegates attached WebSocket launches to the shared launcher", async () => {
  const fx = fixture();
  const repo = makeRepo();
  const socket = new FakeSocket();

  try {
    fx.monitor.addClient(socket, undefined, { kind: "device", deviceId: "phone-1" });
    await tick(20);
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "start_agent", request: { command: "codex", agent: "codex", cwd: repo } }))
    );
    await tick(40);

    const request = fx.adapter.requests[0];
    assert.equal(request?.args?.[0], "--remote");
    assert.equal(fx.adapter.controlAttachedAtSpawn[0], true);
    const fleet = socket.fleets().at(-1);
    assert.ok((fleet?.sessions as AgentSession[]).some((session) => session.id === fx.adapter.sessions[0]?.id));

    fx.monitor.publish({ type: "terminal_output", sessionId: fx.adapter.sessions[0]!.id, text: "streamed", at: "" });
    assert.ok(
      socket.events().some((message) => {
        const event = message.event as { sessionId: string; text?: string };
        return event.sessionId === fx.adapter.sessions[0]?.id && event.text === "streamed";
      }),
      "starting client is subscribed to the new session"
    );
    assert.match(readFileSync(join(fx.home, "audit.jsonl"), "utf8"), /"deviceId":"phone-1"/);
  } finally {
    await fx.cleanup(repo);
  }
});

test("relay-style RPC /agents/pty and /mate/start use the same managed launcher", async () => {
  const fx = fixture();
  const priorHome = process.env.PERCH_HOME;
  process.env.PERCH_HOME = fx.home;

  try {
    const started = await handleWebSocketRpcRequest(
      {
        type: "rpc",
        id: "start",
        method: "POST",
        path: "/agents/pty",
        body: { command: "codex", agent: "codex", cwd: fx.home }
      },
      { kind: "device", deviceId: "phone-1" },
      fx.options
    );
    assert.equal(started.status, 201);
    assert.equal(fx.adapter.requests[0]?.args?.[0], "--remote");
    assert.equal(fx.adapter.controlAttachedAtSpawn[0], true);

    fx.adapter.sessions[0] = { ...fx.adapter.sessions[0]!, status: "done" };
    const mate = await handleWebSocketRpcRequest(
      {
        type: "rpc",
        id: "mate",
        method: "POST",
        path: "/mate/start",
        body: { agent: "codex" }
      },
      { kind: "device", deviceId: "phone-1" },
      fx.options
    );
    assert.equal(mate.status, 201);
    const mateRequest = fx.adapter.requests.at(-1);
    assert.equal(mateRequest?.labels?.role, "mate");
    assert.equal(mateRequest?.agent, "codex");
    assert.equal(mateRequest?.args?.[0], "--remote");
    assert.equal(fx.adapter.controlAttachedAtSpawn.at(-1), true);
  } finally {
    if (priorHome === undefined) delete process.env.PERCH_HOME;
    else process.env.PERCH_HOME = priorHome;
    await fx.cleanup();
  }
});

test("task dispatch keeps task worktree behavior while launching through the shared service", async () => {
  const fx = fixture();
  const repo = makeRepo();
  const baseUrl = await listen(fx.server, fx.options);

  try {
    const response = await fetch(`${baseUrl}/tasks`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ title: "ship launch", project: repo, dispatch: true, agent: "codex", prompt: "go" })
    });
    const responseText = await response.text();
    assert.equal(response.status, 201, responseText);
    const body = JSON.parse(responseText) as {
      task: { id: string; workerName?: string; sessionId?: string; worktreeId?: string; branch?: string };
    };
    const request = fx.adapter.requests[0];
    assert.equal(request?.labels?.task, body.task.id);
    assert.equal(request?.labels?.workerName, body.task.workerName);
    assert.match(body.task.workerName ?? "", /^[A-Z][a-z]+(?: \d+)?$/);
    assert.equal(request?.args?.[0], "--remote");
    assert.equal(fx.adapter.controlAttachedAtSpawn[0], true);
    assert.ok(request?.cwd?.includes("/worktrees/"), `expected pooled worktree cwd, got ${request?.cwd}`);
    assert.ok(request?.initialPrompt?.includes(`PERCH TASK BRIEF (task ${body.task.id})`));
    assert.equal(body.task.sessionId, fx.adapter.sessions[0]?.id);
    assert.equal(body.task.worktreeId, fx.adapter.sessions[0]?.worktreeId);
    assert.equal(body.task.branch, `perch/${body.task.id}`);

    const sessionsResponse = await fetch(`${baseUrl}/sessions`, authed);
    assert.equal(sessionsResponse.status, 200);
    const sessionsBody = (await sessionsResponse.json()) as { sessions: AgentSession[] };
    assert.equal(sessionsBody.sessions[0]?.workerName, body.task.workerName, "session API carries the same identity");
  } finally {
    await fx.cleanup(repo);
  }
});

test("durable dispatch adopts an after-launch crash and repeated idempotency keys return one worker", async () => {
  const fx = fixture("afterLaunch");
  const repo = makeRepo();
  const baseUrl = await listen(fx.server, fx.options);
  const body = {
    title: "durable launch",
    project: repo,
    dispatch: true,
    agent: "codex",
    prompt: "go",
    idempotencyKey: "phone-request-1"
  };
  try {
    const crashed = await fetch(`${baseUrl}/tasks`, {
      ...authed,
      method: "POST",
      body: JSON.stringify(body)
    });
    assert.equal(crashed.status, 500);
    assert.equal(fx.adapter.requests.length, 1, "the worker launched before the injected crash");
    await tick(10);

    const [firstRetry, concurrentRetry] = await Promise.all([
      fetch(`${baseUrl}/tasks`, { ...authed, method: "POST", body: JSON.stringify(body) }),
      fetch(`${baseUrl}/tasks`, { ...authed, method: "POST", body: JSON.stringify(body) })
    ]);
    const firstText = await firstRetry.text();
    const secondText = await concurrentRetry.text();
    assert.equal(firstRetry.status, 201, firstText);
    assert.equal(concurrentRetry.status, 201, secondText);
    const firstTask = (JSON.parse(firstText) as { task: { id: string; sessionId?: string } }).task;
    const secondTask = (JSON.parse(secondText) as { task: { id: string; sessionId?: string } }).task;
    assert.equal(firstTask.id, secondTask.id);
    assert.equal(firstTask.sessionId, fx.adapter.sessions[0]?.id);
    assert.equal(fx.adapter.requests.length, 1, "reconciliation never launches a duplicate PTY");
    const operation = fx.options.tasks.stateDb.operations.findByIdempotencyKey("dispatch:request:phone-request-1");
    assert.equal(operation?.state, "succeeded");
    assert.deepEqual(fx.options.tasks.events(firstTask.id).map((event) => event.kind), ["created", "working"]);
  } finally {
    await fx.cleanup(repo);
  }
});

test("replaying a durably failed idempotency key returns the failed task without relaunching", async () => {
  const fx = fixture("durable");
  const repo = makeRepo();
  const baseUrl = await listen(fx.server, fx.options);
  const body = {
    title: "poisoned dispatch",
    project: repo,
    dispatch: true,
    agent: "codex",
    prompt: "go",
    idempotencyKey: "phone-request-2"
  };
  try {
    fx.adapter.failStartAgent = true;
    const failed = await fetch(`${baseUrl}/tasks`, { ...authed, method: "POST", body: JSON.stringify(body) });
    assert.equal(failed.status, 500);
    assert.equal(fx.adapter.requests.length, 1);

    fx.adapter.failStartAgent = false;
    const replayed = await fetch(`${baseUrl}/tasks`, { ...authed, method: "POST", body: JSON.stringify(body) });
    const replayedText = await replayed.text();
    assert.equal(replayed.status, 201, replayedText);
    const task = (JSON.parse(replayedText) as { task: { id: string; state: string } }).task;
    assert.equal(task.state, "failed", "the caller sees the durable failure, not a server error");
    assert.equal(fx.adapter.requests.length, 1, "a failed key never relaunches");
    assert.equal(
      fx.options.tasks.stateDb.operations.findByIdempotencyKey("dispatch:request:phone-request-2")?.state,
      "failed"
    );
  } finally {
    await fx.cleanup(repo);
  }
});

test("a first-time request losing the idempotency-key race adopts the winner's task with no orphan", async () => {
  const fx = fixture("durable");
  const repo = makeRepo();
  const baseUrl = await listen(fx.server, fx.options);
  const body = {
    title: "raced dispatch",
    project: repo,
    dispatch: true,
    agent: "codex",
    prompt: "go",
    idempotencyKey: "phone-request-3"
  };
  try {
    const winner = await fetch(`${baseUrl}/tasks`, { ...authed, method: "POST", body: JSON.stringify(body) });
    const winnerText = await winner.text();
    assert.equal(winner.status, 201, winnerText);
    const winnerTask = (JSON.parse(winnerText) as { task: { id: string } }).task;

    // Simulate a request that passed the repeated-key check before the
    // winner's operation existed: hide the key from the next lookup only.
    const operations = fx.options.tasks.stateDb.operations;
    const original = operations.findByIdempotencyKey.bind(operations);
    let hidden = false;
    operations.findByIdempotencyKey = (key: string) => {
      if (!hidden && key === "dispatch:request:phone-request-3") {
        hidden = true;
        return undefined;
      }
      return original(key);
    };

    const loser = await fetch(`${baseUrl}/tasks`, { ...authed, method: "POST", body: JSON.stringify(body) });
    const loserText = await loser.text();
    assert.equal(loser.status, 201, loserText);
    const loserTask = (JSON.parse(loserText) as { task: { id: string } }).task;
    assert.equal(loserTask.id, winnerTask.id, "the raced request returns the winning operation's task");
    assert.equal(fx.adapter.requests.length, 1, "the race never launches a second worker");
    assert.equal(fx.options.tasks.list().length, 1, "the losing task record is rolled back, not orphaned");
  } finally {
    await fx.cleanup(repo);
  }
});

test("E2E structured approval reaches API, gates input, resolves by request id, and resumes once", async () => {
  const fx = fixture();
  const repo = makeRepo();
  const baseUrl = await listen(fx.server, fx.options);
  try {
    const dispatched = await fetch(`${baseUrl}/tasks`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ title: "structured approval", project: repo, dispatch: true, agent: "codex", prompt: "go" })
    });
    const { task } = (await dispatched.json()) as { task: { id: string; sessionId: string } };
    const callback = fx.control.callbacks.get(task.sessionId);
    assert.ok(callback?.onServerRequest);
    const request: PendingServerRequest = {
      requestId: "rpc-47",
      threadId: "thr-1",
      turnId: "turn-1",
      itemId: "item-1",
      callId: "call-1",
      family: "mcp_elicitation",
      summary: "Allow Computer Use",
      content: { message: "Allow Computer Use", _meta: { codex_approval_kind: "mcp_tool_call", persist: "session" } },
      decisions: [{ id: "accept", label: "Allow" }, { id: "decline", label: "Deny", destructive: true }],
      persistence: { source: "advertised", session: true, metadata: { codex_approval_kind: "mcp_tool_call" } },
      at: new Date().toISOString()
    };
    callback!.onServerRequest!(request);
    callback!.onServerRequest!(request);

    let sessions = (await (await fetch(`${baseUrl}/sessions`, authed)).json()) as { sessions: AgentSession[] };
    assert.equal(sessions.sessions[0]?.status, "needs_approval");
    assert.equal(sessions.sessions[0]?.pendingServerRequest?.requestId, "rpc-47");
    assert.equal(fx.options.tasks.find(task.id)?.state, "needs_you");
    assert.equal(fx.options.tasks.events(task.id).filter((event) => event.kind === "needs_decision").length, 1);

    const input = await fetch(`${baseUrl}/sessions/${encodeURIComponent(task.sessionId)}/input`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ text: "1" })
    });
    assert.deepEqual(await input.json(), { ok: true, queued: true });
    assert.equal(fx.options.tasks.find(task.id)?.state, "needs_you", "queued input is not approval success");

    const response = await fetch(`${baseUrl}/sessions/${encodeURIComponent(task.sessionId)}/server-request`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ requestId: "rpc-47", decision: "accept" })
    });
    assert.equal(response.status, 202, await response.text());
    assert.equal(fx.options.tasks.find(task.id)?.state, "needs_you", "wire response waits for serverRequest/resolved");
    assert.equal(fx.control.responses[0]?.response.requestId, "rpc-47");

    callback!.onServerRequestResolved!(request);
    callback!.onServerRequestResolved!(request);
    sessions = (await (await fetch(`${baseUrl}/sessions`, authed)).json()) as { sessions: AgentSession[] };
    assert.equal(sessions.sessions[0]?.pendingServerRequest, undefined);
    assert.equal(fx.options.tasks.find(task.id)?.state, "working");
    assert.equal(fx.options.tasks.events(task.id).filter((event) => event.data?.reason === "codex_server_request_resolved").length, 1);

    const stale = await fetch(`${baseUrl}/sessions/${encodeURIComponent(task.sessionId)}/server-request`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ requestId: "rpc-47", decision: "accept" })
    });
    assert.equal(stale.status, 409);
  } finally {
    await fx.cleanup(repo);
  }
});

test("a failed spawn unwinds Codex control, pre-minted identity, and the worktree lease in reverse order", async () => {
  const fx = fixture();
  const repo = makeRepo();
  const baseUrl = await listen(fx.server, fx.options);
  fx.adapter.failStartAgent = true;

  try {
    const response = await fetch(`${baseUrl}/agents/pty`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ command: "codex", agent: "codex", cwd: repo, worktree: true })
    });
    // The launch surfaces the failure rather than swallowing it.
    assert.equal(response.status, 500, await response.text());

    // The pre-minted id reached the adapter (control was attached before spawn)
    // but nothing survives the failure: the lease is released, the control
    // client is detached, and the hook token is unregistered under that id.
    const mintedId = fx.adapter.requests[0]?.sessionId;
    assert.ok(mintedId, "codex launch pre-mints a session id before spawning");
    assert.equal(fx.adapter.controlAttachedAtSpawn[0], true);
    assert.deepEqual(fx.control.detached, [mintedId]);
    assert.equal(fx.control.has(mintedId!), false);
    assert.equal(fx.options.hooks.correlation(mintedId!), undefined);
    // The worktree acquired for this launch is returned to the pool: the slot
    // persists for reuse, but nothing holds a lease on it anymore.
    assert.equal(fx.options.worktrees.findByHolder("pending"), undefined);
    assert.equal(
      fx.options.worktrees.list().filter((lease) => lease.leasedBy).length,
      0,
      "no worktree lease survives the failed launch"
    );
    // No orphan session was left running (spawn never returned one).
    assert.equal(fx.adapter.stopped.length, 0);
  } finally {
    await fx.cleanup(repo);
  }
});

// Claude's folder-trust dialog renders before hooks load, so dispatch answers
// it ahead of launch: the launcher seeds .claude.json trust for the pool
// worktree, but only for Claude workers and only when the worktree's repo is
// a registered project (registration is the human trust decision).
test("dispatching a Claude worker seeds folder trust for the pool worktree", async () => {
  const fx = fixture();
  const repo = makeRepo();
  const baseUrl = await listen(fx.server, fx.options);
  fx.options.projects.touch(repo);

  try {
    const response = await fetch(`${baseUrl}/tasks`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ title: "trusted", project: repo, dispatch: true, agent: "claude", prompt: "go" })
    });
    assert.equal(response.status, 201, await response.text());
    const worktree = fx.adapter.requests[0]?.cwd;
    assert.ok(worktree, "claude worker launched into a pool worktree");
    const state = JSON.parse(readFileSync(join(fx.home, ".claude.json"), "utf8"));
    const entry = state.projects[realpathSync(worktree!)];
    assert.deepEqual(entry, { hasTrustDialogAccepted: true });
  } finally {
    await fx.cleanup(repo);
  }
});

test("a Claude trust-seed failure logs the manual fallback and still launches", async () => {
  const fx = fixture();
  const repo = makeRepo();
  const baseUrl = await listen(fx.server, fx.options);
  const warnings: string[] = [];
  const logs: string[] = [];
  const warn = console.warn;
  const log = console.log;
  fx.options.projects.touch(repo);
  writeFileSync(join(fx.home, ".claude.json"), "{ corrupt");
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

  try {
    const response = await fetch(`${baseUrl}/tasks`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ title: "fallback", project: repo, dispatch: true, agent: "claude", prompt: "go" })
    });
    assert.equal(response.status, 201, await response.text());
    assert.ok(fx.adapter.requests[0]?.cwd, "Claude still launches so its manual trust gate can run");
    assert.ok(warnings.some((message) => message.includes("launching anyway so Claude can show the manual trust gate")));
    assert.ok(!logs.some((message) => message.includes("claude trust seeded")));
    assert.equal(readFileSync(join(fx.home, ".claude.json"), "utf8"), "{ corrupt");
  } finally {
    console.warn = warn;
    console.log = log;
    await fx.cleanup(repo);
  }
});

test("dispatching a Codex worker never touches the Claude state file", async () => {
  const fx = fixture();
  const repo = makeRepo();
  const baseUrl = await listen(fx.server, fx.options);
  fx.options.projects.touch(repo);

  try {
    const response = await fetch(`${baseUrl}/tasks`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ title: "codex", project: repo, dispatch: true, agent: "codex", prompt: "go" })
    });
    assert.equal(response.status, 201, await response.text());
    assert.ok(fx.adapter.requests[0]?.cwd, "codex worker launched into a pool worktree");
    assert.equal(existsSync(join(fx.home, ".claude.json")), false);
  } finally {
    await fx.cleanup(repo);
  }
});

test("a Claude worktree for an unregistered project is not trust-seeded", async () => {
  const fx = fixture();
  const repo = makeRepo();
  const baseUrl = await listen(fx.server, fx.options);

  try {
    const response = await fetch(`${baseUrl}/tasks`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ title: "untrusted", project: repo, dispatch: true, agent: "claude", prompt: "go" })
    });
    assert.equal(response.status, 201, await response.text());
    assert.equal(existsSync(join(fx.home, ".claude.json")), false);
  } finally {
    await fx.cleanup(repo);
  }
});
