import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentAdapter } from "./adapters/types.js";
import { AuditLog } from "./audit.js";
import { cleanupSessionExitWorktree } from "./sessionExitCleanup.js";
import { StateMetrics } from "./stateMetrics.js";
import { TaskStore } from "./tasks.js";
import { WorktreePool } from "./worktrees.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "perch-exit-repo-"));
  const run = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "t@t"]);
  run(["config", "user.name", "t"]);
  writeFileSync(join(dir, "readme.md"), "hello\n");
  run(["add", "."]);
  run(["commit", "-qm", "init"]);
  return dir;
}

function inSlot(path: string, args: string[]): void {
  execFileSync("git", ["-C", path, ...args], { stdio: "pipe" });
}

type Harness = {
  repo: string;
  pool: WorktreePool;
  tasks: TaskStore;
  auditLog: AuditLog;
  adapter: AgentAdapter;
  stopped: string[];
  metrics: StateMetrics;
  cleanup: () => void;
};

function harness(): Harness {
  const repo = makeRepo();
  const poolRoot = mkdtempSync(join(tmpdir(), "perch-exit-pool-"));
  const home = mkdtempSync(join(tmpdir(), "perch-exit-home-"));
  const pool = new WorktreePool({ root: poolRoot, maxSlots: 2 });
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const auditLog = new AuditLog(join(home, "audit.jsonl"));
  const stopped: string[] = [];
  const adapter = {
    name: "test",
    stopSession: async (id: string) => {
      stopped.push(id);
    }
  } as unknown as AgentAdapter;
  return {
    repo,
    pool,
    tasks,
    auditLog,
    adapter,
    stopped,
    metrics: new StateMetrics(),
    cleanup: () => {
      rmSync(repo, { recursive: true, force: true });
      rmSync(poolRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  };
}

test("session exit keeps a task-owned clean local branch commit leased before PR or merge", async () => {
  const h = harness();
  const task = h.tasks.create({ title: "protect task branch", project: h.repo });
  const sessionId = "pty:worker";
  const lease = await h.pool.acquire(h.repo, sessionId);
  inSlot(lease.path, ["checkout", "-qb", "perch/protect-task-branch"]);
  writeFileSync(join(lease.path, "work.txt"), "local committed task work\n");
  inSlot(lease.path, ["add", "."]);
  inSlot(lease.path, ["commit", "-qm", "task work"]);
  h.tasks.update(task.id, {
    sessionId,
    worktreeId: lease.id,
    branch: "perch/protect-task-branch"
  });
  h.tasks.recordEvent(task.id, { kind: "working", source: "worker" });

  await cleanupSessionExitWorktree(
    sessionId,
    { status: "done", exitCode: 0, tail: "agent exited" },
    {
      tasks: h.tasks,
      worktrees: h.pool,
      adapter: h.adapter,
      auditLog: h.auditLog,
      metrics: h.metrics
    }
  );

  assert.equal(h.pool.find(lease.id)?.leasedBy, sessionId, "task lease remains protected");
  assert.ok(existsSync(join(lease.path, "work.txt")), "clean committed branch work survives");
  assert.equal(h.tasks.find(task.id)?.state, "working");
  assert.equal(h.metrics.snapshot().counters["watchdog.sessionDeaths"], 1);
  const events = h.tasks.events(task.id);
  assert.equal(events.some((event) => event.kind === "landed"), false);
  assert.equal(events.some((event) => event.kind === "closed"), false);
  assert.equal(events.some((event) => event.kind === "failed"), false);
  assert.equal(events.some((event) => event.kind === "blocked"), false);
  const note = events.find((event) => event.kind === "note");
  assert.match(note?.message ?? "", /worktree retained after session exit/);
  assert.match(note?.message ?? "", /landed gate refused/);
  assert.equal(note?.data?.worktreeId, lease.id);
  assert.deepEqual(h.stopped, []);

  h.cleanup();
});

test("session exit still returns non-task clean leases through the pool", async () => {
  const h = harness();
  const sessionId = "pty:solo";
  const lease = await h.pool.acquire(h.repo, sessionId);

  await cleanupSessionExitWorktree(
    sessionId,
    { status: "done", exitCode: 0 },
    {
      tasks: h.tasks,
      worktrees: h.pool,
      adapter: h.adapter,
      auditLog: h.auditLog,
      metrics: h.metrics
    }
  );

  assert.equal(h.pool.find(lease.id)?.leasedBy, undefined);
  assert.deepEqual(h.tasks.list(), []);

  h.cleanup();
});

test("session exit can tear down a task lease once the task landed gate passes", async () => {
  const h = harness();
  execFileSync("git", ["-C", h.repo, "remote", "add", "origin", "https://github.com/o/r.git"], { stdio: "pipe" });
  const task = h.tasks.create({ title: "merged task", project: h.repo });
  const sessionId = "pty:merged";
  const lease = await h.pool.acquire(h.repo, sessionId);
  writeFileSync(join(lease.path, "work.txt"), "merged through PR\n");
  inSlot(lease.path, ["add", "."]);
  inSlot(lease.path, ["commit", "-qm", "merged work"]);
  h.tasks.update(task.id, {
    sessionId,
    worktreeId: lease.id,
    branch: `perch/${task.id}`,
    pr: { url: "https://github.com/o/r/pull/99", repo: "o/r", head: `perch/${task.id}`, merged: true }
  });
  h.tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  h.tasks.recordEvent(task.id, { kind: "done", source: "worker" });

  await cleanupSessionExitWorktree(
    sessionId,
    { status: "done", exitCode: 0 },
    {
      tasks: h.tasks,
      worktrees: h.pool,
      adapter: h.adapter,
      auditLog: h.auditLog,
      metrics: h.metrics
    }
  );

  assert.equal(h.pool.find(lease.id)?.leasedBy, undefined);
  assert.equal(h.tasks.find(task.id)?.state, "closed");
  assert.deepEqual(h.stopped, [sessionId]);
  const kinds = h.tasks.events(task.id).map((event) => event.kind);
  assert.ok(kinds.includes("landed"));
  assert.ok(kinds.includes("closed"));
  assert.ok(!existsSync(join(lease.path, "work.txt")), "released slot reset to the default tip");

  h.cleanup();
});
