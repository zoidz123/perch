import { createHash, randomBytes } from "node:crypto";
import type { PendingApproval } from "@perch/shared";
import type { FleetMonitor } from "./fleetMonitor.js";
import type { HookEventPayload } from "./hooks.js";
import type { ClaudeApprovalRecord } from "./stateDb.js";
import type { TaskStore } from "./tasks.js";

export const CLAUDE_APPROVAL_VERSION = 1 as const;
export const CLAUDE_APPROVAL_DECISIONS = ["allow", "deny"] as const;
export type ClaudeApprovalDecision = (typeof CLAUDE_APPROVAL_DECISIONS)[number];

const DEFAULT_DEADLINE_MS = 9 * 60_000;
const MAX_DEADLINE_MS = 9 * 60_000;

export type ClaudeApprovalCoordinatorOptions = {
  deadlineMs?: number;
  now?: () => number;
  pollMs?: number;
};

export class ClaudeApprovalCoordinator {
  private readonly alwaysAllowSuggestions = new Map<string, Map<string, Record<string, unknown>>>();
  private readonly deadlineMs: number;
  private readonly now: () => number;
  private readonly pollMs: number;

  constructor(
    private readonly tasks: TaskStore,
    private readonly monitor: FleetMonitor,
    options: ClaudeApprovalCoordinatorOptions = {}
  ) {
    const requested = Number.isFinite(options.deadlineMs) ? options.deadlineMs! : DEFAULT_DEADLINE_MS;
    this.deadlineMs = Math.max(100, Math.min(requested, MAX_DEADLINE_MS));
    this.now = options.now ?? Date.now;
    this.pollMs = options.pollMs ?? 50;
  }

  recordPreToolUse(perchSessionId: string, payload: HookEventPayload): void {
    if (payload.hook_event_name !== "PreToolUse" || typeof payload.tool_use_id !== "string" || typeof payload.tool_name !== "string") return;
    const claudeSessionId = typeof payload.session_id === "string" && payload.session_id ? payload.session_id : `unlinked:${perchSessionId}`;
    const runtime = this.tasks.stateDb.runtimes.findBySession(perchSessionId) ?? this.tasks.stateDb.ownerRuntimes.findBySession(perchSessionId);
    this.tasks.stateDb.claudeToolOccurrences.record({
      perchSessionId, claudeSessionId, toolUseId: payload.tool_use_id, toolName: payload.tool_name,
      toolInputHash: sha256(stableStringify(asRecord(payload.tool_input))),
      ...(runtime ? { runtimeGeneration: runtime.generation } : {})
    });
  }

  register(perchSessionId: string, payload: HookEventPayload): { record: ClaudeApprovalRecord; created: boolean } {
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "action";
    const toolInput = asRecord(payload.tool_input);
    const toolInputHash = sha256(stableStringify(toolInput));
    const claudeSessionId = typeof payload.session_id === "string" && payload.session_id
      ? payload.session_id
      : `unlinked:${perchSessionId}`;
    const workerRuntime = this.tasks.stateDb.runtimes.findBySession(perchSessionId);
    const ownerRuntime = this.tasks.stateDb.ownerRuntimes.findBySession(perchSessionId);
    const generation = (workerRuntime ?? ownerRuntime)?.generation;
    const openRetry = this.tasks.stateDb.claudeApprovals.latestForSession(perchSessionId);
    if (openRetry && openRetry.interactionKind === "permission_request" && openRetry.claudeSessionId === claudeSessionId &&
        openRetry.toolName === toolName && openRetry.toolInputHash === toolInputHash &&
        openRetry.runtimeGeneration === generation && ["pending", "decided", "decision_sent"].includes(openRetry.state)) {
      this.monitor.restorePendingApproval(perchSessionId, pendingApproval(openRetry));
      return { record: openRetry, created: false };
    }
    const correlated = this.tasks.stateDb.claudeToolOccurrences.consumeMatch({
      perchSessionId, claudeSessionId, toolName, toolInputHash, runtimeGeneration: generation
    });
    const occurrence = correlated?.occurrence ?? this.tasks.stateDb.claudeToolOccurrences.nextOccurrence(perchSessionId, claudeSessionId);
    const promptIdentity = correlated?.toolUseId
      ?? `helper:${randomBytes(12).toString("hex")}:g${generation ?? "unlinked"}:n${occurrence}`;
    const prior = this.tasks.stateDb.claudeApprovals.latestForIdentity(perchSessionId, promptIdentity);
    if (prior && ["pending", "decided", "decision_sent"].includes(prior.state)) {
      this.monitor.restorePendingApproval(perchSessionId, pendingApproval(prior));
      return { record: prior, created: false };
    }

    const task = this.tasks.list().find((candidate) => candidate.sessionId === perchSessionId);
    const summary = permissionSummary(toolName, toolInput);
    const record = this.tasks.stateDb.claudeApprovals.create({
      interactionKind: "permission_request",
      hookEventName: "PermissionRequest",
      perchSessionId,
      claudeSessionId,
      promptIdentity,
      toolName,
      toolInput: redactPermissionInput(toolInput),
      toolInputHash,
      summary: summary.summary,
      ...(summary.command ? { command: summary.command } : {}),
      ...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}),
      ...(typeof payload.transcript_path === "string" ? { transcriptPath: payload.transcript_path } : {}),
      ...(generation !== undefined ? { runtimeGeneration: generation } : {}),
      ...(task ? { taskId: task.id } : {}),
      workerSessionId: perchSessionId,
      ...(task?.parentSessionId ? { parentSessionId: task.parentSessionId } : {}),
      decisionPolicy: "boss_only",
      expiresAt: new Date(this.now() + this.deadlineMs).toISOString()
    });
    const suggestions = validatedSuggestions(payload.permission_suggestions);
    if (suggestions.size > 0) this.alwaysAllowSuggestions.set(record.id, suggestions);
    const approval = pendingApproval(record, suggestions);
    this.monitor.setPendingApproval(perchSessionId, approval);
    this.monitor.publish({
      type: "approval_request",
      sessionId: perchSessionId,
      id: record.id,
      summary: record.summary,
      command: record.command,
      at: record.createdAt
    });
    return { record, created: true };
  }

  registerExitPlan(perchSessionId: string, payload: HookEventPayload): { record?: ClaudeApprovalRecord; created: boolean; error?: string } {
    if (payload.tool_name !== "ExitPlanMode" || payload.hook_event_name !== "PreToolUse") {
      return { created: false, error: "not_exit_plan_mode" };
    }
    const input = asRecord(payload.tool_input);
    const toolUseId = typeof payload.tool_use_id === "string" && payload.tool_use_id ? payload.tool_use_id : undefined;
    if (!toolUseId || typeof input.plan !== "string" || typeof input.planFilePath !== "string") {
      return { created: false, error: "invalid_exit_plan_schema" };
    }
    const prior = this.tasks.stateDb.claudeApprovals.latestForIdentity(perchSessionId, toolUseId);
    if (prior && ["pending", "decided", "decision_sent"].includes(prior.state)) {
      this.monitor.restorePendingApproval(perchSessionId, pendingApproval(prior));
      return { record: prior, created: false };
    }
    const task = this.tasks.list().find((candidate) => candidate.sessionId === perchSessionId);
    const workerRuntime = this.tasks.stateDb.runtimes.findBySession(perchSessionId);
    const ownerRuntime = this.tasks.stateDb.ownerRuntimes.findBySession(perchSessionId);
    const claudeSessionId = typeof payload.session_id === "string" && payload.session_id
      ? payload.session_id
      : `unlinked:${perchSessionId}`;
    const record = this.tasks.stateDb.claudeApprovals.create({
      interactionKind: "exit_plan_mode",
      hookEventName: "PreToolUse",
      perchSessionId,
      claudeSessionId,
      promptIdentity: toolUseId,
      toolName: "ExitPlanMode",
      toolInput: input,
      toolInputHash: sha256(stableStringify(input)),
      summary: "Claude is ready to leave plan mode",
      command: input.planFilePath,
      ...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}),
      ...(typeof payload.transcript_path === "string" ? { transcriptPath: payload.transcript_path } : {}),
      ...(workerRuntime || ownerRuntime ? { runtimeGeneration: (workerRuntime ?? ownerRuntime)!.generation } : {}),
      ...(task ? { taskId: task.id } : {}),
      workerSessionId: perchSessionId,
      ...(task?.parentSessionId ? { parentSessionId: task.parentSessionId } : {}),
      decisionPolicy: "boss_only",
      expiresAt: new Date(this.now() + this.deadlineMs).toISOString()
    });
    this.monitor.setPendingApproval(perchSessionId, pendingApproval(record));
    return { record, created: true };
  }

  replay(): void {
    this.tasks.stateDb.claudeToolOccurrences.prune(new Date(this.now() - 24 * 60 * 60_000).toISOString());
    for (const record of this.tasks.stateDb.claudeApprovals.effective()) {
      if (record.state === "pending" && this.now() >= Date.parse(record.expiresAt)) {
        this.tasks.stateDb.claudeApprovals.transition(record.id, "pending", "expired", {
          failureReason: "Remote approval deadline expired while Perch was offline"
        });
        continue;
      }
      if (["pending", "decided", "decision_sent", "expired", "local_fallback"].includes(record.state)) {
        this.monitor.restorePendingApproval(record.perchSessionId, pendingApproval(record));
      }
    }
  }

  list(): ClaudeApprovalRecord[] {
    return this.tasks.stateDb.claudeApprovals.effective();
  }

  latestForSession(sessionId: string): ClaudeApprovalRecord | undefined {
    return this.tasks.stateDb.claudeApprovals.latestForSession(sessionId);
  }

  decide(
    sessionId: string,
    requestId: string,
    decision: string,
    actor: string
  ): { status: number; body: Record<string, unknown> } {
    const record = this.tasks.stateDb.claudeApprovals.find(requestId);
    if (!record || record.perchSessionId !== sessionId) {
      return { status: 409, body: { error: "The Claude approval request has changed" } };
    }
    const stale = this.staleGeneration(record);
    if (stale) {
      return { status: 409, body: { error: stale, reason: "stale_generation" } };
    }
    let persistedDecision: "allow" | "deny" | "allow_always";
    let selectedPermission: Record<string, unknown> | undefined;
    if (decision === "allow" || decision === "deny") {
      persistedDecision = decision;
    } else if (decision.startsWith("allow_always:")) {
      selectedPermission = this.alwaysAllowSuggestions.get(requestId)?.get(decision.slice("allow_always:".length));
      if (!selectedPermission) return { status: 409, body: { error: "The exact always-allow suggestion is unavailable or changed" } };
      persistedDecision = "allow_always";
    } else {
      return { status: 400, body: { error: "Unsupported Claude permission decision" } };
    }
    const result = this.tasks.stateDb.claudeApprovals.decide(requestId, persistedDecision, actor, selectedPermission);
    if (result.outcome === "missing" || result.outcome === "conflict" || !result.record) {
      return { status: 409, body: { error: "The response is stale, duplicated with a different decision, or no longer remotely resolvable" } };
    }
    this.monitor.restorePendingApproval(sessionId, pendingApproval(result.record));
    return {
      status: 202,
      body: {
        ok: true,
        pending: true,
        idempotent: result.outcome === "idempotent",
        request: publicRecord(result.record)
      }
    };
  }

  async waitForDecision(requestId: string, connected: () => boolean = () => true): Promise<ClaudeApprovalRecord> {
    while (true) {
      const record = this.tasks.stateDb.claudeApprovals.find(requestId);
      if (!record) throw new Error("Claude approval request disappeared");
      if (record.state !== "pending") return record;
      if (!connected()) {
        return this.markLocalFallback(
          requestId,
          "Permission hook connection closed before a remote decision; use Claude's native local dialog"
        ) ?? record;
      }
      if (this.now() >= Date.parse(record.expiresAt)) {
        const expired = this.tasks.stateDb.claudeApprovals.transition(
          record.id,
          "pending",
          "expired",
          { failureReason: "Remote approval deadline expired; use Claude's native local dialog" }
        ) ?? this.tasks.stateDb.claudeApprovals.find(record.id)!;
        this.surfaceFallback(expired);
        return expired;
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  markLocalFallback(requestId: string, reason: string): ClaudeApprovalRecord | undefined {
    const record = this.tasks.stateDb.claudeApprovals.transition(
      requestId,
      "pending",
      "local_fallback",
      { failureReason: reason }
    );
    if (record) this.surfaceFallback(record);
    return record;
  }

  confirmLaterActivity(sessionId: string, eventName: string): void {
    if (!CONFIRMING_EVENTS.has(eventName)) return;
    const current = this.tasks.stateDb.claudeApprovals.latestForSession(sessionId);
    if (!current) return;
    if (eventName === "SessionEnd" && current.state === "pending") {
      this.tasks.stateDb.claudeApprovals.transition(current.id, "pending", "canceled", {
        failureReason: "Claude session ended before the permission was decided"
      });
      this.monitor.resolveApproval(sessionId);
      return;
    }
    if (current.state === "decision_sent") {
      const nextState = current.decision === "deny" ? "denied" : "continued";
      const confirmed = this.tasks.stateDb.claudeApprovals.transition(
        current.id,
        "decision_sent",
        nextState,
        { confirmedAt: new Date(this.now()).toISOString() }
      );
      if (confirmed) this.monitor.resolveApproval(sessionId);
      return;
    }
    if (["pending", "expired", "local_fallback"].includes(current.state)) {
      const fallback = current.state === "pending"
        ? this.tasks.stateDb.claudeApprovals.transition(
            current.id,
            "pending",
            "local_fallback",
            {
              failureReason: "Claude continued through its native local dialog",
              confirmedAt: new Date(this.now()).toISOString()
            }
          )
        : current;
      if (fallback) this.monitor.resolveApproval(sessionId);
    }
  }

  hookOutput(record: ClaudeApprovalRecord): Record<string, unknown> | undefined {
    if (record.state === "decided") {
      record = this.tasks.stateDb.claudeApprovals.transition(record.id, "decided", "decision_sent") ?? record;
      this.monitor.restorePendingApproval(record.perchSessionId, pendingApproval(record));
    }
    if (record.state !== "decision_sent" || !record.decision) return undefined;
    if (record.interactionKind === "exit_plan_mode") {
      return {
        hookSpecificOutput: record.decision === "allow"
          ? {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              permissionDecisionReason: "Plan accepted by the boss in Perch",
              updatedInput: record.toolInput
            }
          : {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: "Plan declined by the boss in Perch"
            }
      };
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: record.decision === "allow" || record.decision === "allow_always"
          ? { behavior: "allow", ...(record.selectedPermission ? { updatedPermissions: [record.selectedPermission] } : {}) }
          : { behavior: "deny", message: "Denied by the boss in Perch" }
      }
    };
  }

  private staleGeneration(record: ClaudeApprovalRecord): string | undefined {
    if (record.runtimeGeneration === undefined) return undefined;
    const worker = record.taskId
      ? this.tasks.stateDb.runtimes.latestForTask(record.taskId)
      : this.tasks.stateDb.runtimes.findBySession(record.workerSessionId);
    const owner = this.tasks.stateDb.ownerRuntimes.findBySession(record.workerSessionId);
    const current = worker ?? owner;
    if (!current || current.generation !== record.runtimeGeneration) {
      return `Claude approval belongs to runtime generation ${record.runtimeGeneration}; the current runtime generation changed`;
    }
    return undefined;
  }

  private surfaceFallback(record: ClaudeApprovalRecord): void {
    this.monitor.restorePendingApproval(record.perchSessionId, pendingApproval(record));
    if (!record.taskId) return;
    const task = this.tasks.find(record.taskId);
    if (!task || task.state === "closed") return;
    try {
      this.tasks.recordEvent(task.id, {
        kind: "blocked",
        source: "system",
        message: record.failureReason ?? "Remote Claude approval expired; answer Claude's native dialog locally",
        data: {
          reason: "claude_approval_local_fallback",
          approvalId: record.id,
          state: record.state,
          runtimeGeneration: record.runtimeGeneration
        }
      });
    } catch {
      // The approval record is already durable. Task projection is best-effort.
    }
  }
}

const CONFIRMING_EVENTS = new Set([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionDenied",
  "Stop",
  "SessionEnd"
]);

export function pendingApproval(record: ClaudeApprovalRecord, suggestions = new Map<string, Record<string, unknown>>()): PendingApproval {
  return {
    id: record.id,
    summary: record.summary,
    ...(record.command ? { command: record.command } : {}),
    at: record.createdAt,
    source: "hook",
    context: { tool: record.toolName },
    decisions: record.state === "pending" || record.state === "decided" || record.state === "decision_sent"
      ? [
          { id: "deny", label: "Deny", destructive: true, persistence: "turn" },
          { id: "allow", label: "Allow once", persistence: "turn" },
          ...[...suggestions.keys()].map((id) => ({ id: `allow_always:${id}`, label: "Always allow exact rule", persistence: "always" as const }))
        ]
      : undefined,
    submittedDecision: record.state === "decided" || record.state === "decision_sent" ? record.decision : undefined,
    remoteResolutionUnavailable: record.state === "expired" || record.state === "local_fallback",
    requestVersion: record.version,
    state: record.state,
    decisionPolicy: record.decisionPolicy,
    expiresAt: record.expiresAt,
    claudeSessionId: record.claudeSessionId,
    runtimeGeneration: record.runtimeGeneration,
    taskId: record.taskId,
    workerSessionId: record.workerSessionId,
    toolInputHash: record.toolInputHash,
    cwd: record.cwd,
    interactionKind: record.interactionKind
  };
}

export function publicRecord(record: ClaudeApprovalRecord): Record<string, unknown> {
  const { toolInput: _toolInput, selectedPermission: _selectedPermission, ...redacted } = record;
  return { ...redacted, hasSelectedPermission: Boolean(record.selectedPermission), allowedDecisions: CLAUDE_APPROVAL_DECISIONS };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function permissionSummary(toolName: string, input: Record<string, unknown>): { summary: string; command?: string } {
  const command = typeof input.command === "string"
    ? input.command.slice(0, 400)
    : typeof input.file_path === "string"
      ? input.file_path.slice(0, 400)
      : undefined;
  return { summary: `${toolName} wants permission`, ...(command ? { command } : {}) };
}

function redactPermissionInput(input: Record<string, unknown>): Record<string, unknown> {
  return { redacted: true, keys: Object.keys(input).sort() };
}

function validatedSuggestions(value: unknown): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(value)) return result;
  for (const suggestion of value) {
    if (!suggestion || typeof suggestion !== "object" || Array.isArray(suggestion)) continue;
    const record = suggestion as Record<string, unknown>;
    if (typeof record.type !== "string" || !record.type || stableStringify(record).length > 8_000) continue;
    result.set(sha256(stableStringify(record)), record);
  }
  return result;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
