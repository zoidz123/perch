import type {
  AgentKind,
  AgentEvent,
  AgentSession,
  AgentSessionStatus,
  CodexReasoningEffort,
  FleetEvent,
  PendingApproval,
  PendingClaudeInteraction,
  PendingQuestion,
  PendingServerRequest,
  StartAgentRequest,
  WebSocketClientEvent,
  WebSocketRpcRequest,
  WebSocketRpcResponse,
  WebSocketServerEvent
} from "@perch/shared";

// The live model + reasoning effort a session is running, tracked so the fleet
// overview and GET /sessions report exactly what an agent is using right now.
export type SessionModel = {
  model?: string;
  modelLabel?: string;
  effort?: CodexReasoningEffort;
};
import type { RawData } from "ws";
import type { AgentAdapter } from "./adapters/types.js";
import type { PromptDeliverySource, PromptDeliveryTracker } from "./promptDeliveries.js";
import type { AuditLog } from "./audit.js";
import { detectPrompt, type DetectedPrompt } from "./promptDetect.js";
import type { PushRouter } from "./pushRouter.js";
import type { SessionStatusSource } from "./stateMetrics.js";
import { detectUsageLimit, type UsageLimit } from "./usageLimitDetect.js";

// Rendered lines pulled per tail capture. The overview tail is a few lines, but
// the prompt detector reads a whole screen: a TUI pads blank rows above its
// bottom-anchored boxes, so a dialog a handful of content lines up sits far more
// raw lines from the bottom.
const SCREEN_CAPTURE_LINES = 60;

// A session status change with its provenance, observable via
// FleetMonitorOptions.onStatusChange (feeds the state metrics, G6).
export type SessionStatusChange = {
  sessionId: string;
  from?: AgentSessionStatus;
  to: AgentSessionStatus;
  source: SessionStatusSource;
};

// How a WebSocket client authenticated: the server token (CLI, local tools)
// or a paired device's revocable token. Device clients get server-enforced
// restrictions (no resize) and can be disconnected when their token is revoked.
export type ClientAuth = { kind: "server" } | { kind: "device"; deviceId: string };

export type WebSocketRpcHandler = (
  request: WebSocketRpcRequest,
  auth: ClientAuth
) => Promise<WebSocketRpcResponse>;

export type StartAgentLauncher = (
  input: {
    request: StartAgentRequest;
    auditMeta?: { deviceId?: string; remoteAddress?: string };
  }
) => Promise<{ session: AgentSession }>;

// The plaintext-facing socket surface the monitor talks to. A raw `ws.WebSocket`
// satisfies it directly (the legacy `?token=` path); an `EncryptedServerChannel`
// also satisfies it, encrypting on `send` and handing decrypted plaintext to the
// `message` listener, so the monitor stays plaintext-only regardless of transport.
export interface ClientSocket {
  readonly OPEN: number;
  readonly readyState: number;
  send(data: string): void;
  terminate(): void;
  on(event: "message", listener: (data: RawData) => void): unknown;
  on(event: "close", listener: () => void): unknown;
}

type Client = {
  socket: ClientSocket;
  auth: ClientAuth;
  // Sessions this client opened the focused-detail tier for. Empty is the
  // common case: every client always receives the fleet overview regardless.
  subscriptions: Set<string>;
};

// Live status/activity derived from the event stream, keyed by workspace.
// Agent-hook events only carry a workspace id, so status is tracked per
// workspace and applied to that workspace's terminal sessions.
type WorkspaceState = {
  status?: AgentSessionStatus;
  agent?: AgentKind;
  at: string;
};

export type FleetMonitorOptions = {
  // Slow safety-net resync that recovers from missed events / resume gaps.
  reconcileMs?: number;
  // Lines captured for the cheap overview tail vs. the rich focused detail.
  tailLines?: number;
  detailLines?: number;
  // Minimum spacing between overview tail captures for one session.
  tailThrottleMs?: number;
  // Debounce before (re)capturing focused detail for a subscribed session.
  detailThrottleMs?: number;
  // Coalesce bursts of state changes into one fleet broadcast.
  broadcastMs?: number;
  // Mutating client actions (input/resize) are auditable when provided.
  auditLog?: AuditLog;
  // Routes away-mode moments (approval needed, turn done, mate replies) to
  // the push layer by conversation role; the monitor only reports moments.
  pushRouter?: PushRouter;
  // Called after each reconcile with the ids of sessions that still exist, so
  // per-session state held elsewhere (timeline items) can be released too.
  onPrune?: (activeSessionIds: Set<string>) => void;
  // Called when a device is revoked, so transports that hold their own sockets
  // (the relay client) sever the device's underlying data socket too. The LAN
  // path needs nothing here: a direct WS client is terminated in-place below.
  onDisconnectDevice?: (deviceId: string) => void;
  // Observes every session status change with its source (hook, adapter,
  // system action, reconciler correction) - the G6 measurement tap.
  onStatusChange?: (change: SessionStatusChange) => void;
  // Best-effort model fallback for live sessions that predate launch-time
  // model tracking or whose adapter cannot report a model.
  sessionModelFallback?: (session: AgentSession) => SessionModel | undefined;
  // Centralized launch service. The monitor owns WebSocket client plumbing,
  // but not agent launch policy.
  startAgent?: StartAgentLauncher;
  // A provider integration or terminal fallback reported quota exhaustion.
  // The monitor flips the session status to `error`; this hook owns task-ledger
  // policy. Fired once per distinct condition per session.
  onUsageLimit?: (sessionId: string, agent: AgentKind | undefined, limit: UsageLimit) => void;
  // Called only after composer text was actually submitted to the agent. Text
  // held behind an approval/question gate does not fire this until the later
  // flush succeeds, so task state can follow real turn submission rather than
  // merely accepting input into Perch's queue.
  onInputSubmitted?: (sessionId: string) => void;
  // Claude PTY submissions cross a semantic boundary that process.write
  // cannot acknowledge. This tracker journals intent before typing and closes
  // it only from a provider hook or matching transcript row.
  promptDeliveries?: PromptDeliveryTracker;
  // Durable warning text derived from the prompt-delivery ledger. It is
  // recomputed for every fleet snapshot, so disconnected clients see it on
  // reconnect instead of depending on a one-shot WebSocket event.
  promptDeliveryWarning?: (sessionId: string) => AgentSession["promptDeliveryWarning"];
  // Durable task policy hook for accepted composer input that later becomes
  // undeliverable because the terminal ended or a queued flush failed.
  onQueuedInputRejected?: (sessionId: string, count: number, reason: string) => void;
  // Screen-owned prompts have no provider request callback. These hooks give
  // the task ledger the same durable needs-decision / resolved evidence used
  // by structured Codex server requests.
  onApprovalNeeded?: (sessionId: string, approval: PendingApproval) => void;
  onApprovalResolved?: (sessionId: string, approval: PendingApproval) => void;
};

// One shared monitor for the whole fleet. It subscribes once to the agent
// backend's event stream and fans the same derived state out to every client,
// so N connected phones never multiply backend load.
export class FleetMonitor {
  private readonly clients = new Set<Client>();
  private readonly workspaceState = new Map<string, WorkspaceState>();
  private readonly sessionState = new Map<string, WorkspaceState>();
  // Open permission prompts and composer messages held until the session can
  // take input again. Both surface in the fleet overview.
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  // Codex app-server requests, per session keyed by exact JSON-RPC request id:
  // the protocol allows several to be open at once, and each stays pending
  // until Codex confirms that exact id resolved. Insertion order is the
  // deterministic queue the overview presents, oldest first. A session's entry
  // exists only while at least one request is open, so `has()` is the gate.
  private readonly pendingServerRequests = new Map<string, Map<string, PendingServerRequest>>();
  // Open AskUserQuestion prompts, alongside approvals in the overview. Both
  // gate the composer so typed text never lands in the focused widget.
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly pendingClaudeInteractions = new Map<string, PendingClaudeInteraction>();
  private readonly queuedInputs = new Map<string, Array<{ text: string; deliveryId?: string }>>();
  // Prompts raised off the rendered screen rather than a hook, by session ->
  // prompt id. No hook will ever resolve one, so the detector retracts it when
  // the dialog leaves the screen; the id also keeps a redraw from re-raising it.
  private readonly screenPrompts = new Map<string, DetectedPrompt>();
  // Sessions already surfaced as usage-limited, by session -> detection
  // signature. Keeps repeated provider events or screen redraws from re-blocking
  // the task; a fresh condition fires again.
  private readonly usageLimits = new Map<string, string>();
  // The exact model + reasoning effort each session is running, resolved
  // server-side at launch and updated on every live switch, overlaid onto the
  // fleet overview and GET /sessions so the boss always sees what an agent is
  // actually using.
  private readonly sessionModels = new Map<string, SessionModel>();
  private readonly tails = new Map<string, string>();
  private readonly tailTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastTailAt = new Map<string, number>();
  private readonly detailTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private sessions: AgentSession[] = [];
  private running = false;
  private unsubscribeEvents?: () => void;
  private unsubscribeAgentEvents?: () => void;
  private reconcileTimer?: ReturnType<typeof setInterval>;
  private broadcastTimer?: ReturnType<typeof setTimeout>;

  private readonly reconcileMs: number;
  private readonly tailLines: number;
  private readonly detailLines: number;
  private readonly tailThrottleMs: number;
  private readonly detailThrottleMs: number;
  private readonly broadcastMs: number;
  private readonly auditLog?: AuditLog;
  private pushRouter?: PushRouter;
  private readonly onPrune?: (activeSessionIds: Set<string>) => void;
  private readonly onDisconnectDevice?: (deviceId: string) => void;
  private readonly onStatusChange?: (change: SessionStatusChange) => void;
  private sessionModelFallback?: (session: AgentSession) => SessionModel | undefined;
  private runtimeSnapshot?: (sessionId: string) => AgentSession["runtime"];
  private rpcHandler?: WebSocketRpcHandler;
  private startAgentLauncher?: StartAgentLauncher;
  private readonly onUsageLimit?: (
    sessionId: string,
    agent: AgentKind | undefined,
    limit: UsageLimit
  ) => void;
  private readonly onInputSubmitted?: (sessionId: string) => void;
  private readonly promptDeliveries?: PromptDeliveryTracker;
  private readonly promptDeliveryWarning?: (sessionId: string) => AgentSession["promptDeliveryWarning"];
  private readonly onQueuedInputRejected?: (sessionId: string, count: number, reason: string) => void;
  private readonly onApprovalNeeded?: (sessionId: string, approval: PendingApproval) => void;
  private readonly onApprovalResolved?: (sessionId: string, approval: PendingApproval) => void;
  private claudeManualGateHandler?: (sessionId: string, approval: PendingApproval) => void;

  constructor(
    private readonly adapter: AgentAdapter,
    options: FleetMonitorOptions = {}
  ) {
    this.reconcileMs = options.reconcileMs ?? 30_000;
    this.tailLines = options.tailLines ?? 3;
    this.detailLines = options.detailLines ?? 200;
    this.tailThrottleMs = options.tailThrottleMs ?? 750;
    this.detailThrottleMs = options.detailThrottleMs ?? 250;
    this.broadcastMs = options.broadcastMs ?? 120;
    this.auditLog = options.auditLog;
    this.pushRouter = options.pushRouter;
    this.onPrune = options.onPrune;
    this.onDisconnectDevice = options.onDisconnectDevice;
    this.onStatusChange = options.onStatusChange;
    this.sessionModelFallback = options.sessionModelFallback;
    this.startAgentLauncher = options.startAgent;
    this.onUsageLimit = options.onUsageLimit;
    this.onInputSubmitted = options.onInputSubmitted;
    this.promptDeliveries = options.promptDeliveries;
    this.promptDeliveryWarning = options.promptDeliveryWarning;
    this.onQueuedInputRejected = options.onQueuedInputRejected;
    this.onApprovalNeeded = options.onApprovalNeeded;
    this.onApprovalResolved = options.onApprovalResolved;
  }

  setRpcHandler(handler: WebSocketRpcHandler): void {
    this.rpcHandler = handler;
  }

  setClaudeManualGateHandler(handler: (sessionId: string, approval: PendingApproval) => void): void {
    this.claudeManualGateHandler = handler;
  }

  setSessionModelFallback(fallback: (session: AgentSession) => SessionModel | undefined): void {
    this.sessionModelFallback = fallback;
  }

  setRuntimeSnapshot(resolver: (sessionId: string) => AgentSession["runtime"]): void {
    this.runtimeSnapshot = resolver;
  }

  // Provider integrations call this for structured failures. It shares the
  // same dedupe/status/task-policy path as the terminal fallback.
  reportUsageLimit(sessionId: string, agent: AgentKind | undefined, limit: UsageLimit): void {
    this.surfaceUsageLimit(sessionId, agent, limit);
  }

  setStartAgentLauncher(launcher: StartAgentLauncher): void {
    this.startAgentLauncher = launcher;
  }

  // The router needs the monitor (viewer presence, session lookup) and the
  // monitor needs the router, so the router is attached after construction.
  setPushRouter(router: PushRouter): void {
    this.pushRouter = router;
  }

  addClient(socket: ClientSocket, sessionId?: string, auth: ClientAuth = { kind: "server" }): void {
    const canonicalSessionId = sessionId ? this.canonicalSessionId(sessionId) : undefined;
    const client: Client = {
      socket,
      auth,
      subscriptions: new Set(canonicalSessionId ? [canonicalSessionId] : [])
    };
    this.clients.add(client);

    // Backend work is client-driven: the first client starts the stream, the
    // last to leave stops it, so an idle server does no work.
    this.start();

    this.send(client, { type: "hello", at: new Date().toISOString() });
    // Hand the new client the current overview immediately; it does not wait
    // for the next event or reconcile.
    this.send(client, { type: "fleet", sessions: this.overview(), at: new Date().toISOString() });

    if (canonicalSessionId) {
      void this.sendDetailOpening(client, canonicalSessionId);
    }

    socket.on("message", (raw) => {
      this.handleClientMessage(client, raw);
    });

    socket.on("close", () => {
      this.clients.delete(client);
      if (this.clients.size === 0) {
        this.stop();
      }
    });
  }

  // Record the exact model + reasoning effort a session is running, set at
  // launch (resolved from the launch flags or the CLI's own config default) and
  // updated on every live switch. Overlaid onto the fleet overview / GET
  // /sessions and pushed to clients so the readout stays current as it changes.
  setSessionModel(sessionId: string, model: SessionModel): void {
    const canonical = this.canonicalSessionId(sessionId);
    const previous = this.sessionModels.get(canonical);
    // Merge: an omitted field keeps its prior value (a model-only switch must
    // not reset the effort tier), so only supplied fields move.
    const next: SessionModel = { ...previous };
    if (model.model !== undefined) next.model = model.model;
    if (model.modelLabel !== undefined) next.modelLabel = model.modelLabel;
    if (model.effort !== undefined) next.effort = model.effort;
    if (
      previous &&
      previous.model === next.model &&
      previous.modelLabel === next.modelLabel &&
      previous.effort === next.effort
    ) {
      return;
    }
    this.sessionModels.set(canonical, next);
    this.scheduleBroadcast();
  }

  // Status derived outside the adapter event stream (agent hooks reporting
  // through POST /hooks, mobile approve/answer actions, the reconciliation
  // sweep). Feeds the same per-session live state the fleet overview is built
  // from, resolves stale approvals, and flushes queued composer input once the
  // session is receptive again. `source` stamps the change for the metrics tap.
  applyExternalStatus(
    sessionId: string,
    status: AgentSessionStatus,
    agent?: AgentKind,
    source: SessionStatusSource = "hook"
  ): void {
    const canonical = this.canonicalSessionId(sessionId);
    const previous = this.sessionState.get(canonical);
    this.sessionState.set(canonical, {
      status,
      agent: agent ?? previous?.agent,
      at: new Date().toISOString()
    });
    if (previous?.status !== status) {
      this.onStatusChange?.({ sessionId: canonical, from: previous?.status, to: status, source });
    }

    const pendingForStatus = this.pendingApprovals.get(canonical);
    // A provider can report idle while a nested terminal-owned permission UI
    // is still blocking the PTY. Only a rendered-screen capture can prove that
    // prompt closed. Hook-owned approvals keep the provider status barrier.
    if (status === "idle" && pendingForStatus && pendingForStatus.source !== "screen") {
      this.resolveApproval(canonical);
    }
    if ((status === "done" || status === "error") && this.pendingApprovals.delete(canonical)) {
      this.scheduleBroadcast();
    }
    const submittedHookApproval = this.pendingApprovals.get(canonical);
    if (
      status === "running" &&
      submittedHookApproval?.submittedDecision &&
      submittedHookApproval.source !== "screen"
    ) {
      this.resolveApproval(canonical);
    }
    // A question is done the moment the agent moves on - answering it advances
    // straight to the next tool (running), so clear on running too, not just
    // when the turn ends. The question's own hooks report needs_approval, which
    // never reaches here as a status transition that would clear it early.
    if (status !== "needs_approval" && this.pendingQuestions.delete(canonical)) {
      // Question resolved on the desktop (or the turn/session ended).
    }
    if (status === "done" || status === "error") {
      this.promptDeliveries?.markSessionEnded(canonical);
      this.rejectQueuedInputs(canonical, `worker session ended with status ${status}`);
    }
    if (status === "idle" || status === "running" || status === "waiting") {
      void this.flushQueuedInputs(canonical);
    }

    // Attention moments: a turn finishing (running -> idle), an explicit
    // waiting-for-input, and errors. The router decides who pushes (mate
    // replies push, crew never does, solo keeps turn-done); never on repeats
    // of the same state.
    if (previous?.status !== status) {
      const session = this.sessions.find((candidate) => candidate.id === canonical);
      this.pushRouter?.sessionStatusChanged(canonical, session, previous?.status, status);
    }
    this.scheduleBroadcast();
  }

  setPendingApproval(sessionId: string, approval: PendingApproval): void {
    const canonical = this.canonicalSessionId(sessionId);
    // AskUserQuestion also emits a generic "Claude needs your permission"
    // Notification (no tool_name, so it cannot self-identify). When a question
    // is already open that is exactly what this is - the specific question card
    // already covers it, so never stack a bare allow/deny approval on top.
    if (this.pendingQuestions.has(canonical)) {
      return;
    }
    const existing = this.pendingApprovals.get(canonical);
    // A PermissionRequest carries tool + command; the follow-up Notification
    // is generic. Never downgrade the card the user sees.
    if (existing?.command && !approval.command) {
      return;
    }
    // A generic notification can arrive just before the richer tool hook for
    // the same prompt. Upgrade in place without changing the stable identity
    // already sent to the phone and task ledger.
    const next = existing && !existing.command && approval.command ? { ...approval, id: existing.id } : approval;
    this.pendingApprovals.set(canonical, next);

    // Away-mode moment: only push for a NEW prompt, not upgrades of one the
    // user has already been told about.
    if (!existing) {
      const session = this.sessions.find((candidate) => candidate.id === canonical);
      this.pushRouter?.approvalNeeded(canonical, session, next);
      this.onApprovalNeeded?.(canonical, next);
    }
    this.scheduleBroadcast();
  }

  // Rehydrate durable provider-owned approval state without replaying its
  // push or task-event side effects. The original request already emitted
  // those before it was committed; reconnect and restart only restore truth.
  restorePendingApproval(sessionId: string, approval: PendingApproval): void {
    const canonical = this.canonicalSessionId(sessionId);
    this.pendingApprovals.set(canonical, approval);
    this.scheduleBroadcast();
  }

  pendingApproval(sessionId: string): PendingApproval | undefined {
    return this.pendingApprovals.get(this.canonicalSessionId(sessionId));
  }

  resolveApproval(sessionId: string): void {
    const canonical = this.canonicalSessionId(sessionId);
    const pending = this.pendingApprovals.get(canonical);
    if (pending && this.pendingApprovals.delete(canonical)) {
      this.onApprovalResolved?.(canonical, pending);
      this.scheduleBroadcast();
    }
  }

  approvalDecisionInput(sessionId: string, approvalId: string, decisionId: string): string[] | undefined {
    const canonical = this.canonicalSessionId(sessionId);
    const pending = this.pendingApprovals.get(canonical);
    const detected = this.screenPrompts.get(canonical);
    if (!pending || pending.id !== approvalId || pending.submittedDecision || detected?.id !== approvalId) {
      return undefined;
    }
    return detected.decisions?.find((decision) => decision.id === decisionId)?.input;
  }

  markApprovalSubmitted(sessionId: string, approvalId: string, decisionId: string): boolean {
    const canonical = this.canonicalSessionId(sessionId);
    const pending = this.pendingApprovals.get(canonical);
    if (!pending || pending.id !== approvalId || pending.submittedDecision) return false;
    this.pendingApprovals.set(canonical, { ...pending, submittedDecision: decisionId });
    this.scheduleBroadcast();
    return true;
  }

  resetApprovalSubmitted(sessionId: string, approvalId: string): void {
    const canonical = this.canonicalSessionId(sessionId);
    const pending = this.pendingApprovals.get(canonical);
    if (!pending || pending.id !== approvalId || !pending.submittedDecision) return;
    const { submittedDecision: _, ...reset } = pending;
    this.pendingApprovals.set(canonical, reset);
    this.scheduleBroadcast();
  }

  setPendingServerRequest(sessionId: string, request: PendingServerRequest): boolean {
    const canonical = this.canonicalSessionId(sessionId);
    const open = this.pendingServerRequests.get(canonical) ?? new Map<string, PendingServerRequest>();
    const key = serverRequestKey(request.requestId);
    const existing = open.get(key);
    if (existing && existing.threadId === request.threadId) {
      return false;
    }
    open.set(key, request);
    this.pendingServerRequests.set(canonical, open);
    this.applyExternalStatus(canonical, "needs_approval", "codex", "adapter");
    this.pushRouter?.approvalNeeded(canonical, this.findSession(canonical), {
      id: key,
      summary: request.summary,
      command: typeof request.content.command === "string" ? request.content.command : undefined,
      at: request.at
    });
    this.scheduleBroadcast();
    return true;
  }

  // The oldest open request: the queue head the phone card, the generic
  // approve barrier, and the task ledger read. Later requests surface as
  // earlier ones resolve.
  pendingServerRequest(sessionId: string): PendingServerRequest | undefined {
    const open = this.pendingServerRequests.get(this.canonicalSessionId(sessionId));
    return open?.values().next().value;
  }

  // Exact-id lookup so every open request stays answerable, not just the head.
  pendingServerRequestById(sessionId: string, requestId: string | number): PendingServerRequest | undefined {
    const open = this.pendingServerRequests.get(this.canonicalSessionId(sessionId));
    return open?.get(serverRequestKey(requestId));
  }

  resolveServerRequest(sessionId: string, requestId: string | number): PendingServerRequest | undefined {
    const canonical = this.canonicalSessionId(sessionId);
    const open = this.pendingServerRequests.get(canonical);
    const key = serverRequestKey(requestId);
    const pending = open?.get(key);
    if (!open || !pending) return undefined;
    open.delete(key);
    if (open.size === 0) this.pendingServerRequests.delete(canonical);
    this.scheduleBroadcast();
    return pending;
  }

  setPendingQuestion(sessionId: string, question: PendingQuestion): void {
    const canonical = this.canonicalSessionId(sessionId);
    const existing = this.pendingQuestions.get(canonical);
    // The two hooks for one prompt share a content-hashed id; only the first
    // is new. Re-setting the same one would re-push and churn the card.
    if (existing?.id === question.id) {
      return;
    }
    this.pendingQuestions.set(canonical, question);
    // The question is the specific truth; drop any generic permission approval
    // raised by the same prompt's "needs your permission" Notification (which
    // can arrive before or after the tool hooks).
    this.pendingApprovals.delete(canonical);

    this.pushRouter?.questionAsked(
      canonical,
      this.sessions.find((candidate) => candidate.id === canonical),
      question
    );
    this.scheduleBroadcast();
  }

  restorePendingQuestion(sessionId: string, question: PendingQuestion): void {
    this.pendingQuestions.set(this.canonicalSessionId(sessionId), question);
    this.scheduleBroadcast();
  }

  pendingQuestion(sessionId: string): PendingQuestion | undefined {
    return this.pendingQuestions.get(this.canonicalSessionId(sessionId));
  }

  resolveQuestion(sessionId: string): void {
    const canonical = this.canonicalSessionId(sessionId);
    if (this.pendingQuestions.delete(canonical)) {
      this.scheduleBroadcast();
    }
  }

  setPendingClaudeInteraction(sessionId: string, interaction: PendingClaudeInteraction): void {
    const canonical = this.canonicalSessionId(sessionId);
    if (!isActionableClaudeInteraction(interaction)) {
      this.resolveClaudeInteraction(canonical);
      return;
    }
    const existing = this.pendingClaudeInteractions.get(canonical);
    this.pendingClaudeInteractions.set(canonical, interaction);
    if (!existing) {
      this.pushRouter?.approvalNeeded(canonical, this.findSession(canonical), {
        id: interaction.id,
        summary: interaction.summary,
        at: interaction.at
      });
    }
    this.applyExternalStatus(canonical, "needs_approval", "claude", "hook");
    this.scheduleBroadcast();
  }

  restorePendingClaudeInteraction(sessionId: string, interaction: PendingClaudeInteraction): void {
    const canonical = this.canonicalSessionId(sessionId);
    if (!isActionableClaudeInteraction(interaction)) {
      this.resolveClaudeInteraction(canonical);
      return;
    }
    this.pendingClaudeInteractions.set(canonical, interaction);
    this.scheduleBroadcast();
  }

  pendingClaudeInteraction(sessionId: string): PendingClaudeInteraction | undefined {
    const interaction = this.pendingClaudeInteractions.get(this.canonicalSessionId(sessionId));
    return interaction && isActionableClaudeInteraction(interaction) ? interaction : undefined;
  }

  resolveClaudeInteraction(sessionId: string): void {
    const canonical = this.canonicalSessionId(sessionId);
    const removed = this.pendingClaudeInteractions.delete(canonical);
    if (!this.hasPromptGate(canonical) && this.sessionState.get(canonical)?.status === "needs_approval") {
      this.applyExternalStatus(canonical, "running", undefined, "system");
      return;
    }
    if (!this.inputGated(canonical)) void this.flushQueuedInputs(canonical);
    if (removed) this.scheduleBroadcast();
  }

  // Composer gating: while a permission prompt is open, pasted text would land
  // in the wrong TUI widget, so messages queue server-side (surviving phone
  // disconnects) and flush on the next idle/running transition.
  async queueOrSubmit(
    sessionId: string,
    text: string,
    options: { queueIfGated?: boolean; source?: PromptDeliverySource } = {}
  ): Promise<{ queued: boolean; gated?: boolean }> {
    const canonical = this.canonicalSessionId(sessionId);
    const status =
      this.sessionState.get(canonical)?.status ??
      this.sessions.find((session) => session.id === canonical)?.status;
    if (status === "done" || status === "error") {
      throw new Error("worker session has ended; follow-up input was not accepted");
    }

    if (this.inputGated(canonical)) {
      if (options.queueIfGated === false) return { queued: false, gated: true };
      const agent =
        this.sessions.find((session) => session.id === canonical)?.agent ??
        (await this.adapter.listSessions()).find((session) => session.id === canonical)?.agent;
      const delivery = agent === "claude"
        ? this.promptDeliveries?.create(canonical, text, options.source ?? "agent")
        : undefined;
      const queue = this.queuedInputs.get(canonical) ?? [];
      queue.push({ text, ...(delivery ? { deliveryId: delivery.id } : {}) });
      this.queuedInputs.set(canonical, queue);
      this.scheduleBroadcast();
      return { queued: true };
    }

    const agent =
      this.sessions.find((session) => session.id === canonical)?.agent ??
      (await this.adapter.listSessions()).find((session) => session.id === canonical)?.agent;
    const delivery = agent === "claude"
      ? this.promptDeliveries?.create(canonical, text, options.source ?? "agent")
      : undefined;
    await this.submitToAdapter(canonical, text, delivery?.id);
    return { queued: false };
  }

  // Prompt provided at spawn time: hold it until the agent signals ready
  // (first SessionStart/Stop hook flips status), with a timer fallback for
  // agents that have no hooks installed.
  queueInitialPrompt(sessionId: string, text: string): void {
    const canonical = this.canonicalSessionId(sessionId);
    const queue = this.queuedInputs.get(canonical) ?? [];
    queue.push({ text });
    this.queuedInputs.set(canonical, queue);
    this.scheduleBroadcast();

    const fallback = setTimeout(() => {
      void this.flushQueuedInputs(canonical);
    }, 12_000);
    fallback.unref?.();
  }

  private async flushQueuedInputs(sessionId: string): Promise<void> {
    const queue = this.queuedInputs.get(sessionId);
    if (!queue || queue.length === 0) {
      return;
    }
    // The gate can open at any moment (including mid-flush, since submits
    // await the adapter): typing queued text into a focused permission dialog
    // would silently answer it, so re-check before every write.
    if (this.inputGated(sessionId)) {
      return;
    }
    this.queuedInputs.delete(sessionId);
    for (const [index, input] of queue.entries()) {
      if (this.inputGated(sessionId)) {
        // Put the unsent remainder back, ahead of anything queued since.
        const requeued = queue.slice(index).concat(this.queuedInputs.get(sessionId) ?? []);
        this.queuedInputs.set(sessionId, requeued);
        break;
      }
      try {
        await this.submitToAdapter(sessionId, input.text, input.deliveryId);
      } catch {
        for (const pending of queue.slice(index + 1)) {
          if (pending.deliveryId) {
            this.promptDeliveries?.markUnknown(
              pending.deliveryId,
              "queued prompt was abandoned after an earlier submission failed; not resent"
            );
          }
        }
        this.queuedInputs.set(sessionId, queue.slice(index));
        this.rejectQueuedInputs(sessionId, "queued follow-up could not be submitted");
        break;
      }
    }
    this.scheduleBroadcast();
  }

  private rejectQueuedInputs(sessionId: string, reason: string): void {
    let untrackedCount = 0;
    for (const input of this.queuedInputs.get(sessionId) ?? []) {
      if (input.deliveryId) this.promptDeliveries?.markUnknown(input.deliveryId, `${reason}; not resent`);
      else untrackedCount += 1;
    }
    this.queuedInputs.delete(sessionId);
    if (untrackedCount > 0) {
      this.onQueuedInputRejected?.(sessionId, untrackedCount, reason);
    }
  }

  // A session blocked on a permission prompt must not receive composer text:
  // a leading "1"/"y" plus Enter would select Allow in the focused dialog.
  private inputGated(sessionId: string): boolean {
    return (
      this.pendingApprovals.has(sessionId) ||
      this.pendingServerRequests.has(sessionId) ||
      this.pendingQuestions.has(sessionId) ||
      isActionableClaudeInteraction(this.pendingClaudeInteractions.get(sessionId)) ||
      this.sessionState.get(sessionId)?.status === "needs_approval"
    );
  }

  private hasPromptGate(sessionId: string): boolean {
    return (
      this.pendingApprovals.has(sessionId) ||
      this.pendingServerRequests.has(sessionId) ||
      this.pendingQuestions.has(sessionId) ||
      isActionableClaudeInteraction(this.pendingClaudeInteractions.get(sessionId))
    );
  }

  private async submitToAdapter(sessionId: string, text: string, deliveryId?: string): Promise<void> {
    if (deliveryId) this.promptDeliveries?.markTyping(deliveryId);
    try {
      if (this.adapter.submitInput) {
        await this.adapter.submitInput(sessionId, text);
      } else {
        await this.adapter.sendInput(sessionId, text);
        await this.adapter.sendEnter(sessionId);
      }
    } catch (error) {
      if (deliveryId) {
        this.promptDeliveries?.markUnknown(
          deliveryId,
          `prompt submission failed before acceptance could be confirmed: ${
            error instanceof Error ? error.message : String(error)
          }; not resent`
        );
      }
      throw error;
    }
    if (deliveryId) this.promptDeliveries?.markSubmitted(deliveryId);
    try {
      // Tracked Claude input becomes task activity only after its hook or
      // transcript receipt. Other providers retain their existing boundary.
      if (!deliveryId) this.onInputSubmitted?.(sessionId);
    } catch {
      // Ledger observation must never turn a successful agent submission into
      // an HTTP/input failure.
    }
    this.publish({
      type: "message",
      sessionId,
      role: "user",
      text,
      at: new Date().toISOString()
    });
  }

  // Audit/system events from the HTTP layer. Per-session events reach only that
  // session's detail subscribers; "system" events broadcast to everyone.
  publish(event: AgentEvent): void {
    if (event.sessionId === "system") {
      this.broadcastEvent(event);
    } else {
      this.deliverEvent(event);
    }
  }

  // Revocation must cut live access too: a device's token is only checked when
  // its channel opens (WS upgrade on the LAN path, e2ee_auth on the relay path),
  // so nothing re-checks it mid-socket. Terminating each of the device's client
  // sockets severs its live access regardless of transport: a relayed device is
  // a FleetMonitor client whose socket IS its EncryptedServerChannel, so
  // terminating it drops the underlying relay data socket end-to-end. The
  // onDisconnectDevice hook additionally tells the relay client to sever any of
  // the device's data sockets that have not (yet) become FleetMonitor clients.
  disconnectDevice(deviceId: string): void {
    for (const client of [...this.clients]) {
      if (client.auth.kind === "device" && client.auth.deviceId === deviceId) {
        client.socket.terminate();
        this.clients.delete(client);
      }
    }
    this.onDisconnectDevice?.(deviceId);
    if (this.clients.size === 0) {
      this.stop();
    }
  }

  // Number of connected clients. Read-only observability (and a test hook for
  // asserting that an unauthorized channel never became a client).
  clientCount(): number {
    return this.clients.size;
  }

  // The last-reconciled session record, for push-role classification of
  // events that arrive outside a status change (task ledger events).
  findSession(sessionId: string): AgentSession | undefined {
    const canonical = this.canonicalSessionId(sessionId);
    return this.sessions.find((candidate) => candidate.id === canonical);
  }

  // A paired phone has this session's detail tier open right now. Used to
  // ROUTE mate-message pushes away from a boss already reading the chat -
  // never to gate approvals (a backgrounded app drops its socket, so this
  // reads false when the phone is away).
  hasDeviceViewer(sessionId: string): boolean {
    const canonical = this.canonicalSessionId(sessionId);
    for (const client of this.clients) {
      if (client.auth.kind === "device" && client.subscriptions.has(canonical)) {
        return true;
      }
    }
    return false;
  }

  // Shutdown path: server.close() waits for open sockets, so a connected
  // phone would otherwise hang the process after its PTYs are already gone.
  closeAllClients(): void {
    for (const client of this.clients) {
      client.socket.terminate();
    }
    this.clients.clear();
  }

  stop(): void {
    this.running = false;

    this.unsubscribeEvents?.();
    this.unsubscribeEvents = undefined;
    this.unsubscribeAgentEvents?.();
    this.unsubscribeAgentEvents = undefined;

    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = undefined;
    }
    for (const timer of this.tailTimers.values()) {
      clearTimeout(timer);
    }
    this.tailTimers.clear();
    for (const timer of this.detailTimers.values()) {
      clearTimeout(timer);
    }
    this.detailTimers.clear();
  }

  private start(): void {
    if (this.running) {
      return;
    }
    this.running = true;

    if (this.adapter.subscribeFleetEvents) {
      this.unsubscribeEvents = this.adapter.subscribeFleetEvents((event) => {
        this.handleFleetEvent(event);
      });
    }
    if (this.adapter.subscribeAgentEvents) {
      this.unsubscribeAgentEvents = this.adapter.subscribeAgentEvents((event) => {
        this.publish(event);
      });
    }

    this.reconcileTimer = setInterval(() => {
      void this.reconcile();
    }, this.reconcileMs);
    this.reconcileTimer.unref?.();

    void this.reconcile();
  }

  private handleClientMessage(client: Client, raw: RawData): void {
    let message: WebSocketClientEvent;

    try {
      message = JSON.parse(raw.toString()) as WebSocketClientEvent;
    } catch {
      return;
    }

    if (message.type === "subscribe") {
      // Additive: opening detail for one pane never narrows fleet coverage.
      const sessionId = this.canonicalSessionId(message.sessionId);
      client.subscriptions.add(sessionId);
      void this.sendDetailOpening(client, sessionId);
    } else if (message.type === "unsubscribe") {
      client.subscriptions.delete(this.canonicalSessionId(message.sessionId));
    } else if (message.type === "start_agent") {
      void this.startAgentForClient(client, message.request);
    } else if (message.type === "input") {
      const sessionId = this.canonicalSessionId(message.sessionId);
      if (typeof message.data === "string" && message.data.length > 0) {
        void this.adapter.sendInput(sessionId, message.data).catch(() => {});
        this.audit({ action: "input", sessionId, deviceId: this.deviceIdOf(client), textLength: message.data.length });
      }
    } else if (message.type === "resize") {
      // The desktop terminal owns the PTY geometry: device (phone) clients
      // must never resize, enforced here rather than trusted client-side.
      if (client.auth.kind === "device") {
        return;
      }
      const sessionId = this.canonicalSessionId(message.sessionId);
      if (Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
        void this.adapter.resize?.(sessionId, message.cols, message.rows).catch(() => {});
        this.audit({ action: "resize", sessionId, cols: message.cols, rows: message.rows });
      }
    } else if (message.type === "rpc") {
      void this.handleRpcMessage(client, message);
    }
  }

  private async handleRpcMessage(client: Client, message: WebSocketRpcRequest): Promise<void> {
    const id = typeof message.id === "string" && message.id.length > 0 ? message.id : "";
    if (!id) {
      return;
    }
    if (!this.rpcHandler) {
      this.send(client, {
        type: "rpc_response",
        id,
        status: 501,
        ok: false,
        error: "WebSocket RPC is not supported by this server."
      });
      return;
    }

    try {
      this.send(client, await this.rpcHandler(message, client.auth));
    } catch (error) {
      this.send(client, {
        type: "rpc_response",
        id,
        status: 500,
        ok: false,
        error: error instanceof Error ? error.message : "Internal server error"
      });
    }
  }

  private deviceIdOf(client: Client): string | undefined {
    return client.auth.kind === "device" ? client.auth.deviceId : undefined;
  }

  // Fire-and-forget audit: a full disk or unwritable log must never take the
  // server (and every server-owned PTY) down with an unhandled rejection.
  private audit(record: Parameters<AuditLog["write"]>[0]): void {
    void this.auditLog?.write(record).catch(() => {});
  }

  // Opening (or resyncing) the detail tier: a serialized snapshot when the
  // backend supports it, else the legacy rendered-capture fallback.
  private async sendDetailOpening(client: Client, sessionId: string): Promise<void> {
    if (this.adapter.snapshot) {
      try {
        const snapshot = await this.adapter.snapshot(sessionId);
        this.send(client, {
          type: "event",
          event: {
            type: "terminal_snapshot",
            sessionId,
            data: snapshot.data,
            cols: snapshot.cols,
            rows: snapshot.rows,
            seq: snapshot.seq,
            at: new Date().toISOString()
          }
        });
        return;
      } catch {
        // Not a snapshot-capable session; fall through to capture.
      }
    }
    await this.captureDetail(sessionId);
  }

  private async startAgentForClient(client: Client, request: StartAgentRequest): Promise<void> {
    if (!this.startAgentLauncher) {
      this.send(client, {
        type: "event",
        event: {
          type: "message",
          sessionId: "system",
          role: "system",
          text: "This server does not support starting PTY agents.",
          at: new Date().toISOString()
        }
      });
      return;
    }

    try {
      const { session } = await this.startAgentLauncher({
        request,
        auditMeta: {
          deviceId: this.deviceIdOf(client)
        }
      });
      client.subscriptions.add(session.id);
      await this.reconcile();
      this.send(client, {
        type: "event",
        event: {
          type: "status",
          sessionId: session.id,
          status: session.status,
          at: session.lastActivityAt
        }
      });
    } catch (error) {
      this.send(client, {
        type: "event",
        event: {
          type: "message",
          sessionId: "system",
          role: "system",
          text: error instanceof Error ? error.message : "Unable to start PTY agent.",
          at: new Date().toISOString()
        }
      });
    }
  }

  private handleFleetEvent(event: FleetEvent): void {
    if (event.kind === "topology" || event.kind === "gap") {
      void this.reconcile();
    }

    if (event.sessionId) {
      const previous = this.sessionState.get(event.sessionId);
      this.sessionState.set(event.sessionId, {
        status: event.status ?? previous?.status,
        agent: event.agent ?? previous?.agent,
        at: event.at
      });
      if (event.status && previous?.status !== event.status) {
        this.onStatusChange?.({
          sessionId: event.sessionId,
          from: previous?.status,
          to: event.status,
          source: "adapter"
        });
      }
      if (event.status === "done" || event.status === "error") {
        // The process is gone: an open approval/question card would be
        // actionable against nothing, and queued composer text can never be
        // delivered.
        this.promptDeliveries?.markSessionEnded(event.sessionId);
        this.pendingApprovals.delete(event.sessionId);
        this.pendingQuestions.delete(event.sessionId);
        this.pendingClaudeInteractions.delete(event.sessionId);
        this.screenPrompts.delete(event.sessionId);
        this.usageLimits.delete(event.sessionId);
        this.rejectQueuedInputs(event.sessionId, `worker session ended with status ${event.status}`);
      }
      this.scheduleTailCapture(event.sessionId);
      if (!hasDirectAgentDetail(event)) {
        this.scheduleDetailCapture(event.sessionId);
      }
    }

    if (event.workspaceId && !event.sessionId) {
      const previous = this.workspaceState.get(event.workspaceId);
      this.workspaceState.set(event.workspaceId, {
        status: event.status ?? previous?.status,
        agent: event.agent ?? previous?.agent,
        at: event.at
      });
      this.refreshWorkspace(event.workspaceId);
    }

    this.scheduleBroadcast();
  }

  // Capture an updated tail (and focused detail, for subscribers) for every
  // terminal session in a workspace that just showed activity.
  private refreshWorkspace(workspaceId: string): void {
    for (const session of this.sessions) {
      if (session.workspaceId !== workspaceId) {
        continue;
      }
      this.scheduleTailCapture(session.id);
      this.scheduleDetailCapture(session.id);
    }
  }

  private async reconcile(): Promise<void> {
    if (!this.running) {
      return;
    }

    const previousSessionIds = new Set(this.sessions.map((session) => session.id));
    try {
      this.sessions = await this.adapter.listSessions();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to list sessions";
      this.broadcastEvent({
        type: "message",
        sessionId: "system",
        role: "system",
        text: message,
        at: new Date().toISOString()
      });
      return;
    }

    this.pruneSessionState(previousSessionIds);
    this.scheduleBroadcast();
  }

  // Purged sessions must not leak per-session state (queued composer text is
  // the sensitive case) for the lifetime of a long-running server.
  private pruneSessionState(previousSessionIds = new Set<string>()): void {
    const active = new Set(this.sessions.map((session) => session.id));
    this.promptDeliveries?.reconcileActiveSessions(previousSessionIds, active);
    const maps = [
      this.sessionState,
      this.pendingApprovals,
      this.pendingServerRequests,
      this.pendingQuestions,
      this.pendingClaudeInteractions,
      this.screenPrompts,
      this.usageLimits,
      this.sessionModels,
      this.tails,
      this.lastTailAt
    ];
    for (const map of maps) {
      for (const sessionId of map.keys()) {
        if (!active.has(sessionId)) {
          map.delete(sessionId);
        }
      }
    }
    for (const sessionId of this.queuedInputs.keys()) {
      if (!active.has(sessionId)) {
        this.rejectQueuedInputs(sessionId, "worker session disappeared before queued follow-up delivery");
      }
    }
    for (const timers of [this.tailTimers, this.detailTimers]) {
      for (const [sessionId, timer] of timers) {
        if (!active.has(sessionId)) {
          clearTimeout(timer);
          timers.delete(sessionId);
        }
      }
    }
    const workspaces = new Set(this.sessions.map((session) => session.workspaceId).filter(Boolean));
    for (const workspaceId of this.workspaceState.keys()) {
      if (!workspaces.has(workspaceId)) {
        this.workspaceState.delete(workspaceId);
      }
    }
    this.onPrune?.(active);
  }

  // The fleet overview: every session, with live status/activity overlaid and a
  // small tail. Built fresh so it never drifts from the topology snapshot.
  private overview(): AgentSession[] {
    return this.withLiveState(this.sessions);
  }

  // Overlay hook-derived status/approvals onto adapter session records. Also
  // used by GET /sessions so HTTP and the fleet socket never disagree (the
  // adapter's own status is stale for agents that report through hooks).
  withLiveState(sessions: AgentSession[]): AgentSession[] {
    return sessions.map((session) => {
      const live =
        this.sessionState.get(session.id) ??
        (session.workspaceId ? this.workspaceState.get(session.workspaceId) : undefined);
      // Never let late-arriving hook statuses resurrect an ended session:
      // hook curls race the process exit (UserPromptSubmit for "/exit" can
      // land after the PTY closes) and would pin a dead session on "running".
      const ended = session.status === "done" || session.status === "error";
      const applyLive = Boolean(live && session.kind === "terminal" && !ended);
      const tail = this.tails.get(session.id);

      const result: AgentSession = { ...session };
      const runtime = this.runtimeSnapshot?.(session.id);
      if (runtime) {
        result.runtime = runtime;
        if (!result.workerName && runtime.workerName) result.workerName = runtime.workerName;
      }
      if (applyLive && live) {
        if (live.status) {
          result.status = live.status;
        }
        if (live.agent) {
          result.agent = live.agent;
        }
        if (live.at > session.lastActivityAt) {
          result.lastActivityAt = live.at;
        }
      }
      if (tail !== undefined) {
        result.tail = tail;
      }
      const promptDeliveryWarning = this.promptDeliveryWarning?.(session.id);
      if (promptDeliveryWarning) result.promptDeliveryWarning = promptDeliveryWarning;
      const modelInfo = this.sessionModels.get(session.id);
      if (modelInfo) {
        if (modelInfo.model !== undefined) result.model = modelInfo.model;
        if (modelInfo.modelLabel !== undefined) result.modelLabel = modelInfo.modelLabel;
        if (modelInfo.effort !== undefined) result.effort = modelInfo.effort;
      }
      const fallbackModelInfo = this.sessionModelFallback?.(result);
      if (fallbackModelInfo) {
        if (result.model == null && fallbackModelInfo.model !== undefined) {
          result.model = fallbackModelInfo.model;
        }
        if (result.modelLabel == null && fallbackModelInfo.modelLabel !== undefined) {
          result.modelLabel = fallbackModelInfo.modelLabel;
        }
        if (result.effort == null && fallbackModelInfo.effort !== undefined) {
          result.effort = fallbackModelInfo.effort;
        }
      }
      if (!ended) {
        // A question and a generic approval are mutually exclusive surfaces;
        // the question is the more specific/actionable one, so it wins.
        const serverRequest = this.pendingServerRequests.get(session.id)?.values().next().value;
        const question = this.pendingQuestions.get(session.id);
        const claudeInteraction = this.pendingClaudeInteractions.get(session.id);
        if (serverRequest) {
          result.pendingServerRequest = serverRequest;
          result.status = "needs_approval";
        } else if (isActionableClaudeInteraction(claudeInteraction)) {
          result.pendingClaudeInteraction = claudeInteraction;
          result.status = "needs_approval";
        } else if (question) {
          result.pendingQuestion = question;
          result.status = "needs_approval";
        } else {
          const approval = this.pendingApprovals.get(session.id);
          if (approval) {
            result.pendingApproval = approval;
            result.status = "needs_approval";
          }
        }
        const queued = this.queuedInputs.get(session.id)?.length ?? 0;
        if (queued > 0) {
          result.queuedCount = queued;
        }
      }
      return result;
    });
  }

  private scheduleTailCapture(sessionId: string): void {
    const session = this.sessions.find((candidate) => candidate.id === sessionId);
    if (!session || session.kind !== "terminal") {
      return;
    }
    if (this.tailTimers.has(sessionId)) {
      return;
    }

    const sinceLast = Date.now() - (this.lastTailAt.get(sessionId) ?? 0);
    const delay = Math.max(0, this.tailThrottleMs - sinceLast);
    const timer = setTimeout(() => {
      this.tailTimers.delete(sessionId);
      void this.captureTail(sessionId);
    }, delay);
    timer.unref?.();
    this.tailTimers.set(sessionId, timer);
  }

  private async captureTail(sessionId: string): Promise<void> {
    if (!this.running) {
      return;
    }
    this.lastTailAt.set(sessionId, Date.now());

    try {
      // Read a whole screen, not just the tail: the prompt detector needs to see
      // through the blank rows a bottom-anchored TUI box pads above itself. The
      // overview tail is still cut from the last `tailLines` rendered lines.
      const result = await this.adapter.readRecentEvents(sessionId, SCREEN_CAPTURE_LINES);
      if (!result.terminal) {
        return;
      }
      const screen = captureText(result.events);
      const text = lastLines(rawTail(screen, this.tailLines), this.tailLines);
      if (text) {
        this.tails.set(sessionId, text);
        this.scheduleBroadcast();
      }
      this.detectScreenPrompt(sessionId, screen);
      this.detectSessionUsageLimit(sessionId, screen);
    } catch {
      // Best-effort: the reconcile loop and the next event are the safety net.
    }
  }

  // A worker that runs out of provider credits prints its CLI's usage-limit line
  // and then sits silent: no hook, no tool call, the PTY goes quiet and the
  // session reads as plain "idle" while its task stays "working" forever. This
  // recognizes that line on the rendered screen (agent-specific formatting lives
  // in usageLimitDetect), flips the session's own status to `error` so GET
  // /sessions stops calling it idle, and hands the condition to the task-ledger
  // hook - which blocks the task and wakes the mate through the normal channel.
  private detectSessionUsageLimit(sessionId: string, screen: string): void {
    const session = this.sessions.find((candidate) => candidate.id === sessionId);
    const agent = session?.agent ?? this.sessionState.get(sessionId)?.agent;
    const limit = detectUsageLimit(screen, agent);
    if (!limit) {
      // The line left the screen (session recovered / scrolled). Re-arm so a
      // fresh limit fires again; the `error` status stands until the session
      // actually moves (a hook, a reconcile, or exit).
      this.usageLimits.delete(sessionId);
      return;
    }
    this.surfaceUsageLimit(sessionId, agent, limit);
  }

  private surfaceUsageLimit(sessionId: string, agent: AgentKind | undefined, limit: UsageLimit): void {
    const signature = `${limit.provider}:${limit.retryAt ?? ""}:${limit.message}`;
    if (this.usageLimits.get(sessionId) === signature) return;
    this.usageLimits.set(sessionId, signature);
    this.applyExternalStatus(sessionId, "error", agent, "system");
    this.onUsageLimit?.(sessionId, agent, limit);
  }

  // The general net for prompts no hook reports. Every hook-driven prompt in
  // perch is a tool call the CLI asked permission for; a slash-command confirm,
  // a trust-this-directory prompt, or whatever the next CLI release adds fires
  // nothing, and the session hangs invisibly while composer text is typed into
  // the open dialog. Recognizing the frame on the rendered screen raises the
  // SAME `needs_approval` state a hook would, which buys the decision card, the
  // push, and `inputGated()` - so the message queues instead of answering the
  // dialog. Claude screen detection is degraded/manual-local only: it never
  // proves a remote decision landed. Existing structured Codex behavior is
  // unchanged.
  private detectScreenPrompt(sessionId: string, screen: string): void {
    const session = this.sessions.find((candidate) => candidate.id === sessionId);
    const agent = session?.agent ?? this.sessionState.get(sessionId)?.agent;
    const detected = detectPrompt(screen, agent);
    const raised = this.screenPrompts.get(sessionId);

    if (!detected) {
      // The dialog left the screen: answered on the desktop, or by us. Nothing
      // else will ever resolve a screen-raised card, so it is retracted here.
      if (raised !== undefined) {
        this.screenPrompts.delete(sessionId);
        if (this.pendingApprovals.get(sessionId)?.id === raised.id) {
          this.resolveApproval(sessionId);
          const state = this.sessionState.get(sessionId);
          if (state?.status === "needs_approval") {
            this.applyExternalStatus(sessionId, "running", state.agent, "system");
          }
        }
      }
      return;
    }
    // The same dialog, still (or briefly still) on screen: already surfaced, or
    // just answered and not yet redrawn. Either way, never raise it twice.
    if (raised?.id === detected.id) {
      return;
    }
    // A dialog perch itself is about to answer (the model-switch confirm) is not
    // a decision to bounce back to the phone.
    if (this.adapter.promptAnswerInFlight?.(sessionId)) {
      return;
    }
    // A hook told us about this prompt already, and told us more than the screen
    // can; the specific card wins.
    if (this.pendingApprovals.has(sessionId) || this.pendingQuestions.has(sessionId)) {
      return;
    }

    this.screenPrompts.set(sessionId, detected);
    const degradedClaude = agent === "claude";
    const approval: PendingApproval = {
      id: detected.id,
      summary: detected.summary,
      command: detected.options.map((option, index) => `${index + 1}. ${option}`).join("\n"),
      at: new Date().toISOString(),
      source: "screen",
      ...(degradedClaude ? { interactionKind: "pty_manual_gate" as const } : {}),
      ...(detected.remoteResolutionUnavailable || degradedClaude ? { remoteResolutionUnavailable: true } : {}),
      ...(!degradedClaude && detected.decisions
        ? { decisions: detected.decisions.map(({ input: _, ...decision }) => decision) }
        : {}),
      ...(detected.context ? { context: detected.context } : {})
    };
    this.setPendingApproval(sessionId, approval);
    if (degradedClaude) this.claudeManualGateHandler?.(sessionId, approval);
  }

  private scheduleDetailCapture(sessionId: string): void {
    if (!this.hasSubscribers(sessionId)) {
      return;
    }
    if (this.detailTimers.has(sessionId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.detailTimers.delete(sessionId);
      void this.captureDetail(sessionId);
    }, this.detailThrottleMs);
    timer.unref?.();
    this.detailTimers.set(sessionId, timer);
  }

  private async captureDetail(sessionId: string): Promise<void> {
    if (!this.running || !this.hasSubscribers(sessionId)) {
      return;
    }

    try {
      const result = await this.adapter.readRecentEvents(sessionId, this.detailLines);
      for (const event of result.events) {
        this.deliverEvent(event);
      }
    } catch {
      // Detail is best-effort; the overview still reflects status.
    }
  }

  private scheduleBroadcast(): void {
    if (!this.running || this.broadcastTimer) {
      return;
    }
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = undefined;
      this.broadcastFleet();
    }, this.broadcastMs);
    this.broadcastTimer.unref?.();
  }

  private broadcastFleet(): void {
    const message: WebSocketServerEvent = {
      type: "fleet",
      sessions: this.overview(),
      at: new Date().toISOString()
    };
    for (const client of this.clients) {
      this.send(client, message);
    }
  }

  private deliverEvent(event: AgentEvent): void {
    for (const client of this.clients) {
      if (client.subscriptions.has(event.sessionId)) {
        this.send(client, { type: "event", event });
      }
    }
  }

  private broadcastEvent(event: AgentEvent): void {
    for (const client of this.clients) {
      this.send(client, { type: "event", event });
    }
  }

  private hasSubscribers(sessionId: string): boolean {
    for (const client of this.clients) {
      if (client.subscriptions.has(sessionId)) {
        return true;
      }
    }
    return false;
  }

  private canonicalSessionId(sessionId: string): string {
    return this.adapter.canonicalSessionId?.(sessionId) ?? sessionId;
  }

  private send(client: Client, message: WebSocketServerEvent): void {
    if (client.socket.readyState !== client.socket.OPEN) {
      return;
    }
    client.socket.send(JSON.stringify(message));
  }
}

// Mirrors the Codex adapter's requestKey: JSON-RPC ids are string | number,
// and "48" must never collide with 48.
function serverRequestKey(requestId: string | number): string {
  return `${typeof requestId}:${requestId}`;
}

function captureText(events: AgentEvent[]): string {
  return events
    .map((event) => (event.type === "terminal_output" ? event.text : ""))
    .filter(Boolean)
    .join("\n");
}

function hasDirectAgentDetail(event: FleetEvent): boolean {
  return event.name?.startsWith("pty.") ?? false;
}

function isActionableClaudeInteraction(
  interaction: PendingClaudeInteraction | undefined
): interaction is PendingClaudeInteraction {
  return interaction?.state === "waiting" || interaction?.state === "response_sent";
}

function lastLines(text: string, count: number): string {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(-count)
    .join("\n");
}

function rawTail(text: string, count: number): string {
  return text.split(/\r?\n/).slice(-count).join("\n");
}
