import type { Task, TaskEventKind } from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import type { ChartRegistry } from "./charts.js";
import { findingsWakeSummary, parseNoMistakesGate } from "./findings.js";
import type { FleetMonitor } from "./fleetMonitor.js";
import type { TaskStore } from "./tasks.js";

// Boss-relevant task events (the absorb policy): decision-shaped moments
// reach the mate and the phone; working-heartbeats and bookkeeping notes stay
// silent. "stalled" is watchdog-emitted (a worker went quiet) - it wakes the
// mate but never pushes the phone.
export const BOSS_EVENT_KINDS = new Set([
  "chart_ready",
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

// How a task identifies itself in every mate wake line: the worker name for
// reading, the task id in parentheses for acting (GET /tasks/<id>). Older
// records without a worker name stay id-only.
export function taskWakeIdentity(task: Pick<Task, "id" | "workerName">): string {
  return task.workerName ? `${task.workerName} (${task.id})` : task.id;
}

// One wake line per boss-relevant event, always single-line (a newline would
// submit the mate's composer early). A needs_decision carrying a no-mistakes
// gate renders the full findings table - ids, severities, files, descriptions
// verbatim - so the mate can relay them without re-fetching the ledger.
export function wakeLine(
  task: Task,
  event: { kind: TaskEventKind; message?: string; data?: Record<string, unknown> }
): string {
  const gate = event.kind === "needs_decision" ? parseNoMistakesGate(event.data) : undefined;
  const fallbackBody = event.message ?? task.title;
  const body = gate
    ? `${event.message ? `${event.message.replace(/\s+/g, " ").trim()} - ` : ""}${findingsWakeSummary(gate)}`
    : event.kind === "checks_green"
      ? `${fallbackBody} - CI checks green; merge readiness not confirmed`
      : event.kind === "merge_ready"
        ? `${fallbackBody} - GitHub reports this PR is ready to merge`
        : fallbackBody;
  return `[perch] ${taskWakeIdentity(task)} · ${event.kind}: ${body}`;
}

// Supervisor wake channel: boss-relevant events inject one line into a
// running mate's composer (queue-gated, so an open permission prompt is never
// typed into). The mate sleeps free and wakes on meaning; absorbed events cost
// it zero tokens.
export function wireMateWake(tasks: TaskStore, adapter: AgentAdapter, monitor: FleetMonitor): void {
  tasks.subscribe((task, event) => {
    void deliverMateWake(task, event, adapter, monitor).catch(() => {});
  });
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
