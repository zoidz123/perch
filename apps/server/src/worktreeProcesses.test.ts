import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentAdapter } from "./adapters/types.js";
import { AuditLog } from "./audit.js";
import { TaskStore } from "./tasks.js";
import { executeTeardown } from "./teardown.js";
import {
  parseLsof,
  reapOrphanWorktreeProcesses,
  systemProcessProbe,
  terminateWorktreeProcesses,
  type ProcessEntry,
  type ProcessProbe
} from "./worktreeProcesses.js";
import { WorktreePool, type WorktreeLease } from "./worktrees.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "perch-wtp-repo-"));
  const run = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "t@t"]);
  run(["config", "user.name", "t"]);
  writeFileSync(join(dir, "readme.md"), "hello\n");
  run(["add", "."]);
  run(["commit", "-qm", "init"]);
  return dir;
}

type Harness = {
  repo: string;
  pool: WorktreePool;
  tasks: TaskStore;
  auditLog: AuditLog;
  adapter: AgentAdapter;
  cleanup: () => void;
};

function harness(): Harness {
  const repo = makeRepo();
  const poolRoot = mkdtempSync(join(tmpdir(), "perch-wtp-pool-"));
  const home = mkdtempSync(join(tmpdir(), "perch-wtp-home-"));
  const pool = new WorktreePool({ root: poolRoot, maxSlots: 4 });
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const auditLog = new AuditLog(join(home, "audit.jsonl"));
  const adapter = {
    name: "test",
    stopSession: async () => {}
  } as unknown as AgentAdapter;
  return {
    repo,
    pool,
    tasks,
    auditLog,
    adapter,
    cleanup: () => {
      rmSync(repo, { recursive: true, force: true });
      rmSync(poolRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  };
}

// A stand-in for the long-lived server a worker starts inside its worktree
// (`node apps/server/dist/index.js`): detached, so ending the worker's PTY
// leaves it running exactly like the leaked processes it stands for.
const spawned: ChildProcess[] = [];

function startLongLivedProcess(cwd: string, options: { ignoreTerm?: boolean } = {}): number {
  const body = options.ignoreTerm
    ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
    : "setInterval(() => {}, 1000);";
  const child = spawn(process.execPath, ["-e", body], { cwd, detached: true, stdio: "ignore" });
  child.unref();
  spawned.push(child);
  return child.pid!;
}

// A server started the way the real one is - `node <dir>/apps/server/dist/index.js`
// - so the only thing separating it from a worktree's server is its path.
function startServerLikeProcess(root: string): number {
  const dist = join(root, "apps", "server", "dist");
  mkdirSync(dist, { recursive: true });
  const entry = join(dist, "index.js");
  writeFileSync(entry, "setInterval(() => {}, 1000);\n");
  const child = spawn(process.execPath, [entry], { cwd: root, detached: true, stdio: "ignore" });
  child.unref();
  spawned.push(child);
  return child.pid!;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function exited(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await wait(25);
  }
  return !isAlive(pid);
}

// Survival needs a settling window: a signaled node process exits in
// milliseconds, so an immediate check would pass for the wrong reason.
async function survived(pid: number): Promise<boolean> {
  await wait(500);
  return isAlive(pid);
}

test.after(() => {
  for (const child of spawned) {
    if (child.pid) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already gone: nothing to clean up.
      }
    }
  }
});

// The reported bug, end to end: a worker starts a server inside its pooled
// worktree, the task is torn down, and the process outlives the lease.
test("teardown terminates the server process the released worktree owns", async () => {
  const h = harness();
  const task = h.tasks.create({ title: "run the server", project: h.repo });
  const sessionId = "pty:leak";
  const lease = await h.pool.acquire(h.repo, sessionId);
  h.tasks.update(task.id, { sessionId, worktreeId: lease.id });
  const pid = startLongLivedProcess(lease.path);
  assert.ok(isAlive(pid), "the worker's server is running inside the worktree");

  await executeTeardown(
    h.tasks.find(task.id)!,
    { tasks: h.tasks, worktrees: h.pool, adapter: h.adapter, auditLog: h.auditLog },
    { force: true }
  );

  assert.equal(h.pool.find(lease.id)?.leasedBy, undefined, "slot returned to the pool");
  assert.ok(await exited(pid), "the worktree's server process is terminated");
  h.cleanup();
});

// The safety line: teardown of one slot signals nothing outside that slot -
// not the primary Perch server, not another slot's live worker, not an
// unrelated node process, however similar their command lines are.
test("teardown leaves the primary server and every process outside the slot alone", async () => {
  const h = harness();
  const primary = mkdtempSync(join(tmpdir(), "perch-wtp-primary-"));
  const unrelated = mkdtempSync(join(tmpdir(), "perch-wtp-unrelated-"));
  const task = h.tasks.create({ title: "teardown", project: h.repo });
  const lease = await h.pool.acquire(h.repo, "pty:torn-down");
  const neighbour = await h.pool.acquire(h.repo, "pty:still-working");
  h.tasks.update(task.id, { sessionId: "pty:torn-down", worktreeId: lease.id });

  const primaryPid = startServerLikeProcess(primary);
  const projectPid = startLongLivedProcess(h.repo);
  const unrelatedPid = startLongLivedProcess(unrelated);
  const neighbourPid = startLongLivedProcess(neighbour.path);
  const ownPid = startLongLivedProcess(lease.path);

  await executeTeardown(
    h.tasks.find(task.id)!,
    { tasks: h.tasks, worktrees: h.pool, adapter: h.adapter, auditLog: h.auditLog },
    { force: true }
  );

  assert.ok(await exited(ownPid), "the torn-down slot's own process is terminated");
  assert.ok(await survived(primaryPid), "the primary server keeps running");
  assert.ok(await survived(projectPid), "a process in the project root keeps running");
  assert.ok(await survived(unrelatedPid), "an unrelated node process keeps running");
  assert.ok(await survived(neighbourPid), "another slot's live worker keeps running");

  rmSync(primary, { recursive: true, force: true });
  rmSync(unrelated, { recursive: true, force: true });
  h.cleanup();
});

// The other half of the fix: slots released without a teardown - a server
// killed mid-task, a lease reclaimed by the pool reaper - still get swept.
test("the orphan sweep clears released slots and never touches leased ones", async () => {
  const h = harness();
  const released = await h.pool.acquire(h.repo, "pty:gone");
  const leased = await h.pool.acquire(h.repo, "pty:live");
  const orphanPid = startLongLivedProcess(released.path);
  const livePid = startLongLivedProcess(leased.path);
  await h.pool.release(released.id, { force: true });

  const swept = await reapOrphanWorktreeProcesses(h.pool);

  assert.deepEqual(
    swept.map((entry) => entry.leaseId),
    [released.id],
    "only the released slot is swept"
  );
  assert.deepEqual(swept[0]!.pids, [orphanPid]);
  assert.ok(await exited(orphanPid), "the orphaned process is terminated");
  assert.ok(await survived(livePid), "the leased slot's process keeps running");

  // Idempotent: a second sweep over the same slots finds nothing to do, and a
  // process that is already gone is success, not an error.
  assert.deepEqual(await reapOrphanWorktreeProcesses(h.pool), []);
  h.cleanup();
});

test("a process that ignores SIGTERM is killed after the graceful window", async () => {
  const h = harness();
  const lease = await h.pool.acquire(h.repo, "pty:stubborn");
  const pid = startLongLivedProcess(lease.path, { ignoreTerm: true });
  await h.pool.release(lease.id, { force: true });

  const signaled = await terminateWorktreeProcesses(lease.path, { gracefulWaitMs: 750 });

  assert.deepEqual(signaled, [pid]);
  assert.ok(await exited(pid), "SIGKILL follows the bounded graceful wait");
  h.cleanup();
});

// Everything below drives the terminator through a stub probe: these are the
// races and mismatches that are impossible to stage reliably with real
// processes, and every one of them must end in no signal at all.
function stubProbe(entries: ProcessEntry[], overrides: Partial<ProcessProbe> = {}): {
  probe: ProcessProbe;
  signals: { pid: number; signal: string }[];
} {
  const signals: { pid: number; signal: string }[] = [];
  const probe: ProcessProbe = {
    snapshot: () => entries,
    cwdOf: (pid) => entries.find((entry) => entry.pid === pid)?.cwd,
    parentOf: () => undefined,
    alive: () => false,
    signal: (pid, signal) => {
      signals.push({ pid, signal });
    },
    ...overrides
  };
  return { probe, signals };
}

test("a slot re-acquired mid-sweep loses no processes", async () => {
  const path = "/tmp/perch-fake-slot";
  const lease = { id: "wt:fake/1", path, repoRoot: "/tmp/repo", slot: "1", createdAt: "" };
  const pool = {
    // Free when the sweep lists slots, leased by the time it would signal.
    list: (): WorktreeLease[] => [{ ...lease }],
    find: (): WorktreeLease | undefined => ({ ...lease, leasedBy: "pty:new-owner" })
  };
  const { probe, signals } = stubProbe([{ pid: 424242, cwd: path }]);

  const swept = await reapOrphanWorktreeProcesses(pool, { probe });

  assert.deepEqual(swept, []);
  assert.deepEqual(signals, [], "the new lease's process is never signaled");
});

test("a pid that has moved out of the slot since the scan is never signaled", async () => {
  const path = "/tmp/perch-fake-slot";
  const { probe, signals } = stubProbe([{ pid: 424243, cwd: path }], {
    cwdOf: () => "/somewhere/else"
  });

  assert.deepEqual(await terminateWorktreeProcesses(path, { probe }), []);
  assert.deepEqual(signals, []);
});

test("a pid that has exited since the scan is not an error", async () => {
  const path = "/tmp/perch-fake-slot";
  const { probe, signals } = stubProbe([{ pid: 424244, cwd: path }], { cwdOf: () => undefined });

  assert.deepEqual(await terminateWorktreeProcesses(path, { probe }), []);
  assert.deepEqual(signals, []);
});

test("this server and its ancestors are never candidates", async () => {
  const path = "/tmp/perch-fake-slot";
  const parents = new Map<number, number>([[process.pid, 987_651], [987_651, 987_652]]);
  const { probe, signals } = stubProbe(
    [
      { pid: process.pid, cwd: path },
      { pid: 987_651, cwd: path },
      { pid: 987_652, cwd: join(path, "apps") }
    ],
    { parentOf: (pid) => parents.get(pid) }
  );

  assert.deepEqual(await terminateWorktreeProcesses(path, { probe }), []);
  assert.deepEqual(signals, []);
});

test("a slot path that resolves to the home directory or / is refused", async () => {
  const { probe, signals } = stubProbe([{ pid: 424245, cwd: "/etc" }]);

  assert.deepEqual(await terminateWorktreeProcesses("/", { probe }), []);
  assert.deepEqual(
    await terminateWorktreeProcesses(process.env.HOME ?? "/", { probe }),
    [],
    "a bare home directory is never a pool slot"
  );
  assert.deepEqual(signals, []);
});

test("the probe reads working directories out of lsof field output", () => {
  assert.deepEqual(parseLsof("p101\nfcwd\nn/tmp/a\np102\nfcwd\nn/tmp/b\n"), [
    { pid: 101, cwd: "/tmp/a" },
    { pid: 102, cwd: "/tmp/b" }
  ]);
  assert.deepEqual(parseLsof(""), []);
  assert.deepEqual(parseLsof("n/tmp/orphaned-field\n"), [], "a path with no pid is dropped");

  // And the real probe agrees with the kernel about this test process.
  const own = systemProcessProbe.cwdOf(process.pid);
  assert.ok(own && process.cwd().endsWith(own.replace(/^\/private/, "")), `own cwd resolved: ${own}`);
});
