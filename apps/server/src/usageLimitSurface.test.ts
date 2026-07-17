import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type {
  AgentSession,
  FleetEvent,
  RecentEventsResult,
  SurfaceKind
} from "@perch/shared";
import type { WebSocket } from "ws";
import { EventEmitter } from "node:events";
import type { AgentAdapter } from "./adapters/types.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { wireMateWake } from "./mateWake.js";
import { TaskStore } from "./tasks.js";
import { reportUsageLimitToTask } from "./taskWatchdog.js";

// The real codex out-of-credits line, verbatim: it prints this and then sits.
const CODEX_LIMIT =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage " +
  "to purchase more credits or try again at 3:28 PM.";

function session(id: string, kind: SurfaceKind): AgentSession {
  return {
    id,
    title: id,
    agent: "codex",
    kind,
    status: "idle",
    lastActivityAt: ""
  };
}

// Feeds a fixed screen back through readRecentEvents (the exact path
// captureTail reads), and records composer input (the mate wake).
class ScreenAdapter implements AgentAdapter {
  readonly name = "screen";
  inputs: Array<{ sessionId: string; text: string }> = [];
  private handler?: (event: FleetEvent) => void;

  constructor(
    private readonly sessions: AgentSession[],
    private readonly screens: Record<string, string>
  ) {}

  async getTopology() {
    return { windows: [], generatedAt: "" };
  }
  async listSessions(): Promise<AgentSession[]> {
    return this.sessions;
  }
  async readRecentEvents(sessionId: string): Promise<RecentEventsResult> {
    const text = this.screens[sessionId];
    if (text === undefined) {
      return { events: [], terminal: true };
    }
    return { events: [{ type: "terminal_output", sessionId, text, at: "" }], terminal: true };
  }
  async sendInput(sessionId: string, text: string): Promise<void> {
    this.inputs.push({ sessionId, text });
  }
  async sendEnter(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async startAgent(): Promise<AgentSession> {
    throw new Error("not used");
  }
  subscribeFleetEvents(handler: (event: FleetEvent) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = undefined;
    };
  }
  emit(event: FleetEvent): void {
    this.handler?.(event);
  }
}

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("codex usage limit flips the session, blocks the task, and wakes the mate", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-usage-"));
  const tasks = new TaskStore({ ...process.env, PERCH_HOME: home } as NodeJS.ProcessEnv);

  // A live worker task, dispatched into a codex session that just ran out.
  const task = tasks.create({ title: "some ship task", project: "/repo" });
  tasks.update(task.id, { sessionId: "pty:worker" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker", message: "on it" });
  assert.equal(tasks.find(task.id)?.state, "working");

  const worker = session("pty:worker", "terminal");
  const mate: AgentSession = {
    ...session("pty:mate", "terminal"),
    agent: "claude",
    labels: { role: "mate" }
  };
  const adapter = new ScreenAdapter([worker, mate], { "pty:worker": CODEX_LIMIT });

  let fired: { retryAt?: string; provider: string } | undefined;
  const hub = new FleetMonitor(adapter, {
    reconcileMs: 10_000,
    broadcastMs: 5,
    tailThrottleMs: 1,
    onUsageLimit: (sessionId, _agent, limit) => {
      fired = limit;
      reportUsageLimitToTask(tasks, sessionId, limit);
    }
  });
  after(() => hub.stop());
  // The wake channel the orchestrator listens on.
  wireMateWake(tasks, adapter, hub);

  hub.addClient(new FakeSocket() as unknown as WebSocket);
  await tick(20);
  // Nudge the worker: an activity event triggers the tail capture that reads
  // the screen and runs the detector.
  adapter.emit({ kind: "status", sessionId: "pty:worker", status: "idle", at: "" });
  await tick(40);

  // 1) The detector fired once, carrying the provider and the retry time.
  assert.ok(fired, "usage-limit detector fired through the monitoring path");
  assert.equal(fired.provider, "codex");
  assert.equal(fired.retryAt, "3:28 PM");

  // 2) The task flipped out of 'working' -> 'blocked', event carries the time.
  const blocked = tasks.find(task.id);
  assert.equal(blocked?.state, "blocked", "task no longer sits working");
  const event = tasks.events(task.id).find((e) => e.kind === "blocked");
  assert.ok(event);
  assert.equal(event.source, "system");
  assert.match(event.message ?? "", /codex usage limit reached/);
  assert.match(event.message ?? "", /3:28 PM/);
  assert.equal((event.data as Record<string, unknown>)?.retryAt, "3:28 PM");

  // 3) GET /sessions reflects the condition (error), not 'idle'.
  const [live] = hub.withLiveState([worker]);
  assert.equal(live?.status, "error", "session surfaces as error, not idle");

  // 4) The wake emission fired: the block line landed in the mate's composer.
  const wake = adapter.inputs.find((i) => i.sessionId === "pty:mate");
  assert.ok(wake, "mate was woken");
  assert.match(wake.text, /blocked/);
  assert.match(wake.text, /3:28 PM/);
});

// The verbatim startup screen captured from a live out-of-credits codex worker:
// a `■ ` notice bullet, surrounding hook noise, and the retry time wrapped onto
// the next row. This shape read as a plain "idle" session and left the task
// working (the earlier `^you've` anchor missed the bulleted line).
const CODEX_LIMIT_STARTUP = [
  "• SessionStart hook (completed)",
  "  hook context: bin: /opt/homebrew/bin/lavish-axi",
  "",
  "■ You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at",
  "8:29 PM.",
  "",
  "› Write tests for @filename",
  "",
  "gpt-5.6-sol medium fast · ~/.perch/worktrees/sample-abc123/5/sample-app"
].join("\n");

test("codex out-of-credits at startup (bulleted line) blocks the task and wakes the mate", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-usage-"));
  const tasks = new TaskStore({ ...process.env, PERCH_HOME: home } as NodeJS.ProcessEnv);

  // The live-repro shape: dispatched, flipped to working by the activity helper
  // (system source), then the worker never runs because credits are exhausted.
  const task = tasks.create({ title: "per-model codex effort", project: "/repo" });
  tasks.update(task.id, { sessionId: "pty:worker" });
  tasks.recordEvent(task.id, { kind: "working", source: "system", message: "worker session active" });

  const worker = session("pty:worker", "terminal");
  const mate: AgentSession = { ...session("pty:mate", "terminal"), agent: "claude", labels: { role: "mate" } };
  const adapter = new ScreenAdapter([worker, mate], { "pty:worker": CODEX_LIMIT_STARTUP });

  let fired: { retryAt?: string; provider: string } | undefined;
  const hub = new FleetMonitor(adapter, {
    reconcileMs: 10_000,
    broadcastMs: 5,
    tailThrottleMs: 1,
    onUsageLimit: (sessionId, _agent, limit) => {
      fired = limit;
      reportUsageLimitToTask(tasks, sessionId, limit);
    }
  });
  after(() => hub.stop());
  wireMateWake(tasks, adapter, hub);

  hub.addClient(new FakeSocket() as unknown as WebSocket);
  await tick(20);
  adapter.emit({ kind: "status", sessionId: "pty:worker", status: "idle", at: "" });
  await tick(40);

  assert.ok(fired, "detector fired on the bulleted startup line");
  assert.equal(fired.provider, "codex");
  assert.equal(fired.retryAt, "8:29 PM");

  const blocked = tasks.find(task.id);
  assert.equal(blocked?.state, "blocked", "task no longer sits working at startup");
  const event = tasks.events(task.id).find((e) => e.kind === "blocked");
  assert.match(event?.message ?? "", /codex usage limit reached/);
  assert.match(event?.message ?? "", /8:29 PM/);

  const [live] = hub.withLiveState([worker]);
  assert.equal(live?.status, "error", "idle-looking session now reads as error");

  const wake = adapter.inputs.find((i) => i.sessionId === "pty:mate");
  assert.ok(wake, "mate was woken at startup");
  assert.match(wake.text, /blocked/);
});

test("structured Codex app-server limit blocks the task and wakes the mate without a terminal line", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-usage-"));
  const tasks = new TaskStore({ ...process.env, PERCH_HOME: home } as NodeJS.ProcessEnv);
  const task = tasks.create({ title: "structured failure", project: "/repo" });
  tasks.update(task.id, { sessionId: "pty:worker" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });

  const worker = session("pty:worker", "terminal");
  const mate: AgentSession = { ...session("pty:mate", "terminal"), agent: "claude", labels: { role: "mate" } };
  const adapter = new ScreenAdapter([worker, mate], {});
  const hub = new FleetMonitor(adapter, {
    reconcileMs: 10_000,
    broadcastMs: 5,
    onUsageLimit: (sessionId, _agent, limit) => reportUsageLimitToTask(tasks, sessionId, limit)
  });
  after(() => hub.stop());
  wireMateWake(tasks, adapter, hub);
  hub.addClient(new FakeSocket() as unknown as WebSocket);
  await tick(20);

  // This is exactly what the app-server control callback invokes. No PTY
  // capture occurs, so this proves structured events are the primary route.
  hub.reportUsageLimit("pty:worker", "codex", {
    provider: "codex",
    message: "out of credits",
    retryAt: "2026-07-10T22:00:00Z",
    source: "app_server"
  });
  await tick(20);

  assert.equal(tasks.find(task.id)?.state, "blocked");
  assert.equal((tasks.events(task.id).find((event) => event.kind === "blocked")?.data as Record<string, unknown>)?.provider, "codex");
  assert.equal(hub.withLiveState([worker])[0]?.status, "error");
  assert.match(adapter.inputs.find((input) => input.sessionId === "pty:mate")?.text ?? "", /2026-07-10T22:00:00Z/);
});

test("a redraw of the same limit line does not re-block or re-wake", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-usage-"));
  const tasks = new TaskStore({ ...process.env, PERCH_HOME: home } as NodeJS.ProcessEnv);
  const task = tasks.create({ title: "task", project: "/repo" });
  tasks.update(task.id, { sessionId: "pty:worker" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });

  const worker = session("pty:worker", "terminal");
  const adapter = new ScreenAdapter([worker], { "pty:worker": CODEX_LIMIT });
  let fires = 0;
  const hub = new FleetMonitor(adapter, {
    reconcileMs: 10_000,
    broadcastMs: 5,
    tailThrottleMs: 1,
    onUsageLimit: (sessionId, _agent, limit) => {
      fires += 1;
      reportUsageLimitToTask(tasks, sessionId, limit);
    }
  });
  after(() => hub.stop());

  hub.addClient(new FakeSocket() as unknown as WebSocket);
  await tick(20);
  for (let i = 0; i < 3; i += 1) {
    adapter.emit({ kind: "status", sessionId: "pty:worker", status: "idle", at: "" });
    await tick(20);
  }

  assert.equal(fires, 1, "same limit signature fires the hook exactly once");
});
