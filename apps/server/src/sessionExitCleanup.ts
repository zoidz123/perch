import type { Task } from "@perch/shared";
import type { SessionExitContext } from "./adapters/pty.js";
import type { AgentAdapter } from "./adapters/types.js";
import type { AuditLog } from "./audit.js";
import type { StateMetrics } from "./stateMetrics.js";
import { reportSessionExitToTask } from "./taskWatchdog.js";
import type { TaskStore } from "./tasks.js";
import { executeTeardown, landedGate } from "./teardown.js";
import type { WorktreeLease, WorktreePool } from "./worktrees.js";
import type { RuntimeManager } from "./runtimeManager.js";

export type SessionExitCleanupDeps = {
  tasks: TaskStore;
  worktrees: WorktreePool;
  adapter: AgentAdapter;
  auditLog: AuditLog;
  metrics?: StateMetrics;
  runtimeManager?: RuntimeManager;
};

// Natural worker exit is not a worktree teardown decision. Plain sessions keep
// the old pool cleanup path, but a task-owned lease must first pass the
// task-layer landed gate or stay leased for explicit task teardown.
export async function cleanupSessionExitWorktree(
  sessionId: string,
  exitContext: SessionExitContext = { status: "done" },
  deps: SessionExitCleanupDeps
): Promise<void> {
  const lease = deps.worktrees.findByHolder(sessionId);
  const taskBeforeExit = findTaskForSessionLease(deps.tasks, sessionId, lease);

  reportSessionExitToTask(
    deps.tasks,
    sessionId,
    exitContext,
    deps.metrics,
    (id, message, intentional) => deps.runtimeManager?.interruptSession(id, message, intentional)
  );

  if (!lease) {
    return;
  }

  const task = taskBeforeExit
    ? deps.tasks.find(taskBeforeExit.id) ?? taskBeforeExit
    : findTaskForSessionLease(deps.tasks, sessionId, lease);

  if (!task || task.state === "closed") {
    await releasePlainSessionLease(deps.worktrees, lease);
    return;
  }

  const verdict = await landedGate(task, lease.path);
  if (!verdict.landed) {
    recordWorktreeNote(deps.tasks, task.id, {
      message: `worktree retained after session exit: landed gate refused: ${verdict.reason}`,
      lease,
      exitContext
    });
    return;
  }

  recordWorktreeNote(deps.tasks, task.id, {
    message: `session-exit worktree cleanup gate passed: ${verdict.reason}`,
    lease,
    exitContext
  });
  await executeTeardown(task, {
    tasks: deps.tasks,
    worktrees: deps.worktrees,
    adapter: deps.adapter,
    auditLog: deps.auditLog,
    runtimeManager: deps.runtimeManager
  });
}

function findTaskForSessionLease(
  tasks: TaskStore,
  sessionId: string,
  lease?: WorktreeLease
): Task | undefined {
  return tasks
    .list()
    .find(
      (task) =>
        task.sessionId === sessionId &&
        (!lease || !task.worktreeId || task.worktreeId === lease.id)
    );
}

async function releasePlainSessionLease(worktrees: WorktreePool, lease: WorktreeLease): Promise<void> {
  try {
    await worktrees.release(lease.id);
  } catch (error) {
    console.warn(
      `worktree: keeping ${lease.id} leased after session end: ${
        error instanceof Error ? error.message : error
      }`
    );
  }
}

function recordWorktreeNote(
  tasks: TaskStore,
  taskId: string,
  input: { message: string; lease: WorktreeLease; exitContext: SessionExitContext }
): void {
  try {
    tasks.recordEvent(taskId, {
      kind: "note",
      source: "system",
      message: input.message,
      data: {
        worktreeId: input.lease.id,
        exit: input.exitContext.status,
        ...(input.exitContext.exitCode !== undefined ? { exitCode: input.exitContext.exitCode } : {}),
        ...(input.exitContext.tail ? { tail: input.exitContext.tail } : {})
      }
    });
  } catch {
    // Session cleanup must never fail because task evidence could not be logged.
  }
}
