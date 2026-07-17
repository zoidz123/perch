import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_MAX_SLOTS, WorktreePool } from "./worktrees.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "perch-wt-repo-"));
  const run = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "t@t"]);
  run(["config", "user.name", "t"]);
  writeFileSync(join(dir, "readme.md"), "hello\n");
  run(["add", "."]);
  run(["commit", "-qm", "init"]);
  return dir;
}

function makePool(): { pool: WorktreePool; root: string } {
  const root = mkdtempSync(join(tmpdir(), "perch-wt-pool-"));
  return { pool: new WorktreePool({ root, maxSlots: 2 }), root };
}

// A bare upstream, a seed checkout that pushes to it, and a clone that plays
// the user's local checkout (origin/HEAD set by clone). Advancing the remote
// through the seed leaves the clone stale, exactly like PRs merging on GitHub.
function makeRemoteFixture(): { base: string; upstream: string; seed: string; clone: string } {
  const base = mkdtempSync(join(tmpdir(), "perch-wt-remote-"));
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
  return { base, upstream, seed, clone };
}

// Land a new commit on the remote's main without the clone hearing about it.
function advanceRemote(seed: string, marker: string): string {
  const run = (args: string[]) => execFileSync("git", ["-C", seed, ...args], { stdio: "pipe" });
  writeFileSync(join(seed, `${marker}.txt`), `${marker}\n`);
  run(["add", "."]);
  run(["commit", "-qm", marker]);
  run(["push", "-q", "origin", "main"]);
  return revParse(seed, "HEAD");
}

function revParse(dir: string, ref: string): string {
  return execFileSync("git", ["-C", dir, "rev-parse", ref]).toString().trim();
}

test("worktree pool acquires detached slots and reuses released ones", async () => {
  const repo = makeRepo();
  const { pool, root } = makePool();

  const first = await pool.acquire(repo, "pty:a");
  assert.ok(existsSync(join(first.path, "readme.md")));
  assert.equal(first.leasedBy, "pty:a");
  // Detached HEAD, not a branch checkout.
  const head = execFileSync("git", ["-C", first.path, "rev-parse", "--abbrev-ref", "HEAD"])
    .toString()
    .trim();
  assert.equal(head, "HEAD");

  const second = await pool.acquire(repo, "pty:b");
  assert.notEqual(second.path, first.path);

  // Pool cap enforced.
  await assert.rejects(pool.acquire(repo, "pty:c"), /full/);

  // Release + reacquire reuses the slot.
  await pool.release(first.id);
  const third = await pool.acquire(repo, "pty:c");
  assert.equal(third.path, first.path);
  assert.equal(third.leasedBy, "pty:c");

  rmSync(root, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

test("default worktree pool capacity matches the supported dispatch fanout", async () => {
  const repo = makeRepo();
  const root = mkdtempSync(join(tmpdir(), "perch-wt-default-pool-"));
  const pool = new WorktreePool({ root });

  const leases = [];
  for (let i = 0; i < DEFAULT_MAX_SLOTS; i += 1) {
    leases.push(await pool.acquire(repo, `pty:${i}`));
  }

  assert.equal(leases.length, 16);
  await assert.rejects(
    pool.acquire(repo, "pty:overflow"),
    /worktree pool for .* is full \(16 slots, all leased\)/
  );

  rmSync(root, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

test("worktree release refuses dirty trees unless forced, then resets", async () => {
  const repo = makeRepo();
  const { pool, root } = makePool();

  const lease = await pool.acquire(repo, "pty:a");
  writeFileSync(join(lease.path, "scratch.txt"), "uncommitted\n");

  await assert.rejects(pool.release(lease.id), /uncommitted/);
  await pool.release(lease.id, { force: true });
  assert.ok(!existsSync(join(lease.path, "scratch.txt")), "forced release cleans the tree");
  assert.equal(pool.find(lease.id)?.leasedBy, undefined);

  rmSync(root, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

test("release refuses committed-but-unlanded detached-HEAD work unless forced", async () => {
  const repo = makeRepo();
  const { pool, root } = makePool();

  const lease = await pool.acquire(repo, "pty:a");
  // Commit on the detached HEAD: clean tree, but the commit lives on no branch
  // ref and is not in the default branch, so a plain reset would orphan it.
  const run = (args: string[]) => execFileSync("git", ["-C", lease.path, ...args], { stdio: "pipe" });
  writeFileSync(join(lease.path, "work.txt"), "committed\n");
  run(["add", "."]);
  run(["commit", "-qm", "unlanded work"]);

  await assert.rejects(pool.release(lease.id), /not landed/);
  // Lease and tree are kept: the commit survives.
  assert.equal(pool.find(lease.id)?.leasedBy, "pty:a");
  assert.ok(existsSync(join(lease.path, "work.txt")), "committed work is preserved");

  // Force discards it.
  await pool.release(lease.id, { force: true });
  assert.ok(!existsSync(join(lease.path, "work.txt")), "forced release discards the commit");
  assert.equal(pool.find(lease.id)?.leasedBy, undefined);

  rmSync(root, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

test("reaper releases only expired leases with dead holders", async () => {
  const repo = makeRepo();
  const { pool, root } = makePool();

  const dead = await pool.acquire(repo, "pty:dead");
  const alive = await pool.acquire(repo, "pty:alive");

  // Nothing reaped inside the TTL window.
  assert.deepEqual(await pool.reap(() => false, 60_000), []);

  // Expired: only the dead holder's lease goes.
  const reaped = await pool.reap((holder) => holder === "pty:alive", -1);
  assert.deepEqual(reaped, [dead.id]);
  assert.equal(pool.find(dead.id)?.leasedBy, undefined);
  assert.equal(pool.find(alive.id)?.leasedBy, "pty:alive");

  rmSync(root, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

test("acquire bases a new slot on the fetched origin tip, not the stale local ref", async () => {
  const { base, seed, clone } = makeRemoteFixture();
  const { pool, root } = makePool();

  const localTip = revParse(clone, "main");
  const remoteTip = advanceRemote(seed, "landed-on-github");

  const lease = await pool.acquire(clone, "pty:a");
  assert.equal(revParse(lease.path, "HEAD"), remoteTip, "slot starts at the remote's real tip");
  // Fetch-only contract: the user's local branch is never pulled or merged.
  assert.equal(revParse(clone, "main"), localTip, "local main is untouched");

  rmSync(root, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

test("a reused slot is re-based on the fresh origin tip at acquire", async () => {
  const { base, seed, clone } = makeRemoteFixture();
  const { pool, root } = makePool();

  const first = await pool.acquire(clone, "pty:a");
  await pool.release(first.id);

  const remoteTip = advanceRemote(seed, "merged-while-free");
  const second = await pool.acquire(clone, "pty:b");
  assert.equal(second.path, first.path, "slot is reused");
  assert.equal(revParse(second.path, "HEAD"), remoteTip, "reused slot re-detaches at the fresh tip");

  rmSync(root, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

test("acquire degrades to the last-known origin ref when the remote is unreachable", async () => {
  const { base, clone } = makeRemoteFixture();
  const { pool, root } = makePool();

  const lastKnown = revParse(clone, "origin/main");
  execFileSync("git", ["-C", clone, "remote", "set-url", "origin", join(base, "gone.git")], {
    stdio: "pipe"
  });

  const lease = await pool.acquire(clone, "pty:a");
  assert.equal(revParse(lease.path, "HEAD"), lastKnown, "offline acquire still dispatches on the last-known ref");

  rmSync(root, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

test("a repo with no remote keeps the local-tip behavior", async () => {
  const repo = makeRepo();
  const { pool, root } = makePool();

  const lease = await pool.acquire(repo, "pty:a");
  assert.equal(revParse(lease.path, "HEAD"), revParse(repo, "HEAD"));

  rmSync(root, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

test("release's landed check sees work merged upstream once fetched", async () => {
  const { base, clone } = makeRemoteFixture();
  const { pool, root } = makePool();

  const lease = await pool.acquire(clone, "pty:a");
  const staleTip = revParse(lease.path, "HEAD");

  // Commit on the detached HEAD and land it on the remote's main.
  const run = (args: string[]) => execFileSync("git", ["-C", lease.path, ...args], { stdio: "pipe" });
  writeFileSync(join(lease.path, "work.txt"), "shipped\n");
  run(["add", "."]);
  run(["commit", "-qm", "shipped work"]);
  run(["push", "-q", "origin", "HEAD:main"]);
  const landedTip = revParse(lease.path, "HEAD");
  // The push updated the clone's remote-tracking ref as a side effect; rewind
  // it so the gate can only pass by fetching the remote's real state.
  execFileSync("git", ["-C", clone, "update-ref", "refs/remotes/origin/main", staleTip], {
    stdio: "pipe"
  });

  await pool.release(lease.id);
  assert.equal(pool.find(lease.id)?.leasedBy, undefined, "merged-upstream work releases without force");
  assert.equal(revParse(lease.path, "HEAD"), landedTip, "slot resets to the fetched tip");

  rmSync(root, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

test("acquire rejects non-repos", async () => {
  const { pool, root } = makePool();
  const plain = mkdtempSync(join(tmpdir(), "perch-wt-plain-"));
  await assert.rejects(pool.acquire(plain, "pty:a"), /not a git repository/);
  rmSync(root, { recursive: true, force: true });
  rmSync(plain, { recursive: true, force: true });
});

test("listWithStatus reports lease state, dirtiness, and the checked-out branch", async () => {
  const repo = makeRepo();
  const { pool, root } = makePool();

  const leased = await pool.acquire(repo, "pty:a");
  const freed = await pool.acquire(repo, "pty:b");
  await pool.release(freed.id);

  // Dirty the leased slot and check out a branch in it.
  const run = (args: string[]) => execFileSync("git", ["-C", leased.path, ...args], { stdio: "pipe" });
  run(["checkout", "-qb", "perch/test-branch"]);
  writeFileSync(join(leased.path, "wip.txt"), "wip\n");

  const statuses = await pool.listWithStatus();
  const leasedStatus = statuses.find((status) => status.id === leased.id);
  const freeStatus = statuses.find((status) => status.id === freed.id);

  assert.equal(leasedStatus?.leasedBy, "pty:a");
  assert.equal(leasedStatus?.dirty, true);
  assert.equal(leasedStatus?.head, "perch/test-branch");
  assert.equal(freeStatus?.leasedBy, undefined);
  assert.equal(freeStatus?.dirty, false);
  assert.equal(freeStatus?.head, undefined, "a reset slot is detached");

  rmSync(root, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});
