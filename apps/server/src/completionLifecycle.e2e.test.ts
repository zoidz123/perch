import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession, RecentEventsResult } from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { wireMateWake } from "./mateWake.js";
import { TaskCompletionReconciler } from "./taskCompletion.js";
import { TaskStore } from "./tasks.js";

class LifecycleAdapter implements AgentAdapter {
  readonly name = "completion-lifecycle";
  readonly inputs: Array<{ sessionId: string; text: string }> = [];
  readonly sessions: AgentSession[] = [
    { id: "pty:worker", title: "worker", agent: "codex", kind: "terminal", status: "idle", lastActivityAt: "", labels: { task: "task" } },
    { id: "pty:mate", title: "mate", agent: "claude", kind: "terminal", status: "idle", lastActivityAt: "", labels: { role: "mate" } }
  ];

  async getTopology() {
    return { windows: [], generatedAt: "" };
  }
  async listSessions(): Promise<AgentSession[]> {
    return this.sessions;
  }
  async readRecentEvents(): Promise<RecentEventsResult> {
    return { events: [], terminal: true };
  }
  async sendInput(sessionId: string, text: string): Promise<void> {
    this.inputs.push({ sessionId, text });
  }
  async sendEnter(): Promise<void> {}
  async interrupt(): Promise<void> {}
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("artifact plus provider turn completion without a task outcome wakes mate and recovers without false done", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-completion-e2e-"));
  const project = mkdtempSync(join(home, "repo-"));
  const artifact = join(project, "audit.md");
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const adapter = new LifecycleAdapter();
  const monitor = new FleetMonitor(adapter, { broadcastMs: 1 });
  wireMateWake(tasks, adapter, monitor);
  const reconciler = new TaskCompletionReconciler({
    tasks,
    lastAssistantText: () => "I wrote audit.md"
  });

  try {
    const task = tasks.create({
      title: "write audit artifact",
      project,
      prompt: "Create audit.md with the requested findings"
    });
    tasks.update(task.id, { sessionId: "pty:worker" });
    reconciler.onTurnStarted("pty:worker", "codex");
    tasks.recordEvent(task.id, { kind: "working", source: "worker", message: "writing the audit" });
    writeFileSync(artifact, "# Audit\n\nFindings\n");
    assert.equal(existsSync(artifact), true);

    reconciler.onTurnCompleted("pty:worker", "codex");
    await wait(10);

    assert.equal(tasks.find(task.id)?.state, "working", "provider completion never proves the goal");
    assert.deepEqual(
      tasks.events(task.id).slice(-2).map((event) => event.kind),
      ["turn_completed", "stalled"]
    );
    assert.ok(
      adapter.inputs.some(
        (input) => input.sessionId === "pty:mate" && input.text.includes("stalled:") && input.text.includes(task.id)
      ),
      "the durable missing-outcome event wakes the mate"
    );

    await monitor.queueOrSubmit("pty:worker", "The artifact exists. Report the required task outcome now.");
    assert.ok(adapter.inputs.some((input) => input.sessionId === "pty:worker"));
    tasks.recordEvent(task.id, { kind: "completion_requested", source: "worker", message: "audit.md is ready" });
    tasks.recordEvent(task.id, { kind: "completion_accepted", source: "system", message: "mate verified audit.md" });
    assert.equal(tasks.find(task.id)?.state, "done", "recovery finishes only after the mate verifies the artifact");
  } finally {
    monitor.stop();
    tasks.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("terminal follow-up accepted behind a gate gets a durable rejection receipt instead of disappearing", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-input-receipt-e2e-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const adapter = new LifecycleAdapter();
  const monitor = new FleetMonitor(adapter, {
    onQueuedInputRejected: (sessionId, count, reason) => {
      const task = tasks.list().find((candidate) => candidate.sessionId === sessionId);
      if (!task) return;
      tasks.recordEvent(task.id, {
        kind: "stalled",
        source: "system",
        message: `${count} accepted follow-up was not delivered: ${reason}`,
        data: { reason: "terminal_input_rejected", sessionId, count }
      });
    }
  });
  wireMateWake(tasks, adapter, monitor);

  try {
    const task = tasks.create({ title: "follow-up barrier", project: "/tmp/repo" });
    tasks.update(task.id, { sessionId: "pty:worker" });
    tasks.recordEvent(task.id, { kind: "working", source: "worker" });
    monitor.setPendingApproval("pty:worker", { id: "approval", summary: "waiting", at: "" });

    const accepted = await monitor.queueOrSubmit("pty:worker", "report the task outcome");
    assert.equal(accepted.queued, true);
    monitor.applyExternalStatus("pty:worker", "done");
    await wait(10);

    const receipt = tasks.events(task.id).at(-1);
    assert.equal(receipt?.kind, "stalled");
    assert.equal(receipt?.data?.reason, "terminal_input_rejected");
    assert.equal(receipt?.data?.count, 1);
    assert.equal(tasks.find(task.id)?.state, "working");
    assert.ok(
      adapter.inputs.some(
        (input) => input.sessionId === "pty:mate" && input.text.includes("accepted follow-up was not delivered")
      ),
      "mate receives the durable retry-needed receipt"
    );
  } finally {
    monitor.stop();
    tasks.close();
    rmSync(home, { recursive: true, force: true });
  }
});
