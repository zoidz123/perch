import type { NativeChildRunState, NativeChildRunSummary } from "@perch/shared";
import type { StateDb } from "./stateDb.js";

export type NativeChildRunObservation = NativeChildRunSummary;

type NativeProtocolItem = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function childState(value: unknown): NativeChildRunState {
  switch (value) {
    case "pendingInit":
      return "waiting";
    case "running":
      return "running";
    case "interrupted":
      return "interrupted";
    case "completed":
      return "completed";
    case "errored":
      return "failed";
    // Both are terminal but prove neither completion nor error. Mapping them
    // to "unknown" would keep a torn-down child durably stored as running.
    case "shutdown":
    case "notFound":
      return "interrupted";
    default:
      return "unknown";
  }
}

function activityState(value: unknown): NativeChildRunState {
  switch (value) {
    case "started":
    case "interacted":
      return "running";
    case "interrupted":
      return "interrupted";
    default:
      return "unknown";
  }
}

function callState(value: unknown): NativeChildRunState {
  switch (value) {
    case "inProgress":
      return "running";
    case "failed":
      return "failed";
    default:
      // A completed collab call only says that the parent tool invocation
      // settled. It does not prove that the child itself is complete.
      return "unknown";
  }
}

function protocol(itemType: NativeChildRunSummary["protocol"]["itemType"], item: NativeProtocolItem, event?: string) {
  return {
    itemType,
    ...(asNonEmptyString(item.id) ? { itemId: asNonEmptyString(item.id) } : {}),
    ...(event ? { event } : {})
  };
}

// Parses only the documented, non-content native collaboration fields.
// Unknown item shapes deliberately return no observation, preserving the
// root-only behavior that predates native Codex multi-agent support.
export function parseNativeChildRunObservations(input: {
  item: unknown;
  rootThreadId: string;
  observedAt?: string;
}): NativeChildRunObservation[] {
  const item = asRecord(input.item);
  if (!item) return [];
  const observedAt = input.observedAt ?? new Date().toISOString();
  const type = asNonEmptyString(item.type);

  if (type === "subAgentActivity") {
    const childThreadId = asNonEmptyString(item.agentThreadId);
    if (!childThreadId) return [];
    const event = asNonEmptyString(item.kind);
    return [{
      childThreadId,
      parentThreadId: asNonEmptyString(item.parentThreadId) ?? input.rootThreadId,
      ...(asNonNegativeInteger(item.depth) !== undefined ? { depth: asNonNegativeInteger(item.depth) } : {}),
      ...(asNonEmptyString(item.agentPath) ? { path: asNonEmptyString(item.agentPath) } : {}),
      ...(asNonEmptyString(item.agentRole) ? { role: asNonEmptyString(item.agentRole) } : {}),
      state: activityState(event),
      observedAt,
      protocol: protocol("subAgentActivity", item, event)
    }];
  }

  if (type !== "collabAgentToolCall") return [];
  const senderThreadId = asNonEmptyString(item.senderThreadId);
  if (!senderThreadId || senderThreadId !== input.rootThreadId || !Array.isArray(item.receiverThreadIds)) return [];
  const agentsStates = asRecord(item.agentsStates);
  const event = asNonEmptyString(item.status);
  return item.receiverThreadIds.flatMap((receiver) => {
    const childThreadId = asNonEmptyString(receiver);
    if (!childThreadId) return [];
    const stateRecord = asRecord(agentsStates?.[childThreadId]);
    return [{
      childThreadId,
      parentThreadId: senderThreadId,
      state: stateRecord ? childState(stateRecord.status) : callState(event),
      observedAt,
      protocol: protocol("collabAgentToolCall", item, event)
    }];
  });
}

// Only the root session is routable to a durable Perch runtime. Native child
// ids are provider-local observations, never adapter sessions or task ids.
export function recordNativeChildRunObservation(
  stateDb: StateDb,
  sessionId: string,
  observation: NativeChildRunObservation
): void {
  const runtime = stateDb.runtimes.findBySession(sessionId);
  if (runtime) {
    stateDb.nativeChildRuns.upsert({
      outerRuntimeKind: "task",
      outerRuntimeId: runtime.id,
      outerRuntimeGeneration: runtime.generation,
      ...observation
    });
    return;
  }
  const ownerRuntime = stateDb.ownerRuntimes.findBySession(sessionId);
  if (!ownerRuntime) return;
  stateDb.nativeChildRuns.upsert({
    outerRuntimeKind: "owner",
    outerRuntimeId: ownerRuntime.id,
    outerRuntimeGeneration: ownerRuntime.generation,
    ...observation
  });
}

export function nativeChildRunSummary(stateDb: StateDb, sessionId: string): NativeChildRunSummary[] {
  const runtime = stateDb.runtimes.findBySession(sessionId);
  if (runtime) {
    return stateDb.nativeChildRuns.listForOuter("task", runtime.id, runtime.generation);
  }
  const ownerRuntime = stateDb.ownerRuntimes.findBySession(sessionId);
  return ownerRuntime
    ? stateDb.nativeChildRuns.listForOuter("owner", ownerRuntime.id, ownerRuntime.generation)
    : [];
}
