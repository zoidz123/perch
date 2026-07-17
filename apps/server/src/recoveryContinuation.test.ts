import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession, RecentEventsResult } from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import { AuditLog } from "./audit.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { RecoveryContinuationCoordinator } from "./recoveryContinuation.js";
import { RECOVERY_CONTINUATION_TEXT, RuntimeManager } from "./runtimeManager.js";
import { TaskStore } from "./tasks.js";
import { TaskScheduler } from "./taskScheduler.js";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";

class ContinuationAdapter implements AgentAdapter {
  readonly name = "continuation-test";
  readonly submitted: Array<{ sessionId: string; text: string }> = [];
  sessions: AgentSession[] = [];

  async getTopology() { return { windows: [], generatedAt: new Date().toISOString() }; }
  async listSessions() { return this.sessions; }
  async readRecentEvents(): Promise<RecentEventsResult> { return { events: [], terminal: true }; }
  async sendInput() {}
  async sendEnter() {}
  async interrupt() {}
  async submitInput(sessionId: string, text: string) {
    this.submitted.push({ sessionId, text });
    return true;
  }
}

function harness() {
  const home = mkdtempSync(join(tmpdir(), "perch-continuation-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const manager = new RuntimeManager(tasks);
  const adapter = new ContinuationAdapter();
  const monitor = new FleetMonitor(adapter);
  const coordinator = new RecoveryContinuationCoordinator({
    tasks,
    monitor,
    auditLog: new AuditLog(join(home, "audit.jsonl"))
  });
  const created = tasks.create({ title: "continue after recovery", project: home });
  tasks.update(created.id, { sessionId: "pty:g0" });
  tasks.recordEvent(created.id, { kind: "working", source: "worker" });
  const starting = manager.beginLaunch(tasks.find(created.id)!, {
    command: "codex",
    agent: "codex",
    sessionId: "pty:g0"
  });
  manager.markLive(starting, "pty:g0");
  manager.recordProviderSession("pty:g0", "codex", THREAD_ID);

  return {
    home,
    tasks,
    manager,
    adapter,
    monitor,
    coordinator,
    taskId: created.id,
    cleanup() {
      monitor.stop();
      tasks.close();
      rmSync(home, { recursive: true, force: true });
    }
  };
}

function bindNext(h: ReturnType<typeof harness>, oldSessionId: string, nextSessionId: string) {
  const interrupted = h.manager.interruptSession(oldSessionId, "test interruption");
  assert.equal(interrupted?.state, "recoverable");
  const claimed = h.manager.claimRecovery(h.taskId, interrupted!.generation);
  assert.ok(claimed);
  h.adapter.sessions = [{
    id: nextSessionId,
    kind: "terminal",
    title: "recovered",
    status: "idle",
    agent: "codex",
    lastActivityAt: new Date().toISOString()
  }];
  return h.manager.bindRecoveredRuntime(claimed, {
    sessionId: nextSessionId,
    provider: "codex",
    providerSessionId: THREAD_ID
  });
}

test("runtime bind atomically creates one durable continuation intent scoped to the recovered generation", () => {
  const h = harness();
  const g1 = bindNext(h, "pty:g0", "pty:g1");
  const first = h.tasks.stateDb.operations.findByIdempotencyKey(`continuation:${h.taskId}:g1`);
  assert.equal(g1.generation, 1);
  assert.equal(first?.state, "pending");
  assert.deepEqual(first?.payload, {
    generation: 1,
    sessionId: "pty:g1",
    text: RECOVERY_CONTINUATION_TEXT
  });

  assert.equal(h.tasks.stateDb.operations.findByIdempotencyKey(`continuation:${h.taskId}:g1`)?.id, first?.id);

  const g2 = bindNext(h, "pty:g1", "pty:g2");
  assert.equal(g2.generation, 2);
  assert.ok(h.tasks.stateDb.operations.findByIdempotencyKey(`continuation:${h.taskId}:g2`));
  assert.notEqual(
    h.tasks.stateDb.operations.findByIdempotencyKey(`continuation:${h.taskId}:g2`)?.id,
    first?.id
  );
  h.cleanup();
});

test("concurrent and replayed continuation execution submits exactly one deterministic new turn", async () => {
  const h = harness();
  bindNext(h, "pty:g0", "pty:g1");
  const operation = h.tasks.stateDb.operations.findByIdempotencyKey(`continuation:${h.taskId}:g1`)!;
  const scheduler = new TaskScheduler({ stateDb: h.tasks.stateDb, operationKinds: ["continuation"] });
  scheduler.setExecutor((candidate, context) => h.coordinator.execute(candidate, context));

  await Promise.all([scheduler.run(operation.id), scheduler.run(operation.id), scheduler.run(operation.id)]);
  await scheduler.run(operation.id);

  assert.deepEqual(h.adapter.submitted, [{ sessionId: "pty:g1", text: RECOVERY_CONTINUATION_TEXT }]);
  assert.equal(h.tasks.stateDb.operations.find(operation.id)?.state, "succeeded");
  await scheduler.stop();
  h.cleanup();
});

test("a continuation claim abandoned by a crashed scheduler resumes after lease expiry", async () => {
  const h = harness();
  bindNext(h, "pty:g0", "pty:g1");
  const operation = h.tasks.stateDb.operations.findByIdempotencyKey(`continuation:${h.taskId}:g1`)!;
  let now = Date.parse("2026-07-15T00:00:00.000Z");
  const crashed = new TaskScheduler({
    stateDb: h.tasks.stateDb,
    operationKinds: ["continuation"],
    claimTtlMs: 100,
    now: () => now,
    afterClaim: () => { throw new Error("simulated process crash after durable claim"); }
  });
  crashed.setExecutor((candidate, context) => h.coordinator.execute(candidate, context));
  await assert.rejects(crashed.run(operation.id), /simulated process crash/);
  assert.equal(h.tasks.stateDb.operations.find(operation.id)?.state, "claimed");
  assert.equal(h.adapter.submitted.length, 0);
  await crashed.stop();

  now += 101;
  const restarted = new TaskScheduler({
    stateDb: h.tasks.stateDb,
    operationKinds: ["continuation"],
    claimTtlMs: 100,
    now: () => now
  });
  restarted.setExecutor((candidate, context) => h.coordinator.execute(candidate, context));
  await restarted.run(operation.id);
  assert.deepEqual(h.adapter.submitted, [{ sessionId: "pty:g1", text: RECOVERY_CONTINUATION_TEXT }]);
  assert.equal(h.tasks.stateDb.operations.find(operation.id)?.attempts, 2);
  await restarted.stop();
  h.cleanup();
});

test("a recovered shell exiting before continuation leaves its stale generation inert and re-drives the next generation once", async () => {
  const h = harness();
  bindNext(h, "pty:g0", "pty:g1");
  const g1 = h.tasks.stateDb.operations.findByIdempotencyKey(`continuation:${h.taskId}:g1`)!;
  bindNext(h, "pty:g1", "pty:g2");
  const g2 = h.tasks.stateDb.operations.findByIdempotencyKey(`continuation:${h.taskId}:g2`)!;
  const scheduler = new TaskScheduler({ stateDb: h.tasks.stateDb, operationKinds: ["continuation"] });
  scheduler.setExecutor((candidate, context) => h.coordinator.execute(candidate, context));

  await Promise.all([scheduler.run(g1.id), scheduler.run(g2.id)]);

  assert.deepEqual(h.adapter.submitted, [{ sessionId: "pty:g2", text: RECOVERY_CONTINUATION_TEXT }]);
  assert.equal(h.tasks.stateDb.operations.find(g1.id)?.state, "succeeded");
  assert.equal(h.tasks.stateDb.operations.find(g2.id)?.state, "succeeded");
  await scheduler.stop();
  h.cleanup();
});

test("continuation rechecks task and provider prompt parks before submitting", async () => {
  for (const kind of ["needs_decision", "blocked", "done", "failed"] as const) {
    const h = harness();
    bindNext(h, "pty:g0", "pty:g1");
    h.tasks.recordEvent(h.taskId, { kind, source: "worker", message: `parked as ${kind}` });
    const operation = h.tasks.stateDb.operations.findByIdempotencyKey(`continuation:${h.taskId}:g1`)!;
    await h.coordinator.execute(operation);
    assert.equal(h.adapter.submitted.length, 0, `${kind} must not auto-drive`);
    h.cleanup();
  }

  const completion = harness();
  bindNext(completion, "pty:g0", "pty:g1");
  completion.tasks.recordEvent(completion.taskId, { kind: "completion_requested", source: "worker" });
  await completion.coordinator.execute(
    completion.tasks.stateDb.operations.findByIdempotencyKey(`continuation:${completion.taskId}:g1`)!
  );
  assert.equal(completion.adapter.submitted.length, 0, "completion_requested must not auto-drive");
  completion.cleanup();

  const question = harness();
  bindNext(question, "pty:g0", "pty:g1");
  question.monitor.setPendingQuestion("pty:g1", {
    id: "question-1",
    questions: [{ header: "Choice", question: "Continue?", multiSelect: false, options: [{ label: "Yes" }] }],
    at: new Date().toISOString()
  });
  await question.coordinator.execute(
    question.tasks.stateDb.operations.findByIdempotencyKey(`continuation:${question.taskId}:g1`)!
  );
  assert.equal(question.adapter.submitted.length, 0, "provider question must not auto-drive or queue");
  question.cleanup();

  const approval = harness();
  bindNext(approval, "pty:g0", "pty:g1");
  approval.monitor.setPendingApproval("pty:g1", {
    id: "approval-1",
    summary: "Provider needs approval",
    at: new Date().toISOString()
  });
  await approval.coordinator.execute(
    approval.tasks.stateDb.operations.findByIdempotencyKey(`continuation:${approval.taskId}:g1`)!
  );
  assert.equal(approval.adapter.submitted.length, 0, "provider approval must not auto-drive or queue");
  approval.cleanup();

  const closed = harness();
  bindNext(closed, "pty:g0", "pty:g1");
  closed.tasks.recordEvent(closed.taskId, { kind: "done", source: "system" });
  closed.tasks.recordEvent(closed.taskId, { kind: "landed", source: "system" });
  closed.tasks.recordEvent(closed.taskId, { kind: "closed", source: "system" });
  await closed.coordinator.execute(
    closed.tasks.stateDb.operations.findByIdempotencyKey(`continuation:${closed.taskId}:g1`)!
  );
  assert.equal(closed.adapter.submitted.length, 0, "closed task must not auto-drive");
  closed.cleanup();
});

test("only a task interrupted while actively working receives a continuation intent", () => {
  for (const kind of ["needs_decision", "blocked", "completion_requested"] as const) {
    const h = harness();
    h.tasks.recordEvent(h.taskId, { kind, source: "worker" });
    bindNext(h, "pty:g0", "pty:g1");
    assert.equal(
      h.tasks.stateDb.operations.findByIdempotencyKey(`continuation:${h.taskId}:g1`),
      undefined,
      `${kind} interruption must not create an intent`
    );
    h.cleanup();
  }
});
