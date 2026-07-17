import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Native worktree pool: numbered detached-HEAD slots per repository, acquired
// with a durable lease and returned with a reset. The lifecycle is
// treehouse's get/return (the lease flavor - the holder is a task/session
// record, not a subshell), with the gap it left open closed here: leases
// carry a TTL and are reaped against PTY-session liveness, which this server
// knows authoritatively instead of inferring from process working
// directories.
//
// Release safety rule (the line between cleanup and data loss): a dirty tree
// is never reset without force=true; landed-ness of committed work is the
// task layer's concern (M1), not the pool's.

export const DEFAULT_MAX_SLOTS = 16;
export const LEASE_TTL_MS = 15 * 60_000;

export type WorktreeLease = {
  id: string;
  repoRoot: string;
  slot: string;
  path: string;
  branch?: string;
  createdAt: string;
  leasedBy?: string;
  leasedAt?: string;
};

// A lease enriched with best-effort live git state (GET /worktrees): absent
// fields mean the tree is missing or git failed, never "clean".
export type WorktreeStatus = WorktreeLease & {
  dirty?: boolean;
  // Committed work not landed on any branch or the default branch (the same
  // notion release guards against discarding).
  unlanded?: boolean;
  // The branch checked out in the tree right now; absent when detached.
  head?: string;
};

type PoolState = {
  slots: WorktreeLease[];
};

export type WorktreePoolOptions = {
  root?: string;
  maxSlots?: number;
  env?: NodeJS.ProcessEnv;
};

export class WorktreePool {
  private readonly root: string;
  private readonly maxSlots: number;
  // Per-pool mutation lock: acquire/release/assign each do a
  // load-mutate-persist of state.json, so concurrent calls for the same repo
  // must serialize or they double-lease a slot / collide on `worktree add` /
  // clobber each other's persist. Read-only paths (list/find) stay lock-free.
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: WorktreePoolOptions = {}) {
    const env = options.env ?? process.env;
    this.root = options.root ?? join(env.PERCH_HOME ?? join(homedir(), ".perch"), "worktrees");
    this.maxSlots = options.maxSlots ?? DEFAULT_MAX_SLOTS;
  }

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Tail swallows outcome so one failure never breaks the chain for the next.
    this.locks.set(key, next.then(() => undefined, () => undefined));
    return next;
  }

  private poolKey(repo: string): string {
    return `${basename(repo)}-${createHash("sha256").update(repo).digest("hex").slice(0, 6)}`;
  }

  private lockKeyForId(id: string): string {
    const body = id.startsWith("wt:") ? id.slice(3) : id;
    const slash = body.lastIndexOf("/");
    return slash >= 0 ? body.slice(0, slash) : body;
  }

  // Acquire a slot in the pool for `repoRoot`, leased to `holder` (a session
  // or task id). Reuses a free slot when one exists (re-based on the freshly
  // fetched default tip), otherwise grows the pool up to maxSlots.
  async acquire(repoRoot: string, holder: string): Promise<WorktreeLease> {
    const repo = resolve(repoRoot);
    await assertGitRepo(repo);

    return this.withLock(this.poolKey(repo), async () => {
      const poolDir = this.poolDir(repo);
      const state = this.load(poolDir);

      let lease = state.slots.find((slot) => !slot.leasedBy);
      if (!lease) {
        if (state.slots.length >= this.maxSlots) {
          throw new Error(
            `worktree pool for ${basename(repo)} is full (${this.maxSlots} slots, all leased)`
          );
        }
        lease = await this.createSlot(repo, poolDir, state);
      } else if (existsSync(lease.path)) {
        // A freed slot sits at whatever the default tip was when it was
        // released; re-detach it on the freshly fetched tip so a lease never
        // starts on a stale base.
        await fetchDefaultBranch(repo);
        await resetToDefault(repo, lease.path);
      }

      lease.leasedBy = holder;
      lease.leasedAt = new Date().toISOString();
      this.persist(poolDir, state);
      return { ...lease };
    });
  }

  // Return a slot to the pool. Without force this is the pool-level landed
  // gate: it refuses dirty trees AND trees whose HEAD holds commits that are
  // not contained in the default branch and not reachable from any branch ref
  // (mirroring teardown's landedGate, so plain session-exit release never
  // orphans committed-but-unlanded work). A clean+landed (or forced) return
  // resets to the repository's default branch tip and clears the lease.
  async release(id: string, options: { force?: boolean } = {}): Promise<void> {
    return this.withLock(this.lockKeyForId(id), async () => {
      const located = this.locate(id);
      if (!located) {
        throw new Error(`Unknown worktree: ${id}`);
      }
      const { poolDir, state, lease } = located;

      if (existsSync(lease.path)) {
        // Refresh origin/<default> before judging landed-ness: work merged on
        // GitHub counts as landed only once the remote-tracking ref knows it.
        await fetchDefaultBranch(lease.repoRoot);
        if (!options.force) {
          if (await isDirty(lease.path)) {
            throw new Error(
              `Worktree ${id} has uncommitted changes; pass force to discard them`
            );
          }
          if (await hasUnlandedCommits(lease.repoRoot, lease.path)) {
            throw new Error(
              `Worktree ${id} has committed work not landed on any branch or the default branch; pass force to discard it`
            );
          }
        }
        await resetToDefault(lease.repoRoot, lease.path);
      }

      lease.leasedBy = undefined;
      lease.leasedAt = undefined;
      this.persist(poolDir, state);
    });
  }

  // Force-release leases whose holder is gone: the holder-liveness check is
  // supplied by the caller (PTY session liveness), and the TTL guards the
  // window where a holder died before ever being observed.
  async reap(isHolderAlive: (holder: string) => boolean, ttlMs = LEASE_TTL_MS): Promise<string[]> {
    const reaped: string[] = [];
    for (const lease of this.list()) {
      if (!lease.leasedBy || !lease.leasedAt) {
        continue;
      }
      const age = Date.now() - Date.parse(lease.leasedAt);
      if (age > ttlMs && !isHolderAlive(lease.leasedBy)) {
        try {
          // Never force: a dirty tree with a dead holder stays leased (and
          // visible) rather than silently losing work - discarding unlanded
          // changes is a human (or task-layer) decision.
          await this.release(lease.id);
          reaped.push(lease.id);
        } catch {
          // Dirty or broken slot: skip; next reap retries.
        }
      }
    }
    return reaped;
  }

  list(): WorktreeLease[] {
    const leases: WorktreeLease[] = [];
    if (!existsSync(this.root)) {
      return leases;
    }
    for (const entry of readDirNames(this.root)) {
      const poolDir = join(this.root, entry);
      const statePath = join(poolDir, "state.json");
      if (!existsSync(statePath)) {
        continue;
      }
      leases.push(...this.load(poolDir).slots.map((slot) => ({ ...slot })));
    }
    return leases;
  }

  // list() plus live git state per slot, for the CLI's `perch worktrees`
  // table. Read-only and best-effort: a broken slot still lists, just without
  // status fields.
  async listWithStatus(): Promise<WorktreeStatus[]> {
    return Promise.all(
      this.list().map(async (lease): Promise<WorktreeStatus> => {
        if (!existsSync(lease.path)) {
          return lease;
        }
        try {
          const [dirty, unlanded, head] = await Promise.all([
            isDirty(lease.path),
            hasUnlandedCommits(lease.repoRoot, lease.path),
            currentBranch(lease.path)
          ]);
          return { ...lease, dirty, unlanded, ...(head ? { head } : {}) };
        } catch {
          return lease;
        }
      })
    );
  }

  // Re-point a lease at its final holder (acquire happens before the session
  // id exists; assign binds them right after spawn). Serialized against the
  // same per-pool lock so it never clobbers a concurrent acquire's persist.
  assign(id: string, holder: string): Promise<void> {
    return this.withLock(this.lockKeyForId(id), async () => {
      const located = this.locate(id);
      if (!located) {
        return;
      }
      located.lease.leasedBy = holder;
      located.lease.leasedAt = new Date().toISOString();
      this.persist(located.poolDir, located.state);
    });
  }

  // The lease held by a given holder (session/task id), if any.
  findByHolder(holder: string): WorktreeLease | undefined {
    return this.list().find((lease) => lease.leasedBy === holder);
  }

  find(id: string): WorktreeLease | undefined {
    const located = this.locate(id);
    return located ? { ...located.lease } : undefined;
  }

  private locate(id: string): { poolDir: string; state: PoolState; lease: WorktreeLease } | undefined {
    if (!existsSync(this.root)) {
      return undefined;
    }
    for (const entry of readDirNames(this.root)) {
      const poolDir = join(this.root, entry);
      const statePath = join(poolDir, "state.json");
      if (!existsSync(statePath)) {
        continue;
      }
      const state = this.load(poolDir);
      const lease = state.slots.find((slot) => slot.id === id);
      if (lease) {
        return { poolDir, state, lease };
      }
    }
    return undefined;
  }

  private async createSlot(repo: string, poolDir: string, state: PoolState): Promise<WorktreeLease> {
    const slot = String(nextSlotNumber(state));
    const path = join(poolDir, slot, basename(repo));
    mkdirSync(join(poolDir, slot), { recursive: true });

    await fetchDefaultBranch(repo);
    const base = await defaultBranchCommit(repo);
    await git(repo, ["worktree", "add", "--detach", path, base]);

    const lease: WorktreeLease = {
      id: `wt:${basename(poolDir)}/${slot}`,
      repoRoot: repo,
      slot,
      path,
      createdAt: new Date().toISOString()
    };
    state.slots.push(lease);
    return lease;
  }

  private poolDir(repo: string): string {
    const dir = join(this.root, this.poolKey(repo));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private load(poolDir: string): PoolState {
    try {
      const parsed = JSON.parse(readFileSync(join(poolDir, "state.json"), "utf8")) as PoolState;
      return { slots: Array.isArray(parsed.slots) ? parsed.slots : [] };
    } catch {
      return { slots: [] };
    }
  }

  private persist(poolDir: string, state: PoolState): void {
    const path = join(poolDir, "state.json");
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, path);
  }
}

async function assertGitRepo(repo: string): Promise<void> {
  try {
    await git(repo, ["rev-parse", "--git-dir"]);
  } catch {
    throw new Error(`${repo} is not a git repository`);
  }
}

async function isDirty(worktree: string): Promise<boolean> {
  const { stdout } = await git(worktree, ["status", "--porcelain"]);
  return stdout.trim().length > 0;
}

// True when resetting this slot would orphan committed work: HEAD carries
// commits that live on no branch ref (local or remote) and are not contained
// in the repository's default branch. A fresh detached slot (HEAD == base
// tip) is contained in the default branch, so it reports false.
async function hasUnlandedCommits(repo: string, worktree: string): Promise<boolean> {
  const { stdout: branches } = await git(worktree, ["branch", "-a", "--contains", "HEAD"]);
  // Each line is `  name` / `* name`; a detached HEAD lists a parenthesized
  // marker ("* (no branch)") that is not a real ref - ignore those.
  const onRealBranch = branches
    .split("\n")
    .map((line) => line.replace(/^[*+]?\s*/, "").trim())
    .some((name) => name.length > 0 && !name.startsWith("("));
  if (onRealBranch) {
    return false;
  }
  const base = await defaultBranchCommit(repo);
  try {
    await git(worktree, ["merge-base", "--is-ancestor", "HEAD", base]);
    return false;
  } catch {
    return true;
  }
}

async function currentBranch(worktree: string): Promise<string | undefined> {
  const { stdout } = await git(worktree, ["branch", "--show-current"]);
  const name = stdout.trim();
  return name.length > 0 ? name : undefined;
}

// Reset a slot for reuse: discard everything, then re-detach at the current
// default-branch tip so the next acquire starts fresh. Callers that want the
// remote's real tip fetch first (fetchDefaultBranch); this only reads refs.
async function resetToDefault(repo: string, worktree: string): Promise<void> {
  await git(worktree, ["reset", "--hard"]);
  await git(worktree, ["clean", "-fd"]);
  const base = await defaultBranchCommit(repo);
  await git(worktree, ["checkout", "--detach", base]);
}

// origin/HEAD when a remote exists, the local HEAD otherwise (plain local
// repos are first-class: tests, scratch projects).
async function defaultBranchCommit(repo: string): Promise<string> {
  const name = await defaultBranchName(repo);
  if (name) {
    return `origin/${name}`;
  }
  const { stdout } = await git(repo, ["rev-parse", "HEAD"]);
  return stdout.trim();
}

// The default branch's short name ("main") resolved from origin/HEAD, or
// undefined when the repo has no remote (or no origin/HEAD ref).
async function defaultBranchName(repo: string): Promise<string | undefined> {
  try {
    const { stdout } = await git(repo, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
    const ref = stdout.trim();
    return ref.startsWith("origin/") ? ref.slice("origin/".length) : undefined;
  } catch {
    return undefined;
  }
}

// Refresh origin/<default> before basing a slot on it: PRs merge on GitHub,
// so the source checkout's remote-tracking ref is routinely stale. Single-ref
// fetch into the remote-tracking namespace only - the user's local branches
// are never touched. Offline or a failed fetch degrades to the last-known
// ref with a one-line warning; a network hiccup must never block dispatch.
// No-remote repos skip entirely (local-tip behavior unchanged).
async function fetchDefaultBranch(repo: string): Promise<void> {
  const name = await defaultBranchName(repo);
  if (!name) {
    return;
  }
  try {
    await git(repo, [
      "fetch",
      "--no-tags",
      "origin",
      `+refs/heads/${name}:refs/remotes/origin/${name}`
    ]);
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).split("\n")[0];
    console.warn(`worktree: fetch origin/${name} failed for ${basename(repo)}; using last-known ref (${detail})`);
  }
}

function nextSlotNumber(state: PoolState): number {
  const used = new Set(state.slots.map((slot) => Number(slot.slot)));
  let candidate = 1;
  while (used.has(candidate)) {
    candidate += 1;
  }
  return candidate;
}

function readDirNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", ["-C", cwd, ...args], { timeout: 15_000 });
}
