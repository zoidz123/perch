import type { Task, TaskEventKind, TaskEventSource } from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import type { ChartRegistry } from "./charts.js";
import type { FleetMonitor, SessionStatusChange } from "./fleetMonitor.js";
import type { MateMailboxRepository } from "./stateDb.js";
import type { TaskStore } from "./tasks.js";
import { MAILBOX_CONTROL_PREFIX } from "./timeline.js";

// Boss-relevant task events (the absorb policy): decision-shaped moments
// reach the mate and the phone; working-heartbeats and bookkeeping notes stay
// silent. "stalled" is watchdog-emitted (a worker went quiet) - it wakes the
// mate but never pushes the phone.
export const BOSS_EVENT_KINDS = new Set([
  "chart_ready",
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

// Worker-authored boss-relevant kinds: these fan in to the mate through the
// durable mailbox (a delivery row committed with the event) instead of raw
// composer injection. System/hook/poller notifications stay on the legacy
// wake-line path below until the mailbox subsumes them - that legacy path is
// the explicit compatibility boundary, not a second correctness layer.
export const MATE_MAILBOX_EVENT_KINDS = new Set<TaskEventKind>([
  "pr_linked",
  "needs_decision",
  "blocked",
  "completion_requested",
  "done",
  "failed"
]);

export type MailboxRoutableEvent = {
  kind: TaskEventKind;
  message?: string;
  source?: TaskEventSource;
  data?: Record<string, unknown>;
};

// A worker message never becomes a user message in the mate's chat. Either it
// is a worker-sourced boss event or the pointer note of a submitted worker
// report - both already have durable mailbox deliveries by the time the
// outbox fans out.
export function isMailboxRouted(event: MailboxRoutableEvent): boolean {
  if (event.source !== "worker") return false;
  if (MATE_MAILBOX_EVENT_KINDS.has(event.kind)) return true;
  return event.kind === "note" && event.data?.reason === "worker_report";
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
// it zero tokens. Worker-authored events are diverted to the mailbox nudge
// path in deliverMateAttention; this raw injection remains only for
// system-sourced notifications.
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
// Everything else keeps the legacy content wake line.
export async function deliverMateAttention(
  task: Task,
  event: MailboxRoutableEvent,
  adapter: AgentAdapter,
  monitor: FleetMonitor,
  nudger?: MateMailboxNudger
): Promise<void> {
  if (isMailboxRouted(event)) {
    await nudger?.nudge({ excludeSessionId: task.sessionId });
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
  const requestedParent =
    event.kind === "chart_ready" && typeof event.data?.parentSessionId === "string"
      ? event.data.parentSessionId
      : undefined;
  const target =
    sessions.find((session) => session.id === requestedParent) ??
    sessions.find((session) => session.labels?.role === "mate");
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

  constructor(
    private readonly options: {
      mailbox: MateMailboxRepository;
      adapter: AgentAdapter;
      monitor: FleetMonitor;
    }
  ) {}

  // Safe-checkpoint safety net: a mate turn just ended. If unacknowledged
  // messages arrived that no nudge has covered, raise attention now.
  onStatusChange(change: SessionStatusChange): void {
    if (change.to !== "idle") return;
    void (async () => {
      const sessions = await this.options.adapter.listSessions();
      const mate = sessions.find((session) => session.labels?.role === "mate");
      if (!mate || mate.id !== change.sessionId) return;
      await this.nudge({ target: mate.id });
    })().catch(() => {});
  }

  async nudge(input: { excludeSessionId?: string; target?: string } = {}): Promise<void> {
    const now = new Date().toISOString();
    const pending = this.options.mailbox.pendingCount(now);
    if (pending === 0) return;
    const maxKey = this.options.mailbox.maxUnacknowledgedOrderKey() ?? 0;
    if (maxKey <= this.lastNudgedOrderKey) return;
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
    const result = await this.options.monitor.queueOrSubmit(targetId, mailboxNudgeLine(pending), {
      queueIfGated: false,
      silent: true
    });
    if (!result.gated) this.lastNudgedOrderKey = maxKey;
  }
}

// Charts surface through the durable task-event channel at registration time.
// The normal mate wake subscriber then routes the event to the exact parent
// when it is live, or the live mate fallback when the recorded parent has
// already disappeared. Recording first keeps scout completion irrelevant.
export function wireChartWake(
  charts: ChartRegistry,
  tasks: TaskStore,
  reviewUrl: (chartId: string) => string
): void {
  charts.subscribe((chart, event) => {
    if (event.kind !== "registered" || !chart.taskId) {
      return;
    }
    const url = reviewUrl(chart.id);
    tasks.recordEvent(chart.taskId, {
      kind: "chart_ready",
      source: "system",
      message: `"${chart.name}" - review at ${url}`,
      data: {
        chartId: chart.id,
        chartName: chart.name,
        reviewUrl: url,
        ...(chart.parentSessionId ? { parentSessionId: chart.parentSessionId } : {})
      }
    });
  });
}
