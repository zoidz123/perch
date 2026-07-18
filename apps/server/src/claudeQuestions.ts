import { createHash } from "node:crypto";
import type { PendingQuestion, QuestionItem } from "@perch/shared";
import { ASK_USER_QUESTION_TOOL, extractQuestions } from "./askQuestion.js";
import type { FleetMonitor } from "./fleetMonitor.js";
import type { HookEventPayload } from "./hooks.js";
import type { ClaudeQuestionRecord } from "./stateDb.js";
import type { TaskStore } from "./tasks.js";

const DEFAULT_DEADLINE_MS = 9 * 60_000;

export class ClaudeQuestionCoordinator {
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

  register(perchSessionId: string, payload: HookEventPayload): { record?: ClaudeQuestionRecord; error?: string; created: boolean } {
    if (payload.tool_name !== ASK_USER_QUESTION_TOOL) return { created: false, error: "not_ask_user_question" };
    const rawInput = asRecord(payload.tool_input);
    const rawQuestions = Array.isArray(rawInput.questions) ? rawInput.questions : undefined;
    const questions = extractQuestions(rawInput);
    if (!rawQuestions || !questions || questions.length < 1 || questions.length > 4) {
      return { created: false, error: "invalid_question_schema" };
    }
    const toolUseId = typeof payload.tool_use_id === "string" && payload.tool_use_id
      ? payload.tool_use_id
      : undefined;
    if (!toolUseId) return { created: false, error: "missing_tool_use_id" };
    const prior = this.tasks.stateDb.claudeQuestions.findByToolUse(perchSessionId, toolUseId);
    if (prior) {
      this.monitor.restorePendingQuestion(perchSessionId, pendingQuestion(prior));
      return { record: prior, created: false };
    }

    const task = this.tasks.list().find((candidate) => candidate.sessionId === perchSessionId);
    const workerRuntime = this.tasks.stateDb.runtimes.findBySession(perchSessionId);
    const ownerRuntime = this.tasks.stateDb.ownerRuntimes.findBySession(perchSessionId);
    const simultaneous = this.tasks.stateDb.claudeQuestions.activeForSession(perchSessionId);
    const claudeSessionId = typeof payload.session_id === "string" && payload.session_id
      ? payload.session_id
      : `unlinked:${perchSessionId}`;
    const record = this.tasks.stateDb.claudeQuestions.create({
      perchSessionId,
      claudeSessionId,
      toolUseId,
      questions: rawQuestions,
      questionsHash: hash(JSON.stringify(rawQuestions)),
      ...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}),
      ...(typeof payload.transcript_path === "string" ? { transcriptPath: payload.transcript_path } : {}),
      ...(workerRuntime || ownerRuntime ? { runtimeGeneration: (workerRuntime ?? ownerRuntime)!.generation } : {}),
      ...(task ? { taskId: task.id } : {}),
      workerSessionId: perchSessionId,
      ...(task?.parentSessionId ? { parentSessionId: task.parentSessionId } : {}),
      answerPolicy: "boss_only",
      expiresAt: new Date(this.now() + this.deadlineMs).toISOString()
    });

    if (simultaneous) {
      const fallback = this.tasks.stateDb.claudeQuestions.transition(
        record.id,
        "waiting",
        "simultaneous_fallback",
        { failureReason: "Claude emitted simultaneous tool calls; only one AskUserQuestion call can be remotely bridged" }
      )!;
      this.recordFallback(fallback);
      return { record: fallback, created: true, error: "simultaneous_tool_call" };
    }

    this.monitor.setPendingQuestion(perchSessionId, pendingQuestion(record));
    this.recordQuestion(task?.id, record, questions);
    return { record, created: true };
  }

  replay(): void {
    for (const record of this.tasks.stateDb.claudeQuestions.effective()) {
      if (record.state === "waiting" && this.now() >= Date.parse(record.expiresAt)) {
        this.tasks.stateDb.claudeQuestions.transition(record.id, "waiting", "expired", {
          failureReason: "Remote question deadline expired while Perch was offline"
        });
        continue;
      }
      if (["waiting", "answer_sent", "expired", "local_fallback"].includes(record.state)) {
        this.monitor.restorePendingQuestion(record.perchSessionId, pendingQuestion(record));
      }
    }
  }

  list(): ClaudeQuestionRecord[] {
    return this.tasks.stateDb.claudeQuestions.effective();
  }

  answer(
    sessionId: string,
    requestId: string,
    selections: number[][],
    customAnswers: Record<string, string> | undefined,
    actor: string
  ): { status: number; body: Record<string, unknown> } {
    const record = this.tasks.stateDb.claudeQuestions.find(requestId);
    if (!record || record.perchSessionId !== sessionId) {
      return { status: 409, body: { error: "The Claude question request has changed" } };
    }
    const stale = this.staleGeneration(record);
    if (stale) return { status: 409, body: { error: stale, reason: "stale_generation" } };
    const questions = extractQuestions({ questions: record.questions });
    if (!questions) return { status: 409, body: { error: "The persisted question schema is invalid" } };
    const built = buildAnswers(questions, selections, customAnswers);
    if ("error" in built) return { status: 400, body: { error: built.error } };
    const result = this.tasks.stateDb.claudeQuestions.answer(requestId, built.answers, actor);
    if (!result.record || result.outcome === "missing" || result.outcome === "conflict") {
      return { status: 409, body: { error: "The answer is stale, duplicated with different content, or no longer remotely resolvable" } };
    }
    this.monitor.restorePendingQuestion(sessionId, pendingQuestion(result.record));
    return {
      status: 202,
      body: { ok: true, pending: true, idempotent: result.outcome === "idempotent", request: publicQuestion(result.record) }
    };
  }

  async waitForAnswer(id: string, connected: () => boolean = () => true): Promise<ClaudeQuestionRecord> {
    while (true) {
      const record = this.tasks.stateDb.claudeQuestions.find(id);
      if (!record) throw new Error("Claude question request disappeared");
      if (record.state !== "waiting") return record;
      if (!connected()) {
        return this.localFallback(id, "Question hook connection closed; use Claude's native local question UI") ?? record;
      }
      if (this.now() >= Date.parse(record.expiresAt)) {
        const expired = this.tasks.stateDb.claudeQuestions.transition(
          id,
          "waiting",
          "expired",
          { failureReason: "Remote question deadline expired; use Claude's native local question UI" }
        ) ?? record;
        this.monitor.restorePendingQuestion(record.perchSessionId, pendingQuestion(expired));
        this.recordFallback(expired);
        return expired;
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  localFallback(id: string, reason: string): ClaudeQuestionRecord | undefined {
    const record = this.tasks.stateDb.claudeQuestions.transition(id, "waiting", "local_fallback", { failureReason: reason });
    if (record) {
      this.monitor.restorePendingQuestion(record.perchSessionId, pendingQuestion(record));
      this.recordFallback(record);
    }
    return record;
  }

  confirmLaterActivity(sessionId: string, eventName: string): void {
    if (!QUESTION_CONFIRMING_EVENTS.has(eventName)) return;
    const current = this.tasks.stateDb.claudeQuestions.latestForSession(sessionId);
    if (!current) return;
    if (current.state === "answer_sent") {
      const confirmed = this.tasks.stateDb.claudeQuestions.transition(
        current.id,
        "answer_sent",
        "continued",
        { confirmedAt: new Date(this.now()).toISOString() }
      );
      if (confirmed) this.monitor.resolveQuestion(sessionId);
    } else if (["waiting", "expired", "local_fallback"].includes(current.state)) {
      this.monitor.resolveQuestion(sessionId);
    }
  }

  hookOutput(record: ClaudeQuestionRecord): Record<string, unknown> | undefined {
    if (record.state !== "answer_sent" || !record.answers) return undefined;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Answered by the boss in Perch",
        updatedInput: { questions: record.questions, answers: record.answers }
      }
    };
  }

  private staleGeneration(record: ClaudeQuestionRecord): string | undefined {
    if (record.runtimeGeneration === undefined) return undefined;
    const current = record.taskId
      ? this.tasks.stateDb.runtimes.latestForTask(record.taskId)
      : (this.tasks.stateDb.runtimes.findBySession(record.workerSessionId)
        ?? this.tasks.stateDb.ownerRuntimes.findBySession(record.workerSessionId));
    return !current || current.generation !== record.runtimeGeneration
      ? `Claude question belongs to runtime generation ${record.runtimeGeneration}; the current runtime generation changed`
      : undefined;
  }

  private recordQuestion(taskId: string | undefined, record: ClaudeQuestionRecord, questions: QuestionItem[]): void {
    if (!taskId) return;
    try {
      this.tasks.recordEvent(taskId, {
        kind: "needs_decision",
        source: "system",
        message: questions[0]!.question,
        data: {
          reason: "claude_question_request",
          questionId: record.id,
          questionCount: questions.length,
          toolUseId: record.toolUseId,
          cwd: record.cwd,
          runtimeGeneration: record.runtimeGeneration,
          answerPolicy: record.answerPolicy
        }
      });
    } catch {}
  }

  private recordFallback(record: ClaudeQuestionRecord): void {
    if (!record.taskId) return;
    try {
      this.tasks.recordEvent(record.taskId, {
        kind: "blocked",
        source: "system",
        message: record.failureReason ?? "Claude question requires local input",
        data: { reason: "claude_question_local_fallback", questionId: record.id, state: record.state }
      });
    } catch {}
  }
}

const QUESTION_CONFIRMING_EVENTS = new Set(["PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"]);

export function pendingQuestion(record: ClaudeQuestionRecord): PendingQuestion {
  return {
    id: record.id,
    questions: extractQuestions({ questions: record.questions }) ?? [],
    at: record.createdAt,
    requestVersion: 1,
    state: record.state,
    answerPolicy: record.answerPolicy,
    remoteResolutionUnavailable: ["expired", "local_fallback", "simultaneous_fallback"].includes(record.state),
    submittedAnswers: record.state === "answer_sent" ? record.answers : undefined,
    expiresAt: record.expiresAt,
    claudeSessionId: record.claudeSessionId,
    toolUseId: record.toolUseId,
    runtimeGeneration: record.runtimeGeneration,
    taskId: record.taskId,
    workerSessionId: record.workerSessionId,
    questionsHash: record.questionsHash,
    cwd: record.cwd
  };
}

export function publicQuestion(record: ClaudeQuestionRecord): Record<string, unknown> {
  return { ...record };
}

function buildAnswers(
  questions: QuestionItem[],
  selections: number[][],
  customAnswers: Record<string, string> | undefined
): { answers: Record<string, string> } | { error: string } {
  if (selections.length !== questions.length) return { error: "selections must contain one entry per question" };
  const answers: Record<string, string> = {};
  for (const [index, question] of questions.entries()) {
    const selected = [...new Set(selections[index] ?? [])];
    if (selected.some((choice) => !Number.isInteger(choice) || choice < 0 || choice >= question.options.length)) {
      return { error: `question ${index + 1} contains an invalid option index` };
    }
    if (!question.multiSelect && selected.length > 1) return { error: `question ${index + 1} accepts one answer` };
    const custom = customAnswers?.[question.question]?.trim();
    if (custom && custom.length > 4_000) return { error: `question ${index + 1} custom answer is too long` };
    const labels = selected.map((choice) => question.options[choice]!.label);
    if (custom) labels.push(custom);
    if (labels.length === 0) return { error: `question ${index + 1} requires an option or Other answer` };
    answers[question.question] = labels.join(", ");
  }
  return { answers };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
