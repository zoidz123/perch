import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentKind, AgentSession, AgentSessionStatus, FleetEvent, PendingServerRequest, RecentEventsResult, ServerRequestResponse, StartAgentRequest } from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import type { CodexAppServerAdapter } from "./adapters/codexAppServerAdapter.js";
import { FakeCodexOwnedAdapter } from "./adapters/fakeCodexAppServer.js";
import type { PtyAgentAdapter } from "./adapters/pty.js";
import { RoutingAgentAdapter } from "./adapters/routingAdapter.js";
import { resolveCodexServerRequest, startManagedAgent, surfaceCodexServerRequest } from "./agentLauncher.js";
import { AuditLog } from "./audit.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { HookRegistry, installClaudeHooks, perchHookPath } from "./hooks.js";
import { RuntimeManager } from "./runtimeManager.js";
import { createControlServer, handleWebSocketRpcRequest } from "./http.js";
import { DeviceRegistry } from "./pairing.js";
import { handleDispatchOperationFailure } from "./dispatchFailures.js";
import { PrPoller } from "./prPoller.js";
import { PromptDeliveryTracker } from "./promptDeliveries.js";
import { ProjectRegistry } from "./projects.js";
import { FleetSettings } from "./settings.js";
import { TaskStore } from "./tasks.js";
import { TimelineStore } from "./timeline.js";
import { WorktreePool } from "./worktrees.js";
import { InjectedCrash } from "./failureInjection.js";
import { TaskScheduler } from "./taskScheduler.js";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class CapturingAdapter implements AgentAdapter {
  readonly name = "fake-pty";
  requests: StartAgentRequest[] = [];
  sessions: AgentSession[] = [];
  // When set, startAgent records the (id-minted, lease-bound) request and
  // then throws, exercising reverse-order unwinding.
  failStartAgent = false;
  stopped: string[] = [];

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
  const pty = new CapturingAdapter();
  const codexOwned = new FakeCodexOwnedAdapter();
  // The production topology: one routing facade over the Claude PTY backend
  // and the app-server-owned Codex backend.
  const routing = new RoutingAgentAdapter(
    pty as unknown as PtyAgentAdapter,
    codexOwned as unknown as CodexAppServerAdapter
  );
  const auditLog = new AuditLog(join(home, "audit.jsonl"));
  const tasks = new TaskStore(env);
  const worktrees = new WorktreePool({ env });
  const timeline = new TimelineStore();
  const promptDeliveries = new PromptDeliveryTracker(tasks.stateDb, { receiptTimeoutMs: 5_000 });
  const monitor = new FleetMonitor(routing, {
    auditLog,
    broadcastMs: 5,
    tailThrottleMs: 1,
    detailThrottleMs: 1,
    promptDeliveries
  });
  timeline.observe((item) => promptDeliveries.acknowledgeTimeline(item));
  // Mirror the index.ts wiring the approval pipeline depends on.
  codexOwned.wireEvents({
    onServerRequest: (sessionId, request) => surfaceCodexServerRequest({ monitor, tasks }, sessionId, request),
    onServerRequestResolved: (sessionId, request) => resolveCodexServerRequest({ monitor, tasks }, sessionId, request),
    onStatus: (sessionId, status) => monitor.applyExternalStatus(sessionId, status, "codex", "adapter")
  });
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
        onFailure: (operation, error) =>
          handleDispatchOperationFailure(operation, error, { tasks, worktrees })
      })
    : undefined;
  const options = {
    adapter: routing,
    auditLog,
    authToken: "test-token",
    boxSecretKey: new Uint8Array(32),
    monitor,
    devices: new DeviceRegistry(env),
    port: 0,
    hooks: new HookRegistry(),
    timeline,
    projects: new ProjectRegistry(env),
    worktrees,
    // Trust seeding targets a scratch state file, never the real ~/.claude.json.
    claudeStateFile: join(home, ".claude.json"),
    tasks,
    prPoller: new PrPoller(tasks, async () => {
      throw new Error("gh disabled in tests");
    }),
    settings: new FleetSettings(env),
    codexOwned: codexOwned as unknown as CodexAppServerAdapter,
    codexOnPath: () => true,
    // Individual tests opt in by assigning these; absent means no runtime
    // ledger and no hook reinstall side effects.
    runtimeManager: undefined as RuntimeManager | undefined,
    installHooks: undefined as ((agent: AgentKind) => void) | undefined,
    promptDeliveries,
    ...(taskScheduler ? { taskScheduler } : {})
  };
  const server = createControlServer(options);
  return {
    home,
    adapter: pty,
    codexOwned,
    monitor,
    options,
    server,
    cleanup: async (...extra: string[]) => {
      timeline.stop();
      promptDeliveries.stop();
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

test("direct HTTP POST /agents/pty routes Codex to the app-server owning adapter, never a PTY", async () => {
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
    // No PTY spawn happened at all for a Codex launch.
    assert.equal(fx.adapter.requests.length, 0);
    assert.equal(fx.codexOwned.launches.length, 1);
    const request = fx.codexOwned.launches[0]!.request as { cwd?: string; model?: string; effort?: string };
    assert.equal(request.cwd, repo);
    assert.equal(request.model, "gpt-5.5");
    assert.equal(request.effort, "xhigh");
    // The session surfaces the native desktop attach command.
    const sessions = (await (await fetch(`${baseUrl}/sessions`, authed)).json()) as { sessions: AgentSession[] };
    assert.match(sessions.sessions[0]?.attachCommand ?? "", /^codex resume thr-fake-\d+ --remote unix:\/\//);
    assert.match(readFileSync(join(fx.home, "audit.jsonl"), "utf8"), /"action":"start_agent"/);
  } finally {
    await fx.cleanup(repo);
  }
});

test("a Codex launch fails loudly when the owning adapter cannot start - there is no PTY fallback", async () => {
  const fx = fixture();
  const repo = makeRepo();
  const baseUrl = await listen(fx.server, fx.options);
  fx.codexOwned.failStart = new Error("codex daemon did not become healthy");

  try {
    const response = await fetch(`${baseUrl}/agents/pty`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ command: "codex", agent: "codex", cwd: repo })
    });
    assert.equal(response.status, 500);
    assert.match(await response.text(), /codex daemon did not become healthy/);
    // The regression this pins: no Codex path may ever reach PTY prompt
    // submission or a PTY spawn, even when app-server startup fails.
    assert.equal(fx.adapter.requests.length, 0);
    assert.equal(fx.adapter.sessions.length, 0);
  } finally {
    await fx.cleanup(repo);
  }
});

test("a Codex launch without the owning adapter is refused outright", async () => {
  const fx = fixture();
  const repo = makeRepo();
  try {
    await assert.rejects(
      startManagedAgent(
        { ...fx.options, codexOwned: undefined },
        { request: { command: "codex", agent: "codex", cwd: repo } }
      ),
      /codex sessions require the app-server owning adapter/
    );
    assert.equal(fx.adapter.requests.length, 0);
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

    // Codex went to the owning adapter, not the PTY backend.
    assert.equal(fx.adapter.requests.length, 0);
    assert.equal(fx.codexOwned.launches.length, 1);
    const ownedId = (await fx.codexOwned.listSessions())[0]!.id;
    const fleet = socket.fleets().at(-1);
    assert.ok((fleet?.sessions as AgentSession[]).some((session) => session.id === ownedId));
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
    assert.equal(fx.adapter.requests.length, 0);
    assert.equal(fx.codexOwned.launches.length, 1);

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
    // The Codex mate is app-server-owned too: same launcher, same adapter.
    const mateLaunch = fx.codexOwned.launches.at(-1)!.request as { labels?: Record<string, string>; agent?: string };
    assert.equal(mateLaunch.labels?.role, "mate");
    assert.equal(mateLaunch.agent, "codex");
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
    // Codex dispatch launches through the owning adapter; the PTY backend
    // never sees it.
    assert.equal(fx.adapter.requests.length, 0);
    const launch = fx.codexOwned.launches[0]!.request as {
      labels?: Record<string, string>;
      cwd?: string;
      initialPrompt?: string;
      sessionId?: string;
    };
    assert.equal(launch.labels?.task, body.task.id);
    assert.equal(launch.labels?.workerName, body.task.workerName);
    assert.match(body.task.workerName ?? "", /^[A-Z][a-z]+(?: \d+)?$/);
    assert.ok(launch.cwd?.includes("/worktrees/"), `expected pooled worktree cwd, got ${launch.cwd}`);
    assert.ok(launch.initialPrompt?.includes(`PERCH TASK BRIEF (task ${body.task.id})`));
    assert.equal(body.task.sessionId, launch.sessionId);
    assert.equal(body.task.branch, `perch/${body.task.id}`);
    // The kickoff went through the acknowledged app-server path, exactly once.
    assert.equal(fx.codexOwned.submitted.length, 1);
    assert.equal(fx.codexOwned.submitted[0]?.text, launch.initialPrompt);
    assert.equal(fx.codexOwned.submitted[0]?.clientUserMessageId, `perch-kickoff:${body.task.id}`);
    assert.equal(fx.codexOwned.submitted[0]?.source, "agent");

    const sessionsResponse = await fetch(`${baseUrl}/sessions`, authed);
    assert.equal(sessionsResponse.status, 200);
    const sessionsBody = (await sessionsResponse.json()) as { sessions: AgentSession[] };
    assert.equal(sessionsBody.sessions[0]?.workerName, body.task.workerName, "session API carries the same identity");
  } finally {
    await fx.cleanup(repo);
  }
});

test("invalid-repo dispatch records failure then auto-closes it out of the live ledger", async () => {
  const fx = fixture("durable");
  const project = mkdtempSync(join(tmpdir(), "perch-invalid-project-"));
  const baseUrl = await listen(fx.server, fx.options);

  try {
    const response = await fetch(`${baseUrl}/tasks`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ title: "invalid repo", project, dispatch: true, agent: "codex", prompt: "go" })
    });
    assert.equal(response.status, 500);

    const task = fx.options.tasks.list()[0]!;
    assert.equal(task.state, "closed");
    assert.deepEqual(fx.options.tasks.events(task.id).map((event) => event.kind), ["created", "failed", "closed"]);
    assert.equal(fx.options.tasks.stateDb.operations.latestForTask(task.id, "dispatch")?.state, "failed");

    const live = (await (await fetch(`${baseUrl}/tasks`, authed)).json()) as { tasks: Array<{ id: string }> };
    assert.deepEqual(live.tasks, []);
    const ledger = (await (await fetch(`${baseUrl}/tasks?includeClosed=1`, authed)).json()) as {
      tasks: Array<{ id: string; state: string }>;
    };
    assert.deepEqual(ledger.tasks.map((candidate) => [candidate.id, candidate.state]), [[task.id, "closed"]]);
  } finally {
    await fx.cleanup(project);
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
    assert.equal(fx.codexOwned.launches.length, 1, "the worker launched before the injected crash");
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
    assert.equal(firstTask.sessionId, (await fx.codexOwned.listSessions())[0]?.id);
    assert.equal(fx.codexOwned.launches.length, 1, "reconciliation never launches a duplicate worker");
    const operation = fx.options.tasks.stateDb.operations.findByIdempotencyKey("dispatch:request:phone-request-1");
    assert.equal(operation?.state, "succeeded");
    // The ledger carries the durable kickoff contract: intent journaled
    // before the send, the accepted turn after it.
    const events = fx.options.tasks.events(firstTask.id);
    assert.deepEqual(events.map((event) => event.kind), ["created", "note", "note", "working"]);
    assert.equal(events[1]?.data?.reason, "kickoff_submitted");
    assert.equal(events[2]?.data?.reason, "kickoff_accepted");
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
    fx.codexOwned.failStart = new Error("codex daemon spawn failed");
    const failed = await fetch(`${baseUrl}/tasks`, { ...authed, method: "POST", body: JSON.stringify(body) });
    assert.equal(failed.status, 500);
    assert.equal(fx.codexOwned.launches.length, 0);

    fx.codexOwned.failStart = null;
    const replayed = await fetch(`${baseUrl}/tasks`, { ...authed, method: "POST", body: JSON.stringify(body) });
    const replayedText = await replayed.text();
    assert.equal(replayed.status, 201, replayedText);
    const task = (JSON.parse(replayedText) as { task: { id: string; state: string } }).task;
    assert.equal(task.state, "failed", "the caller sees the durable failure, not a server error");
    assert.equal(fx.codexOwned.launches.length, 0, "a failed key never relaunches");
    assert.equal(
      fx.options.tasks.stateDb.operations.findByIdempotencyKey("dispatch:request:phone-request-2")?.state,
      "failed"
    );
    const live = (await (await fetch(`${baseUrl}/tasks`, authed)).json()) as { tasks: Array<{ id: string }> };
    assert.ok(live.tasks.some((candidate) => candidate.id === task.id), "post-launch failure stays visible");
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
    assert.equal(fx.codexOwned.launches.length, 1, "the race never launches a second worker");
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
    const callback = ownedCallbacks(fx, task.sessionId);
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
    callback.onServerRequest(request);
    callback.onServerRequest(request);

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
    assert.equal(fx.codexOwned.serverResponses[0]?.response.requestId, "rpc-47");

    callback.onServerRequestResolved(request);
    callback.onServerRequestResolved(request);
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

// Codex can open several JSON-RPC approvals in one session (parallel tool
// calls). Each stays pending until Codex confirms that exact request id
// resolved; the overview presents them as a deterministic queue, oldest first.
// Drive the owning adapter's event sink exactly as the protocol client would
// for this session (the index.ts-mirroring wiring lives in the fixture).
function ownedCallbacks(fx: ReturnType<typeof fixture>, sessionId: string) {
  return {
    onServerRequest: (request: PendingServerRequest) => fx.codexOwned.events.onServerRequest?.(sessionId, request),
    onServerRequestResolved: (request: PendingServerRequest) =>
      fx.codexOwned.events.onServerRequestResolved?.(sessionId, request),
    onStatus: (status: AgentSessionStatus) => fx.codexOwned.events.onStatus?.(sessionId, status)
  };
}

function structuredRequest(requestId: string | number, summary: string): PendingServerRequest {
  return {
    requestId,
    threadId: "thr-1",
    turnId: "turn-1",
    family: "command_execution",
    summary,
    content: { command: summary },
    decisions: [
      { id: "accept", label: "Allow" },
      { id: "decline", label: "Deny", destructive: true }
    ],
    at: new Date().toISOString()
  };
}

test("E2E overlapping Codex approvals: resolving B first keeps A pending, gated, and answerable", async () => {
  const fx = fixture();
  const repo = makeRepo();
  const baseUrl = await listen(fx.server, fx.options);
  try {
    const dispatched = await fetch(`${baseUrl}/tasks`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ title: "overlapping approvals", project: repo, dispatch: true, agent: "codex", prompt: "go" })
    });
    const { task } = (await dispatched.json()) as { task: { id: string; sessionId: string } };
    const callback = ownedCallbacks(fx, task.sessionId);
    const requestA = structuredRequest("rpc-a", "Run: rm -rf build");
    const requestB = structuredRequest("rpc-b", "Run: npm install");
    callback.onServerRequest(requestA);
    callback.onServerRequest(requestB);

    let sessions = (await (await fetch(`${baseUrl}/sessions`, authed)).json()) as { sessions: AgentSession[] };
    assert.equal(sessions.sessions[0]?.status, "needs_approval");
    assert.equal(sessions.sessions[0]?.pendingServerRequest?.requestId, "rpc-a", "the oldest open request is the card");
    assert.equal(fx.options.tasks.find(task.id)?.state, "needs_you");
    assert.equal(fx.options.tasks.events(task.id).filter((event) => event.kind === "needs_decision").length, 2);

    // Codex resolves B first (answered on the desktop TUI). A must survive.
    callback.onServerRequestResolved(requestB);

    sessions = (await (await fetch(`${baseUrl}/sessions`, authed)).json()) as { sessions: AgentSession[] };
    assert.equal(sessions.sessions[0]?.pendingServerRequest?.requestId, "rpc-a", "resolving B must not drop A");
    assert.equal(sessions.sessions[0]?.status, "needs_approval", "A is still open");
    assert.equal(fx.options.tasks.find(task.id)?.state, "needs_you", "the durable task still needs the boss");
    const lastEvent = fx.options.tasks.events(task.id).at(-1);
    assert.equal(lastEvent?.kind, "needs_decision");
    assert.equal(lastEvent?.data?.requestId, "rpc-a", "the ledger re-points at the still-open request");

    // Generic composer input stays gated while A is open.
    const input = await fetch(`${baseUrl}/sessions/${encodeURIComponent(task.sessionId)}/input`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ text: "1" })
    });
    assert.deepEqual(await input.json(), { ok: true, queued: true });

    // A remains answerable by its exact request id.
    const answer = await fetch(`${baseUrl}/sessions/${encodeURIComponent(task.sessionId)}/server-request`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ requestId: "rpc-a", decision: "accept" })
    });
    assert.equal(answer.status, 202, await answer.text());
    assert.equal(fx.codexOwned.serverResponses.at(-1)?.response.requestId, "rpc-a");

    // Codex confirms A resolved; a duplicate notification stays one event.
    callback.onServerRequestResolved(requestA);
    callback.onServerRequestResolved(requestA);
    callback.onStatus("running");
    await tick(20);

    sessions = (await (await fetch(`${baseUrl}/sessions`, authed)).json()) as { sessions: AgentSession[] };
    assert.equal(sessions.sessions[0]?.pendingServerRequest, undefined);
    assert.equal(sessions.sessions[0]?.status, "running");
    assert.equal(sessions.sessions[0]?.queuedCount, undefined, "the final resolution releases queued composer input");
    assert.equal(fx.options.tasks.find(task.id)?.state, "working");
    assert.equal(
      fx.options.tasks.events(task.id).filter((event) => event.data?.reason === "codex_server_request_resolved").length,
      1
    );

    const stale = await fetch(`${baseUrl}/sessions/${encodeURIComponent(task.sessionId)}/server-request`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ requestId: "rpc-a", decision: "accept" })
    });
    assert.equal(stale.status, 409);
  } finally {
    await fx.cleanup(repo);
  }
});

test("E2E overlapping Codex approvals resolve in order and the queued request is answerable before it surfaces", async () => {
  const fx = fixture();
  const repo = makeRepo();
  const baseUrl = await listen(fx.server, fx.options);
  try {
    const dispatched = await fetch(`${baseUrl}/tasks`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ title: "queued approvals", project: repo, dispatch: true, agent: "codex", prompt: "go" })
    });
    const { task } = (await dispatched.json()) as { task: { id: string; sessionId: string } };
    const callback = ownedCallbacks(fx, task.sessionId);
    const requestA = structuredRequest("rpc-a", "Run: rm -rf build");
    // A numeric JSON-RPC id must be preserved end to end, never coerced.
    const requestB = structuredRequest(48, "Apply file changes");
    callback.onServerRequest(requestA);
    callback.onServerRequest(requestB);

    // B is queued behind A on the card, but already answerable by exact id.
    let sessions = (await (await fetch(`${baseUrl}/sessions`, authed)).json()) as { sessions: AgentSession[] };
    assert.equal(sessions.sessions[0]?.pendingServerRequest?.requestId, "rpc-a");
    const answerB = await fetch(`${baseUrl}/sessions/${encodeURIComponent(task.sessionId)}/server-request`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ requestId: 48, decision: "accept" })
    });
    assert.equal(answerB.status, 202, await answerB.text());
    assert.equal(fx.codexOwned.serverResponses.at(-1)?.response.requestId, 48);

    // A resolves first: B surfaces as the next card and the task stays gated.
    callback.onServerRequestResolved(requestA);
    sessions = (await (await fetch(`${baseUrl}/sessions`, authed)).json()) as { sessions: AgentSession[] };
    assert.equal(sessions.sessions[0]?.pendingServerRequest?.requestId, 48, "the next open request surfaces");
    assert.equal(sessions.sessions[0]?.status, "needs_approval");
    assert.equal(fx.options.tasks.find(task.id)?.state, "needs_you");
    assert.equal(
      fx.options.tasks.events(task.id).filter((event) => event.kind === "needs_decision").length,
      2,
      "the ledger already names the surviving request; no duplicate needs_decision"
    );

    // Only resolving the final open request clears the gate.
    callback.onServerRequestResolved(requestB);
    sessions = (await (await fetch(`${baseUrl}/sessions`, authed)).json()) as { sessions: AgentSession[] };
    assert.equal(sessions.sessions[0]?.pendingServerRequest, undefined);
    assert.equal(fx.options.tasks.find(task.id)?.state, "working");
  } finally {
    await fx.cleanup(repo);
  }
});

test("E2E three overlapping Codex approvals: the ledger re-points only when the last-named request resolves", async () => {
  const fx = fixture();
  const repo = makeRepo();
  const baseUrl = await listen(fx.server, fx.options);
  try {
    const dispatched = await fetch(`${baseUrl}/tasks`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ title: "triple approvals", project: repo, dispatch: true, agent: "codex", prompt: "go" })
    });
    const { task } = (await dispatched.json()) as { task: { id: string; sessionId: string } };
    const callback = ownedCallbacks(fx, task.sessionId);
    const requestA = structuredRequest("rpc-a", "Run: rm -rf build");
    const requestB = structuredRequest("rpc-b", "Run: npm install");
    const requestC = structuredRequest("rpc-c", "Apply file changes");
    callback.onServerRequest(requestA);
    callback.onServerRequest(requestB);
    callback.onServerRequest(requestC);

    let sessions = (await (await fetch(`${baseUrl}/sessions`, authed)).json()) as { sessions: AgentSession[] };
    assert.equal(sessions.sessions[0]?.pendingServerRequest?.requestId, "rpc-a", "the oldest open request is the card");
    assert.equal(fx.options.tasks.find(task.id)?.state, "needs_you");
    assert.equal(fx.options.tasks.events(task.id).filter((event) => event.kind === "needs_decision").length, 3);

    // B resolves: it is neither the queue head nor the request the ledger last
    // named (C), so the ledger stays untouched instead of duplicating B or A.
    callback.onServerRequestResolved(requestB);
    sessions = (await (await fetch(`${baseUrl}/sessions`, authed)).json()) as { sessions: AgentSession[] };
    assert.equal(sessions.sessions[0]?.pendingServerRequest?.requestId, "rpc-a", "the head is unchanged");
    assert.equal(fx.options.tasks.find(task.id)?.state, "needs_you");
    assert.equal(
      fx.options.tasks.events(task.id).filter((event) => event.kind === "needs_decision").length,
      3,
      "resolving a request the ledger does not name records no duplicate needs_decision"
    );

    // C resolves: it is the request the ledger last named, so the ledger
    // re-points at the surviving queue head A with exactly one new event.
    callback.onServerRequestResolved(requestC);
    sessions = (await (await fetch(`${baseUrl}/sessions`, authed)).json()) as { sessions: AgentSession[] };
    assert.equal(sessions.sessions[0]?.pendingServerRequest?.requestId, "rpc-a");
    assert.equal(fx.options.tasks.find(task.id)?.state, "needs_you");
    const decisions = fx.options.tasks.events(task.id).filter((event) => event.kind === "needs_decision");
    assert.equal(decisions.length, 4, "the re-point records exactly one new needs_decision");
    assert.equal(decisions.at(-1)?.data?.requestId, "rpc-a", "the ledger re-points at the surviving queue head");

    // Only resolving the final open request clears the gate.
    callback.onServerRequestResolved(requestA);
    sessions = (await (await fetch(`${baseUrl}/sessions`, authed)).json()) as { sessions: AgentSession[] };
    assert.equal(sessions.sessions[0]?.pendingServerRequest, undefined);
    assert.equal(fx.options.tasks.find(task.id)?.state, "working");
    assert.equal(
      fx.options.tasks.events(task.id).filter((event) => event.data?.reason === "codex_server_request_resolved").length,
      1
    );
  } finally {
    await fx.cleanup(repo);
  }
});

test("a failed Codex launch unwinds the worktree lease and leaves no session behind", async () => {
  const fx = fixture();
  const repo = makeRepo();
  const baseUrl = await listen(fx.server, fx.options);
  fx.codexOwned.failStart = new Error("codex daemon spawn failed");

  try {
    const response = await fetch(`${baseUrl}/agents/pty`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ command: "codex", agent: "codex", cwd: repo, worktree: true })
    });
    // The launch surfaces the failure rather than swallowing it.
    assert.equal(response.status, 500, await response.text());

    // Nothing survives the failure: no session anywhere, and the worktree
    // acquired for this launch is returned to the pool.
    assert.equal(fx.adapter.requests.length, 0);
    assert.equal((await fx.codexOwned.listSessions()).length, 0);
    assert.equal(fx.options.worktrees.findByHolder("pending"), undefined);
    assert.equal(
      fx.options.worktrees.list().filter((lease) => lease.leasedBy).length,
      0,
      "no worktree lease survives the failed launch"
    );
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
    const [kickoff] = fx.options.tasks.stateDb.promptDeliveries.list();
    assert.equal(kickoff?.state, "submitted");
    assert.match(kickoff?.promptText ?? "", /PERCH TASK BRIEF/);
    assert.equal(fx.adapter.requests[0]?.args?.filter((arg) => arg === kickoff?.promptText).length, 1);
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
    const launch = fx.codexOwned.launches[0]?.request as { cwd?: string } | undefined;
    assert.ok(launch?.cwd, "codex worker launched into a pool worktree");
    assert.equal(existsSync(join(fx.home, ".claude.json")), false);
  } finally {
    await fx.cleanup(repo);
  }
});

// The production outage this guards against: hook delivery silently died (an
// external rewrite of ~/.claude/settings.json dropped perch's entries), so no
// SessionStart ever correlated a transcript and the timelines of two workers
// dispatched in the same second stayed empty while both were productive. The
// launcher now pre-mints the Claude session id (--session-id) and attaches the
// tailer to the derived transcript path at launch, so every timeline populates
// - including rows written before the file even existed at attach time - with
// zero hook events delivered.
test("concurrent Claude dispatches attach every timeline without any hook event", async () => {
  const fx = fixture();
  const repo = makeRepo();
  const claudeDir = mkdtempSync(join(tmpdir(), "perch-claude-config-"));
  const priorConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  fx.options.runtimeManager = new RuntimeManager(fx.options.tasks);
  const baseUrl = await listen(fx.server, fx.options);

  try {
    const responses = await Promise.all(
      [1, 2, 3].map((n) =>
        fetch(`${baseUrl}/tasks`, {
          ...authed,
          method: "POST",
          body: JSON.stringify({ title: `worker ${n}`, project: repo, dispatch: true, agent: "claude", prompt: `go ${n}` })
        })
      )
    );
    for (const response of responses) {
      assert.equal(response.status, 201, await response.clone().text());
    }
    assert.equal(fx.adapter.requests.length, 3);

    const launches = fx.adapter.requests.map((request, index) => {
      const flagIndex = request.args?.indexOf("--session-id") ?? -1;
      assert.ok(flagIndex >= 0, "every fresh Claude launch pre-mints --session-id");
      const uuid = request.args![flagIndex + 1]!;
      assert.equal(`pty:${uuid}`, request.sessionId, "provider id and PTY id share the minted uuid");
      // The runtime knows its provider session from launch, not only after a
      // SessionStart hook - so recovery never reports provider_session_unknown.
      const runtime = fx.options.tasks.stateDb.runtimes.findBySession(request.sessionId!);
      assert.equal(runtime?.providerSessionId, uuid);
      // Claude creates the transcript only after the process starts; write it
      // AFTER dispatch returned to prove late attachment plus backfill.
      const projectDir = join(claudeDir, "projects", realpathSync(request.cwd!).replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(projectDir, { recursive: true });
      const at = new Date().toISOString();
      writeFileSync(
        join(projectDir, `${uuid}.jsonl`),
        [
          JSON.stringify({ type: "user", uuid: `u-${index}`, timestamp: at, message: { role: "user", content: `kickoff ${index}` } }),
          JSON.stringify({
            type: "assistant",
            uuid: `a-${index}`,
            timestamp: at,
            message: { role: "assistant", model: "claude-fable-5", content: [{ type: "text", text: `progress ${index}` }] }
          })
        ].join("\n") + "\n"
      );
      return { sessionId: request.sessionId!, index };
    });

    // The tailer discovers the late-created files on its poll cadence (1s).
    const deadline = Date.now() + 10_000;
    for (const launch of launches) {
      let items: Array<{ kind: string; text?: string }> = [];
      while (Date.now() < deadline) {
        const timeline = await fetch(`${baseUrl}/sessions/${encodeURIComponent(launch.sessionId)}/timeline`, authed);
        assert.equal(timeline.status, 200);
        items = ((await timeline.json()) as { items: Array<{ kind: string; text?: string }> }).items;
        if (items.length >= 2) break;
        await tick(100);
      }
      assert.ok(
        items.some((item) => item.kind === "user" && item.text === `kickoff ${launch.index}`),
        `session ${launch.sessionId} backfilled its pre-attach kickoff row`
      );
      assert.ok(
        items.some((item) => item.kind === "assistant" && item.text === `progress ${launch.index}`),
        `session ${launch.sessionId} tailed its assistant row`
      );
      // The watchdog's idle detection reads the same feed; a populated
      // timeline is exactly what stops the false "no activity since launch".
      assert.ok(fx.options.timeline.lastActivityAt(launch.sessionId), "activity feed sees the tailed rows");
    }
  } finally {
    if (priorConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = priorConfigDir;
    await fx.cleanup(repo, claudeDir);
  }
});

test("a Claude launch reinstalls perch hook entries clobbered by an external settings rewrite", async () => {
  const fx = fixture();
  const repo = makeRepo();
  const claudeDir = mkdtempSync(join(tmpdir(), "perch-claude-config-"));
  const priorConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const priorHome = process.env.PERCH_HOME;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.PERCH_HOME = fx.home;
  fx.options.installHooks = (agent) => {
    if (agent === "claude") installClaudeHooks();
  };
  const baseUrl = await listen(fx.server, fx.options);
  // An external tool rewrote settings.json from a stale snapshot: user entries
  // survive, perch's are gone. Boot-time installation cannot heal this.
  writeFileSync(
    join(claudeDir, "settings.json"),
    JSON.stringify({
      hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "user-tool", timeout: 10 }] }] }
    })
  );

  try {
    const response = await fetch(`${baseUrl}/tasks`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ title: "healed", project: repo, dispatch: true, agent: "claude", prompt: "go" })
    });
    assert.equal(response.status, 201, await response.text());
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const sessionStart = settings.hooks.SessionStart ?? [];
    assert.ok(
      sessionStart.some((entry) => entry.hooks.some((hook) => hook.command === "user-tool")),
      "the user's own hook entry survives the reinstall"
    );
    assert.ok(
      sessionStart.some((entry) => entry.hooks.some((hook) => hook.command.includes(perchHookPath()))),
      "perch's SessionStart entry is restored before the worker spawns"
    );
    assert.ok(settings.hooks.Stop, "the full perch hook set is restored");
  } finally {
    if (priorConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = priorConfigDir;
    if (priorHome === undefined) delete process.env.PERCH_HOME;
    else process.env.PERCH_HOME = priorHome;
    await fx.cleanup(repo, claudeDir);
  }
});

test("Claude kickoff variants keep provider identity and journal against a pre-minted Perch session", async () => {
  const fx = fixture();
  const repo = makeRepo();
  const baseUrl = await listen(fx.server, fx.options);

  try {
    const resumed = await fetch(`${baseUrl}/agents/pty`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({
        command: "claude",
        agent: "claude",
        cwd: repo,
        args: ["--resume", "abc-123"],
        sessionId: "malformed",
        initialPrompt: "resume kickoff"
      })
    });
    assert.equal(resumed.status, 201, await resumed.text());
    assert.ok(
      !fx.adapter.requests[0]?.args?.includes("--session-id"),
      "a resume keeps the provider-owned session id"
    );
    assert.match(fx.adapter.requests[0]?.sessionId ?? "", /^pty:[0-9a-f-]{36}$/);

    const continued = await fetch(`${baseUrl}/agents/pty`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({
        command: "claude",
        agent: "claude",
        cwd: repo,
        args: ["--continue"],
        sessionId: fx.adapter.requests[0]?.sessionId,
        initialPrompt: "continue kickoff"
      })
    });
    assert.equal(continued.status, 201, await continued.text());
    assert.notEqual(fx.adapter.requests[1]?.sessionId, fx.adapter.requests[0]?.sessionId);

    const providerSessionId = randomUUID();
    const callerIdentified = await fetch(`${baseUrl}/agents/pty`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({
        command: "claude",
        agent: "claude",
        cwd: repo,
        args: ["--session-id", providerSessionId],
        initialPrompt: "caller session kickoff"
      })
    });
    assert.equal(callerIdentified.status, 201, await callerIdentified.text());

    const variantDeliveries = fx.options.tasks.stateDb.promptDeliveries.list();
    assert.deepEqual(
      variantDeliveries.map((delivery) => delivery.promptText),
      ["resume kickoff", "continue kickoff", "caller session kickoff"]
    );
    assert.deepEqual(
      variantDeliveries.map((delivery) => delivery.perchSessionId),
      fx.adapter.requests.slice(0, 3).map((request) => request.sessionId)
    );
    assert.ok(variantDeliveries.every((delivery) => delivery.state === "submitted"));

    const fresh = await fetch(`${baseUrl}/agents/pty`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ command: "claude", agent: "claude", cwd: repo })
    });
    assert.equal(fresh.status, 201, await fresh.text());
    const args = fx.adapter.requests[3]?.args ?? [];
    const flagIndex = args.indexOf("--session-id");
    assert.ok(flagIndex >= 0, "a plain solo launch still pre-mints its session id");
    assert.equal(`pty:${args[flagIndex + 1]}`, fx.adapter.sessions[3]?.id);
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
