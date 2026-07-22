import type { AgentSession, AgentSessionStatus } from "@perch/shared";
import type { StateMetrics } from "./stateMetrics.js";

// Reconciliation sweep (G1). Session status is push-driven by one-shot hook
// curls with no retry, so a lost Stop hook leaves a session "running" forever
// and a lost UserPromptSubmit hides a turn. The sweep re-derives status for
// suspicious Claude sessions from ground truth the server already holds -
// the rendered terminal screen and the transcript file's mtime - and
// corrects drift through the same applyExternalStatus path the hooks use
// (source "reconciler"), so a lost push becomes a temporary lie instead of a
// permanent one. Pushes stay the fast path; this never replaces them.
//
// PTY process liveness is the third ground truth, but it is already enforced
// upstream: the PTY adapter sweeps dead processes on every listSessions call,
// which each sweep pass performs.

// Claude renders this line while a turn is in flight; it sits in the bottom
// few screen lines and disappears when the turn ends.
const RUNNING_MARKER = /esc to interrupt/i;

export type ReconcilerDeps = {
  // Sessions with live hook-derived status overlaid (monitor.withLiveState).
  listSessions: () => Promise<AgentSession[]>;
  // Last few rendered screen lines for a terminal session; undefined when the
  // session cannot be captured (gone, non-terminal).
  screenTail: (sessionId: string) => Promise<string | undefined>;
  // Age of the session's transcript file; undefined when no transcript
  // is correlated (sessions without hooks are never corrected - their status
  // is not hook-driven, so there is no lost push to repair).
  transcriptAgeMs: (sessionId: string) => number | undefined;
  // Correction sink: wired to monitor.applyExternalStatus(..., "reconciler").
  applyStatus: (sessionId: string, status: AgentSessionStatus) => void;
  metrics?: StateMetrics;
};

export type ReconcilerOptions = {
  sweepMs?: number;
  // How long a transcript must be quiet before a "running" claim is doubted.
  staleMs?: number;
};

export type Correction = {
  sessionId: string;
  from: AgentSessionStatus;
  to: AgentSessionStatus;
  reason: string;
};

export class StatusReconciler {
  private readonly sweepMs: number;
  private readonly staleMs: number;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly deps: ReconcilerDeps,
    options: ReconcilerOptions = {}
  ) {
    this.sweepMs = options.sweepMs ?? 60_000;
    this.staleMs = options.staleMs ?? 120_000;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.sweep().catch(() => {});
    }, this.sweepMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // One pass over the fleet; exposed for tests. Returns what it corrected.
  async sweep(): Promise<Correction[]> {
    const corrections: Correction[] = [];
    const sessions = await this.deps.listSessions();
    for (const session of sessions) {
      if (session.kind !== "terminal") {
        continue;
      }
      // Only the states hooks drive; needs_approval/done/error have their own
      // resolution paths and are never second-guessed here.
      if (session.status !== "running" && session.status !== "idle" && session.status !== "waiting") {
        continue;
      }
      const transcriptAgeMs = this.deps.transcriptAgeMs(session.id);
      if (transcriptAgeMs === undefined) {
        continue;
      }
      // Cheap pre-filter before touching the screen: a running session with
      // fresh transcript writes is truthy, an idle one with a stale transcript
      // is too.
      const transcriptFresh = transcriptAgeMs < this.staleMs;
      if (session.status === "running" ? transcriptFresh : !transcriptFresh) {
        continue;
      }
      const screen = await this.deps.screenTail(session.id);
      const verdict = deriveStatusCorrection({
        status: session.status,
        screen,
        transcriptAgeMs,
        staleMs: this.staleMs
      });
      if (!verdict) {
        continue;
      }
      this.deps.applyStatus(session.id, verdict.to);
      // Distinct log line: each correction is a measured lost push.
      console.log(
        `reconcile: corrected session=${session.id.slice(0, 12)} ${session.status}->${verdict.to} (${verdict.reason})`
      );
      this.deps.metrics?.increment("reconciler.corrections");
      this.deps.metrics?.observe("reconciler.correctionLagMs", transcriptAgeMs);
      corrections.push({ sessionId: session.id, from: session.status, to: verdict.to, reason: verdict.reason });
    }
    return corrections;
  }
}

// Pure correction rule, exported for tests. Conservative on purpose: both
// corrections require the screen and the transcript to agree, so a mid-tool
// quiet spell (long build, no transcript writes) is never flipped idle while
// the TUI still shows a turn in flight.
export function deriveStatusCorrection(input: {
  status: AgentSessionStatus;
  screen?: string;
  transcriptAgeMs: number;
  staleMs: number;
}): { to: AgentSessionStatus; reason: string } | undefined {
  const runningOnScreen = input.screen !== undefined && RUNNING_MARKER.test(input.screen);
  const transcriptFresh = input.transcriptAgeMs < input.staleMs;

  if (input.status === "running") {
    // Lost Stop: claims running, but no turn on screen and the transcript has
    // been quiet past the threshold. An unreadable screen is not proof either
    // way, so it does not correct.
    if (input.screen !== undefined && !runningOnScreen && !transcriptFresh) {
      return {
        to: "idle",
        reason: `no turn on screen, transcript quiet ${Math.round(input.transcriptAgeMs / 1000)}s`
      };
    }
    return undefined;
  }

  // Lost UserPromptSubmit/PreToolUse: claims idle/waiting, but a turn is
  // visibly in flight and the transcript is being written right now.
  if (runningOnScreen && transcriptFresh) {
    return { to: "running", reason: "turn in flight on screen with fresh transcript" };
  }
  return undefined;
}
