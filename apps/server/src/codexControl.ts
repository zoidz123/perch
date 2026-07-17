// Codex control plane: the live wiring that turns the protocol engine
// (codexAppServer.ts) + daemon lifecycle (codexDaemon.ts) + WS transport
// (wsUnixTransport.ts) into a working `--remote` session.
//
// The topology for one Codex session launched through perch:
//   1. A perch-owned daemon `codex app-server --listen unix://<sock>` runs with
//      its cwd set to the session workdir (worktree isolation - `--remote`
//      turns inherit the DAEMON cwd).
//   2. The real TUI is spawned under perch's server-owned PTY as
//      `codex --remote unix://<sock>` (unchanged desktop-terminal attach story).
//   3. This control plane holds a WebSocket `/rpc` control client on the same
//      daemon, sharing the TUI's thread, used to drive the model chip and to
//      submit phone-composer turns over the protocol (no keystroke injection).
//
// Timeline items continue through rollout tailing, while app-server approvals
// and status flow through this control client. Everything degrades
// gracefully: if a daemon cannot be acquired, callers fall back to the plain
// PTY `codex` launch and the model chip is simply unavailable for that session.

import type {
  AgentSessionStatus,
  CodexReasoningEffort,
  PendingServerRequest,
  ServerRequestResponse
} from "@perch/shared";
import { CodexAppServerClient } from "./adapters/codexAppServer.js";
import { CodexDaemonManager, type CodexDaemonHandle } from "./adapters/codexDaemon.js";
import { websocketUnixTransport } from "./adapters/wsUnixTransport.js";
import { assertLocalRuntimeModelId } from "./modelSwitch.js";
import type { UsageLimit } from "./usageLimitDetect.js";

export type AssistantStreamEvent = { itemId: string; text: string; done: boolean };

export type CreateControlClient = (args: {
  sessionId: string;
  socketPath: string;
  // Fired when the daemon broadcasts the thread the `--remote` TUI established.
  onThreadStarted: (threadId: string) => void;
  // Live incremental assistant text for daemon-driven turns (both the desktop
  // TUI's and phone-composer turns share the daemon, so both stream here).
  onAssistantStream?: (ev: AssistantStreamEvent) => void;
  onStatus?: (status: AgentSessionStatus) => void;
  onServerRequest?: (request: PendingServerRequest) => void;
  onServerRequestResolved?: (request: PendingServerRequest) => void;
  // Fired once per completed (non-aborted) turn with its final assistant
  // message; the http layer uses it to report a crew worker's result to the
  // orchestrator without depending on any hook inside the codex process.
  onTurnComplete?: (ev: { message: string }) => void;
  // Fired once per actual turn start (never from approval resolution or other
  // mid-turn status churn) - the only signal allowed to recover a blocked task.
  onTurnStarted?: () => void;
  onUsageLimit?: (limit: UsageLimit) => void;
}) => CodexAppServerClient;

export type CodexControlOptions = {
  daemonManager?: CodexDaemonManager;
  // Injectable client factory for tests (defaults to a WS-over-unix client).
  createClient?: CreateControlClient;
  // Whether the `--remote` topology should be attempted at all. Defaults to on;
  // the http layer passes the codexDaemon driver selection through here.
  enabled?: boolean;
};

type ControlSession = {
  sessionId: string;
  cwd: string;
  socketPath: string;
  client: CodexAppServerClient;
  // The thread the `--remote` TUI established on the daemon, learned from the
  // daemon's `thread/started` broadcast. Only when this is known do we steer
  // the session over the protocol (else we would risk addressing a thread the
  // TUI is not showing).
  sharedThreadId: string | null;
  // Fired with the codex thread id the moment it is learned. The daemon runs
  // `--remote` turns in its own process (no PERCH_SESSION_ID), so the codex
  // hooks never fire and cannot correlate this session's rollout - the http
  // layer uses this to resolve the rollout from the thread id and attach the
  // timeline tailer, the sole channel by which daemon-driven turns reach the app.
  onSharedThread?: (threadId: string) => void;
};

export class CodexControlPlane {
  private readonly daemons: CodexDaemonManager;
  private readonly createClient: CreateControlClient;
  private readonly enabled: boolean;
  private readonly sessions = new Map<string, ControlSession>();
  // Daemon ownership by session id, recorded at acquisition (prepareRemote)
  // rather than attach: attach is best-effort, and a session whose control
  // attach failed still owns its daemon and must release it on exit.
  private readonly ownedDaemons = new Map<string, string>();

  constructor(options: CodexControlOptions = {}) {
    this.daemons = options.daemonManager ?? new CodexDaemonManager();
    this.enabled = options.enabled ?? true;
    this.createClient =
      options.createClient ??
      (({ sessionId, socketPath, onThreadStarted, onAssistantStream, onStatus, onServerRequest, onServerRequestResolved, onTurnComplete, onTurnStarted, onUsageLimit }) =>
        new CodexAppServerClient({
          sessionId,
          spawn: websocketUnixTransport({ socketPath }),
          onThreadStarted,
          onAssistantStream,
          onStatus,
          onServerRequest,
          onServerRequestResolved,
          onTurnComplete,
          onTurnStarted,
          onUsageLimit
        }));
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // Acquire (start or reuse) a daemon for the session workdir. Returns the
  // socket to point a `--remote` TUI at, or null if the daemon could not be
  // brought up (the caller then falls back to a plain PTY `codex` launch). A
  // launch-time `effort` bakes `model_reasoning_effort` into the daemon so every
  // `--remote` turn (including ones the desktop TUI starts) runs at that tier
  // instead of the model default.
  async prepareRemote(
    cwd: string,
    opts: { effort?: CodexReasoningEffort; env?: Record<string, string> } = {}
  ): Promise<CodexDaemonHandle | null> {
    if (!this.enabled) return null;
    const configOverrides = opts.effort
      ? [`model_reasoning_effort="${opts.effort}"`]
      : [];
    try {
      // `env` seeds the daemon process (which runs the agent's tool shells) with
      // the per-session hook wiring so the standard in-agent reporting curl has
      // an endpoint + token. Only applied when a daemon is freshly spawned; a
      // reused daemon keeps whatever env it started with.
      const handle = await this.daemons.acquire(cwd, { configOverrides, env: opts.env });
      const sessionId = opts.env?.PERCH_SESSION_ID;
      if (sessionId) this.ownedDaemons.set(sessionId, handle.socketPath);
      return handle;
    } catch {
      return null;
    }
  }

  // Retire orphaned daemons/sockets left under $PERCH_HOME/codex-daemons by a
  // previous, non-gracefully exited server run. Boot-time only.
  sweepOrphanDaemons(): void {
    this.daemons.sweepOrphans();
  }

  // Re-key daemon ownership when a session continues under a different id (the
  // adapter refused a pre-minted id): the `--remote` TUI stays dialed into the
  // daemon, so releasing under the old id would SIGTERM the live session's
  // backend - move ownership so the new id's exit releases it instead.
  transferDaemon(fromSessionId: string, toSessionId: string): void {
    const socketPath = this.ownedDaemons.get(fromSessionId);
    if (socketPath === undefined) return;
    this.ownedDaemons.delete(fromSessionId);
    this.ownedDaemons.set(toSessionId, socketPath);
  }

  // Attach a control client to a session that was spawned as `codex --remote`.
  // Best-effort: a failure here only forfeits the model chip, never the session.
  async attach(
    sessionId: string,
    args: {
      socketPath: string;
      cwd: string;
      onSharedThread?: (threadId: string) => void;
      onAssistantStream?: (ev: AssistantStreamEvent) => void;
      onStatus?: (status: AgentSessionStatus) => void;
      onServerRequest?: (request: PendingServerRequest) => void;
      onServerRequestResolved?: (request: PendingServerRequest) => void;
      onTurnComplete?: (ev: { message: string }) => void;
      onTurnStarted?: () => void;
      onUsageLimit?: (limit: UsageLimit) => void;
    }
  ): Promise<boolean> {
    if (this.sessions.has(sessionId)) return true;
    const session: ControlSession = {
      sessionId,
      cwd: args.cwd,
      socketPath: args.socketPath,
      client: null as unknown as CodexAppServerClient,
      sharedThreadId: null,
      onSharedThread: args.onSharedThread
    };
    const client = this.createClient({
      sessionId,
      socketPath: args.socketPath,
      onThreadStarted: (threadId) => {
        session.sharedThreadId = threadId;
        session.onSharedThread?.(threadId);
      },
      onAssistantStream: args.onAssistantStream,
      onStatus: args.onStatus,
      onServerRequest: args.onServerRequest,
      onServerRequestResolved: args.onServerRequestResolved,
      onTurnComplete: args.onTurnComplete,
      onTurnStarted: args.onTurnStarted,
      onUsageLimit: args.onUsageLimit
    });
    session.client = client;
    try {
      await client.connect();
      // A thread the client itself already knows (e.g. it started one) counts.
      if (!session.sharedThreadId && client.threadId) {
        session.sharedThreadId = client.threadId;
        session.onSharedThread?.(client.threadId);
      }
      this.sessions.set(sessionId, session);
      return true;
    } catch {
      await client.disconnect().catch(() => {});
      return false;
    }
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  // Explicit recovery verification: ask the same daemon that owns the fresh
  // TUI to resume the persisted thread. Only reachable when the recovered
  // session was attached with the remote topology; PTY-only recovery (the
  // current production path) has no control session here and returns
  // undefined, so the codex driver falls back to an out-of-band resume.
  async verifyResumedThread(sessionId: string, threadId: string): Promise<string | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const resumed = await session.client.resumeThread({ threadId, cwd: session.cwd });
    session.sharedThreadId = resumed.threadId;
    session.onSharedThread?.(resumed.threadId);
    return resumed.threadId;
  }

  // Arm the model for this session's next turn. Faithful to the protocol: the
  // override folds into the next `turn/start` (never sent as an empty model).
  // No push fires on a model change, so there is nothing to await; the next
  // submitted turn applies it and the `--remote` TUI footer reflects it.
  switchModel(sessionId: string, model: string, effort?: CodexReasoningEffort): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const trimmed = model.trim();
    if (!trimmed) return false;
    assertLocalRuntimeModelId(trimmed);
    session.client.setModelForNextTurn(trimmed, effort);
    return true;
  }

  // Submit a phone-composer turn over the protocol so the pending model
  // override actually reaches the shared thread and the turn appears in the
  // TUI. Returns false (caller falls back to the PTY path) unless we have both
  // a connected client and the TUI's shared thread id.
  async submitTurn(
    sessionId: string,
    text: string,
    source: "human" | "agent" = "human"
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.client.isConnected() || !session.sharedThreadId) return false;
    try {
      await session.client.submitTurn(text, { source });
      return true;
    } catch {
      return false;
    }
  }

  respondToServerRequest(sessionId: string, response: ServerRequestResponse): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.client.isConnected()) return false;
    return session.client.respondToServerRequest(response.requestId, response.decision, response.content);
  }

  async detach(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      await session.client.disconnect().catch(() => {});
    }
    // Release by acquisition-time ownership, not by control-session presence:
    // the daemon must die with its session even when attach never succeeded.
    const socketPath = this.ownedDaemons.get(sessionId);
    if (socketPath !== undefined) {
      this.ownedDaemons.delete(sessionId);
      this.daemons.release(socketPath);
    }
  }

  stop(): void {
    for (const session of this.sessions.values()) {
      void session.client.disconnect().catch(() => {});
    }
    this.sessions.clear();
    this.ownedDaemons.clear();
    this.daemons.stopAll();
  }
}
