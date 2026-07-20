import { createHash } from "node:crypto";
import type { PendingClaudeInteraction } from "@perch/shared";
import type { FleetMonitor } from "./fleetMonitor.js";
import type { HookEventPayload } from "./hooks.js";
import type { ClaudeInteractionRecord } from "./stateDb.js";
import type { TaskStore } from "./tasks.js";

const DEFAULT_DEADLINE_MS = 9 * 60_000;

export class ClaudeInteractionCoordinator {
  private readonly deadlineMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;

  constructor(
    private readonly tasks: TaskStore,
    private readonly monitor: FleetMonitor,
    options: { deadlineMs?: number; pollMs?: number; now?: () => number } = {}
  ) {
    const requested = Number.isFinite(options.deadlineMs) ? options.deadlineMs! : DEFAULT_DEADLINE_MS;
    this.deadlineMs = Math.max(100, Math.min(requested, DEFAULT_DEADLINE_MS));
    this.pollMs = options.pollMs ?? 50;
    this.now = options.now ?? Date.now;
  }

  register(sessionId: string, payload: HookEventPayload): { record?: ClaudeInteractionRecord; error?: string } {
    const event = payload.hook_event_name;
    const kind = event === "Elicitation" ? "elicitation" : event === "ElicitationResult" ? "elicitation_result" : undefined;
    if (!kind) return { error: "not_elicitation" };
    const body = payload as Record<string, unknown>;
    const mode = body.mode === "form" || body.mode === "url" ? body.mode : undefined;
    if (!mode || typeof body.elicitation_id !== "string") return { error: "invalid_elicitation_schema" };
    const providerRequestId = body.elicitation_id;
    const prior = this.tasks.stateDb.claudeInteractions.findProvider(sessionId, kind, providerRequestId);
    if (prior) {
      this.monitor.restorePendingClaudeInteraction(sessionId, pendingInteraction(prior));
      return { record: prior };
    }
    const task = this.tasks.list().find((candidate) => candidate.sessionId === sessionId);
    const runtime = this.tasks.stateDb.runtimes.findBySession(sessionId) ?? this.tasks.stateDb.ownerRuntimes.findBySession(sessionId);
    const record = this.tasks.stateDb.claudeInteractions.create({
      kind,
      state: "waiting",
      perchSessionId: sessionId,
      claudeSessionId: typeof body.session_id === "string" ? body.session_id : undefined,
      providerRequestId,
      payload: durableElicitationPayload(body),
      payloadHash: hash(stableStringify(body)),
      summary: kind === "elicitation" ? `MCP ${String(body.mcp_server_name ?? "server")} requests input` : "MCP elicitation result needs confirmation",
      ...(runtime ? { runtimeGeneration: runtime.generation } : {}),
      ...(task ? { taskId: task.id } : {}),
      expiresAt: new Date(this.now() + this.deadlineMs).toISOString()
    });
    this.monitor.setPendingClaudeInteraction(sessionId, pendingInteraction(record));
    this.recordTask(record, "needs_decision", record.summary);
    return { record };
  }

  observePermissionDenied(sessionId: string, payload: HookEventPayload): ClaudeInteractionRecord {
    const body = payload as Record<string, unknown>;
    const providerRequestId = typeof body.tool_use_id === "string"
      ? body.tool_use_id
      : `denied:${hash(stableStringify(body))}`;
    const prior = this.tasks.stateDb.claudeInteractions.findProvider(sessionId, "permission_denied", providerRequestId);
    if (prior) return prior;
    const task = this.tasks.list().find((candidate) => candidate.sessionId === sessionId);
    const runtime = this.tasks.stateDb.runtimes.findBySession(sessionId) ?? this.tasks.stateDb.ownerRuntimes.findBySession(sessionId);
    const record = this.tasks.stateDb.claudeInteractions.create({
      kind: "permission_denied",
      state: "observed",
      perchSessionId: sessionId,
      claudeSessionId: typeof body.session_id === "string" ? body.session_id : undefined,
      providerRequestId,
      payload: pick(body, ["session_id", "tool_use_id", "tool_name", "permission_mode", "cwd"]),
      payloadHash: hash(stableStringify(body)),
      summary: `${String(body.tool_name ?? "Claude tool")} permission was denied`,
      ...(runtime ? { runtimeGeneration: runtime.generation } : {}),
      ...(task ? { taskId: task.id } : {})
    });
    return record;
  }

  recordManualGate(sessionId: string, summary: string, providerRequestId: string): ClaudeInteractionRecord {
    const prior = this.tasks.stateDb.claudeInteractions.findProvider(sessionId, "pty_manual_gate", providerRequestId);
    if (prior) return prior;
    const task = this.tasks.list().find((candidate) => candidate.sessionId === sessionId);
    const runtime = this.tasks.stateDb.runtimes.findBySession(sessionId) ?? this.tasks.stateDb.ownerRuntimes.findBySession(sessionId);
    const record = this.tasks.stateDb.claudeInteractions.create({
      kind: "pty_manual_gate", state: "local_fallback", perchSessionId: sessionId,
      providerRequestId, payload: { source: "screen" }, payloadHash: hash(providerRequestId), summary,
      ...(runtime ? { runtimeGeneration: runtime.generation } : {}), ...(task ? { taskId: task.id } : {}),
      failureReason: "This prompt occurs before Claude hooks can authorize it; resolve it manually in the local PTY"
    });
    this.recordTask(record, "blocked", record.failureReason!);
    return record;
  }

  respond(sessionId: string, id: string, action: "accept" | "decline" | "cancel", content: Record<string, unknown> | undefined, actor: string) {
    const record = this.tasks.stateDb.claudeInteractions.find(id);
    if (!record || record.perchSessionId !== sessionId) return { status: 409, body: { error: "The Claude interaction has changed" } };
    const stale = this.staleGeneration(record);
    if (stale) return { status: 409, body: { error: stale, reason: "stale_generation" } };
    if (action === "accept" && interactionMode(record) === "form") {
      const error = validateForm(record.payload.requested_schema, content);
      if (error) return { status: 400, body: { error } };
    }
    const result = this.tasks.stateDb.claudeInteractions.respond(id, action, content, actor);
    if (!result.record || result.outcome === "conflict") {
      return { status: 409, body: { error: "The response is stale or conflicts with an earlier response" } };
    }
    this.monitor.restorePendingClaudeInteraction(sessionId, pendingInteraction(result.record));
    return { status: 202, body: { ok: true, pending: true, idempotent: result.outcome === "idempotent", request: result.record } };
  }

  async wait(id: string, connected: () => boolean = () => true): Promise<ClaudeInteractionRecord> {
    while (true) {
      const record = this.tasks.stateDb.claudeInteractions.find(id);
      if (!record) throw new Error("Claude interaction disappeared");
      if (record.state !== "waiting") return record;
      if (!connected() || (record.expiresAt && this.now() >= Date.parse(record.expiresAt))) {
        const reason = connected() ? "Remote interaction deadline expired; use Claude locally" : "Hook connection closed; use Claude locally";
        const fallback = this.tasks.stateDb.claudeInteractions.transition(id, "waiting", connected() ? "expired" : "local_fallback", reason) ?? record;
        this.monitor.restorePendingClaudeInteraction(record.perchSessionId, pendingInteraction(fallback));
        this.recordTask(fallback, "blocked", reason);
        return fallback;
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  hookOutput(record: ClaudeInteractionRecord): Record<string, unknown> | undefined {
    if (record.state !== "response_sent" || !record.responseAction) return undefined;
    return { hookSpecificOutput: {
      hookEventName: record.kind === "elicitation" ? "Elicitation" : "ElicitationResult",
      action: record.responseAction,
      ...(record.responseAction === "accept" && record.responseContent ? { content: record.responseContent } : {})
    } };
  }

  confirmLaterActivity(sessionId: string, event: string): void {
    if (!["PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"].includes(event)) return;
    const current = this.tasks.stateDb.claudeInteractions.effective().find((item) => item.perchSessionId === sessionId);
    if (current?.state === "response_sent") {
      this.tasks.stateDb.claudeInteractions.transition(current.id, "response_sent", "confirmed");
      this.monitor.resolveClaudeInteraction(sessionId);
    }
  }

  replay(): void {
    for (const record of this.tasks.stateDb.claudeInteractions.effective()) {
      if (record.state === "waiting" && record.expiresAt && this.now() >= Date.parse(record.expiresAt)) {
        this.tasks.stateDb.claudeInteractions.transition(record.id, "waiting", "expired", "Remote interaction expired while Perch was offline");
        this.monitor.resolveClaudeInteraction(record.perchSessionId);
        continue;
      }
      if (isActionableInteractionState(record.state)) {
        this.monitor.restorePendingClaudeInteraction(record.perchSessionId, pendingInteraction(record));
      } else {
        // Older servers replayed observed and terminal evidence into the
        // pending map. Clear that legacy gate during startup while preserving
        // the durable record in claude_interactions.
        this.monitor.resolveClaudeInteraction(record.perchSessionId);
      }
    }
  }

  list(): ClaudeInteractionRecord[] { return this.tasks.stateDb.claudeInteractions.effective(); }

  private staleGeneration(record: ClaudeInteractionRecord): string | undefined {
    if (record.runtimeGeneration === undefined) return undefined;
    const current = record.taskId ? this.tasks.stateDb.runtimes.latestForTask(record.taskId) : this.tasks.stateDb.runtimes.findBySession(record.perchSessionId) ?? this.tasks.stateDb.ownerRuntimes.findBySession(record.perchSessionId);
    return !current || current.generation !== record.runtimeGeneration ? `Claude interaction belongs to stale runtime generation ${record.runtimeGeneration}` : undefined;
  }

  private recordTask(record: ClaudeInteractionRecord, kind: "needs_decision" | "blocked", message: string): void {
    if (!record.taskId) return;
    try { this.tasks.recordEvent(record.taskId, { kind, source: "system", message, data: { interactionId: record.id, interactionKind: record.kind, runtimeGeneration: record.runtimeGeneration } }); } catch {}
  }
}

function isActionableInteractionState(state: ClaudeInteractionRecord["state"]): boolean {
  return state === "waiting" || state === "response_sent";
}

export function pendingInteraction(record: ClaudeInteractionRecord): PendingClaudeInteraction {
  const payload = record.payload;
  return {
    id: record.id, requestVersion: 1, kind: record.kind, state: record.state, summary: record.summary,
    at: record.createdAt, providerRequestId: record.providerRequestId,
    ...(interactionMode(record) ? { mode: interactionMode(record)! } : {}),
    ...(typeof payload.message === "string" ? { message: payload.message } : {}),
    ...(typeof payload.url === "string" ? { url: payload.url } : {}),
    ...(isRecord(payload.requested_schema) ? { requestedSchema: payload.requested_schema } : {}),
    ...(payload.action === "accept" || payload.action === "decline" || payload.action === "cancel" ? { proposedAction: payload.action } : {}),
    ...(isRecord(payload.content) ? { proposedContent: payload.content } : {}),
    ...(record.responseAction ? { responseAction: record.responseAction } : {}),
    allowedActions: record.state === "waiting" ? ["accept", "decline", "cancel"] : [],
    remoteResolutionUnavailable: !["waiting", "response_sent"].includes(record.state),
    runtimeGeneration: record.runtimeGeneration, taskId: record.taskId, failureReason: record.failureReason
  };
}

export function publicInteraction(record: ClaudeInteractionRecord): Record<string, unknown> {
  const { payload: _payload, responseContent: _responseContent, ...redacted } = record;
  return { ...redacted, payloadHash: record.payloadHash, hasResponseContent: Boolean(record.responseContent) };
}

function interactionMode(record: ClaudeInteractionRecord): "form" | "url" | undefined { return record.payload.mode === "form" || record.payload.mode === "url" ? record.payload.mode : undefined; }
function validateForm(schema: unknown, content: Record<string, unknown> | undefined): string | undefined {
  if (!isRecord(schema) || !isRecord(content)) return "Accepted form elicitation requires structured content";
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
  for (const key of required) if (!(key in content)) return `Missing required form field: ${key}`;
  return undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function durableElicitationPayload(body: Record<string, unknown>): Record<string, unknown> {
  return pick(body, ["session_id", "mcp_server_name", "message", "mode", "elicitation_id", "requested_schema", "url", "action", "content"]);
}
function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function stableStringify(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`; if (isRecord(value)) return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`; return JSON.stringify(value); }
