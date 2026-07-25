import type { CodexAppServerAdapter } from "./adapters/codexAppServerAdapter.js";
import type {
  CodexHistorySyncRecord,
  OwnerRuntimeRecord,
  RuntimeRecord,
  StateDb
} from "./stateDb.js";

export class CodexHistorySyncCoordinator {
  constructor(
    private readonly stateDb: StateDb,
    private readonly adapter: CodexAppServerAdapter
  ) {
    this.adapter.setHistoryCatchUpRequester((sessionId) => this.resumeForSession(sessionId));
  }

  startForTaskRuntime(runtime: RuntimeRecord): CodexHistorySyncRecord | undefined {
    if (!isEligible(runtime)) return undefined;
    return this.createAndStart({
      runtimeKind: "task",
      runtimeId: runtime.id,
      runtimeGeneration: runtime.generation,
      perchSessionId: runtime.ptySessionId,
      providerSessionId: runtime.providerSessionId
    });
  }

  startForOwnerRuntime(runtime: OwnerRuntimeRecord): CodexHistorySyncRecord | undefined {
    if (!isEligible(runtime)) return undefined;
    return this.createAndStart({
      runtimeKind: "owner",
      runtimeId: runtime.id,
      runtimeGeneration: runtime.generation,
      perchSessionId: runtime.ptySessionId,
      providerSessionId: runtime.providerSessionId
    });
  }

  resumeForSession(sessionId: string): CodexHistorySyncRecord | undefined {
    const latest = this.stateDb.codexHistorySyncs.latestForSession(sessionId);
    if (latest && !isTerminalSuccess(latest.state)) {
      this.start(latest);
      return latest;
    }

    const taskRuntime = this.stateDb.runtimes.findBySession(sessionId);
    if (taskRuntime) return this.startForTaskRuntime(taskRuntime);
    const ownerRuntime = this.stateDb.ownerRuntimes.findBySession(sessionId);
    if (ownerRuntime) return this.startForOwnerRuntime(ownerRuntime);
    return undefined;
  }

  private createAndStart(
    input: Parameters<StateDb["codexHistorySyncs"]["create"]>[0]
  ): CodexHistorySyncRecord {
    const receipt = this.stateDb.codexHistorySyncs.create(input);
    this.start(receipt);
    return receipt;
  }

  private start(receipt: CodexHistorySyncRecord): void {
    const running = this.stateDb.codexHistorySyncs.start(receipt.id);
    if (!running) return;
    const started = this.adapter.startHistoryCatchUp(running.perchSessionId, {
      syncId: running.id,
      threadId: running.providerSessionId,
      cursor: running.cursor ?? null,
      onPage: ({ cursor, accepted }) => {
        if (!this.stateDb.codexHistorySyncs.recordPage(running.id, cursor, accepted)) {
          throw new Error(`codex history sync receipt is no longer running: ${running.id}`);
        }
      },
      onTerminal: ({ state, error }) => {
        this.stateDb.codexHistorySyncs.finish(running.id, state, error);
      }
    });
    if (!started) {
      this.stateDb.codexHistorySyncs.finish(
        running.id,
        "failed",
        `codex session is not live: ${running.perchSessionId}`
      );
    }
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
