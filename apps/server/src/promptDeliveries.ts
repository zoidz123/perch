import type { TimelineItem } from "@perch/shared";
import type { PromptDeliveryRecord, StateDb } from "./stateDb.js";
import { TIMELINE_TEXT_MAX_LENGTH } from "./timeline.js";

const DEFAULT_RECEIPT_TIMEOUT_MS = 15_000;

export type PromptDeliverySource = "human" | "agent";

type PromptDeliveryTrackerOptions = {
  receiptTimeoutMs?: number;
  restartRecoveryTimeoutMs?: number;
  onAccepted?: (delivery: PromptDeliveryRecord) => void;
  onUnknown?: (delivery: PromptDeliveryRecord) => void;
};

// Durable boundary around PTY prompt submission. It records intent before any
// keystrokes, then waits for Claude's UserPromptSubmit hook or the matching
// transcript user row. A timeout records uncertainty but never retries input.
export class PromptDeliveryTracker {
  private readonly receiptTimeoutMs: number;
  private readonly restartRecoveryTimeoutMs: number;
  private readonly onAccepted?: (delivery: PromptDeliveryRecord) => void;
  private readonly onUnknown?: (delivery: PromptDeliveryRecord) => void;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly stateDb: StateDb,
    options: PromptDeliveryTrackerOptions = {}
  ) {
    this.receiptTimeoutMs = options.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
    this.restartRecoveryTimeoutMs = options.restartRecoveryTimeoutMs ?? 60_000;
    this.onAccepted = options.onAccepted;
    this.onUnknown = options.onUnknown;

    // Retry accepted projections that may have been interrupted after the
    // receipt commit. Callback completion is marked only after it succeeds.
    for (const delivery of this.stateDb.promptDeliveries.list()) {
      if (delivery.state === "accepted" && !delivery.acceptedNotifiedAt) {
        this.notifyAccepted(delivery);
        continue;
      }
      if (delivery.state === "delivery_unknown" && !delivery.unknownNotifiedAt) {
        if (delivery.unknownFromState === "queued") this.notifyUnknown(delivery);
        else this.scheduleRestartFallback(delivery.id);
        continue;
      }
      if (delivery.state !== "queued" && delivery.state !== "typing" && delivery.state !== "submitted") {
        continue;
      }
      this.stateDb.promptDeliveries.markUnknown(
        delivery.id,
        "server restarted before prompt acceptance was confirmed; not resent"
      );
      const unknown = this.stateDb.promptDeliveries.find(delivery.id);
      if (unknown?.unknownFromState === "queued") this.notifyUnknown(unknown);
      else if (unknown) this.scheduleRestartFallback(unknown.id);
    }
  }

  create(
    sessionId: string,
    text: string,
    source: PromptDeliverySource,
    options: { allowLateReceipt?: boolean } = {}
  ): PromptDeliveryRecord {
    const runtime = this.stateDb.runtimes.findBySession(sessionId);
    const ownerRuntime = runtime ? undefined : this.stateDb.ownerRuntimes.findBySession(sessionId);
    return this.stateDb.promptDeliveries.create({
      perchSessionId: sessionId,
      promptText: text,
      source,
      ...(options.allowLateReceipt ? { allowLateReceipt: true } : {}),
      ...(runtime ? { runtimeGeneration: runtime.generation, taskId: runtime.taskId } : {}),
      ...(ownerRuntime ? { runtimeGeneration: ownerRuntime.generation } : {})
    });
  }

  markTyping(id: string): void {
    this.stateDb.promptDeliveries.markTyping(id);
  }

  markSubmitted(id: string, receiptTimeoutMs: number | null = this.receiptTimeoutMs): void {
    const delivery = this.stateDb.promptDeliveries.markSubmitted(id);
    if (!delivery || delivery.state === "accepted") return;
    this.clearTimer(id);
    if (receiptTimeoutMs === null) return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      const unknown = this.stateDb.promptDeliveries.markUnknown(
        id,
        "Claude did not acknowledge the submitted prompt before the receipt timeout; not resent"
      );
      if (unknown?.state === "delivery_unknown") this.notifyUnknown(unknown);
    }, receiptTimeoutMs);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  markUnknown(id: string, reason: string): void {
    this.clearTimer(id);
    const delivery = this.stateDb.promptDeliveries.markUnknown(id, reason);
    if (delivery?.state === "delivery_unknown") this.notifyUnknown(delivery);
  }

  acknowledgeHook(sessionId: string, prompt: string, receiptId?: string): PromptDeliveryRecord | undefined {
    return this.accept({
      perchSessionId: sessionId,
      promptText: prompt,
      receiptKind: "user_prompt_submit",
      ...(receiptId ? { receiptId } : {})
    });
  }

  acknowledgeTimeline(item: TimelineItem, timestampAuthentic = true): PromptDeliveryRecord | undefined {
    if (item.kind !== "user" || !item.text || !timestampAuthentic) return undefined;
    return this.accept({
      perchSessionId: item.sessionId,
      promptText: item.text,
      receiptKind: "transcript",
      receiptId: item.id,
      allowObservedPrefix:
        item.text.length === TIMELINE_TEXT_MAX_LENGTH + 1 && item.text.endsWith("…"),
      observedAt: item.at
    });
  }

  finishRestartCatchUp(sessionId: string): void {
    for (const delivery of this.stateDb.promptDeliveries.list(sessionId)) {
      if (delivery.state === "delivery_unknown" && !delivery.unknownNotifiedAt) {
        this.clearTimer(delivery.id);
        this.notifyUnknown(delivery);
      }
    }
  }

  markSessionEnded(sessionId: string): void {
    for (const delivery of this.stateDb.promptDeliveries.list(sessionId)) {
      if (delivery.state === "queued" || delivery.state === "typing" || delivery.state === "submitted") {
        this.markUnknown(delivery.id, "Claude session ended before prompt acceptance was confirmed; not resent");
      }
    }
  }

  reconcileActiveSessions(previousSessionIds: Set<string>, activeSessionIds: Set<string>): void {
    for (const delivery of this.stateDb.promptDeliveries.list()) {
      if (
        previousSessionIds.has(delivery.perchSessionId) &&
        !activeSessionIds.has(delivery.perchSessionId) &&
        (delivery.state === "queued" || delivery.state === "typing" || delivery.state === "submitted")
      ) {
        this.markUnknown(delivery.id, "Claude session disappeared before prompt acceptance was confirmed; not resent");
      }
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private accept(input: Parameters<StateDb["promptDeliveries"]["acceptMatch"]>[0]): PromptDeliveryRecord | undefined {
    const acceptance = this.stateDb.promptDeliveries.acceptMatch(input);
    if (!acceptance) return undefined;
    this.clearTimer(acceptance.delivery.id);
    if (!acceptance.delivery.acceptedNotifiedAt) this.notifyAccepted(acceptance.delivery);
    return acceptance.delivery;
  }

  private notifyAccepted(delivery: PromptDeliveryRecord): void {
    try {
      this.onAccepted?.(delivery);
      this.stateDb.promptDeliveries.markAcceptedNotified(delivery.id);
    } catch {
      // Startup retries any accepted row whose projection did not finish.
    }
  }

  private scheduleRestartFallback(id: string): void {
    this.clearTimer(id);
    const timer = setTimeout(() => {
      this.timers.delete(id);
      const delivery = this.stateDb.promptDeliveries.find(id);
      if (delivery?.state === "delivery_unknown" && !delivery.unknownNotifiedAt) {
        this.notifyUnknown(delivery);
      }
    }, this.restartRecoveryTimeoutMs);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private notifyUnknown(delivery: PromptDeliveryRecord): void {
    try {
      this.onUnknown?.(delivery);
      this.stateDb.promptDeliveries.markUnknownNotified(delivery.id);
    } catch {
      // The durable unknown state remains authoritative even if surfacing it fails.
    }
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }
}
