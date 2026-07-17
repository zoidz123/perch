import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { StartAgentRequest } from "@perch/shared";
import { canonicalRepository, taskCapabilityEnvironment } from "./agentLauncher.js";
import { TaskStore } from "./tasks.js";
import { RuntimeManager } from "./runtimeManager.js";

test("task capability environment exposes scoped claims without treating prompt words as authority", () => {
  const home = mkdtempSync(join(tmpdir(), "perch-capability-env-"));
  const repo = join(home, "repo");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://user:secret@github.com/acme/demo.git"]);
  const tasks = new TaskStore({ PERCH_HOME: home });
  try {
    const created = tasks.create({
      title: "audit safe public ship validation",
      project: repo,
      mode: "direct-PR",
      prompt: "hardening ready-for-review"
    });
    tasks.update(created.id, { branch: `perch/${created.id}` });
    const request: StartAgentRequest = {
      command: "codex",
      cwd: repo,
      sessionId: "pty:test-worker",
      labels: { task: created.id }
    };
    const runtimes = new RuntimeManager(tasks);
    const runtime = runtimes.beginLaunch(tasks.find(created.id)!, request);
    runtimes.markLive(runtime, request.sessionId!);

    assert.deepEqual(taskCapabilityEnvironment(tasks, request), {
      PERCH_TASK_ID: created.id,
      PERCH_TASK_MODE: "direct-PR",
      PERCH_TASK_PROJECT: realpathSync(repo),
      PERCH_TASK_REPOSITORY: "github.com/acme/demo",
      PERCH_TASK_WORKTREE: realpathSync(repo),
      PERCH_TASK_BRANCH: `perch/${created.id}`,
      PERCH_RUNTIME_GENERATION: "0"
    });
    assert.deepEqual(taskCapabilityEnvironment(tasks, { command: "codex" }), {});
  } finally {
    tasks.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("repository canonicalization matches no-mistakes protocol version 1", () => {
  assert.equal(canonicalRepository("https://user:secret@GitHub.com:443/Owner/Repo.git"), "github.com:443/Owner/Repo");
  assert.equal(canonicalRepository("git@GitHub.com:Owner/Repo.git"), "github.com/owner/repo");
});
