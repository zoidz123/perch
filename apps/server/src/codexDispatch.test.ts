import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession, RecentEventsResult, StartAgentRequest } from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import type { CodexAppServerClient } from "./adapters/codexAppServer.js";
import { CodexDaemonManager } from "./adapters/codexDaemon.js";
import { AuditLog } from "./audit.js";
import { CodexControlPlane } from "./codexControl.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { HookRegistry } from "./hooks.js";
import { createControlServer } from "./http.js";
import { DeviceRegistry } from "./pairing.js";
import { PrPoller } from "./prPoller.js";
import { ProjectRegistry } from "./projects.js";
import { TaskStore } from "./tasks.js";
import { TimelineStore } from "./timeline.js";
import { WorktreePool } from "./worktrees.js";

// Regression: a dispatched (computer-started) codex worker runs daemon-driven,
// so its rollout tailer attaches ONLY via the control client hearing the
// daemon's one-shot `thread/started` broadcast. Two ways this went dark:
// - The `codex --remote` TUI dials the already-healthy daemon and opens its
//   thread the instant it spawns, so a control client attached after
//   adapter.startAgent misses the broadcast (no replay) and never learns the
//   thread id. The server must connect the control client BEFORE spawning.
// - Codex creates the rollout FILE only at the thread's first turn (the
//   dispatched kickoff flushes on a 12s fallback), so a resolver pass started
//   at thread/started can find nothing; turn signals must re-arm it.
// This test models both: the broadcast fires at spawn time to already-
// connected clients only, and the rollout file appears only "at the first
// turn", after the dispatch request has already returned.

const THREAD_ID = "0197aaaa-bbbb-7ccc-8ddd-eeeeffff0001";
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The daemon's broadcast bus: notifications reach only the clients that are
// already connected when they fire - exactly like the real app-server.
const bus = {
  listeners: [] as Array<{ onThreadStarted: (threadId: string) => void; onTurnComplete?: (ev: { message: string }) => void }>,
  broadcast(threadId: string): void {
    for (const listener of [...this.listeners]) listener.onThreadStarted(threadId);
  },
  completeTurn(message: string): void {
    for (const listener of [...this.listeners]) listener.onTurnComplete?.({ message });
  }
};

class DispatchAdapter implements AgentAdapter {
  readonly name = "fake-pty";
  sessions: AgentSession[] = [];
  // How many control clients were connected at the moment each TUI spawned.
  connectedAtSpawn: number[] = [];

  async getTopology() {
    return { windows: [], generatedAt: "" };
  }
  async listSessions(): Promise<AgentSession[]> {
    return this.sessions;
  }
  async readRecentEvents(): Promise<RecentEventsResult> {
    return { events: [], terminal: true };
  }
  async sendInput(): Promise<void> {}
  async sendEnter(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async startAgent(request: StartAgentRequest): Promise<AgentSession> {
    const id = request.sessionId ?? `pty:${randomUUID()}`;
    const session: AgentSession = {
      id,
      title: request.title ?? request.command,
      agent: request.agent ?? "codex",
      cwd: request.cwd,
      workspaceId: "perch-pty",
      paneId: id,
      surfaceId: id,
      kind: "terminal",
      status: "running",
      lastActivityAt: new Date().toISOString()
    };
    this.sessions.push(session);
    this.connectedAtSpawn.push(bus.listeners.length);
    // The `--remote` TUI opens its thread the moment it spawns.
    bus.broadcast(THREAD_ID);
    return session;
  }
}

test("a dispatched codex worker's timeline reaches a client that did not start it", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-dispatch-home-"));
  const codexHome = mkdtempSync(join(tmpdir(), "perch-dispatch-codex-"));
  const repo = mkdtempSync(join(tmpdir(), "perch-dispatch-repo-"));
  const priorCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;

  // The project the task dispatches into (worktree pool needs a real repo).
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# demo\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });

  // Where codex will lazily create the rollout at the thread's first turn.
  const now = new Date();
  const day = join(
    codexHome,
    "sessions",
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  );
  mkdirSync(day, { recursive: true });
  const writeRollout = () =>
    writeFileSync(
      join(day, `rollout-2026-01-01T00-00-00-${THREAD_ID}.jsonl`),
      [
        JSON.stringify({ timestamp: "t1", type: "event_msg", payload: { type: "user_message", message: "kickoff" } }),
        JSON.stringify({
          timestamp: "t2",
          type: "event_msg",
          payload: { type: "agent_message", message: "pong from the worker" }
        })
      ].join("\n") + "\n"
    );

  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  const adapter = new DispatchAdapter();
  const tasks = new TaskStore(env);
  const timeline = new TimelineStore();
  const codexControl = new CodexControlPlane({
    enabled: true,
    daemonManager: new CodexDaemonManager({
      env,
      spawn: () => ({ pid: 1, onExit() {}, kill() {} }),
      waitHealthy: async () => {}
    }),
    createClient: ({ onThreadStarted, onTurnComplete }) => {
      const client = {
        threadId: null,
        async connect() {
          bus.listeners.push({ onThreadStarted, onTurnComplete });
        },
        async disconnect() {},
        isConnected: () => true
      };
      return client as unknown as CodexAppServerClient;
    }
  });
  const server = createControlServer({
    adapter,
    auditLog: new AuditLog(join(home, "audit.jsonl")),
    authToken: "test-token",
    boxSecretKey: new Uint8Array(32),
    monitor: new FleetMonitor(adapter, { broadcastMs: 5 }),
    devices: new DeviceRegistry(env),
    port: 0,
    hooks: new HookRegistry(),
    timeline,
    projects: new ProjectRegistry(env),
    worktrees: new WorktreePool({ env }),
    tasks,
    prPoller: new PrPoller(tasks, async () => {
      throw new Error("gh disabled in tests");
    }),
    codexControl
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const authed = { headers: { authorization: "Bearer test-token", "content-type": "application/json" } };

  try {
    const created = await fetch(`http://127.0.0.1:${port}/tasks`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ title: "repro", project: repo, dispatch: true, agent: "codex", prompt: "go" })
    });
    assert.equal(created.status, 201);
    const task = ((await created.json()) as { task: { sessionId?: string } }).task;
    assert.ok(task.sessionId, "dispatch linked a session");

    // The control client must already be connected when the TUI spawns, or
    // the one-shot thread/started above was missed and nothing below works.
    assert.deepEqual(adapter.connectedAtSpawn, [1]);

    // The first turn runs after dispatch returned: codex creates the rollout
    // now, and the turn's completion (which the control client streams) must
    // (re-)arm the resolver.
    writeRollout();
    bus.completeTurn("pong from the worker");

    // A phone that did not originate the session fetches its timeline.
    const deadline = Date.now() + 5_000;
    let items: Array<{ kind: string; text?: string }> = [];
    while (Date.now() < deadline) {
      const fetched = await fetch(
        `http://127.0.0.1:${port}/sessions/${encodeURIComponent(task.sessionId)}/timeline`,
        authed
      );
      items = ((await fetched.json()) as { items: typeof items }).items;
      if (items.some((item) => item.kind === "assistant")) break;
      await tick(50);
    }
    assert.ok(
      items.some((item) => item.kind === "assistant" && item.text === "pong from the worker"),
      `expected the persisted assistant reply, got: ${JSON.stringify(items)}`
    );
  } finally {
    timeline.stop();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = priorCodexHome;
    for (const dir of [home, codexHome, repo]) rmSync(dir, { recursive: true, force: true });
  }
});
