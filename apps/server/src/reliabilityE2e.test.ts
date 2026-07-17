import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PtyAgentAdapter } from "./adapters/pty.js";
import { startManagedAgent } from "./agentLauncher.js";
import { AuditLog } from "./audit.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { HookRegistry } from "./hooks.js";
import { ProjectRegistry } from "./projects.js";
import { RuntimeManager } from "./runtimeManager.js";
import { TaskStore } from "./tasks.js";
import { TimelineStore } from "./timeline.js";
import { WorktreePool } from "./worktrees.js";

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function managedHarness(home: string) {
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const runtimes = new RuntimeManager(tasks);
  const adapter = new PtyAgentAdapter(undefined, {
    onSessionExit: (sessionId) => {
      runtimes.interruptSession(sessionId, "real PTY exited during E2E");
    }
  });
  const monitor = new FleetMonitor(adapter);
  monitor.setRuntimeSnapshot((sessionId) => runtimes.snapshotForSession(sessionId));
  const timeline = new TimelineStore();
  return {
    tasks,
    runtimes,
    adapter,
    monitor,
    timeline,
    launcher: {
      adapter,
      auditLog: new AuditLog(join(home, "audit.jsonl")),
      monitor,
      projects: new ProjectRegistry({ PERCH_HOME: home } as NodeJS.ProcessEnv),
      worktrees: new WorktreePool({ root: join(home, "worktrees") }),
      hooks: new HookRegistry(),
      timeline,
      tasks,
      port: 0,
      runtimeManager: runtimes
    }
  };
}

test("E2E: a real managed worker PTY can disappear without changing task meaning", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-runtime-e2e-"));
  const h = managedHarness(home);
  try {
    const created = h.tasks.create({ title: "runtime interruption", project: home });
    const task = h.tasks.claimWorkerName(created.id);
    h.tasks.update(task.id, { parentSessionId: "pty:mate-parent" });
    const launched = await startManagedAgent(h.launcher, {
      taskId: task.id,
      request: {
        command: "sleep",
        args: ["300"],
        agent: "claude",
        sessionId: "pty:runtime-e2e-worker",
        cwd: home,
        labels: { task: task.id, workerName: task.workerName!, parent: "pty:mate-parent" }
      }
    });
    h.tasks.update(task.id, { sessionId: launched.session.id });
    h.tasks.recordEvent(task.id, { kind: "working", source: "worker" });
    h.runtimes.recordProviderSession(launched.session.id, "claude", "99999999-9999-4999-8999-999999999999");

    const fleet = h.monitor.withLiveState(await h.adapter.listSessions());
    assert.equal(fleet[0]?.runtime?.state, "live");
    assert.equal(fleet[0]?.runtime?.workerName, task.workerName);
    assert.equal(fleet[0]?.runtime?.parentSessionId, "pty:mate-parent");

    await h.adapter.stopSession(launched.session.id);
    await until(() => h.tasks.find(task.id)?.runtime?.state === "recoverable");

    const persisted = h.tasks.find(task.id);
    assert.equal(persisted?.state, "working");
    assert.equal(persisted?.workerName, task.workerName);
    assert.equal(persisted?.parentSessionId, "pty:mate-parent");
    assert.equal(persisted?.runtime?.state, "recoverable");
    assert.equal(persisted?.runtime?.generation, 0);
    assert.equal(persisted?.runtime?.recoveryAvailable, true);
    assert.equal(persisted?.runtime?.workerName, task.workerName);
    assert.equal(persisted?.runtime?.parentSessionId, "pty:mate-parent");

    // Worker loss surfaces immediately on both boss channels without moving
    // task state: the interruption event queues a mate wake and a push.
    const interruption = h.tasks.events(task.id).find((event) => event.kind === "runtime_interrupted");
    assert.ok(interruption);
    assert.equal(interruption?.source, "system");
    const outbox = h.tasks.stateDb.outbox.forTaskEvent(task.id, interruption!.seq);
    assert.deepEqual(outbox.map((row) => row.channel).sort(), ["mate", "push"]);
  } finally {
    h.timeline.stop();
    h.monitor.stop();
    h.adapter.stop();
    h.tasks.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("E2E: private-home server restart reconciles ownership and preserves reconnect identity", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-runtime-restart-e2e-"));
  const first = managedHarness(home);
  const created = first.tasks.create({ title: "restart persistence", project: home });
  const task = first.tasks.claimWorkerName(created.id);
  const launched = await startManagedAgent(first.launcher, {
    taskId: task.id,
    request: {
      command: "sleep",
      args: ["300"],
      agent: "claude",
      sessionId: "pty:restart-e2e-worker",
      cwd: home,
      labels: { task: task.id, workerName: task.workerName!, parent: "pty:mate-durable" }
    }
  });
  first.tasks.update(task.id, { sessionId: launched.session.id, parentSessionId: "pty:mate-durable" });
  first.tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  first.runtimes.recordProviderSession(launched.session.id, "claude", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

  // Simulate process death: adapter.stop kills owned PTYs without firing the
  // graceful exit callback, then a fresh StateDb opens the same private home.
  first.adapter.stop();
  first.timeline.stop();
  first.monitor.stop();
  first.tasks.close();

  const restarted = managedHarness(home);
  try {
    const changed = restarted.runtimes.reconcile(new Set(), () => false);
    assert.equal(changed.length, 1);
    const snapshot = restarted.tasks.find(task.id);
    assert.equal(snapshot?.state, "working");
    assert.equal(snapshot?.workerName, task.workerName);
    assert.equal(snapshot?.parentSessionId, "pty:mate-durable");
    assert.equal(snapshot?.runtime?.state, "recoverable");
    assert.equal(snapshot?.runtime?.recoveryAvailable, true);
    assert.equal(snapshot?.runtime?.ptySessionId, launched.session.id);

    // A reconnect/refetch is read-only and returns the same durable identity.
    assert.deepEqual(restarted.tasks.find(task.id)?.runtime, snapshot?.runtime);
  } finally {
    restarted.timeline.stop();
    restarted.monitor.stop();
    restarted.adapter.stop();
    restarted.tasks.close();
    rmSync(home, { recursive: true, force: true });
  }
});
