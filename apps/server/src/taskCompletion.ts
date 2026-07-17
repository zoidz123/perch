import type { TaskEvent, TaskEventKind, TaskState } from "@perch/shared";
import type { TaskStore } from "./tasks.js";

export type Provider = "codex" | "claude";

export type TaskCompletionDeps = {
  tasks: TaskStore;
  lastAssistantText?: (sessionId: string) => string | undefined;
};

export type TurnCompletionResult = {
  taskId?: string;
  taskState?: TaskState;
  matchedStart: boolean;
  outcomeEvent?: TaskEvent;
  retryNeeded: boolean;
  duplicate?: boolean;
};

const OUTCOME_KINDS: ReadonlySet<TaskEventKind> = new Set([
  "needs_decision",
  "blocked",
  "completion_requested",
  "failed"
]);

const RETRY_VISIBLE_STATES: ReadonlySet<TaskState> = new Set([
  "queued",
  "working",
  "needs_you",
  "blocked",
  "completion_requested",
  // A late follow-up to an already verified task must not reopen done, but it
  // still needs a durable receipt if its turn silently omits an outcome.
  "done"
]);

// Provider hooks are the enforcement boundary for one worker turn. A turn
// start snapshots the immutable task-event sequence. At the matching Stop /
// turn-complete signal, only an accepted worker outcome appended after that
// snapshot satisfies the reporting contract. Provider completion remains
// runtime evidence and never changes task meaning.
export class TaskCompletionReconciler {
  constructor(private readonly deps: TaskCompletionDeps) {}

  onTurnStarted(sessionId: string, provider: Provider): TaskEvent | undefined {
    const task = this.deps.tasks.list().find((candidate) => candidate.sessionId === sessionId);
    if (!task || task.state === "closed" || task.state === "landed") return undefined;

    const events = this.deps.tasks.events(task.id);
    const taskEventSeqAtStart = events.at(-1)?.seq ?? 0;
    try {
      this.deps.tasks.recordEvent(task.id, {
        kind: "turn_started",
        source: "hook",
        message: `${provider} turn started`,
        data: { provider, sessionId, taskEventSeqAtStart }
      });
      return this.deps.tasks.events(task.id).at(-1);
    } catch {
      return undefined;
    }
  }

  onTurnCompleted(
    sessionId: string,
    provider: Provider,
    options: { continuation?: boolean } = {}
  ): TurnCompletionResult {
    const task = this.deps.tasks.list().find((candidate) => candidate.sessionId === sessionId);
    if (!task || task.state === "closed" || task.state === "landed") {
      return { matchedStart: false, retryNeeded: false };
    }

    let events = this.deps.tasks.events(task.id);
    const start = [...events].reverse().find((event) => {
      if (event.kind !== "turn_started") return false;
      return event.data?.provider === provider && event.data?.sessionId === sessionId;
    });
    const matchedStart = start !== undefined;
    const priorCompletions = events.filter(
      (event) =>
        event.kind === "turn_completed" &&
        event.data?.provider === provider &&
        event.data?.sessionId === sessionId &&
        (matchedStart
          ? event.data?.turnStartedSeq === start.seq
          : event.data?.turnStartedSeq === null)
    );
    const priorCompletion = priorCompletions.at(-1);
    const taskEventSeqAtStart = matchedStart
      ? numberField(start.data?.taskEventSeqAtStart) ?? start.seq
      : numberField(priorCompletion?.data?.taskEventSeqAtStart) ?? events.at(-1)?.seq ?? 0;
    if (priorCompletion && (priorCompletion.data?.retryNeeded !== true || options.continuation !== true)) {
      const outcomeEvent = outcomeFor(events, taskEventSeqAtStart);
      return {
        taskId: task.id,
        taskState: task.state,
        matchedStart,
        outcomeEvent,
        retryNeeded: priorCompletion.data?.retryNeeded === true && outcomeEvent === undefined,
        duplicate: true
      };
    }

    const outcomeEvent = outcomeFor(events, taskEventSeqAtStart);
    const retryNeeded = outcomeEvent === undefined;
    const alreadyStalled = events.some(
      (event) =>
        event.kind === "stalled" &&
        event.data?.reason === "turn_outcome_missing" &&
        event.data?.provider === provider &&
        event.data?.sessionId === sessionId &&
        event.data?.turnStartedSeq === (start?.seq ?? null)
    );
    const current = this.deps.tasks.find(task.id);
    const completionSeq = (events.at(-1)?.seq ?? 0) + 1;
    const completionEvent = {
      kind: "turn_completed" as const,
      source: "hook" as const,
      message: `${provider} turn completed`,
      data: {
        provider,
        sessionId,
        turnStartedSeq: start?.seq ?? null,
        taskEventSeqAtStart,
        attempt: priorCompletions.length + 1,
        retryNeeded,
        ...(outcomeEvent
          ? { outcomeEventSeq: outcomeEvent.seq, outcomeKind: outcomeEvent.kind }
          : {})
      }
    };
    const shouldStall = retryNeeded && current && RETRY_VISIBLE_STATES.has(current.state) && !alreadyStalled;
    try {
      if (shouldStall) {
        const tail = this.deps.lastAssistantText?.(sessionId);
        const message =
          `worker ${provider} turn ended without an accepted task outcome; retry needed` +
          (tail ? ` · last reply: ${clip(tail, 300)}` : "");
        this.deps.tasks.recordEvents(task.id, [
          { event: completionEvent },
          {
            event: {
              kind: "stalled",
              source: "system",
              message,
              data: {
                reason: "turn_outcome_missing",
                provider,
                sessionId,
                turnStartedSeq: start?.seq ?? null,
                taskEventSeqAtStart,
                turnCompletedSeq: completionSeq,
                retryNeeded: true
              }
            }
          }
        ]);
      } else {
        this.deps.tasks.recordEvent(task.id, completionEvent);
      }
    } catch {
      // Runtime evidence must never disturb the provider hook/control path.
      return { taskId: task.id, taskState: task.state, matchedStart, outcomeEvent, retryNeeded };
    }

    return {
      taskId: task.id,
      taskState: this.deps.tasks.find(task.id)?.state ?? task.state,
      matchedStart,
      outcomeEvent,
      retryNeeded
    };
  }
}

function outcomeFor(events: TaskEvent[], taskEventSeqAtStart: number): TaskEvent | undefined {
  return events.find(
    (event) =>
      event.seq > taskEventSeqAtStart &&
      event.source === "worker" &&
      OUTCOME_KINDS.has(event.kind)
  );
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function clip(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}
