import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import type { WorktreeLease } from "./worktrees.js";

// Processes a worker starts inside its pooled worktree - a dev server, a
// watcher, a test harness - outlive the PTY that spawned them: ending the
// session reaps the shell, not the detached grandchild. Left alone they
// accumulate one slot's worth per torn-down task, holding memory and ports for
// weeks.
//
// Ownership is proven by the kernel, never by a process name: a process whose
// current working directory is inside a pool slot is running in that slot, and
// a slot whose lease is held (or already released) says whether that slot is
// ours to clear. Both facts are re-verified immediately before every signal, so
// a slot re-acquired mid-sweep, a recycled pid, or a process that has since
// moved elsewhere is skipped rather than signaled. Nothing outside a pool slot
// is ever a candidate - the primary server, editors, and unrelated node
// processes live outside every slot path and cannot match.

export type ProcessEntry = { pid: number; cwd: string };

export type ProcessProbe = {
  // Every readable process with its current working directory.
  snapshot(): ProcessEntry[];
  // The process's working directory right now; absent when the pid is gone.
  cwdOf(pid: number): string | undefined;
  parentOf(pid: number): number | undefined;
  alive(pid: number): boolean;
  signal(pid: number, signal: NodeJS.Signals): void;
};

export type TerminationOptions = {
  probe?: ProcessProbe;
  // A snapshot shared across several slots in one sweep; taken per call
  // otherwise.
  snapshot?: ProcessEntry[];
  // Re-asked before every signal: false aborts the rest of this slot.
  stillOwned?: () => boolean;
  gracefulWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export const DEFAULT_GRACEFUL_WAIT_MS = 5_000;

const LSOF_BASE = ["-w", "-n", "-P", "-a", "-d", "cwd"];

export const systemProcessProbe: ProcessProbe = {
  snapshot(): ProcessEntry[] {
    return parseLsof(lsof([...LSOF_BASE, "-F", "pn"]));
  },
  cwdOf(pid: number): string | undefined {
    return parseLsof(lsof([...LSOF_BASE, "-p", String(pid), "-F", "pn"])).find(
      (entry) => entry.pid === pid
    )?.cwd;
  },
  parentOf(pid: number): number | undefined {
    try {
      const output = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 2_000
      }).trim();
      const parent = Number.parseInt(output, 10);
      return Number.isInteger(parent) && parent > 0 ? parent : undefined;
    } catch {
      return undefined;
    }
  },
  alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means it exists and is not ours to signal - treat it as alive so
      // it is never mistaken for a successful termination.
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  signal(pid: number, signal: NodeJS.Signals): void {
    process.kill(pid, signal);
  }
};

// Terminate every process running inside `worktreePath`: SIGTERM first, then
// SIGKILL for whatever is still alive after the graceful window. Returns the
// pids that were signaled. A slot with nothing running in it, a path that no
// longer exists, and a process that exits on its own are all success.
export async function terminateWorktreeProcesses(
  worktreePath: string,
  options: TerminationOptions = {}
): Promise<number[]> {
  const probe = options.probe ?? systemProcessProbe;
  const roots = slotRoots(worktreePath);
  if (roots.length === 0) {
    return [];
  }
  const owned = (pid: number): boolean => {
    if (options.stillOwned && !options.stillOwned()) {
      return false;
    }
    const cwd = probe.cwdOf(pid);
    return cwd !== undefined && isInside(cwd, roots);
  };

  const protectedPids = selfAndAncestors(probe);
  const candidates = (options.snapshot ?? probe.snapshot())
    .filter((entry) => isInside(entry.cwd, roots) && !protectedPids.has(entry.pid))
    .map((entry) => entry.pid);

  const signaled: number[] = [];
  for (const pid of candidates) {
    // Ownership is re-proven against live kernel state, not the snapshot: a
    // pid recycled since the scan, or one that has moved out of the slot, is
    // no longer this worktree's process.
    if (!owned(pid) || !signalQuietly(probe, pid, "SIGTERM")) {
      continue;
    }
    signaled.push(pid);
  }
  if (signaled.length === 0) {
    return [];
  }

  const sleep = options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const deadline = Date.now() + (options.gracefulWaitMs ?? DEFAULT_GRACEFUL_WAIT_MS);
  let survivors = signaled.filter((pid) => probe.alive(pid));
  while (survivors.length > 0 && Date.now() < deadline) {
    await sleep(50);
    survivors = survivors.filter((pid) => probe.alive(pid));
  }
  for (const pid of survivors) {
    if (!owned(pid)) {
      continue;
    }
    signalQuietly(probe, pid, "SIGKILL");
  }
  return signaled;
}

export type OrphanSweepResult = { leaseId: string; path: string; pids: number[] };

// Clear processes left behind in slots that hold no lease. A leased slot is
// live work and is never touched; an unleased slot has no owner left to
// protect, so anything still running in it is by definition a leak from the
// lease that ended. Idempotent and safe beside a running server: the slot's
// lease state is re-read immediately before each signal, so a slot re-acquired
// mid-sweep drops out of the sweep instead of losing its new processes.
export async function reapOrphanWorktreeProcesses(
  pool: { list(): WorktreeLease[]; find(id: string): WorktreeLease | undefined },
  options: TerminationOptions = {}
): Promise<OrphanSweepResult[]> {
  const free = pool.list().filter((lease) => !lease.leasedBy);
  if (free.length === 0) {
    return [];
  }
  const probe = options.probe ?? systemProcessProbe;
  const snapshot = options.snapshot ?? probe.snapshot();
  const results: OrphanSweepResult[] = [];
  for (const lease of free) {
    const pids = await terminateWorktreeProcesses(lease.path, {
      ...options,
      probe,
      snapshot,
      stillOwned: () => pool.find(lease.id)?.leasedBy === undefined
    });
    if (pids.length > 0) {
      results.push({ leaseId: lease.id, path: lease.path, pids });
    }
  }
  return results;
}

// The paths that count as "inside this slot". The realpath form is what the
// kernel reports for a working directory (/private/var vs /var on macOS); the
// lexical form covers a slot whose directory is already gone. A path that
// resolves to the filesystem root or the home directory is never a slot -
// refuse it rather than match half the machine.
function slotRoots(worktreePath: string): string[] {
  const lexical = resolve(worktreePath);
  const real = (() => {
    try {
      return realpathSync(lexical);
    } catch {
      return undefined;
    }
  })();
  const rejected = new Set([sep, resolve(homedir())]);
  return [...new Set([lexical, real].filter((path): path is string => path !== undefined))].filter(
    (path) => !rejected.has(path)
  );
}

function isInside(cwd: string, roots: string[]): boolean {
  return roots.some((root) => cwd === root || cwd.startsWith(`${root}${sep}`));
}

// This server and everything that launched it are never candidates, even if
// one of them happens to run inside a slot.
function selfAndAncestors(probe: ProcessProbe): Set<number> {
  const chain = new Set<number>([process.pid]);
  let current: number | undefined = process.pid;
  for (let depth = 0; depth < 32 && current !== undefined; depth += 1) {
    current = probe.parentOf(current);
    if (current === undefined || current <= 1 || chain.has(current)) {
      break;
    }
    chain.add(current);
  }
  return chain;
}

function signalQuietly(probe: ProcessProbe, pid: number, signal: NodeJS.Signals): boolean {
  try {
    probe.signal(pid, signal);
    return true;
  } catch {
    // Already exited, or not ours to signal: nothing left to reap either way.
    return false;
  }
}

function lsof(args: string[]): string {
  try {
    return execFileSync("/usr/sbin/lsof", args, { encoding: "utf8", timeout: 15_000 });
  } catch (error) {
    // lsof exits non-zero when it finds nothing and when some processes are
    // unreadable; whatever it did print is still authoritative.
    return (error as { stdout?: string }).stdout ?? "";
  }
}

// lsof -F output is one field per line, tagged by its first character: `p` for
// the pid of the process the following lines describe, `n` for the path.
export function parseLsof(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  let pid: number | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isInteger(parsed) ? parsed : undefined;
    } else if (line.startsWith("n") && pid !== undefined) {
      entries.push({ pid, cwd: line.slice(1) });
    }
  }
  return entries;
}
