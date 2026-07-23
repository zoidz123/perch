import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession, RecentEventsResult } from "@perch/shared";
import { WebSocket } from "ws";
import { CodexAppServerAdapter } from "./adapters/codexAppServerAdapter.js";
import type { CodexDaemonManager } from "./adapters/codexDaemon.js";
import { FakeCodexAppServer } from "./adapters/fakeCodexAppServer.js";
import type { PtyAgentAdapter } from "./adapters/pty.js";
import { RoutingAgentAdapter } from "./adapters/routingAdapter.js";
import type { AgentAdapter } from "./adapters/types.js";
import { AuditLog } from "./audit.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { HookRegistry } from "./hooks.js";
import { createControlServer } from "./http.js";
import { DeviceRegistry } from "./pairing.js";
import { PrPoller } from "./prPoller.js";
import { ProjectRegistry } from "./projects.js";
import { TaskStore } from "./tasks.js";
import { TimelineStore } from "./timeline.js";
import { WorktreePool } from "./worktrees.js";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(deadlineMs: number, check: () => boolean): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await tick(10);
  }
  return check();
}

class NoPtyAdapter implements AgentAdapter {
  readonly name = "no-pty";

  async getTopology() {
    return { windows: [], generatedAt: "" };
  }

  async listSessions(): Promise<AgentSession[]> {
    return [];
  }

  async readRecentEvents(): Promise<RecentEventsResult> {
    return { events: [], terminal: true };
  }

  async sendInput(): Promise<void> {
    throw new Error("owned Codex sessions must not reach the PTY adapter");
  }

  async sendEnter(): Promise<void> {
    throw new Error("owned Codex sessions must not reach the PTY adapter");
  }

  async interrupt(): Promise<void> {}
  stop(): void {}
}

test("a direct-LAN fleet WebSocket updates an owned Codex mate before its long safety reconcile", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-codex-fleet-home-"));
  const repo = mkdtempSync(join(tmpdir(), "perch-codex-fleet-repo-"));
  const socketDir = mkdtempSync(join(tmpdir(), "perch-codex-fleet-socket-"));
  const socketPath = join(socketDir, "app-server.sock");
  let client: WebSocket | undefined;
  let server: ReturnType<typeof createControlServer> | undefined;
  let monitor: FleetMonitor | undefined;
  let timeline: TimelineStore | undefined;
  let tasks: TaskStore | undefined;
  let codexOwned: CodexAppServerAdapter | undefined;
  const fake = new FakeCodexAppServer();

  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "# Codex fleet lifecycle\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
    await fake.start(socketPath);

    const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
    codexOwned = new CodexAppServerAdapter({
      daemons: {
        acquire: async () => ({ socketPath, cwd: repo }),
        release: () => {},
        adoptExisting: async () => null,
        currentRuntimeFingerprint: () => "fleet-test"
      } as unknown as CodexDaemonManager,
      reconnectDelaysMs: [5]
    });
    const adapter = new RoutingAgentAdapter(new NoPtyAdapter() as unknown as PtyAgentAdapter, codexOwned);
    tasks = new TaskStore(env);
    timeline = new TimelineStore();
    monitor = new FleetMonitor(adapter, {
      reconcileMs: 60_000,
      broadcastMs: 1
    });
    server = createControlServer({
      adapter,
      codexOwned,
      auditLog: new AuditLog(join(home, "audit.jsonl")),
      authToken: "test-token",
      boxSecretKey: new Uint8Array(32),
      monitor,
      devices: new DeviceRegistry(env),
      port: 0,
      hooks: new HookRegistry(),
      timeline,
      projects: new ProjectRegistry(env),
      worktrees: new WorktreePool({ env }),
      tasks,
      prPoller: new PrPoller(tasks, async () => {
        throw new Error("gh disabled in tests");
      })
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const frames: AgentSession[][] = [];
    client = new WebSocket(`ws://127.0.0.1:${port}/fleet?token=test-token`);
    client.on("message", (raw) => {
      const payload = JSON.parse(raw.toString()) as { type?: string; sessions?: AgentSession[] };
      if (payload.type === "fleet" && payload.sessions) frames.push(payload.sessions);
    });

    assert.ok(await until(1_000, () => frames.length > 0), "direct-LAN client received its initial fleet frame");

    const mateId = "pty:codex-mate";
    const startedAt = Date.now();
    await codexOwned.startOwned({
      command: "codex",
      agent: "codex",
      cwd: repo,
      sessionId: mateId,
      labels: { role: "mate" }
    });
    assert.ok(
      await until(1_000, () => frames.some((sessions) => sessions.some((session) => session.id === mateId))),
      "owned Codex mate reached the real fleet WebSocket without waiting for the 60-second safety reconcile"
    );
    assert.ok(Date.now() - startedAt < 1_000, "mate topology invalidated promptly");

    const framesBeforeStop = frames.length;
    await codexOwned.stopSession(mateId);
    assert.ok(
      await until(1_000, () =>
        frames.slice(framesBeforeStop).some((sessions) => !sessions.some((session) => session.id === mateId))
      ),
      "explicit owned-session removal reached the fleet WebSocket promptly"
    );

    const disconnectedMateId = "pty:codex-mate-disconnected";
    await codexOwned.startOwned({
      command: "codex",
      agent: "codex",
      cwd: repo,
      sessionId: disconnectedMateId,
      labels: { role: "mate" }
    });
    assert.ok(
      await until(1_000, () => frames.some((sessions) => sessions.some((session) => session.id === disconnectedMateId))),
      "second owned Codex mate reached the fleet before disconnect coverage"
    );

    const framesBeforeDisconnect = frames.length;
    await fake.stop();
    assert.ok(
      await until(1_000, () =>
        frames
          .slice(framesBeforeDisconnect)
          .some((sessions) => !sessions.some((session) => session.id === disconnectedMateId))
      ),
      "exhausted app-server disconnect removed the errored Codex mate through the fleet WebSocket promptly"
    );
  } finally {
    client?.close();
    monitor?.closeAllClients();
    codexOwned?.stop();
    monitor?.stop();
    timeline?.stop();
    server?.closeAllConnections?.();
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await fake.stop().catch(() => {});
    tasks?.close();
    for (const dir of [home, repo, socketDir]) rmSync(dir, { recursive: true, force: true });
  }
});
