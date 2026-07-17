import type { Task, TaskState } from "@perch/shared";
import type { SessionExitContext } from "./adapters/pty.js";
import type { StateMetrics } from "./stateMetrics.js";
import { isTeardownInFlight } from "./teardown.js";
import type { TaskStore } from "./tasks.js";
import type { UsageLimit } from "./usageLimitDetect.js";

// Task-side watchdogs. Worker verbs stay the fast path; these exist so a
// worker that stops reporting becomes a wake-the-mate moment instead of a
// task that sits "working" forever. They emit a system-sourced "stalled"
// event, which moves no state (the mate adjudicates) but rides the boss
// wake channel.
//
// - Silence (G3): while working, no task event AND no session activity for N
//   minutes (by task kind) fires stalled once, re-armed by fresh activity.
// Per-turn missing-outcome enforcement lives in TaskCompletionReconciler at
// the provider Stop/turn-complete boundary, where it can correlate the exact
// task-event sequence captured at turn start.

const LIVE_STATES: ReadonlySet<TaskState> = new Set([
  "queued",
  "working",
  "needs_you",
  "blocked",
  "completion_requested"
]);

export type TaskWatchdogDeps = {
  tasks: TaskStore;
  // Epoch ms of the worker session's last normalized conversation activity.
  // TUI redraws and transcript-file creation alone must not mask a genuinely
  // silent worker.
  sessionActivityAt?: (sessionId: string) => number | undefined;
  // The worker's final reply, so a stall note carries enough for the mate to
  // adjudicate cheaply without opening the session.
  lastAssistantText?: (sessionId: string) => string | undefined;
  // The session ids the adapter currently considers live. Backs the G4 backstop
  // reconcile: a `working` task whose session is not in this set has no live
  // worker (server restart, crash, or a missed onSessionExit) and must not sit
  // "working" forever. Absent => liveness unknown, so the reconcile is skipped
  // and the silence message stays generic.
  liveSessionIds?: () => Promise<Set<string>> | Set<string>;
  // Returns true only when the report actually transitioned the runtime (the
  // manager's CAS makes repeated reports no-ops).
  runtimeInterrupted?: (sessionId: string, message: string) => boolean;
  // Self-heal hook for tasks parked "blocked" by a recoverable, retryable
  // condition (currently the PR-binding propagation race). Invoked once per
  // sweep per blocked task; the handler decides whether the task qualifies and
  // whether re-attempting clears it. Kept an opaque callback so the watchdog
  // stays agent-agnostic and unaware of PR binding.
  healBlocked?: (task: Task) => void | Promise<void>;
  metrics?: StateMetrics;
};

export type TaskWatchdogOptions = {
  scoutSilenceMs?: number;
  shipSilenceMs?: number;
  launchStallMs?: number;
  checkMs?: number;
  now?: () => number;
};

export class TaskWatchdog {
  private readonly scoutSilenceMs: number;
  private readonly shipSilenceMs: number;
  private readonly launchStallMs: number;
  private readonly checkMs: number;
  private readonly now: () => number;
  // Last stall fired per task; a new one only fires after fresh activity.
  private readonly stalledAt = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly deps: TaskWatchdogDeps,
    options: TaskWatchdogOptions = {}
  ) {
    this.scoutSilenceMs = options.scoutSilenceMs ?? 15 * 60_000;
    this.shipSilenceMs = options.shipSilenceMs ?? 45 * 60_000;
    this.launchStallMs = options.launchStallMs ?? 3 * 60_000;
    this.checkMs = options.checkMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.checkMs);
    this.timer.unref?.();
    // Heal restart-orphaned tasks immediately: a server restart kills its PTYs
    // without firing onSessionExit, so persisted tasks reload as "working" with
    // a session that no longer exists. The first sweep flips them within seconds
    // instead of waiting on the slow silence threshold.
    void this.sweep();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // One interval pass: reconcile dead sessions first (so a task with no live
  // worker leaves "working" before the silence check reasons about it), then
  // run the silence check on what remains. Interval-driven and exposed for
  // tests; both sub-passes are individually exposed too.
  async sweep(): Promise<void> {
    let live: Set<string> | undefined;
    if (this.deps.liveSessionIds) {
      try {
        live = await this.deps.liveSessionIds();
      } catch {
        // Liveness unknown this pass; fall back to silence-only, generic text.
        live = undefined;
      }
    }
    if (live) {
      try {
        this.reconcileDeadSessions(live);
      } catch {
        // Reconcile passes never disturb the server.
      }
    }
    try {
      this.checkSilence(live);
    } catch {
      // Watchdog passes never disturb the server.
    }
    try {
      this.healBlocked();
    } catch {
      // Self-heal passes never disturb the server.
    }
  }

  // Give every blocked task a chance to self-heal. Fire-and-forget: the handler
  // may do git/gh work, and its own in-flight guard keeps a slow heal from being
  // re-entered by the next sweep. No-op when no handler is wired.
  private healBlocked(): void {
    if (!this.deps.healBlocked) {
      return;
    }
    for (const task of this.deps.tasks.list()) {
      if (task.state !== "blocked") {
        continue;
      }
      void Promise.resolve(this.deps.healBlocked(task)).catch(() => {});
    }
  }

  // Missing PTYs are runtime facts, not task-state transitions. The runtime
  // manager owns the generation CAS and interruption evidence.
  reconcileDeadSessions(live: Set<string>): void {
    for (const task of this.deps.tasks.list()) {
      if ((task.state !== "working" && task.state !== "completion_requested") || !task.sessionId) {
        continue;
      }
      if (live.has(task.sessionId) || isTeardownInFlight(task.id)) {
        continue;
      }
      try {
        const transitioned = this.deps.runtimeInterrupted?.(
          task.sessionId,
          "worker runtime interrupted (server restart or missing PTY ownership)"
        );
        if (transitioned) {
          this.deps.metrics?.increment("watchdog.sessionReconciled");
        }
      } catch {
        // The ledger may have moved concurrently; a lost reconcile is retried
        // next sweep.
      }
    }
  }

  // G3 pass; interval-driven, exposed for tests. `live`, when known, makes the
  // stall message honest: a genuinely dead session is already reconciled above,
  // so a stall here means the session is alive but idle.
  checkSilence(live?: Set<string>): void {
    const now = this.now();
    for (const task of this.deps.tasks.list()) {
      if (task.state !== "working") {
        this.stalledAt.delete(task.id);
        continue;
      }
      const lastEvent = Date.parse(task.updatedAt) || 0;
      const activity = (task.sessionId ? this.deps.sessionActivityAt?.(task.sessionId) : undefined) ?? 0;
      const last = Math.max(lastEvent, activity);
      const launchAt = Date.parse(task.createdAt) || 0;
      const hasPostLaunchActivity = activity >= launchAt && activity > 0;
      const sessionKnownLive = live !== undefined && task.sessionId !== undefined && live.has(task.sessionId);
      const sessionKnownGone = live !== undefined && task.sessionId !== undefined && !live.has(task.sessionId);

      // Launch-stall backstop (acceptance #2): a task whose live session has been
      // idle since launch, produced no transcript activity, and never received
      // any worker or hook signal is
      // dead on arrival - most often a provider usage limit the terminal detector
      // did not recognize (the detector is the fast, evidence-anchored path; this
      // catches unknown shapes). Confirmed-live only: without liveness we cannot
      // tell it apart from a worker still spinning up, so we defer to the stall.
      // Flip to blocked (recoverable via blocked -> working) so an idle-stuck
      // session stops reading as benign and wakes the mate.
      if (
        sessionKnownLive &&
        now - last >= this.launchStallMs &&
        !this.hasReported(task.id) &&
        !hasPostLaunchActivity
      ) {
        try {
          this.deps.tasks.recordEvent(task.id, {
            kind: "blocked",
            source: "system",
            message: "worker produced no activity since launch (session idle); likely a provider usage limit or a failed start",
            data: { reason: "no_launch_activity", sessionId: task.sessionId }
          });
          this.deps.metrics?.increment("watchdog.launchStalls");
        } catch {
          // Ledger moved concurrently; retried next sweep.
        }
        // Flipped out of working - the loop's next pass skips it.
        continue;
      }

      const threshold = task.kind === "scout" ? this.scoutSilenceMs : this.shipSilenceMs;
      const fired = this.stalledAt.get(task.id);
      // Fired for this quiet spell already; only fresh activity re-arms.
      if (fired !== undefined && fired >= last) {
        continue;
      }
      if (now - last < threshold) {
        continue;
      }
      const minutes = Math.round((now - last) / 60_000);
      const message = sessionKnownLive
        ? `worker session is alive but idle: no task events or activity for ${minutes} min`
        : sessionKnownGone
          ? `worker session no longer exists; task still working after ${minutes} min quiet`
          : `no task events or session activity for ${minutes} min`;
      this.emitStalled(task.id, message);
      // Stamped after the emit so the stall's own updatedAt can never read as
      // fresh activity that re-arms this same quiet spell.
      this.stalledAt.set(task.id, this.now());
    }
  }

  // A task has "reported" once any worker verb or hook event landed - i.e. the
  // worker actually started. A task carrying only system-sourced bookkeeping
  // (created, the activity-flip "working") never got off the ground.
  private hasReported(taskId: string): boolean {
    return this.deps.tasks
      .events(taskId)
      .some((event) => event.source === "worker" || event.source === "hook");
  }

  private emitStalled(taskId: string, message: string): void {
    try {
      this.deps.tasks.recordEvent(taskId, { kind: "stalled", source: "system", message });
      this.deps.metrics?.increment("watchdog.stalls");
    } catch {
      // The ledger may have moved concurrently; a lost stall note is fine.
    }
  }
}

// G4: a worker session exited (or errored) - if its task is still live, the
// task must not sit "working" forever. Auto-post a system-sourced "blocked"
// (not failed: work may be resumable, the mate decides) with the exit context.
// Intentional teardowns are excluded: executeTeardown stops the session itself
// and writes the authoritative failed/landed/closed trail.
export function reportSessionExitToTask(
  tasks: TaskStore,
  sessionId: string,
  context: SessionExitContext = { status: "done" },
  metrics?: StateMetrics,
  runtimeInterrupted?: (sessionId: string, message: string, intentional: boolean) => void
): void {
  const task = tasks.list().find((candidate) => candidate.sessionId === sessionId);
  try {
    const exitBit = context.exitCode !== undefined ? ` (exit ${context.exitCode})` : "";
    const tailBit = context.tail ? ` · last output: ${clip(context.tail, 160)}` : "";
    runtimeInterrupted?.(
      sessionId,
      task
        ? `worker runtime ended while task stayed ${task.state}${exitBit}${tailBit}`
        : `worker runtime ended without an owning task${exitBit}${tailBit}`,
      task ? isTeardownInFlight(task.id) : false
    );
    if (!task || task.state === "closed") {
      return;
    }
    if (LIVE_STATES.has(task.state) && !isTeardownInFlight(task.id)) {
      metrics?.increment("watchdog.sessionDeaths");
    } else {
      tasks.recordEvent(task.id, { kind: "note", source: "system", message: "worker session ended" });
    }
  } catch {
    // Never let ledger bookkeeping disturb session teardown.
  }
}

// G5: a worker CLI printed its provider usage-limit line and went quiet (see
// usageLimitDetect). The session is dead-on-arrival - it will make no progress
// until the owner adds credits or the limit resets - but nothing has exited, so
// left alone the task sits "working" forever. Auto-post a system-sourced
// "blocked" (not failed: the work resumes the moment credits return, and the
// mate decides) carrying the provider, the CLI's own message, and the named
// retry time. recordEvent fires the ledger subscribers, so this rides the same
// mate wake channel every boss-relevant event does - the whole point: the stall
// becomes an immediate notification instead of silence.
export function reportUsageLimitToTask(
  tasks: TaskStore,
  sessionId: string,
  limit: UsageLimit,
  metrics?: StateMetrics
): void {
  const task = tasks.list().find((candidate) => candidate.sessionId === sessionId);
  if (!task || !LIVE_STATES.has(task.state) || isTeardownInFlight(task.id)) {
    return;
  }
  const retryBit = limit.retryAt ? ` · try again at ${limit.retryAt}` : "";
  try {
    tasks.recordEvent(task.id, {
      kind: "blocked",
      source: "system",
      message: `${limit.provider} usage limit reached${retryBit} · ${clip(limit.message, 200)}`,
      data: {
        reason: "usage_limit",
        provider: limit.provider,
        ...(limit.retryAt ? { retryAt: limit.retryAt } : {}),
        message: limit.message
      }
    });
    metrics?.increment("watchdog.usageLimits");
  } catch {
    // Never let ledger bookkeeping disturb PTY monitoring.
  }
}

function clip(text: string, max: number): string {
  const squeezed = text.replace(/\s+/g, " ").trim();
  return squeezed.length <= max ? squeezed : `${squeezed.slice(0, max - 1)}…`;
}
