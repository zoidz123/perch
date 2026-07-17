import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { StartAgentRequest } from "@perch/shared";
import { taskCapabilityEnvironment } from "./agentLauncher.js";
import { TaskStore } from "./tasks.js";

test("task capability environment exposes scoped claims without treating prompt words as authority", () => {
  const home = mkdtempSync(join(tmpdir(), "perch-capability-env-"));
  const tasks = new TaskStore({ PERCH_HOME: home });
  try {
    const created = tasks.create({
      title: "audit safe public ship validation",
      project: "/repo",
      mode: "direct-PR",
      prompt: "hardening ready-for-review"
    });
    tasks.update(created.id, { branch: `perch/${created.id}` });
    const request: StartAgentRequest = {
      command: "codex",
      cwd: "/worktree",
      labels: { task: created.id }
    };

    assert.deepEqual(taskCapabilityEnvironment(tasks, request), {
      PERCH_TASK_ID: created.id,
      PERCH_TASK_MODE: "direct-PR",
      PERCH_TASK_PROJECT: "/repo",
      PERCH_TASK_WORKTREE: "/worktree",
      PERCH_TASK_BRANCH: `perch/${created.id}`
    });
    assert.deepEqual(taskCapabilityEnvironment(tasks, { command: "codex" }), {});
  } finally {
    tasks.close();
    rmSync(home, { recursive: true, force: true });
  }
});
