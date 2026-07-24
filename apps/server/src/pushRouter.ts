import type {
  AgentSession,
  AgentSessionStatus,
  PendingApproval,
  PendingQuestion,
  Task,
  TaskEventKind
} from "@perch/shared";
import { findingsPushBody, parseNoMistakesGate } from "./findings.js";
import type { PushSender } from "./push.js";

// Push routing: a push is a request for the boss's attention, so only
// conversations the boss is IN may push. Three roles:
//
// - mate: the boss's one conversation. A mate reply pushes like a messaging
//   app (title "Mate", body = the message) unless a phone is viewing it.
// - crew (labels.parent set): the mate's workers. They NEVER push directly -
//   their events reach the mate over the wake channel, and the mate relays
//   what matters. A deterministic escalation fallback backstops the relay:
//   needs_decision/blocked arm a timer, and if no mate reply follows in time
//   the raw event pushes late rather than getting lost.
// - solo (everything else): the boss talks to these directly, so turn-done /
//   waiting / error pushes stay.
//
// Approvals are the exception: time-sensitive and a security boundary, they
// push for ALL sessions. A mate that dies or exits while crew tasks are live
// pushes once (the mate-down backstop) so the fleet is never silently
// unsupervised.

export type SessionRole = "mate" | "crew" | "solo";

// Task-event kinds the durable push channel must deliver: the kinds that push
// (or arm the escalation fallback), plus the state-moving kinds whose arrival
// disarms a now-stale fallback. Everything else (notes, created, chart_ready -
// which pushes via chartReady - and the mate-only stalled) is inert here and
// never enqueued for this channel.
export const PUSH_EVENT_KINDS = new Set<TaskEventKind>([
  "pr_linked",
  "needs_decision",
  "blocked",
  "runtime_interrupted",
  "completion_requested",
  "done",
  "failed",
  "checks_green",
  "merge_ready",
  "merged",
  "working",
  "landed",
  "closed"
]);

// Task states with a live worker; the mate-down backstop only matters then.
const LIVE_TASK_STATES = new Set(["queued", "working", "needs_you", "blocked", "completion_requested"]);

export type PushRouterDeps = {
  push: PushSender;
  // Friendly project name for a repo/session path (registry name or basename).
  projectName: (path: string | undefined) => string | undefined;
  // The message a turn produced, for mate/solo push bodies.
  lastAssistantText?: (sessionId: string) => string | undefined;
  // A paired phone has the session's detail tier open right now. Routes the
  // mate push away from a boss already reading the conversation; a
  // backgrounded app drops its socket, so stale presence cannot suppress.
  hasActiveViewer?: (sessionId: string) => boolean;
  // Live session lookup for role classification of task events.
  findSession?: (sessionId: string) => AgentSession | undefined;
  // Any task still has a live worker (arms the mate-down backstop).
  hasLiveTasks?: () => boolean;
};

export type PushRouterOptions = {
  // How long the mate gets to relay a needs_decision/blocked before the raw
  // event pushes directly. PERCH_ESCALATION_FALLBACK_MS; default 3 minutes.
  fallbackMs?: number;
};

type ArmedFallback = {
  timer: ReturnType<typeof setTimeout>;
  kind: "needs_decision" | "blocked" | "runtime_interrupted";
};

export class PushRouter {
  private readonly fallbackMs: number;
  private readonly fallbacks = new Map<string, ArmedFallback>();
  // Sessions leave the fleet the moment they exit, but task events (the G4
  // death-blocked especially) arrive after; remember each session's role so
  // late events still classify.
  private readonly roles = new Map<string, SessionRole>();
  // Mate-down pushes once per mate session; a fresh mate re-arms.
  private readonly mateDownPushed = new Set<string>();

  constructor(
    private readonly deps: PushRouterDeps,
    options: PushRouterOptions = {}
  ) {
    this.fallbackMs = options.fallbackMs ?? 3 * 60_000;
  }

  stop(): void {
    for (const armed of this.fallbacks.values()) {
      clearTimeout(armed.timer);
    }
    this.fallbacks.clear();
  }

  // Turn-level moments (running->idle, waiting, error), from the fleet
  // monitor. Fired only on real status changes, never repeats.
  sessionStatusChanged(
    sessionId: string,
    session: AgentSession | undefined,
    from: AgentSessionStatus | undefined,
    to: AgentSessionStatus
  ): void {
    const role = this.classify(sessionId, session);

    if (role === "mate") {
      // A finished turn or an explicit ask is the mate speaking to the boss.
      if (to === "waiting" || (to === "idle" && from === "running")) {
        this.mateSpoke(sessionId);
      } else if (to === "error" || to === "done") {
        this.mateDown(sessionId);
      }
      return;
    }

    if (role === "crew") {
      // Never directly: the wake channel carries these to the mate.
      return;
    }

    const project = this.projectOf(session);
    const snippet = truncateAtWord(this.deps.lastAssistantText?.(sessionId) ?? "");
    if (to === "waiting") {
      this.sendDetached({
        title: `${project} (solo) is waiting on you`,
        subtitle: pushContext(session),
        body: snippet || "It asked for your input and is paused until you reply.",
        sessionId,
        category: "turn_done"
      });
    } else if (to === "idle" && from === "running") {
      this.sendDetached({
        title: `${project} (solo) finished`,
        subtitle: pushContext(session),
        body: snippet || "The reply is ready when you are.",
        sessionId,
        category: "turn_done"
      });
    } else if (to === "error") {
      this.sendDetached({
        title: `${project} (solo) stopped unexpectedly`,
        subtitle: pushContext(session),
        body: "The session ended with an error - tap to see what happened.",
        sessionId,
        category: "error"
      });
    }
  }

  // Session process ended (any reason). Only the mate-down backstop cares:
  // solo/crew exits already surface through status changes and the task
  // ledger's G4 death-blocked event.
  sessionExited(sessionId: string): void {
    if (this.roles.get(sessionId) === "mate") {
      this.mateDown(sessionId);
    }
  }

  // Permission prompts push for ALL sessions - time-sensitive and a security
  // boundary, they cannot wait for the mate to relay.
  approvalNeeded(sessionId: string, session: AgentSession | undefined, approval: PendingApproval): void {
    const role = this.classify(sessionId, session);
    const project = this.projectOf(session);
    const actor = session?.workerName ?? (role === "mate" ? "Mate" : role === "crew" ? "Worker" : undefined);
    const context = [approval.context?.tool, approval.context?.app].filter(Boolean).join(" / ");
    this.sendDetached({
      title: actor ? `${actor} needs permission` : "Your OK needed",
      subtitle: pushContext(session),
      body: context
        ? `${project}: ${context} - ${truncateAtWord(approval.summary, 100)}`
        : approval.command
        ? `The ${project} agent wants to run: ${truncateAtWord(approval.command, 120)}`
        : `${project}: ${truncateAtWord(approval.summary, 120)}`,
      sessionId,
      // Multi-choice and desktop-only prompts must open the exact card. Generic
      // lock-screen Approve / Deny actions would collapse or invent choices.
      category: approval.decisions?.length || approval.remoteResolutionUnavailable
        ? "approval_choices"
        : "approval"
    });
  }

  // AskUserQuestion prompts gate the composer exactly like approvals, so they
  // ride the same always-push rule.
  questionAsked(sessionId: string, session: AgentSession | undefined, question: PendingQuestion): void {
    this.classify(sessionId, session);
    const project = this.projectOf(session);
    const first = question.questions[0]?.question;
    this.sendDetached({
      title: "A question for you",
      subtitle: pushContext(session),
      body: first ? `${project}: ${truncateAtWord(first)}` : `The ${project} agent needs you to choose how to proceed.`,
      sessionId,
      category: "approval"
    });
  }

  // A chart was registered for review. Charts exist to be reviewed by the
  // boss, so - like approvals - this is boss-facing for EVERY role: a crew
  // worker's chart pushes directly and is never absorbed as crew noise behind
  // the mate relay.
  chartReady(sessionId: string, session: AgentSession | undefined, chartName: string): void {
    this.classify(sessionId, session);
    const project = this.projectOf(session);
    this.sendDetached({
      title: `${project}: a chart is ready for review`,
      subtitle: pushContext(session),
      body: `"${chartName}" is up - take a look and mark it up when you have a minute.`,
      sessionId,
      category: "chart_ready"
    });
  }

  // Task ledger events. Crew tasks stay silent (the mate relays), except that
  // needs_decision/blocked arm the escalation fallback. Tasks the boss
  // dispatched directly (no mate parentage) push immediately.
  taskEvent(task: Task, event: { kind: TaskEventKind; message?: string; data?: Record<string, unknown> }): void {
    void this.deliverTaskEvent(task, event).catch((error) => {
      console.warn(`push: task event delivery failed: ${error instanceof Error ? error.message : error}`);
    });
  }

  async deliverTaskEvent(
    task: Task,
    event: { kind: TaskEventKind; message?: string; data?: Record<string, unknown> }
  ): Promise<void> {
    const crew = this.isCrewTask(task);

    // Live permission surfaces already send the dedicated role-aware approval
    // push with the exact session deep link. Their mirrored task evidence is
    // for durability and Mate context, not a second delayed notification.
    if (
      event.kind === "needs_decision" &&
      (event.data?.reason === "approval_request" || event.data?.reason === "codex_server_request")
    ) {
      return;
    }

    if (event.kind === "needs_decision" || event.kind === "blocked" || event.kind === "runtime_interrupted") {
      if (crew) {
        this.armFallback(task, event.kind, event.message, event.data);
        return;
      }
      await this.pushDecisionMoment(task, event.kind, event.message, event.data);
      return;
    }

    // The moment passed (worker resumed, finished, or the task closed):
    // whatever the boss would have been asked is stale, so disarm.
    this.disarmFallback(task.id);

    if (crew) {
      return;
    }

    const project = this.deps.projectName(task.project) ?? "a project";
    const sessionId = task.sessionId ?? "system";
    switch (event.kind) {
      case "pr_linked":
        await this.deps.push.send({
          title: `${project} PR linked`,
          subtitle: taskSubtitle(task),
          body: event.message ?? "A task PR is now available.",
          sessionId,
          category: "turn_done"
        });
        break;
      case "completion_requested":
        await this.deps.push.send({
          title: `${project} task needs verification`,
          subtitle: taskSubtitle(task),
          body: event.message ?? "The worker requested completion verification.",
          sessionId,
          category: "turn_done"
        });
        break;
      case "done":
        await this.deps.push.send({
          title: `${project} task finished`,
          subtitle: taskSubtitle(task),
          body: event.message ?? "The worker reports it is done.",
          sessionId,
          category: "turn_done"
        });
        break;
      case "failed":
        await this.deps.push.send({
          title: `${project} task failed`,
          subtitle: taskSubtitle(task),
          body: event.message ?? "The worker could not complete it.",
          sessionId,
          category: "error"
        });
        break;
      case "checks_green":
        await this.deps.push.send({
          title: "PR checks are green",
          subtitle: taskSubtitle(task),
          body: task.pr?.url
            ? `${task.pr.url} - CI/status checks only; merge readiness not confirmed.`
            : "CI/status checks passed; merge readiness is not confirmed yet.",
          sessionId,
          category: "turn_done"
        });
        break;
      case "merge_ready":
        await this.deps.push.send({
          title: "PR is ready to merge",
          subtitle: taskSubtitle(task),
          body: task.pr?.url ?? "GitHub reports draft, reviews, mergeability, and required checks are ready.",
          sessionId,
          category: "turn_done"
        });
        break;
      case "merged":
        await this.deps.push.send({
          title: "PR merged",
          subtitle: taskSubtitle(task),
          body: task.pr?.url ?? "The work landed.",
          sessionId,
          category: "turn_done"
        });
        break;
      default:
        break;
    }
  }

  // --- internals ----------------------------------------------------------

  // The mate produced a message for the boss: push it messaging-app style
  // (unless a phone is already reading the conversation), and count it as the
  // relay every armed escalation fallback was waiting for.
  private mateSpoke(sessionId: string): void {
    // Relayed either way: the boss got the push or is looking at the chat.
    for (const armed of this.fallbacks.values()) {
      clearTimeout(armed.timer);
    }
    this.fallbacks.clear();

    if (this.deps.hasActiveViewer?.(sessionId)) {
      return;
    }
    const text = truncateAtWord(this.deps.lastAssistantText?.(sessionId) ?? "");
    this.sendDetached({
      title: "Mate",
      body: text || "Your mate has an update - tap to read it.",
      sessionId,
      category: "mate_message",
      threadId: "mate"
    });
  }

  private mateDown(sessionId: string): void {
    if (this.mateDownPushed.has(sessionId)) {
      return;
    }
    if (!(this.deps.hasLiveTasks?.() ?? false)) {
      return;
    }
    this.mateDownPushed.add(sessionId);
    this.sendDetached({
      title: "Your mate went quiet",
      body: "Not responding - tap to check on things.",
      sessionId,
      category: "error",
      threadId: "mate"
    });
  }

  private armFallback(
    task: Task,
    kind: ArmedFallback["kind"],
    message?: string,
    data?: Record<string, unknown>
  ): void {
    // Re-arm per event: the newest question/blocker is the one worth pushing.
    this.disarmFallback(task.id);
    const timer = setTimeout(() => {
      this.fallbacks.delete(task.id);
      void this.pushDecisionMoment(task, kind, message, data).catch((error) => {
        console.warn(`push: fallback delivery failed: ${error instanceof Error ? error.message : error}`);
      });
    }, this.fallbackMs);
    timer.unref?.();
    this.fallbacks.set(task.id, { timer, kind });
  }

  private disarmFallback(taskId: string): void {
    const armed = this.fallbacks.get(taskId);
    if (armed) {
      clearTimeout(armed.timer);
      this.fallbacks.delete(taskId);
    }
  }

  private async pushDecisionMoment(
    task: Task,
    kind: ArmedFallback["kind"],
    message?: string,
    data?: Record<string, unknown>
  ): Promise<void> {
    const project = this.deps.projectName(task.project) ?? "a project";
    const sessionId = task.sessionId ?? "system";
    if (kind === "runtime_interrupted") {
      await this.deps.push.send({
        title: `${project} worker went down`,
        subtitle: taskSubtitle(task),
        body: message ?? "The worker's runtime was interrupted; the task keeps its state.",
        sessionId,
        category: "error"
      });
    } else if (kind === "needs_decision") {
      // A no-mistakes ask-user gate carries its findings table as structured
      // data: the push names the gate, the count, and the worst finding
      // verbatim instead of whatever prose the worker put in message.
      const gate = parseNoMistakesGate(data);
      await this.deps.push.send({
        title: "Needs your call",
        subtitle: taskSubtitle(task),
        body: `${project}: ${gate ? truncateAtWord(findingsPushBody(gate)) : (message ?? "the worker is waiting on your decision.")}`,
        sessionId,
        category: "turn_done"
      });
    } else {
      await this.deps.push.send({
        title: `Stuck on ${project}`,
        subtitle: taskSubtitle(task),
        body: message ?? "The worker hit something it cannot get past.",
        sessionId,
        category: "turn_done"
      });
    }
  }

  private sendDetached(notification: Parameters<PushSender["send"]>[0]): void {
    void Promise.resolve(this.deps.push.send(notification)).catch((error) => {
      console.warn(`push: delivery failed: ${error instanceof Error ? error.message : error}`);
    });
  }

  private classify(sessionId: string, session: AgentSession | undefined): SessionRole {
    const resolved = session ?? this.deps.findSession?.(sessionId);
    if (resolved) {
      const role: SessionRole =
        resolved.labels?.role === "mate" ? "mate" : resolved.labels?.parent ? "crew" : "solo";
      this.roles.set(sessionId, role);
      return role;
    }
    return this.roles.get(sessionId) ?? "solo";
  }

  private isCrewTask(task: Task): boolean {
    if (task.parentSessionId) {
      return true;
    }
    if (!task.sessionId) {
      return false;
    }
    return this.classify(task.sessionId, undefined) === "crew";
  }

  private projectOf(session: AgentSession | undefined): string {
    return this.deps.projectName(session?.cwd) ?? session?.title ?? "an agent";
  }
}

// Clip to ~max chars at a word boundary, single-line, with an ellipsis.
export function truncateAtWord(text: string, max = 150): string {
  const squeezed = text.replace(/\s+/g, " ").trim();
  if (squeezed.length <= max) {
    return squeezed;
  }
  const cut = squeezed.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const kept = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${kept.trimEnd()}…`;
}

// "branch · ~/short/path" for notification subtitles, mirroring the app's
// fleet-row context line.
export function pushContext(session: AgentSession | undefined): string | undefined {
  if (!session) {
    return undefined;
  }
  const parts: string[] = [];
  if (session.branch) {
    parts.push(session.branch);
  }
  if (session.cwd) {
    const shortened = session.cwd.replace(/^\/Users\/[^/]+/, "~");
    const components = shortened.split("/").filter(Boolean);
    parts.push(components.length > 4 ? `…/${components.slice(-3).join("/")}` : shortened);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function taskSubtitle(task: Task): string {
  return task.workerName ? `${task.workerName} · ${task.title}` : task.title;
}
