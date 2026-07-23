import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  isVerifiedPrelaunchDispatchFailure,
  repairVerifiedPrelaunchDispatchFailures
} from "./dispatchFailures.js";
import { TaskScheduler } from "./taskScheduler.js";
import { TaskStore } from "./tasks.js";
import { landedGate } from "./teardown.js";
import { WorktreePool } from "./worktrees.js";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "perch-dispatch-failure-home-"));
  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  const tasks = new TaskStore(env);
  const worktrees = new WorktreePool({ env });
  return {
    home,
    tasks,
    worktrees,
    cleanup: (...paths: string[]) => {
      tasks.close();
      rmSync(home, { recursive: true, force: true });
      for (const path of paths) rmSync(path, { recursive: true, force: true });
    }
  };
}

async function recordHistoricalDispatchFailure(tasks: TaskStore, taskId: string): Promise<void> {
  const scheduler = new TaskScheduler({
    stateDb: tasks.stateDb,
    execute: () => {
      throw new Error("historical preparation failure");
    },
    onFailure: (_operation, error) => {
      tasks.recordEvent(taskId, {
        kind: "failed",
        source: "system",
        message: `dispatch failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  });
  const operation = scheduler.create({
    taskId,
    idempotencyKey: `dispatch:test:${taskId}`,
    payload: { launchStarted: false }
  });
  await assert.rejects(scheduler.run(operation.id), /historical preparation failure/);
  await scheduler.stop();
}

test("startup repair closes a historical verified pre-launch dispatch failure once", async () => {
  const fx = fixture();
  try {
    const task = fx.tasks.create({ title: "historical ghost", project: fx.home, kind: "scout" });
    await recordHistoricalDispatchFailure(fx.tasks, task.id);

    const failed = fx.tasks.find(task.id)!;
    assert.equal(failed.state, "failed");
    const verdict = await landedGate(failed, undefined, {
      verifiedPrelaunchDispatchFailure: isVerifiedPrelaunchDispatchFailure(failed, fx)
    });
    assert.equal(verdict.landed, true, "normal teardown fallback accepts the same strict predicate");
    assert.equal(repairVerifiedPrelaunchDispatchFailures(fx), 1);
    assert.equal(repairVerifiedPrelaunchDispatchFailures(fx), 0);
    assert.equal(fx.tasks.find(task.id)?.state, "closed");
    assert.deepEqual(fx.tasks.events(task.id).map((event) => event.kind), ["created", "failed", "closed"]);
    assert.equal(fx.tasks.stateDb.operations.latestForTask(task.id, "dispatch")?.state, "failed");
  } finally {
    fx.cleanup();
  }
});

test("an owned lease or linked worktree keeps a failed dispatch protected from normal teardown", async () => {
  const fx = fixture();
  const repo = mkdtempSync(join(tmpdir(), "perch-dispatch-failure-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init", "--allow-empty"], {
    cwd: repo
  });

  try {
    const task = fx.tasks.create({ title: "linked failure", project: repo, kind: "scout" });
    const lease = await fx.worktrees.acquire(repo, task.id);
    await recordHistoricalDispatchFailure(fx.tasks, task.id);

    let failed = fx.tasks.find(task.id)!;
    assert.equal(failed.worktreeId, undefined, "the lease exists before task linkage");
    assert.equal(isVerifiedPrelaunchDispatchFailure(failed, fx), false, "an owned pre-link lease disqualifies it");
    assert.equal(repairVerifiedPrelaunchDispatchFailures(fx), 0);
    let verdict = await landedGate(failed, undefined, {
      verifiedPrelaunchDispatchFailure: isVerifiedPrelaunchDispatchFailure(failed, fx)
    });
    assert.equal(verdict.landed, false);
    assert.match(verdict.reason, /has not reported done/);

    fx.tasks.update(task.id, { worktreeId: lease.id });
    failed = fx.tasks.find(task.id)!;
    assert.equal(isVerifiedPrelaunchDispatchFailure(failed, fx), false, "durable worktree linkage disqualifies it");
    verdict = await landedGate(failed, lease.path, {
      verifiedPrelaunchDispatchFailure: isVerifiedPrelaunchDispatchFailure(failed, fx)
    });
    assert.equal(verdict.landed, false);
    assert.equal(fx.tasks.find(task.id)?.state, "failed");
  } finally {
    fx.cleanup(repo);
  }
});
