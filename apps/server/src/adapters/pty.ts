import { accessSync, chmodSync, constants, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import pty from "node-pty";
import type {
  AgentEvent,
  AgentKind,
  AgentSession,
  DesktopContext,
  FleetEvent,
  RecentEventsResult,
  StartAgentRequest,
  TopologyResponse
} from "@perch/shared";
import type {
  ITerminalInitOnlyOptions,
  ITerminalOptions,
  Terminal as HeadlessTerminal
} from "@xterm/headless";
import type { SerializeAddon as SerializeAddonType } from "@xterm/addon-serialize";
import { normalizeLines, stripTerminalControls } from "../terminalText.js";
import { spawnModelArgs, type SubmitBarrier } from "../modelSwitch.js";
import type { AgentAdapter, TerminalSnapshot } from "./types.js";

const PTY_PREFIX = "pty:";
const WORKSPACE_ID = "perch-pty";
const WORKSPACE_TITLE = "Perch agents";
// Ended sessions stay visible in the fleet briefly (so "done" is seen), then
// purge. Their terminal buffers are disposed immediately on exit.
const MAX_BUFFER_BYTES = 256 * 1024;
const TERMINAL_COLS = 120;
const TERMINAL_ROWS = 30;
const TERMINAL_SCROLLBACK = 1000;
const MIN_TERMINAL_COLS = 20;
const MIN_TERMINAL_ROWS = 5;
const MAX_TERMINAL_COLS = 300;
const MAX_TERMINAL_ROWS = 100;
const SUBMIT_ENTER_DELAY_MS = 35;
// Delivery verification (see submitInput): per-attempt wait before checking
// the rendered screen for the submitted text, and how many tries to make.
const SUBMIT_VERIFY_DELAY_MS = 1500;
const SUBMIT_VERIFY_ATTEMPTS = 3;
// Post-Enter confirmation barrier (see submitInput's `confirm` arg): how often
// to re-check the rendered screen for the confirmation marker, and how long to
// keep re-rendering after it appears so a follow-on write lands on a settled
// input line rather than one still mid-transition.
const SUBMIT_CONFIRM_POLL_MS = 120;
const SUBMIT_CONFIRM_SETTLE_MS = 300;
// The barrier searches only the BOTTOM of the rendered screen. `renderedText`
// returns the viewport plus ~1000 lines of scrollback, so an unscoped search
// matches a marker printed by an earlier switch and satisfies the barrier on
// its first poll - before the CLI has even reacted to this one. Counted in
// NON-BLANK lines: the TUI anchors its input box to the bottom of the viewport
// and pads the gap above it with blank rows, so on a short transcript a marker
// just 6 content lines up sits 22 RAW lines from the bottom (measured) - a raw
// window would report a switch that plainly landed as "never landed".
const SUBMIT_CONFIRM_TAIL_LINES = 20;
// Once a confirm dialog is answered, guarantee the barrier at least this long
// to see the marker, even if the dialog appeared near the original deadline.
const SUBMIT_CONFIRM_ANSWER_GRACE_MS = 2000;
// Producer-side coalescing: the first chunk after idle flushes immediately;
// sustained bursts flush at most once per interval (leading + trailing).
const FLUSH_INTERVAL_MS = 16;
const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminalCtor } = require("@xterm/headless") as {
  Terminal: new (options?: ITerminalOptions & ITerminalInitOnlyOptions) => HeadlessTerminal;
};
const { SerializeAddon } = require("@xterm/addon-serialize") as {
  SerializeAddon: new () => SerializeAddonType;
};

type PtyExitEvent = {
  exitCode: number;
  signal?: number;
};

type Disposable = {
  dispose(): void;
};

export type PtyProcess = {
  pid: number;
  write(data: string): void;
  resize?(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: PtyExitEvent) => void): Disposable;
};

export type SpawnPty = (
  command: string,
  args: string[],
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: NodeJS.ProcessEnv;
  }
) => PtyProcess;

type PtySessionState = {
  process: PtyProcess;
  session: AgentSession;
  // When this PTY process was spawned - the process ownership birth marker
  // persisted on the runtime row (never an activity timestamp).
  spawnedAt: string;
  command: string;
  args: string[];
  rawText: string;
  terminal: HeadlessTerminal;
  serialize: SerializeAddonType;
  writeQueue: Promise<void>;
  disposables: Disposable[];
  cols: number;
  rows: number;
  // Coalescing state: chunks buffer here between flushes; seq counts flushed
  // deltas so clients can detect gaps and request a fresh snapshot.
  pendingRaw: string;
  seq: number;
  lastFlushAt: number;
  flushTimer?: ReturnType<typeof setTimeout>;
  // Set once the process exits; the record survives briefly for the fleet,
  // with heavy resources already released.
  endedAt?: number;
};

// How a session ended, handed to onSessionExit so task bookkeeping can record
// the death with context. exitCode is absent when the exit was inferred (the
// liveness sweep or an explicit stop) rather than reported by the process.
export type SessionExitContext = {
  status: "done" | "error";
  exitCode?: number;
  // Last rendered output lines, for the "what was it doing when it died" note.
  tail?: string;
};

export type PtyAdapterOptions = {
  // Extra environment for each spawned session (hook wiring: PERCH_SESSION_ID
  // and friends). Keyed by the perch session id.
  sessionEnv?: (sessionId: string, request: StartAgentRequest) => Record<string, string>;
  // Fired when a session's process exits, for cleanup outside the adapter
  // (hook token revocation, timeline tailer teardown, task bookkeeping).
  onSessionExit?: (sessionId: string, context: SessionExitContext) => void;
};

export class PtyAgentAdapter implements AgentAdapter {
  readonly name = "pty";

  private readonly sessions = new Map<string, PtySessionState>();
  private readonly events = new EventEmitter();
  // Sessions with a barriered submit in flight - see promptAnswerInFlight.
  private readonly answeringSessions = new Set<string>();

  constructor(
    private readonly spawnPty: SpawnPty = pty.spawn,
    private readonly options: PtyAdapterOptions = {}
  ) {}

  owns(sessionId: string): boolean {
    return sessionId.startsWith(PTY_PREFIX);
  }

  async getTopology(): Promise<TopologyResponse> {
    const panes = [...this.sessions.values()].map((state) => ({
      id: state.session.id,
      title: state.session.title,
      active: state.session.status === "running",
      surfaces: [
        {
          id: state.session.id,
          title: state.session.title,
          kind: "terminal" as const,
          active: state.session.status === "running",
          command: [state.command, ...state.args].join(" "),
          sessionId: state.session.id
        }
      ]
    }));

    return {
      windows: panes.length
        ? [
            {
              id: "perch-pty",
              title: "Perch PTY sessions",
              active: false,
              workspaces: [
                {
                  id: WORKSPACE_ID,
                  title: WORKSPACE_TITLE,
                  active: false,
                  panes
                }
              ]
            }
          ]
        : [],
      generatedAt: new Date().toISOString()
    };
  }

  async listSessions(): Promise<AgentSession[]> {
    this.sweepLiveness();
    return [...this.sessions.values()].map((state) => ({ ...state.session }));
  }

  // Defense in depth against missed onExit callbacks (observed in the wild
  // with wrapper shims): any session still marked live whose process is gone
  // gets transitioned to done. Runs on every list, which the monitor calls
  // on its reconcile cadence.
  private sweepLiveness(): void {
    for (const [sessionId, state] of this.sessions) {
      if (state.endedAt !== undefined) {
        continue;
      }
      if (!isProcessAlive(state.process.pid)) {
        this.markEnded(sessionId, state, "done");
      }
    }
  }

  private markEnded(
    sessionId: string,
    state: PtySessionState,
    status: "done" | "error",
    exitCode?: number
  ): void {
    if (state.endedAt !== undefined) {
      return;
    }
    this.flush(sessionId, state);
    state.endedAt = Date.now();
    // Capture the death context before the buffers are released below.
    const tail = lastLines(stripTerminalControls(state.rawText), 12).trim().slice(-1000);

    // Release heavy resources now; keep the light record for the fleet.
    for (const disposable of state.disposables) {
      disposable.dispose();
    }
    state.disposables = [];
    state.writeQueue = state.writeQueue.finally(() => {
      try {
        state.terminal.dispose();
      } catch {
        // Already disposed.
      }
    });

    this.touch(sessionId, status);
    this.emitAgentEvent({
      type: "status",
      sessionId,
      status,
      at: state.session.lastActivityAt
    });
    this.options.onSessionExit?.(sessionId, {
      status,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(tail ? { tail } : {})
    });

    // An ended session leaves the fleet immediately: exiting on the desktop
    // (or stopping from the phone) should make the row disappear, not linger
    // as a done/error ghost. The timeline/scrollback die with it by design.
    this.sessions.delete(sessionId);
    this.emitFleetEvent({
      kind: "topology",
      workspaceId: WORKSPACE_ID,
      sessionId,
      at: new Date().toISOString(),
      name: "pty.session.purged"
    });
  }

  // Explicit kill from a client (phone/CLI): terminate the process; the exit
  // handler (or the liveness sweep) completes the ended transition.
  async stopSession(sessionId: string): Promise<void> {
    const state = this.requireSession(sessionId);
    try {
      state.process.kill();
    } catch {
      // Already gone; sweep will settle it.
    }
    setTimeout(() => {
      const current = this.sessions.get(sessionId);
      if (current && current.endedAt === undefined) {
        this.markEnded(sessionId, current, "done");
      }
    }, 1500).unref?.();
  }

  runtimeProcess(sessionId: string): { processId: number; processStartedAt: string } | undefined {
    const state = this.sessions.get(sessionId);
    if (!state || state.endedAt !== undefined || !isProcessAlive(state.process.pid)) return undefined;
    return { processId: state.process.pid, processStartedAt: state.spawnedAt };
  }

  async readRecentEvents(sessionId: string, lines: number): Promise<RecentEventsResult> {
    const state = this.requireSession(sessionId);
    const rendered = await this.renderedText(state);
    return {
      terminal: true,
      events: [
        {
          type: "terminal_output",
          sessionId,
          text: lastLines(rendered, lines),
          seq: state.seq,
          at: state.session.lastActivityAt
        }
      ]
    };
  }

  // Full serialized screen (colors, cursor) for a client opening or resyncing
  // the detail tier. Deltas with seq > snapshot.seq apply cleanly on top.
  async snapshot(sessionId: string): Promise<TerminalSnapshot> {
    const state = this.requireLiveSession(sessionId);
    // The terminal already contains any coalesced-but-unflushed bytes; flush
    // them (bumping seq) first so no delta <= the reported seq re-delivers
    // content the snapshot includes.
    this.flush(sessionId, state);
    await state.writeQueue;
    return {
      data: state.serialize.serialize(),
      cols: state.cols,
      rows: state.rows,
      seq: state.seq
    };
  }

  // Last-interacting-client-wins PTY size; passive viewers never call this.
  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    const state = this.requireLiveSession(sessionId);
    const nextCols = clampInteger(cols, state.cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS);
    const nextRows = clampInteger(rows, state.rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS);
    if (nextCols === state.cols && nextRows === state.rows) {
      return;
    }

    state.cols = nextCols;
    state.rows = nextRows;
    state.process.resize?.(nextCols, nextRows);
    state.writeQueue = state.writeQueue.then(() => {
      state.terminal.resize(nextCols, nextRows);
    });
  }

  async sendInput(sessionId: string, text: string): Promise<void> {
    this.requireLiveSession(sessionId).process.write(text);
    this.touch(sessionId);
  }

  // Whether perch is currently driving a barriered submit on this session, and
  // so may be about to answer the very dialog that command raised (`confirm.
  // prompt`: the model-switch confirm). The general screen-state prompt
  // detector asks before surfacing a dialog as a decision card, so one dialog
  // never gets two answers - perch's "1" and then the user's. A barrier that
  // gives up leaves the flag clear, so a dialog perch failed to answer still
  // reaches the phone.
  promptAnswerInFlight(sessionId: string): boolean {
    return this.answeringSessions.has(sessionId);
  }

  async submitInput(sessionId: string, text: string, confirm?: SubmitBarrier): Promise<boolean> {
    if (!confirm) {
      return await this.submitAndConfirm(sessionId, text);
    }
    this.answeringSessions.add(sessionId);
    try {
      return await this.submitAndConfirm(sessionId, text, confirm);
    } finally {
      this.answeringSessions.delete(sessionId);
    }
  }

  // Submit = land the text in the input line, THEN press Enter once. A booting
  // agent TUI (claude fires SessionStart seconds before its input line is
  // interactive) silently swallows typed text - the worst failure mode,
  // because a swallowed kickoff brief strands its task forever. So the two
  // phases are kept strictly separate: while the text is still unsubmitted we
  // may re-type it (a swallow leaves the input line empty; the rendered screen
  // is checked for the whitespace-squeezed head of the text with backoff), but
  // once Enter is pressed we NEVER re-type - a genuinely submitted prompt that
  // scrolls out of the viewport must not be mistaken for a swallow and sent
  // twice. Short texts ("y", "1") are not distinctive enough to verify and
  // keep single-shot behavior.
  //
  // Returns whether `confirm`'s marker was reached; an un-barriered submit is
  // trivially true. A false return means the command did NOT visibly land, and
  // the caller must not report it as applied.
  private async submitAndConfirm(
    sessionId: string,
    text: string,
    confirm?: SubmitBarrier
  ): Promise<boolean> {
    const needle = squeezeText(text).slice(0, 32);
    const initial = this.requireLiveSession(sessionId);
    initial.process.write(text);
    await sleep(SUBMIT_ENTER_DELAY_MS);

    if (needle.length < 8) {
      const baseline = await this.confirmBaseline(sessionId, confirm);
      initial.process.write("\r");
      this.touch(sessionId, "running");
      return await this.awaitConfirmation(sessionId, confirm, baseline);
    }

    // Phase 1: confirm the text reached the (still unsubmitted) input line,
    // re-typing on a miss. Re-typing here cannot duplicate a submission
    // because Enter has not been pressed yet. A miss is ambiguous - the write
    // may have been swallowed by a not-yet-interactive TUI, or buffered but
    // not yet echoed to the rendered screen - so we kill-line (Ctrl+U) before
    // re-typing. That is idempotent in both cases: a buffered-but-unechoed
    // write is cleared so the retype leaves exactly one copy, and a truly
    // swallowed write makes kill-line a no-op so the retype simply lands.
    for (let attempt = 1; attempt <= SUBMIT_VERIFY_ATTEMPTS; attempt += 1) {
      await sleep(SUBMIT_VERIFY_DELAY_MS * attempt);
      const screen = await this.renderedText(this.requireSession(sessionId)).catch(() => undefined);
      if (screen === undefined || squeezeText(screen).includes(needle)) {
        break;
      }
      if (attempt < SUBMIT_VERIFY_ATTEMPTS) {
        const retry = this.requireLiveSession(sessionId);
        retry.process.write("\x15");
        retry.process.write(text);
      }
    }

    // Phase 2: submit once. The text is confirmed present (or unverifiable),
    // so a single Enter is the whole submission - no text is ever re-sent.
    const state = this.requireLiveSession(sessionId);
    const baseline = await this.confirmBaseline(sessionId, confirm);
    state.process.write("\r");
    this.touch(sessionId, "running");
    return await this.awaitConfirmation(sessionId, confirm, baseline);
  }

  // How many times the success marker is ALREADY on the screen tail, sampled
  // immediately before Enter. The barrier then requires a new occurrence, so a
  // marker left by an earlier run of the same command cannot satisfy it.
  private async confirmBaseline(sessionId: string, confirm?: SubmitBarrier): Promise<number> {
    if (!confirm) return 0;
    const state = this.sessions.get(sessionId);
    if (!state?.process) return 0;
    const screen = await this.renderedText(state).catch(() => undefined);
    return screen === undefined ? 0 : countOccurrences(confirmTail(screen), squeezeText(confirm.awaitText));
  }

  // Optional post-Enter barrier: block until a NEW `confirm.awaitText` renders
  // (the submitted command has visibly landed), then keep re-rendering briefly
  // so the input line settles before the caller writes again. Returns whether
  // the marker was reached.
  //
  // The barrier is observational with exactly one exception: `confirm.prompt`,
  // a dialog the submitted command itself raises. Seeing that dialog on the
  // screen tail makes the barrier answer it once - the command cannot land
  // otherwise, and an unanswered dialog swallows whatever the caller types
  // next. It never re-types the submission, so it cannot duplicate it.
  //
  // A marker that never appears times out at `awaitMs` and returns false. The
  // caller decides what that means; for a model switch it means the switch did
  // not happen and must not be reported as though it had.
  private async awaitConfirmation(
    sessionId: string,
    confirm?: SubmitBarrier,
    baseline = 0
  ): Promise<boolean> {
    if (!confirm) return true;
    const needle = squeezeText(confirm.awaitText);
    const promptNeedle = confirm.prompt ? squeezeText(confirm.prompt.awaitText) : undefined;
    let deadline = Date.now() + confirm.awaitMs;
    let answered = false;

    while (Date.now() < deadline) {
      await sleep(SUBMIT_CONFIRM_POLL_MS);
      const state = this.sessions.get(sessionId);
      if (!state?.process) return false; // session gone; the command never landed
      const screen = await this.renderedText(state).catch(() => undefined);
      if (screen === undefined) continue;

      const tail = confirmTail(screen);
      if (countOccurrences(tail, needle) > baseline) {
        await sleep(SUBMIT_CONFIRM_SETTLE_MS);
        return true;
      }
      if (!answered && promptNeedle !== undefined && tail.includes(promptNeedle)) {
        answered = true;
        state.process.write(confirm.prompt!.keys);
        // The dialog may have opened just shy of the deadline; always leave
        // enough room to see the marker the answer unblocks.
        deadline = Math.max(deadline, Date.now() + SUBMIT_CONFIRM_ANSWER_GRACE_MS);
      }
    }
    return false;
  }

  async sendEnter(sessionId: string): Promise<void> {
    this.requireLiveSession(sessionId).process.write("\r");
    this.touch(sessionId, "running");
  }

  async interrupt(sessionId: string): Promise<void> {
    this.requireLiveSession(sessionId).process.write("\x03");
    this.touch(sessionId, "waiting");
  }

  async startAgent(request: StartAgentRequest): Promise<AgentSession> {
    validateStartRequest(request);
    ensureNodePtyCanSpawn();

    // Adopt a caller-minted id when it is a well-formed, not-yet-live PTY id
    // (the Codex `--remote` path pre-mints it so the daemon can carry this
    // session's hook wiring); otherwise generate a fresh one.
    const id =
      request.sessionId &&
      request.sessionId.startsWith(PTY_PREFIX) &&
      !this.sessions.has(request.sessionId)
        ? request.sessionId
        : `${PTY_PREFIX}${randomUUID()}`;
    const command = request.command.trim();
    const cwd = request.cwd ?? process.cwd();
    const now = new Date().toISOString();
    const agent = request.agent ?? inferAgentKind(command);
    // A launch-time model (from the New Agent sheet) becomes the agent's model
    // flag appended to the caller's args; an empty model contributes nothing.
    // A launch-time reasoning effort (Codex) rides along as a `-c` override.
    const args = [...(request.args ?? []), ...spawnModelArgs(agent, request.model, request.effort)];
    const desktop = normalizeDesktopContext(request.desktop);
    const cols = clampInteger(desktop?.cols, TERMINAL_COLS, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS);
    const rows = clampInteger(desktop?.rows, TERMINAL_ROWS, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS);
    const session: AgentSession = {
      id,
      title: request.title?.trim() || basename(command),
      ...(request.labels?.workerName ? { workerName: request.labels.workerName } : {}),
      agent,
      cwd,
      ...(await gitBranch(cwd)).map((branch) => ({ branch }))[0],
      ...(request.labels ? { labels: request.labels } : {}),
      workspaceId: WORKSPACE_ID,
      paneId: id,
      surfaceId: id,
      kind: "terminal",
      status: "running",
      lastActivityAt: now,
      ...(desktop ? { desktop } : {})
    };

    const child = this.spawnPty(command, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: {
        ...sanitizeSpawnEnv(process.env),
        TERM: "xterm-256color",
        ...(this.options.sessionEnv?.(id, request) ?? {})
      }
    });

    const terminal = new HeadlessTerminalCtor({
      allowProposedApi: true,
      cols,
      rows,
      scrollback: TERMINAL_SCROLLBACK,
      convertEol: true,
      logLevel: "off"
    });
    const serialize = new SerializeAddon();
    terminal.loadAddon(serialize);

    const state: PtySessionState = {
      process: child,
      session,
      spawnedAt: new Date().toISOString(),
      command,
      args,
      rawText: "",
      terminal,
      serialize,
      writeQueue: Promise.resolve(),
      disposables: [],
      cols,
      rows,
      pendingRaw: "",
      seq: 0,
      lastFlushAt: 0
    };

    state.disposables.push(
      child.onData((chunk) => {
        state.rawText = trimBuffer(state.rawText + chunk);
        // Feed the headless terminal (snapshot/tail source) off the hot path;
        // delta delivery to clients does not wait for it.
        state.writeQueue = state.writeQueue.then(() => writeTerminal(state.terminal, chunk)).catch(() => {});
        state.pendingRaw += chunk;
        this.scheduleFlush(id, state);
      }),
      child.onExit((event) => {
        this.markEnded(id, state, event.exitCode === 0 ? "done" : "error", event.exitCode);
      })
    );

    this.sessions.set(id, state);
    this.emitFleetEvent({
      kind: "topology",
      workspaceId: WORKSPACE_ID,
      sessionId: id,
      status: "running",
      agent,
      at: now,
      name: "pty.session.started"
    });
    this.emitAgentEvent({
      type: "status",
      sessionId: id,
      status: "running",
      at: now
    });

    return { ...session };
  }

  sessionAliases(): Map<string, string> {
    const aliases = new Map<string, string>();

    for (const state of this.sessions.values()) {
      const alias = state.session.desktop?.sessionId;
      if (alias && alias !== state.session.id) {
        aliases.set(alias, state.session.id);
      }
    }

    return aliases;
  }

  subscribeFleetEvents(handler: (event: FleetEvent) => void): () => void {
    this.events.on("fleet", handler);
    return () => {
      this.events.off("fleet", handler);
    };
  }

  subscribeAgentEvents(handler: (event: AgentEvent) => void): () => void {
    this.events.on("agent", handler);
    return () => {
      this.events.off("agent", handler);
    };
  }

  stop(): void {
    for (const [sessionId, state] of this.sessions) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
      }
      for (const disposable of state.disposables) {
        disposable.dispose();
      }
      if (state.endedAt === undefined) {
        state.terminal.dispose();
        try {
          state.process.kill();
        } catch {
          // Process already exited.
        }
      }
      this.sessions.delete(sessionId);
    }
  }

  private requireSession(sessionId: string): PtySessionState {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new Error(`Unknown PTY session: ${sessionId}`);
    }
    return state;
  }

  private requireLiveSession(sessionId: string): PtySessionState {
    const state = this.requireSession(sessionId);
    if (state.endedAt !== undefined) {
      throw new Error(`Session ${sessionId} has ended`);
    }
    return state;
  }

  // Leading + trailing throttle: idle sessions deliver the first chunk with no
  // added latency; bursts (builds, `cat` of a big file) coalesce into one
  // delta per interval instead of one WS frame per PTY read.
  private scheduleFlush(sessionId: string, state: PtySessionState): void {
    if (state.flushTimer) {
      return;
    }
    const sinceLast = Date.now() - state.lastFlushAt;
    if (sinceLast >= FLUSH_INTERVAL_MS) {
      this.flush(sessionId, state);
      return;
    }
    state.flushTimer = setTimeout(() => {
      state.flushTimer = undefined;
      this.flush(sessionId, state);
    }, FLUSH_INTERVAL_MS - sinceLast);
    state.flushTimer.unref?.();
  }

  private flush(sessionId: string, state: PtySessionState): void {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = undefined;
    }
    if (!state.pendingRaw) {
      return;
    }
    const raw = state.pendingRaw;
    state.pendingRaw = "";
    state.lastFlushAt = Date.now();
    state.seq += 1;
    // Activity only, no status claim: agent TUIs redraw (spinner, cursor)
    // even while idle at the prompt, so output-driven "running" would
    // permanently overwrite the idle set by the agent's Stop hook.
    this.touch(sessionId);
    this.emitAgentEvent({
      type: "terminal_output",
      sessionId,
      raw,
      seq: state.seq,
      at: state.session.lastActivityAt
    });
  }

  // Rendered plain-text view of the screen, computed on demand (throttled by
  // the fleet monitor's tail cadence) instead of per chunk.
  private async renderedText(state: PtySessionState): Promise<string> {
    try {
      await state.writeQueue;
      return terminalText(state.terminal);
    } catch {
      return stripTerminalControls(state.rawText);
    }
  }

  private touch(sessionId: string, status?: AgentSession["status"]): void {
    const state = this.requireSession(sessionId);
    const at = new Date().toISOString();
    state.session = {
      ...state.session,
      status: status ?? state.session.status,
      lastActivityAt: at
    };
    this.emitFleetEvent({
      kind: "activity",
      workspaceId: WORKSPACE_ID,
      sessionId,
      status,
      agent: state.session.agent,
      at,
      name: "pty.session.activity"
    });
  }

  private emitFleetEvent(event: FleetEvent): void {
    this.events.emit("fleet", event);
  }

  private emitAgentEvent(event: AgentEvent): void {
    this.events.emit("agent", event);
  }
}

function validateStartRequest(request: StartAgentRequest): void {
  if (!request || typeof request.command !== "string" || request.command.trim().length === 0) {
    throw new Error("command is required");
  }

  if (request.args && !request.args.every((arg) => typeof arg === "string")) {
    throw new Error("args must be strings");
  }

  validateDesktopContext(request.desktop);
}

function inferAgentKind(command: string): AgentKind {
  const name = basename(command).toLowerCase();

  if (name.includes("codex")) {
    return "codex";
  }
  if (name.includes("claude")) {
    return "claude";
  }

  return "unknown";
}

function ensureNodePtyCanSpawn(): void {
  if (process.platform !== "darwin") {
    return;
  }

  let packageJson: string;
  try {
    packageJson = require.resolve("node-pty/package.json");
  } catch {
    return;
  }

  const packageRoot = dirname(packageJson);
  const helperPath = join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  if (!existsSync(helperPath)) {
    return;
  }

  try {
    accessSync(helperPath, constants.X_OK);
    return;
  } catch {
    // npm can install node-pty's prebuilt helper without the executable bit.
  }

  try {
    chmodSync(helperPath, 0o755);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`node-pty spawn-helper is not executable at ${helperPath}: ${message}`);
  }
}

// If the perch server was itself started from inside an agent session (a
// nested Claude, a hook, CI), those session markers must not leak into the
// PTYs we spawn: a claude that inherits CLAUDE_CODE_CHILD_SESSION treats
// itself as a child session and skips transcript persistence, which silently
// breaks the structured timeline. CLAUDE_CONFIG_DIR is user intent and stays.
function sanitizeSpawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")) {
      continue;
    }
    clean[key] = value;
  }
  // Per perch's no-cloud posture, sessions perch spawns run no-mistakes with
  // its telemetry off by default, using upstream's own documented opt-out
  // (NO_MISTAKES_TELEMETRY; docs: reference/environment). Reversible: any
  // value the user exported before starting the perch server wins - export
  // NO_MISTAKES_TELEMETRY=1 to re-enable telemetry.
  if (!("NO_MISTAKES_TELEMETRY" in clean)) {
    clean.NO_MISTAKES_TELEMETRY = "0";
  }
  return clean;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function trimBuffer(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_BUFFER_BYTES) {
    return text;
  }

  return text.slice(-MAX_BUFFER_BYTES);
}

function writeTerminal(terminal: HeadlessTerminal, chunk: string): Promise<void> {
  return new Promise((resolve) => {
    terminal.write(chunk, resolve);
  });
}

function terminalText(terminal: HeadlessTerminal): string {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.length - TERMINAL_SCROLLBACK - terminal.rows);
  const lines: string[] = [];

  for (let index = start; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    if (!line) {
      continue;
    }

    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }

  return normalizeLines(stripTerminalControls(lines.join("\n")));
}

function lastLines(text: string, count: number): string {
  return text
    .split(/\r?\n/)
    .slice(-Math.max(1, Math.min(count, 1000)))
    .join("\n");
}

function normalizeDesktopContext(value: DesktopContext | undefined): DesktopContext | undefined {
  if (!value) {
    return undefined;
  }

  const desktop: DesktopContext = {};

  for (const key of ["sessionId", "workspaceId", "paneId", "surfaceId", "terminal"] as const) {
    const field = value[key]?.trim();
    if (field) {
      desktop[key] = field;
    }
  }

  for (const key of ["cols", "rows"] as const) {
    const field = value[key];
    if (typeof field === "number" && Number.isInteger(field) && field > 0) {
      desktop[key] = field;
    }
  }

  return Object.keys(desktop).length > 0 ? desktop : undefined;
}

function validateDesktopContext(value: DesktopContext | undefined): void {
  if (value === undefined) {
    return;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("desktop must be an object");
  }

  for (const key of ["sessionId", "workspaceId", "paneId", "surfaceId", "terminal"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new Error(`desktop.${key} must be a string`);
    }
  }

  for (const key of ["cols", "rows"] as const) {
    if (value[key] !== undefined && !Number.isInteger(value[key])) {
      throw new Error(`desktop.${key} must be an integer`);
    }
  }
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, value));
}

// Whitespace-insensitive haystack/needle form: terminal line-wrap inserts
// newlines at arbitrary columns, so remove all whitespace before matching.
function squeezeText(value: string): string {
  return value.replace(/\s+/g, "");
}

// The whitespace-squeezed bottom of the rendered screen. Blank rows are dropped
// before slicing, so the window spans real content rather than the TUI's
// bottom-padding - a dialog and a slash command's result line both render just
// above the input box, well inside this many content lines.
function confirmTail(screen: string): string {
  const lines = screen.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return squeezeText(lines.slice(-SUBMIT_CONFIRM_TAIL_LINES).join("\n"));
}

function countOccurrences(haystack: string, needle: string): number {
  return needle.length === 0 ? 0 : haystack.split(needle).length - 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Best-effort branch lookup for the fleet subtitle; never blocks a spawn on
// a slow or absent git (1s cap, empty outside repos / detached HEADs keep
// their short-hash label from rev-parse).
async function gitBranch(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
      { timeout: 1000 },
      (error, stdout) => {
        const branch = error ? "" : stdout.trim();
        resolve(branch && branch !== "HEAD" ? [branch] : []);
      }
    );
  });
}
