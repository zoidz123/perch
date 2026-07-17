import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RuntimeManager } from "./runtimeManager.js";
import { TaskStore } from "./tasks.js";

function harness() {
  const home = mkdtempSync(join(tmpdir(), "perch-runtime-manager-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const manager = new RuntimeManager(tasks);
  return {
    home,
    tasks,
    manager,
    cleanup() {
      tasks.close();
      rmSync(home, { recursive: true, force: true });
    }
  };
}

function liveRuntime(h: ReturnType<typeof harness>, providerSessionId?: string) {
  const created = h.tasks.create({ title: "runtime task", project: "/tmp/repo" });
  const task = h.tasks.claimWorkerName(created.id);
  h.tasks.update(task.id, { sessionId: "pty:runtime", parentSessionId: "pty:mate" });
  h.tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  const runtime = h.manager.beginLaunch(h.tasks.find(task.id)!, {
    command: "codex",
    agent: "codex",
    sessionId: "pty:runtime",
    model: "gpt-test",
    labels: { workerName: task.workerName!, parent: "pty:mate" }
  });
  const live = h.manager.markLive(runtime, "pty:runtime", {
    processId: 1234,
    processStartedAt: "2026-07-14T00:00:00.000Z"
  });
  if (providerSessionId) h.manager.recordProviderSession("pty:runtime", "codex", providerSessionId);
  return { task: h.tasks.find(task.id)!, runtime: h.tasks.stateDb.runtimes.latestForTask(task.id) ?? live };
}

test("runtime interruption preserves task state and trusted identity enables recovery", () => {
  const h = harness();
  const { task } = liveRuntime(h, "11111111-1111-4111-8111-111111111111");
  const interrupted = h.manager.interruptSession("pty:runtime", "PTY disappeared");
  assert.equal(h.tasks.find(task.id)?.state, "working");
  assert.equal(interrupted?.state, "recoverable");
  // The loss is boss-visible immediately, without moving task state.
  const event = h.tasks.events(task.id).at(-1);
  assert.equal(event?.kind, "runtime_interrupted");
  assert.equal(event?.source, "system");
  assert.equal(h.tasks.find(task.id)?.runtime?.recoveryAvailable, true);
  assert.equal(h.tasks.find(task.id)?.runtime?.workerName, task.workerName);
  assert.equal(h.tasks.find(task.id)?.runtime?.parentSessionId, "pty:mate");
  h.cleanup();
});

test("normal completion and explicit teardown end the runtime", () => {
  const normal = harness();
  const { task } = liveRuntime(normal, "22222222-2222-4222-8222-222222222222");
  normal.tasks.recordEvent(task.id, { kind: "done", source: "worker" });
  assert.equal(normal.manager.interruptSession("pty:runtime")?.state, "ended");
  normal.cleanup();

  const teardown = harness();
  liveRuntime(teardown, "33333333-3333-4333-8333-333333333333");
  assert.equal(teardown.manager.interruptSession("pty:runtime", "explicit teardown", true)?.state, "ended");
  teardown.cleanup();
});

test("restart and stale process markers become recoverable without trusting the PID", () => {
  const h = harness();
  const { task, runtime } = liveRuntime(h, "44444444-4444-4444-8444-444444444444");
  assert.equal(runtime.processId, 1234);
  assert.equal(h.manager.reconcile(new Set(["pty:runtime"]), () => false).length, 1);
  assert.equal(h.tasks.find(task.id)?.state, "working");
  assert.equal(h.tasks.find(task.id)?.runtime?.state, "recoverable");
  h.cleanup();
});

test("generation CAS admits one recovery claimant and rejects stale transitions", () => {
  const h = harness();
  const { task } = liveRuntime(h, "55555555-5555-4555-8555-555555555555");
  h.manager.interruptSession("pty:runtime");
  assert.equal(h.manager.claimRecovery(task.id, 0)?.state, "recovering");
  assert.equal(h.manager.claimRecovery(task.id, 0), undefined);
  assert.equal(h.tasks.stateDb.runtimes.compareAndSwap(task.id, 99, "recovering", "live"), undefined);
  h.cleanup();
});

test("legacy runtime without trusted provider identity stays visible but recovery is unavailable", () => {
  const h = harness();
  const { task } = liveRuntime(h);
  h.manager.interruptSession("pty:runtime");
  const snapshot = h.tasks.find(task.id)?.runtime;
  assert.equal(snapshot?.state, "recoverable");
  assert.equal(snapshot?.recoveryAvailable, false);
  assert.equal(snapshot?.recoveryUnavailableReason, "provider_session_unknown");
  assert.equal(snapshot?.workerName, task.workerName);
  h.cleanup();
});

test("malformed or unsupported provider identity is never recovery-eligible", () => {
  const malformed = harness();
  const { task: malformedTask } = liveRuntime(malformed, "not-a-provider-uuid");
  malformed.manager.interruptSession("pty:runtime");
  assert.equal(malformed.tasks.find(malformedTask.id)?.runtime?.recoveryAvailable, false);
  assert.equal(malformed.tasks.find(malformedTask.id)?.runtime?.recoveryUnavailableReason, "provider_session_unknown");
  malformed.cleanup();

  const unsupported = harness();
  const { task: unsupportedTask } = liveRuntime(unsupported);
  unsupported.manager.recordProviderSession("pty:runtime", "shell", "66666666-6666-4666-8666-666666666666");
  unsupported.manager.interruptSession("pty:runtime");
  assert.equal(unsupported.tasks.find(unsupportedTask.id)?.runtime?.recoveryAvailable, false);
  unsupported.cleanup();
});

test("one PTY session cannot be owned by duplicate runtime rows", () => {
  const h = harness();
  liveRuntime(h);
  const other = h.tasks.create({ title: "other runtime", project: "/tmp/repo" });
  assert.throws(
    () => h.tasks.stateDb.runtimes.create({
      taskId: other.id,
      generation: 0,
      state: "starting",
      agent: "codex",
      ptySessionId: "pty:runtime"
    }),
    /UNIQUE constraint failed/
  );
  h.cleanup();
});

test("managed launch refuses a second active generation for one logical worker", () => {
  const h = harness();
  const { task } = liveRuntime(h);
  assert.throws(
    () => h.manager.beginLaunch(task, { command: "codex", agent: "codex", sessionId: "pty:duplicate" }),
    /already owns runtime generation 0/
  );
  h.cleanup();
});

test("legacy task projections bootstrap visible recovery-unavailable runtimes", () => {
  const h = harness();
  const task = h.tasks.create({ title: "legacy projection", project: "/tmp/repo" });
  h.tasks.update(task.id, {
    sessionId: "pty:legacy",
    workerName: "Alder",
    parentSessionId: "pty:mate-legacy",
    worktreeId: "wt:legacy"
  });
  h.tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  assert.equal(h.manager.bootstrapLegacyTasks(), 1);
  const snapshot = h.tasks.find(task.id)?.runtime;
  assert.equal(snapshot?.state, "recoverable");
  assert.equal(snapshot?.recoveryAvailable, false);
  assert.equal(snapshot?.workerId, task.id);
  assert.equal(snapshot?.workerName, "Alder");
  assert.equal(snapshot?.parentSessionId, "pty:mate-legacy");
  assert.equal(snapshot?.leaseId, "wt:legacy");
  assert.equal(h.manager.bootstrapLegacyTasks(), 0);
  h.cleanup();
});

test("a task reaching a terminal state without teardown ends its parked runtime", () => {
  const h = harness();
  const { task } = liveRuntime(h, "77777777-7777-4777-8777-777777777777");
  h.manager.interruptSession("pty:runtime");
  assert.equal(h.tasks.find(task.id)?.runtime?.state, "recoverable");
  h.tasks.recordEvent(task.id, { kind: "done", source: "poller" });
  assert.equal(h.tasks.find(task.id)?.runtime?.state, "ended");
  h.cleanup();
});

test("reconcile ends recoverable runtimes whose task already finished", () => {
  const h = harness();
  const { task } = liveRuntime(h, "88888888-8888-4888-8888-888888888888");
  h.manager.interruptSession("pty:runtime");
  h.tasks.stateDb.tasks.save({ ...h.tasks.stateDb.tasks.find(task.id)!, state: "closed" });
  assert.equal(h.manager.reconcile(new Set(), () => false).length, 1);
  assert.equal(h.tasks.find(task.id)?.runtime?.state, "ended");
  h.cleanup();
});

test("legacy bootstrap tolerates duplicate session ids and maps finished tasks to ended", () => {
  const h = harness();
  const finished = h.tasks.create({ title: "legacy finished", project: "/tmp/repo" });
  h.tasks.update(finished.id, { sessionId: "pty:legacy-done" });
  h.tasks.recordEvent(finished.id, { kind: "done", source: "worker" });
  const first = h.tasks.create({ title: "legacy one", project: "/tmp/repo" });
  h.tasks.update(first.id, { sessionId: "pty:legacy-dup" });
  const second = h.tasks.create({ title: "legacy two", project: "/tmp/repo" });
  h.tasks.update(second.id, { sessionId: "pty:legacy-dup" });
  assert.equal(h.manager.bootstrapLegacyTasks(), 2);
  assert.equal(h.tasks.find(finished.id)?.runtime?.state, "ended");
  h.cleanup();
});

test("legacy repair targets only the exact system session_gone artifact", () => {
  const h = harness();
  const legacy = h.tasks.create({ title: "legacy blocker", project: "/tmp/repo" });
  h.tasks.recordEvent(legacy.id, { kind: "working", source: "worker" });
  h.tasks.recordEvent(legacy.id, {
    kind: "blocked",
    source: "system",
    message: "old artifact",
    data: { reason: "session_gone" }
  });
  const genuine = h.tasks.create({ title: "genuine blocker", project: "/tmp/repo" });
  h.tasks.recordEvent(genuine.id, { kind: "working", source: "worker" });
  h.tasks.recordEvent(genuine.id, {
    kind: "blocked",
    source: "worker",
    message: "needs credentials",
    data: { reason: "session_gone" }
  });

  assert.equal(h.manager.repairLegacySessionGoneArtifacts(), 1);
  assert.equal(h.tasks.find(legacy.id)?.state, "working");
  assert.equal(h.tasks.find(genuine.id)?.state, "blocked");
  assert.equal(h.manager.repairLegacySessionGoneArtifacts(), 0);
  h.cleanup();
});
