import type {
  AgentEvent,
  AgentSession,
  FleetEvent,
  RecentEventsResult,
  StartAgentRequest,
  TopologyResponse
} from "@perch/shared";
import type { SubmitBarrier } from "../modelSwitch.js";

// Full serialized screen state for a client opening or resyncing the detail
// tier. `data` is ANSI (colors, cursor) replayable into any terminal emulator.
export type TerminalSnapshot = {
  data: string;
  cols: number;
  rows: number;
  seq: number;
};

export type AgentAdapter = {
  readonly name: string;
  getTopology(): Promise<TopologyResponse>;
  listSessions(): Promise<AgentSession[]>;
  readRecentEvents(sessionId: string, lines: number): Promise<RecentEventsResult>;
  canonicalSessionId?(sessionId: string): string;
  sendInput(sessionId: string, text: string): Promise<void>;
  // `confirm`, when passed, blocks after Enter until `awaitText` renders (or
  // `awaitMs` elapses) - a barrier so a following write never races a slash
  // command the TUI has not finished applying (e.g. a model switch) - and
  // answers `confirm.prompt` if the command raises that dialog. It resolves to
  // whether the marker was reached, so a caller never reports a command that
  // did not land. An un-barriered submit resolves true.
  submitInput?(sessionId: string, text: string, confirm?: SubmitBarrier): Promise<boolean>;
  // Whether a barriered submit is in flight, meaning perch may be about to
  // answer a dialog it raised itself. The screen-state prompt detector consults
  // this so a perch-answered dialog is never also surfaced to the phone.
  // Adapters that never answer dialogs omit it and are always answerable.
  promptAnswerInFlight?(sessionId: string): boolean;
  sendEnter(sessionId: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  startAgent?(request: StartAgentRequest): Promise<AgentSession>;
  // Serialized screen for sessions that support it (PTY-owned). Backends that
  // cannot snapshot omit this; the monitor falls back to readRecentEvents.
  snapshot?(sessionId: string): Promise<TerminalSnapshot>;
  // Last-interacting-client-wins PTY resize; passive viewers never call it.
  resize?(sessionId: string, cols: number, rows: number): Promise<void>;
  // Kill a perch-owned session's process (explicit stop from a client).
  stopSession?(sessionId: string): Promise<void>;
  // In-process proof that this adapter owns the PTY process born for this
  // session. A persisted PID alone is never sufficient after server restart.
  runtimeProcess?(sessionId: string): { processId: number; processStartedAt: string } | undefined;
  // Subscribe to a normalized, agent-agnostic live event stream from the agent
  // backend. Returns an unsubscribe function that tears the subscription down.
  // Adapters that cannot push events omit this; the monitor then relies on its
  // slow reconcile loop alone.
  subscribeFleetEvents?(handler: (event: FleetEvent) => void): () => void;
  // Raw/detail agent events, such as PTY output chunks, that should be pushed
  // directly to subscribed clients without waiting for a screen capture.
  subscribeAgentEvents?(handler: (event: AgentEvent) => void): () => void;
};
