// One AgentAdapter facade over the two provider backends: Codex sessions live
// on the app-server-owned adapter (no PTY), everything else - Claude first -
// stays on the PTY adapter, byte-for-byte. Session-scoped calls route by which
// backend actually owns the session id; launches route by agent kind.
//
// The monitor, watchdogs, recovery coordinators, and HTTP layer all keep their
// single-adapter world view; this facade is the only place that knows there
// are two.

import type {
  AgentEvent,
  AgentSession,
  FleetEvent,
  RecentEventsResult,
  StartAgentRequest,
  TopologyResponse
} from "@perch/shared";
import type { SubmitBarrier } from "../modelSwitch.js";
import type { CodexAppServerAdapter } from "./codexAppServerAdapter.js";
import type { PtyAgentAdapter } from "./pty.js";
import type { AgentAdapter, TerminalSnapshot } from "./types.js";

export function isCodexLaunchRequest(request: StartAgentRequest): boolean {
  if (request.agent) return request.agent === "codex";
  const base = request.command.trim().split(/[\\/]/).pop() ?? "";
  return base.toLowerCase().includes("codex");
}

export class RoutingAgentAdapter implements AgentAdapter {
  readonly name = "routing";

  constructor(
    private readonly pty: PtyAgentAdapter,
    private readonly codexOwned: CodexAppServerAdapter
  ) {}

  private ownerOf(sessionId: string): AgentAdapter {
    return this.codexOwned.has(sessionId) ? this.codexOwned : this.pty;
  }

  getTopology(): Promise<TopologyResponse> {
    return this.pty.getTopology();
  }

  async listSessions(): Promise<AgentSession[]> {
    const [ptySessions, ownedSessions] = await Promise.all([
      this.pty.listSessions(),
      this.codexOwned.listSessions()
    ]);
    return [...ptySessions, ...ownedSessions];
  }

  readRecentEvents(sessionId: string, lines: number): Promise<RecentEventsResult> {
    return this.ownerOf(sessionId).readRecentEvents(sessionId, lines);
  }

  canonicalSessionId(sessionId: string): string {
    if (this.codexOwned.has(sessionId)) return sessionId;
    const pty: AgentAdapter = this.pty;
    return pty.canonicalSessionId?.(sessionId) ?? sessionId;
  }

  sendInput(sessionId: string, text: string): Promise<void> {
    return this.ownerOf(sessionId).sendInput(sessionId, text);
  }

  async submitInput(sessionId: string, text: string, confirm?: SubmitBarrier): Promise<boolean> {
    const owner = this.ownerOf(sessionId);
    if (owner.submitInput) return owner.submitInput(sessionId, text, confirm);
    await owner.sendInput(sessionId, text);
    await owner.sendEnter(sessionId);
    return true;
  }

  promptAnswerInFlight(sessionId: string): boolean {
    if (this.codexOwned.has(sessionId)) return false;
    return this.pty.promptAnswerInFlight?.(sessionId) ?? false;
  }

  sendEnter(sessionId: string): Promise<void> {
    return this.ownerOf(sessionId).sendEnter(sessionId);
  }

  interrupt(sessionId: string): Promise<void> {
    return this.ownerOf(sessionId).interrupt(sessionId);
  }

  // Launch routing: Codex is app-server-owned, everything else is a PTY. The
  // managed launcher calls codexOwned.startOwned directly when it needs to
  // carry resume context; this path serves plain AgentAdapter consumers.
  startAgent(request: StartAgentRequest): Promise<AgentSession> {
    if (isCodexLaunchRequest(request)) return this.codexOwned.startAgent(request);
    if (!this.pty.startAgent) throw new Error("PTY agents are not supported by this server");
    return this.pty.startAgent(request);
  }

  snapshot(sessionId: string): Promise<TerminalSnapshot> {
    if (this.codexOwned.has(sessionId)) {
      throw new Error("app-server-owned codex sessions have no terminal snapshot");
    }
    if (!this.pty.snapshot) throw new Error("snapshot is not supported by this server");
    return this.pty.snapshot(sessionId);
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    if (this.codexOwned.has(sessionId)) return;
    await this.pty.resize?.(sessionId, cols, rows);
  }

  stopSession(sessionId: string): Promise<void> {
    const owner = this.ownerOf(sessionId);
    return owner.stopSession ? owner.stopSession(sessionId) : Promise.resolve();
  }

  runtimeProcess(sessionId: string): { processId: number; processStartedAt: string } | undefined {
    if (this.codexOwned.has(sessionId)) return undefined;
    return this.pty.runtimeProcess?.(sessionId);
  }

  subscribeFleetEvents(handler: (event: FleetEvent) => void): () => void {
    return this.pty.subscribeFleetEvents?.(handler) ?? (() => {});
  }

  subscribeAgentEvents(handler: (event: AgentEvent) => void): () => void {
    return this.pty.subscribeAgentEvents?.(handler) ?? (() => {});
  }

  stop(): void {
    this.pty.stop();
  }
}
