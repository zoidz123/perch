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

export class CodexHistorySyncCoordinator {
  private readonly retryDelaysMs: number[];
  private readonly runs = new Map<string, symbol>();
  private readonly retryIndexes = new Map<string, number>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
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
    const processReceipt = this.processReceipts.get(sessionId);
    const latest = processReceipt
      ? this.stateDb.codexHistorySyncs.find(processReceipt.receiptId)
      : undefined;
    if (latest) {
      this.processReceipts.set(sessionId, {
        receiptId: latest.id,
        providerSessionId: latest.providerSessionId
      });
      if (!isTerminalSuccess(latest.state)) this.start(latest);
      return latest;
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
    this.retryTimers.clear();
    this.runs.clear();
    this.processReceipts.clear();
  }

  private startForRuntime(
    input: Parameters<StateDb["codexHistorySyncs"]["create"]>[0]
  ): CodexHistorySyncRecord {
    const processReceipt = this.processReceipts.get(input.perchSessionId);
    if (processReceipt?.providerSessionId === input.providerSessionId) {
      const existing = this.stateDb.codexHistorySyncs.find(processReceipt.receiptId);
      if (existing) {
        if (!isTerminalSuccess(existing.state)) this.start(existing);
        return existing;
      }
    }
    const receipt = this.stateDb.codexHistorySyncs.create(input);
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
      }
    };

    try {
      const started = this.adapter.startHistoryCatchUp(running.perchSessionId, {
        syncId: running.id,
        threadId: running.providerSessionId,
        cursor: running.cursor ?? null,
        onPage: ({ cursor, accepted }) => {
          if (!this.stateDb.codexHistorySyncs.recordPage(running.id, cursor, accepted)) {
            throw new Error(`codex history sync receipt is no longer running: ${running.id}`);
          }
        },
        onTerminal: ({ state, error, retryable }) => finish(state, error, retryable)
      });
      if (!started) {
        finish("failed", `codex session is not live: ${running.perchSessionId}`, false);
      }
    } catch (error) {
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
