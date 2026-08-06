import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nativeChildRunSummary, recordNativeChildRunObservation } from "./nativeChildRuns.js";
import { TaskStore } from "./tasks.js";

test("native child observations route to both Codex worker and Mate roots without creating child runtimes", () => {
  const home = mkdtempSync(join(tmpdir(), "perch-native-child-wiring-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  try {
    const task = tasks.create({ title: "Codex worker", project: "/tmp/project" });
    const worker = tasks.stateDb.runtimes.create({
      id: "worker-runtime",
      taskId: task.id,
      generation: 2,
      state: "live",
      agent: "codex",
      provider: "codex",
      ptySessionId: "pty:worker"
    });
    tasks.stateDb.owners.ensure("owner:mate", "mate");
    const mate = tasks.stateDb.ownerRuntimes.create({
      id: "mate-runtime",
      ownerId: "owner:mate",
      generation: 4,
      state: "live",
      agent: "codex",
      provider: "codex",
      ptySessionId: "pty:mate",
      cwd: "/tmp/project"
    });
    const observation = {
      childThreadId: "child-1",
      parentThreadId: "root",
      state: "running" as const,
      observedAt: "2026-08-06T12:00:00.000Z",
      protocol: { itemType: "subAgentActivity" as const, itemId: "activity-1", event: "started" }
    };

    recordNativeChildRunObservation(tasks.stateDb, "pty:worker", observation);
    recordNativeChildRunObservation(tasks.stateDb, "pty:mate", { ...observation, childThreadId: "child-2" });

    assert.deepEqual(nativeChildRunSummary(tasks.stateDb, "pty:worker"), [observation]);
    assert.deepEqual(nativeChildRunSummary(tasks.stateDb, "pty:mate"), [{ ...observation, childThreadId: "child-2" }]);
    assert.equal(tasks.stateDb.runtimes.active().length, 1);
    assert.equal(tasks.stateDb.ownerRuntimes.active().length, 1);
    assert.equal(worker.id, "worker-runtime");
    assert.equal(mate.id, "mate-runtime");
  } finally {
    tasks.close();
    rmSync(home, { recursive: true, force: true });
  }
});
