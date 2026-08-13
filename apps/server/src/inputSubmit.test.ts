import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession, FleetEvent, RecentEventsResult } from "@perch/shared";
import type { WebSocket } from "ws";
import type { AgentAdapter } from "./adapters/types.js";
import { resolveApprovalForTask, surfaceApprovalToTask } from "./agentLauncher.js";
import { AuditLog } from "./audit.js";
import { FleetMonitor, type FleetMonitorOptions } from "./fleetMonitor.js";
import { HookRegistry } from "./hooks.js";
import { createControlServer } from "./http.js";
import { DeviceRegistry } from "./pairing.js";
import { PrPoller } from "./prPoller.js";
import { PromptDeliveryTracker, promptDeliverySurface } from "./promptDeliveries.js";
import { ProjectRegistry } from "./projects.js";
import type { PushNotification } from "./push.js";
import { PushRouter } from "./pushRouter.js";
import { TaskStore } from "./tasks.js";
import { TimelineStore } from "./timeline.js";
import { WorktreePool } from "./worktrees.js";

// Regression for the recurring "input drop": POST /sessions/:id/input used to
// write the caller's text into the agent TUI's composer and stop - no Enter -
// so a steered worker sat idle forever on an unsent message. Both claude and
// codex treat newlines inside the SAME write as composer content (bracketed
// paste), so submission requires a DISTINCT Enter write after the text. A
// single /input call must deliver exactly that, and must queue (not type)
// while a permission prompt is open.

const SESSION_ID = "pty:input-submit-test";

class RecordingAdapter implements AgentAdapter {
  readonly name = "fake-pty";
  writes: string[] = [];
  submitDelayMs = 0;
  failSubmit = false;
  failSubmitCount = 0;
  failAfterSubmitCount = 0;
  composerEmpty = true;
  screen = "";
  private handler?: (event: FleetEvent) => void;
  readonly session: AgentSession = {
    id: SESSION_ID,
    title: "mate",
    agent: "claude",
    cwd: "/tmp",
    workspaceId: "perch-pty",
    paneId: SESSION_ID,
    surfaceId: SESSION_ID,
    kind: "terminal",
    status: "running",
    labels: { role: "mate" },
    lastActivityAt: new Date().toISOString()
  };

  async getTopology() {
    return { windows: [], generatedAt: "" };
  }
  async listSessions(): Promise<AgentSession[]> {
    return [this.session];
  }
  async readRecentEvents(sessionId: string): Promise<RecentEventsResult> {
    return {
      events: this.screen ? [{ type: "terminal_output", sessionId, text: this.screen, at: "" }] : [],
      terminal: true
    };
  }
  async sendInput(_sessionId: string, text: string): Promise<void> {
    this.writes.push(text);
  }
  async sendEnter(): Promise<void> {
    this.writes.push("\r");
  }
  async submitInput(sessionId: string, text: string): Promise<boolean> {
    if (this.failSubmit || this.failSubmitCount > 0) {
      if (this.failSubmitCount > 0) this.failSubmitCount -= 1;
      throw new Error("submit failed");
    }
    await this.sendInput(sessionId, text);
    await this.sendEnter();
    if (this.failAfterSubmitCount > 0) {
      this.failAfterSubmitCount -= 1;
      throw new Error("PTY delivery became unknown after Enter");
    }
    if (this.submitDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.submitDelayMs));
    }
    return true;
  }
  async interrupt(): Promise<void> {}
  async composerIsEmpty(): Promise<boolean> {
    return this.composerEmpty;
  }
  subscribeFleetEvents(handler: (event: FleetEvent) => void): () => void {
    this.handler = handler;
    return () => { this.handler = undefined; };
  }
  emit(event: FleetEvent): void {
    this.handler?.(event);
  }
}

class MonitorSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  messages: Array<Record<string, unknown>> = [];
  send(data: string): void {
    this.messages.push(JSON.parse(data) as Record<string, unknown>);
  }
  terminate(): void {}
}

type TestServerOptions = Pick<
  FleetMonitorOptions,
  | "pendingInputMaxAttempts"
  | "pendingInputPollMs"
  | "pendingInputRetryBackoffMs"
  | "pushRouter"
> & { receiptTimeoutMs?: number };

async function startServer(
  home: string,
  adapter = new RecordingAdapter(),
  options: TestServerOptions = {}
) {
  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  const tasks = new TaskStore(env);
  const promptDeliveries = new PromptDeliveryTracker(tasks.stateDb, {
    receiptTimeoutMs: options.receiptTimeoutMs ?? 5_000
  });
  const monitor = new FleetMonitor(adapter, {
    broadcastMs: 5,
    tailThrottleMs: 1,
    onApprovalNeeded: (sessionId, approval) => surfaceApprovalToTask(tasks, sessionId, approval),
    onApprovalResolved: (sessionId, approval) => resolveApprovalForTask(tasks, sessionId, approval),
    promptDeliveries,
    promptDeliverySurface: (sessionId) =>
      promptDeliverySurface(tasks.stateDb.promptDeliveries.surfaceCandidates(sessionId)),
    ...(options.pendingInputMaxAttempts !== undefined
      ? { pendingInputMaxAttempts: options.pendingInputMaxAttempts }
      : {}),
    ...(options.pendingInputPollMs !== undefined
      ? { pendingInputPollMs: options.pendingInputPollMs }
      : {}),
    ...(options.pendingInputRetryBackoffMs
      ? { pendingInputRetryBackoffMs: options.pendingInputRetryBackoffMs }
      : {}),
    ...(options.pushRouter ? { pushRouter: options.pushRouter } : {})
  });
  const hooks = new HookRegistry();
  const timeline = new TimelineStore();
  timeline.observe((item) => promptDeliveries.acknowledgeTimeline(item));
  const server = createControlServer({
    adapter,
    auditLog: new AuditLog(join(home, "audit.jsonl")),
    authToken: "test-token",
    boxSecretKey: new Uint8Array(32),
    monitor,
    devices: new DeviceRegistry(env),
    port: 0,
    hooks,
    timeline,
    projects: new ProjectRegistry(env),
    worktrees: new WorktreePool({ env }),
    tasks,
    prPoller: new PrPoller(tasks, async () => {
      throw new Error("gh disabled in tests");
    }),
    promptDeliveries
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    adapter,
    monitor,
    tasks,
    hooks,
    promptDeliveries,
    async close() {
      promptDeliveries.stop();
      timeline.stop();
      monitor.stop();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      tasks.close();
    }
  };
}

async function withServer(
  run: (ctx: Awaited<ReturnType<typeof startServer>>) => Promise<void>,
  options: TestServerOptions = {},
  adapter = new RecordingAdapter()
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "perch-input-home-"));
  const context = await startServer(home, adapter, options);
  try {
    await run(context);
  } finally {
    await context.close();
    rmSync(home, { recursive: true, force: true });
  }
}

function postInput(port: number, text: string, interrupt = false): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/sessions/${encodeURIComponent(SESSION_ID)}/input`, {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ text, ...(interrupt ? { interrupt: true } : {}) })
  });
}

function postSubmit(port: number, text: string, interrupt = false): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/sessions/${encodeURIComponent(SESSION_ID)}/submit`, {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ text, ...(interrupt ? { interrupt: true } : {}) })
  });
}

function postApproval(port: number, id: string, decision = "allow"): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/sessions/${encodeURIComponent(SESSION_ID)}/approve`, {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ id, decision })
  });
}

function postHook(port: number, token: string, payload: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/hooks`, {
    method: "POST",
    headers: {
      "x-perch-session": SESSION_ID,
      "x-perch-token": token,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

async function waitForMessage(socket: MonitorSocket, id: string): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const message = socket.messages.find((candidate) => candidate.type === "rpc_response" && candidate.id === id);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}

async function waitForWrites(adapter: RecordingAdapter, count: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (adapter.writes.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(adapter.writes.length, count);
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!(await predicate()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(await predicate(), true);
}

async function queuedCount(port: number): Promise<number | undefined> {
  const response = await fetch(`http://127.0.0.1:${port}/sessions`, {
    headers: { authorization: "Bearer test-token" }
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { sessions: AgentSession[] };
  return body.sessions.find((session) => session.id === SESSION_ID)?.queuedCount;
}

async function sessionSnapshot(port: number): Promise<AgentSession | undefined> {
  const response = await fetch(`http://127.0.0.1:${port}/sessions`, {
    headers: { authorization: "Bearer test-token" }
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { sessions: AgentSession[] };
  return body.sessions.find((session) => session.id === SESSION_ID);
}

test("an idle mate durably queues and starts release near-immediately", async () => {
  await withServer(async ({ port, adapter, monitor, promptDeliveries }) => {
    monitor.applyExternalStatus(SESSION_ID, "idle", "claude", "hook");
    const started = Date.now();
    const response = await postInput(port, "please also update the tests\n");
    const elapsed = Date.now() - started;
    assert.equal(response.status, 202);
    assert.deepEqual((await response.json()) as object, { ok: true, queued: true });
    assert.ok(elapsed < 100, `idle enqueue should return quickly, waited ${elapsed}ms`);
    await waitForWrites(adapter, 2);
    assert.deepEqual(adapter.writes, ["please also update the tests\n", "\r"]);
    assert.equal(await queuedCount(port), 1);

    promptDeliveries.acknowledgeHook(SESSION_ID, "please also update the tests\n");
    monitor.applyExternalStatus(SESSION_ID, "running", "claude", "hook");
    await waitFor(async () => (await queuedCount(port)) === undefined);
  });
});

test("an idle mate releases despite a newer PTY redraw retaining coarse running status", async () => {
  await withServer(async ({ port, adapter, monitor, promptDeliveries }) => {
    monitor.applyExternalStatus(SESSION_ID, "idle", "claude", "hook");
    // PTY redraws update activity while the Claude process keeps its coarse
    // launch-time status. That activity is not a newer status observation.
    adapter.session.lastActivityAt = new Date(Date.now() + 1_000).toISOString();
    assert.equal(adapter.session.status, "running");
    assert.equal((await sessionSnapshot(port))?.status, "idle");

    const response = await postInput(port, "deliver while genuinely idle");
    assert.deepEqual(await response.json(), { ok: true, queued: true });
    await waitForWrites(adapter, 2);
    assert.deepEqual(adapter.writes, ["deliver while genuinely idle", "\r"]);

    promptDeliveries.acknowledgeHook(SESSION_ID, "deliver while genuinely idle");
    monitor.applyExternalStatus(SESSION_ID, "running", "claude", "hook");
    await waitFor(async () => (await queuedCount(port)) === undefined);
  });
});

test("a busy mate releases at turn end despite a newer PTY redraw retaining coarse running status", async () => {
  await withServer(async ({ port, adapter, monitor, promptDeliveries }) => {
    monitor.applyExternalStatus(SESSION_ID, "running", "claude", "hook");
    const response = await postInput(port, "deliver at the next turn end");
    assert.deepEqual(await response.json(), { ok: true, queued: true });
    assert.deepEqual(adapter.writes, []);

    adapter.session.lastActivityAt = new Date(Date.now() + 1_000).toISOString();
    monitor.applyExternalStatus(SESSION_ID, "idle", "claude", "hook");
    await waitForWrites(adapter, 2);
    assert.deepEqual(adapter.writes, ["deliver at the next turn end", "\r"]);

    promptDeliveries.acknowledgeHook(SESSION_ID, "deliver at the next turn end");
    monitor.applyExternalStatus(SESSION_ID, "running", "claude", "hook");
    await waitFor(async () => (await queuedCount(port)) === undefined);
  });
});

test("an idle mate release waits for a shared PTY desktop draft to clear", async () => {
  const adapter = new RecordingAdapter();
  adapter.composerEmpty = false;
  await withServer(async ({ port, monitor, tasks, promptDeliveries }) => {
    monitor.applyExternalStatus(SESSION_ID, "idle", "claude", "hook");
    const response = await postInput(port, "queued boss message");
    assert.deepEqual(await response.json(), { ok: true, queued: true });

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(adapter.writes, [], "release must not splice into the desktop draft");
    assert.equal(tasks.stateDb.pendingSessionInputs.list(SESSION_ID)[0]?.attemptCount, 0);

    adapter.composerEmpty = true;
    await waitForWrites(adapter, 2);
    assert.deepEqual(adapter.writes, ["queued boss message", "\r"]);

    promptDeliveries.acknowledgeHook(SESSION_ID, "queued boss message");
    monitor.applyExternalStatus(SESSION_ID, "running", "claude", "hook");
    await waitFor(async () => (await queuedCount(port)) === undefined);
  }, {
    pendingInputPollMs: 10
  }, adapter);
});

test("Claude PTY input stays submitted until its matching hook receipt accepts it", async () => {
  await withServer(async ({ port, adapter, tasks, hooks, monitor }) => {
    monitor.applyExternalStatus(SESSION_ID, "idle", "claude", "hook");
    const prompt = "please report the exact test result";
    const response = await postInput(port, prompt);
    assert.equal(response.status, 202);

    const [submitted] = tasks.stateDb.promptDeliveries.list(SESSION_ID);
    assert.equal(submitted?.state, "submitted");
    assert.deepEqual(adapter.writes, [prompt, "\r"]);

    const { token } = hooks.register(SESSION_ID);
    const receipt = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: "POST",
      headers: {
        "x-perch-session": SESSION_ID,
        "x-perch-token": token,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "claude-session-1",
        prompt
      })
    });
    assert.equal(receipt.status, 200);

    const accepted = tasks.stateDb.promptDeliveries.find(submitted!.id);
    assert.equal(accepted?.state, "accepted");
    assert.equal(accepted?.receiptKind, "user_prompt_submit");
    assert.deepEqual(adapter.writes, [prompt, "\r"], "receipt handling never resends the prompt");
  });
});

test("multi-line input stays one composer body and exactly one Enter", async () => {
  await withServer(async ({ port, adapter, monitor }) => {
    monitor.applyExternalStatus(SESSION_ID, "idle", "claude", "hook");
    const text = "line one\nline two\nline three";
    await postInput(port, text);
    // Internal newlines ride inside the single text write (composer content);
    // only the final standalone Enter submits - never one per line.
    await waitForWrites(adapter, 2);
    assert.deepEqual(adapter.writes, [text, "\r"]);
    assert.equal(adapter.writes.filter((write) => write === "\r").length, 1);
  });
});

test("home mate submit acks accepted delivery before slow PTY confirmation can trip the client timeout", async () => {
  await withServer(async ({ port, adapter, monitor }) => {
    monitor.applyExternalStatus(SESSION_ID, "idle", "claude", "hook");
    adapter.submitDelayMs = 1500;

    const started = Date.now();
    const response = await postSubmit(port, "message the mate");
    const elapsed = Date.now() - started;

    assert.equal(response.status, 202);
    assert.deepEqual((await response.json()) as object, { ok: true, queued: true });
    assert.ok(elapsed < 100, `submit response should not wait for slow PTY confirmation, waited ${elapsed}ms`);
    await waitForWrites(adapter, 2);
    assert.deepEqual(adapter.writes, ["message the mate", "\r"]);
  });
});

test("home mate submit preserves a real immediate delivery failure for retry", async () => {
  await withServer(async ({ port, adapter, monitor, tasks }) => {
    monitor.applyExternalStatus(SESSION_ID, "idle", "claude", "hook");
    adapter.failSubmit = true;

    const response = await postSubmit(port, "message the mate");

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, queued: true });
    assert.deepEqual(adapter.writes, []);
    await waitFor(() => tasks.stateDb.promptDeliveries.list(SESSION_ID)[0]?.state === "delivery_unknown");
    assert.equal(tasks.stateDb.pendingSessionInputs.count(SESSION_ID), 1);
  });
});

test("input queues while a permission prompt is open instead of typing into the dialog", async () => {
  await withServer(async ({ port, adapter, monitor }) => {
    monitor.setPendingApproval(SESSION_ID, {
      id: "appr-1",
      summary: "Run rm -rf?",
      at: new Date().toISOString()
    });
    const response = await postInput(port, "keep going");
    assert.equal(response.status, 202);
    assert.deepEqual((await response.json()) as object, { ok: true, queued: true });
    assert.deepEqual(adapter.writes, []);
  });
});

test("a busy mate receives a three-message burst on three separate turn boundaries in FIFO order", async (t) => {
  for (const agent of ["claude", "codex"] as const) {
    await t.test(agent, async () => {
      await withServer(async ({ port, adapter, monitor, tasks, promptDeliveries }) => {
        adapter.session.agent = agent;
        monitor.applyExternalStatus(SESSION_ID, "running", agent, "hook");

        const responses = [
          await postInput(port, "first"),
          await postInput(port, "second"),
          await postInput(port, "third")
        ];
        assert.deepEqual(
          await Promise.all(responses.map((response) => response.json())),
          Array.from({ length: 3 }, () => ({ ok: true, queued: true }))
        );
        assert.deepEqual(adapter.writes, []);
        assert.equal(await queuedCount(port), 3);
        assert.deepEqual(
          tasks.stateDb.pendingSessionInputs.list(SESSION_ID).map((input) => input.promptText),
          ["first", "second", "third"]
        );
        assert.equal(tasks.stateDb.promptDeliveries.list(SESSION_ID).length, 0);

        monitor.applyExternalStatus(SESSION_ID, "idle", agent, "hook");
        monitor.applyExternalStatus(SESSION_ID, "idle", agent, "hook");
        await waitForWrites(adapter, 2);
        assert.deepEqual(adapter.writes, ["first", "\r"]);
        assert.equal(await queuedCount(port), agent === "claude" ? 3 : 2);
        assert.deepEqual(
          tasks.stateDb.promptDeliveries.list(SESSION_ID).map((delivery) => delivery.state),
          agent === "claude" ? ["submitted"] : []
        );

        if (agent === "claude") promptDeliveries.acknowledgeHook(SESSION_ID, "first");
        monitor.applyExternalStatus(SESSION_ID, "running", agent, "hook");
        await waitFor(async () => (await queuedCount(port)) === 2);
        monitor.applyExternalStatus(SESSION_ID, "idle", agent, "hook");
        await waitForWrites(adapter, 4);
        assert.deepEqual(adapter.writes, ["first", "\r", "second", "\r"]);
        assert.equal(await queuedCount(port), agent === "claude" ? 2 : 1);

        if (agent === "claude") promptDeliveries.acknowledgeHook(SESSION_ID, "second");
        monitor.applyExternalStatus(SESSION_ID, "running", agent, "hook");
        await waitFor(async () => (await queuedCount(port)) === 1);
        monitor.applyExternalStatus(SESSION_ID, "idle", agent, "hook");
        await waitForWrites(adapter, 6);
        assert.deepEqual(adapter.writes, ["first", "\r", "second", "\r", "third", "\r"]);
        assert.equal(await queuedCount(port), agent === "claude" ? 1 : undefined);
        if (agent === "claude") {
          promptDeliveries.acknowledgeHook(SESSION_ID, "third");
          monitor.applyExternalStatus(SESSION_ID, "running", agent, "hook");
          await waitFor(async () => (await queuedCount(port)) === undefined);
        }
        assert.equal(tasks.stateDb.promptDeliveries.list(SESSION_ID).length, agent === "claude" ? 3 : 0);
      });
    });
  }
});

test("a receipt timeout retries through stale running status when the shared composer is empty", async () => {
  await withServer(async ({ port, adapter, monitor, tasks, promptDeliveries }) => {
    monitor.applyExternalStatus(SESSION_ID, "idle", "claude", "hook");
    const response = await postInput(port, "retry after receipt timeout");
    assert.deepEqual(await response.json(), { ok: true, queued: true });
    await waitForWrites(adapter, 2);

    const [submitted] = tasks.stateDb.promptDeliveries.list(SESSION_ID);
    assert.equal(submitted?.state, "submitted");
    monitor.applyExternalStatus(SESSION_ID, "running", "claude", "adapter");

    await waitForWrites(adapter, 4);
    assert.deepEqual(adapter.writes, [
      "retry after receipt timeout",
      "\r",
      "retry after receipt timeout",
      "\r"
    ]);
    const [retried] = tasks.stateDb.promptDeliveries.list(SESSION_ID);
    assert.equal(retried?.id, submitted?.id);
    assert.equal(tasks.stateDb.pendingSessionInputs.list(SESSION_ID)[0]?.attemptCount, 2);

    promptDeliveries.acknowledgeHook(SESSION_ID, "retry after receipt timeout");
    await waitFor(() => tasks.stateDb.pendingSessionInputs.count(SESSION_ID) === 0);
  }, {
    receiptTimeoutMs: 20,
    pendingInputPollMs: 5,
    pendingInputRetryBackoffMs: [10]
  });
});

test("an unknown mate delivery retries the durable head instead of wedging later human input", async () => {
  await withServer(async ({ port, adapter, monitor, tasks, hooks }) => {
    const { token } = hooks.register(SESSION_ID);
    const phone = new MonitorSocket();
    monitor.addClient(phone as unknown as WebSocket);
    adapter.failAfterSubmitCount = 1;
    monitor.applyExternalStatus(SESSION_ID, "running", "claude", "hook");

    const hello = await postInput(port, "Hello");
    const followUp = await postInput(port, "Hello??");
    assert.deepEqual(await hello.json(), { ok: true, queued: true });
    assert.deepEqual(await followUp.json(), { ok: true, queued: true });
    assert.equal(tasks.stateDb.pendingSessionInputs.count(SESSION_ID), 2);

    monitor.applyExternalStatus(SESSION_ID, "idle", "claude", "hook");
    await waitForWrites(adapter, 2);
    assert.deepEqual(adapter.writes, ["Hello", "\r"]);
    assert.equal(tasks.stateDb.pendingSessionInputs.count(SESSION_ID), 2);
    const [unknown] = tasks.stateDb.promptDeliveries.list(SESSION_ID);
    assert.equal(unknown?.state, "delivery_unknown");

    // This is the production wedge: the release failed after Enter while the
    // only idle transition was already being consumed. Repeated idle reads
    // and the monitor's periodic safe check must still retry the durable head.
    monitor.applyExternalStatus(SESSION_ID, "idle", "claude", "hook");
    monitor.applyExternalStatus(SESSION_ID, "idle", "claude", "adapter");
    phone.emit("close");
    await waitForWrites(adapter, 4);
    assert.deepEqual(adapter.writes, ["Hello", "\r", "Hello", "\r"]);
    const [retried] = tasks.stateDb.promptDeliveries.list(SESSION_ID);
    assert.equal(retried?.id, unknown?.id, "retry reuses one delivery identity");
    assert.equal(tasks.stateDb.pendingSessionInputs.list(SESSION_ID)[0]?.attemptCount, 2);

    const firstReceipt = await postHook(port, token, {
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-session-1",
      prompt: "Hello"
    });
    assert.equal(firstReceipt.status, 200);
    await waitFor(async () => (await queuedCount(port)) === 1);

    const boundary = await postHook(port, token, {
      hook_event_name: "Stop",
      session_id: "claude-session-1"
    });
    assert.equal(boundary.status, 200);
    await waitForWrites(adapter, 6);
    assert.deepEqual(adapter.writes, ["Hello", "\r", "Hello", "\r", "Hello??", "\r"]);

    const secondReceipt = await postHook(port, token, {
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-session-1",
      prompt: "Hello??"
    });
    assert.equal(secondReceipt.status, 200);
    await waitFor(async () => (await queuedCount(port)) === undefined);
    assert.deepEqual(tasks.stateDb.pendingSessionInputs.list(SESSION_ID), []);
  }, {
    pendingInputRetryBackoffMs: [20],
    pendingInputPollMs: 5
  });
});

test("an exhausted mate head warns the session and boss, then releases later input", async () => {
  const sent: PushNotification[] = [];
  const adapter = new RecordingAdapter();
  adapter.failSubmitCount = 2;
  const pushRouter = new PushRouter({
    push: { send: (notification) => { sent.push(notification); } },
    projectName: () => "perch"
  });

  await withServer(async ({ port, monitor, tasks, promptDeliveries }) => {
    monitor.applyExternalStatus(SESSION_ID, "running", "claude", "hook");
    await postInput(port, "cannot deliver");
    await postInput(port, "later message");

    monitor.applyExternalStatus(SESSION_ID, "idle", "claude", "hook");
    await waitFor(() => Boolean(tasks.stateDb.pendingSessionInputs.latestFailed(SESSION_ID)));
    await waitForWrites(adapter, 2);
    assert.deepEqual(adapter.writes, ["later message", "\r"]);

    const failed = tasks.stateDb.pendingSessionInputs.latestFailed(SESSION_ID);
    assert.equal(failed?.promptText, "cannot deliver");
    assert.equal(failed?.attemptCount, 2);
    assert.equal(tasks.stateDb.pendingSessionInputs.list(SESSION_ID)[0]?.promptText, "later message");
    const failurePushes = sent.filter((notification) => notification.title === "Mate message was not delivered");
    assert.equal(failurePushes.length, 1);

    const session = await sessionSnapshot(port);
    assert.equal(session?.promptDeliveryWarning?.deliveryId, failed?.id);
    assert.match(session?.promptDeliveryWarning?.message ?? "", /not delivered after 2 attempts/);

    promptDeliveries.acknowledgeHook(SESSION_ID, "later message");
    monitor.applyExternalStatus(SESSION_ID, "running", "claude", "hook");
    await waitFor(async () => (await queuedCount(port)) === undefined);
    assert.equal((await sessionSnapshot(port))?.promptDeliveryWarning, undefined);
  }, {
    pendingInputMaxAttempts: 2,
    pendingInputPollMs: 5,
    pendingInputRetryBackoffMs: [10],
    pushRouter
  }, adapter);
  pushRouter.stop();
});

test("interrupt input bypasses a busy mate's turn-boundary queue", async () => {
  await withServer(async ({ port, adapter, tasks }) => {
    const response = await postInput(port, "override now", true);

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, queued: false });
    assert.deepEqual(adapter.writes, ["override now", "\r"]);
    assert.equal(tasks.stateDb.pendingSessionInputs.count(SESSION_ID), 0);
  });
});

test("worker-session steering remains immediate while the worker turn is active", async () => {
  await withServer(async ({ port, adapter, tasks }) => {
    adapter.session.title = "worker";
    adapter.session.labels = { task: "task-1", parent: "pty:mate" };
    const response = await postInput(port, "worker override");

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, queued: false });
    assert.deepEqual(adapter.writes, ["worker override", "\r"]);
    assert.equal(tasks.stateDb.pendingSessionInputs.count(SESSION_ID), 0);
  });
});

test("server start retries a wedged in-flight mate delivery for an idle live session", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-input-restart-"));
  const firstAdapter = new RecordingAdapter();
  firstAdapter.session.status = "idle";
  const retryOptions = {
    pendingInputPollMs: 5,
    pendingInputRetryBackoffMs: [10]
  } as const;
  const first = await startServer(home, firstAdapter, retryOptions);
  let deliveryId: string | undefined;
  try {
    const accepted = await postSubmit(first.port, "survive restart");
    assert.deepEqual(await accepted.json(), { ok: true, queued: true });
    await waitForWrites(first.adapter, 2);
    assert.deepEqual(first.adapter.writes, ["survive restart", "\r"]);
    assert.equal(first.tasks.stateDb.pendingSessionInputs.count(SESSION_ID), 1);
    deliveryId = first.tasks.stateDb.pendingSessionInputs.list(SESSION_ID)[0]?.deliveryId;
    assert.equal(first.tasks.stateDb.promptDeliveries.find(deliveryId!)?.state, "submitted");
  } finally {
    await first.close();
  }

  const secondAdapter = new RecordingAdapter();
  secondAdapter.session.status = "idle";
  const second = await startServer(home, secondAdapter, retryOptions);
  try {
    assert.equal(second.tasks.stateDb.pendingSessionInputs.count(SESSION_ID), 1);
    await waitForWrites(second.adapter, 2);
    assert.deepEqual(second.adapter.writes, ["survive restart", "\r"]);
    const pending = second.tasks.stateDb.pendingSessionInputs.list(SESSION_ID)[0];
    assert.equal(pending?.deliveryId, deliveryId);
    assert.equal(pending?.attemptCount, 2);

    second.promptDeliveries.acknowledgeHook(SESSION_ID, "survive restart");
    second.monitor.applyExternalStatus(SESSION_ID, "running", "claude", "hook");
    await waitFor(() => second.tasks.stateDb.pendingSessionInputs.count(SESSION_ID) === 0);
  } finally {
    await second.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a Codex prompt without a structured request cannot be answered with a guessed PTY key", async () => {
  await withServer(async ({ port, adapter, monitor }) => {
    monitor.setPendingApproval(SESSION_ID, {
      id: "codex-fallback-1",
      summary: "Codex needs approval",
      at: new Date().toISOString(),
      remoteResolutionUnavailable: true
    });

    const response = await postApproval(port, "codex-fallback-1");

    assert.equal(response.status, 409);
    assert.deepEqual(adapter.writes, []);
  });
});

test("generic Claude approvals wait for a provider status barrier and reject duplicate responses", async () => {
  await withServer(async ({ port, adapter, monitor, tasks }) => {
    const task = tasks.update(tasks.create({ title: "run tests", project: "/repo" }).id, { sessionId: SESSION_ID });
    tasks.recordEvent(task.id, { kind: "working", source: "system" });
    monitor.setPendingApproval(SESSION_ID, {
      id: "claude-permission-1",
      summary: "Bash wants to run",
      command: "npm test",
      source: "hook",
      at: new Date().toISOString()
    });

    const response = await postApproval(port, "claude-permission-1", "allow");
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, pending: true });
    assert.deepEqual(adapter.writes, ["1"]);
    assert.equal(monitor.pendingApproval(SESSION_ID)?.submittedDecision, "allow");
    assert.equal(tasks.find(task.id)?.state, "needs_you");

    const duplicate = await postApproval(port, "claude-permission-1", "allow");
    assert.equal(duplicate.status, 409);
    assert.deepEqual(adapter.writes, ["1"]);

    monitor.applyExternalStatus(SESSION_ID, "running", "claude", "hook");
    assert.equal(monitor.pendingApproval(SESSION_ID), undefined);
    assert.equal(tasks.find(task.id)?.state, "working");
  });
});

test("Claude PermissionRequest hook blocks on durable CAS and returns exact structured JSON without PTY input", async () => {
  await withServer(async ({ port, adapter, monitor, hooks }) => {
    const { token } = hooks.register(SESSION_ID);
    const hookResponse = fetch(`http://127.0.0.1:${port}/hooks`, {
      method: "POST",
      headers: {
        "x-perch-session": SESSION_ID,
        "x-perch-token": token,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        hook_event_name: "PermissionRequest",
        session_id: "claude-session-1",
        cwd: "/tmp",
        tool_name: "Bash",
        tool_input: { command: "git status --short" }
      })
    });
    let pending = monitor.pendingApproval(SESSION_ID);
    for (let index = 0; !pending && index < 100; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      pending = monitor.pendingApproval(SESSION_ID);
    }
    assert.equal(pending?.requestVersion, 1);
    const decision = await fetch(`http://127.0.0.1:${port}/sessions/${encodeURIComponent(SESSION_ID)}/approve`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ id: pending!.id, decision: "allow", requestVersion: 1, runtimeGeneration: pending!.runtimeGeneration ?? null })
    });
    assert.equal(decision.status, 202);
    const response = await hookResponse;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } }
    });
    assert.deepEqual(adapter.writes, []);
    assert.equal(monitor.pendingApproval(SESSION_ID)?.state, "decision_sent");
  });
});

test("a verified hook report flips the session's queued task to working", async () => {
  await withServer(async ({ port, tasks, hooks }) => {
    const task = tasks.update(tasks.create({ title: "compute 6x7", project: "/repo" }).id, {
      sessionId: SESSION_ID
    });
    assert.equal(tasks.find(task.id)!.state, "queued");
    const { token } = hooks.register(SESSION_ID);

    const response = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: "POST",
      headers: {
        "x-perch-session": SESSION_ID,
        "x-perch-token": token,
        "content-type": "application/json"
      },
      body: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "agent-1" })
    });
    assert.equal(response.status, 200);

    const after = tasks.find(task.id)!;
    assert.equal(after.state, "working");
    const events = tasks.events(task.id);
    assert.ok(events.some((event) => event.kind === "working" && event.source === "system"));
  });
});
