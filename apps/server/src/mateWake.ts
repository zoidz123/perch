import type { Task, TaskEventKind, TaskEventSource } from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import type { FleetMonitor, SessionStatusChange } from "./fleetMonitor.js";
import type { MateMailboxRepository } from "./stateDb.js";
import type { TaskStore } from "./tasks.js";
import { MAILBOX_CONTROL_PREFIX } from "./timeline.js";

// Boss-relevant task events (the absorb policy): decision-shaped moments
// reach the mate and the phone; working-heartbeats and bookkeeping notes stay
// silent. "stalled" is watchdog-emitted (a worker went quiet) - it wakes the
// mate but never pushes the phone.
export const BOSS_EVENT_KINDS = new Set<TaskEventKind>([
  "pr_linked",
  "needs_decision",
  "blocked",
  "completion_requested",
  "done",
  "failed",
  "checks_green",
  "merge_ready",
  "merged",
  "stalled",
  "runtime_interrupted"
]);

export type MailboxRoutableEvent = {
  kind: TaskEventKind;
  message?: string;
  source?: TaskEventSource;
  data?: Record<string, unknown>;
};

// A lifecycle wake never becomes a user message in the mate's chat. New
// source-stamped boss events and worker-report pointers already have durable
// mailbox deliveries by the time the outbox fans out. Source-less payloads
// predate this mailbox route and stay on the compatibility wake-line path.
export function isMailboxRouted(event: MailboxRoutableEvent): boolean {
  if (!event.source) return false;
  if (BOSS_EVENT_KINDS.has(event.kind)) return true;
  return event.source === "worker" && event.kind === "note" && event.data?.reason === "worker_report";
}

// The disposable attention nudge: single line (a newline would submit the
// composer early), content-free (pointers live in the mailbox), and carrying
// the shared control prefix so every boss-facing timeline projection filters
// it. Losing one loses no message - the mailbox is the correctness layer.
export function mailboxNudgeLine(pendingCount: number): string {
  return `${MAILBOX_CONTROL_PREFIX} ${pendingCount} unread worker message${pendingCount === 1 ? "" : "s"} - drain your mailbox (perch mailbox read) before replying or going idle`;
}

// How a task identifies itself in every mate wake line: the worker name for
// reading, the task id in parentheses for acting (GET /tasks/<id>). Older
// records without a worker name stay id-only.
export function taskWakeIdentity(task: Pick<Task, "id" | "workerName">): string {
  return task.workerName ? `${task.workerName} (${task.id})` : task.id;
}

// One wake line per boss-relevant event, always single-line (a newline would
// submit the mate's composer early).
export function wakeLine(
  task: Task,
  event: { kind: TaskEventKind; message?: string; data?: Record<string, unknown> }
): string {
  const fallbackBody = event.message ?? task.title;
  const approvalBody = event.kind === "needs_decision" && event.data?.reason === "approval_request"
    ? approvalWakeBody(fallbackBody, event.data)
    : undefined;
  const body = approvalBody ?? (event.kind === "checks_green"
    ? `${fallbackBody} - CI checks green; merge readiness not confirmed`
    : event.kind === "merge_ready"
      ? `${fallbackBody} - GitHub reports this PR is ready to merge`
      : fallbackBody);
  return `[perch] ${taskWakeIdentity(task)} · ${event.kind}: ${body}`;
}

function approvalWakeBody(fallback: string, data: Record<string, unknown>): string {
  const context = data.context && typeof data.context === "object"
    ? data.context as Record<string, unknown>
    : {};
  const tool = typeof context.tool === "string" ? context.tool : "Claude tool";
  const command = typeof data.command === "string" ? data.command.replace(/\s+/g, " ").trim().slice(0, 180) : undefined;
  const cwd = typeof data.cwd === "string" ? data.cwd.slice(0, 180) : undefined;
  return [fallback, tool, command, cwd ? `cwd ${cwd}` : undefined].filter(Boolean).join(" - ");
}

// Supervisor wake channel: boss-relevant events inject one line into a
// running mate's composer (queue-gated, so an open permission prompt is never
// typed into). The mate sleeps free and wakes on meaning; absorbed events cost
// it zero tokens. Source-stamped lifecycle events are diverted to the mailbox
// nudge path in deliverMateAttention; this raw injection remains only as the
// compatibility fallback for source-less old outbox payloads or an unavailable
// mailbox attention path.
export function wireMateWake(
  tasks: TaskStore,
  adapter: AgentAdapter,
  monitor: FleetMonitor,
  nudger?: MateMailboxNudger
): void {
  tasks.subscribe((task, event) => {
    void deliverMateAttention(task, event, adapter, monitor, nudger).catch(() => {});
  });
}

// The outbox 'mate' channel entrypoint. Mailbox-routed events already have
// durable delivery rows; their only remaining need is disposable attention.
// An older server composition may not provide a nudger, so absence falls back
// to the legacy content line instead of losing the wake.
export async function deliverMateAttention(
  task: Task,
  event: MailboxRoutableEvent,
  adapter: AgentAdapter,
  monitor: FleetMonitor,
  nudger?: MateMailboxNudger,
  delivery?: { taskEventId?: number }
): Promise<void> {
  const mailboxAvailable =
    nudger && (delivery?.taskEventId === undefined || nudger.hasDelivery(delivery.taskEventId));
  if (isMailboxRouted(event) && mailboxAvailable) {
    await nudger.nudge({ excludeSessionId: task.sessionId });
    return;
  }
  await deliverMateWake(task, event, adapter, monitor);
}

export async function deliverMateWake(
  task: Task,
  event: { kind: TaskEventKind; message?: string; data?: Record<string, unknown> },
  adapter: AgentAdapter,
  monitor: FleetMonitor
): Promise<void> {
  if (!BOSS_EVENT_KINDS.has(event.kind)) return;
  const sessions = await adapter.listSessions();
  const target = sessions.find((session) => session.labels?.role === "mate");
  if (!target || (task.sessionId && target.id === task.sessionId)) return;
  await monitor.queueOrSubmit(target.id, wakeLine(task, event));
}

// Attention transport for the durable mailbox. Correctness lives in SQLite;
// this class only decides when a content-free nudge is safe and useful:
// never while the mate is mid-turn (a Codex steer would interrupt it), never
// behind a permission gate, and never twice for the same backlog (the
// high-water order key stops nudge->idle->nudge loops while the mate is
// between drain checkpoints).
export class MateMailboxNudger {
  private lastNudgedOrderKey = 0;
  private lastNudgeAttemptAt: string | undefined;
  private pendingNudgeTarget: string | undefined;
  private nudgeInFlight: Promise<void> | undefined;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private readonly sweepMs: number;

  constructor(
    private readonly options: {
      mailbox: MateMailboxRepository;
      adapter: AgentAdapter;
      monitor: FleetMonitor;
      sweepMs?: number;
    }
  ) {
    this.sweepMs = options.sweepMs ?? 60_000;
  }

  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch(() => {});
    }, this.sweepMs);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  hasDelivery(taskEventId: number): boolean {
    try {
      return this.options.mailbox.hasTaskEvent(taskEventId);
    } catch {
      return false;
    }
  }

  // Safe-checkpoint safety net: a mate turn just ended. If unacknowledged
  // messages arrived that no nudge has covered, raise attention now.
  onStatusChange(change: SessionStatusChange): void {
    if (change.sessionId === this.pendingNudgeTarget && change.to === "running") {
      this.pendingNudgeTarget = undefined;
    }
    if (change.to !== "idle") return;
    void (async () => {
      const sessions = await this.options.adapter.listSessions();
      const mate = sessions.find((session) => session.labels?.role === "mate");
      if (!mate || mate.id !== change.sessionId) return;
      await this.nudge({ target: mate.id });
    })().catch(() => {});
  }

  async nudge(input: { excludeSessionId?: string; target?: string; force?: boolean } = {}): Promise<void> {
    // Coalesce concurrent outbox deliveries and newer arrivals while the
    // existing control prompt is still waiting for the mate to process it.
    if (this.nudgeInFlight || this.pendingNudgeTarget) return;
    const inFlight = this.performNudge(input);
    this.nudgeInFlight = inFlight;
    try {
      await inFlight;
    } finally {
      if (this.nudgeInFlight === inFlight) this.nudgeInFlight = undefined;
    }
  }

  // Retry a lost control prompt once per interval while the same pending
  // mailbox remains untouched. This intentionally bypasses the normal
  // high-water check: the durable mailbox, not the prompt, is the source of
  // truth, and a restarted server begins with no in-memory nudge state.
  async sweep(): Promise<void> {
    if (this.nudgeInFlight) return;
    const now = new Date().toISOString();
    if (this.options.mailbox.pendingCount(now) === 0) return;
    if (
      this.lastNudgeAttemptAt &&
      Date.parse(now) - Date.parse(this.lastNudgeAttemptAt) < this.sweepMs
    ) {
      return;
    }

    const sessions = await this.options.adapter.listSessions();
    const mate = sessions.find((session) => session.labels?.role === "mate");
    if (!mate) return;
    const status = this.options.monitor.sessionStatus(mate.id) ?? mate.status;
    if (status !== "idle") return;
    const activityAt = this.options.mailbox.latestClaimOrAckAt();
    if (this.lastNudgeAttemptAt && activityAt && activityAt > this.lastNudgeAttemptAt) return;

    // A prior accepted nudge normally clears this marker when the mate starts
    // its turn. If the input was lost, it remains idle forever; this interval
    // proves the old marker stale before submitting exactly one replacement.
    if (this.pendingNudgeTarget && this.pendingNudgeTarget !== mate.id) return;
    this.pendingNudgeTarget = undefined;
    await this.nudge({ target: mate.id, force: true });
  }

  private async performNudge(input: { excludeSessionId?: string; target?: string; force?: boolean }): Promise<void> {
    const now = new Date().toISOString();
    const pending = this.options.mailbox.pendingCount(now);
    if (pending === 0) return;
    const maxKey = this.options.mailbox.maxUnacknowledgedOrderKey() ?? 0;
    if (!input.force && maxKey <= this.lastNudgedOrderKey) return;
    let targetId = input.target;
    if (!targetId) {
      const sessions = await this.options.adapter.listSessions();
      targetId = sessions.find((session) => session.labels?.role === "mate")?.id;
    }
    // No live mate (or the event came from the mate's own session): the
    // durable mailbox holds the work for the next mate turn or launch.
    if (!targetId || targetId === input.excludeSessionId) return;
    // Never steer an active turn; the idle transition re-invokes this.
    if (this.options.monitor.sessionStatus(targetId) === "running") return;
    this.pendingNudgeTarget = targetId;
    try {
      const attemptAt = new Date().toISOString();
      const result = await this.options.monitor.queueOrSubmit(targetId, mailboxNudgeLine(pending), {
        queueIfGated: false,
        silent: true
      });
      if (result.gated) {
        this.pendingNudgeTarget = undefined;
        return;
      }
      this.lastNudgedOrderKey = maxKey;
      this.lastNudgeAttemptAt = attemptAt;
    } catch (error) {
      this.pendingNudgeTarget = undefined;
      throw error;
    }
  }
}
