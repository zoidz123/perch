// App-server-owned Codex sessions (docs/plans/2026-07-22-app-server-owned-codex.md).
//
// This adapter makes Perch the sole standing authoritative client of a
// per-worktree `codex app-server` daemon: it starts (or resumes) the thread
// itself, captures thread/turn ids from protocol RESPONSES, serializes every
// programmatic input, and drives timeline/status/approvals from protocol
// notifications. There is no PTY, no keystroke injection, and no rollout
// polling for identity. Desktop humans attach the real native TUI as an
// additional same-user client with `codex resume <threadId> --remote
// unix://<socket>` (surfaced as AgentSession.attachCommand).
//
// App-server ownership is the ONLY Codex driver: there is no runtime
// fallback to PTY injection, and rollback is a release or commit rollback.
// The driver and daemon socket persist on the runtime record so recovery
// rebinds a session to the same daemon and thread it launched with.

import { randomUUID } from "node:crypto";
import type {
  AgentSession,
  AgentSessionStatus,
  CodexReasoningEffort,
  PendingServerRequest,
  RecentEventsResult,
  ServerRequestResponse,
  StartAgentRequest,
  TimelineItem,
  TopologyResponse
} from "@perch/shared";
import type { UsageLimit } from "../usageLimitDetect.js";
import { CodexAppServerClient, isCodexRpcError, type CodexRpcError } from "./codexAppServer.js";
import type { CodexDaemonManager } from "./codexDaemon.js";
import type { ThreadHistoryTurn } from "./codexAppServerTypes.js";
import { websocketUnixTransport } from "./wsUnixTransport.js";
import type { AgentAdapter } from "./types.js";
import type { SessionExitContext } from "./pty.js";

// Delivery failed in a way where acceptance is authoritatively UNKNOWN even
// after reconciliation against thread history. Distinct from CodexRpcError
// (authoritative rejection): callers must report "unknown, not resent", never
// treat it as either accepted or rejected.
export class CodexDeliveryUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexDeliveryUnknownError";
  }
}

export type CodexOwnedEventSink = {
  // `live` is false for history replayed by thread/resume (catch-up rows must
  // not flood the fleet WebSocket; clients page them via GET /timeline).
  onTimelineItem?: (item: TimelineItem, live: boolean) => void;
  onStatus?: (sessionId: string, status: AgentSessionStatus) => void;
  onServerRequest?: (sessionId: string, request: PendingServerRequest) => void;
  onServerRequestResolved?: (sessionId: string, request: PendingServerRequest) => void;
  onAssistantStream?: (sessionId: string, ev: { itemId: string; text: string; done: boolean }) => void;
  onTurnStarted?: (sessionId: string) => void;
  onTurnComplete?: (sessionId: string, ev: { message: string }) => void;
  onThreadStarted?: (sessionId: string, threadId: string, socketPath: string) => void;
  onModelResolved?: (sessionId: string, model: string) => void;
  onUsageLimit?: (sessionId: string, limit: UsageLimit) => void;
  onSessionExit?: (sessionId: string, context: SessionExitContext) => void;
};

export type CreateOwnedClient = (args: {
  sessionId: string;
  socketPath: string;
  handlers: {
    onTimelineItem: (item: TimelineItem) => void;
    onStatus: (status: AgentSessionStatus) => void;
    onServerRequest: (request: PendingServerRequest) => void;
    onServerRequestResolved: (request: PendingServerRequest) => void;
    onAssistantStream: (ev: { itemId: string; text: string; done: boolean }) => void;
    onTurnStarted: () => void;
    onTurnComplete: (ev: { message: string }) => void;
    onUsageLimit: (limit: UsageLimit) => void;
    onDisconnected: () => void;
  };
}) => CodexAppServerClient;

export type CodexAppServerAdapterOptions = {
  daemons: CodexDaemonManager;
  // Hook wiring (PERCH_SESSION_ID / PERCH_HOOK_*) + task capability env for
  // the daemon process, which runs the agent's tool shells.
  sessionEnv?: (sessionId: string, request: StartAgentRequest) => Record<string, string>;
  // Injectable client factory for tests (defaults to WS-over-unix).
  createClient?: CreateOwnedClient;
  // Bounded reconnect backoff after an unexpected control-connection drop.
  reconnectDelaysMs?: number[];
};

export type StartOwnedOptions = {
  resume?: {
    threadId: string;
    // Recorded socket of a daemon that may have survived a Perch restart.
    // When it still answers, the session rebinds WITHOUT respawning the
    // daemon; when it is dead, a fresh daemon resumes the rollout-backed
    // thread.
    socketPath?: string;
    // Codex runtime fingerprint recorded when the daemon was launched. A
    // surviving daemon is only adopted when the current runtime still
    // matches; a mismatch (codex upgraded between lives) falls through to a
    // fresh daemon resuming the rollout-backed thread.
    runtimeFingerprint?: string;
  };
};

type OwnedSession = {
  id: string;
  title: string;
  cwd: string;
  labels?: Record<string, string>;
  worktreeId?: string;
  status: AgentSessionStatus;
  createdAt: string;
  lastActivityAt: string;
  socketPath: string;
  client: CodexAppServerClient;
  threadId: string | null;
  activeTurnId: string | null;
  model?: string;
  effort?: CodexReasoningEffort;
  // Serialization: all programmatic input for a thread flows through this
  // chain, so two phone messages (or a kickoff racing a steer) can never
  // interleave their protocol requests.
  queue: Promise<unknown>;
  // Raw text buffered by sendInput until sendEnter submits it (the
  // AgentAdapter fallback path for callers that do not use submitInput).
  pendingRaw: string;
  stopped: boolean;
  reconnecting: boolean;
};

const DEFAULT_RECONNECT_DELAYS_MS = [500, 2_000];

export class CodexAppServerAdapter implements AgentAdapter {
  readonly name = "codex-app-server";

  private readonly sessions = new Map<string, OwnedSession>();
  private readonly daemons: CodexDaemonManager;
  private readonly sessionEnv?: (sessionId: string, request: StartAgentRequest) => Record<string, string>;
  private readonly createClient: CreateOwnedClient;
  private readonly reconnectDelaysMs: number[];
  private events: CodexOwnedEventSink = {};

  constructor(options: CodexAppServerAdapterOptions) {
    this.daemons = options.daemons;
    this.sessionEnv = options.sessionEnv;
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    this.createClient =
      options.createClient ??
      (({ sessionId, socketPath, handlers }) =>
        new CodexAppServerClient({
          sessionId,
          spawn: websocketUnixTransport({ socketPath }),
          onTimelineItem: handlers.onTimelineItem,
          onStatus: handlers.onStatus,
          onServerRequest: handlers.onServerRequest,
          onServerRequestResolved: handlers.onServerRequestResolved,
          onAssistantStream: handlers.onAssistantStream,
          onTurnStarted: handlers.onTurnStarted,
          onTurnComplete: handlers.onTurnComplete,
          onUsageLimit: handlers.onUsageLimit,
          onDisconnected: handlers.onDisconnected,
          clientName: "perch-owner"
        }));
  }

  // Wired once at boot, after the consumers (monitor, tasks, timeline) exist.
  wireEvents(events: CodexOwnedEventSink): void {
    this.events = events;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  threadIdOf(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.threadId ?? null;
  }

  socketPathOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.socketPath;
  }

  // Fingerprint of the codex runtime this adapter's daemons run, for durable
  // runtime metadata (the rebind path re-checks it before adopting a daemon).
  runtimeFingerprint(): string | undefined {
    return this.daemons.currentRuntimeFingerprint();
  }

  // The launcher assigns the worktree lease only after the session exists;
  // record it on the adapter's own session so later listSessions snapshots
  // keep the association (toAgentSession returns copies, not live objects).
  setWorktreeId(sessionId: string, worktreeId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.worktreeId = worktreeId;
  }

  // Sockets of live owned sessions, excluded from daemon teardown at graceful
  // shutdown so a healthy daemon survives for the post-restart rebind.
  liveSocketPaths(): Set<string> {
    const paths = new Set<string>();
    for (const session of this.sessions.values()) {
      if (!session.stopped) paths.add(session.socketPath);
    }
    return paths;
  }

  // ─── AgentAdapter surface ───────────────────────────────────

  async getTopology(): Promise<TopologyResponse> {
    return { windows: [], generatedAt: new Date().toISOString() };
  }

  async listSessions(): Promise<AgentSession[]> {
    return [...this.sessions.values()].map((session) => this.toAgentSession(session));
  }

  async readRecentEvents(): Promise<RecentEventsResult> {
    // No terminal surface exists: the timeline is the transcript. terminal:
    // false tells consumers (status reconciler, watchdog tails) there is no
    // screen to read, not that the screen is empty.
    return { events: [], terminal: false };
  }

  async sendInput(sessionId: string, text: string): Promise<void> {
    const session = this.mustSession(sessionId);
    session.pendingRaw += text;
  }

  async sendEnter(sessionId: string): Promise<void> {
    const session = this.mustSession(sessionId);
    const text = session.pendingRaw;
    session.pendingRaw = "";
    if (text.trim().length === 0) return;
    await this.submitInput(sessionId, text);
  }

  async submitInput(sessionId: string, text: string): Promise<boolean> {
    await this.enqueue(this.mustSession(sessionId), (session) => this.deliverText(session, text));
    return true;
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.mustSession(sessionId);
    await session.client.interrupt();
    session.activeTurnId = session.client.turnId;
  }

  async startAgent(request: StartAgentRequest): Promise<AgentSession> {
    // AgentAdapter-shaped entry: a `codex resume <threadId>` arg pair routes
    // to the resume path; everything else starts a fresh thread. The launcher
    // calls startOwned directly to carry a recorded socket.
    const args = request.args ?? [];
    const resumeIndex = args.indexOf("resume");
    const threadId = resumeIndex >= 0 ? args[resumeIndex + 1] : undefined;
    return this.startOwned(request, threadId ? { resume: { threadId } } : {});
  }

  async startOwned(request: StartAgentRequest, opts: StartOwnedOptions = {}): Promise<AgentSession> {
    const sessionId = request.sessionId ?? `pty:${randomUUID()}`;
    if (this.sessions.has(sessionId)) {
      throw new Error(`codex app-server session already exists: ${sessionId}`);
    }
    const cwd = request.cwd ?? process.cwd();
    const env = this.sessionEnv?.(sessionId, { ...request, sessionId });
    const configOverrides = request.effort ? [`model_reasoning_effort="${request.effort}"`] : [];

    // Prefer the recorded socket of a surviving daemon (rebind without
    // killing it); otherwise acquire a fresh per-worktree daemon.
    let socketPath: string | undefined;
    if (opts.resume?.socketPath) {
      const adopted = await this.daemons.adoptExisting(opts.resume.socketPath, cwd, {
        ...(opts.resume.runtimeFingerprint
          ? { expectedRuntimeFingerprint: opts.resume.runtimeFingerprint }
          : {})
      });
      if (adopted) socketPath = adopted.socketPath;
    }
    if (!socketPath) {
      const handle = await this.daemons.acquire(cwd, { configOverrides, env });
      socketPath = handle.socketPath;
    }

    const session: OwnedSession = {
      id: sessionId,
      title: request.title ?? `codex - ${cwd}`,
      cwd,
      ...(request.labels ? { labels: { ...request.labels } } : {}),
      status: "idle",
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      socketPath,
      client: null as unknown as CodexAppServerClient,
      threadId: null,
      activeTurnId: null,
      ...(request.effort ? { effort: request.effort } : {}),
      queue: Promise.resolve(),
      pendingRaw: "",
      stopped: false,
      reconnecting: false
    };
    session.client = this.createClient({
      sessionId,
      socketPath,
      handlers: this.handlersFor(session)
    });

    try {
      await session.client.connect();
      if (opts.resume) {
        const resumed = await session.client.resumeThread({ threadId: opts.resume.threadId, cwd });
        session.threadId = resumed.threadId;
        session.model = resumed.model;
        this.replayHistory(session, threadTurns(resumed.result));
      } else {
        const started = await session.client.startThread({ cwd, model: request.model });
        session.threadId = started.threadId;
        session.model = started.model;
      }
    } catch (error) {
      await session.client.disconnect().catch(() => {});
      // A daemon acquired for a launch that never produced a session dies
      // with the failure; an adopted resume daemon holds the only live copy
      // of the thread state and is left alone for the next attempt.
      if (!opts.resume?.socketPath || socketPath !== opts.resume.socketPath) {
        this.daemons.release(socketPath);
      }
      throw error;
    }

    this.sessions.set(sessionId, session);
    this.events.onThreadStarted?.(sessionId, session.threadId!, socketPath);
    if (session.model) this.events.onModelResolved?.(sessionId, session.model);
    return this.toAgentSession(session);
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.stopped) return;
    session.stopped = true;
    await session.client.disconnect().catch(() => {});
    this.daemons.release(session.socketPath);
    this.sessions.delete(sessionId);
    this.events.onSessionExit?.(sessionId, { status: "done" });
  }

  stop(opts: { keepDaemons?: boolean } = {}): void {
    for (const session of this.sessions.values()) {
      session.stopped = true;
      void session.client.disconnect().catch(() => {});
      if (!opts.keepDaemons) this.daemons.release(session.socketPath);
    }
    this.sessions.clear();
  }

  // ─── Codex-owned control surface (beyond AgentAdapter) ─────

  switchModel(sessionId: string, model: string, effort?: CodexReasoningEffort): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const trimmed = model.trim();
    if (!trimmed) return false;
    session.client.setModelForNextTurn(trimmed, effort);
    return true;
  }

  respondToServerRequest(sessionId: string, response: ServerRequestResponse): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.client.isConnected()) return false;
    return session.client.respondToServerRequest(response.requestId, response.decision, response.content);
  }

  // Read authoritative thread history for a turn containing the given
  // clientUserMessageId. Returns the containing turn, or undefined when the
  // history is readable and provably does NOT contain it. Serialized behind
  // the session's input queue so it can never interleave with a submit.
  async findAcceptedTurn(
    sessionId: string,
    clientUserMessageId: string
  ): Promise<ThreadHistoryTurn | undefined> {
    const session = this.mustSession(sessionId);
    return this.enqueue(session, async () => {
      if (!session.threadId) throw new Error("no thread established for this session");
      if (!session.client.isConnected()) await this.reconnect(session);
      const turns = threadTurns(await session.client.readThread(session.threadId));
      return findTurnByClientMessageId(turns, clientUserMessageId);
    });
  }

  // The acknowledged-delivery contract: resolves ONLY when the daemon
  // confirmed the input (a turn/start response, or history reconciliation
  // proving the message landed). Throws CodexRpcError on authoritative
  // rejection and CodexDeliveryUnknownError when acceptance stayed unknown
  // after reconciliation. Never resends without history-verified absence.
  async submitAcknowledgedTurn(
    sessionId: string,
    text: string,
    opts: { clientUserMessageId: string; source?: "human" | "agent" }
  ): Promise<{ turnId: string | null }> {
    const session = this.mustSession(sessionId);
    return this.enqueue(session, async () => {
      const result = await this.startTurnAcknowledged(session, text, opts.clientUserMessageId, opts.source);
      return result;
    });
  }

  // ─── Internals ──────────────────────────────────────────────

  private mustSession(sessionId: string): OwnedSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown codex app-server session: ${sessionId}`);
    return session;
  }

  private enqueue<T>(session: OwnedSession, work: (session: OwnedSession) => Promise<T>): Promise<T> {
    const run = session.queue.then(() => work(session));
    session.queue = run.catch(() => {});
    return run;
  }

  private touch(session: OwnedSession): void {
    session.lastActivityAt = new Date().toISOString();
  }

  // Deliver one composer/steer text: turn/start when idle, turn/steer with
  // the expectedTurnId CAS while a turn is active. A CAS miss re-reads the
  // live turn once; losing the race again falls through to turn/start (the
  // daemon folds it into the active turn if one still exists - verified
  // behavior, never an error).
  private async deliverText(session: OwnedSession, text: string): Promise<void> {
    const clientUserMessageId = `perch:${randomUUID()}`;
    if (session.activeTurnId) {
      try {
        await session.client.steerTurn(text, { expectedTurnId: session.activeTurnId, clientUserMessageId });
        this.touch(session);
        return;
      } catch (error) {
        if (!isCodexRpcError(error)) {
          await this.reconcileUnknownDelivery(session, text, clientUserMessageId);
          return;
        }
        const liveTurnId = session.client.turnId;
        if (liveTurnId && liveTurnId !== session.activeTurnId) {
          session.activeTurnId = liveTurnId;
          try {
            await session.client.steerTurn(text, { expectedTurnId: liveTurnId, clientUserMessageId });
            this.touch(session);
            return;
          } catch (retryError) {
            if (!isCodexRpcError(retryError)) {
              await this.reconcileUnknownDelivery(session, text, clientUserMessageId);
              return;
            }
            // Turn settled between reads: deliver as a fresh turn below.
          }
        }
      }
    }
    await this.startTurnAcknowledged(session, text, clientUserMessageId);
  }

  private async startTurnAcknowledged(
    session: OwnedSession,
    text: string,
    clientUserMessageId: string,
    source?: "human" | "agent"
  ): Promise<{ turnId: string | null }> {
    try {
      const { turnId } = await session.client.submitTurn(text, {
        clientUserMessageId,
        ...(source ? { source } : {})
      });
      if (turnId) session.activeTurnId = turnId;
      this.touch(session);
      return { turnId };
    } catch (error) {
      if (isCodexRpcError(error)) throw error;
      return this.reconcileUnknownDelivery(session, text, clientUserMessageId, source);
    }
  }

  // The turn/start (or steer) request was sent but its response was lost:
  // acceptance is UNKNOWN. Reconnect, resume the thread, and read authoritative
  // history for our clientUserMessageId. Found -> it landed, never resend.
  // Verifiably absent -> one resend with the same id. Anything less certain
  // throws CodexDeliveryUnknownError.
  private async reconcileUnknownDelivery(
    session: OwnedSession,
    text: string,
    clientUserMessageId: string,
    source?: "human" | "agent"
  ): Promise<{ turnId: string | null }> {
    const threadId = session.threadId;
    if (!threadId) {
      throw new CodexDeliveryUnknownError(
        "input delivery is unknown: the codex connection dropped before the thread was established; not resent"
      );
    }
    try {
      await this.reconnect(session);
    } catch (error) {
      throw new CodexDeliveryUnknownError(
        `input delivery is unknown: the codex app-server connection was lost and could not be re-established (${
          error instanceof Error ? error.message : error
        }); not resent`
      );
    }
    let turns: ThreadHistoryTurn[];
    try {
      turns = threadTurns(await session.client.readThread(threadId));
    } catch (error) {
      if (isThreadNotMaterializedError(error)) {
        // Verified live on 0.144.6: a thread with no first user message is
        // "not materialized" and refuses includeTurns. That is authoritative
        // PROOF the lost input never landed - safe to fall through to the
        // single resend below.
        turns = [];
      } else {
        throw new CodexDeliveryUnknownError(
          `input delivery is unknown: thread history could not be read after reconnect (${
            error instanceof Error ? error.message : error
          }); not resent`
        );
      }
    }
    const landed = findTurnByClientMessageId(turns, clientUserMessageId);
    if (landed) {
      this.touch(session);
      return { turnId: landed.id ?? null };
    }
    // History-verified absence: the one resend this delivery may ever make.
    // A non-RPC failure here (connection lost again mid-resend) is once more
    // an UNKNOWN outcome, not a plain failure - report it as such.
    let turnId: string | null;
    try {
      ({ turnId } = await session.client.submitTurn(text, {
        clientUserMessageId,
        ...(source ? { source } : {})
      }));
    } catch (error) {
      if (isCodexRpcError(error)) throw error;
      throw new CodexDeliveryUnknownError(
        `input delivery is unknown: the history-verified resend itself failed (${
          error instanceof Error ? error.message : error
        }); acceptance was not confirmed`
      );
    }
    if (turnId) session.activeTurnId = turnId;
    this.touch(session);
    return { turnId };
  }

  private async reconnect(session: OwnedSession): Promise<void> {
    if (session.client.isConnected()) return;
    await session.client.disconnect().catch(() => {});
    await session.client.connect();
    if (session.threadId) {
      const resumed = await session.client.resumeThread({ threadId: session.threadId, cwd: session.cwd });
      session.threadId = resumed.threadId;
      this.replayHistory(session, threadTurns(resumed.result));
    }
  }

  // Unexpected control-connection drop (daemon crash, socket churn): bounded
  // reconnect attempts, then the session is truthfully dead - runtime
  // interruption and the recovery flow own what happens next.
  private handleDisconnect(session: OwnedSession): void {
    if (session.stopped || session.reconnecting) return;
    session.reconnecting = true;
    void (async () => {
      try {
        for (const delayMs of this.reconnectDelaysMs) {
          await sleep(delayMs);
          if (session.stopped) return;
          try {
            await this.reconnect(session);
            return;
          } catch {
            // Next backoff step, then give up below.
          }
        }
        if (session.stopped) return;
        session.stopped = true;
        session.status = "error";
        await session.client.disconnect().catch(() => {});
        this.daemons.release(session.socketPath);
        this.sessions.delete(session.id);
        this.events.onSessionExit?.(session.id, {
          status: "error",
          tail: "codex app-server connection lost and reconnect attempts were exhausted"
        });
      } finally {
        session.reconnecting = false;
      }
    })();
  }

  // Replay resumed turn history into the timeline, deduped downstream by
  // protocol item id. An interrupted in-flight turn is represented truthfully
  // as a system row instead of pretending the turn is still running.
  private replayHistory(session: OwnedSession, turns: ThreadHistoryTurn[]): void {
    if (!this.events.onTimelineItem) return;
    for (const turn of turns) {
      for (const item of turn.items ?? []) {
        const timelineItem = historyItemToTimeline(session.id, item);
        if (timelineItem) this.events.onTimelineItem(timelineItem, false);
      }
      if (turn.status === "interrupted" && turn.id) {
        this.events.onTimelineItem(
          {
            seq: 0,
            id: `cx-item-${turn.id}:interrupted`,
            sessionId: session.id,
            kind: "system",
            text: "This turn was interrupted by a runtime restart; recovery resumed the thread from persisted history.",
            at: new Date().toISOString()
          },
          false
        );
      }
    }
  }

  private handlersFor(session: OwnedSession): Parameters<CreateOwnedClient>[0]["handlers"] {
    return {
      onTimelineItem: (item) => {
        this.touch(session);
        this.events.onTimelineItem?.(item, true);
      },
      onStatus: (status) => {
        session.status = status;
        this.touch(session);
        this.events.onStatus?.(session.id, status);
      },
      onServerRequest: (request) => this.events.onServerRequest?.(session.id, request),
      onServerRequestResolved: (request) => this.events.onServerRequestResolved?.(session.id, request),
      onAssistantStream: (ev) => {
        this.touch(session);
        this.events.onAssistantStream?.(session.id, ev);
      },
      onTurnStarted: () => {
        session.activeTurnId = session.client.turnId;
        this.touch(session);
        this.events.onTurnStarted?.(session.id);
      },
      onTurnComplete: (ev) => {
        session.activeTurnId = null;
        this.touch(session);
        this.events.onTurnComplete?.(session.id, ev);
      },
      onUsageLimit: (limit) => this.events.onUsageLimit?.(session.id, limit),
      onDisconnected: () => this.handleDisconnect(session)
    };
  }

  private toAgentSession(session: OwnedSession): AgentSession {
    return {
      id: session.id,
      title: session.title,
      agent: "codex",
      cwd: session.cwd,
      ...(session.labels ? { labels: { ...session.labels } } : {}),
      ...(session.worktreeId ? { worktreeId: session.worktreeId } : {}),
      kind: "terminal",
      status: session.status,
      ...(session.model ? { model: session.model } : {}),
      ...(session.effort ? { effort: session.effort } : {}),
      lastActivityAt: session.lastActivityAt,
      ...(session.threadId
        ? {
            attachCommand: `codex resume ${session.threadId} --remote unix://${session.socketPath}`,
            attachThreadId: session.threadId,
            attachSocketPath: session.socketPath
          }
        : {})
    };
  }
}

// 0.144.6, verified live: thread/read {includeTurns} on a thread with no
// first user message rejects -32600 "not materialized yet". For lost-input
// reconciliation that rejection is affirmative evidence of absence.
function isThreadNotMaterializedError(error: unknown): boolean {
  return (
    isCodexRpcError(error) &&
    (error as CodexRpcError).code === -32600 &&
    /not materialized yet/.test((error as CodexRpcError).rpcMessage)
  );
}

function threadTurns(result: unknown): ThreadHistoryTurn[] {
  const thread = (result as { thread?: { turns?: unknown } } | undefined)?.thread;
  return Array.isArray(thread?.turns) ? (thread.turns as ThreadHistoryTurn[]) : [];
}

export function findTurnByClientMessageId(
  turns: ThreadHistoryTurn[],
  clientUserMessageId: string
): ThreadHistoryTurn | undefined {
  for (const turn of turns) {
    for (const item of turn.items ?? []) {
      if (item.type === "userMessage" && item.clientId === clientUserMessageId) return turn;
    }
  }
  return undefined;
}

// Project a thread/read (or resume-replayed) history item into perch's
// timeline shape. Stable `cx-item-<protocol id>` ids make the replay
// idempotent against rows already ingested live.
function historyItemToTimeline(sessionId: string, item: Record<string, unknown>): TimelineItem | undefined {
  const id = typeof item.id === "string" && item.id.length > 0 ? item.id : undefined;
  const type = typeof item.type === "string" ? item.type : "";
  const at = new Date().toISOString();
  if (type === "userMessage") {
    const text = userMessageText(item);
    if (!text) return undefined;
    const clientId = typeof item.clientId === "string" ? item.clientId : undefined;
    return {
      seq: 0,
      id: `cx-item-${clientId ?? id ?? `user-${hashText(text)}`}`,
      sessionId,
      kind: "user",
      text,
      at
    };
  }
  if (type === "agentMessage") {
    const text = typeof item.text === "string" ? item.text : "";
    if (!text || !id) return undefined;
    return { seq: 0, id: `cx-item-${id}`, sessionId, kind: "assistant", text, at };
  }
  if (type === "commandExecution") {
    if (!id) return undefined;
    const command = typeof item.command === "string" ? item.command : undefined;
    return {
      seq: 0,
      id: `cx-item-${id}:call`,
      sessionId,
      kind: "tool_call",
      at,
      tool: { name: "shell", ...(command ? { input: command } : {}) }
    };
  }
  return undefined;
}

function userMessageText(item: Record<string, unknown>): string {
  const content = item.content;
  if (typeof item.text === "string" && item.text.length > 0) return item.text;
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) =>
      entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string"
        ? ((entry as { text: string }).text ?? "")
        : ""
    )
    .filter(Boolean)
    .join("\n");
}

function hashText(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(16);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
