import type { CodexAppServerAdapter } from "./adapters/codexAppServerAdapter.js";
import type {
  CodexHistorySyncRecord,
  OwnerRuntimeRecord,
  RuntimeRecord,
  StateDb
} from "./stateDb.js";

const DEFAULT_RETRY_DELAYS_MS = [1_000, 5_000, 30_000];

export type CodexHistorySyncCoordinatorOptions = {
  retryDelaysMs?: number[];
};

type SyncMode = "full" | "gap";

export class CodexHistorySyncCoordinator {
  private readonly retryDelaysMs: number[];
  private readonly runs = new Map<string, symbol>();
  private readonly retryIndexes = new Map<string, number>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly gapTimers = new Map<string, NodeJS.Timeout>();
  private readonly pendingGaps = new Set<string>();
  private readonly receiptModes = new Map<string, SyncMode>();
  private readonly processReceipts = new Map<
    string,
    { receiptId: string; providerSessionId: string }
  >();
  private stopped = false;

  constructor(
    private readonly stateDb: StateDb,
    private readonly adapter: CodexAppServerAdapter,
    options: CodexHistorySyncCoordinatorOptions = {}
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.adapter.setHistoryCatchUpRequester((sessionId) => this.resumeForSession(sessionId));
  }

  startForTaskRuntime(runtime: RuntimeRecord): CodexHistorySyncRecord | undefined {
    if (this.stopped || !isEligible(runtime)) return undefined;
    return this.startForRuntime({
      runtimeKind: "task",
      runtimeId: runtime.id,
      runtimeGeneration: runtime.generation,
      perchSessionId: runtime.ptySessionId,
      providerSessionId: runtime.providerSessionId
    });
  }

  startForOwnerRuntime(runtime: OwnerRuntimeRecord): CodexHistorySyncRecord | undefined {
    if (this.stopped || !isEligible(runtime)) return undefined;
    return this.startForRuntime({
      runtimeKind: "owner",
      runtimeId: runtime.id,
      runtimeGeneration: runtime.generation,
      perchSessionId: runtime.ptySessionId,
      providerSessionId: runtime.providerSessionId
    });
  }

  resumeForSession(sessionId: string): CodexHistorySyncRecord | undefined {
    if (this.stopped) return undefined;
    this.pendingGaps.add(sessionId);
    const processReceipt = this.processReceipts.get(sessionId);
    const latest = processReceipt
      ? this.stateDb.codexHistorySyncs.find(processReceipt.receiptId)
      : undefined;
    if (latest) {
      this.processReceipts.set(sessionId, {
        receiptId: latest.id,
        providerSessionId: latest.providerSessionId
      });
      if (!isTerminalSuccess(latest.state)) {
        this.start(latest);
        return latest;
      }
      return this.startGap(latest);
    }

    const taskRuntime = this.stateDb.runtimes.findBySession(sessionId);
    if (taskRuntime) return this.startForTaskRuntime(taskRuntime);
    const ownerRuntime = this.stateDb.ownerRuntimes.findBySession(sessionId);
    if (ownerRuntime) return this.startForOwnerRuntime(ownerRuntime);
    return undefined;
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    for (const timer of this.gapTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.gapTimers.clear();
    this.runs.clear();
    this.pendingGaps.clear();
    this.receiptModes.clear();
    this.processReceipts.clear();
  }

  private startForRuntime(
    input: Parameters<StateDb["codexHistorySyncs"]["create"]>[0]
  ): CodexHistorySyncRecord {
    const processReceipt = this.processReceipts.get(input.perchSessionId);
    if (processReceipt?.providerSessionId === input.providerSessionId) {
      const existing = this.stateDb.codexHistorySyncs.find(processReceipt.receiptId);
      if (existing) {
        if (!isTerminalSuccess(existing.state)) {
          this.start(existing);
          return existing;
        }
        if (
          existing.runtimeKind === input.runtimeKind &&
          existing.runtimeId === input.runtimeId &&
          existing.runtimeGeneration === input.runtimeGeneration
        ) {
          return existing;
        }
        return this.createAndStart(input, "gap");
      }
    }
    return this.createAndStart(
      input,
      this.pendingGaps.has(input.perchSessionId) ? "gap" : "full"
    );
  }

  private createAndStart(
    input: Parameters<StateDb["codexHistorySyncs"]["create"]>[0],
    mode: SyncMode
  ): CodexHistorySyncRecord {
    const receipt = this.stateDb.codexHistorySyncs.create(input);
    this.pendingGaps.delete(input.perchSessionId);
    this.receiptModes.set(receipt.id, mode);
    this.processReceipts.set(input.perchSessionId, {
      receiptId: receipt.id,
      providerSessionId: receipt.providerSessionId
    });
    this.start(receipt);
    return receipt;
  }

  private start(receipt: CodexHistorySyncRecord): void {
    if (this.stopped || this.runs.has(receipt.id)) return;
    this.clearRetryTimer(receipt.id);
    const running = this.stateDb.codexHistorySyncs.start(receipt.id);
    if (!running) return;
    const mode = this.receiptModes.get(running.id);
    const cursor = running.cursor ?? null;
    const retiredPendingGap =
      mode === "full" &&
      cursor === null &&
      this.pendingGaps.delete(running.perchSessionId);
    const run = Symbol(running.id);
    this.runs.set(running.id, run);
    const finish = (
      state: "succeeded" | "truncated" | "failed",
      error?: string,
      retryable = true
    ): void => {
      if (this.runs.get(running.id) !== run) return;
      this.runs.delete(running.id);
      const finished = this.stateDb.codexHistorySyncs.finish(running.id, state, error);
      if (!finished) return;
      if (state === "failed" && retryable) {
        this.scheduleRetry(finished);
      } else {
        this.retryIndexes.delete(running.id);
        this.clearRetryTimer(running.id);
        if (state !== "failed") {
          this.receiptModes.delete(running.id);
          this.schedulePendingGap(finished);
        }
      }
    };

    try {
      const started = this.adapter.startHistoryCatchUp(running.perchSessionId, {
        syncId: running.id,
        threadId: running.providerSessionId,
        cursor,
        stopAtAnchor: mode === "gap",
        onPage: ({ cursor, accepted }) => {
          if (!this.stateDb.codexHistorySyncs.recordPage(running.id, cursor, accepted)) {
            throw new Error(`codex history sync receipt is no longer running: ${running.id}`);
          }
        },
        onTerminal: ({ state, error, retryable }) => finish(state, error, retryable)
      });
      if (!started) {
        if (retiredPendingGap) this.pendingGaps.add(running.perchSessionId);
        finish("failed", `codex session is not live: ${running.perchSessionId}`, false);
      }
    } catch (error) {
      if (retiredPendingGap) this.pendingGaps.add(running.perchSessionId);
      finish("failed", error instanceof Error ? error.message : String(error), false);
    }
  }

  private scheduleRetry(receipt: CodexHistorySyncRecord): void {
    if (this.stopped || this.retryTimers.has(receipt.id)) return;
    const index = this.retryIndexes.get(receipt.id) ?? 0;
    const delayMs = this.retryDelaysMs[index];
    if (delayMs === undefined) return;
    this.retryIndexes.set(receipt.id, index + 1);
    const timer = setTimeout(() => {
      this.retryTimers.delete(receipt.id);
      if (this.stopped) return;
      const latest = this.stateDb.codexHistorySyncs.find(receipt.id);
      if (latest?.state === "failed") this.start(latest);
    }, delayMs);
    timer.unref?.();
    this.retryTimers.set(receipt.id, timer);
  }

  private clearRetryTimer(receiptId: string): void {
    const timer = this.retryTimers.get(receiptId);
    if (!timer) return;
    clearTimeout(timer);
    this.retryTimers.delete(receiptId);
  }

  private startGap(receipt: CodexHistorySyncRecord): CodexHistorySyncRecord {
    return this.createAndStart(
      {
        runtimeKind: receipt.runtimeKind,
        runtimeId: receipt.runtimeId,
        runtimeGeneration: receipt.runtimeGeneration,
        perchSessionId: receipt.perchSessionId,
        providerSessionId: receipt.providerSessionId
      },
      "gap"
    );
  }

  private schedulePendingGap(receipt: CodexHistorySyncRecord): void {
    if (
      this.stopped ||
      !this.pendingGaps.has(receipt.perchSessionId) ||
      this.gapTimers.has(receipt.perchSessionId)
    ) {
      return;
    }
    const timer = setTimeout(() => {
      this.gapTimers.delete(receipt.perchSessionId);
      if (this.stopped || !this.pendingGaps.has(receipt.perchSessionId)) return;
      const processReceipt = this.processReceipts.get(receipt.perchSessionId);
      const latest = processReceipt
        ? this.stateDb.codexHistorySyncs.find(processReceipt.receiptId)
        : undefined;
      if (latest && isTerminalSuccess(latest.state)) this.startGap(latest);
    }, 0);
    timer.unref?.();
    this.gapTimers.set(receipt.perchSessionId, timer);
  }
}

function isEligible(
  runtime: RuntimeRecord | OwnerRuntimeRecord
): runtime is (RuntimeRecord | OwnerRuntimeRecord) & {
  ptySessionId: string;
  providerSessionId: string;
} {
  return (
    runtime.state === "live" &&
    runtime.provider === "codex" &&
    typeof runtime.ptySessionId === "string" &&
    runtime.ptySessionId.length > 0 &&
    typeof runtime.providerSessionId === "string" &&
    runtime.providerSessionId.length > 0
  );
}

function isTerminalSuccess(state: CodexHistorySyncRecord["state"]): boolean {
  return state === "succeeded" || state === "truncated";
}
