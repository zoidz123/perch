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
import { FleetMonitor } from "./fleetMonitor.js";
import { HookRegistry } from "./hooks.js";
import { createControlServer } from "./http.js";
import { DeviceRegistry } from "./pairing.js";
import { PrPoller } from "./prPoller.js";
import { PromptDeliveryTracker } from "./promptDeliveries.js";
import { ProjectRegistry } from "./projects.js";
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
    if (this.failSubmit) {
      throw new Error("submit failed");
    }
    await this.sendInput(sessionId, text);
    await this.sendEnter();
    if (this.submitDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.submitDelayMs));
    }
    return true;
  }
  async interrupt(): Promise<void> {}
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

async function startServer(home: string, adapter = new RecordingAdapter()) {
  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  const tasks = new TaskStore(env);
  const promptDeliveries = new PromptDeliveryTracker(tasks.stateDb, { receiptTimeoutMs: 5_000 });
  const monitor = new FleetMonitor(adapter, {
    broadcastMs: 5,
    tailThrottleMs: 1,
    onApprovalNeeded: (sessionId, approval) => surfaceApprovalToTask(tasks, sessionId, approval),
    onApprovalResolved: (sessionId, approval) => resolveApprovalForTask(tasks, sessionId, approval),
    promptDeliveries
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
  run: (ctx: Awaited<ReturnType<typeof startServer>>) => Promise<void>
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "perch-input-home-"));
  const context = await startServer(home);
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

async function queuedCount(port: number): Promise<number | undefined> {
  const response = await fetch(`http://127.0.0.1:${port}/sessions`, {
    headers: { authorization: "Bearer test-token" }
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { sessions: AgentSession[] };
  return body.sessions.find((session) => session.id === SESSION_ID)?.queuedCount;
}

test("a single POST /sessions/:id/input submits: the text write, then a distinct Enter", async () => {
  await withServer(async ({ port, adapter, monitor }) => {
    monitor.applyExternalStatus(SESSION_ID, "idle", "claude", "hook");
    const response = await postInput(port, "please also update the tests\n");
    assert.equal(response.status, 202);
    assert.deepEqual((await response.json()) as object, { ok: true, queued: false });
    assert.deepEqual(adapter.writes, ["please also update the tests\n", "\r"]);
  });
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
    assert.deepEqual((await response.json()) as object, { ok: true, queued: false });
    assert.ok(elapsed < 1300, `submit response should not wait for slow PTY confirmation, waited ${elapsed}ms`);
    assert.deepEqual(adapter.writes, ["message the mate", "\r"]);
  });
});

test("home mate submit still reports a real immediate delivery failure", async () => {
  await withServer(async ({ port, adapter, monitor }) => {
    monitor.applyExternalStatus(SESSION_ID, "idle", "claude", "hook");
    adapter.failSubmit = true;

    const response = await postSubmit(port, "message the mate");

    assert.equal(response.status, 500);
    assert.deepEqual(adapter.writes, []);
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
      await withServer(async ({ port, adapter, monitor, tasks }) => {
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
        assert.equal(await queuedCount(port), 2);
        assert.deepEqual(
          tasks.stateDb.promptDeliveries.list(SESSION_ID).map((delivery) => delivery.state),
          agent === "claude" ? ["submitted"] : []
        );

        monitor.applyExternalStatus(SESSION_ID, "running", agent, "hook");
        monitor.applyExternalStatus(SESSION_ID, "idle", agent, "hook");
        await waitForWrites(adapter, 4);
        assert.deepEqual(adapter.writes, ["first", "\r", "second", "\r"]);
        assert.equal(await queuedCount(port), 1);

        monitor.applyExternalStatus(SESSION_ID, "running", agent, "hook");
        monitor.applyExternalStatus(SESSION_ID, "idle", agent, "hook");
        await waitForWrites(adapter, 6);
        assert.deepEqual(adapter.writes, ["first", "\r", "second", "\r", "third", "\r"]);
        assert.equal(await queuedCount(port), undefined);
        assert.equal(tasks.stateDb.promptDeliveries.list(SESSION_ID).length, agent === "claude" ? 3 : 0);
      });
    });
  }
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

test("a held mate message survives a server restart and releases at the next turn boundary", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-input-restart-"));
  const first = await startServer(home);
  try {
    const accepted = await postSubmit(first.port, "survive restart");
    assert.deepEqual(await accepted.json(), { ok: true, queued: true });
    assert.deepEqual(first.adapter.writes, []);
    assert.equal(first.tasks.stateDb.pendingSessionInputs.count(SESSION_ID), 1);
  } finally {
    await first.close();
  }

  const second = await startServer(home);
  try {
    assert.equal(second.tasks.stateDb.pendingSessionInputs.count(SESSION_ID), 1);
    assert.deepEqual(second.adapter.writes, []);

    second.monitor.applyExternalStatus(SESSION_ID, "idle", "claude", "hook");
    await waitForWrites(second.adapter, 2);
    assert.deepEqual(second.adapter.writes, ["survive restart", "\r"]);
    assert.equal(second.tasks.stateDb.pendingSessionInputs.count(SESSION_ID), 0);
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
