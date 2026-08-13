import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession, FleetEvent, RecentEventsResult } from "@perch/shared";
import type { WebSocket } from "ws";
import type { AgentAdapter } from "./adapters/types.js";
import { PtyAgentAdapter, type PtyProcess } from "./adapters/pty.js";
import { resolveApprovalForTask, surfaceApprovalToTask } from "./agentLauncher.js";
import { AuditLog } from "./audit.js";
import { FleetMonitor, type FleetMonitorOptions } from "./fleetMonitor.js";
import { HookRegistry } from "./hooks.js";
import { createControlServer, handleWebSocketRpcRequest } from "./http.js";
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

class ScriptedMatePty implements PtyProcess {
  pid = process.pid;
  readonly writes: Array<{ data: string; at: number }> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  constructor(private readonly onWrite?: (data: string) => void) {}

  write(data: string): void {
    this.writes.push({ data, at: Date.now() });
    // A real terminal echoes composed input before Claude processes Enter.
    this.emitData(data);
    this.onWrite?.(data);
  }

  kill(): void {
    for (const listener of this.exitListeners) listener({ exitCode: 0 });
  }

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
}

class TranscriptMatePty implements PtyProcess {
  pid = process.pid;
  readonly writes: Array<{ data: string; at: number }> = [];
  readonly submissions: string[] = [];
  private composer = "";
  private receipt = 0;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  constructor(private readonly transcript: string) {}

  write(data: string): void {
    this.writes.push({ data, at: Date.now() });
    if (data === "\x15") {
      this.composer = "";
      this.emitData(data);
      return;
    }
    if (data !== "\r") {
      this.composer += data;
      this.emitData(data);
      return;
    }

    const submitted = this.composer;
    this.composer = "";
    if (submitted) {
      this.submissions.push(submitted);
      this.receipt += 1;
      appendFileSync(
        this.transcript,
        `${JSON.stringify({
          type: "user",
          uuid: `interleaved-receipt-${this.receipt}`,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: submitted }
        })}\n`
      );
    }
    this.emitData("\r\n❯ ");
  }

  kill(): void {
    for (const listener of this.exitListeners) listener({ exitCode: 0 });
  }

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
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
  let observePromptDelivery: ((delivery: import("./stateDb.js").PromptDeliveryRecord, state: "accepted" | "unknown") => void) | undefined;
  const promptDeliveries = new PromptDeliveryTracker(tasks.stateDb, {
    receiptTimeoutMs: options.receiptTimeoutMs ?? 5_000,
    onAccepted: (delivery) => observePromptDelivery?.(delivery, "accepted"),
    onUnknown: (delivery) => observePromptDelivery?.(delivery, "unknown")
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
    ...(options.pendingInputRetryBackoffMs
      ? { pendingInputRetryBackoffMs: options.pendingInputRetryBackoffMs }
      : {}),
    ...(options.pushRouter ? { pushRouter: options.pushRouter } : {})
  });
  observePromptDelivery = (delivery, state) => {
    if (state === "accepted") {
      monitor.onPromptDeliveryAccepted(delivery);
    } else {
      monitor.onPromptDeliveryUnknown(delivery);
    }
  };
  const hooks = new HookRegistry();
  const timeline = new TimelineStore();
  timeline.observe((item) => promptDeliveries.acknowledgeTimeline(item));
  const serverOptions = {
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
  };
  const server = createControlServer(serverOptions);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    adapter,
    monitor,
    tasks,
    hooks,
    timeline,
    promptDeliveries,
    options: serverOptions,
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

async function waitForWrites(adapter: RecordingAdapter, count: number, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (adapter.writes.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(adapter.writes.length, count);
}

async function waitForPtyWrite(child: ScriptedMatePty, data: string, after: number): Promise<number> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const write = child.writes.find((candidate) => candidate.data === data && candidate.at >= after);
    if (write) return write.at;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`PTY did not receive ${JSON.stringify(data)} within one second`);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
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
    const released = await sessionSnapshot(port);
    assert.equal(released?.inputDelivery?.state, "released");
    assert.ok(released?.inputDelivery?.enqueuedAt);
    assert.ok(released?.inputDelivery?.releasedAt);

    promptDeliveries.acknowledgeHook(SESSION_ID, "please also update the tests\n");
    monitor.applyExternalStatus(SESSION_ID, "running", "claude", "hook");
    await waitFor(async () => (await queuedCount(port)) === undefined);
    const confirmed = await sessionSnapshot(port);
    assert.equal(confirmed?.inputDelivery, undefined);
  });
});

test("mate-like PTY transcript confirms literal and transformed input exactly once", async (t) => {
  const cases = [
    { name: "plain text", text: "please verify the delivery receipt" },
    { name: "multiline batch", text: "first queued message\nsecond queued message" },
    { name: "textual attachment reference", text: "review @docs/delivery-notes.md before replying" },
    {
      name: "slash command",
      text: "/eli5 how we implemented this",
      transcriptText:
        "<command-message>eli5</command-message>\n" +
        "<command-name>/eli5</command-name>\n" +
        "<command-args>how we implemented this</command-args>"
    }
  ];

  for (const input of cases) {
    await t.test(input.name, async () => {
      const transcriptHome = mkdtempSync(join(tmpdir(), "perch-input-transcript-"));
      const transcript = join(transcriptHome, "mate.jsonl");
      writeFileSync(transcript, "");
      let child: ScriptedMatePty | undefined;
      const adapter = new PtyAgentAdapter(() => {
        child = new ScriptedMatePty((data) => {
          if (data !== "\r") return;
          appendFileSync(
            transcript,
            `${JSON.stringify({
              type: "user",
              uuid: `receipt-${input.name}`,
              timestamp: new Date().toISOString(),
              message: { role: "user", content: input.transcriptText ?? input.text }
            })}\n`
          );
          child!.emitData("\r\n❯ ");
        });
        return child;
      });
      await adapter.startAgent({
        command: "claude",
        sessionId: SESSION_ID,
        title: "mate",
        labels: { role: "mate" }
      });

      try {
        await withServer(async ({ port, monitor, tasks, timeline }) => {
          timeline.attach(SESSION_ID, transcript);
          child!.emitData("❯ ");
          monitor.applyExternalStatus(SESSION_ID, "idle", "claude", "hook");

          const response = await postInput(port, input.text);
          assert.equal(response.status, 202);
          assert.deepEqual(await response.json(), { ok: true, queued: true });
          await waitFor(
            () => tasks.stateDb.promptDeliveries.list(SESSION_ID)[0]?.state === "accepted",
            5_000
          );
          await new Promise((resolve) => setTimeout(resolve, 100));

          assert.equal(
            child!.writes.filter((write) => write.data === input.text).length,
            1,
            "confirmed input must not be typed again"
          );
          assert.equal(
            child!.writes.filter((write) => write.data === "\r").length,
            1,
            "confirmed input must have exactly one submission"
          );
          assert.equal(tasks.stateDb.pendingSessionInputs.count(SESSION_ID), 0);
          assert.deepEqual(
            tasks.stateDb.promptDeliveries.list(SESSION_ID).map((delivery) => ({
              promptText: delivery.promptText,
              state: delivery.state,
              receiptKind: delivery.receiptKind
            })),
            [{ promptText: input.text, state: "accepted", receiptKind: "transcript" }]
          );
        }, {
          receiptTimeoutMs: 2_500,
          pendingInputRetryBackoffMs: [10]
        }, adapter as unknown as RecordingAdapter);
      } finally {
        adapter.stop();
        rmSync(transcriptHome, { recursive: true, force: true });
      }
    });
  }
});

test("interleaved boss and mailbox deliveries reach one mate PTY exactly once", async () => {
  const transcriptHome = mkdtempSync(join(tmpdir(), "perch-input-interleave-"));
  const transcript = join(transcriptHome, "mate.jsonl");
  writeFileSync(transcript, "");
  let child: TranscriptMatePty | undefined;
  const adapter = new PtyAgentAdapter(() => {
    child = new TranscriptMatePty(transcript);
    return child;
  });
  await adapter.startAgent({
    command: "claude",
    sessionId: SESSION_ID,
    title: "mate",
    labels: { role: "mate" }
  });

  const firstNudge = "[perch mailbox] 1 unread item - use mailbox tools";
  const secondNudge = "[perch mailbox] 2 unread items - use mailbox tools";
  const bossText = "Add dark mode to my gym app";

  try {
    await withServer(async ({ port, monitor, tasks, timeline }) => {
      timeline.attach(SESSION_ID, transcript);
      child!.emitData("❯ ");
      monitor.applyExternalStatus(SESSION_ID, "idle", "claude", "hook");

      const response = await postInput(port, bossText);
      assert.equal(response.status, 202);
      const nudges = [
        monitor.queueOrSubmit(SESSION_ID, firstNudge, { silent: true }),
        monitor.queueOrSubmit(SESSION_ID, secondNudge, { silent: true })
      ];
      await Promise.all(nudges);

      await waitFor(
        () => {
          const deliveries = tasks.stateDb.promptDeliveries.list(SESSION_ID);
          return deliveries.length === 3 && deliveries.every((delivery) => delivery.state === "accepted");
        },
        10_000
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.deepEqual(child!.submissions, [firstNudge, secondNudge, bossText]);
      assert.equal(child!.writes.filter((write) => write.data === "\r").length, 3);
      assert.equal(tasks.stateDb.pendingSessionInputs.count(SESSION_ID), 0);
      const deliveries = tasks.stateDb.promptDeliveries.list(SESSION_ID);
      assert.deepEqual(
        [firstNudge, secondNudge, bossText].map((promptText) => {
          const delivery = deliveries.find((candidate) => candidate.promptText === promptText);
          return {
            promptText: delivery?.promptText,
            state: delivery?.state,
            receiptKind: delivery?.receiptKind
          };
        }),
        [firstNudge, secondNudge, bossText].map((promptText) => ({
          promptText,
          state: "accepted",
          receiptKind: "transcript"
        }))
      );
    }, {
      receiptTimeoutMs: 2_500,
      pendingInputRetryBackoffMs: [10]
    }, adapter as unknown as RecordingAdapter);
  } finally {
    adapter.stop();
    rmSync(transcriptHome, { recursive: true, force: true });
  }
});

test("idle mate PTY tap-to-terminal p95 stays below five seconds", async () => {
  let child: ScriptedMatePty | undefined;
  const adapter = new PtyAgentAdapter(() => {
    child = new ScriptedMatePty();
    return child;
  });
  await adapter.startAgent({
    command: "claude",
    sessionId: SESSION_ID,
    title: "mate",
    labels: { role: "mate" }
  });

  try {
    await withServer(async ({ port, monitor, promptDeliveries }) => {
      const phone = new MonitorSocket();
      monitor.addClient(phone as unknown as WebSocket);
      child!.emitData("❯ ");
      await waitFor(async () => (await sessionSnapshot(port))?.status === "idle");

      const latencies: number[] = [];
      for (let index = 0; index < 20; index += 1) {
        const text = `m${index}`;
        const started = Date.now();
        const response = await postInput(port, text);
        assert.equal(response.status, 202);
        const typedAt = await waitForPtyWrite(child!, text, started);
        latencies.push(typedAt - started);

        await waitForPtyWrite(child!, "\r", typedAt);
        promptDeliveries.acknowledgeHook(SESSION_ID, text);
        // Claude redraws the fenced empty composer at the next turn boundary.
        child!.emitData("\r\x1b[2K❯ ");
        await waitFor(async () => (await sessionSnapshot(port))?.status === "idle");
      }

      const p95 = [...latencies].sort((left, right) => left - right)[18]!;
      assert.ok(p95 < 5_000, `expected tap-to-terminal p95 under 5s, got ${p95}ms`);
    }, {}, adapter as unknown as RecordingAdapter);
  } finally {
    adapter.stop();
  }
});

test("an idle mate receives a three-message burst as one ordered delivery", async (t) => {
  for (const agent of ["claude", "codex"] as const) {
    await t.test(agent, async () => {
      await withServer(async ({ port, adapter, monitor, tasks, promptDeliveries }) => {
        adapter.session.agent = agent;
        monitor.applyExternalStatus(SESSION_ID, "idle", agent, "hook");

        const responses = await Promise.all([
          postInput(port, "first"),
          postInput(port, "second"),
          postInput(port, "third")
        ]);
        assert.deepEqual(
          await Promise.all(responses.map((response) => response.json())),
          Array.from({ length: 3 }, () => ({ ok: true, queued: true }))
        );

        const combined = "first\nsecond\nthird";
        await waitForWrites(adapter, 2);
        assert.deepEqual(adapter.writes, [combined, "\r"]);
        assert.equal(await queuedCount(port), agent === "claude" ? 3 : undefined);
        const pending = tasks.stateDb.pendingSessionInputs.list(SESSION_ID);
        const deliveries = tasks.stateDb.promptDeliveries.list(SESSION_ID);
        assert.deepEqual(deliveries.map((delivery) => delivery.promptText), agent === "claude" ? [combined] : []);
        assert.deepEqual(
          pending.map((input) => input.deliveryId),
          agent === "claude" ? Array.from({ length: 3 }, () => deliveries[0]!.id) : []
        );

        if (agent === "claude") {
          promptDeliveries.acknowledgeHook(SESSION_ID, combined);
          monitor.applyExternalStatus(SESSION_ID, "running", agent, "hook");
          await waitFor(async () => (await queuedCount(port)) === undefined);
        }
      });
    });
  }
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
    // The PTY's verified composer-ready event wakes release. There is no
    // eligibility poll to discover that a shared desktop draft was cleared.
    monitor.applyExternalStatus(SESSION_ID, "idle", "claude", "adapter");
    await waitForWrites(adapter, 2);
    assert.deepEqual(adapter.writes, ["queued boss message", "\r"]);

    promptDeliveries.acknowledgeHook(SESSION_ID, "queued boss message");
    monitor.applyExternalStatus(SESSION_ID, "running", "claude", "hook");
    await waitFor(async () => (await queuedCount(port)) === undefined);
  }, {}, adapter);
});

test("Claude PTY input stays submitted until its matching hook receipt accepts it", async () => {
  await withServer(async ({ port, adapter, tasks, hooks, monitor }) => {
    monitor.applyExternalStatus(SESSION_ID, "idle", "claude", "hook");
    const prompt = "please report the exact test result";
    const response = await postInput(port, prompt);
    assert.equal(response.status, 202);

    await waitFor(() => tasks.stateDb.promptDeliveries.list(SESSION_ID)[0]?.state === "submitted");
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

test("a busy mate receives a three-message burst as one ordered turn-boundary delivery", async (t) => {
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
        const pendingIds = tasks.stateDb.pendingSessionInputs.list(SESSION_ID).map((input) => input.id);
        assert.equal(tasks.stateDb.promptDeliveries.list(SESSION_ID).length, 0);

        monitor.applyExternalStatus(SESSION_ID, "idle", agent, "hook");
        monitor.applyExternalStatus(SESSION_ID, "idle", agent, "hook");
        await waitForWrites(adapter, 2);
        const combined = "first\nsecond\nthird";
        assert.deepEqual(adapter.writes, [combined, "\r"]);
        assert.equal(await queuedCount(port), agent === "claude" ? 3 : undefined);
        assert.deepEqual(
          tasks.stateDb.promptDeliveries.list(SESSION_ID).map((delivery) => [delivery.state, delivery.promptText]),
          agent === "claude" ? [["submitted", combined]] : []
        );

        if (agent === "claude") {
          const deliveryIds = tasks.stateDb.pendingSessionInputs
            .list(SESSION_ID)
            .map((input) => input.deliveryId);
          assert.deepEqual(
            deliveryIds,
            Array.from({ length: 3 }, () => tasks.stateDb.promptDeliveries.list(SESSION_ID)[0]!.id)
          );
          promptDeliveries.acknowledgeHook(SESSION_ID, combined);
          monitor.applyExternalStatus(SESSION_ID, "running", agent, "hook");
        }
        await waitFor(async () => (await queuedCount(port)) === undefined);
        assert.deepEqual(
          pendingIds.map((id) => tasks.stateDb.pendingSessionInputs.find(id)),
          Array.from({ length: 3 }, () => undefined),
          "confirmed queue rows are deleted instead of retained as delivery history"
        );
        assert.equal(tasks.stateDb.promptDeliveries.list(SESSION_ID).length, agent === "claude" ? 1 : 0);
      });
    });
  }
});

test("seven released mate inputs are removed after their shared delivery is confirmed", async () => {
  await withServer(async ({ port, adapter, monitor, tasks, promptDeliveries }) => {
    const prompts = Array.from({ length: 7 }, (_, index) => `production row ${index + 1}`);
    monitor.applyExternalStatus(SESSION_ID, "running", "claude", "hook");
    const responses = await Promise.all(prompts.map((prompt) => postInput(port, prompt)));
    assert.deepEqual(
      await Promise.all(responses.map((response) => response.json())),
      Array.from({ length: 7 }, () => ({ ok: true, queued: true }))
    );
    const pendingIds = tasks.stateDb.pendingSessionInputs.list(SESSION_ID).map((input) => input.id);
    assert.equal(pendingIds.length, 7);

    monitor.applyExternalStatus(SESSION_ID, "idle", "claude", "hook");
    const combined = prompts.join("\n");
    await waitForWrites(adapter, 2);
    assert.deepEqual(adapter.writes, [combined, "\r"]);

    promptDeliveries.acknowledgeHook(SESSION_ID, combined);
    monitor.applyExternalStatus(SESSION_ID, "running", "claude", "hook");
    await waitFor(async () => (await queuedCount(port)) === undefined);
    assert.deepEqual(pendingIds.map((id) => tasks.stateDb.pendingSessionInputs.find(id)), Array(7).fill(undefined));
    assert.deepEqual(adapter.writes, [combined, "\r"], "confirmation never delivers the batch a second time");
  });
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
    pendingInputRetryBackoffMs: [10]
  });
});

test("an unconfirmed mate delivery retries within fifteen seconds", async () => {
  await withServer(async ({ port, adapter, monitor, promptDeliveries, tasks }) => {
    monitor.applyExternalStatus(SESSION_ID, "idle", "claude", "hook");
    const started = Date.now();
    const response = await postInput(port, "retry at production timeout");
    assert.equal(response.status, 202);
    await waitForWrites(adapter, 4, 6_000);
    const elapsed = Date.now() - started;
    assert.deepEqual(adapter.writes, [
      "retry at production timeout",
      "\r",
      "retry at production timeout",
      "\r"
    ]);
    assert.ok(elapsed < 15_000, `expected retry under 15s, got ${elapsed}ms`);
    assert.equal(tasks.stateDb.pendingSessionInputs.list(SESSION_ID)[0]?.attemptCount, 2);

    promptDeliveries.acknowledgeHook(SESSION_ID, "retry at production timeout");
    await waitFor(() => tasks.stateDb.pendingSessionInputs.count(SESSION_ID) === 0);
  }, { receiptTimeoutMs: 4_000 });
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
    const combined = "Hello\nHello??";
    assert.deepEqual(adapter.writes, [combined, "\r"]);
    assert.equal(tasks.stateDb.pendingSessionInputs.count(SESSION_ID), 2);
    const [unknown] = tasks.stateDb.promptDeliveries.list(SESSION_ID);
    assert.equal(unknown?.state, "delivery_unknown");
    assert.equal(unknown?.promptText, combined);
    assert.equal(
      new Set(tasks.stateDb.pendingSessionInputs.list(SESSION_ID).map((input) => input.deliveryId)).size,
      1
    );

    const later = await postInput(port, "later after unknown");
    assert.deepEqual(await later.json(), { ok: true, queued: true });
    assert.equal(tasks.stateDb.pendingSessionInputs.count(SESSION_ID), 3);
    const pendingIds = tasks.stateDb.pendingSessionInputs.list(SESSION_ID).map((input) => input.id);

    // This is the production wedge: the release failed after Enter while the
    // only idle transition was already being consumed. Repeated idle reads
    // and the monitor's periodic safe check must still retry the durable head.
    monitor.applyExternalStatus(SESSION_ID, "idle", "claude", "hook");
    monitor.applyExternalStatus(SESSION_ID, "idle", "claude", "adapter");
    phone.emit("close");
    await waitForWrites(adapter, 4);
    assert.deepEqual(adapter.writes, [combined, "\r", combined, "\r"]);
    const [retried] = tasks.stateDb.promptDeliveries.list(SESSION_ID);
    assert.equal(retried?.id, unknown?.id, "retry reuses one delivery identity");
    assert.deepEqual(
      tasks.stateDb.pendingSessionInputs.list(SESSION_ID).map((input) => input.attemptCount),
      [2, 2, 0]
    );

    const firstReceipt = await postHook(port, token, {
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-session-1",
      prompt: combined
    });
    assert.equal(firstReceipt.status, 200);
    await waitFor(async () => (await queuedCount(port)) === 1);

    const boundary = await postHook(port, token, {
      hook_event_name: "Stop",
      session_id: "claude-session-1"
    });
    assert.equal(boundary.status, 200);
    await waitForWrites(adapter, 6);
    assert.deepEqual(adapter.writes, [combined, "\r", combined, "\r", "later after unknown", "\r"]);

    const secondReceipt = await postHook(port, token, {
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-session-1",
      prompt: "later after unknown"
    });
    assert.equal(secondReceipt.status, 200);
    await waitFor(async () => (await queuedCount(port)) === undefined);
    assert.deepEqual(tasks.stateDb.pendingSessionInputs.list(SESSION_ID), []);
    assert.deepEqual(pendingIds.map((id) => tasks.stateDb.pendingSessionInputs.find(id)), Array(3).fill(undefined));
  }, {
    pendingInputRetryBackoffMs: [20]
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

    monitor.applyExternalStatus(SESSION_ID, "idle", "claude", "hook");
    await waitFor(() => tasks.stateDb.pendingSessionInputs.list(SESSION_ID)[0]?.attemptCount === 1);
    await postInput(port, "later message");
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
    pendingInputRetryBackoffMs: [10]
  } as const;
  const first = await startServer(home, firstAdapter, retryOptions);
  let deliveryId: string | undefined;
  let pendingId: string | undefined;
  try {
    const accepted = await postSubmit(first.port, "survive restart");
    assert.deepEqual(await accepted.json(), { ok: true, queued: true });
    await waitForWrites(first.adapter, 2);
    assert.deepEqual(first.adapter.writes, ["survive restart", "\r"]);
    assert.equal(first.tasks.stateDb.pendingSessionInputs.count(SESSION_ID), 1);
    pendingId = first.tasks.stateDb.pendingSessionInputs.list(SESSION_ID)[0]?.id;
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
    assert.equal(second.tasks.stateDb.pendingSessionInputs.find(pendingId!), undefined);
  } finally {
    await second.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("server start clears stale unlinked released mate input instead of replaying it", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-input-stale-orphan-"));
  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  const first = new TaskStore(env);
  try {
    const staleAt = new Date(Date.now() - 3 * 60 * 1_000).toISOString();
    const orphan = first.stateDb.pendingSessionInputs.enqueue({
      perchSessionId: SESSION_ID,
      promptText: "already delivered before linkage existed",
      source: "human"
    });
    assert.ok(first.stateDb.pendingSessionInputs.beginBatchAttempt([orphan.id], {
      nextAttemptAt: staleAt,
      releasedAt: staleAt
    }));
  } finally {
    first.close();
  }

  const adapter = new RecordingAdapter();
  adapter.session.status = "idle";
  const second = await startServer(home, adapter);
  try {
    assert.equal(second.tasks.stateDb.pendingSessionInputs.count(SESSION_ID), 0);
    assert.deepEqual(adapter.writes, []);
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

test("Codex PermissionRequest hook telemetry creates no approval, push, or needs_decision", async () => {
  const pushes: PushNotification[] = [];
  const adapter = new RecordingAdapter();
  adapter.session.agent = undefined;
  const pushRouter = new PushRouter({
    push: { send: (notification) => pushes.push(notification) },
    projectName: () => "perch",
    findSession: () => adapter.session
  });

  await withServer(async ({ port, monitor, tasks, hooks }) => {
    const task = tasks.update(tasks.create({ title: "auto-reviewed command", project: "/repo" }).id, {
      sessionId: SESSION_ID
    });
    tasks.stateDb.runtimes.create({
      taskId: task.id,
      generation: 0,
      state: "live",
      agent: "codex",
      provider: "codex",
      providerSessionId: "codex-thread-1",
      ptySessionId: SESSION_ID
    });
    tasks.recordEvent(task.id, { kind: "working", source: "system" });
    const { token } = hooks.register(SESSION_ID);

    const response = await postHook(port, token, {
      hook_event_name: "PermissionRequest",
      session_id: "codex-thread-1",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: { command: "npm test" }
    });
    assert.equal(response.status, 200);

    assert.equal(monitor.pendingApproval(SESSION_ID), undefined);
    assert.equal(pushes.length, 0);
    assert.equal(
      tasks.events(task.id).filter((event) => event.kind === "needs_decision").length,
      0
    );
    assert.equal(monitor.withLiveState([adapter.session])[0]?.status, "running");
  }, { pushRouter }, adapter);
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

test("Claude PermissionRequest exact durable rule option round-trips through the phone API", async () => {
  await withServer(async ({ port, adapter, monitor, hooks }) => {
    const { token } = hooks.register(SESSION_ID);
    const hookResponse = postHook(port, token, {
      hook_event_name: "PermissionRequest",
      session_id: "claude-session-rule",
      cwd: "/tmp",
      tool_name: "Bash",
      tool_input: { command: "git status --short" },
      permission_suggestions: [{ type: "addRules", destination: "userSettings", rules: ["Bash(git status:*)"] }]
    });
    let pending = monitor.pendingApproval(SESSION_ID);
    for (let index = 0; !pending && index < 100; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      pending = monitor.pendingApproval(SESSION_ID);
    }
    const ruleDecision = pending?.decisions?.find((decision) => decision.id.startsWith("allow_always:"));
    assert.ok(ruleDecision, "the phone surface receives the exact durable rule choice");

    const decision = await fetch(`http://127.0.0.1:${port}/sessions/${encodeURIComponent(SESSION_ID)}/approve`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({
        id: pending!.id,
        decision: ruleDecision.id,
        requestVersion: 1,
        runtimeGeneration: pending!.runtimeGeneration ?? null
      })
    });
    assert.equal(decision.status, 202);
    const response = await hookResponse;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedPermissions: [{ type: "addRules", destination: "userSettings", rules: ["Bash(git status:*)"] }]
        }
      }
    });
    assert.deepEqual(adapter.writes, []);
  });
});

test("Claude PermissionRequest is answerable through relay RPC with exact id and generation", async () => {
  await withServer(async ({ port, adapter, monitor, hooks, options }) => {
    const { token } = hooks.register(SESSION_ID);
    const hookResponse = postHook(port, token, {
      hook_event_name: "PermissionRequest",
      session_id: "claude-session-relay",
      cwd: "/tmp",
      tool_name: "Bash",
      tool_input: { command: "git status --short" }
    });
    let pending = monitor.pendingApproval(SESSION_ID);
    for (let index = 0; !pending && index < 100; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      pending = monitor.pendingApproval(SESSION_ID);
    }
    assert.equal(pending?.requestVersion, 1);

    const stale = await handleWebSocketRpcRequest(
      {
        type: "rpc",
        id: "claude-stale",
        method: "POST",
        path: `/sessions/${encodeURIComponent(SESSION_ID)}/approve`,
        body: {
          id: pending!.id,
          decision: "deny",
          requestVersion: 1,
          runtimeGeneration: (pending!.runtimeGeneration ?? 0) + 1
        }
      },
      { kind: "device", deviceId: "phone" },
      options
    );
    assert.equal(stale.status, 409);

    const decision = await handleWebSocketRpcRequest(
      {
        type: "rpc",
        id: "claude-deny",
        method: "POST",
        path: `/sessions/${encodeURIComponent(SESSION_ID)}/approve`,
        body: {
          id: pending!.id,
          decision: "deny",
          requestVersion: 1,
          runtimeGeneration: pending!.runtimeGeneration ?? null
        }
      },
      { kind: "device", deviceId: "phone" },
      options
    );
    assert.equal(decision.status, 202);
    const duplicate = await handleWebSocketRpcRequest(
      {
        type: "rpc",
        id: "claude-deny-retry",
        method: "POST",
        path: `/sessions/${encodeURIComponent(SESSION_ID)}/approve`,
        body: {
          id: pending!.id,
          decision: "deny",
          requestVersion: 1,
          runtimeGeneration: pending!.runtimeGeneration ?? null
        }
      },
      { kind: "device", deviceId: "phone" },
      options
    );
    assert.equal(duplicate.status, 202);

    const response = await hookResponse;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "Denied by the boss in Perch" }
      }
    });
    assert.deepEqual(adapter.writes, []);
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
