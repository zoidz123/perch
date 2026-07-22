import { randomUUID } from "node:crypto";
import type { AgentKind, RuntimeSnapshot, StartAgentRequest, Task, TaskState } from "@perch/shared";
import type { RuntimeRecord, RuntimeState } from "./stateDb.js";
import type { TaskStore } from "./tasks.js";
import type { WorktreeLease } from "./worktrees.js";

const INTERRUPTIBLE_TASK_STATES = new Set<TaskState>([
  "queued",
  "working",
  "needs_you",
  "blocked",
  "completion_requested"
]);
const TERMINAL_TASK_STATES = new Set<TaskState>(["done", "landed", "failed", "closed"]);
export const RECOVERY_CONTINUATION_TEXT =
  "Perch restored this exact conversation after the worker runtime was interrupted. Continue the task from the existing conversation and worktree state. Do not repeat completed work or replay the original kickoff prompt. Report the next accurate task outcome through the task event endpoint when appropriate.";

export type RuntimeProcessOwnership = {
  processId: number;
  processStartedAt: string;
};

export class RuntimeManager {
  readonly instanceId = `server:${randomUUID()}`;

  constructor(private readonly tasks: TaskStore) {
    // A task that reaches a terminal state without teardown (PR-verified
    // completion after a crash, dispatch failure) must not leave a runtime
    // parked recoverable/recovering forever.
    tasks.subscribe((task) => {
      if (TERMINAL_TASK_STATES.has(task.state)) {
        this.endParkedRuntime(task.id);
      }
    });
  }

  beginLaunch(task: Task, request: StartAgentRequest, lease?: WorktreeLease): RuntimeRecord {
    const latest = this.tasks.stateDb.runtimes.latestForTask(task.id);
    if (latest && latest.state !== "ended") {
      throw new Error(`task ${task.id} already owns runtime generation ${latest.generation} (${latest.state})`);
    }
    const generation = (latest?.generation ?? -1) + 1;
    const parentSessionId = task.parentSessionId ?? request.labels?.parent;
    const parentOwnerId = parentSessionId && this.tasks.stateDb.ownerRuntimes.findBySession(parentSessionId)?.ownerId;
    return this.tasks.stateDb.runtimes.create({
      taskId: task.id,
      generation,
      state: "starting",
      agent: request.agent ?? providerForCommand(request.command),
      provider: providerForCommand(request.command, request.agent),
      ...(task.workerName ? { workerName: task.workerName } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(parentOwnerId === "owner:mate" ? { parentOwnerId } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.sessionId ? { ptySessionId: request.sessionId } : {}),
      ...(lease
        ? { worktreeId: lease.id, leaseId: lease.id, worktreePath: lease.path }
        : task.worktreeId
          ? { worktreeId: task.worktreeId, leaseId: task.worktreeId }
          : {}),
      ownerInstanceId: this.instanceId,
      metadata: { source: "managed-launch" }
    });
  }

  markLive(
    runtime: RuntimeRecord,
    sessionId: string,
    ownership?: RuntimeProcessOwnership,
    patch: {
      model?: string;
      worktreeId?: string;
      worktreePath?: string;
      leaseId?: string;
      // Driver facts recorded at launch (codexDriver, appServerSocketPath):
      // a session never changes ownership mid-life, and recovery reads these
      // to rebind to the same daemon socket.
      metadata?: Record<string, unknown>;
    } = {}
  ): RuntimeRecord {
    const live = this.tasks.stateDb.runtimes.compareAndSwap(
      runtime.taskId,
      runtime.generation,
      "starting",
      "live",
      {
        ptySessionId: sessionId,
        ownerInstanceId: this.instanceId,
        ...(ownership ? ownership : {}),
        ...patch
      }
    );
    if (!live) throw new Error(`runtime generation conflict for ${runtime.taskId} g${runtime.generation}`);
    return live;
  }

  markLaunchFailed(runtime: RuntimeRecord): void {
    this.tasks.stateDb.runtimes.compareAndSwap(
      runtime.taskId,
      runtime.generation,
      ["starting", "live"],
      "ended"
    );
  }

  recordProviderSession(sessionId: string, provider: string, providerSessionId: string): RuntimeRecord | undefined {
    if (!providerSessionId.trim()) return undefined;
    const runtime = this.tasks.stateDb.runtimes.findBySession(sessionId);
    if (!runtime || (runtime.state !== "starting" && runtime.state !== "live")) return runtime;
    if (runtime.agent !== provider) return undefined;
    return this.tasks.stateDb.runtimes.compareAndSwap(
      runtime.taskId,
      runtime.generation,
      runtime.state,
      runtime.state,
      { provider, providerSessionId }
    );
  }

  // Returns the updated record only when this call transitioned the runtime;
  // undefined when it was already settled or the CAS lost. A "recovering"
  // runtime is excluded: its ptySessionId still names the dead pre-recovery
  // PTY, so old-session death evidence must not revoke the held recovery
  // claim - bind, failRecovery, or the startup reconcile own that lifecycle.
  interruptSession(
    sessionId: string,
    message = "worker runtime interrupted",
    intentional = false
  ): RuntimeRecord | undefined {
    const runtime = this.tasks.stateDb.runtimes.findBySession(sessionId);
    if (!runtime || (runtime.state !== "starting" && runtime.state !== "live")) return undefined;
    const task = this.tasks.find(runtime.taskId);
    const next: RuntimeState =
      task && INTERRUPTIBLE_TASK_STATES.has(task.state) && !intentional
        ? "recoverable"
        : "ended";
    const updated = this.tasks.stateDb.runtimes.compareAndSwap(
      runtime.taskId,
      runtime.generation,
      ["starting", "live"],
      next,
      task && next === "recoverable"
        ? { metadata: interruptionMetadata(runtime, task.state) }
        : {}
    );
    if (updated && next === "recoverable" && task) {
      this.recordInterruption(task, updated, message);
    }
    return updated;
  }

  endTaskRuntime(taskId: string): RuntimeRecord | undefined {
    const runtime = this.tasks.stateDb.runtimes.latestForTask(taskId);
    if (!runtime || runtime.state === "ended") return runtime;
    return this.tasks.stateDb.runtimes.compareAndSwap(
      taskId,
      runtime.generation,
      ["starting", "live", "recoverable", "recovering"],
      "ended"
    );
  }

  claimRecovery(taskId: string, generation: number): RuntimeRecord | undefined {
    return this.tasks.stateDb.runtimes.compareAndSwap(taskId, generation, "recoverable", "recovering", {
      ownerInstanceId: this.instanceId
    });
  }

  bindRecoveredRuntime(
    recovering: RuntimeRecord,
    input: {
      sessionId: string;
      provider: string;
      providerSessionId: string;
      ownership?: RuntimeProcessOwnership;
    }
  ): RuntimeRecord {
    if (
      recovering.state !== "recovering" ||
      !isTrustedProviderIdentity(input.provider, input.providerSessionId) ||
      recovering.provider !== input.provider ||
      recovering.providerSessionId !== input.providerSessionId
    ) {
      throw new Error(`provider identity mismatch for ${recovering.taskId} g${recovering.generation}`);
    }
    const live = this.tasks.stateDb.transaction(() => {
      const next = this.tasks.stateDb.runtimes.replaceRecoveringGeneration(recovering, {
        state: "live",
        agent: recovering.agent,
        provider: recovering.provider,
        providerSessionId: recovering.providerSessionId,
        ptySessionId: input.sessionId,
        ...(input.ownership ?? {}),
        ...(recovering.worktreeId ? { worktreeId: recovering.worktreeId } : {}),
        ...(recovering.worktreePath ? { worktreePath: recovering.worktreePath } : {}),
        ...(recovering.leaseId ? { leaseId: recovering.leaseId } : {}),
        ...(recovering.parentSessionId ? { parentSessionId: recovering.parentSessionId } : {}),
        ...(recovering.parentOwnerId ? { parentOwnerId: recovering.parentOwnerId } : {}),
        ...(recovering.workerName ? { workerName: recovering.workerName } : {}),
        ownerInstanceId: this.instanceId,
        ...(recovering.model ? { model: recovering.model } : {}),
        metadata: {
          source: "provider-recovery",
          previousRuntimeId: recovering.id,
          previousGeneration: recovering.generation
        }
      });
      if (!next) return undefined;
      this.tasks.update(recovering.taskId, { sessionId: input.sessionId });
      const task = this.tasks.find(recovering.taskId);
      if (recovering.metadata?.interruptedTaskState === "working" && task?.state === "working") {
        this.tasks.stateDb.operations.create({
          taskId: recovering.taskId,
          kind: "continuation",
          idempotencyKey: `continuation:${recovering.taskId}:g${next.generation}`,
          payload: {
            generation: next.generation,
            sessionId: input.sessionId,
            text: RECOVERY_CONTINUATION_TEXT
          }
        });
      }
      return next;
    });
    if (!live) {
      throw new Error(`runtime generation conflict for ${recovering.taskId} g${recovering.generation}`);
    }
    return live;
  }

  failRecovery(recovering: RuntimeRecord, message: string, candidateSessionId?: string): RuntimeRecord | undefined {
    const failed = this.tasks.stateDb.runtimes.compareAndSwap(
      recovering.taskId,
      recovering.generation,
      "recovering",
      "recoverable",
      { metadata: recoveryFailureMetadata(recovering, message, candidateSessionId) }
    );
    if (!failed) return undefined;
    this.recordRecoveryFailureEvent(recovering, failed, message, candidateSessionId);
    return failed;
  }

  // A candidate PTY that refused to die may still hold the provider
  // conversation, so the claim deliberately stays "recovering" rather than
  // reopening recovery against a possibly-live duplicate. There is no
  // same-process retry path from here: POST /tasks/:id/recover answers 409
  // until a server restart, whose startup reconcile releases the stale claim.
  noteRecoveryCleanupFailure(
    recovering: RuntimeRecord,
    message: string,
    candidateSessionId: string
  ): RuntimeRecord | undefined {
    const failed = this.tasks.stateDb.runtimes.compareAndSwap(
      recovering.taskId,
      recovering.generation,
      "recovering",
      "recovering",
      { metadata: recoveryFailureMetadata(recovering, message, candidateSessionId) }
    );
    if (!failed) return undefined;
    this.recordRecoveryFailureEvent(recovering, failed, message, candidateSessionId);
    return failed;
  }

  private recordRecoveryFailureEvent(
    recovering: RuntimeRecord,
    failed: RuntimeRecord,
    message: string,
    candidateSessionId?: string
  ): void {
    const task = this.tasks.find(recovering.taskId);
    if (task) {
      try {
        this.tasks.recordEvent(task.id, {
          kind: "runtime_interrupted",
          source: "system",
          message,
          data: {
            reason: "recovery_failed",
            runtimeId: recovering.id,
            generation: recovering.generation,
            ...(candidateSessionId ? { candidateSessionId } : {}),
            recoveryAvailable: failed.state === "recoverable" && isTrustedRuntimeIdentity(failed)
          }
        });
      } catch {
        // Runtime truth remains authoritative if optional task evidence fails.
      }
    }
  }

  private endParkedRuntime(taskId: string): RuntimeRecord | undefined {
    const runtime = this.tasks.stateDb.runtimes.latestForTask(taskId);
    if (!runtime || (runtime.state !== "recoverable" && runtime.state !== "recovering")) return undefined;
    return this.tasks.stateDb.runtimes.compareAndSwap(
      taskId,
      runtime.generation,
      ["recoverable", "recovering"],
      "ended"
    );
  }

  reconcile(liveSessionIds: ReadonlySet<string>, owns: (sessionId: string) => boolean): RuntimeRecord[] {
    const changed: RuntimeRecord[] = [];
    for (const runtime of this.tasks.stateDb.runtimes.active()) {
      const task = this.tasks.find(runtime.taskId);
      const interruptible = Boolean(task && INTERRUPTIBLE_TASK_STATES.has(task.state));
      if (runtime.state === "recoverable") {
        if (!interruptible) {
          const ended = this.tasks.stateDb.runtimes.compareAndSwap(
            runtime.taskId,
            runtime.generation,
            "recoverable",
            "ended"
          );
          if (ended) changed.push(ended);
        }
        continue;
      }
      // A recovering row claimed by this very instance is a held recovery in
      // flight: its ptySessionId still names the dead pre-recovery PTY, so
      // ownership can never be proven through it. Only bind, failRecovery, or
      // a later owner's reconcile may settle the claim.
      if (runtime.state === "recovering" && runtime.ownerInstanceId === this.instanceId) {
        continue;
      }
      const provablyOwned = Boolean(
        runtime.ptySessionId &&
        liveSessionIds.has(runtime.ptySessionId) &&
        runtime.ownerInstanceId === this.instanceId &&
        owns(runtime.ptySessionId)
      );
      if (provablyOwned) continue;
      const next: RuntimeState = interruptible ? "recoverable" : "ended";
      const updated = this.tasks.stateDb.runtimes.compareAndSwap(
        runtime.taskId,
        runtime.generation,
        ["starting", "live", "recovering"],
        next,
        task && next === "recoverable"
          ? { metadata: interruptionMetadata(runtime, task.state) }
          : {}
      );
      if (!updated) continue;
      changed.push(updated);
      if (next === "recoverable" && task) {
        this.recordInterruption(task, updated, "runtime ownership was not present at server startup");
      }
    }
    return changed;
  }

  repairLegacySessionGoneArtifacts(): number {
    let repaired = 0;
    for (const task of this.tasks.list()) {
      if (task.state !== "blocked") continue;
      const last = this.tasks.events(task.id).at(-1);
      if (last?.kind !== "blocked" || last.source !== "system" || last.data?.reason !== "session_gone") continue;
      this.tasks.recordEvent(task.id, {
        kind: "working",
        source: "system",
        message: "repaired legacy session_gone blocker; runtime interruption no longer changes task state",
        data: { reason: "runtime_lifecycle_legacy_repair", repairedEventSeq: last.seq }
      });
      repaired += 1;
    }
    return repaired;
  }

  bootstrapLegacyTasks(): number {
    let created = 0;
    for (const task of this.tasks.list()) {
      if (!task.sessionId || this.tasks.stateDb.runtimes.latestForTask(task.id)) continue;
      const terminal = TERMINAL_TASK_STATES.has(task.state);
      try {
        this.tasks.stateDb.runtimes.create({
          taskId: task.id,
          generation: 0,
          state: terminal ? "ended" : "recoverable",
          agent: "unknown",
          ptySessionId: task.sessionId,
          ...(task.workerName ? { workerName: task.workerName } : {}),
          ...(task.parentSessionId ? { parentSessionId: task.parentSessionId } : {}),
          ...(task.worktreeId ? { worktreeId: task.worktreeId, leaseId: task.worktreeId } : {}),
          metadata: { source: "legacy-task-projection" },
          ...(terminal ? { endedAt: new Date().toISOString() } : {})
        });
        created += 1;
      } catch (error) {
        // A legacy projection may reuse a session id another task already
        // claimed; one bad row must never brick startup.
        console.warn(
          `runtime: skipped legacy bootstrap for ${task.id}: ${error instanceof Error ? error.message : error}`
        );
      }
    }
    return created;
  }

  snapshotForTask(taskId: string): RuntimeSnapshot | undefined {
    const runtime = this.tasks.stateDb.runtimes.latestForTask(taskId);
    return runtime ? runtimeSnapshot(runtime) : undefined;
  }

  snapshotForSession(sessionId: string): RuntimeSnapshot | undefined {
    const runtime = this.tasks.stateDb.runtimes.findBySession(sessionId);
    return runtime ? runtimeSnapshot(runtime) : undefined;
  }

  private recordInterruption(task: Task, runtime: RuntimeRecord, message: string): void {
    const last = this.tasks.events(task.id).at(-1);
    if (last?.kind === "runtime_interrupted" && last.data?.generation === runtime.generation) {
      return;
    }
    try {
      this.tasks.recordEvent(task.id, {
        kind: "runtime_interrupted",
        source: "system",
        message,
        data: {
          reason: "runtime_interrupted",
          runtimeId: runtime.id,
          generation: runtime.generation,
          sessionId: runtime.ptySessionId,
          interruptedTaskState: runtime.metadata?.interruptedTaskState,
          recoveryAvailable: isTrustedRuntimeIdentity(runtime)
        }
      });
    } catch {
      // Runtime truth is authoritative even if optional task evidence cannot append.
    }
  }
}

export function runtimeSnapshot(runtime: RuntimeRecord): RuntimeSnapshot {
  const recoveryAvailable = runtime.state === "recoverable" && isTrustedRuntimeIdentity(runtime);
  return {
    id: runtime.id,
    workerId: runtime.taskId,
    generation: runtime.generation,
    state: runtime.state,
    ...(runtime.provider ? { provider: runtime.provider } : {}),
    ...(runtime.providerSessionId ? { providerSessionId: runtime.providerSessionId } : {}),
    agent: runtime.agent as AgentKind,
    ...(runtime.model ? { model: runtime.model } : {}),
    ...(runtime.workerName ? { workerName: runtime.workerName } : {}),
    ...(runtime.parentSessionId ? { parentSessionId: runtime.parentSessionId } : {}),
    ...(runtime.worktreeId ? { worktreeId: runtime.worktreeId } : {}),
    ...(runtime.worktreePath ? { worktreePath: runtime.worktreePath } : {}),
    ...(runtime.leaseId ? { leaseId: runtime.leaseId } : {}),
    ...(runtime.ptySessionId ? { ptySessionId: runtime.ptySessionId } : {}),
    ...(runtime.processId !== undefined ? { processId: runtime.processId } : {}),
    ...(runtime.processStartedAt ? { processStartedAt: runtime.processStartedAt } : {}),
    ...(runtime.ownerInstanceId ? { ownerInstanceId: runtime.ownerInstanceId } : {}),
    recoveryAvailable,
    ...(!recoveryAvailable
      ? {
          recoveryUnavailableReason: isTrustedRuntimeIdentity(runtime)
            ? ("runtime_not_recoverable" as const)
            : ("provider_session_unknown" as const)
        }
      : {}),
    createdAt: runtime.createdAt,
    updatedAt: runtime.updatedAt,
    ...(runtime.endedAt ? { endedAt: runtime.endedAt } : {})
  };
}

export function isTrustedProviderIdentity(provider: string | undefined, providerSessionId: string | undefined): boolean {
  return (provider === "claude" || provider === "codex") && isUuid(providerSessionId);
}

function isTrustedRuntimeIdentity(runtime: Pick<RuntimeRecord, "agent" | "provider" | "providerSessionId">): boolean {
  return runtime.agent === runtime.provider && isTrustedProviderIdentity(runtime.provider, runtime.providerSessionId);
}

function recoveryFailureMetadata(
  recovering: RuntimeRecord,
  message: string,
  candidateSessionId?: string
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    ...(recovering.metadata ?? {}),
    lastRecoveryFailure: message.slice(0, 1_000),
    lastRecoveryFailedAt: new Date().toISOString()
  };
  if (candidateSessionId) {
    metadata.candidateSessionId = candidateSessionId;
  } else {
    delete metadata.candidateSessionId;
  }
  return metadata;
}

function interruptionMetadata(runtime: RuntimeRecord, taskState: TaskState): Record<string, unknown> {
  return {
    ...(runtime.metadata ?? {}),
    interruptedTaskState: taskState,
    interruptedAt: new Date().toISOString()
  };
}

function isUuid(value: string | undefined): boolean {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

function providerForCommand(command: string, agent?: AgentKind): AgentKind {
  if (agent) return agent;
  const base = command.trim().split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (base.includes("codex")) return "codex";
  if (base.includes("claude")) return "claude";
  return "unknown";
}
