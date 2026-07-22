// Test harness: a stateful fake `codex app-server` daemon speaking the v2
// JSON-RPC protocol over WebSocket-on-unix-socket, faithful to the semantics
// verified live against codex-cli 0.144.6 for the app-server-owned design
// (docs/plans/2026-07-22-app-server-owned-codex.md):
//   - unlimited concurrent clients, each with its own initialize;
//   - turn/item events go only to thread subscribers; thread/started broadcasts;
//   - thread/resume subscribes and replays turn history in the response;
//   - a second turn/start steers into the active turn (never errors);
//   - turn/steer carries a real expectedTurnId CAS;
//   - clientUserMessageId persists into history as the userMessage clientId;
//   - approvals fan out with one request id, first answer wins, the rest get
//     serverRequest/resolved;
//   - threads survive a daemon restart (rollout-backed); the in-flight turn
//     becomes interrupted; turns are not resumable.
//
// Production code never imports this module; it exists so the adapter,
// recovery, and two-client attachment suites exercise the real transport and
// protocol engine instead of hand-rolled stubs (same precedent as
// failureInjection.ts for test-only hooks in prod source).

import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { CodexOwnedEventSink } from "./codexAppServerAdapter.js";

type JsonRpc = {
  jsonrpc?: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};

type FakeTurnItem = Record<string, unknown> & { id: string; type: string };

export type FakeTurn = {
  id: string;
  status: "inProgress" | "completed" | "interrupted" | "failed";
  items: FakeTurnItem[];
};

type FakeThread = {
  id: string;
  cwd: string;
  turns: FakeTurn[];
  activeTurnId: string | null;
  subscribers: Set<WebSocket>;
};

type PendingApproval = {
  requestId: number;
  threadId: string;
  askedOf: Set<WebSocket>;
  resolve: (answer: { result: unknown; socket: WebSocket }) => void;
};

// What the next turn/start does, then resets to "ok":
//   "reject"             - JSON-RPC error response (authoritative rejection)
//   "accept-no-response" - the input IS applied to the thread, then the
//                          connection drops without a response (acceptance
//                          unknown, message landed)
//   "lose-before-apply"  - the connection drops without applying the input
//                          (acceptance unknown, message never landed)
export type TurnStartBehavior = "ok" | "reject" | "accept-no-response" | "lose-before-apply";

export class FakeCodexAppServer {
  readonly threads = new Map<string, FakeThread>();
  readonly requestLog: Array<{ method: string; params: Record<string, unknown> }> = [];
  nextTurnStartBehavior: TurnStartBehavior = "ok";
  rejectionError = { code: -32000, message: "turn refused by fake policy" };
  // Thread ids whose rollout "was never written": thread/resume fails with
  // the exact permanent -32600 condition the classifier matches.
  readonly missingRollouts = new Set<string>();
  model = "gpt-5.5-codex";

  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private sockets = new Set<WebSocket>();
  private threadCounter = 0;
  private turnCounter = 0;
  private itemCounter = 0;
  private approvalCounter = 0;
  private readonly approvals = new Map<number, PendingApproval>();
  private socketPath: string | null = null;

  async start(socketPath: string): Promise<void> {
    this.socketPath = socketPath;
    this.http = createServer();
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on("upgrade", (request, socket, head) => {
      if (request.url !== "/rpc") return void socket.destroy();
      this.wss!.handleUpgrade(request, socket, head, (ws) => this.accept(ws));
    });
    await new Promise<void>((resolve) => this.http!.listen(socketPath, resolve));
  }

  // Daemon death: every connection drops, the active turn dies with the
  // process. Thread history survives in this instance (the rollout analog),
  // so a later start() + thread/resume replays it with the in-flight turn
  // represented as interrupted.
  async stop(): Promise<void> {
    for (const thread of this.threads.values()) {
      if (thread.activeTurnId) {
        const active = thread.turns.find((turn) => turn.id === thread.activeTurnId);
        if (active) active.status = "interrupted";
        thread.activeTurnId = null;
      }
      thread.subscribers.clear();
    }
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
    this.approvals.clear();
    this.wss?.close();
    const http = this.http;
    this.http = null;
    this.wss = null;
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
  }

  async restart(): Promise<void> {
    const socketPath = this.socketPath;
    if (!socketPath) throw new Error("fake app-server was never started");
    await this.stop();
    await removeSocketFile(socketPath);
    await this.start(socketPath);
  }

  connectionCount(): number {
    return this.sockets.size;
  }

  thread(threadId: string): FakeThread {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`unknown fake thread: ${threadId}`);
    return thread;
  }

  // Seed a rollout-backed thread that no live daemon ever announced this run
  // (legacy-migration scenarios).
  seedThread(threadId: string, turns: FakeTurn[] = [], cwd = "/"): void {
    this.threads.set(threadId, { id: threadId, cwd, turns, activeTurnId: null, subscribers: new Set() });
  }

  // Drive the active turn like the real model would: stream a delta, settle
  // the assistant message, complete the turn.
  completeActiveTurn(threadId: string, message: string): void {
    const thread = this.thread(threadId);
    const turnId = thread.activeTurnId;
    if (!turnId) throw new Error(`no active turn on ${threadId}`);
    const turn = thread.turns.find((candidate) => candidate.id === turnId)!;
    const itemId = `item_${++this.itemCounter}`;
    turn.items.push({ id: itemId, type: "agentMessage", text: message });
    turn.status = "completed";
    thread.activeTurnId = null;
    this.notifySubscribers(thread, "item/completed", {
      threadId,
      turn: { id: turnId },
      item: { id: itemId, type: "agentMessage", text: message, phase: "final_answer" }
    });
    this.notifySubscribers(thread, "turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
  }

  emitAssistantDelta(threadId: string, itemId: string, delta: string): void {
    const thread = this.thread(threadId);
    this.notifySubscribers(thread, "item/agentMessage/delta", { threadId, itemId, delta });
  }

  // Fan an approval request out to every subscriber with ONE request id.
  // Resolves with the first answer; every other subscriber gets
  // serverRequest/resolved for the same id.
  requestApproval(
    threadId: string,
    params: Record<string, unknown> = {}
  ): { requestId: number; answer: Promise<{ result: unknown }> } {
    const thread = this.thread(threadId);
    const requestId = ++this.approvalCounter;
    const askedOf = new Set(thread.subscribers);
    const answer = new Promise<{ result: unknown; socket: WebSocket }>((resolve) => {
      this.approvals.set(requestId, { requestId, threadId, askedOf, resolve });
    });
    for (const socket of askedOf) {
      this.send(socket, {
        jsonrpc: "2.0",
        id: requestId,
        method: "item/commandExecution/requestApproval",
        params: { threadId, turnId: thread.activeTurnId, itemId: `item_${requestId}`, ...params }
      });
    }
    return { requestId, answer: answer.then(({ result }) => ({ result })) };
  }

  private accept(ws: WebSocket): void {
    this.sockets.add(ws);
    ws.on("close", () => {
      this.sockets.delete(ws);
      for (const thread of this.threads.values()) thread.subscribers.delete(ws);
    });
    ws.on("message", (data) => {
      let msg: JsonRpc;
      try {
        msg = JSON.parse(data.toString("utf8")) as JsonRpc;
      } catch {
        return;
      }
      // An answer to a server->client approval request.
      if (msg.id != null && msg.method === undefined && (msg.result !== undefined || msg.error !== undefined)) {
        this.handleApprovalAnswer(ws, msg);
        return;
      }
      if (msg.method) this.handleRequest(ws, msg);
    });
  }

  private handleApprovalAnswer(ws: WebSocket, msg: JsonRpc): void {
    const approval = typeof msg.id === "number" ? this.approvals.get(msg.id) : undefined;
    if (!approval) return;
    this.approvals.delete(approval.requestId);
    approval.resolve({ result: msg.result, socket: ws });
    const thread = this.threads.get(approval.threadId);
    if (!thread) return;
    for (const other of approval.askedOf) {
      if (other === ws || other.readyState !== other.OPEN) continue;
      this.send(other, {
        jsonrpc: "2.0",
        method: "serverRequest/resolved",
        params: { requestId: approval.requestId, threadId: approval.threadId }
      });
    }
  }

  private handleRequest(ws: WebSocket, msg: JsonRpc): void {
    const method = msg.method!;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    this.requestLog.push({ method, params });
    const reply = (result: unknown) => {
      if (msg.id != null) this.send(ws, { jsonrpc: "2.0", id: msg.id, result });
    };
    const fail = (code: number, message: string) => {
      if (msg.id != null) this.send(ws, { jsonrpc: "2.0", id: msg.id, error: { code, message } });
    };

    switch (method) {
      case "initialize":
        return reply({ userAgent: "fake-codex/0.144.6" });
      case "initialized":
        return;
      case "model/list":
        return reply({ models: [{ id: this.model }] });
      case "thread/start": {
        const id = `thr_${++this.threadCounter}`;
        const thread: FakeThread = {
          id,
          cwd: typeof params.cwd === "string" ? params.cwd : "/",
          turns: [],
          activeTurnId: null,
          subscribers: new Set([ws])
        };
        this.threads.set(id, thread);
        // Lifecycle broadcast, observed live: every connection learns the
        // thread exists; only subscribers get its turn/item events.
        for (const socket of this.sockets) {
          this.send(socket, { jsonrpc: "2.0", method: "thread/started", params: { thread: { id } } });
        }
        return reply({ thread: { id, turns: [] }, model: this.model });
      }
      case "thread/resume": {
        const threadId = String(params.threadId ?? "");
        if (this.missingRollouts.has(threadId)) {
          return fail(-32600, `no rollout found for thread id: ${threadId}`);
        }
        const thread = this.threads.get(threadId);
        if (!thread) return fail(-32600, `no rollout found for thread id: ${threadId}`);
        thread.subscribers.add(ws);
        return reply({ thread: { id: thread.id, turns: structuredClone(thread.turns) }, model: this.model });
      }
      case "thread/read": {
        const thread = this.threads.get(String(params.threadId ?? ""));
        if (!thread) return fail(-32600, `unknown thread id`);
        return reply({
          thread: {
            id: thread.id,
            turns: params.includeTurns === true ? structuredClone(thread.turns) : []
          }
        });
      }
      case "turn/start": {
        const thread = this.threads.get(String(params.threadId ?? ""));
        if (!thread) return fail(-32600, "unknown thread id");
        const behavior = this.nextTurnStartBehavior;
        this.nextTurnStartBehavior = "ok";
        if (behavior === "reject") {
          return fail(this.rejectionError.code, this.rejectionError.message);
        }
        if (behavior === "lose-before-apply") {
          ws.terminate();
          return;
        }
        const userItem = this.userItem(params);
        if (thread.activeTurnId) {
          // Verified live: a second turn/start never errors; it steers into
          // the active turn.
          const active = thread.turns.find((turn) => turn.id === thread.activeTurnId)!;
          active.items.push(userItem);
          return reply({ turn: { id: active.id, status: active.status, items: structuredClone(active.items) } });
        }
        const turn: FakeTurn = { id: `turn_${++this.turnCounter}`, status: "inProgress", items: [userItem] };
        thread.turns.push(turn);
        thread.activeTurnId = turn.id;
        this.notifySubscribers(thread, "turn/started", { threadId: thread.id, turn: { id: turn.id } });
        if (behavior === "accept-no-response") {
          ws.terminate();
          return;
        }
        return reply({ turn: { id: turn.id, status: turn.status, items: structuredClone(turn.items) } });
      }
      case "turn/steer": {
        const thread = this.threads.get(String(params.threadId ?? ""));
        if (!thread) return fail(-32600, "unknown thread id");
        if (!thread.activeTurnId || thread.activeTurnId !== params.expectedTurnId) {
          return fail(-32602, `expectedTurnId does not match the active turn`);
        }
        const active = thread.turns.find((turn) => turn.id === thread.activeTurnId)!;
        active.items.push(this.userItem(params));
        return reply({});
      }
      case "turn/interrupt": {
        const thread = this.threads.get(String(params.threadId ?? ""));
        if (!thread) return fail(-32600, "unknown thread id");
        const turnId = thread.activeTurnId;
        if (turnId) {
          const active = thread.turns.find((turn) => turn.id === turnId)!;
          active.status = "interrupted";
          thread.activeTurnId = null;
          this.notifySubscribers(thread, "turn/completed", {
            threadId: thread.id,
            turn: { id: turnId, status: "interrupted" }
          });
        }
        return reply({ abortReason: "interrupted" });
      }
      default:
        return reply({});
    }
  }

  private userItem(params: Record<string, unknown>): FakeTurnItem {
    const input = Array.isArray(params.input) ? (params.input as Array<Record<string, unknown>>) : [];
    return {
      id: `item_${++this.itemCounter}`,
      type: "userMessage",
      clientId: typeof params.clientUserMessageId === "string" ? params.clientUserMessageId : null,
      content: structuredClone(input)
    };
  }

  private notifySubscribers(thread: FakeThread, method: string, params: Record<string, unknown>): void {
    for (const socket of thread.subscribers) {
      if (socket.readyState === socket.OPEN) this.send(socket, { jsonrpc: "2.0", method, params });
    }
  }

  private send(ws: WebSocket, msg: JsonRpc): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
}

async function removeSocketFile(socketPath: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(socketPath, { force: true });
}

// In-memory stand-in for CodexAppServerAdapter for HTTP/launcher-level suites
// that assert routing, journaling, and lifecycle - not wire behavior (the
// adapter suite covers that against FakeCodexAppServer above). Tests cast it
// `as unknown as CodexAppServerAdapter`.
type FakeOwnedSession = {
  id: string;
  threadId: string;
  socketPath: string;
  title: string;
  cwd?: string;
  labels?: Record<string, string>;
  worktreeId?: string;
  attachCommandReady: boolean;
};

export class FakeCodexOwnedAdapter {
  readonly name = "fake-codex-owned";
  launches: Array<{ request: Record<string, unknown>; resume?: { threadId: string; socketPath?: string } }> = [];
  submitted: Array<{ sessionId: string; text: string; clientUserMessageId?: string; source?: string }> = [];
  modelSwitches: Array<{ sessionId: string; model: string; effort?: string }> = [];
  serverResponses: Array<{ sessionId: string; response: Record<string, unknown> }> = [];
  stopped: string[] = [];
  events: CodexOwnedEventSink = {};
  // Knobs
  failStart: Error | null = null;
  nextSubmitError: Error | null = null;
  // Simulates a daemon whose thread/resume lands on an unexpected identity.
  resumedThreadOverride: string | null = null;
  // Fired synchronously after a successful startOwned (candidate-death races).
  onStartOwned: ((sessionId: string) => void) | null = null;
  // stopSession records the stop but the session refuses to die (cleanup-failure paths).
  refuseStop = false;
  // clientUserMessageId -> accepted turn (findAcceptedTurn reads this).
  readonly history = new Map<string, { id: string }>();
  historyReadError: Error | null = null;
  // Reported by runtimeFingerprint() (rebind invariant tests set it).
  fakeRuntimeFingerprint: string | undefined;
  autoCompleteAcknowledgedTurns = true;

  private readonly sessions = new Map<string, FakeOwnedSession>();
  private readonly turnCompletionWaiters = new Map<string, () => void>();
  private threadCounter = 0;
  private turnCounter = 0;

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

  runtimeFingerprint(): string | undefined {
    return this.fakeRuntimeFingerprint;
  }

  setWorktreeId(sessionId: string, worktreeId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.worktreeId = worktreeId;
  }

  liveSocketPaths(): Set<string> {
    return new Set([...this.sessions.values()].map((session) => session.socketPath));
  }

  async startOwned(
    request: { sessionId?: string; title?: string; cwd?: string; labels?: Record<string, string> },
    opts: { deferAttachCommand?: boolean; resume?: { threadId: string; socketPath?: string } } = {}
  ) {
    if (this.failStart) throw this.failStart;
    const id = request.sessionId ?? `pty:${Math.random().toString(36).slice(2)}`;
    const threadId =
      this.resumedThreadOverride ?? opts.resume?.threadId ?? `thr-fake-${++this.threadCounter}`;
    const socketPath = opts.resume?.socketPath ?? `/fake/daemons/${id.slice(4, 12)}.sock`;
    this.launches.push({ request: { ...request }, ...(opts.resume ? { resume: opts.resume } : {}) });
    this.sessions.set(id, {
      id,
      threadId,
      socketPath,
      title: request.title ?? "codex",
      cwd: request.cwd,
      labels: request.labels,
      attachCommandReady: opts.deferAttachCommand !== true
    });
    this.onStartOwned?.(id);
    return {
      id,
      title: request.title ?? "codex",
      ...(request.labels?.workerName ? { workerName: request.labels.workerName } : {}),
      agent: "codex" as const,
      cwd: request.cwd,
      ...(request.labels ? { labels: request.labels } : {}),
      kind: "terminal" as const,
      status: "idle" as const,
      lastActivityAt: new Date().toISOString(),
      ...(opts.deferAttachCommand !== true
        ? {
            attachCommand: `codex resume ${threadId} --remote unix://${socketPath}`,
            attachThreadId: threadId,
            attachSocketPath: socketPath
          }
        : {})
    };
  }

  async startAgent(request: { args?: string[]; sessionId?: string; title?: string; cwd?: string }) {
    const args = request.args ?? [];
    const index = args.indexOf("resume");
    const threadId = index >= 0 ? args[index + 1] : undefined;
    return this.startOwned(request, threadId ? { resume: { threadId } } : {});
  }

  async submitAcknowledgedTurn(
    sessionId: string,
    text: string,
    opts: { clientUserMessageId: string; source?: "human" | "agent" }
  ): Promise<{ turnId: string | null }> {
    if (this.nextSubmitError) {
      const error = this.nextSubmitError;
      this.nextSubmitError = null;
      throw error;
    }
    this.submitted.push({ sessionId, text, clientUserMessageId: opts.clientUserMessageId, source: opts.source });
    return { turnId: `turn-fake-${++this.turnCounter}` };
  }

  async submitAcknowledgedTurnAndWait(
    sessionId: string,
    text: string,
    opts: { clientUserMessageId: string; source?: "human" | "agent" }
  ): Promise<void> {
    await this.submitAcknowledgedTurn(sessionId, text, opts);
    if (this.autoCompleteAcknowledgedTurns) return;
    await new Promise<void>((resolve) => this.turnCompletionWaiters.set(sessionId, resolve));
  }

  emitTurnCompleted(sessionId: string): void {
    this.turnCompletionWaiters.get(sessionId)?.();
    this.turnCompletionWaiters.delete(sessionId);
  }

  revealAttachCommand(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown fake codex session: ${sessionId}`);
    session.attachCommandReady = true;
    return this.toAgentSession(session);
  }

  async findAcceptedTurn(_sessionId: string, clientUserMessageId: string): Promise<{ id: string } | undefined> {
    if (this.historyReadError) throw this.historyReadError;
    return this.history.get(clientUserMessageId);
  }

  async submitInput(sessionId: string, text: string): Promise<boolean> {
    this.submitted.push({ sessionId, text });
    return true;
  }

  async sendInput(): Promise<void> {}
  async sendEnter(): Promise<void> {}
  async interrupt(): Promise<void> {}

  async getTopology() {
    return { windows: [], generatedAt: "" };
  }

  async listSessions() {
    return [...this.sessions.values()].map((session) => this.toAgentSession(session));
  }

  private toAgentSession(session: FakeOwnedSession) {
    return {
      id: session.id,
      title: session.title,
      ...(session.labels?.workerName ? { workerName: session.labels.workerName } : {}),
      agent: "codex" as const,
      cwd: session.cwd,
      ...(session.labels ? { labels: session.labels } : {}),
      ...(session.worktreeId ? { worktreeId: session.worktreeId } : {}),
      kind: "terminal" as const,
      status: "idle" as const,
      lastActivityAt: new Date().toISOString(),
      ...(session.attachCommandReady
        ? {
            attachCommand: `codex resume ${session.threadId} --remote unix://${session.socketPath}`,
            attachThreadId: session.threadId,
            attachSocketPath: session.socketPath
          }
        : {})
    };
  }

  async readRecentEvents() {
    return { events: [], terminal: false as const };
  }

  switchModel(sessionId: string, model: string, effort?: string): boolean {
    if (!this.sessions.has(sessionId)) return false;
    this.modelSwitches.push({ sessionId, model, ...(effort ? { effort } : {}) });
    return true;
  }

  respondToServerRequest(sessionId: string, response: Record<string, unknown>): boolean {
    if (!this.sessions.has(sessionId)) return false;
    this.serverResponses.push({ sessionId, response });
    return true;
  }

  async stopSession(sessionId: string): Promise<void> {
    this.stopped.push(sessionId);
    if (!this.refuseStop) this.sessions.delete(sessionId);
  }

  // Kill a session out from under everyone (no stop bookkeeping, no events):
  // the "candidate died before the bind" simulation.
  killSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  stop(): void {
    this.sessions.clear();
  }
}
