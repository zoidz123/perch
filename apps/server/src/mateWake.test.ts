import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession, RecentEventsResult, Task } from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { deliverMateAttention, isMailboxRouted, MateMailboxNudger, wakeLine } from "./mateWake.js";
import { TaskStore } from "./tasks.js";
import { MAILBOX_CONTROL_PREFIX } from "./timeline.js";

function task(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: "fix-the-auth-a1b2",
    title: "fix the auth flow",
    project: "/Users/dev/projects/perch",
    kind: "ship",
    state: "needs_you",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

test("wakeLine keeps the plain one-line format for events without findings", () => {
  assert.equal(
    wakeLine(task(), { kind: "blocked", message: "npm registry is down" }),
    "[perch] fix-the-auth-a1b2 · blocked: npm registry is down"
  );
  assert.equal(wakeLine(task(), { kind: "done" }), "[perch] fix-the-auth-a1b2 · done: fix the auth flow");
});

test("wakeLine leads with the worker name while keeping the task id machine-resolvable", () => {
  assert.equal(
    wakeLine(task({ workerName: "Wren" }), { kind: "done" }),
    "[perch] Wren (fix-the-auth-a1b2) · done: fix the auth flow"
  );
  assert.equal(
    wakeLine(task({ workerName: "Wren" }), { kind: "blocked", message: "waiting for Apple" }),
    "[perch] Wren (fix-the-auth-a1b2) · blocked: waiting for Apple"
  );
});

test("wakeLine separates green checks from true merge readiness", () => {
  assert.equal(
    wakeLine(task(), { kind: "checks_green", message: "https://github.com/o/r/pull/7" }),
    "[perch] fix-the-auth-a1b2 · checks_green: https://github.com/o/r/pull/7 - CI checks green; merge readiness not confirmed"
  );
  assert.equal(
    wakeLine(task(), { kind: "merge_ready", message: "https://github.com/o/r/pull/7" }),
    "[perch] fix-the-auth-a1b2 · merge_ready: https://github.com/o/r/pull/7 - GitHub reports this PR is ready to merge"
  );
});

test("wakeLine renders a needs_decision from the worker's own message", () => {
  const line = wakeLine(task(), {
    kind: "needs_decision",
    message: "which branch?",
    data: { structured: "carried verbatim, never rendered" }
  });
  assert.equal(line, "[perch] fix-the-auth-a1b2 · needs_decision: which branch?");
});

// ---------------------------------------------------------------------------
// Mailbox routing and the disposable nudge
// ---------------------------------------------------------------------------

class MateAdapter implements AgentAdapter {
  readonly name = "fake-pty";
  readonly submissions: Array<{ sessionId: string; text: string }> = [];
  async getTopology() {
    return { windows: [], generatedAt: "" };
  }
  async listSessions(): Promise<AgentSession[]> {
    return [
      { id: "pty:mate", title: "mate", status: "idle", labels: { role: "mate" } } as unknown as AgentSession
    ];
  }
  async readRecentEvents(): Promise<RecentEventsResult> {
    return { events: [], terminal: true };
  }
  async sendInput(sessionId: string, text: string): Promise<void> {
    this.submissions.push({ sessionId, text });
  }
  async sendEnter(): Promise<void> {}
  async interrupt(): Promise<void> {}
}

type NudgeFixture = {
  home: string;
  tasks: TaskStore;
  adapter: MateAdapter;
  monitor: FleetMonitor;
  nudger: MateMailboxNudger;
  task: Task;
};

async function withNudger(run: (ctx: NudgeFixture) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "perch-nudge-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const adapter = new MateAdapter();
  const monitor = new FleetMonitor(adapter, { broadcastMs: 5 });
  const nudger = new MateMailboxNudger({ mailbox: tasks.stateDb.mateMailbox, adapter, monitor });
  const created = tasks.create({ title: "routed work", project: "/tmp/repo", kind: "ship" });
  tasks.update(created.id, { sessionId: "pty:worker" });
  try {
    await run({ home, tasks, adapter, monitor, nudger, task: tasks.find(created.id)! });
  } finally {
    tasks.close();
    rmSync(home, { recursive: true, force: true });
  }
}

test("isMailboxRouted separates worker fan-in from system notifications", () => {
  assert.equal(isMailboxRouted({ kind: "completion_requested", source: "worker" }), true);
  assert.equal(isMailboxRouted({ kind: "needs_decision", source: "worker" }), true);
  assert.equal(isMailboxRouted({ kind: "note", source: "worker", data: { reason: "worker_report" } }), true);
  assert.equal(isMailboxRouted({ kind: "note", source: "worker" }), false);
  assert.equal(isMailboxRouted({ kind: "stalled", source: "system" }), false);
  assert.equal(isMailboxRouted({ kind: "chart_ready", source: "system" }), false);
  // Legacy outbox payloads without a source stay on the legacy wake path.
  assert.equal(isMailboxRouted({ kind: "completion_requested" }), false);
});

test("a worker report never becomes composer text: the idle mate gets one content-free nudge", async () => {
  await withNudger(async ({ tasks, adapter, monitor, nudger, task: routed }) => {
    monitor.applyExternalStatus("pty:mate", "idle", "claude");
    const event = { kind: "blocked" as const, source: "worker" as const, message: "SECRET worker details" };
    tasks.recordEvent(routed.id, event);
    await deliverMateAttention(tasks.find(routed.id)!, event, adapter, monitor, nudger);

    assert.equal(adapter.submissions.length, 1);
    const nudge = adapter.submissions[0]!;
    assert.equal(nudge.sessionId, "pty:mate");
    assert.ok(nudge.text.startsWith(MAILBOX_CONTROL_PREFIX), "the nudge carries the filterable control prefix");
    assert.ok(!nudge.text.includes("SECRET"), "no worker content rides the wake");
    assert.ok(!nudge.text.includes("\n"), "single line; a newline would submit the composer early");
  });
});

test("a report arriving during an active mate turn does not interrupt or steer; the idle transition re-nudges", async () => {
  await withNudger(async ({ tasks, adapter, monitor, nudger, task: routed }) => {
    monitor.applyExternalStatus("pty:mate", "running", "claude");
    const event = { kind: "completion_requested" as const, source: "worker" as const, message: "verify me" };
    tasks.recordEvent(routed.id, event);
    await deliverMateAttention(tasks.find(routed.id)!, event, adapter, monitor, nudger);
    assert.equal(adapter.submissions.length, 0, "an active mate turn is never interrupted");
    assert.equal(tasks.stateDb.mateMailbox.list().length, 1, "the durable delivery still exists");

    // The turn ends: the monitor records idle first (as applyExternalStatus
    // does in production), then the safe-checkpoint tap raises attention once.
    monitor.applyExternalStatus("pty:mate", "idle", "claude");
    nudger.onStatusChange({ sessionId: "pty:mate", from: "running", to: "idle", source: "adapter" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(adapter.submissions.length, 1);
    assert.ok(adapter.submissions[0]!.text.startsWith(MAILBOX_CONTROL_PREFIX));

    // A second idle transition with no newer mail stays silent (no loops).
    nudger.onStatusChange({ sessionId: "pty:mate", from: "running", to: "idle", source: "adapter" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(adapter.submissions.length, 1);
  });
});

test("one nudge covers a burst; acknowledged mail never re-nudges", async () => {
  await withNudger(async ({ tasks, adapter, monitor, nudger, task: routed }) => {
    monitor.applyExternalStatus("pty:mate", "idle", "claude");
    const first = { kind: "blocked" as const, source: "worker" as const, message: "one" };
    tasks.recordEvent(routed.id, first);
    tasks.recordEvent(routed.id, { kind: "working", source: "worker" });
    const second = { kind: "needs_decision" as const, source: "worker" as const, message: "two" };
    tasks.recordEvent(routed.id, second);
    await deliverMateAttention(tasks.find(routed.id)!, first, adapter, monitor, nudger);
    await deliverMateAttention(tasks.find(routed.id)!, second, adapter, monitor, nudger);
    assert.equal(adapter.submissions.length, 1, "the first nudge already covered the backlog");

    // Drain + ack everything; an idle transition afterwards stays silent.
    const now = new Date().toISOString();
    for (const claimed of tasks.stateDb.mateMailbox.claim({ generation: 0, limit: 10, ttlMs: 60_000, now })) {
      tasks.stateDb.mateMailbox.ack({
        id: claimed.id,
        claimToken: claimed.claimToken!,
        generation: 0,
        idempotencyKey: `ack-${claimed.id}`,
        sessionId: "pty:mate",
        now
      });
    }
    nudger.onStatusChange({ sessionId: "pty:mate", from: "running", to: "idle", source: "adapter" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(adapter.submissions.length, 1);
  });
});

test("system-sourced notifications keep the legacy content wake line", async () => {
  await withNudger(async ({ tasks, adapter, monitor, nudger, task: routed }) => {
    monitor.applyExternalStatus("pty:mate", "idle", "claude");
    const event = { kind: "merged" as const, source: "poller" as const, message: "PR #7 merged" };
    await deliverMateAttention(
      { ...tasks.find(routed.id)!, sessionId: "pty:worker" },
      event,
      adapter,
      monitor,
      nudger
    );
    assert.equal(adapter.submissions.length, 1);
    assert.ok(adapter.submissions[0]!.text.startsWith("[perch] "));
    assert.ok(adapter.submissions[0]!.text.includes("merged: PR #7 merged"));
  });
});
