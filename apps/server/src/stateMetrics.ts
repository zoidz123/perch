import type { AgentSessionStatus, TaskEventKind, TaskEventSource, TaskState } from "@perch/shared";

// Measure the state machine (G6). Push-driven transitions stay the fast path;
// these counters exist to see which edges fire from which source, how often the
// reconciler had to correct a lying status (= push loss), and how stale a lie
// was when caught. Deliberately in-memory with a small rolling log - this is a
// diagnostic surface for the mate/CLI (GET /doctor/state-metrics), not a
// metrics stack; a server restart zeroing it is fine.

// Where a session status change came from. Task events already carry their
// own TaskEventSource; this is the session-side equivalent.
export type SessionStatusSource = "hook" | "adapter" | "system" | "reconciler";

const MAX_SAMPLES = 256;
const MAX_RECENT = 100;

type RecentTransition = {
  at: string;
  kind: "session" | "task";
  id: string;
  from?: string;
  to: string;
  source: string;
  // The task event kind that drove a task transition.
  via?: string;
};

export class StateMetrics {
  // Edge counters keyed "<from>-><to>|<source>".
  private readonly sessionEdges = new Map<string, number>();
  private readonly taskEdges = new Map<string, number>();
  // Named counters (reconciler.corrections, watchdog.stalls, prPoller.fastPolls...).
  private readonly counters = new Map<string, number>();
  // Named rolling samples for the few latencies that are actually measurable.
  private readonly samples = new Map<string, number[]>();
  private readonly recent: RecentTransition[] = [];

  recordSessionStatus(
    sessionId: string,
    from: AgentSessionStatus | undefined,
    to: AgentSessionStatus,
    source: SessionStatusSource
  ): void {
    this.bump(this.sessionEdges, `${from ?? "?"}->${to}|${source}`);
    this.remember({ at: new Date().toISOString(), kind: "session", id: sessionId, from, to, source });
  }

  recordTaskTransition(
    taskId: string,
    from: TaskState,
    to: TaskState,
    via: TaskEventKind,
    source: TaskEventSource
  ): void {
    this.bump(this.taskEdges, `${from}->${to}|${source}`);
    this.remember({ at: new Date().toISOString(), kind: "task", id: taskId, from, to, source, via });
  }

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  observe(name: string, valueMs: number): void {
    const list = this.samples.get(name) ?? [];
    list.push(valueMs);
    if (list.length > MAX_SAMPLES) {
      list.splice(0, list.length - MAX_SAMPLES);
    }
    this.samples.set(name, list);
  }

  snapshot(): {
    at: string;
    sessionEdges: Record<string, Record<string, number>>;
    taskEdges: Record<string, Record<string, number>>;
    counters: Record<string, number>;
    latenciesMs: Record<string, { count: number; p50: number; p95: number; max: number }>;
    recent: RecentTransition[];
  } {
    return {
      at: new Date().toISOString(),
      sessionEdges: groupEdges(this.sessionEdges),
      taskEdges: groupEdges(this.taskEdges),
      counters: Object.fromEntries(this.counters),
      latenciesMs: Object.fromEntries(
        [...this.samples].map(([name, values]) => [name, summarize(values)])
      ),
      recent: [...this.recent]
    };
  }

  private bump(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  private remember(entry: RecentTransition): void {
    this.recent.push(entry);
    if (this.recent.length > MAX_RECENT) {
      this.recent.splice(0, this.recent.length - MAX_RECENT);
    }
  }
}

// "running->idle|hook": 3  becomes  { "running->idle": { "hook": 3 } }.
function groupEdges(map: Map<string, number>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [key, count] of map) {
    const [edge, source] = key.split("|");
    if (!edge || !source) {
      continue;
    }
    out[edge] = out[edge] ?? {};
    out[edge][source] = count;
  }
  return out;
}

function summarize(values: number[]): { count: number; p50: number; p95: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    count: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1] ?? 0
  };
}
