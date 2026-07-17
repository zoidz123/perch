import { randomUUID } from "node:crypto";
import type { Task, TaskEventKind, TaskEventSource } from "@perch/shared";
import { isInjectedCrash } from "./failureInjection.js";
import type { NotificationChannel, NotificationOutboxRecord, StateDb } from "./stateDb.js";

export type TaskEventDelivery = {
  task: Task;
  event: {
    kind: TaskEventKind;
    message?: string;
    source: TaskEventSource;
    data?: Record<string, unknown>;
  };
};

export type OutboxWorkerOptions = {
  stateDb: StateDb;
  deliver: Record<NotificationChannel, (delivery: TaskEventDelivery) => void | Promise<void>>;
  intervalMs?: number;
  claimTtlMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  retentionMs?: number;
  now?: () => number;
  beforeDelivery?: (intent: NotificationOutboxRecord) => void | Promise<void>;
};

export class OutboxWorker {
  private readonly intervalMs: number;
  private readonly claimTtlMs: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private draining?: Promise<void>;
  private lastPruneMs = 0;

  constructor(private readonly options: OutboxWorkerOptions) {
    this.intervalMs = options.intervalMs ?? 500;
    this.claimTtlMs = options.claimTtlMs ?? 30_000;
    this.maxAttempts = options.maxAttempts ?? 6;
    this.baseBackoffMs = options.baseBackoffMs ?? 1_000;
    this.retentionMs = options.retentionMs ?? 24 * 60 * 60_000;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    const tick = () =>
      void this.drain().catch((error) => {
        console.error(`perch: outbox drain failed: ${errorText(error)}`);
      });
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.draining?.catch(() => {});
  }

  drain(): Promise<void> {
    if (!this.draining) {
      this.draining = this.drainAvailable().finally(() => {
        this.draining = undefined;
      });
    }
    return this.draining;
  }

  private async drainAvailable(): Promise<void> {
    this.pruneSettled();
    for (;;) {
      const nowMs = this.now();
      const token = randomUUID();
      const intent = this.options.stateDb.outbox.claim({
        token,
        now: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + this.claimTtlMs).toISOString()
      });
      if (!intent) return;
      try {
        await this.options.beforeDelivery?.(intent);
        await this.options.deliver[intent.channel](parseDelivery(intent));
        this.options.stateDb.outbox.deliver(intent.id, token, new Date(this.now()).toISOString());
      } catch (error) {
        if (isInjectedCrash(error)) return;
        const terminal = intent.attempts >= this.maxAttempts;
        const backoff = Math.min(60_000, this.baseBackoffMs * 2 ** Math.max(0, intent.attempts - 1));
        this.options.stateDb.outbox.retry({
          id: intent.id,
          token,
          error: errorText(error),
          availableAt: new Date(this.now() + backoff).toISOString(),
          terminal
        });
      }
    }
  }

  // Retention rides the drain loop but sweeps at most once a minute: settled
  // rows older than retentionMs age out; pending/claimed rows never do.
  private pruneSettled(): void {
    const nowMs = this.now();
    if (nowMs - this.lastPruneMs < 60_000) return;
    this.lastPruneMs = nowMs;
    try {
      this.options.stateDb.outbox.prune(new Date(nowMs - this.retentionMs).toISOString());
    } catch {
      // Retention is best-effort; delivery must never stall on it.
    }
  }
}

function parseDelivery(intent: NotificationOutboxRecord): TaskEventDelivery {
  const task = intent.payload.task;
  const event = intent.payload.event;
  if (!task || typeof task !== "object" || !event || typeof event !== "object") {
    throw new Error(`invalid ${intent.channel} outbox payload`);
  }
  return intent.payload as TaskEventDelivery;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}
