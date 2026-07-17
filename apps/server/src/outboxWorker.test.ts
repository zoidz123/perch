import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InjectedCrash } from "./failureInjection.js";
import { OutboxWorker } from "./outboxWorker.js";
import { TaskStore } from "./tasks.js";

test("task event, mate wake, and push intents survive failure and retry with backoff", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-outbox-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const task = tasks.create({ title: "outbox event", project: "/tmp/repo" });
  tasks.recordEvent(task.id, { kind: "done", source: "worker", message: "ready" });
  const intents = tasks.stateDb.outbox.pending();
  assert.equal(intents.length, 2);
  let now = Date.parse(intents[0]!.availableAt);
  let mateAttempts = 0;
  let pushes = 0;
  const worker = new OutboxWorker({
    stateDb: tasks.stateDb,
    now: () => now,
    baseBackoffMs: 100,
    deliver: {
      mate: () => { mateAttempts += 1; if (mateAttempts === 1) throw new Error("mate unavailable"); },
      push: () => { pushes += 1; }
    }
  });
  await worker.drain();
  assert.equal(pushes, 1);
  assert.equal(tasks.stateDb.outbox.forTaskEvent(task.id, 2).find((intent) => intent.channel === "mate")?.state, "pending");
  assert.deepEqual(tasks.events(task.id).map((event) => event.kind), ["created", "done"], "durable event is never lost");
  now += 100;
  await worker.drain();
  assert.equal(mateAttempts, 2);
  assert.ok(tasks.stateDb.outbox.forTaskEvent(task.id, 2).every((intent) => intent.state === "delivered"));
  tasks.close();
  rmSync(home, { recursive: true, force: true });
});

test("only channel-notifiable events enqueue intents and settled rows age out of the outbox", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-outbox-retention-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const task = tasks.create({ title: "retention", project: "/tmp/repo" });
  tasks.recordEvent(task.id, { kind: "note", source: "system", message: "bookkeeping" });
  assert.equal(tasks.stateDb.outbox.forTaskEvent(task.id, 2).length, 0, "notes enqueue nothing");
  tasks.recordEvent(task.id, { kind: "stalled", source: "system", message: "worker went quiet" });
  assert.deepEqual(
    tasks.stateDb.outbox.forTaskEvent(task.id, 3).map((intent) => intent.channel),
    ["mate"],
    "stalled wakes the mate but never pushes"
  );
  tasks.recordEvent(task.id, { kind: "done", source: "worker", message: "ready" });
  let now = Date.now();
  const worker = new OutboxWorker({
    stateDb: tasks.stateDb,
    now: () => now,
    retentionMs: 100,
    deliver: { mate: () => {}, push: () => {} }
  });
  await worker.drain();
  assert.ok(tasks.stateDb.outbox.forTaskEvent(task.id, 4).every((intent) => intent.state === "delivered"));

  now += 61_000;
  await worker.drain();
  assert.equal(tasks.stateDb.outbox.forTaskEvent(task.id, 3).length, 0, "delivered rows age out");
  assert.equal(tasks.stateDb.outbox.forTaskEvent(task.id, 4).length, 0, "delivered rows age out");

  const resumed = tasks.create({ title: "resumed task", project: "/repo" });
  tasks.recordEvent(resumed.id, { kind: "working", source: "worker", message: "resumed" });
  tasks.stateDb.outbox.prune(new Date(now + 3_600_000).toISOString());
  const pendingIntents = tasks.stateDb.outbox.forTaskEvent(resumed.id, 2);
  assert.deepEqual(
    pendingIntents.map((intent) => intent.channel),
    ["push"],
    "working disarms the push fallback but never wakes the mate"
  );
  assert.ok(pendingIntents.every((intent) => intent.state === "pending"), "pending rows survive any cutoff");
  tasks.close();
  rmSync(home, { recursive: true, force: true });
});

test("expired outbox claims resume after a crash without replaying delivered channels", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-outbox-restart-"));
  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  const first = new TaskStore(env);
  const task = first.create({ title: "restart outbox", project: "/tmp/repo" });
  first.recordEvent(task.id, { kind: "blocked", source: "worker", message: "waiting" });
  let now = Date.now();
  let crashed = false;
  const worker = new OutboxWorker({
    stateDb: first.stateDb,
    now: () => now,
    claimTtlMs: 100,
    beforeDelivery: () => { if (!crashed) { crashed = true; throw new InjectedCrash("outboxDelivery"); } },
    deliver: { mate: () => {}, push: () => {} }
  });
  await worker.drain();
  assert.equal(first.stateDb.outbox.forTaskEvent(task.id, 2).filter((intent) => intent.state === "claimed").length, 1);
  first.close();

  now += 101;
  const restarted = new TaskStore(env);
  const delivered: string[] = [];
  const resumed = new OutboxWorker({
    stateDb: restarted.stateDb,
    now: () => now,
    deliver: {
      mate: () => { delivered.push("mate"); },
      push: () => { delivered.push("push"); }
    }
  });
  await resumed.drain();
  assert.deepEqual(delivered.sort(), ["mate", "push"]);
  assert.ok(restarted.stateDb.outbox.forTaskEvent(task.id, 2).every((intent) => intent.state === "delivered"));
  restarted.close();
  rmSync(home, { recursive: true, force: true });
});
