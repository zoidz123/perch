import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InjectedCrash } from "./failureInjection.js";
import { TaskScheduler } from "./taskScheduler.js";
import { TaskStore } from "./tasks.js";

function harness() {
  const home = mkdtempSync(join(tmpdir(), "perch-scheduler-"));
  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  const tasks = new TaskStore(env);
  const task = tasks.create({ title: "durable dispatch", project: "/tmp/repo" });
  return { home, env, tasks, task, now: Date.parse("2026-07-14T10:00:00.000Z") };
}

test("failure boundaries before and after claim recover an expired dispatch claim", async () => {
  const h = harness();
  let now = h.now;
  const operation = h.tasks.stateDb.operations.create({
    taskId: h.task.id,
    kind: "dispatch",
    idempotencyKey: "dispatch:claim-boundaries"
  });
  const before = new TaskScheduler({
    stateDb: h.tasks.stateDb,
    now: () => now,
    beforeClaim: () => { throw new InjectedCrash("beforeClaim"); },
    execute: () => { throw new Error("must not execute"); }
  });
  await assert.rejects(before.run(operation.id), /beforeClaim/);
  assert.equal(h.tasks.stateDb.operations.find(operation.id)?.state, "pending");

  const after = new TaskScheduler({
    stateDb: h.tasks.stateDb,
    claimTtlMs: 100,
    now: () => now,
    afterClaim: () => { throw new InjectedCrash("afterClaim"); },
    execute: () => { throw new Error("must not execute"); }
  });
  await assert.rejects(after.run(operation.id), /afterClaim/);
  assert.equal(h.tasks.stateDb.operations.find(operation.id)?.state, "claimed");

  now += 101;
  let executions = 0;
  const restarted = new TaskScheduler({
    stateDb: h.tasks.stateDb,
    now: () => now,
    execute: () => { executions += 1; }
  });
  await restarted.run(operation.id);
  assert.equal(executions, 1);
  assert.equal(h.tasks.stateDb.operations.find(operation.id)?.state, "succeeded");
  assert.equal(h.tasks.stateDb.operations.find(operation.id)?.attempts, 2);
  h.tasks.close();
  rmSync(h.home, { recursive: true, force: true });
});

test("before-launch retry and after-launch adoption produce zero or one live worker", async () => {
  const h = harness();
  let now = h.now;
  const live = new Set<string>();
  let launches = 0;
  const beforeLaunch = h.tasks.stateDb.operations.create({
    taskId: h.task.id,
    kind: "dispatch",
    idempotencyKey: "dispatch:before-launch",
    payload: { sessionId: "pty:before" }
  });
  const crashBefore = new TaskScheduler({
    stateDb: h.tasks.stateDb,
    claimTtlMs: 100,
    now: () => now,
    boundary: (name) => { if (name === "beforeLaunch") throw new InjectedCrash(name); },
    execute: async (_operation, context) => {
      await context.boundary("beforeLaunch");
      launches += 1;
    }
  });
  await assert.rejects(crashBefore.run(beforeLaunch.id), /beforeLaunch/);
  assert.equal(launches, 0);
  now += 101;
  const retryBefore = new TaskScheduler({
    stateDb: h.tasks.stateDb,
    now: () => now,
    execute: async (_operation, context) => {
      await context.boundary("beforeLaunch");
      launches += 1;
    }
  });
  await retryBefore.run(beforeLaunch.id);
  assert.equal(launches, 1);

  const afterLaunch = h.tasks.stateDb.operations.create({
    taskId: h.task.id,
    kind: "dispatch",
    idempotencyKey: "dispatch:after-launch",
    payload: { sessionId: "pty:after" }
  });
  const crashAfter = new TaskScheduler({
    stateDb: h.tasks.stateDb,
    claimTtlMs: 100,
    now: () => now,
    boundary: (name) => { if (name === "afterLaunch") throw new InjectedCrash(name); },
    execute: async (operation, context) => {
      const sessionId = String(operation.payload?.sessionId);
      await context.boundary("beforeLaunch");
      if (!live.has(sessionId)) {
        live.add(sessionId);
        launches += 1;
      }
      await context.boundary("afterLaunch");
    }
  });
  await assert.rejects(crashAfter.run(afterLaunch.id), /afterLaunch/);
  now += 101;
  const adoptAfter = new TaskScheduler({
    stateDb: h.tasks.stateDb,
    now: () => now,
    execute: async (operation) => {
      const sessionId = String(operation.payload?.sessionId);
      if (!live.has(sessionId)) {
        live.add(sessionId);
        launches += 1;
      }
      h.tasks.recordEvent(h.task.id, { kind: "working", source: "system", message: "worker linked" });
    }
  });
  await adoptAfter.run(afterLaunch.id);
  assert.equal(launches, 2, "one launch for each distinct idempotency key");
  assert.deepEqual(h.tasks.events(h.task.id).map((event) => event.kind), ["created", "working"]);
  h.tasks.close();
  rmSync(h.home, { recursive: true, force: true });
});

test("a slow launch renews its claim lease and is never reclaimed mid-execution", async () => {
  const h = harness();
  const operation = h.tasks.stateDb.operations.create({
    taskId: h.task.id,
    kind: "dispatch",
    idempotencyKey: "dispatch:heartbeat"
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let launches = 0;
  const slow = new TaskScheduler({
    stateDb: h.tasks.stateDb,
    claimTtlMs: 1_000,
    execute: async () => { launches += 1; await gate; }
  });
  const running = slow.run(operation.id);
  await new Promise((resolve) => setTimeout(resolve, 1_400));
  const reclaimer = new TaskScheduler({
    stateDb: h.tasks.stateDb,
    execute: () => { launches += 1; }
  });
  await reclaimer.drain();
  assert.equal(launches, 1, "the renewed lease is not reclaimed past its original TTL");
  release();
  await running;
  assert.equal(h.tasks.stateDb.operations.find(operation.id)?.state, "succeeded");
  h.tasks.close();
  rmSync(h.home, { recursive: true, force: true });
});

test("atomic claims serialize concurrent execution and startup drains pending work cleanly", async () => {
  const h = harness();
  const operation = h.tasks.stateDb.operations.create({
    taskId: h.task.id,
    kind: "dispatch",
    idempotencyKey: "dispatch:concurrent"
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let launches = 0;
  const execute = async () => { launches += 1; await gate; };
  const first = new TaskScheduler({ stateDb: h.tasks.stateDb, execute, intervalMs: 5 });
  const second = new TaskScheduler({ stateDb: h.tasks.stateDb, execute, intervalMs: 5 });
  const a = first.run(operation.id);
  const b = second.run(operation.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(launches, 1);
  release();
  await Promise.all([a, b]);
  await first.stop();
  await second.stop();

  const pending = h.tasks.stateDb.operations.create({
    taskId: h.task.id,
    kind: "dispatch",
    idempotencyKey: "dispatch:startup"
  });
  const startup = new TaskScheduler({ stateDb: h.tasks.stateDb, execute: () => {}, intervalMs: 5 });
  startup.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await startup.stop();
  assert.equal(h.tasks.stateDb.operations.find(pending.id)?.state, "succeeded");
  h.tasks.close();

  const restarted = new TaskStore(h.env);
  assert.equal(restarted.stateDb.operations.find(pending.id)?.state, "succeeded");
  restarted.close();
  rmSync(h.home, { recursive: true, force: true });
});

test("startup draining leaves unknown future operation kinds untouched", async () => {
  const h = harness();
  const future = h.tasks.stateDb.operations.create({
    taskId: h.task.id,
    kind: "future-provider-operation",
    idempotencyKey: "future:operation"
  });
  const dispatch = h.tasks.stateDb.operations.create({
    taskId: h.task.id,
    kind: "dispatch",
    idempotencyKey: "dispatch:known"
  });
  const executed: string[] = [];
  const scheduler = new TaskScheduler({
    stateDb: h.tasks.stateDb,
    operationKinds: ["dispatch", "recovery"],
    execute: (operation) => { executed.push(operation.kind); }
  });

  await scheduler.drain();

  assert.deepEqual(executed, ["dispatch"]);
  assert.equal(h.tasks.stateDb.operations.find(dispatch.id)?.state, "succeeded");
  assert.equal(h.tasks.stateDb.operations.find(future.id)?.state, "pending");
  h.tasks.close();
  rmSync(h.home, { recursive: true, force: true });
});
