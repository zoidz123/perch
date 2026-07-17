import { randomUUID } from "node:crypto";
import { isInjectedCrash } from "./failureInjection.js";
import type { OperationRecord, StateDb } from "./stateDb.js";

export type OperationExecutionContext = {
  checkpoint(payload: Record<string, unknown>): OperationRecord;
  boundary(name: "beforeLaunch" | "afterLaunch"): void | Promise<void>;
};

export type TaskSchedulerOptions = {
  stateDb: StateDb;
  execute?: (operation: OperationRecord, context: OperationExecutionContext) => void | Promise<void>;
  onFailure?: (operation: OperationRecord, error: unknown) => void | Promise<void>;
  intervalMs?: number;
  claimTtlMs?: number;
  now?: () => number;
  beforeClaim?: (operationId?: string) => void | Promise<void>;
  afterClaim?: (operation: OperationRecord) => void | Promise<void>;
  boundary?: (name: "beforeLaunch" | "afterLaunch", operation: OperationRecord) => void | Promise<void>;
  operationKinds?: readonly string[];
};

export class TaskScheduler {
  private readonly intervalMs: number;
  private readonly claimTtlMs: number;
  private readonly now: () => number;
  private readonly operationKinds: readonly string[];
  private readonly inFlight = new Map<string, Promise<OperationRecord>>();
  private timer?: ReturnType<typeof setInterval>;
  private draining?: Promise<void>;

  constructor(private readonly options: TaskSchedulerOptions) {
    this.intervalMs = options.intervalMs ?? 500;
    this.claimTtlMs = options.claimTtlMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.operationKinds = options.operationKinds ?? ["dispatch"];
  }

  start(): void {
    if (this.timer) return;
    const tick = () =>
      void this.drain().catch((error) => {
        console.error(`perch: operation drain failed: ${errorText(error)}`);
      });
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref?.();
  }

  setExecutor(execute: NonNullable<TaskSchedulerOptions["execute"]>): void {
    this.options.execute = execute;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.inFlight.values()]);
    await this.draining?.catch(() => {});
  }

  create(input: {
    taskId: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    kind?: string;
  }): OperationRecord {
    return this.options.stateDb.operations.create({ ...input, kind: input.kind ?? "dispatch" });
  }

  run(operationId: string): Promise<OperationRecord> {
    const existing = this.inFlight.get(operationId);
    if (existing) return existing;
    const running = this.runUntilSettled(operationId).finally(() => this.inFlight.delete(operationId));
    this.inFlight.set(operationId, running);
    return running;
  }

  drain(): Promise<void> {
    if (!this.draining) {
      this.draining = this.drainPending().finally(() => {
        this.draining = undefined;
      });
    }
    return this.draining;
  }

  private async drainPending(): Promise<void> {
    for (;;) {
      const claimed = await this.claim();
      if (!claimed) return;
      await this.executeClaim(claimed).catch(() => {});
    }
  }

  private async runUntilSettled(operationId: string): Promise<OperationRecord> {
    for (;;) {
      const operation = this.options.stateDb.operations.find(operationId);
      if (!operation) throw new Error(`Unknown operation: ${operationId}`);
      if (operation.state === "succeeded") return operation;
      if (operation.state === "failed") throw new Error(operation.lastError ?? "operation failed");
      const claimed = await this.claim(operationId);
      if (claimed) return this.executeClaim(claimed);
      await delay(Math.min(25, this.intervalMs));
    }
  }

  private async claim(operationId?: string): Promise<OperationRecord | undefined> {
    await this.options.beforeClaim?.(operationId);
    const nowMs = this.now();
    const claimed = this.options.stateDb.operations.claim({
      ...(operationId ? { id: operationId } : { kinds: this.operationKinds }),
      token: randomUUID(),
      now: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + this.claimTtlMs).toISOString()
    });
    if (claimed && !this.operationKinds.includes(claimed.kind)) {
      this.options.stateDb.operations.fail(
        claimed.id,
        claimed.claimToken!,
        `unsupported operation kind: ${claimed.kind}`,
        new Date(nowMs).toISOString()
      );
      return undefined;
    }
    if (claimed) await this.options.afterClaim?.(claimed);
    return claimed;
  }

  private async executeClaim(operation: OperationRecord): Promise<OperationRecord> {
    const token = operation.claimToken!;
    let current = operation;
    // The claim is a renewable owner lease: a heartbeat well inside the TTL
    // keeps a legitimately slow launch (large-repo worktree acquire, daemon
    // prep, PTY spawn) owned, so reclaimers only ever take truly expired
    // leases whose owning process died mid-execution.
    const heartbeat = setInterval(() => {
      try {
        const nowMs = this.now();
        current = this.options.stateDb.operations.renew(
          current.id,
          token,
          new Date(nowMs + this.claimTtlMs).toISOString(),
          new Date(nowMs).toISOString()
        );
      } catch {
        // Claim lost to a reclaimer; the execution's next owned write throws.
      }
    }, Math.max(250, Math.floor(this.claimTtlMs / 3)));
    heartbeat.unref?.();
    const context: OperationExecutionContext = {
      checkpoint: (payload) => {
        current = this.options.stateDb.operations.updatePayload(
          current.id,
          token,
          payload,
          new Date(this.now()).toISOString()
        );
        return current;
      },
      boundary: (name) => this.options.boundary?.(name, current)
    };
    try {
      if (!this.options.execute) throw new Error("task scheduler executor is not configured");
      await this.options.execute(current, context);
      return this.options.stateDb.operations.succeed(current.id, token, new Date(this.now()).toISOString());
    } catch (error) {
      if (isInjectedCrash(error)) throw error;
      const failed = this.options.stateDb.operations.fail(
        current.id,
        token,
        errorText(error),
        new Date(this.now()).toISOString()
      );
      await this.options.onFailure?.(failed, error);
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}
