import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentAdapter } from "./adapters/types.js";
import { AuditLog } from "./audit.js";
import { PrPoller } from "./prPoller.js";
import { TaskStore } from "./tasks.js";
import { executeTeardown, landedGate, ownLeaseFor, type SimctlRunner } from "./teardown.js";
import { WorktreePool } from "./worktrees.js";

// A real git repo standing in for a project root; no remote, so origin/HEAD is
// absent and the gate falls back to the repo's own HEAD as the default branch.
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "perch-td-repo-"));
  const run = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "t@t"]);
  run(["config", "user.name", "t"]);
  run(["remote", "add", "origin", "https://github.com/o/r.git"]);
  writeFileSync(join(dir, "readme.md"), "hello\n");
  run(["add", "."]);
  run(["commit", "-qm", "init"]);
  return dir;
}

function makeRemoteFixture(): { base: string; seed: string; clone: string } {
  const base = mkdtempSync(join(tmpdir(), "perch-td-remote-"));
  const upstream = join(base, "upstream.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", upstream], { stdio: "pipe" });

  const seed = join(base, "seed");
  execFileSync("git", ["init", "-q", "-b", "main", seed], { stdio: "pipe" });
  const seedRun = (args: string[]) => execFileSync("git", ["-C", seed, ...args], { stdio: "pipe" });
  seedRun(["config", "user.email", "t@t"]);
  seedRun(["config", "user.name", "t"]);
  writeFileSync(join(seed, "readme.md"), "hello\n");
  seedRun(["add", "."]);
  seedRun(["commit", "-qm", "init"]);
  seedRun(["remote", "add", "origin", upstream]);
  seedRun(["push", "-q", "-u", "origin", "main"]);

  const clone = join(base, "clone");
  execFileSync("git", ["clone", "-q", upstream, clone], { stdio: "pipe" });
  const cloneRun = (args: string[]) => execFileSync("git", ["-C", clone, ...args], { stdio: "pipe" });
  cloneRun(["config", "user.email", "t@t"]);
  cloneRun(["config", "user.name", "t"]);
  return { base, seed, clone };
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
  cleanup: () => void;
};

function harness(): Harness {
  const repo = makeRepo();
  const poolRoot = mkdtempSync(join(tmpdir(), "perch-td-pool-"));
  const home = mkdtempSync(join(tmpdir(), "perch-td-home-"));
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
    cleanup: () => {
      rmSync(repo, { recursive: true, force: true });
      rmSync(poolRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  };
}

// Wire the same auto-return the server installs in index.ts: a `merged` event
// runs the gate, then (if landed) tears down. Returns a bag whose promises the
// test awaits for determinism (the server fires them fire-and-forget).
function autoReturn(h: Harness): { pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  h.tasks.subscribe((task, event) => {
    if (event.kind !== "merged") {
      return;
    }
    pending.push(
      (async () => {
        const lease = ownLeaseFor(task, h.pool);
        const verdict = await landedGate(task, lease?.path);
        if (!verdict.landed) {
          return;
        }
        h.tasks.recordEvent(task.id, {
          kind: "note",
          source: "system",
          message: `auto-return on merge: ${verdict.reason}`
        });
        await executeTeardown(task, {
          tasks: h.tasks,
          worktrees: h.pool,
          adapter: h.adapter,
          auditLog: h.auditLog
        });
      })()
    );
  });
  return { pending };
}

// (a) A merged PR returns the worktree within the poll cycle, no manual call.
test("auto-return: a merged PR returns the worktree within the poll cycle", async () => {
  const h = harness();
  const task = h.tasks.create({ title: "add flag", project: h.repo });
  h.tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  h.tasks.recordEvent(task.id, { kind: "done", source: "worker" });

  const sessionId = "pty:a";
  const lease = await h.pool.acquire(h.repo, sessionId);
  // A local task branch exists; auto-return cleans it up (remote is left alone).
  inSlot(lease.path, ["branch", "perch/x"]);
  h.tasks.update(task.id, {
    sessionId,
    worktreeId: lease.id,
    branch: "perch/x",
    pr: { url: "https://github.com/o/r/pull/1" }
  });

  const { pending } = autoReturn(h);
  const poller = new PrPoller(h.tasks, async () => ({
    state: "MERGED",
    mergedAt: "2026-07-05T00:00:00Z",
    headRefName: "perch/x",
    headRepository: { nameWithOwner: "o/r" },
    statusCheckRollup: [{ conclusion: "SUCCESS" }]
  }));

  await poller.tick();
  await Promise.all(pending);

  assert.equal(h.pool.find(lease.id)?.leasedBy, undefined, "slot returned to the pool");
  assert.deepEqual(h.stopped, [sessionId], "worker session ended once");
  assert.equal(h.tasks.find(task.id)?.state, "closed");
  const localBranches = execFileSync("git", ["-C", h.repo, "branch", "--list", "perch/x"]).toString().trim();
  assert.equal(localBranches, "", "local task branch deleted");
  const kinds = h.tasks.events(task.id).map((event) => event.kind);
  assert.ok(kinds.includes("note"), "an auto-return trail note is recorded");
  assert.equal(kinds.filter((k) => k === "merged").length, 1);
  assert.equal(kinds.filter((k) => k === "closed").length, 1);

  h.cleanup();
});

test("auto-return: transient readiness regression stays fast-polled until merge", async () => {
  const h = harness();
  const task = h.tasks.create({ title: "merge after settled checks", project: h.repo });
  h.tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  h.tasks.recordEvent(task.id, { kind: "done", source: "worker" });

  const sessionId = "pty:late-merge";
  const lease = await h.pool.acquire(h.repo, sessionId);
  h.tasks.update(task.id, {
    sessionId,
    worktreeId: lease.id,
    branch: "perch/late-merge",
    pr: { url: "https://github.com/o/r/pull/41" }
  });

  let clock = 1_000_000;
  let phase: "ready" | "regressed" | "merged" = "ready";
  let polls = 0;
  const { pending } = autoReturn(h);
  const poller = new PrPoller(
    h.tasks,
    async () => {
      polls += 1;
      return {
        state: phase === "merged" ? "MERGED" : "OPEN",
        mergedAt: phase === "merged" ? "2026-07-22T00:00:00Z" : null,
        headRefName: "perch/late-merge",
        headRepository: { nameWithOwner: "o/r" },
        statusCheckRollup: [{ conclusion: "SUCCESS" }],
        isDraft: false,
        mergeable: phase === "regressed" ? "UNKNOWN" : "MERGEABLE",
        mergeStateStatus: phase === "regressed" ? "UNKNOWN" : "CLEAN",
        reviewDecision: "APPROVED"
      };
    },
    { now: () => clock, fastWindowMs: 60_000 }
  );

  poller.armFast(task.id);
  await poller.fastTick();
  assert.equal(h.tasks.find(task.id)?.pr?.mergeReady, true);

  clock += 60_001;
  phase = "regressed";
  await poller.fastTick();
  assert.equal(polls, 2);
  assert.equal(h.tasks.find(task.id)?.pr?.mergeReady, false);

  phase = "merged";
  await poller.fastTick();
  await Promise.all(pending);

  assert.equal(polls, 3, "the later fast tick observes the merge");
  assert.equal(h.tasks.find(task.id)?.state, "closed");
  assert.equal(h.pool.find(lease.id)?.leasedBy, undefined, "the worker slot auto-returns");
  assert.deepEqual(h.stopped, [sessionId]);

  await poller.fastTick();
  await Promise.all(pending);
  const kinds = h.tasks.events(task.id).map((event) => event.kind);
  assert.equal(kinds.filter((kind) => kind === "merged").length, 1);
  assert.equal(kinds.filter((kind) => kind === "closed").length, 1);
  assert.equal(polls, 3, "closed tasks stop fast polling");

  h.cleanup();
});

test("auto-return refuses a merged PR from another head branch", async () => {
  const h = harness();
  const task = h.tasks.create({ title: "wrong pr", project: h.repo });
  h.tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  h.tasks.recordEvent(task.id, { kind: "done", source: "worker" });

  const sessionId = "pty:wrong-pr";
  const lease = await h.pool.acquire(h.repo, sessionId);
  h.tasks.update(task.id, {
    sessionId,
    worktreeId: lease.id,
    branch: "perch/expected",
    pr: { url: "https://github.com/o/r/pull/7" }
  });

  const { pending } = autoReturn(h);
  const poller = new PrPoller(h.tasks, async () => ({
    state: "MERGED",
    mergedAt: "2026-07-05T00:00:00Z",
    headRefName: "perch/unrelated",
    headRepository: { nameWithOwner: "o/r" }
  }));

  await poller.tick();
  await Promise.all(pending);

  assert.equal(h.tasks.find(task.id)?.state, "done");
  assert.equal(h.tasks.find(task.id)?.pr?.merged, undefined);
  assert.equal(h.pool.find(lease.id)?.leasedBy, sessionId, "slot remains leased to the task");
  const kinds = h.tasks.events(task.id).map((event) => event.kind);
  assert.equal(kinds.includes("merged"), false);
  assert.equal(kinds.includes("closed"), false);

  h.cleanup();
});

// (b) The squash-merge false positive: HEAD carries a commit on no branch and
// not in the default branch (squash minted a new SHA, rebase dropped the remote
// branch). The pool's own SHA gate refuses it - but a merged PR still tears
// down.
test("auto-return: a squash-merged, diverged HEAD still tears down", async () => {
  const h = harness();
  const task = h.tasks.create({ title: "squash me", project: h.repo });
  h.tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  h.tasks.recordEvent(task.id, { kind: "done", source: "worker" });

  const sessionId = "pty:b";
  const lease = await h.pool.acquire(h.repo, sessionId);
  // Commit on the detached HEAD: reachable from no branch ref and not in the
  // default branch - exactly what squash + rebase leaves behind.
  writeFileSync(join(lease.path, "work.txt"), "landed via squash\n");
  inSlot(lease.path, ["add", "."]);
  inSlot(lease.path, ["commit", "-qm", "work"]);
  h.tasks.update(task.id, {
    sessionId,
    worktreeId: lease.id,
    pr: { url: "https://github.com/o/r/pull/2", merged: true }
  });

  // The pool's SHA-based gate false-refuses this genuinely-landed work.
  await assert.rejects(h.pool.release(lease.id), /not landed/);

  // The teardown gate trusts the merge, not the SHA.
  const merged = h.tasks.find(task.id)!;
  const verdict = await landedGate(merged, lease.path);
  assert.equal(verdict.landed, true);
  assert.match(verdict.reason, /merged/);

  await executeTeardown(merged, {
    tasks: h.tasks,
    worktrees: h.pool,
    adapter: h.adapter,
    auditLog: h.auditLog
  });

  assert.equal(h.pool.find(lease.id)?.leasedBy, undefined, "slot returned despite divergence");
  assert.ok(!existsSync(join(lease.path, "work.txt")), "slot reset to the default tip");
  assert.equal(h.tasks.find(task.id)?.state, "closed");

  h.cleanup();
});

// (c) Protection intact: uncommitted work is refused, with or without a merged
// PR, and committed-but-unlanded work with no merge is refused too.
test("gate refuses uncommitted work even when the PR is merged", async () => {
  const h = harness();
  const task = h.tasks.create({ title: "wip", project: h.repo });
  h.tasks.recordEvent(task.id, { kind: "working", source: "worker" });

  const sessionId = "pty:c";
  const lease = await h.pool.acquire(h.repo, sessionId);
  writeFileSync(join(lease.path, "scratch.txt"), "uncommitted\n");
  h.tasks.update(task.id, { sessionId, worktreeId: lease.id });

  // No merged PR: refused for uncommitted changes (unchanged behavior).
  let verdict = await landedGate(task, lease.path);
  assert.equal(verdict.landed, false);
  assert.match(verdict.reason, /uncommitted/);

  // Even a merged PR does NOT license discarding uncommitted work: dirty is
  // checked before the merge short-circuit.
  h.tasks.update(task.id, { pr: { url: "https://github.com/o/r/pull/3", merged: true } });
  verdict = await landedGate(h.tasks.find(task.id)!, lease.path);
  assert.equal(verdict.landed, false);
  assert.match(verdict.reason, /uncommitted/);

  // The slot is still held - nothing was torn down.
  assert.equal(h.pool.find(lease.id)?.leasedBy, sessionId);

  h.cleanup();
});

test("gate refuses committed-but-unlanded work with no merged PR", async () => {
  const h = harness();
  const task = h.tasks.create({ title: "local only", project: h.repo });
  h.tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  h.tasks.recordEvent(task.id, { kind: "done", source: "worker" });

  const sessionId = "pty:d";
  const lease = await h.pool.acquire(h.repo, sessionId);
  writeFileSync(join(lease.path, "work.txt"), "committed but unpushed\n");
  inSlot(lease.path, ["add", "."]);
  inSlot(lease.path, ["commit", "-qm", "unlanded"]);
  h.tasks.update(task.id, { sessionId, worktreeId: lease.id });

  const verdict = await landedGate(task, lease.path);
  assert.equal(verdict.landed, false);
  assert.match(verdict.reason, /not reachable/);
  assert.equal(h.pool.find(lease.id)?.leasedBy, sessionId, "unlanded work stays leased");

  h.cleanup();
});

test("gate fetches stale origin/main before checking landed ancestry", async () => {
  const { base, seed, clone } = makeRemoteFixture();
  const home = mkdtempSync(join(tmpdir(), "perch-td-home-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const task = tasks.create({ title: "merged upstream", project: clone });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  tasks.recordEvent(task.id, { kind: "done", source: "worker" });

  const localMain = execFileSync("git", ["-C", clone, "rev-parse", "main"]).toString().trim();
  execFileSync("git", ["-C", clone, "checkout", "-q", "--detach"], { stdio: "pipe" });
  writeFileSync(join(clone, "landed.txt"), "landed\n");
  inSlot(clone, ["add", "."]);
  inSlot(clone, ["commit", "-qm", "landed work"]);
  const landedHead = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"]).toString().trim();
  execFileSync("git", ["-C", clone, "push", "-q", "origin", "HEAD:main"], { stdio: "pipe" });
  execFileSync("git", ["-C", clone, "update-ref", "refs/remotes/origin/main", localMain], { stdio: "pipe" });

  const verdict = await landedGate(tasks.find(task.id)!, clone);

  assert.equal(verdict.landed, true);
  assert.match(verdict.reason, /origin\/main|remote branch/);
  assert.equal(
    execFileSync("git", ["-C", clone, "rev-parse", "origin/main"]).toString().trim(),
    landedHead,
    "the targeted fetch refreshes the remote-tracking ref"
  );
  assert.equal(
    execFileSync("git", ["-C", clone, "rev-parse", "main"]).toString().trim(),
    localMain,
    "the user's local default branch is untouched"
  );
  assert.equal(
    execFileSync("git", ["-C", seed, "rev-parse", "main"]).toString().trim(),
    localMain,
    "the unrelated seed checkout is untouched"
  );

  rmSync(home, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

test("gate refuses a merged PR record whose repo conflicts with the task", async () => {
  const h = harness();
  const task = h.tasks.create({ title: "bad identity", project: h.repo });
  h.tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  h.tasks.recordEvent(task.id, { kind: "done", source: "worker" });

  const sessionId = "pty:identity";
  const lease = await h.pool.acquire(h.repo, sessionId);
  h.tasks.update(task.id, {
    sessionId,
    worktreeId: lease.id,
    branch: "perch/expected",
    pr: {
      url: "https://github.com/o/other/pull/8",
      repo: "o/other",
      headRepo: "o/other",
      head: "perch/expected",
      merged: true
    }
  });

  const verdict = await landedGate(h.tasks.find(task.id)!, lease.path);
  assert.equal(verdict.landed, false);
  assert.match(verdict.reason, /identity mismatch/);
  assert.equal(h.pool.find(lease.id)?.leasedBy, sessionId, "conflicting identity cannot release the slot");

  h.cleanup();
});

// A worker briefed to reuse an existing branch/PR delivers on a head branch
// that differs from the auto-assigned task branch. The done gate accepted it by
// verifying commit ownership (not branch name), so the landed gate must trust
// the merged, same-repo PR and tear down rather than false-refuse on the branch
// difference under the branch-reuse identity rule.
test("gate lands a merged PR reused on a branch other than the task branch", async () => {
  const h = harness();
  const task = h.tasks.create({ title: "reused branch", project: h.repo });
  h.tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  h.tasks.recordEvent(task.id, { kind: "done", source: "worker" });

  const sessionId = "pty:reused";
  const lease = await h.pool.acquire(h.repo, sessionId);
  h.tasks.update(task.id, {
    sessionId,
    worktreeId: lease.id,
    branch: "perch/reused-branch",
    pr: {
      url: "https://github.com/o/r/pull/8",
      repo: "o/r",
      headRepo: "o/r",
      head: "feature/pre-existing",
      merged: true
    }
  });

  const verdict = await landedGate(h.tasks.find(task.id)!, lease.path);
  assert.equal(verdict.landed, true);
  assert.match(verdict.reason, /PR merged/);

  h.cleanup();
});

// (d) Idempotency: a concurrent auto + manual teardown tears down exactly once,
// and a later call after close is a no-op.
test("executeTeardown is idempotent and single-flight", async () => {
  const h = harness();
  const task = h.tasks.create({ title: "race", project: h.repo });
  h.tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  h.tasks.recordEvent(task.id, { kind: "done", source: "worker" });

  const sessionId = "pty:e";
  const lease = await h.pool.acquire(h.repo, sessionId);
  h.tasks.update(task.id, {
    sessionId,
    worktreeId: lease.id,
    pr: { url: "https://github.com/o/r/pull/4", merged: true }
  });

  const deps = { tasks: h.tasks, worktrees: h.pool, adapter: h.adapter, auditLog: h.auditLog };
  const current = h.tasks.find(task.id)!;
  const [a, b] = await Promise.all([
    executeTeardown(current, deps),
    executeTeardown(current, deps)
  ]);

  assert.equal(a.state === "closed" || b.state === "closed", true);
  assert.equal(h.pool.find(lease.id)?.leasedBy, undefined);
  assert.deepEqual(h.stopped, [sessionId], "session ended exactly once - the loser no-ops");
  const kinds = h.tasks.events(task.id).map((event) => event.kind);
  assert.equal(kinds.filter((k) => k === "landed").length, 1);
  assert.equal(kinds.filter((k) => k === "closed").length, 1);

  // A later teardown after close changes nothing.
  const eventsBefore = h.tasks.events(task.id).length;
  const again = await executeTeardown(h.tasks.find(task.id)!, deps);
  assert.equal(again.state, "closed");
  assert.equal(h.tasks.events(task.id).length, eventsBefore);
  assert.deepEqual(h.stopped, [sessionId]);

  h.cleanup();
});

// (e) Review-sim cleanup: teardown deletes exactly the task's
// "perch-review-<taskId>" simulator and never touches other devices - not the
// boss's own, not another task's review sim, and never the protected
// "perch-main (latest build)" device.
test("teardown deletes the task's review simulator and nothing else", async () => {
  const h = harness();
  const task = h.tasks.create({ title: "ui tweak", project: h.repo });
  h.tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  h.tasks.recordEvent(task.id, { kind: "done", source: "worker" });
  h.tasks.update(task.id, { pr: { url: "https://github.com/o/r/pull/5", merged: true } });

  const calls: string[][] = [];
  const simctl: SimctlRunner = async (args) => {
    calls.push(args);
    if (args[0] === "list") {
      return {
        stdout: JSON.stringify({
          devices: {
            "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
              { name: `perch-review-${task.id}`, udid: "AAAA-1111", state: "Booted" },
              { name: "iPhone 17 Pro", udid: "BBBB-2222", state: "Booted" },
              { name: "perch-review-other-task", udid: "CCCC-3333", state: "Shutdown" },
              { name: "perch-main (latest build)", udid: "DDDD-4444", state: "Booted" }
            ]
          }
        })
      };
    }
    return { stdout: "" };
  };

  const updated = await executeTeardown(h.tasks.find(task.id)!, {
    tasks: h.tasks,
    worktrees: h.pool,
    adapter: h.adapter,
    auditLog: h.auditLog,
    simctl
  });

  assert.equal(updated.state, "closed");
  assert.deepEqual(
    calls.filter((args) => args[0] !== "list"),
    [
      ["shutdown", "AAAA-1111"],
      ["delete", "AAAA-1111"]
    ],
    "only the task's own review sim is shut down and deleted"
  );
  assert.ok(
    !calls.some((args) => args.includes("DDDD-4444")),
    "the protected perch-main device is never touched"
  );

  h.cleanup();
});

// (f) The cleanup is best-effort: a machine with no xcrun (or any simctl
// failure) still tears the task down.
test("review-sim cleanup failure never blocks teardown", async () => {
  const h = harness();
  const task = h.tasks.create({ title: "no xcode here", project: h.repo });
  h.tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  h.tasks.recordEvent(task.id, { kind: "done", source: "worker" });
  h.tasks.update(task.id, { pr: { url: "https://github.com/o/r/pull/6", merged: true } });

  const simctl: SimctlRunner = async () => {
    throw new Error("xcrun: command not found");
  };

  const updated = await executeTeardown(h.tasks.find(task.id)!, {
    tasks: h.tasks,
    worktrees: h.pool,
    adapter: h.adapter,
    auditLog: h.auditLog,
    simctl
  });

  assert.equal(updated.state, "closed");

  h.cleanup();
});
