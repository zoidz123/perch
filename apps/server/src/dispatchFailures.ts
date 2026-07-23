import type { Task } from "@perch/shared";
import type { OperationRecord } from "./stateDb.js";
import type { TaskStore } from "./tasks.js";
import type { WorktreePool } from "./worktrees.js";

type DispatchFailureDeps = {
  tasks: TaskStore;
  worktrees: WorktreePool;
};

export function isVerifiedPrelaunchDispatchFailure(
  task: Task,
  deps: DispatchFailureDeps
): boolean {
  if (task.state !== "failed" || task.sessionId || task.worktreeId || task.runtime) return false;
  if (deps.tasks.stateDb.runtimes.latestForTask(task.id)) return false;
  if (deps.worktrees.findByHolder(task.id)) return false;

  const dispatch = deps.tasks.stateDb.operations.latestForTask(task.id, "dispatch");
  return dispatch?.state === "failed" && dispatch.payload?.launchStarted !== true;
}

export function closeVerifiedPrelaunchDispatchFailure(
  task: Task,
  deps: DispatchFailureDeps
): boolean {
  if (!isVerifiedPrelaunchDispatchFailure(task, deps)) return false;
  deps.tasks.recordEvent(task.id, {
    kind: "closed",
    source: "system",
    message: "auto-closed verified pre-launch dispatch failure",
    data: { reason: "prelaunch_dispatch_failure" }
  });
  return true;
}

export async function handleDispatchOperationFailure(
  operation: OperationRecord,
  error: unknown,
  deps: DispatchFailureDeps
): Promise<void> {
  if (operation.kind !== "dispatch") return;
  const task = deps.tasks.find(operation.taskId);
  if (!task) return;

  if (operation.payload?.launchStarted !== true) {
    const lease = deps.worktrees.findByHolder(task.id);
    if (lease) await deps.worktrees.release(lease.id, { force: true }).catch(() => {});
  }

  const beforeFailure = deps.tasks.find(task.id);
  if (beforeFailure && beforeFailure.state !== "failed" && beforeFailure.state !== "closed") {
    deps.tasks.recordEvent(task.id, {
      kind: "failed",
      source: "system",
      message: `dispatch failed: ${error instanceof Error ? error.message : String(error)}`
    });
  }

  const current = deps.tasks.find(task.id);
  if (current) closeVerifiedPrelaunchDispatchFailure(current, deps);
}

export function repairVerifiedPrelaunchDispatchFailures(deps: DispatchFailureDeps): number {
  let repaired = 0;
  for (const task of deps.tasks.list()) {
    if (closeVerifiedPrelaunchDispatchFailure(task, deps)) repaired += 1;
  }
  return repaired;
}
