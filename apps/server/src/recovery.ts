import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { AgentKind, StartAgentRequest, Task } from "@perch/shared";
import type { CodexAppServerAdapter } from "./adapters/codexAppServerAdapter.js";
import {
  startManagedAgent,
  type ManagedAgentLauncherOptions,
  type StartManagedAgentInput
} from "./agentLauncher.js";
import type { AuditRecord } from "./audit.js";
import type { HookEventPayload } from "./hooks.js";
import { claudeRecoveryDriver } from "./providerRecovery.js";
import { isTrustedProviderIdentity } from "./runtimeManager.js";
import type { RuntimeRecord, OperationRecord } from "./stateDb.js";
import type { OperationExecutionContext } from "./taskScheduler.js";
import { terminateMatchingOrphan } from "./orphanProcess.js";
import type { CodexHistorySyncCoordinator } from "./codexHistorySync.js";
import { isCodexRpcError } from "./adapters/codexAppServer.js";

const DEFAULT_IDENTITY_TIMEOUT_MS = 30_000;

export type PreparedProviderRecovery = {
  request: StartAgentRequest;
  expectedProviderSessionId: string;
  allowReplacementProviderSessionId?: boolean;
  postBindTurn?: {
    text: string;
    clientUserMessageId: string;
    handoff: "task_brief" | "mate_state";
  };
  // Extra launcher input the driver needs carried into startManagedAgent
  // (the codex driver passes the resume thread + recorded daemon socket).
  launchInput?: Pick<StartManagedAgentInput, "codexOwnedResume">;
};

export type RecoveryProviderDriver = {
  provider: string;
  verifyBeforeLaunch?: boolean;
  prepare(runtime: RuntimeRecord, task: Task): Promise<PreparedProviderRecovery> | PreparedProviderRecovery;
  verifySessionStart?(expectedProviderSessionId: string, payload: HookEventPayload): boolean;
  verifyIdentity?(input: {
    sessionId: string;
    providerSessionId: string;
    cwd: string;
  }): Promise<string | undefined>;
};

export type RecoveryCoordinatorOptions = ManagedAgentLauncherOptions & {
  identityTimeoutMs?: number;
  providers?: readonly RecoveryProviderDriver[];
  codexHistorySync?: CodexHistorySyncCoordinator;
};

type RecoveryPayload = {
  expectedGeneration: number;
  auditMeta?: Pick<AuditRecord, "deviceId" | "remoteAddress">;
  claimed?: boolean;
  claimOwnerInstanceId?: string;
  launchStarted?: boolean;
  sessionId?: string;
};

export type CodexMigrationHandoff = {
  state: "pending" | "submitted" | "accepted" | "rejected" | "delivery_unknown";
  clientUserMessageId: string;
  handoff: "task_brief" | "mate_state";
  turnId?: string | null;
  failureReason?: string;
};

export class CodexMigrationHandoffError extends Error {}

type IdentityExpectation = {
  provider: string;
  providerSessionId: string;
  allowReplacementProviderSessionId: boolean;
  recordSession: (sessionId: string, providerSessionId: string) => void;
  resolve: () => void;
  reject: (error: Error) => void;
};

export class RecoveryCoordinator {
  private readonly providers: Map<string, RecoveryProviderDriver>;
  private readonly expectations = new Map<string, IdentityExpectation>();

  constructor(private readonly options: RecoveryCoordinatorOptions) {
    this.providers = new Map(
      (options.providers ?? [claudeRecoveryDriver, codexRecoveryDriver]).map((driver) => [driver.provider, driver])
    );
  }

  observeSessionStart(
    sessionId: string,
    provider: string,
    providerSessionId: string,
    payload?: HookEventPayload
  ): void {
    const expected = this.expectations.get(sessionId);
    if (!expected) return;
    const driver = this.providers.get(expected.provider);
    const identityMatches = providerSessionId === expected.providerSessionId || (
      expected.allowReplacementProviderSessionId &&
      providerSessionId !== expected.providerSessionId &&
      isTrustedProviderIdentity(provider, providerSessionId)
    );
    const verified = Boolean(
      provider === expected.provider && identityMatches &&
      (!driver?.verifySessionStart || (payload && driver.verifySessionStart(providerSessionId, payload)))
    );
    if (!verified) {
      expected.reject(
        new Error(
          `recovery provider identity mismatch: expected ${expected.provider}/${expected.providerSessionId}, got ${provider}/${providerSessionId}`
        )
      );
      return;
    }
    try {
      expected.recordSession(sessionId, providerSessionId);
      expected.resolve();
    } catch (error) {
      expected.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async execute(operation: OperationRecord, context: OperationExecutionContext): Promise<void> {
    const payload = operation.payload as RecoveryPayload | undefined;
    if (!payload || !Number.isInteger(payload.expectedGeneration)) {
      throw new Error("recovery operation payload is incomplete");
    }
    const task = this.options.tasks.find(operation.taskId);
    if (!task) throw new Error(`Unknown task: ${operation.taskId}`);
    const currentRuntime = this.options.tasks.stateDb.runtimes.latestForTask(task.id);
    if (!currentRuntime) throw new Error(`task ${task.id} has no durable runtime`);
    let runtime = currentRuntime;

    if (runtime.state === "live" && runtime.generation === payload.expectedGeneration + 1) {
      await this.completeMigrationHandoff(task, runtime);
      return;
    }
    if (runtime.generation !== payload.expectedGeneration) {
      throw new Error(`runtime generation conflict for ${task.id}: expected g${payload.expectedGeneration}, found g${runtime.generation}`);
    }
    if (
      runtime.agent !== runtime.provider ||
      !isTrustedProviderIdentity(runtime.provider, runtime.providerSessionId)
    ) {
      throw new Error("provider session identity is missing or untrusted");
    }
    const providerSessionId = runtime.providerSessionId!;
    let recoveredProviderSessionId: string = providerSessionId;
    const driver = this.providers.get(runtime.provider ?? runtime.agent);
    if (!driver) throw new Error(`recovery provider is not supported: ${runtime.provider ?? runtime.agent}`);

    if (payload.launchStarted && payload.sessionId) {
      const live = (await this.options.adapter.listSessions()).find(
        (session) => session.id === payload.sessionId && session.status !== "done" && session.status !== "error"
      );
      if (live) {
        await this.options.adapter.stopSession?.(live.id);
        await this.waitForSessionGone(live.id);
      }
      if (runtime.state === "recovering") {
        this.assertOwnStaleClaim(runtime, payload);
        this.options.runtimeManager?.failRecovery(runtime, "recovery owner restarted before provider verification", payload.sessionId);
        runtime = this.options.tasks.stateDb.runtimes.latestForTask(task.id)!;
      }
    }

    if (
      runtime.state === "recovering" &&
      payload.claimed === true &&
      payload.claimOwnerInstanceId !== this.options.runtimeManager?.instanceId
    ) {
      this.assertOwnStaleClaim(runtime, payload);
      this.options.runtimeManager?.failRecovery(runtime, "recovery operation resumed under a new server owner");
      runtime = this.options.tasks.stateDb.runtimes.latestForTask(task.id)!;
    }

    if (runtime.state === "recoverable") {
      await this.assertOldProcessGone(runtime);
      const claimed = this.options.runtimeManager?.claimRecovery(task.id, runtime.generation);
      if (!claimed) throw new Error(`runtime recovery conflict for ${task.id} g${runtime.generation}`);
      runtime = claimed;
      context.checkpoint({
        ...payload,
        claimed: true,
        claimOwnerInstanceId: this.options.runtimeManager?.instanceId,
        launchStarted: false,
        sessionId: undefined
      });
    } else if (
      runtime.state !== "recovering" ||
      payload.claimed !== true ||
      payload.claimOwnerInstanceId !== this.options.runtimeManager?.instanceId
    ) {
      throw new Error(`runtime ${task.id} g${runtime.generation} is ${runtime.state}, not recoverable`);
    }

    let prepared: PreparedProviderRecovery;
    try {
      prepared = await driver.prepare(runtime, task);
      if (prepared.expectedProviderSessionId !== providerSessionId) {
        throw new Error(`recovery driver identity mismatch for ${task.id} g${runtime.generation}`);
      }
    } catch (error) {
      this.options.runtimeManager?.failRecovery(runtime, error instanceof Error ? error.message : String(error));
      throw error;
    }
    const request = prepared.request;
    const sessionId = request.sessionId;
    if (!sessionId) {
      this.options.runtimeManager?.failRecovery(runtime, "recovery driver did not mint a PTY session id");
      throw new Error("recovery driver did not mint a PTY session id");
    }
    const leaseId = runtime.leaseId ?? runtime.worktreeId ?? task.worktreeId;
    const lease = leaseId ? this.options.worktrees.find(leaseId) : undefined;
    if (leaseId && !lease) {
      this.options.runtimeManager?.failRecovery(runtime, `recovery worktree lease disappeared: ${leaseId}`);
      throw new Error(`recovery worktree lease disappeared: ${leaseId}`);
    }

    const identity = this.expectIdentity(
      sessionId,
      driver.provider,
      providerSessionId,
      prepared.allowReplacementProviderSessionId === true,
      (candidateSessionId, observedProviderSessionId) => {
        recoveredProviderSessionId = observedProviderSessionId;
        const linked = this.options.runtimeManager?.recordRecoverySession(runtime, candidateSessionId);
        if (!linked) throw new Error("runtime manager is unavailable during recovery");
        runtime = linked;
      }
    );
    let launchedSessionId = sessionId;
    let launched = false;
    let boundRuntime: RuntimeRecord | undefined;
    try {
      if (prepared.postBindTurn) {
        this.supersedePendingKickoff(task.id, sessionId);
      }
      if (driver.verifyBeforeLaunch) {
        await this.verifyIdentity(driver, sessionId, providerSessionId, request.cwd ?? task.project);
      }
      await context.boundary("beforeLaunch");
      context.checkpoint({
        ...payload,
        claimed: true,
        claimOwnerInstanceId: this.options.runtimeManager?.instanceId,
        launchStarted: true,
        sessionId
      });
      const result = await startManagedAgent(this.options, {
        request,
        taskId: task.id,
        trackRuntime: false,
        ...(prepared.launchInput ?? {}),
        ...(lease ? { worktreeLease: lease, retainWorktreeOnFailure: true } : {}),
        projectRoot: task.project,
        auditMeta: payload.auditMeta
      });
      launched = true;
      launchedSessionId = result.session.id;
      if (launchedSessionId !== sessionId) {
        const expectation = this.expectations.get(sessionId);
        if (expectation) {
          this.expectations.set(launchedSessionId, expectation);
          this.expectations.delete(sessionId);
        }
      }
      await context.boundary("afterLaunch");
      if (!driver.verifyBeforeLaunch) {
        await this.verifyIdentity(driver, result.session.id, providerSessionId, request.cwd ?? task.project);
      }
      try {
        await identity;
        // Identity evidence can arrive out-of-band (the Codex driver resumes
        // the thread against its own app-server), which proves the persisted
        // conversation is resumable but not that the replacement session
        // survived startup. Never bind a live generation to a session that
        // already exited.
        const alive = (await this.options.adapter.listSessions()).some(
          (session) => session.id === launchedSessionId && session.status !== "done" && session.status !== "error"
        );
        if (!alive) {
          throw new Error(`recovered ${driver.provider} process exited before the runtime bind`);
        }
      } catch (error) {
        const recent = await this.options.adapter.readRecentEvents(result.session.id, 12).catch(() => undefined);
        const tail = recent?.events
          .map((event) => event.type === "terminal_output" ? event.text ?? "" : "")
          .filter(Boolean)
          .join("\n")
          .trim()
          .slice(-1_000);
        throw new Error(`${error instanceof Error ? error.message : String(error)}${tail ? `; terminal: ${tail}` : ""}`);
      }
      await this.options.auditLog.write({
        action: "recover_agent",
        taskId: task.id,
        sessionId: result.session.id,
        ...(payload.auditMeta ?? {})
      });
      const bindFacts = codexOwnedBindFacts(
        this.options.codexOwned,
        result.session.id,
        runtime,
        prepared.launchInput?.codexOwnedResume
      );
      const bound = this.options.runtimeManager?.bindRecoveredRuntime(runtime, {
        sessionId: result.session.id,
        provider: driver.provider,
        providerSessionId: recoveredProviderSessionId,
        allowProviderSessionReplacement: prepared.allowReplacementProviderSessionId === true,
        ownership: this.options.adapter.runtimeProcess?.(result.session.id),
        ...(bindFacts || prepared.postBindTurn
          ? {
              metadata: {
                ...(bindFacts?.metadata ?? {}),
                ...(prepared.postBindTurn
                  ? { codexMigrationHandoff: pendingMigrationHandoff(prepared.postBindTurn) }
                  : {})
              }
            }
          : {})
      });
      boundRuntime = bound;
      if (bindFacts?.aliasSessionId) {
        this.options.hooks.aliasSession(bindFacts.aliasSessionId, result.session.id);
      }
      if (bound) {
        if (prepared.allowReplacementProviderSessionId) {
          this.options.tasks.recordEvent(task.id, {
            kind: "note",
            source: "system",
            message: "codex recovery migrated to a fresh root thread",
            data: {
              reason: "codex_thread_migrated",
              fromThreadId: providerSessionId,
              toThreadId: recoveredProviderSessionId
            }
          });
        }
        try {
          this.options.codexHistorySync?.startForTaskRuntime(bound);
        } catch (error) {
          console.warn(
            `codex history catch-up could not start for ${bound.ptySessionId}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    } catch (error) {
      let cleanupError: unknown;
      if (launched) {
        await this.options.adapter.stopSession?.(launchedSessionId).catch(() => {});
        try {
          await this.waitForSessionGone(launchedSessionId);
        } catch (candidateCleanupError) {
          cleanupError = candidateCleanupError;
        }
      }
      if (lease) await this.options.worktrees.assign(lease.id, task.id).catch(() => {});
      if (cleanupError) {
        const message = `${error instanceof Error ? error.message : String(error)}; cleanup failed: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`;
        this.options.runtimeManager?.noteRecoveryCleanupFailure(runtime, message, launchedSessionId);
        throw new Error(message);
      }
      this.options.runtimeManager?.failRecovery(
        runtime,
        error instanceof Error ? error.message : String(error),
        launched ? launchedSessionId : undefined
      );
      throw error;
    } finally {
      this.expectations.delete(sessionId);
      this.expectations.delete(launchedSessionId);
    }
    if (boundRuntime) await this.completeMigrationHandoff(task, boundRuntime);
  }

  private supersedePendingKickoff(taskId: string, replacementSessionId: string): void {
    const events = this.options.tasks.events(taskId);
    const pending = events.some((event) => event.data?.reason === "kickoff_submitted") &&
      !events.some((event) => event.data?.reason === "kickoff_accepted");
    if (!pending || events.some((event) => event.data?.reason === "kickoff_superseded_by_migration")) return;
    this.options.tasks.recordEvent(taskId, {
      kind: "note",
      source: "system",
      message: "codex kickoff reconciliation was superseded before root thread migration",
      data: { reason: "kickoff_superseded_by_migration", replacementSessionId }
    });
  }

  private async completeMigrationHandoff(task: Task, runtime: RuntimeRecord): Promise<void> {
    const handoff = codexMigrationHandoffFromMetadata(runtime.metadata);
    if (!handoff || !runtime.ptySessionId) return;
    let current = runtime;
    try {
      if (!this.options.codexOwned) throw new Error("Codex ownership adapter is unavailable");
      const acceptedNow = await deliverCodexMigrationHandoff({
        codexOwned: this.options.codexOwned,
        sessionId: runtime.ptySessionId,
        text: codexMigrationHandoff(task, handoff.handoff),
        handoff,
        persist: (next) => {
          const updated = this.options.tasks.stateDb.runtimes.compareAndSwap(
            current.taskId,
            current.generation,
            "live",
            "live",
            { metadata: { ...current.metadata, codexMigrationHandoff: next } }
          );
          if (!updated) throw new Error("migration handoff runtime ownership changed");
          current = updated;
        }
      });
      if (acceptedNow && !this.options.tasks.events(task.id).some(
        (event) => event.data?.reason === "codex_migration_handoff_accepted"
      )) {
        this.options.tasks.recordEvent(task.id, {
          kind: "note",
          source: "system",
          message: "codex accepted the post-migration handoff turn",
          data: { reason: "codex_migration_handoff_accepted", sessionId: runtime.ptySessionId }
        });
      }
      const latestBlock = this.options.tasks.events(task.id).filter((event) => event.kind === "blocked").at(-1);
      if (
        acceptedNow &&
        this.options.tasks.find(task.id)?.state === "blocked" &&
        latestBlock?.data?.reason === "codex_migration_handoff_failed"
      ) {
        this.options.tasks.recordEvent(task.id, {
          kind: "working",
          source: "system",
          message: "codex migration handoff was confirmed after recovery",
          data: { reason: "codex_migration_handoff_reconciled", sessionId: runtime.ptySessionId }
        });
      }
    } catch (error) {
      if (!this.options.tasks.events(task.id).some(
        (event) => event.data?.reason === "codex_migration_handoff_failed"
      )) {
        this.options.tasks.recordEvent(task.id, {
          kind: "blocked",
          source: "system",
          message: `codex post-migration handoff failed: ${error instanceof Error ? error.message : String(error)}`,
          data: { reason: "codex_migration_handoff_failed", sessionId: runtime.ptySessionId }
        });
      }
      throw error;
    }
  }

  private expectIdentity(
    sessionId: string,
    provider: string,
    providerSessionId: string,
    allowReplacementProviderSessionId: boolean,
    recordSession: (sessionId: string, providerSessionId: string) => void
  ): Promise<void> {
    const identity = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for verified SessionStart for ${provider} recovery`)),
        this.options.identityTimeoutMs ?? recoveryIdentityTimeoutFromEnv()
      );
      timer.unref?.();
      this.expectations.set(sessionId, {
        provider,
        providerSessionId,
        allowReplacementProviderSessionId,
        recordSession,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
    // SessionStart can race the await while startManagedAgent is still doing
    // lease/audit work. Mark the promise observed immediately; callers still
    // receive the original rejection when they await it.
    void identity.catch(() => {});
    return identity;
  }

  private async verifyIdentity(
    driver: RecoveryProviderDriver,
    sessionId: string,
    providerSessionId: string,
    cwd: string
  ): Promise<void> {
    const verified = await driver.verifyIdentity?.({
      sessionId,
      providerSessionId,
      cwd
    });
    if (verified && verified !== providerSessionId) {
      throw new Error(
        `recovery provider identity mismatch: expected ${driver.provider}/${providerSessionId}, got ${driver.provider}/${verified}`
      );
    }
    if (verified) this.observeSessionStart(sessionId, driver.provider, verified);
  }

  // A resumed operation may only compensate its own stale claim. A recovering
  // row held by a different owner belongs to a later recovery in flight;
  // revoking it would let two workers resume the same provider conversation.
  private assertOwnStaleClaim(runtime: RuntimeRecord, payload: RecoveryPayload): void {
    if (runtime.ownerInstanceId !== payload.claimOwnerInstanceId) {
      throw new Error(
        `runtime recovery conflict for ${runtime.taskId} g${runtime.generation}: recovering claim is held by another owner`
      );
    }
  }

  private async assertOldProcessGone(runtime: RuntimeRecord): Promise<void> {
    if (runtime.ptySessionId) {
      const session = (await this.options.adapter.listSessions()).find(
        (candidate) => candidate.id === runtime.ptySessionId && candidate.status !== "done" && candidate.status !== "error"
      );
      if (session) throw new Error(`old runtime process is still live for ${runtime.ptySessionId}`);
      const owned = this.options.adapter.runtimeProcess?.(runtime.ptySessionId);
      if (owned) throw new Error(`old runtime process ownership is still present for ${runtime.ptySessionId}`);
    }
    if (runtime.processId && processExists(runtime.processId)) {
      if (terminateMatchingOrphan(runtime)) await waitForProcessGone(runtime.processId);
      if (processExists(runtime.processId)) {
        throw new Error(`old runtime process ${runtime.processId} is still present; refusing recovery`);
      }
    }
  }

  private async waitForSessionGone(sessionId: string): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const live = (await this.options.adapter.listSessions()).some(
        (session) => session.id === sessionId && session.status !== "done" && session.status !== "error"
      );
      if (!live && !this.options.adapter.runtimeProcess?.(sessionId)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`failed recovery process ${sessionId} did not stop cleanly`);
  }
}

export const codexRecoveryDriver: RecoveryProviderDriver = {
  provider: "codex",
  prepare(runtime, task) {
    if (runtime.state !== "recovering") {
      throw new Error(`Codex recovery unavailable: runtime is ${runtime.state}, not a held recovering claim`);
    }
    if (runtime.provider !== "codex" || runtime.agent !== "codex") {
      throw new Error(
        `Codex recovery unavailable: runtime identity is agent=${runtime.agent} provider=${runtime.provider ?? "unknown"}, not codex`
      );
    }
    if (!isTrustedProviderIdentity(runtime.provider, runtime.providerSessionId)) {
      throw new Error(
        "Codex recovery unavailable: trusted provider thread identity is missing. This runtime predates app-server ownership and cannot be migrated; end it and dispatch a fresh worker."
      );
    }
    const threadId = runtime.providerSessionId!;
    const sessionId = `pty:${randomUUID()}`;
    const socketPath =
      typeof runtime.metadata?.appServerSocketPath === "string"
        ? (runtime.metadata.appServerSocketPath as string)
        : undefined;
    const runtimeFingerprint =
      typeof runtime.metadata?.appServerRuntimeFingerprint === "string"
        ? (runtime.metadata.appServerRuntimeFingerprint as string)
        : undefined;
    const rootTaskReportingTool = runtime.metadata?.codexTaskReportingMode === "root_dynamic_tool";
    const legacyChildDisabled = isProvenLegacyChildDisabled(runtime.metadata);
    const migrateToFreshThread = !rootTaskReportingTool && !legacyChildDisabled;
    const handoff = task.id === "owner:mate" ? "mate_state" as const : "task_brief" as const;
    return {
      expectedProviderSessionId: threadId,
      ...(migrateToFreshThread ? { allowReplacementProviderSessionId: true } : {}),
      request: {
        command: "codex",
        agent: "codex" as AgentKind,
        args: ["resume", threadId],
        sessionId,
        cwd: canonicalPath(runtime.worktreePath ?? task.project),
        title: `codex - ${task.title}`,
        ...(runtime.model ? { model: runtime.model } : {}),
        labels: {
          task: task.id,
          ...(runtime.workerName ? { workerName: runtime.workerName } : {}),
          ...(runtime.parentSessionId ? { parent: runtime.parentSessionId } : {})
        }
      },
      ...(migrateToFreshThread
        ? {
            postBindTurn: {
              text: codexMigrationHandoff(task, handoff),
              clientUserMessageId: `perch:migration:${task.id}:g${runtime.generation + 1}`,
              handoff
            }
          }
        : {}),
      launchInput: {
        codexOwnedResume: {
          threadId,
          ...(socketPath ? { socketPath } : {}),
          ...(runtimeFingerprint ? { runtimeFingerprint } : {}),
          ...(rootTaskReportingTool ? { rootTaskReportingTool: true } : {}),
          ...(legacyChildDisabled ? { legacyChildDisabled: true } : {}),
          ...(migrateToFreshThread
            ? {
                migration: {
                  reason: "unverified_native_multi_agent_capability" as const,
                  handoff
                }
              }
            : {})
        }
      }
    };
  }
};

export function isProvenLegacyChildDisabled(metadata: Record<string, unknown> | undefined): boolean {
  const capability = metadata?.codexNativeMultiAgentCapability;
  if (!capability || typeof capability !== "object" || Array.isArray(capability)) return false;
  const proof = capability as Record<string, unknown>;
  return proof.effective === "disabled" && proof.persisted === "disabled" && proof.model === "disabled";
}

function codexMigrationHandoff(task: Task, handoff: "task_brief" | "mate_state"): string {
  if (handoff === "mate_state") {
    return "Perch migrated this owner to a fresh Codex thread to preserve root-only task authority. Inspect the current Perch task ledger and worktree state, then continue orchestration from durable state.";
  }
  const brief = task.prompt?.trim().slice(0, 12_000);
  return [
    "Perch migrated this task to a fresh Codex thread to preserve root-only task authority.",
    "Continue from the current worktree and verify existing changes before editing.",
    brief ? `Original task brief:\n${brief}` : `Task: ${task.title}`
  ].join("\n\n");
}

function pendingMigrationHandoff(
  turn: NonNullable<PreparedProviderRecovery["postBindTurn"]>
): CodexMigrationHandoff {
  return {
    state: "pending",
    clientUserMessageId: turn.clientUserMessageId,
    handoff: turn.handoff
  };
}

export function codexMigrationHandoffFromMetadata(
  metadata: Record<string, unknown> | undefined
): CodexMigrationHandoff | undefined {
  const value = metadata?.codexMigrationHandoff;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !["pending", "submitted", "accepted", "rejected", "delivery_unknown"].includes(String(record.state)) ||
    typeof record.clientUserMessageId !== "string" ||
    (record.handoff !== "task_brief" && record.handoff !== "mate_state")
  ) return undefined;
  return value as CodexMigrationHandoff;
}

export async function deliverCodexMigrationHandoff(input: {
  codexOwned: Pick<CodexAppServerAdapter, "findAcceptedTurn" | "submitAcknowledgedTurn">;
  sessionId: string;
  text: string;
  handoff: CodexMigrationHandoff;
  persist: (handoff: CodexMigrationHandoff) => void;
}): Promise<boolean> {
  let handoff = input.handoff;
  if (handoff.state === "accepted") return false;
  if (handoff.state === "rejected") {
    throw new CodexMigrationHandoffError(
      handoff.failureReason ?? "migration handoff is rejected"
    );
  }
  if (handoff.state === "submitted" || handoff.state === "delivery_unknown") {
    let accepted: { id?: string } | undefined;
    try {
      accepted = await input.codexOwned.findAcceptedTurn(input.sessionId, handoff.clientUserMessageId);
    } catch (error) {
      const failureReason = `migration handoff acceptance is unknown: ${error instanceof Error ? error.message : String(error)}`;
      handoff = { ...handoff, state: "delivery_unknown", failureReason };
      input.persist(handoff);
      throw new CodexMigrationHandoffError(failureReason);
    }
    if (accepted) {
      input.persist({ ...handoff, state: "accepted", turnId: accepted.id, failureReason: undefined });
      return true;
    }
    if (handoff.state === "delivery_unknown") {
      handoff = { ...handoff, state: "submitted", failureReason: undefined };
      input.persist(handoff);
    }
  } else {
    handoff = { ...handoff, state: "submitted", failureReason: undefined };
    input.persist(handoff);
  }
  try {
    const accepted = await input.codexOwned.submitAcknowledgedTurn(input.sessionId, input.text, {
      clientUserMessageId: handoff.clientUserMessageId,
      source: "agent"
    });
    input.persist({ ...handoff, state: "accepted", turnId: accepted.turnId, failureReason: undefined });
    return true;
  } catch (error) {
    const rejected = isCodexRpcError(error);
    const failureReason = rejected
      ? `migration handoff was rejected: ${error.message}`
      : `migration handoff acceptance is unknown: ${error instanceof Error ? error.message : String(error)}`;
    input.persist({
      ...handoff,
      state: rejected ? "rejected" : "delivery_unknown",
      failureReason
    });
    throw new CodexMigrationHandoffError(failureReason);
  }
}

// Driver facts a codex recovery must re-record on the freshly bound
// generation: the CURRENT daemon socket (so the rebind guarantee holds across
// every later restart, not just the first), and - when the launch adopted the
// surviving daemon instead of respawning - the session identity/generation
// still baked into that daemon's environment. The daemon env cannot change,
// so the hook registry aliases that stale identity (aliasSessionId) to the
// live session; tool-shell verbs authenticated with the old credentials then
// resolve to the live runtime. Returns undefined for non-owned (Claude)
// sessions.
export function codexOwnedBindFacts(
  codexOwned: Pick<CodexAppServerAdapter, "socketPathOf" | "runtimeFingerprint" | "taskReportingModeOf" | "migrationOf"> | undefined,
  liveSessionId: string,
  recovering: Pick<RuntimeRecord, "generation" | "ptySessionId" | "metadata">,
  resume: { threadId: string; socketPath?: string } | undefined
): { metadata: Record<string, unknown>; aliasSessionId?: string } | undefined {
  const socketPath = codexOwned?.socketPathOf(liveSessionId);
  if (!socketPath) return undefined;
  const runtimeFingerprint = codexOwned?.runtimeFingerprint();
  const taskReportingMode = codexOwned?.taskReportingModeOf(liveSessionId);
  const migration = codexOwned?.migrationOf(liveSessionId);
  const metadata: Record<string, unknown> = {
    codexDriver: "app-server-owned",
    appServerSocketPath: socketPath,
    ...(runtimeFingerprint ? { appServerRuntimeFingerprint: runtimeFingerprint } : {}),
    ...(taskReportingMode ? { codexTaskReportingMode: taskReportingMode } : {}),
    ...(taskReportingMode === "legacy_hook_compat" && recovering.metadata?.codexNativeMultiAgentCapability
      ? { codexNativeMultiAgentCapability: recovering.metadata.codexNativeMultiAgentCapability }
      : {}),
    ...(codexMigrationHandoffFromMetadata(recovering.metadata)
      ? { codexMigrationHandoff: codexMigrationHandoffFromMetadata(recovering.metadata) }
      : {}),
    ...(migration ? { codexThreadMigration: migration } : {})
  };
  const rebound = Boolean(resume?.socketPath && resume.socketPath === socketPath);
  if (!rebound) return { metadata };
  const daemonSessionId =
    typeof recovering.metadata?.appServerDaemonSessionId === "string"
      ? recovering.metadata.appServerDaemonSessionId
      : recovering.ptySessionId;
  if (!daemonSessionId) return { metadata };
  metadata.appServerDaemonSessionId = daemonSessionId;
  metadata.appServerDaemonGeneration =
    typeof recovering.metadata?.appServerDaemonGeneration === "number"
      ? recovering.metadata.appServerDaemonGeneration
      : recovering.generation;
  return {
    metadata,
    ...(daemonSessionId !== liveSessionId ? { aliasSessionId: daemonSessionId } : {})
  };
}

// The codex app-server rejects thread/resume for a recorded thread whose
// rollout JSONL was never written (the file only appears at the thread's first
// turn) with exactly this -32600 message. That condition is permanent - the
// rollout will never appear - unlike transient daemon/socket/timeout failures,
// which must stay recoverable. Match both the code marker and the message text
// (the client formats errors as `<method>: <message> (code=<code>)`), so other
// -32600 shapes (e.g. a malformed thread id) never classify as permanent.
export function isCodexMissingRolloutResumeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("(code=-32600)") && message.includes("no rollout found for thread id");
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessGone(processId: number): Promise<void> {
  for (let attempt = 0; attempt < 40 && processExists(processId); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function recoveryIdentityTimeoutFromEnv(): number {
  const value = Number(process.env.PERCH_RECOVERY_IDENTITY_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 100 ? value : DEFAULT_IDENTITY_TIMEOUT_MS;
}

function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}
