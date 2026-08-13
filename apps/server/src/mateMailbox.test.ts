import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { StateDb } from "./stateDb.js";
import { TaskStore } from "./tasks.js";

// Durable worker-to-mate mailbox semantics: lossless report storage,
// transactional commit, deterministic ordering, claim/ack fencing, and
// restart survival. Everything here is state-layer truth - no HTTP.

function home(): string {
  return mkdtempSync(join(tmpdir(), "perch-mailbox-"));
}

function env(root: string): NodeJS.ProcessEnv {
  return { PERCH_HOME: root } as NodeJS.ProcessEnv;
}

function makeWorkedTask(tasks: TaskStore, title: string, sessionId: string) {
  const task = tasks.create({ title, project: "/tmp/repo", kind: "ship" });
  tasks.update(task.id, { sessionId });
  return tasks.find(task.id)!;
}

test("a worker report round-trips byte-for-byte with its evidence, hash, and provenance", () => {
  const root = home();
  const tasks = new TaskStore(env(root));
  const task = makeWorkedTask(tasks, "lossless roundtrip", "pty:worker");

  const body = `# Report\n\nunicode: é你好 \u{1f680}\r\nweird:\ttabs, trailing spaces   \nfences: \`\`\`json\n{"a":1}\n\`\`\`\n${"x".repeat(10_000)}`;
  const evidence = { checks: [{ name: "lint", ok: true }], nested: { deep: [1, 2, 3], text: "✓" } };
  const { report, duplicate } = tasks.recordWorkerReport(task.id, {
    sessionId: "pty:worker",
    idempotencyKey: "report-1",
    summary: "summary line",
    report: body,
    evidence
  });

  assert.equal(duplicate, false);
  const stored = tasks.stateDb.workerReports.find(report.id)!;
  assert.equal(stored.report, body);
  assert.deepEqual(stored.evidence, evidence);
  assert.equal(stored.reportBytes, Buffer.byteLength(body, "utf8"));
  assert.equal(stored.reportSha256, createHash("sha256").update(body, "utf8").digest("hex"));
  assert.equal(stored.sessionId, "pty:worker");
  assert.equal(stored.taskId, task.id);
  assert.equal(stored.format, "markdown");

  // The pointer event carries the summary and stable id, never the body.
  const events = tasks.events(task.id);
  const pointer = events.at(-1)!;
  assert.equal(pointer.kind, "note");
  assert.equal(pointer.source, "worker");
  assert.equal(pointer.message, "summary line");
  assert.equal(pointer.data?.reason, "worker_report");
  assert.equal(pointer.data?.reportId, report.id);
  assert.ok(!JSON.stringify(pointer).includes("x".repeat(50)));

  // Exactly one pending delivery referencing the immutable report.
  const deliveries = tasks.stateDb.mateMailbox.list();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.reportId, report.id);
  assert.equal(deliveries[0]!.state, "pending");

  tasks.close();
  rmSync(root, { recursive: true, force: true });
});

test("report submission is one transaction: a mid-transaction failure leaves no event, report, or delivery", () => {
  const root = home();
  const tasks = new TaskStore(env(root));
  const task = makeWorkedTask(tasks, "atomic commit", "pty:worker");
  const { report } = tasks.recordWorkerReport(task.id, {
    sessionId: "pty:worker",
    idempotencyKey: "k-1",
    summary: "first",
    report: "first body"
  });
  const eventsBefore = tasks.events(task.id).length;

  // Force the worker_reports insert (after the event insert) to violate the
  // primary key: the whole transaction must roll back.
  const raw = tasks.find(task.id)!;
  assert.throws(() =>
    tasks.stateDb.tasks.record(
      { ...raw, runtime: undefined, presentation: undefined },
      { kind: "note", source: "worker", message: "second" },
      [],
      {
        recipient: "mate",
        report: {
          id: report.id, // collides
          taskId: task.id,
          sessionId: "pty:worker",
          idempotencyKey: "k-2",
          format: "markdown",
          summary: "second",
          report: "second body",
          reportBytes: 11,
          reportSha256: "0".repeat(64)
        }
      }
    )
  );
  assert.equal(tasks.events(task.id).length, eventsBefore, "the event insert rolled back with the report");
  assert.equal(tasks.stateDb.mateMailbox.list().length, 1, "no orphan delivery row");
  assert.equal(tasks.stateDb.workerReports.findByIdempotencyKey(task.id, "pty:worker", "k-2"), undefined);

  tasks.close();
  rmSync(root, { recursive: true, force: true });
});

test("sender retries are idempotent per (task, session, key); the same key with different content conflicts", () => {
  const root = home();
  const tasks = new TaskStore(env(root));
  const task = makeWorkedTask(tasks, "idempotent send", "pty:worker");
  const input = {
    sessionId: "pty:worker",
    idempotencyKey: "same-key",
    summary: "s",
    report: "identical body",
    evidence: { ok: true }
  };

  const first = tasks.recordWorkerReport(task.id, input);
  const retry = tasks.recordWorkerReport(task.id, input);
  assert.equal(first.duplicate, false);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.report.id, first.report.id);
  assert.equal(tasks.events(task.id).filter((event) => event.data?.reason === "worker_report").length, 1);
  assert.equal(tasks.stateDb.mateMailbox.list().length, 1);

  assert.throws(
    () => tasks.recordWorkerReport(task.id, { ...input, report: "DIFFERENT body" }),
    /idempotency key/
  );

  // A different key from the same sender is a new report.
  const second = tasks.recordWorkerReport(task.id, { ...input, idempotencyKey: "other-key" });
  assert.notEqual(second.report.id, first.report.id);
  assert.equal(tasks.stateDb.mateMailbox.list().length, 2);

  tasks.close();
  rmSync(root, { recursive: true, force: true });
});

test("every boss lifecycle event creates a mailbox delivery; heartbeats and notes do not", () => {
  const root = home();
  const tasks = new TaskStore(env(root));
  const task = makeWorkedTask(tasks, "routing", "pty:worker");

  tasks.recordEvent(task.id, { kind: "pr_linked", source: "worker", message: "PR" });
  tasks.recordEvent(task.id, { kind: "stalled", source: "system", message: "watchdog" });
  tasks.recordEvent(task.id, { kind: "checks_green", source: "poller", message: "CI green" });
  tasks.recordEvent(task.id, { kind: "merge_ready", source: "poller", message: "ready" });
  tasks.recordEvent(task.id, { kind: "runtime_interrupted", source: "system", message: "runtime" });
  tasks.recordEvent(task.id, { kind: "needs_decision", source: "worker", message: "choose" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  tasks.recordEvent(task.id, { kind: "blocked", source: "worker", message: "waiting on credential" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  tasks.recordEvent(task.id, { kind: "completion_requested", source: "worker", message: "verify" });
  tasks.recordEvent(task.id, { kind: "completion_accepted", source: "system", message: "accepted" });
  tasks.recordEvent(task.id, { kind: "done", source: "worker", message: "claim" });
  tasks.recordEvent(task.id, { kind: "merged", source: "poller", message: "landed" });
  tasks.recordEvent(task.id, { kind: "failed", source: "system", message: "post-merge failure" });
  tasks.recordEvent(task.id, { kind: "note", source: "worker", message: "bookkeeping" });
  const deliveries = tasks.stateDb.mateMailbox.list();
  assert.equal(deliveries.length, 11);
  const kinds = deliveries.map(
    (delivery) => tasks.stateDb.tasks.eventById(delivery.taskEventId)?.kind
  );
  assert.deepEqual(kinds, [
    "pr_linked",
    "stalled",
    "checks_green",
    "merge_ready",
    "runtime_interrupted",
    "needs_decision",
    "blocked",
    "completion_requested",
    "done",
    "merged",
    "failed"
  ]);

  tasks.close();
  rmSync(root, { recursive: true, force: true });
});

test("claims drain FIFO per task and in deterministic commit order across tasks", () => {
  const root = home();
  const tasks = new TaskStore(env(root));
  const first = makeWorkedTask(tasks, "task one", "pty:w1");
  const second = makeWorkedTask(tasks, "task two", "pty:w2");

  tasks.recordEvent(first.id, { kind: "blocked", source: "worker", message: "a1" });
  tasks.recordEvent(second.id, { kind: "blocked", source: "worker", message: "b1" });
  tasks.recordEvent(first.id, { kind: "working", source: "worker" });
  tasks.recordEvent(first.id, { kind: "needs_decision", source: "worker", message: "a2" });
  tasks.recordEvent(second.id, { kind: "working", source: "worker" });
  tasks.recordEvent(second.id, { kind: "needs_decision", source: "worker", message: "b2" });

  const now = new Date().toISOString();
  const claimed = tasks.stateDb.mateMailbox.claim({ generation: 0, limit: 10, ttlMs: 60_000, now });
  const drained = claimed.map((record) => ({
    task: record.taskId,
    message: tasks.stateDb.tasks.eventById(record.taskEventId)?.message
  }));
  assert.deepEqual(drained, [
    { task: first.id, message: "a1" },
    { task: second.id, message: "b1" },
    { task: first.id, message: "a2" },
    { task: second.id, message: "b2" }
  ]);
  assert.ok(claimed.every((record) => record.state === "claimed" && record.claimToken));

  tasks.close();
  rmSync(root, { recursive: true, force: true });
});

test("claim tokens fence acknowledgments: re-mint, expiry, stale generation, replay, and conflict", () => {
  const root = home();
  const tasks = new TaskStore(env(root));
  const task = makeWorkedTask(tasks, "fencing", "pty:worker");
  tasks.recordEvent(task.id, { kind: "blocked", source: "worker", message: "m" });
  const mailbox = tasks.stateDb.mateMailbox;
  const now = () => new Date().toISOString();

  // Ack before any claim is refused.
  const unclaimed = mailbox.list()[0]!;
  assert.equal(
    mailbox.ack({
      id: unclaimed.id,
      claimToken: "made-up",
      generation: 0,
      idempotencyKey: "k",
      sessionId: "pty:mate",
      now: now()
    }).outcome,
    "not_claimed"
  );

  const firstClaim = mailbox.claim({ generation: 1, limit: 1, ttlMs: 60_000, now: now() })[0]!;
  // Re-claiming re-mints the token; the old token is now stale.
  const secondClaim = mailbox.claim({ generation: 1, limit: 1, ttlMs: 60_000, now: now() })[0]!;
  assert.notEqual(firstClaim.claimToken, secondClaim.claimToken);
  assert.equal(
    mailbox.ack({
      id: firstClaim.id,
      claimToken: firstClaim.claimToken!,
      generation: 1,
      idempotencyKey: "k",
      sessionId: "pty:mate",
      now: now()
    }).outcome,
    "stale_token"
  );

  // An expired lease cannot acknowledge and returns the row to the claim pool.
  const lateNow = new Date(Date.now() + 120_000).toISOString();
  assert.equal(
    mailbox.ack({
      id: secondClaim.id,
      claimToken: secondClaim.claimToken!,
      generation: 1,
      idempotencyKey: "k",
      sessionId: "pty:mate",
      now: lateNow
    }).outcome,
    "stale_token"
  );
  assert.equal(mailbox.pendingCount(lateNow), 1);

  // A stale generation cannot acknowledge even with the right token.
  const thirdClaim = mailbox.claim({ generation: 1, limit: 1, ttlMs: 60_000, now: now() })[0]!;
  assert.equal(
    mailbox.ack({
      id: thirdClaim.id,
      claimToken: thirdClaim.claimToken!,
      generation: 2,
      idempotencyKey: "k",
      sessionId: "pty:mate",
      now: now()
    }).outcome,
    "stale_generation"
  );

  // A valid acknowledgment commits once; the same key replays; a different
  // key conflicts; and the message is never claimable again.
  const acked = mailbox.ack({
    id: thirdClaim.id,
    claimToken: thirdClaim.claimToken!,
    generation: 1,
    idempotencyKey: "ack-1",
    disposition: "relayed to boss",
    sessionId: "pty:mate",
    now: now()
  });
  assert.equal(acked.outcome, "acknowledged");
  assert.equal((acked as { duplicate: boolean }).duplicate, false);
  const replay = mailbox.ack({
    id: thirdClaim.id,
    claimToken: "irrelevant",
    generation: 9,
    idempotencyKey: "ack-1",
    sessionId: "pty:mate",
    now: now()
  });
  assert.equal(replay.outcome, "acknowledged");
  assert.equal((replay as { duplicate: boolean }).duplicate, true);
  assert.equal(
    mailbox.ack({
      id: thirdClaim.id,
      claimToken: thirdClaim.claimToken!,
      generation: 1,
      idempotencyKey: "ack-2",
      sessionId: "pty:mate",
      now: now()
    }).outcome,
    "ack_conflict"
  );
  assert.equal(mailbox.claim({ generation: 1, limit: 10, ttlMs: 60_000, now: now() }).length, 0);
  assert.equal(mailbox.find(thirdClaim.id)?.ackDisposition, "relayed to boss");

  tasks.close();
  rmSync(root, { recursive: true, force: true });
});

test("unacknowledged messages survive a restart; acknowledged messages are never redelivered", () => {
  const root = home();
  let tasks = new TaskStore(env(root));
  const task = makeWorkedTask(tasks, "restart drain", "pty:worker");
  tasks.recordWorkerReport(task.id, {
    sessionId: "pty:worker",
    idempotencyKey: "r1",
    summary: "first",
    report: "first body"
  });
  tasks.recordEvent(task.id, { kind: "blocked", source: "worker", message: "second" });
  const now = () => new Date().toISOString();
  const claimed = tasks.stateDb.mateMailbox.claim({ generation: 0, limit: 1, ttlMs: 60_000, now: now() })[0]!;
  assert.equal(
    tasks.stateDb.mateMailbox.ack({
      id: claimed.id,
      claimToken: claimed.claimToken!,
      generation: 0,
      idempotencyKey: "ack-r1",
      sessionId: "pty:mate",
      now: now()
    }).outcome,
    "acknowledged"
  );
  tasks.close();

  // Server restart: a fresh handle on the same durable state.
  tasks = new TaskStore(env(root));
  const remaining = tasks.stateDb.mateMailbox.claim({ generation: 1, limit: 10, ttlMs: 60_000, now: now() });
  assert.equal(remaining.length, 1);
  assert.equal(tasks.stateDb.tasks.eventById(remaining[0]!.taskEventId)?.message, "second");
  // The report content survived the restart byte-for-byte too.
  const report = tasks.stateDb.workerReports.findByIdempotencyKey(task.id, "pty:worker", "r1")!;
  assert.equal(report.report, "first body");

  tasks.close();
  rmSync(root, { recursive: true, force: true });
});

test("worker reports are immutable at the database layer", () => {
  const root = home();
  const tasks = new TaskStore(env(root));
  const task = makeWorkedTask(tasks, "immutability", "pty:worker");
  const { report } = tasks.recordWorkerReport(task.id, {
    sessionId: "pty:worker",
    idempotencyKey: "imm",
    summary: "s",
    report: "body"
  });
  const state = new StateDb(env(root));
  state.close();
  assert.throws(
    () => tasks.stateDb.transaction(() =>
      (tasks.stateDb as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db
        .prepare("UPDATE worker_reports SET report = 'tampered' WHERE id = ?")
        .run(report.id)
    ),
    /immutable/
  );
  tasks.close();
  rmSync(root, { recursive: true, force: true });
});
