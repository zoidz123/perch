import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Task } from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import type { AuditLog } from "./audit.js";
import { validateRecordedTaskPrIdentity } from "./prPoller.js";
import type { TaskStore } from "./tasks.js";
import {
  fetchDefaultBranch,
  type DefaultBranchResolution,
  type WorktreeLease,
  type WorktreePool
} from "./worktrees.js";
import type { RuntimeManager } from "./runtimeManager.js";

const execFileAsync = promisify(execFile);

// Landed gate: a task's workspace may be torn
// down only when its work is provably safe to lose. Committed-but-unlanded
// work refuses teardown without force - discarding it is a human decision.

export type LandedVerdict = {
  landed: boolean;
  reason: string;
  defaultBranch?: DefaultBranchResolution;
};

export async function landedGate(task: Task, worktreePath?: string): Promise<LandedVerdict> {
  // Scouts produce reports, not code: reaching done IS landing.
  if (task.kind === "scout") {
    return task.state === "done" || task.state === "landed" || task.state === "closed"
      ? { landed: true, reason: "scout task reported done" }
      : { landed: false, reason: `scout task has not reported done (state: ${task.state})` };
  }

  // local-only ships nothing: done means committed locally, which is the
  // definition of done the mode promised - but the commits live only in the
  // worktree, so teardown would destroy them. Refuse unless the branch is
  // reachable somewhere outside the slot.
  const path = worktreePath;
  if (!path) {
    // No worktree to lose (in-place task): nothing the gate protects.
    return { landed: true, reason: "no pooled worktree attached" };
  }

  try {
    // Dirty tree: never safe - not even for a merged PR. Uncommitted changes
    // are always the human's to keep or discard.
    const { stdout: status } = await git(path, ["status", "--porcelain"]);
    if (status.trim().length > 0) {
      return { landed: false, reason: "worktree has uncommitted changes" };
    }
    // A merged PR is authoritative proof the work landed - trust the merge, not
    // the SHA. This repo squash-merges and rebases/force-pushes branches, so
    // after a merge the worktree HEAD is reachable from NEITHER the default
    // branch (squash minted a new SHA) NOR the remote branch (rebased away).
    // The SHA-reachability checks below would then false-refuse work that truly
    // landed; the merge flag short-circuits them (dirty is still refused above).
    if (task.pr?.merged) {
      const identity = await validateRecordedTaskPrIdentity(task);
      if (!identity.ok) {
        return { landed: false, reason: `PR identity mismatch: ${identity.reason}` };
      }
      return { landed: true, reason: `PR merged: ${task.pr.url}` };
    }
    // Refresh only origin/<default> before ancestry checks. This shares the
    // pool release path's fetch-only behavior: local branches are untouched,
    // and an unavailable remote degrades to the last-known tracking ref.
    const defaultBranch = await fetchDefaultBranch(path);
    // HEAD reachable from any remote ref: pushed, safe.
    const { stdout: remotes } = await git(path, ["branch", "-r", "--contains", "HEAD"]);
    if (remotes.trim().length > 0) {
      return {
        landed: true,
        reason: "HEAD is reachable from a remote branch",
        defaultBranch
      };
    }
    // HEAD an ancestor of the default branch: landed locally. origin/HEAD
    // when a remote exists, the project root's HEAD otherwise (plain local
    // repos are first-class, matching the pool's own base rule).
    const base = defaultBranch.base ?? (await defaultRef(path)) ?? (await headCommit(task.project));
    if (base) {
      try {
        await git(path, ["merge-base", "--is-ancestor", "HEAD", base]);
        return { landed: true, reason: `HEAD is contained in ${base}`, defaultBranch };
      } catch {
        // Not an ancestor; fall through.
      }
    }
    return { landed: false, reason: "HEAD has commits not reachable from any remote or the default branch" };
  } catch (error) {
    return {
      landed: false,
      reason: `could not verify: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

export type TeardownDeps = {
  tasks: TaskStore;
  worktrees: WorktreePool;
  adapter: AgentAdapter;
  auditLog: AuditLog;
  simctl?: SimctlRunner;
  runtimeManager?: RuntimeManager;
};

export type SimctlRunner = (args: string[]) => Promise<{ stdout: string }>;

const defaultSimctl: SimctlRunner = (args) =>
  execFileAsync("xcrun", ["simctl", ...args], { timeout: 60_000 });

// The review simulator helper gives a task its own isolated simulator
// named "perch-review-<taskId>"; teardown deletes it so torn-down tasks never
// leave zombie simulators. Inlined simctl rather than the script because the
// worktree holding the script may already be released. Best-effort by
// contract: absent xcrun (non-mac), absent device, or any simctl failure is
// swallowed by the caller - this must never gate a teardown. Deletion is by
// exact "perch-review-<taskId>" name, so the boss's own devices and the
// protected "perch-main (latest build)" device can never match.
export async function deleteReviewSimulator(
  taskId: string,
  simctl: SimctlRunner = defaultSimctl
): Promise<void> {
  const name = `perch-review-${taskId}`;
  const { stdout } = await simctl(["list", "-j", "devices"]);
  const parsed = JSON.parse(stdout) as {
    devices?: Record<string, { name?: string; udid?: string }[]>;
  };
  for (const list of Object.values(parsed.devices ?? {})) {
    for (const device of list) {
      if (device.name !== name || !device.udid) {
        continue;
      }
      await simctl(["shutdown", device.udid]).catch(() => {});
      await simctl(["delete", device.udid]);
    }
  }
}

// Single-flight guard: an auto-return (poller merged-event) and a manual
// POST /tasks/:id/teardown can fire for the same task at the same instant.
// Whichever enters first owns the teardown; the other no-ops.
const inFlight = new Set<string>();

// A teardown stops the worker session itself; the session-exit path checks
// this so an intentional teardown never doubles as a "worker died" alarm.
export function isTeardownInFlight(taskId: string): boolean {
  return inFlight.has(taskId);
}

// Execute the teardown steps once the decision is made (the gate passed, or
// force): end the worker session, return the pooled worktree, close the ledger
// entry. Idempotent - a task already closed, or already being torn down by a
// concurrent caller, returns unchanged without racing the release or
// double-recording ledger events. The gate lives at the caller; this only
// performs a teardown that has already been authorized.
export async function executeTeardown(
  task: Task,
  deps: TeardownDeps,
  opts: {
    force?: boolean;
    remoteAddress?: string;
    defaultBranch?: DefaultBranchResolution;
  } = {}
): Promise<Task> {
  const current = deps.tasks.find(task.id) ?? task;
  if (current.state === "closed" || inFlight.has(task.id)) {
    return current;
  }
  inFlight.add(task.id);
  try {
    deps.runtimeManager?.endTaskRuntime(task.id);
    if (current.sessionId && deps.adapter.stopSession) {
      await deps.adapter.stopSession(current.sessionId).catch(() => {});
    }
    await deleteReviewSimulator(current.id, deps.simctl).catch(() => {});
    const lease = ownLeaseFor(current, deps.worktrees);
    if (lease) {
      // Force past the pool's own release gate: it is SHA-reachability based and
      // would re-trigger the squash-merge false positive on a merged, diverged
      // HEAD. The task-layer gate (or force) already authorized this teardown
      // and is the stronger, PR-aware authority.
      await deps.worktrees.release(lease.id, {
        force: true,
        ...(opts.defaultBranch ? { defaultBranch: opts.defaultBranch } : {})
      }).catch(() => {});
      // Clean up the local task branch; leave the remote branch alone (its
      // lifecycle is GitHub's - delete-on-merge is a repo setting, not ours).
      if (current.branch) {
        await deleteLocalBranch(lease.repoRoot, current.branch);
      }
    }

    // Close the ledger through legal transitions: a task torn down before it
    // ever reported done did fail its brief, and the log says so.
    let updated = deps.tasks.find(task.id)!;
    if (
      updated.state === "queued" ||
      updated.state === "working" ||
      updated.state === "needs_you" ||
      updated.state === "blocked" ||
      updated.state === "completion_requested"
    ) {
      updated = deps.tasks.recordEvent(task.id, {
        kind: "failed",
        source: "system",
        message: "torn down before done"
      });
    }
    if (updated.state === "done") {
      updated = deps.tasks.recordEvent(task.id, {
        kind: "landed",
        source: "system",
        message: "teardown gate passed"
      });
    }
    updated = deps.tasks.recordEvent(task.id, { kind: "closed", source: "system" });

    await deps.auditLog.write({
      action: "stop_session",
      sessionId: current.sessionId ?? "none",
      remoteAddress: opts.remoteAddress,
      taskId: task.id,
      forced: opts.force === true
    });
    return updated;
  } finally {
    inFlight.delete(task.id);
  }
}

// The slot is only "ours" while its lease still points at this task's session
// (or the task itself, pre-spawn). A released slot may already be re-acquired
// by someone else - never gate on or release that.
export function ownLeaseFor(task: Task, worktrees: WorktreePool): WorktreeLease | undefined {
  if (!task.worktreeId) {
    return undefined;
  }
  const lease = worktrees.find(task.worktreeId);
  return lease && (lease.leasedBy === task.sessionId || lease.leasedBy === task.id)
    ? lease
    : undefined;
}

async function deleteLocalBranch(repoRoot: string, branch: string): Promise<void> {
  try {
    await git(repoRoot, ["branch", "-D", branch]);
  } catch {
    // Already gone, never created, or still checked out elsewhere: branch
    // cleanup is best-effort, never a gate.
  }
}

async function defaultRef(path: string): Promise<string | undefined> {
  try {
    const { stdout } = await git(path, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function headCommit(repoRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await git(repoRoot, ["rev-parse", "HEAD"]);
    return stdout.trim();
  } catch {
    return undefined;
  }
}

function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", ["-C", cwd, ...args], { timeout: 15_000 });
}
