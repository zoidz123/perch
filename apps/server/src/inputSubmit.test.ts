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

async function withServer(
  run: (ctx: {
    port: number;
    adapter: RecordingAdapter;
    monitor: FleetMonitor;
    tasks: TaskStore;
    hooks: HookRegistry;
  }) => Promise<void>
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "perch-input-home-"));
  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  const adapter = new RecordingAdapter();
  const tasks = new TaskStore(env);
  const monitor = new FleetMonitor(adapter, {
    broadcastMs: 5,
    tailThrottleMs: 1,
    onApprovalNeeded: (sessionId, approval) => surfaceApprovalToTask(tasks, sessionId, approval),
    onApprovalResolved: (sessionId, approval) => resolveApprovalForTask(tasks, sessionId, approval)
  });
  const hooks = new HookRegistry();
  const timeline = new TimelineStore();
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
    })
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run({ port, adapter, monitor, tasks, hooks });
  } finally {
    timeline.stop();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}

function postInput(port: number, text: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/sessions/${encodeURIComponent(SESSION_ID)}/input`, {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ text })
  });
}

function postSubmit(port: number, text: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/sessions/${encodeURIComponent(SESSION_ID)}/submit`, {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ text })
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

test("a single POST /sessions/:id/input submits: the text write, then a distinct Enter", async () => {
  await withServer(async ({ port, adapter }) => {
    const response = await postInput(port, "please also update the tests\n");
    assert.equal(response.status, 202);
    assert.deepEqual((await response.json()) as object, { ok: true, queued: false });
    assert.deepEqual(adapter.writes, ["please also update the tests\n", "\r"]);
  });
});

test("multi-line input stays one composer body and exactly one Enter", async () => {
  await withServer(async ({ port, adapter }) => {
    const text = "line one\nline two\nline three";
    await postInput(port, text);
    // Internal newlines ride inside the single text write (composer content);
    // only the final standalone Enter submits - never one per line.
    assert.deepEqual(adapter.writes, [text, "\r"]);
    assert.equal(adapter.writes.filter((write) => write === "\r").length, 1);
  });
});

test("home mate submit acks accepted delivery before slow PTY confirmation can trip the client timeout", async () => {
  await withServer(async ({ port, adapter }) => {
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
  await withServer(async ({ port, adapter }) => {
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

test("live Computer Use choices surface, resolve once through PTY, and clear only after the screen barrier", async () => {
  await withServer(async ({ port, adapter, monitor, tasks }) => {
    adapter.session.agent = "codex";
    adapter.screen = [
      "Field 1/1",
      'Allow Computer Use to use "Xcode"?',
      "App: Xcode",
      "› 1. Allow                   Run the tool and continue.",
      "  2. Allow for this session  Run the tool and remember this choice for this session.",
      "  3. Always allow            Run the tool and remember this choice for future tool calls.",
      "  4. Cancel                  Cancel this tool call",
      "enter to submit | esc to cancel"
    ].join("\n");
    const task = tasks.update(tasks.create({ title: "inspect Xcode", project: "/repo" }).id, {
      sessionId: SESSION_ID
    });
    tasks.recordEvent(task.id, { kind: "working", source: "system" });
    const firstSocket = new MonitorSocket();
    monitor.addClient(firstSocket as unknown as WebSocket);
    await new Promise((resolve) => setTimeout(resolve, 20));
    adapter.emit({ kind: "activity", sessionId: SESSION_ID, workspaceId: "perch-pty", at: new Date().toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const pending = monitor.pendingApproval(SESSION_ID);
    assert.ok(pending);
    assert.equal(pending.context?.app, "Xcode");
    assert.deepEqual(pending.decisions?.map((choice) => choice.id), ["allow", "allow_session", "allow_always", "cancel"]);
    assert.equal(tasks.find(task.id)?.state, "needs_you");
    assert.equal(tasks.events(task.id).at(-1)?.data?.reason, "approval_request");
    assert.ok(firstSocket.messages.some((message) => {
      if (message.type !== "fleet" || !Array.isArray(message.sessions)) return false;
      const session = (message.sessions as AgentSession[]).find((candidate) => candidate.id === SESSION_ID);
      return session?.status === "needs_approval" && session.pendingApproval?.id === pending.id;
    }), "WebSocket fleet state carries the actionable approval");

    monitor.applyExternalStatus(SESSION_ID, "idle", "codex", "adapter");
    assert.equal(
      monitor.pendingApproval(SESSION_ID)?.id,
      pending.id,
      "provider idle cannot clear a terminal prompt that remains rendered"
    );

    firstSocket.emit("close");
    const reconnectSocket = new MonitorSocket();
    monitor.addClient(reconnectSocket as unknown as WebSocket);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(monitor.pendingApproval(SESSION_ID)?.id, pending.id, "reconnect preserves the same request identity");

    reconnectSocket.emit("message", Buffer.from(JSON.stringify({
      type: "rpc",
      id: "approve-always",
      method: "POST",
      path: `/sessions/${encodeURIComponent(SESSION_ID)}/approve`,
      body: { id: pending.id, decision: "allow_always" }
    })));
    const response = await waitForMessage(reconnectSocket, "approve-always");
    assert.deepEqual(response, {
      type: "rpc_response",
      id: "approve-always",
      status: 202,
      ok: true,
      body: { ok: true, pending: true }
    });
    assert.deepEqual(adapter.writes, [
      "\x1b[A", "\x1b[A", "\x1b[A", "\x1b[A",
      "\x1b[B", "\x1b[B", "\r"
    ]);
    assert.equal(monitor.pendingApproval(SESSION_ID)?.submittedDecision, "allow_always");
    assert.equal(tasks.find(task.id)?.state, "needs_you", "task waits for the rendered prompt to close");

    const duplicate = await postApproval(port, pending.id, "allow_always");
    assert.equal(duplicate.status, 409);
    assert.deepEqual(adapter.writes, [
      "\x1b[A", "\x1b[A", "\x1b[A", "\x1b[A",
      "\x1b[B", "\x1b[B", "\r"
    ]);

    adapter.screen = "Codex resumed the tool call";
    adapter.emit({ kind: "activity", sessionId: SESSION_ID, workspaceId: "perch-pty", at: new Date().toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(monitor.pendingApproval(SESSION_ID), undefined);
    assert.equal(tasks.find(task.id)?.state, "working");
    assert.equal(tasks.events(task.id).at(-1)?.data?.reason, "approval_request_resolved");
    assert.equal(tasks.events(task.id).at(-1)?.data?.decision, "allow_always");

    const stale = await postApproval(port, pending.id, "cancel");
    assert.equal(stale.status, 409);

    adapter.writes.length = 0;
    adapter.screen = [
      "Field 1/1",
      'Allow Computer Use to use "Simulator"?',
      "App: Simulator",
      "› 1. Allow  Run the tool and continue.",
      "  2. Allow for this session  Remember this session.",
      "  3. Always allow  Remember future calls.",
      "  4. Cancel  Cancel this tool call"
    ].join("\n");
    adapter.emit({ kind: "activity", sessionId: SESSION_ID, workspaceId: "perch-pty", at: new Date().toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const cancellation = monitor.pendingApproval(SESSION_ID);
    assert.ok(cancellation);
    const cancelled = await postApproval(port, cancellation.id, "cancel");
    assert.equal(cancelled.status, 202);
    assert.deepEqual(adapter.writes, [
      "\x1b[A", "\x1b[A", "\x1b[A", "\x1b[A",
      "\x1b[B", "\x1b[B", "\x1b[B", "\r"
    ]);
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
