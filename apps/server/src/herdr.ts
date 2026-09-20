import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import type {
  AgentEvent,
  AgentKind,
  AgentSession,
  AgentSessionStatus,
  FleetEvent,
  RecentEventsResult,
  StartAgentRequest,
  TopologyResponse
} from "@perch/shared";
import { spawnModelArgs, type SubmitBarrier } from "./modelSwitch.js";
import type { HerdrProvider, HerdrSettings } from "./settings.js";
import type {
  HerdrPresentationKind,
  HerdrWorkerPaneRecord,
  HerdrWorkerPaneRepository,
  StateDb
} from "./stateDb.js";
import type { AgentAdapter } from "./adapters/types.js";

const execFileAsync = promisify(execFile);
export const HERDR_MIN_PROTOCOL = 16;
const HERDR_SESSION_ID = "default";

export type HerdrCompatibility = {
  available: boolean;
  compatible: boolean;
  version?: string;
  protocol?: number;
  reason?: string;
};

export type HerdrPaneIdentity = Pick<
  HerdrWorkerPaneRecord,
  "workspaceId" | "tabId" | "paneId" | "terminalId"
>;

export type HerdrTransport = {
  compatibility(): Promise<HerdrCompatibility>;
  installIntegration(provider: Exclude<HerdrProvider, "cursor">): Promise<void>;
  startAgent(input: {
    name: string;
    cwd: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    workspaceId?: string;
    tabId?: string;
  }): Promise<HerdrPaneIdentity>;
  pane(identity: string): Promise<HerdrPaneIdentity | undefined>;
  readPane(paneId: string, lines: number): Promise<string>;
  sendText(paneId: string, text: string): Promise<void>;
  sendKeys(paneId: string, ...keys: string[]): Promise<void>;
  closePane(paneId: string): Promise<void>;
  reportConsoleAgent(paneId: string, state: "idle" | "working" | "blocked" | "unknown"): Promise<void>;
};

export class HerdrUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HerdrUnavailableError";
  }
}

// Public-CLI transport only. We deliberately do not reach into Herdr's socket
// protocol or source tree: the CLI is the compatibility boundary Herdr owns.
export class CliHerdrTransport implements HerdrTransport {
  constructor(
    private readonly binary = "herdr",
    private readonly runCommand: (command: string, args: string[]) => Promise<string> = runCommand
  ) {}

  async compatibility(): Promise<HerdrCompatibility> {
    try {
      const raw = await this.run(["status", "--json"]);
      const status = JSON.parse(raw) as {
        client?: { version?: string; protocol?: number };
        server?: { running?: boolean; compatible?: boolean; version?: string; protocol?: number };
      };
      const server = status.server;
      const protocol = server?.protocol ?? status.client?.protocol;
      if (!server?.running) {
        return { available: true, compatible: false, version: server?.version, protocol, reason: "Herdr server is not running" };
      }
      if (server.compatible === false || !protocol || protocol < HERDR_MIN_PROTOCOL) {
        return {
          available: true,
          compatible: false,
          version: server.version ?? status.client?.version,
          protocol,
          reason: `Herdr protocol ${protocol ?? "unknown"} is below Perch's required protocol ${HERDR_MIN_PROTOCOL}`
        };
      }
      return { available: true, compatible: true, version: server.version ?? status.client?.version, protocol };
    } catch (error) {
      const message = errorMessage(error);
      return {
        available: !/ENOENT|not found/i.test(message),
        compatible: false,
        reason: /ENOENT|not found/i.test(message) ? "Herdr CLI is not installed" : `Herdr is unavailable: ${message}`
      };
    }
  }

  async installIntegration(provider: Exclude<HerdrProvider, "cursor">): Promise<void> {
    await this.run(["integration", "install", provider]);
  }

  async startAgent(input: {
    name: string;
    cwd: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    workspaceId?: string;
    tabId?: string;
  }): Promise<HerdrPaneIdentity> {
    const args = ["agent", "start", input.name, "--cwd", input.cwd, "--no-focus"];
    if (input.workspaceId) args.push("--workspace", input.workspaceId);
    if (input.tabId) args.push("--tab", input.tabId);
    for (const [key, value] of Object.entries(input.env)) {
      // The hook capability is passed only to the terminal process. It is not
      // written to Herdr metadata or Perch presentation records.
      args.push("--env", `${key}=${value}`);
    }
    args.push("--", input.command, ...input.args);
    return paneIdentityFromResponse(await this.runJson(args));
  }

  async pane(paneId: string): Promise<HerdrPaneIdentity | undefined> {
    try {
      return paneIdentityFromResponse(await this.runJson(["pane", "get", paneId]));
    } catch (error) {
      if (isMissingPaneError(error)) return undefined;
      throw error;
    }
  }

  async readPane(paneId: string, lines: number): Promise<string> {
    // `pane read` is intentionally terminal text in Herdr's public CLI,
    // unlike identity commands which return JSON envelopes.
    return this.run(["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)]);
  }

  async sendText(paneId: string, text: string): Promise<void> {
    await this.run(["pane", "send-text", paneId, text]);
  }

  async sendKeys(paneId: string, ...keys: string[]): Promise<void> {
    await this.run(["pane", "send-keys", paneId, ...keys]);
  }

  async closePane(paneId: string): Promise<void> {
    try {
      await this.run(["pane", "close", paneId]);
    } catch (error) {
      if (!isMissingPaneError(error)) throw error;
    }
  }

  async reportConsoleAgent(
    paneId: string,
    state: "idle" | "working" | "blocked" | "unknown"
  ): Promise<void> {
    await this.run([
      "pane",
      "report-agent",
      paneId,
      "--source",
      "perch",
      "--agent",
      "Perch worker console",
      "--state",
      state
    ]);
  }

  private async runJson(args: string[]): Promise<unknown> {
    const raw = await this.run(args);
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`Herdr returned invalid JSON for ${args.slice(0, 2).join(" ")}`);
    }
  }

  private async run(args: string[]): Promise<string> {
    const output = await this.runCommand(this.binary, args);
    throwForHerdrResponseError(output);
    return output;
  }
}

async function runCommand(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    });
    throwForHerdrResponseError(stdout);
    return stdout;
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string; message?: string };
    const output = [details.stderr, details.stdout, details.message].filter(Boolean).join("\n").trim();
    throw new Error(output || "Herdr command failed");
  }
}

function throwForHerdrResponseError(output: string): void {
  try {
    const parsed = JSON.parse(output) as { error?: { code?: unknown; message?: unknown } };
    if (!parsed.error || typeof parsed.error !== "object") return;
    const code = typeof parsed.error.code === "string" ? parsed.error.code : "unknown_error";
    const message = typeof parsed.error.message === "string" ? parsed.error.message : "Herdr command failed";
    throw new Error(`Herdr ${code}: ${message}`);
  } catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }
}

// Coordinates durable identities and the two deliberately different runtime
// paths. Claude's pane hosts Claude itself. Codex's pane hosts only Perch's
// console, never a second Codex TUI or app-server client.
export class HerdrWorkerIntegration {
  constructor(
    private readonly panes: HerdrWorkerPaneRepository,
    private readonly settings: () => HerdrSettings,
    private readonly transport: HerdrTransport = new CliHerdrTransport(),
    private readonly consoleCommand: (sessionId: string) => { command: string; args: string[]; env: Record<string, string> }
  ) {}

  config(): HerdrSettings {
    return this.settings();
  }

  enabledFor(provider: HerdrProvider): boolean {
    return provider !== "cursor" && this.settings().enabled === true && this.settings().providers?.[provider] === true;
  }

  compatibility(): Promise<HerdrCompatibility> {
    return this.transport.compatibility();
  }

  async installProvider(provider: Exclude<HerdrProvider, "cursor">): Promise<void> {
    await this.transport.installIntegration(provider);
  }

  async startClaude(
    request: StartAgentRequest,
    environment: Record<string, string>,
    taskId?: string
  ): Promise<HerdrWorkerPaneRecord> {
    if (!this.enabledFor("claude")) {
      throw new HerdrUnavailableError("Herdr Claude presentation is disabled");
    }
    const sessionId = requireSessionId(request);
    const existing = this.panes.find(sessionId);
    if (existing?.state === "live") {
      const pane = await this.transport.pane(existing.paneId);
      if (pane) return existing;
      this.panes.markState(sessionId, "stale");
    }
    await this.assertCompatible();
    const command = request.command.trim();
    const args = [...(request.args ?? []), ...spawnModelArgs("claude", request.model, request.effort)];
    const identity = await this.transport.startAgent({
      // A task title can contain the user's brief. Herdr only needs a short
      // operational label, so never promote title/prompt-shaped text into the
      // external terminal name.
      name: paneName(request.labels?.workerName ?? "Perch Claude worker"),
      cwd: request.cwd ?? process.cwd(),
      command,
      args,
      env: environment
    });
    return this.panes.upsert({
      perchSessionId: sessionId,
      ...(taskId ? { taskId } : {}),
      provider: "claude",
      presentationKind: "provider",
      herdrSessionId: HERDR_SESSION_ID,
      ...identity
    });
  }

  async ensureCodexConsole(input: {
    sessionId: string;
    taskId?: string;
    workerName?: string;
    cwd: string;
  }): Promise<HerdrWorkerPaneRecord | undefined> {
    if (!this.enabledFor("codex")) return undefined;
    const existing = this.panes.find(input.sessionId);
    if (existing?.state === "live") {
      const pane = await this.transport.pane(existing.paneId);
      if (pane) return existing;
      this.panes.markState(input.sessionId, "stale");
    }
    try {
      await this.assertCompatible();
    } catch (error) {
      if (error instanceof HerdrUnavailableError) return undefined;
      throw error;
    }
    const console = this.consoleCommand(input.sessionId);
    const identity = await this.transport.startAgent({
      name: paneName(`Perch worker console ${input.workerName ?? "worker"}`),
      cwd: input.cwd,
      command: console.command,
      args: console.args,
      env: console.env
    });
    const record = this.panes.upsert({
      perchSessionId: input.sessionId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      provider: "codex",
      presentationKind: "console",
      herdrSessionId: HERDR_SESSION_ID,
      ...identity
    });
    await this.syncConsole(record, "running").catch(() => {});
    return record;
  }

  async reconnect(): Promise<{ connected: HerdrWorkerPaneRecord[]; stale: HerdrWorkerPaneRecord[] }> {
    const connected: HerdrWorkerPaneRecord[] = [];
    const stale: HerdrWorkerPaneRecord[] = [];
    if (this.settings().enabled !== true) return { connected, stale };
    let compatibility: HerdrCompatibility;
    try {
      compatibility = await this.transport.compatibility();
    } catch {
      return { connected, stale };
    }
    if (!compatibility.compatible) return { connected, stale };
    for (const record of this.panes.live()) {
      try {
        const identity = await this.transport.pane(record.paneId);
        if (identity) {
          connected.push(record);
        } else {
          this.panes.markState(record.perchSessionId, "stale");
          stale.push(record);
        }
      } catch {
        // A transient Herdr failure is not proof a worker exited. Keep the
        // durable identity to reconnect on the next server start/pulse.
      }
    }
    return { connected, stale };
  }

  async paneFor(sessionId: string): Promise<HerdrWorkerPaneRecord | undefined> {
    return this.panes.find(sessionId);
  }

  async paneIsLive(sessionId: string): Promise<boolean> {
    const record = this.panes.find(sessionId);
    if (!record || record.state !== "live") return false;
    const live = await this.transport.pane(record.paneId);
    if (live) return true;
    this.panes.markState(sessionId, "stale");
    return false;
  }

  async read(sessionId: string, lines: number): Promise<string> {
    const pane = this.requireLivePane(sessionId);
    return this.transport.readPane(pane.paneId, lines);
  }

  async sendText(sessionId: string, text: string): Promise<void> {
    const pane = this.requireLivePane(sessionId);
    await this.transport.sendText(pane.paneId, text);
  }

  async sendKeys(sessionId: string, ...keys: string[]): Promise<void> {
    const pane = this.requireLivePane(sessionId);
    await this.transport.sendKeys(pane.paneId, ...keys);
  }

  async close(sessionId: string): Promise<void> {
    const record = this.panes.find(sessionId);
    if (!record || record.state === "closed") return;
    await this.transport.closePane(record.paneId);
    this.panes.markState(sessionId, "closed");
  }

  async syncConsole(session: HerdrWorkerPaneRecord, status: AgentSessionStatus): Promise<void> {
    if (session.presentationKind !== "console" || session.state !== "live") return;
    await this.transport.reportConsoleAgent(session.paneId, herdrState(status));
  }

  async syncCodexStatus(sessionId: string, status: AgentSessionStatus): Promise<void> {
    const record = this.panes.find(sessionId);
    if (!record || record.provider !== "codex") return;
    await this.syncConsole(record, status);
  }

  private async assertCompatible(): Promise<void> {
    const compatibility = await this.transport.compatibility();
    if (!compatibility.compatible) {
      throw new HerdrUnavailableError(compatibility.reason ?? "Herdr is unavailable or incompatible");
    }
  }

  private requireLivePane(sessionId: string): HerdrWorkerPaneRecord {
    const record = this.panes.find(sessionId);
    if (!record || record.state !== "live") {
      throw new Error(`No live Herdr pane for Perch session ${sessionId}`);
    }
    return record;
  }
}

export type HerdrClaudeAdapterOptions = {
  sessionEnv: (sessionId: string, request: StartAgentRequest) => Record<string, string>;
  taskIdForSession?: (sessionId: string) => string | undefined;
  onSessionExit?: (sessionId: string, context: { status: "done" | "error"; tail?: string }) => void;
};

// A remote-terminal adapter for Claude. Perch retains session, task, hook,
// approval, and recovery authority while Herdr owns the terminal pane itself.
export class HerdrClaudeAdapter implements AgentAdapter {
  readonly name = "herdr-claude";
  private readonly sessions = new Map<string, AgentSession>();
  private readonly events = new EventEmitter();

  constructor(
    private readonly integration: HerdrWorkerIntegration,
    private readonly options: HerdrClaudeAdapterOptions
  ) {}

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  enabled(): boolean {
    return this.integration.enabledFor("claude");
  }

  async reconnect(records: HerdrWorkerPaneRecord[]): Promise<void> {
    for (const record of records) {
      if (record.provider !== "claude" || record.presentationKind !== "provider") continue;
      const session = this.sessionFromRecord(record);
      this.sessions.set(session.id, session);
    }
  }

  async getTopology(): Promise<TopologyResponse> {
    const sessions = await this.listSessions();
    return {
      windows: sessions.length
        ? [{
            id: "herdr",
            title: "Herdr worker panes",
            active: false,
            workspaces: sessions.map((session) => ({
              id: session.workspaceId ?? "herdr",
              title: "Herdr",
              active: false,
              panes: [{
                id: session.paneId ?? session.id,
                title: session.title,
                active: session.status === "running",
                surfaces: [{
                  id: session.surfaceId ?? session.id,
                  title: session.title,
                  kind: "terminal" as const,
                  active: session.status === "running",
                  command: "claude",
                  sessionId: session.id
                }]
              }]
            }))
          }]
        : [],
      generatedAt: new Date().toISOString()
    };
  }

  async listSessions(): Promise<AgentSession[]> {
    await this.probe();
    return [...this.sessions.values()].map((session) => ({ ...session }));
  }

  async readRecentEvents(sessionId: string, lines: number): Promise<RecentEventsResult> {
    const text = await this.integration.read(sessionId, lines);
    const session = this.require(sessionId);
    return {
      terminal: true,
      events: [{ type: "terminal_output", sessionId, text, seq: 0, at: session.lastActivityAt }]
    };
  }

  async sendInput(sessionId: string, text: string): Promise<void> {
    await this.integration.sendText(sessionId, text);
    this.touch(sessionId, "running");
  }

  async submitInput(sessionId: string, text: string, _confirm?: SubmitBarrier): Promise<boolean> {
    await this.sendInput(sessionId, text);
    await this.sendEnter(sessionId);
    return true;
  }

  async sendEnter(sessionId: string): Promise<void> {
    await this.integration.sendKeys(sessionId, "ENTER");
    this.touch(sessionId, "running");
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.integration.sendKeys(sessionId, "CTRL_C");
    this.touch(sessionId, "waiting");
  }

  async startAgent(request: StartAgentRequest): Promise<AgentSession> {
    if (request.agent !== "claude") throw new Error("Herdr terminal adapter only supports Claude");
    const sessionId = requireSessionId(request);
    const record = await this.integration.startClaude(
      request,
      this.options.sessionEnv(sessionId, request),
      this.options.taskIdForSession?.(sessionId)
    );
    const session = this.sessionFromRecord(record, request);
    this.sessions.set(sessionId, session);
    this.events.emit("fleet", {
      kind: "topology",
      sessionId,
      workspaceId: session.workspaceId,
      agent: "claude",
      status: "running",
      at: session.lastActivityAt,
      name: "herdr.claude.started"
    } satisfies FleetEvent);
    return { ...session };
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    await this.integration.close(sessionId);
    this.sessions.delete(sessionId);
    if (session) this.options.onSessionExit?.(sessionId, { status: "done" });
  }

  subscribeFleetEvents(handler: (event: FleetEvent) => void): () => void {
    this.events.on("fleet", handler);
    return () => this.events.off("fleet", handler);
  }

  private async probe(): Promise<void> {
    for (const [sessionId, session] of this.sessions) {
      try {
        if (await this.integration.paneIsLive(sessionId)) continue;
      } catch {
        continue;
      }
      this.sessions.delete(sessionId);
      this.options.onSessionExit?.(sessionId, { status: "error" });
      this.events.emit("fleet", {
        kind: "topology",
        sessionId,
        workspaceId: session.workspaceId,
        agent: "claude",
        status: "error",
        at: new Date().toISOString(),
        name: "herdr.claude.missing"
      } satisfies FleetEvent);
    }
  }

  private sessionFromRecord(record: HerdrWorkerPaneRecord, request?: StartAgentRequest): AgentSession {
    const now = new Date().toISOString();
    return {
      id: record.perchSessionId,
      title: request?.title?.trim() || "Claude worker",
      ...(request?.labels?.workerName ? { workerName: request.labels.workerName } : {}),
      agent: "claude",
      ...(request?.cwd ? { cwd: request.cwd } : {}),
      ...(request?.labels ? { labels: request.labels } : {}),
      workspaceId: record.workspaceId,
      paneId: record.paneId,
      surfaceId: record.terminalId ?? record.paneId,
      kind: "terminal",
      status: "running",
      lastActivityAt: now,
      ...(request?.model ? { model: request.model } : {})
    };
  }

  private require(sessionId: string): AgentSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown Herdr Claude session: ${sessionId}`);
    return session;
  }

  private touch(sessionId: string, status: AgentSessionStatus): void {
    const session = this.require(sessionId);
    session.status = status;
    session.lastActivityAt = new Date().toISOString();
  }
}

function paneIdentityFromResponse(response: unknown): HerdrPaneIdentity {
  const root = response as { result?: Record<string, unknown> };
  const result = root?.result ?? root;
  const source = (result as { agent?: Record<string, unknown>; pane?: Record<string, unknown> }).agent
    ?? (result as { pane?: Record<string, unknown> }).pane
    ?? result as Record<string, unknown>;
  const workspaceId = stringValue(source.workspace_id ?? source.workspaceId);
  const tabId = stringValue(source.tab_id ?? source.tabId);
  const paneId = stringValue(source.pane_id ?? source.paneId);
  if (!workspaceId || !tabId || !paneId) {
    throw new Error("Herdr response did not include a workspace, tab, and pane identity");
  }
  const terminalId = stringValue(source.terminal_id ?? source.terminalId);
  return { workspaceId, tabId, paneId, ...(terminalId ? { terminalId } : {}) };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isMissingPaneError(error: unknown): boolean {
  return /not found|unknown (pane|agent|terminal)|does not exist/i.test(errorMessage(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireSessionId(request: StartAgentRequest): string {
  if (!request.sessionId?.startsWith("pty:")) {
    throw new Error("Herdr workers require a Perch-minted PTY session id");
  }
  return request.sessionId;
}

function paneName(value: string): string {
  // Herdr's terminal title is user-visible. Keep it useful but never allow a
  // task prompt or an unbounded external label to enter a title/metadata path.
  return value.replace(/[\r\n\x00-\x1f]/g, " ").trim().slice(0, 80) || "Perch worker";
}

function herdrState(status: AgentSessionStatus): "idle" | "working" | "blocked" | "unknown" {
  switch (status) {
    case "idle":
    case "done":
      return "idle";
    case "running":
      return "working";
    case "waiting":
    case "needs_approval":
    case "error":
      return "blocked";
    default:
      return "unknown";
  }
}

// Kept here so tests can build a real integration around StateDb without
// exposing its whole shape to transport callers.
export function herdrPaneRepository(stateDb: StateDb): HerdrWorkerPaneRepository {
  return stateDb.herdrWorkerPanes;
}
