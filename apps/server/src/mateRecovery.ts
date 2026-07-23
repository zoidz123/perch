import { randomUUID } from "node:crypto";
import type { AgentSession, Task } from "@perch/shared";
import type { HookEventPayload } from "./hooks.js";
import { startManagedAgent, type ManagedAgentLauncherOptions } from "./agentLauncher.js";
import { MATE_OWNER_ID, type OwnerManager } from "./ownerManager.js";
import { claudeRecoveryDriver } from "./providerRecovery.js";
import { codexOwnedBindFacts, codexRecoveryDriver, type RecoveryProviderDriver } from "./recovery.js";
import { isTrustedProviderIdentity } from "./runtimeManager.js";
import type { OwnerRuntimeRecord, RuntimeRecord } from "./stateDb.js";
import type { TaskScheduler } from "./taskScheduler.js";
import { stripTerminalControls } from "./terminalText.js";
import { terminateMatchingOrphan } from "./orphanProcess.js";

export type MateFleetRecoveryResult = {
  session: AgentSession;
  recoveredMate: boolean;
  children: {
    recovered: string[];
    alreadyLive: string[];
    skipped: Array<{ taskId: string; reason: string }>;
    failed: Array<{ taskId: string; error: string }>;
  };
};

type MateRecoveryOptions = ManagedAgentLauncherOptions & {
  ownerManager: OwnerManager;
  taskScheduler: TaskScheduler;
  identityTimeoutMs?: number;
  mateProviders?: readonly RecoveryProviderDriver[];
};

type IdentityExpectation = {
  provider: string;
  providerSessionId: string;
  payload?: HookEventPayload;
  recordSession: (sessionId: string) => void;
  resolve: () => void;
  reject: (error: Error) => void;
};

export class MateRecoveryCoordinator {
  private readonly inFlight = new Map<string, Promise<MateFleetRecoveryResult>>();
  private readonly expectations = new Map<string, IdentityExpectation>();
  private readonly providers: Map<string, RecoveryProviderDriver>;

  constructor(private readonly options: MateRecoveryOptions) {
    this.providers = new Map(
      (options.mateProviders ?? [claudeRecoveryDriver, codexRecoveryDriver]).map((driver) => [driver.provider, driver])
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
    const valid = provider === expected.provider && providerSessionId === expected.providerSessionId && (
      !driver?.verifySessionStart || Boolean(payload && driver.verifySessionStart(providerSessionId, payload))
    );
    if (!valid) {
      expected.reject(new Error(
        `mate recovery provider identity mismatch: expected ${expected.provider}/${expected.providerSessionId}, got ${provider}/${providerSessionId}`
      ));
      return;
    }
    try {
      expected.recordSession(sessionId);
      expected.resolve();
    } catch (error) {
      expected.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  recover(runtime: OwnerRuntimeRecord): Promise<MateFleetRecoveryResult> {
    const key = `mate-fleet:${runtime.ownerId}:g${runtime.generation}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const running = this.execute(runtime, key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, running);
    return running;
  }

  private async execute(runtime: OwnerRuntimeRecord, key: string): Promise<MateFleetRecoveryResult> {
    const operation = this.options.tasks.stateDb.ownerOperations.createOrFind({
      ownerId: runtime.ownerId,
      kind: "mate-fleet-recovery",
      idempotencyKey: key,
      generation: runtime.generation
    });
    if (operation.state === "succeeded" && operation.result) {
      const sessionId = String(operation.result.sessionId ?? "");
      const session = (await this.options.adapter.listSessions()).find((candidate) => candidate.id === sessionId);
      const summary = operation.result.summary as Omit<MateFleetRecoveryResult, "session">;
      if (session && summary.children.failed.length === 0) return { session, ...summary };
    }

    try {
      const mate = runtime.state === "live" ? runtime : await this.resumeMate(runtime);
      const session = (await this.options.adapter.listSessions()).find((candidate) => candidate.id === mate.ptySessionId);
      if (!session) throw new Error("restored mate PTY is not live");
      const children = await this.restoreChildren(mate, runtime.ptySessionId);
      const result: MateFleetRecoveryResult = { session, recoveredMate: runtime.state !== "live", children };
      this.options.tasks.stateDb.ownerOperations.finish(operation.id, "succeeded", {
        sessionId: session.id,
        summary: { recoveredMate: result.recoveredMate, children }
      });
      return result;
    } catch (error) {
      this.options.tasks.stateDb.ownerOperations.finish(
        operation.id,
        "failed",
        undefined,
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  private async resumeMate(runtime: OwnerRuntimeRecord): Promise<OwnerRuntimeRecord> {
    if (runtime.state !== "recoverable") {
      throw new Error(`mate owner generation ${runtime.generation} is ${runtime.state}, not recoverable`);
    }
    if (!isTrustedProviderIdentity(runtime.provider, runtime.providerSessionId)) {
      throw new Error("mate provider session identity is missing or untrusted; use `perch mate --new`");
    }
    await this.assertOldProcessGone(runtime);
    const initialClaim = this.options.ownerManager.claimMateRecovery(runtime.generation);
    if (!initialClaim) throw new Error(`mate recovery conflict at generation ${runtime.generation}`);
    let claimed = initialClaim;

    let sessionId = "";
    let launchedSessionId = "";
    let launched = false;
    const capturedOutput: string[] = [];
    let unsubscribe: (() => void) | undefined;
    try {
      const providerSessionId = claimed.providerSessionId!;
      const prepared = await this.prepare(claimed);
      prepared.request.title = "mate";
      prepared.request.labels = { ...prepared.request.labels, role: "mate" };
      sessionId = prepared.request.sessionId!;
      launchedSessionId = sessionId;
      const identity = this.expectIdentity(sessionId, claimed.provider, providerSessionId, (candidateSessionId) => {
        claimed = this.options.ownerManager.recordRecoverySession(claimed, candidateSessionId);
      });
      unsubscribe = this.options.adapter.subscribeAgentEvents?.((event) => {
        if (event.sessionId === launchedSessionId && event.type === "terminal_output") {
          const text = event.text ?? event.raw;
          if (text) capturedOutput.push(text);
        }
      });
      const driver = this.providers.get(claimed.provider);
      if (driver?.verifyBeforeLaunch) {
        await this.verifyIdentity(driver, sessionId, providerSessionId, claimed.cwd);
      }
      const result = await startManagedAgent(this.options, {
        request: prepared.request,
        trackRuntime: false,
        trackOwner: false,
        ...(prepared.launchInput ?? {}),
        registerProject: false
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
      if (driver && !driver.verifyBeforeLaunch) {
        await this.verifyIdentity(driver, launchedSessionId, providerSessionId, claimed.cwd);
      }
      await identity;
      const alive = (await this.options.adapter.listSessions()).some(
        (session) => session.id === launchedSessionId && session.status !== "done" && session.status !== "error"
      );
      if (!alive) throw new Error(`recovered ${claimed.provider} mate exited before bind`);
      await this.options.auditLog.write({ action: "recover_agent", sessionId: launchedSessionId });
      const bindFacts = codexOwnedBindFacts(
        this.options.codexOwned,
        launchedSessionId,
        claimed,
        prepared.launchInput?.codexOwnedResume
      );
      const bound = this.options.ownerManager.bindRecoveredMate(claimed, {
        sessionId: launchedSessionId,
        provider: claimed.provider,
        providerSessionId,
        ownership: this.options.adapter.runtimeProcess?.(launchedSessionId),
        ...(bindFacts ? { metadata: bindFacts.metadata } : {})
      });
      if (bindFacts?.aliasSessionId) {
        this.options.hooks.aliasSession(bindFacts.aliasSessionId, launchedSessionId);
      }
      return bound;
    } catch (error) {
      const recent = launched
        ? await this.options.adapter.readRecentEvents(launchedSessionId, 12).catch(() => undefined)
        : undefined;
      const recentTail = stripTerminalControls((recent?.events
        .map((event) => event.type === "terminal_output" ? event.text ?? "" : "")
        .filter(Boolean)
        .join("\n")
        ?? "")).slice(-1_000);
      const capturedTail = stripTerminalControls(capturedOutput.join("")).slice(-1_000);
      const tail = recentTail || capturedTail;
      if (launched) await this.options.adapter.stopSession?.(launchedSessionId).catch(() => {});
      const message = `${error instanceof Error ? error.message : String(error)}${tail ? `; terminal: ${tail}` : ""}`;
      this.options.ownerManager.failRecovery(claimed, message);
      throw new Error(message);
    } finally {
      unsubscribe?.();
      this.expectations.delete(sessionId);
      this.expectations.delete(launchedSessionId);
    }
  }

  private async prepare(runtime: OwnerRuntimeRecord) {
    const transientRuntime = {
      ...runtime,
      taskId: MATE_OWNER_ID,
      worktreePath: runtime.cwd
    } as unknown as RuntimeRecord;
    const transientTask = {
      id: MATE_OWNER_ID,
      title: "mate",
      project: runtime.cwd
    } as Task;
    const driver = this.providers.get(runtime.provider);
    if (!driver) throw new Error(`mate recovery provider is not supported: ${runtime.provider}`);
    return driver.prepare(transientRuntime, transientTask);
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
        `mate recovery provider identity mismatch: expected ${driver.provider}/${providerSessionId}, got ${driver.provider}/${verified}`
      );
    }
    if (verified) this.observeSessionStart(sessionId, driver.provider, verified);
  }

  private async restoreChildren(mate: OwnerRuntimeRecord, previousSessionId?: string) {
    const sessionId = mate.ptySessionId!;
    const liveIds = new Set((await this.options.adapter.listSessions()).map((session) => session.id));
    const rebound = this.options.tasks.stateDb.runtimes.rebindParent(MATE_OWNER_ID, previousSessionId, sessionId);
    const candidates = new Map(rebound.map((runtime) => [runtime.taskId, runtime]));
    for (const runtime of this.options.tasks.stateDb.runtimes.active()) {
      if (runtime.parentOwnerId === MATE_OWNER_ID) candidates.set(runtime.taskId, runtime);
    }
    const result: MateFleetRecoveryResult["children"] = {
      recovered: [],
      alreadyLive: [],
      skipped: [],
      failed: []
    };
    for (const runtime of candidates.values()) {
      const task = this.options.tasks.find(runtime.taskId);
      if (!task || task.state === "closed") {
        result.skipped.push({ taskId: runtime.taskId, reason: "task is closed or missing" });
        continue;
      }
      this.options.tasks.update(task.id, { parentSessionId: sessionId });
      if (runtime.state === "live" && runtime.ptySessionId && liveIds.has(runtime.ptySessionId)) {
        result.alreadyLive.push(task.id);
        continue;
      }
      if (runtime.state !== "recoverable") {
        result.skipped.push({ taskId: task.id, reason: `runtime is ${runtime.state}` });
        continue;
      }
      if (!isTrustedProviderIdentity(runtime.provider, runtime.providerSessionId)) {
        result.failed.push({ taskId: task.id, error: "provider session identity is missing or untrusted" });
        continue;
      }
      try {
        const baseKey = `mate-child:${MATE_OWNER_ID}:${task.id}:g${runtime.generation}`;
        const prior = this.options.tasks.stateDb.operations.findByIdempotencyKey(baseKey);
        const operation = this.options.taskScheduler.create({
          taskId: task.id,
          kind: "recovery",
          idempotencyKey: prior?.state === "failed" ? `${baseKey}:retry:${randomUUID()}` : baseKey,
          payload: { expectedGeneration: runtime.generation }
        });
        await this.options.taskScheduler.run(operation.id);
        result.recovered.push(task.id);
      } catch (error) {
        result.failed.push({ taskId: task.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  }

  private expectIdentity(
    sessionId: string,
    provider: string,
    providerSessionId: string,
    recordSession: (sessionId: string) => void
  ): Promise<void> {
    const identity = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for verified ${provider} mate identity`)),
        this.options.identityTimeoutMs ?? mateRecoveryIdentityTimeoutFromEnv()
      );
      timer.unref?.();
      this.expectations.set(sessionId, {
        provider,
        providerSessionId,
        recordSession,
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
    });
    void identity.catch(() => {});
    return identity;
  }

  private async assertOldProcessGone(runtime: OwnerRuntimeRecord): Promise<void> {
    if (runtime.ptySessionId) {
      const live = (await this.options.adapter.listSessions()).some((session) => session.id === runtime.ptySessionId);
      if (live || this.options.adapter.runtimeProcess?.(runtime.ptySessionId)) {
        throw new Error(`old mate process is still live for ${runtime.ptySessionId}`);
      }
    }
    if (runtime.processId && processExists(runtime.processId)) {
      if (terminateMatchingOrphan(runtime)) await waitForProcessGone(runtime.processId);
      if (processExists(runtime.processId)) {
        throw new Error(`old mate process ${runtime.processId} is still present; refusing recovery`);
      }
    }
  }
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function mateRecoveryIdentityTimeoutFromEnv(): number {
  const value = Number(process.env.PERCH_RECOVERY_IDENTITY_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 100 ? value : 30_000;
}

async function waitForProcessGone(processId: number): Promise<void> {
  for (let attempt = 0; attempt < 40 && processExists(processId); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
