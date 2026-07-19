// Codex app-server control client - drives a Codex thread over the v2 JSON-RPC
// protocol (`codex app-server`, newline-delimited JSON over stdio).
//
// This is a faithful port of happy's hand-rolled client
// (happy/packages/happy-cli/src/codex/codexAppServerClient.ts). The protocol is
// marked [experimental] and has many undocumented sharp edges; the port keeps
// happy's hard-won behaviour verbatim where it matters:
//   - process-epoch guarding so stale process output/exits are ignored,
//   - turn-completion tracking that resolves on task_complete / turn_aborted,
//     guarded by turn-id matching (fast turns can skip task_started),
//   - a 3s interrupt fallback that force-restarts + resumes the thread,
//   - auto-detection of BOTH notification protocols (legacy `codex/event/<type>`
//     and raw v2 `thread/*` / `turn/*` / `item/*`).
//
// It differs from happy in two deliberate ways:
//   1. Output is normalized into perch's agent-agnostic `TimelineItem` /
//      `AgentSessionStatus` / approval types, not happy's internal EventMsg.
//   2. The transport is injectable (`spawn` option) so the whole protocol state
//      machine is unit-testable against mock streams, with no daemon or codex
//      install. The default transport spawns a stdio `app-server` child.
//
// Topology note (option b): the same protocol engine drives either a
// per-session stdio `app-server` (the opt-in fallback, via the default stdio
// `spawn`) or a control connection to a perch-owned `codex app-server --listen
// unix://` daemon that a real `codex --remote` TUI is also attached to (the
// primary path, via `websocketUnixTransport` in wsUnixTransport.ts). The engine
// is identical; only the `spawn` factory and whether we thread/start vs
// thread/resume differ. The daemon lifecycle lives in codexDaemon.ts and the
// live session/model/approval routing in codexControl.ts. When the control
// client attaches to a daemon whose TUI already owns a thread, it learns that
// thread id from the daemon's `thread/started` broadcast (see onThreadStarted).

import { spawn as childSpawn } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type {
  AgentSessionStatus,
  PendingServerRequest,
  TimelineItem,
  TimelineItemKind
} from "@perch/shared";
import { assertLocalRuntimeModelId } from "../modelSwitch.js";
import type {
  ApprovalPolicy,
  InputItem,
  InterruptConversationParams,
  JsonRpcMessage,
  NewConversationParams,
  ReasoningEffort,
  ResumeConversationParams,
  ReviewDecision,
  SandboxMode,
  ThreadResult,
  TurnStartParams
} from "./codexAppServerTypes.js";
import { usageLimitFromCodexAppServer, type UsageLimit } from "../usageLimitDetect.js";

// A duplex-ish handle over a codex app-server process. Abstracted so tests can
// inject mock streams and a scripted responder in place of a real child.
export interface CodexTransport {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr?: Readable | null;
  readonly pid?: number;
  onExit(callback: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export type SpawnTransport = () => CodexTransport;

// A normalized approval request handed to the consumer. The consumer returns a
// decision; the client maps it to the correct wire format for the method.
export type CodexApprovalRequest = {
  kind: "exec" | "patch" | "mcp";
  callId: string;
  summary: string;
  command?: string;
  cwd?: string;
  reason?: string | null;
};

export type CodexApprovalHandler = (
  request: CodexApprovalRequest
) => Promise<ReviewDecision>;

export type CodexAppServerOptions = {
  // The perch session id this thread belongs to; stamped onto every emitted
  // TimelineItem so downstream consumers need no extra context.
  sessionId: string;
  // Transport factory. Defaults to a stdio `codex app-server` child. The daemon
  // / `--remote` path supplies its own factory once that lifecycle is built.
  spawn?: SpawnTransport;
  // Normalized structured-timeline sink (user/assistant/tool items).
  onTimelineItem?: (item: TimelineItem) => void;
  // Coarse status sink (running / idle / needs_approval), mirroring the fleet
  // overview tier. Approvals flip to needs_approval and back.
  onStatus?: (status: AgentSessionStatus) => void;
  // Answers server->client approval requests. Absent = deny (safe default).
  approvalHandler?: CodexApprovalHandler;
  // Production structured-request path. The callback projects the exact
  // app-server request into Perch; respondToServerRequest answers it later.
  onServerRequest?: (request: PendingServerRequest) => void;
  onServerRequestResolved?: (request: PendingServerRequest) => void;
  // Fired when the daemon broadcasts a `thread/started` for a thread this
  // client did not itself start - i.e. the `--remote` TUI opened the thread.
  // Lets the control plane learn and resume the shared thread to steer it.
  onThreadStarted?: (threadId: string) => void;
  // Live incremental assistant text. Fired as `item/agentMessage/delta` (v2) or
  // `agent_message_delta` (legacy) notifications arrive, carrying the FULL
  // accumulated text so far for `itemId` (idempotent replace). `done` marks the
  // message finished. This is the phone's ONLY live view of a codex response:
  // the deltas are never written to the rollout JSONL, so without forwarding
  // them the phone sees the message only when the finished row tails back.
  onAssistantStream?: (ev: { itemId: string; text: string; done: boolean }) => void;
  // Fired once when a turn settles successfully (not aborted), carrying the
  // turn's final assistant message when present. Daemon-driven codex turns
  // never fire the PERCH_SESSION_ID Stop hook Claude uses to auto-report, so
  // this is the server's reliable signal to report a crew worker's result back
  // to the orchestrator without depending on a call inside the codex process.
  onTurnComplete?: (ev: { message: string }) => void;
  // Fired once per actual turn start (legacy `task_started` / raw v2
  // `turn/started`) - never from approval resolution or other status churn,
  // which also transition to `running` mid-turn. This is the only signal the
  // launcher accepts to recover a blocked task back to working.
  onTurnStarted?: () => void;
  onUsageLimit?: (limit: UsageLimit) => void;
  clientName?: string;
};

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  epoch: number;
};

const REQUEST_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const ABORT_GRACE_MS = 3_000;
const FORCE_KILL_MS = 2_000;
const MODEL_LIST_TIMEOUT_MS = 5_000;

function requestKey(id: string | number): string {
  return `${typeof id}:${id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decisionList(value: unknown, fallback: string[]): PendingServerRequest["decisions"] {
  const ids = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : fallback;
  const labels: Record<string, string> = {
    accept: "Allow",
    acceptForSession: "Allow for session",
    decline: "Deny",
    cancel: "Cancel",
    allow_turn: "Allow this turn",
    allow_session: "Allow for session",
    deny: "Deny"
  };
  return ids.map((id) => ({
    id,
    label: labels[id] ?? id,
    ...(id === "decline" || id === "deny" || id === "cancel" ? { destructive: true } : {}),
    ...(id === "acceptForSession" || id === "allow_session" ? { persistence: "session" as const } : {})
  }));
}

function persistenceAdvertises(value: unknown, choice: "session" | "always"): boolean {
  return value === choice || (Array.isArray(value) && value.includes(choice));
}
// Min gap between streamed assistant-delta frames. Intermediate deltas inside
// the window are coalesced (each frame carries the full accumulated text, so
// nothing is lost); the `done` frame always flushes immediately.
const STREAM_COALESCE_MS = 33;

// Default transport: a stdio `codex app-server` child. Env-scrubbed of the
// noisy rollout-list logging, matching happy.
function defaultSpawn(command: string, args: string[]): SpawnTransport {
  return () => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") env[key] = value;
    }
    const filter = "codex_core::rollout::list=off";
    if (!env.RUST_LOG) env.RUST_LOG = filter;
    else if (!env.RUST_LOG.includes("codex_core::rollout::list=")) env.RUST_LOG += `,${filter}`;

    const child = childSpawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      windowsHide: true
    });
    return {
      get stdin() {
        return child.stdin as Writable;
      },
      get stdout() {
        return child.stdout as Readable;
      },
      get stderr() {
        return child.stderr;
      },
      get pid() {
        return child.pid;
      },
      onExit(callback) {
        child.on("exit", callback);
        child.on("error", () => callback(null, null));
      },
      kill(signal) {
        child.kill(signal);
      }
    };
  };
}

export class CodexAppServerClient {
  private readonly sessionId: string;
  private readonly spawnTransport: SpawnTransport;
  private readonly onTimelineItem?: (item: TimelineItem) => void;
  private readonly onStatus?: (status: AgentSessionStatus) => void;
  private readonly approvalHandler?: CodexApprovalHandler;
  private readonly onServerRequest?: (request: PendingServerRequest) => void;
  private readonly onServerRequestResolved?: (request: PendingServerRequest) => void;
  private readonly onThreadStarted?: (threadId: string) => void;
  private readonly onAssistantStream?: (ev: { itemId: string; text: string; done: boolean }) => void;
  private readonly onTurnComplete?: (ev: { message: string }) => void;
  private readonly onTurnStarted?: () => void;
  private readonly onUsageLimit?: (limit: UsageLimit) => void;
  private readonly clientName: string;

  private transport: CodexTransport | null = null;
  private readline: ReadlineInterface | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private readonly pendingServerRequests = new Map<string, PendingServerRequest>();
  private processEpoch = 0;
  private connected = false;

  private _threadId: string | null = null;
  private _turnId: string | null = null;
  private threadDefaults: {
    model?: string;
    cwd?: string;
    approvalPolicy?: ApprovalPolicy;
    sandbox?: SandboxMode;
  } | null = null;

  // A model/effort override applied to the next turn/start, then cleared. This
  // is the per-turn model-chip mechanism: set it, and the next submitted turn
  // (and subsequent turns, per the protocol) runs on that model. NEVER stores
  // an empty model - the field is omitted, not blanked.
  private pendingModelOverride: { model?: string; effort?: ReasoningEffort } = {};

  // Turn-completion tracking for an in-flight submitTurnAndWait. A completion
  // notification only resolves once the turn ids match (or no id is known).
  private pendingTurnCompletion: { resolve: (aborted: boolean) => void; turnId: string | null } | null = null;
  private pendingInterrupt: Promise<void> | null = null;
  private notificationProtocol: "unknown" | "legacy" | "raw" = "unknown";
  private completedTurnIds = new Set<string>();
  // Raw turn/item traffic observed since the last reported completion. A
  // daemon-driven TUI turn can settle with only a thread/status/changed idle
  // (the daemon never broadcasts turn/completed to a client that did not
  // submit the turn); this flag makes that idle a completion boundary while
  // an initial idle attach with no observed progress stays silent.
  private observedTurnActivity = false;
  private seqCounter = 0;
  private status: AgentSessionStatus = "idle";

  // Live assistant-message streaming state (see onAssistantStream). Codex sends
  // per-token deltas; we accumulate them per itemId and throttle the emitted
  // frames so a fast turn does not flood the socket, always flushing the final
  // `done` frame with the full text.
  private streamItemId: string | null = null;
  private streamText = "";
  private lastStreamEmitAt = 0;

  // The final assistant message of the in-flight turn, captured as the message
  // settles, then handed to onTurnComplete when the turn completes and cleared.
  // Reset at each turn start so a stale message can never be reported.
  private lastAssistantMessage = "";

  constructor(options: CodexAppServerOptions) {
    this.sessionId = options.sessionId;
    this.spawnTransport = options.spawn ?? defaultSpawn("codex", ["app-server", "--listen", "stdio://"]);
    this.onTimelineItem = options.onTimelineItem;
    this.onStatus = options.onStatus;
    this.approvalHandler = options.approvalHandler;
    this.onServerRequest = options.onServerRequest;
    this.onServerRequestResolved = options.onServerRequestResolved;
    this.onThreadStarted = options.onThreadStarted;
    this.onAssistantStream = options.onAssistantStream;
    this.onTurnComplete = options.onTurnComplete;
    this.onTurnStarted = options.onTurnStarted;
    this.onUsageLimit = options.onUsageLimit;
    this.clientName = options.clientName ?? "perch";
  }

  get threadId(): string | null {
    return this._threadId;
  }

  get turnId(): string | null {
    return this._turnId;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.connected) return;

    const epoch = ++this.processEpoch;
    const transport = this.spawnTransport();
    this.transport = transport;

    transport.onExit((code) => {
      if (this.transport !== transport || this.processEpoch !== epoch) return;
      this.connected = false;
      for (const [id, req] of this.pending) {
        if (req.epoch !== epoch) continue;
        req.reject(new Error(`Codex process exited (code=${code}) while waiting for ${req.method}`));
        this.pending.delete(id);
      }
      this.clearPendingServerRequests();
      this.resolvePendingTurn(true);
    });

    transport.stderr?.on("data", () => {
      /* stderr is debug-only; swallow to avoid noise in the server log */
    });

    this.readline = createInterface({ input: transport.stdout });
    this.readline.on("line", (line) => {
      if (this.transport !== transport || this.processEpoch !== epoch) return;
      this.handleLine(line, epoch);
    });

    await this.request("initialize", {
      clientInfo: { name: this.clientName, title: "Perch Codex Control", version: "1" },
      capabilities: { experimentalApi: true }
    });
    this.notify("initialized");
    this.connected = true;
  }

  private async disconnectInternal(opts?: { preserveThreadState?: boolean }): Promise<void> {
    if (!this.connected && !this.transport) return;
    const transport = this.transport;
    const epoch = this.processEpoch;

    this.readline?.close();
    this.readline = null;

    try {
      transport?.stdin.end();
      transport?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    const pid = transport?.pid;
    if (pid) {
      const killTimer = setTimeout(() => {
        try {
          process.kill(pid, 0);
          process.kill(pid, "SIGKILL");
        } catch {
          /* already dead */
        }
      }, FORCE_KILL_MS);
      killTimer.unref();
    }

    this.transport = null;
    this.connected = false;
    this._turnId = null;
    this.observedTurnActivity = false;
    this.notificationProtocol = "unknown";
    this.completedTurnIds.clear();
    if (!opts?.preserveThreadState) {
      this._threadId = null;
      this.threadDefaults = null;
    }

    for (const [id, req] of this.pending) {
      if (req.epoch !== epoch) continue;
      req.reject(new Error(`Codex process disconnected while waiting for ${req.method}`));
      this.pending.delete(id);
    }
    this.clearPendingServerRequests();
    this.resolvePendingTurn(true);
  }

  async disconnect(): Promise<void> {
    await this.disconnectInternal();
  }

  // ─── Thread management ──────────────────────────────────────

  async startThread(opts?: {
    model?: string;
    cwd?: string;
    approvalPolicy?: ApprovalPolicy;
    sandbox?: SandboxMode;
  }): Promise<{ threadId: string; model: string }> {
    const params: NewConversationParams = {
      model: opts?.model ?? null,
      cwd: opts?.cwd ?? process.cwd(),
      approvalPolicy: opts?.approvalPolicy ?? null,
      sandbox: opts?.sandbox ?? null,
      config: null,
      persistExtendedHistory: true
    };
    const result = (await this.request("thread/start", params)) as ThreadResult;
    this._threadId = result.thread.id;
    this._turnId = null;
    this.observedTurnActivity = false;
    this.threadDefaults = { ...opts };
    return { threadId: result.thread.id, model: result.model };
  }

  // Rejoin an existing thread (the daemon/`--remote` case: the TUI already owns
  // the thread; the control client thread/resume-rejoins to steer it).
  async resumeThread(opts: {
    threadId?: string;
    model?: string;
    cwd?: string;
    approvalPolicy?: ApprovalPolicy;
    sandbox?: SandboxMode;
  }): Promise<{ threadId: string; model: string }> {
    const threadId = opts.threadId ?? this._threadId;
    if (!threadId) throw new Error("No thread available to resume.");
    const defaults = this.threadDefaults ?? {};
    const params: ResumeConversationParams = {
      threadId,
      model: opts.model ?? defaults.model ?? null,
      cwd: opts.cwd ?? defaults.cwd ?? process.cwd(),
      approvalPolicy: opts.approvalPolicy ?? defaults.approvalPolicy ?? null,
      sandbox: opts.sandbox ?? defaults.sandbox ?? null,
      persistExtendedHistory: true
    };
    const result = (await this.request("thread/resume", params)) as ThreadResult;
    this._threadId = result.thread.id;
    this._turnId = null;
    this.observedTurnActivity = false;
    this.threadDefaults = {
      model: opts.model ?? defaults.model,
      cwd: opts.cwd ?? defaults.cwd,
      approvalPolicy: opts.approvalPolicy ?? defaults.approvalPolicy,
      sandbox: opts.sandbox ?? defaults.sandbox
    };
    return { threadId: result.thread.id, model: result.model };
  }

  private async reconnectAndResumeThread(): Promise<boolean> {
    const threadId = this._threadId;
    await this.disconnectInternal({ preserveThreadState: !!threadId });
    await this.connect();
    if (!threadId) return false;
    try {
      await this.resumeThread({ threadId });
      return true;
    } catch {
      this._threadId = null;
      this.threadDefaults = null;
      return false;
    }
  }

  // List the model catalog (`model/list`) - populates the phone's model chip.
  async listModels(): Promise<unknown> {
    return this.request("model/list", {});
  }

  // ─── Model chip ─────────────────────────────────────────────

  // Remember a model/effort override for the next submitted turn. An empty or
  // whitespace model is dropped (never sent as ""), so calling this to "clear"
  // is a no-op that leaves the thread on its current model.
  setModelForNextTurn(model?: string, effort?: ReasoningEffort): void {
    const trimmed = model?.trim();
    if (trimmed) {
      assertLocalRuntimeModelId(trimmed);
      this.pendingModelOverride.model = trimmed;
    }
    if (effort) this.pendingModelOverride.effort = effort;
  }

  // ─── Turn management ────────────────────────────────────────

  // Submit a user turn. Optional model/effort fold in here so the model chip is
  // a single round trip (assessment's preferred shape). Returns the turn id;
  // completion arrives asynchronously via notifications.
  async submitTurn(
    text: string,
    opts?: { model?: string; effort?: ReasoningEffort; source?: "human" | "agent" }
  ): Promise<{ turnId: string | null }> {
    if (!this._threadId) throw new Error("No active thread. Call startThread or resumeThread first.");

    const input: InputItem[] = [{ type: "text", text }];
    const params: TurnStartParams = { threadId: this._threadId, input };

    // Merge the standing override with per-call opts (per-call wins). An empty
    // model string is an error on the wire, so only set it when non-empty.
    const model = opts?.model?.trim() || this.pendingModelOverride.model;
    const effort = opts?.effort ?? this.pendingModelOverride.effort;
    if (model) {
      assertLocalRuntimeModelId(model);
      params.model = model;
    }
    if (effort) params.effort = effort;
    this.pendingModelOverride = {};

    // Echo the user turn into the timeline immediately (the protocol may not
    // reflect it back promptly). Mirrors perch's human/agent provenance.
    if (text.length > 0) {
      this.emitTimelineItem("user", text, undefined, opts?.source ?? "human");
    }

    const result = (await this.request("turn/start", params)) as { turn?: { id?: string | null } };
    const turnId = typeof result?.turn?.id === "string" ? result.turn.id : null;
    if (turnId) {
      this._turnId = turnId;
      if (this.pendingTurnCompletion) this.pendingTurnCompletion.turnId = turnId;
    }
    return { turnId };
  }

  // Submit and wait for the turn to settle (task_complete / turn_aborted).
  async submitTurnAndWait(
    text: string,
    opts?: { model?: string; effort?: ReasoningEffort; source?: "human" | "agent"; turnTimeoutMs?: number }
  ): Promise<{ aborted: boolean }> {
    // Let any in-flight interrupt settle first so a stale turn/interrupt cannot
    // abort the turn we are about to start.
    if (this.pendingInterrupt) {
      await this.pendingInterrupt;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const timeoutMs = opts?.turnTimeoutMs ?? TURN_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const completion = new Promise<boolean>((resolve) => {
      this.pendingTurnCompletion = { resolve, turnId: null };
      timer = setTimeout(() => {
        if (this.pendingTurnCompletion) this.resolvePendingTurn(true);
      }, timeoutMs);
    });

    try {
      await this.submitTurn(text, opts);
    } catch (err) {
      if (timer) clearTimeout(timer);
      this.pendingTurnCompletion = null;
      throw err;
    }

    const aborted = await completion;
    if (timer) clearTimeout(timer);
    return { aborted };
  }

  // Request interruption; if the turn does not settle within the grace period,
  // force-restart the app-server and resume the thread (happy's fallback).
  async interrupt(opts?: { gracePeriodMs?: number; forceRestartOnTimeout?: boolean }): Promise<{
    hadActiveTurn: boolean;
    aborted: boolean;
    forcedRestart: boolean;
    resumedThread: boolean;
  }> {
    const hadActiveTurn = this.pendingTurnCompletion !== null || this._turnId !== null;
    if (!hadActiveTurn) {
      return { hadActiveTurn: false, aborted: false, forcedRestart: false, resumedThread: false };
    }

    await this.sendInterrupt();

    const grace = opts?.gracePeriodMs ?? ABORT_GRACE_MS;
    const settled = await this.waitForTurnCompletion(grace);
    if (settled) {
      return { hadActiveTurn: true, aborted: true, forcedRestart: false, resumedThread: false };
    }
    if (opts?.forceRestartOnTimeout === false) {
      return { hadActiveTurn: true, aborted: false, forcedRestart: false, resumedThread: false };
    }

    if (this.pendingTurnCompletion) this.resolvePendingTurn(true);
    this.setStatus("idle");
    const resumedThread = await this.reconnectAndResumeThread();
    return { hadActiveTurn: true, aborted: true, forcedRestart: true, resumedThread };
  }

  private async sendInterrupt(): Promise<void> {
    if (!this._threadId || !this._turnId) return;
    const params: InterruptConversationParams = { threadId: this._threadId, turnId: this._turnId };
    const doInterrupt = async () => {
      try {
        await this.request("turn/interrupt", params);
      } catch {
        /* no active turn - expected */
      } finally {
        this.pendingInterrupt = null;
      }
    };
    this.pendingInterrupt = doInterrupt();
    return this.pendingInterrupt;
  }

  private async waitForTurnCompletion(timeoutMs: number): Promise<boolean> {
    if (!this.pendingTurnCompletion) return true;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this.pendingTurnCompletion) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return true;
  }

  private resolvePendingTurn(aborted: boolean): void {
    if (!this.pendingTurnCompletion) return;
    this.pendingTurnCompletion.resolve(aborted);
    this.pendingTurnCompletion = null;
  }

  private markPendingTurnStarted(turnId?: string | null): void {
    if (this.pendingTurnCompletion && turnId) this.pendingTurnCompletion.turnId = turnId;
  }

  // Guard against a completion notification from a *different* turn. Uses turn-id
  // matching (not a started flag) because fast turns can skip task_started.
  private tryResolvePendingTurn(aborted: boolean, turnId: string | null): void {
    const pending = this.pendingTurnCompletion;
    if (!pending) return;
    if (pending.turnId && turnId && pending.turnId !== turnId) return;
    this.resolvePendingTurn(aborted);
  }

  // ─── JSON-RPC transport ─────────────────────────────────────

  private request(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.transport?.stdin.writable) {
        reject(new Error(`Cannot send ${method}: stdin not writable`));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms (id=${id})`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        method,
        epoch: this.processEpoch
      });
      const msg: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
      this.transport.stdin.write(JSON.stringify(msg) + "\n");
    });
  }

  private notify(method: string, params?: unknown): void {
    if (!this.transport?.stdin.writable) return;
    const msg: JsonRpcMessage = { jsonrpc: "2.0", method, params };
    this.transport.stdin.write(JSON.stringify(msg) + "\n");
  }

  private respond(id: string | number, result: unknown): void {
    if (!this.transport?.stdin.writable) return;
    const msg: JsonRpcMessage = { jsonrpc: "2.0", id, result };
    this.transport.stdin.write(JSON.stringify(msg) + "\n");
  }

  private handleLine(line: string, sourceEpoch: number): void {
    if (sourceEpoch !== this.processEpoch || !line.trim()) return;

    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }

    // Response to one of our requests.
    if (typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending || pending.epoch !== sourceEpoch) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const limit = usageLimitFromCodexAppServer(msg.error);
        if (limit) this.onUsageLimit?.(limit);
        pending.reject(new Error(`${pending.method}: ${msg.error.message} (code=${msg.error.code})`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Server->client request (approvals).
    if (msg.id != null && msg.method) {
      void this.handleServerRequest(msg.id, msg.method, (msg.params ?? {}) as Record<string, unknown>);
      return;
    }

    // Notification.
    if (msg.method) {
      this.handleNotification(msg.method, (msg.params ?? {}) as Record<string, unknown>);
    }
  }

  // ─── Approvals (server->client) ─────────────────────────────

  // v2 item/* methods use accept/acceptForSession/decline/cancel; the legacy
  // exec/patch methods use approved/approved_for_session/denied/abort.
  private mapDecisionToWire(decision: ReviewDecision, legacy: boolean): string {
    if (legacy) return decision === "approved_for_session" ? "approved_for_session" : decision;
    switch (decision) {
      case "approved":
        return "accept";
      case "approved_for_session":
        return "acceptForSession";
      case "denied":
        return "decline";
      case "abort":
        return "cancel";
      default:
        return "decline";
    }
  }

  private async handleServerRequest(id: string | number, method: string, params: Record<string, unknown>): Promise<void> {
    const structured = this.normalizeServerRequest(id, method, params);
    if (structured && this.onServerRequest) {
      const key = requestKey(id);
      if (this.pendingServerRequests.has(key)) return;
      this.pendingServerRequests.set(key, structured);
      this.setStatus("needs_approval");
      this.onServerRequest(structured);
      return;
    }

    // Compatibility for direct client consumers. Production always installs
    // onServerRequest and never defaults a real approval to decline.
    if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
      const legacy = method === "execCommandApproval";
      const callId = String(params.itemId ?? params.callId ?? id);
      const command = this.stringifyCommand(params.command);
      const decision = await this.dispatchApproval({
        kind: "exec",
        callId,
        summary: command ? `Run: ${command}` : "Run a command",
        command,
        cwd: typeof params.cwd === "string" ? params.cwd : undefined,
        reason: typeof params.reason === "string" ? params.reason : null
      });
      this.respond(id, { decision: this.mapDecisionToWire(decision, legacy) });
      return;
    }

    if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
      const legacy = method === "applyPatchApproval";
      const callId = String(params.itemId ?? params.callId ?? id);
      const decision = await this.dispatchApproval({
        kind: "patch",
        callId,
        summary: "Apply file changes",
        reason: typeof params.reason === "string" ? params.reason : null
      });
      this.respond(id, { decision: this.mapDecisionToWire(decision, legacy) });
      return;
    }

    if (method === "mcpServer/elicitation/request") {
      const decision = await this.dispatchApproval({
        kind: "mcp",
        callId: `mcp:${id}`,
        summary: typeof params.message === "string" ? params.message : "MCP tool request"
      });
      const action = decision === "approved" || decision === "approved_for_session" ? "accept" : decision === "abort" ? "cancel" : "decline";
      this.respond(id, { action, content: null, _meta: null });
      return;
    }

    // Unknown server request - respond so codex does not hang.
    this.respond(id, {});
  }

  respondToServerRequest(
    requestId: string | number,
    decision?: string,
    content?: Record<string, unknown>
  ): boolean {
    const pending = this.pendingServerRequests.get(requestKey(requestId));
    if (!pending) return false;
    const result = this.serverRequestResult(pending, decision, content);
    if (!result) return false;
    this.respond(requestId, result);
    return true;
  }

  private normalizeServerRequest(
    requestId: string | number,
    method: string,
    params: Record<string, unknown>
  ): PendingServerRequest | undefined {
    const threadId = typeof params.threadId === "string" ? params.threadId : this._threadId;
    if (!threadId) return undefined;
    const turnId = typeof params.turnId === "string" ? params.turnId : null;
    const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
    const at = new Date().toISOString();
    const base = { requestId, threadId, turnId, ...(itemId ? { itemId } : {}), content: params, at };

    if (method === "item/commandExecution/requestApproval") {
      const command = this.stringifyCommand(params.command);
      return {
        ...base,
        ...(typeof params.approvalId === "string" ? { callId: params.approvalId } : itemId ? { callId: itemId } : {}),
        family: "command_execution",
        summary: typeof params.reason === "string" ? params.reason : command ? `Run: ${command}` : "Run a command",
        decisions: decisionList(params.availableDecisions, ["accept", "acceptForSession", "decline", "cancel"]),
        persistence: { source: Array.isArray(params.availableDecisions) ? "advertised" : "schema", session: true }
      };
    }
    if (method === "item/fileChange/requestApproval") {
      return {
        ...base,
        family: "file_change",
        summary: typeof params.reason === "string" ? params.reason : "Apply file changes",
        decisions: decisionList(params.availableDecisions, ["accept", "acceptForSession", "decline", "cancel"]),
        persistence: { source: Array.isArray(params.availableDecisions) ? "advertised" : "schema", session: true }
      };
    }
    if (method === "item/permissions/requestApproval") {
      return {
        ...base,
        family: "permissions",
        summary: typeof params.reason === "string" ? params.reason : "Grant additional permissions",
        decisions: decisionList(undefined, ["allow_turn", "allow_session", "deny"]),
        persistence: { source: "schema", session: true }
      };
    }
    if (method === "mcpServer/elicitation/request") {
      const metadata = isRecord(params._meta) ? params._meta : isRecord(params.meta) ? params.meta : undefined;
      return {
        ...base,
        ...(typeof params.serverName === "string" ? { callId: params.serverName } : {}),
        family: "mcp_elicitation",
        summary: typeof params.message === "string" ? params.message : "MCP server needs input",
        decisions: decisionList(undefined, ["accept", "decline", "cancel"]),
        ...(metadata
          ? {
              persistence: {
                source: "advertised" as const,
                session: metadata.persist === true || persistenceAdvertises(metadata.persist, "session"),
                always: persistenceAdvertises(metadata.persist, "always"),
                metadata
              }
            }
          : {})
      };
    }
    if (method === "item/tool/requestUserInput") {
      return {
        ...base,
        family: "request_user_input",
        summary: "Codex needs your input",
        decisions: []
      };
    }
    return undefined;
  }

  private serverRequestResult(
    pending: PendingServerRequest,
    decision?: string,
    content?: Record<string, unknown>
  ): Record<string, unknown> | undefined {
    if (pending.family === "request_user_input") {
      return isRecord(content?.answers) ? { answers: content.answers } : undefined;
    }
    if (!decision || !pending.decisions.some((entry) => entry.id === decision)) return undefined;
    if (pending.family === "permissions") {
      const requested = isRecord(pending.content.permissions) ? pending.content.permissions : {};
      return {
        permissions: decision === "deny" ? {} : requested,
        scope: decision === "allow_session" ? "session" : "turn"
      };
    }
    if (pending.family === "mcp_elicitation") {
      return {
        action: decision,
        content: decision === "accept" ? (content ?? null) : null,
        _meta: null
      };
    }
    return { decision };
  }

  private resolveStructuredServerRequest(requestId: string | number, threadId?: string): void {
    const key = requestKey(requestId);
    const pending = this.pendingServerRequests.get(key);
    if (!pending || (threadId && pending.threadId !== threadId)) return;
    this.pendingServerRequests.delete(key);
    this.onServerRequestResolved?.(pending);
    if (this.pendingServerRequests.size === 0) {
      this.setStatus(this._turnId ? "running" : "idle");
    }
  }

  private clearPendingServerRequests(): void {
    for (const pending of this.pendingServerRequests.values()) {
      this.onServerRequestResolved?.(pending);
    }
    this.pendingServerRequests.clear();
  }

  private async dispatchApproval(request: CodexApprovalRequest): Promise<ReviewDecision> {
    this.setStatus("needs_approval");
    let decision: ReviewDecision = "denied";
    if (this.approvalHandler) {
      try {
        decision = await this.approvalHandler(request);
      } catch {
        decision = "denied";
      }
    }
    // Return to running if a turn is still active, else idle.
    this.setStatus(this._turnId ? "running" : "idle");
    return decision;
  }

  private stringifyCommand(command: unknown): string | undefined {
    if (typeof command === "string") return command;
    if (Array.isArray(command)) return command.map((part) => String(part)).join(" ");
    return undefined;
  }

  // ─── Notifications (both protocols) ─────────────────────────

  private handleNotification(method: string, params: Record<string, unknown>): void {
    const limit = usageLimitFromCodexAppServer({ type: method, ...params });
    if (limit) this.onUsageLimit?.(limit);
    // Legacy: `codex/event` or `codex/event/<type>` carrying { msg }.
    if (method === "codex/event" || method.startsWith("codex/event/")) {
      this.notificationProtocol = "legacy";
      const msg = params.msg as Record<string, unknown> | undefined;
      if (!msg) return;
      this.handleLegacyEvent(msg);
      return;
    }

    if (this.handleRawNotification(method, params)) return;
  }

  private handleLegacyEvent(msg: Record<string, unknown>): void {
    const type = typeof msg.type === "string" ? msg.type : "";
    const turnId = (typeof msg.turn_id === "string" ? msg.turn_id : (msg.turnId as string | undefined)) ?? null;

    if (type === "task_started") {
      if (turnId) this._turnId = turnId;
      this.lastAssistantMessage = "";
      this.markPendingTurnStarted(turnId);
      this.onTurnStarted?.();
      this.setStatus("running");
      return;
    }
    if (type === "agent_message_delta") {
      const delta = typeof msg.delta === "string" ? msg.delta : "";
      const itemId = (typeof msg.item_id === "string" ? msg.item_id : (msg.itemId as string | undefined)) ?? this.streamItemId ?? "stream";
      this.appendAssistantStream(itemId, delta);
      return;
    }
    if (type === "agent_message") {
      const message = typeof msg.message === "string" ? msg.message : "";
      // The full message is the authoritative flush for any live preview.
      this.finishAssistantStream(undefined, message);
      if (message) {
        this.lastAssistantMessage = message;
        this.emitTimelineItem("assistant", message);
      }
      return;
    }
    if (type === "exec_command_begin") {
      this.emitTimelineItem("tool_call", undefined, {
        name: "shell",
        input: this.stringifyCommand(msg.command)
      });
      return;
    }
    if (type === "exec_command_end") {
      const output = typeof msg.output === "string" ? msg.output : "";
      this.emitTimelineItem("tool_result", output);
      return;
    }
    if (type === "task_complete" || type === "turn_aborted") {
      this.finishAssistantStream();
      const aborted = type === "turn_aborted";
      this.emitRawTurnCompletion(turnId, aborted ? "aborted" : "completed");
    }
  }

  // Raw v2 notifications: thread/*, turn/*, item/*. Returns true if handled.
  private handleRawNotification(method: string, params: Record<string, unknown>): boolean {
    const isRaw =
      method === "thread/started" ||
      method === "turn/started" ||
      method === "turn/completed" ||
      method === "thread/status/changed" ||
      method === "serverRequest/resolved" ||
      method.startsWith("item/");
    if (!isRaw) return false;
    if (this.notificationProtocol === "legacy") return false;
    if (this.notificationProtocol === "unknown") this.notificationProtocol = "raw";

    // Any turn or item traffic is observed turn progress; it arms the
    // thread/status/changed idle handler below to report a completion even
    // when the daemon never sends turn/completed for a TUI-driven turn.
    if (method === "turn/started" || method.startsWith("item/")) {
      this.observedTurnActivity = true;
    }

    if (method === "thread/started") {
      // The daemon broadcasts this when the `--remote` TUI opens its thread.
      // Adopt it if we do not already own one, so the control plane can resume
      // and steer the shared thread (e.g. per-turn model override).
      const threadId = this.extractThreadId(params);
      if (threadId) {
        if (!this._threadId) this._threadId = threadId;
        this.onThreadStarted?.(threadId);
      }
      return true;
    }

    if (method === "serverRequest/resolved") {
      const requestId = params.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        this.resolveStructuredServerRequest(
          requestId,
          typeof params.threadId === "string" ? params.threadId : undefined
        );
      }
      return true;
    }

    if (method === "turn/started") {
      const turnId = this.extractTurnId(params);
      if (turnId) this._turnId = turnId;
      this.lastAssistantMessage = "";
      this.markPendingTurnStarted(turnId);
      this.onTurnStarted?.();
      this.setStatus("running");
      return true;
    }

    // Live assistant text: each delta carries an incremental chunk plus the
    // itemId of the message being built. Accumulate and stream (never persisted
    // to the rollout, so this is the phone's only live view of the reply).
    if (method === "item/agentMessage/delta") {
      const itemId = typeof params.itemId === "string" ? params.itemId : this.streamItemId ?? "stream";
      const delta = typeof params.delta === "string" ? params.delta : "";
      this.appendAssistantStream(itemId, delta);
      return true;
    }

    if (method === "turn/completed") {
      this.finishAssistantStream();
      this.emitRawTurnCompletion(this.extractTurnId(params), this.extractTurnStatus(params));
      return true;
    }

    if (method === "thread/status/changed") {
      const statusType = (params.status as Record<string, unknown> | undefined)?.type;
      if (statusType === "idle" && (this.pendingTurnCompletion || this.observedTurnActivity)) {
        // With a locally pending RPC turn OR observed remote turn progress,
        // this idle transition is the turn's completion boundary: report it
        // so onTurnComplete (and the task-completion reconciler behind it)
        // fires even though no turn/completed was broadcast to this client.
        this.emitRawTurnCompletion(this._turnId, "completed");
      } else if (statusType === "idle") {
        // A bare idle with no observed turn progress (e.g. the initial
        // attach to a daemon-owned thread) is not a completed turn. It is
        // still authoritative fleet state and must clear the active badge.
        this._turnId = null;
        this.setStatus("idle");
      }
      return true;
    }

    const item = params.item as Record<string, unknown> | undefined;
    if (!item || typeof item !== "object") return method.startsWith("item/");

    const itemType = typeof item.type === "string" ? item.type : "";

    if (method === "item/started" && itemType === "commandExecution") {
      this.emitTimelineItem("tool_call", undefined, {
        name: "shell",
        input: this.stringifyCommand(item.command)
      });
      return true;
    }
    if (method === "item/completed" && itemType === "commandExecution") {
      const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
      this.emitTimelineItem("tool_result", output);
      return true;
    }
    if (itemType === "fileChange" && method === "item/started") {
      this.emitTimelineItem("tool_call", undefined, { name: "apply_patch" });
      return true;
    }
    if (itemType === "fileChange" && method === "item/completed") {
      const status = typeof item.status === "string" ? item.status : "completed";
      this.emitTimelineItem("tool_result", `File change ${status}`);
      return true;
    }
    if (method === "item/completed" && itemType === "agentMessage") {
      const text = typeof item.text === "string" ? item.text : "";
      const itemId = typeof item.id === "string" ? item.id : this.streamItemId;
      // Flush the live preview with the authoritative full text and mark it
      // done, so the phone renders the complete reply the instant the message
      // settles (the transcript tailer then persists the same text).
      this.finishAssistantStream(itemId ?? undefined, text);
      if (text.length > 0) {
        this.lastAssistantMessage = text;
        this.emitTimelineItem("assistant", text);
      }
      if (item.phase === "final_answer" && this.pendingTurnCompletion) {
        this.emitRawTurnCompletion(this.extractTurnId(params), "completed");
      }
      return true;
    }

    return method.startsWith("item/");
  }

  private emitRawTurnCompletion(turnId: string | null, status: string | null): void {
    const activeTurnId = this._turnId ?? this.pendingTurnCompletion?.turnId;
    if (turnId && activeTurnId && turnId !== activeTurnId) return;
    this.observedTurnActivity = false;
    const aborted = status === "cancelled" || status === "canceled" || status === "aborted" || status === "interrupted";
    // A turn can settle via more than one raw notification (turn/completed,
    // thread/status idle, a final_answer item); report it exactly once.
    const firstCompletion = !turnId || !this.completedTurnIds.has(turnId);
    this.tryResolvePendingTurn(aborted, turnId);
    this._turnId = null;
    this.setStatus("idle");
    if (!firstCompletion) return;
    if (turnId) this.completedTurnIds.add(turnId);
    this.fireTurnComplete(aborted);
  }

  // Hand the turn's final assistant message to onTurnComplete once, then clear
  // it so a later completion (same turn, or the next) can never reuse it.
  // Successful turns still report when the message is empty because provider
  // completion, not assistant prose, is the authoritative lifecycle boundary.
  private fireTurnComplete(aborted: boolean): void {
    const message = this.lastAssistantMessage;
    this.lastAssistantMessage = "";
    if (aborted) return;
    this.onTurnComplete?.({ message });
  }

  private extractTurnId(params: Record<string, unknown>): string | null {
    const turn = params.turn as Record<string, unknown> | undefined;
    const id = turn?.id ?? params.turnId ?? params.turn_id;
    return typeof id === "string" && id.length > 0 ? id : null;
  }

  private extractThreadId(params: Record<string, unknown>): string | null {
    const thread = params.thread as Record<string, unknown> | undefined;
    const id = thread?.id ?? params.threadId ?? params.thread_id;
    return typeof id === "string" && id.length > 0 ? id : null;
  }

  private extractTurnStatus(params: Record<string, unknown>): string | null {
    const turn = params.turn as Record<string, unknown> | undefined;
    const status = turn?.status ?? params.status;
    return typeof status === "string" && status.length > 0 ? status : null;
  }

  // ─── Assistant streaming ────────────────────────────────────

  // Accumulate an incremental assistant-text chunk and emit a throttled live
  // frame. A change of itemId starts a fresh message (resets the buffer).
  private appendAssistantStream(itemId: string, delta: string): void {
    if (!this.onAssistantStream) return;
    if (itemId !== this.streamItemId) {
      this.streamItemId = itemId;
      this.streamText = "";
      this.lastStreamEmitAt = 0;
    }
    if (delta) this.streamText += delta;
    const now = Date.now();
    if (now - this.lastStreamEmitAt < STREAM_COALESCE_MS) return;
    this.lastStreamEmitAt = now;
    this.onAssistantStream({ itemId, text: this.streamText, done: false });
  }

  // Flush the final frame for the current message and clear the buffer. When a
  // finished text is known (the authoritative full message), it replaces the
  // accumulated deltas so the phone always ends on the complete reply. Idempotent:
  // a second call with nothing buffered is a no-op.
  private finishAssistantStream(itemId?: string, finalText?: string): void {
    if (!this.onAssistantStream) return;
    const id = itemId ?? this.streamItemId;
    if (!id) return;
    const text = finalText !== undefined && finalText.length > 0 ? finalText : this.streamText;
    this.streamItemId = null;
    this.streamText = "";
    this.lastStreamEmitAt = 0;
    if (text.length === 0) return;
    this.onAssistantStream({ itemId: id, text, done: true });
  }

  // ─── Emission helpers ───────────────────────────────────────

  private emitTimelineItem(
    kind: TimelineItemKind,
    text?: string,
    tool?: TimelineItem["tool"],
    source?: "human" | "agent"
  ): void {
    if (!this.onTimelineItem) return;
    const item: TimelineItem = {
      seq: ++this.seqCounter,
      id: `cx-${this.sessionId}-${this.seqCounter}`,
      sessionId: this.sessionId,
      kind,
      at: new Date().toISOString()
    };
    if (text !== undefined) item.text = text;
    if (tool) item.tool = tool;
    if (source) item.source = source;
    this.onTimelineItem(item);
  }

  private setStatus(status: AgentSessionStatus): void {
    if (this.pendingServerRequests.size > 0 && status !== "needs_approval") return;
    if (this.status === status) return;
    this.status = status;
    this.onStatus?.(status);
  }
}

export async function listCodexModelsOnce(timeoutMs = MODEL_LIST_TIMEOUT_MS): Promise<unknown> {
  const client = new CodexAppServerClient({
    sessionId: "model-registry",
    clientName: "perch-model-registry"
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      (async () => {
        await client.connect();
        return await client.listModels();
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out waiting for Codex model/list")), timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    await client.disconnect().catch(() => {});
  }
}
