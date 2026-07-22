import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodexAppServerAdapter } from "./adapters/codexAppServerAdapter.js";
import type { CodexDaemonManager } from "./adapters/codexDaemon.js";
import { FakeCodexAppServer } from "./adapters/fakeCodexAppServer.js";
import type { PtyAgentAdapter } from "./adapters/pty.js";
import { RoutingAgentAdapter } from "./adapters/routingAdapter.js";
import type { AgentAdapter } from "./adapters/types.js";
import type { AgentSession, RecentEventsResult } from "@perch/shared";
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

// End-to-end dispatch over the app-server-owned topology: POST /tasks
// launches the worker through the real owning adapter against a fake daemon
// on a real unix socket; the kickoff is the first acknowledged turn/start;
// protocol notifications feed the timeline; and a phone that did not start
// the session reads the full conversation from GET /timeline. No PTY, no
// rollout scanning, no hooks - the protocol is the only source.

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class NoPtyAdapter implements AgentAdapter {
  readonly name = "fake-pty";
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
    throw new Error("codex must never reach the PTY backend");
  }
  async sendEnter(): Promise<void> {
    throw new Error("codex must never reach the PTY backend");
  }
  async interrupt(): Promise<void> {}
  async startAgent(): Promise<AgentSession> {
    throw new Error("codex must never reach the PTY backend");
  }
  stop(): void {}
}

test("a dispatched codex worker's timeline reaches a client that did not start it, protocol-native", async () => {
  const home = mkdtempSync(join(tmpdir(), "pxd-"));
  const repo = mkdtempSync(join(tmpdir(), "pxd-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# demo\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });

  const socketDir = mkdtempSync(join(tmpdir(), "pxds-"));
  const socketPath = join(socketDir, "s");
  const fake = new FakeCodexAppServer();
  await fake.start(socketPath);

  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  const pty = new NoPtyAdapter();
  const codexOwned = new CodexAppServerAdapter({
    daemons: {
      acquire: async () => ({ socketPath, cwd: repo }),
      release: () => {},
      adoptExisting: async () => null
    } as unknown as CodexDaemonManager
  });
  const adapter = new RoutingAgentAdapter(pty as unknown as PtyAgentAdapter, codexOwned);
  const tasks = new TaskStore(env);
  const timeline = new TimelineStore();
  const monitor = new FleetMonitor(adapter, { broadcastMs: 5 });
  // Mirror the index.ts wiring: protocol notifications own the timeline.
  codexOwned.wireEvents({
    onTimelineItem: (item, live) => timeline.ingest(item, { live })
  });
  const server = createControlServer({
    adapter,
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
    }),
    codexOwned
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
    assert.equal(created.status, 201, await created.clone().text());
    const task = ((await created.json()) as { task: { id: string; sessionId?: string } }).task;
    assert.ok(task.sessionId, "dispatch linked a session");

    // The kickoff lands as the acknowledged first turn; the model answers.
    const deadlineKickoff = Date.now() + 5_000;
    while (Date.now() < deadlineKickoff && !fake.threads.get("thr_1")?.activeTurnId) await tick(20);
    assert.equal(fake.thread("thr_1").activeTurnId, "turn_1", "the kickoff started turn 1");
    const kickoffItem = fake
      .thread("thr_1")
      .turns[0]!.items.find((item) => item.type === "userMessage");
    assert.equal(kickoffItem?.clientId, `perch-kickoff:${task.id}`);
    fake.completeActiveTurn("thr_1", "pong from the worker");

    // The durable ledger carries the acknowledged kickoff contract.
    const deadlineLedger = Date.now() + 5_000;
    while (
      Date.now() < deadlineLedger &&
      !tasks.events(task.id).some((event) => event.data?.reason === "kickoff_accepted")
    ) {
      await tick(20);
    }
    assert.ok(tasks.events(task.id).some((event) => event.data?.reason === "kickoff_accepted"));

    // A phone that did not originate the session fetches its timeline.
    const deadline = Date.now() + 5_000;
    let items: Array<{ kind: string; text?: string }> = [];
    while (Date.now() < deadline) {
      const fetched = await fetch(
        `http://127.0.0.1:${port}/sessions/${encodeURIComponent(task.sessionId!)}/timeline`,
        authed
      );
      items = ((await fetched.json()) as { items: typeof items }).items;
      if (items.some((item) => item.kind === "assistant")) break;
      await tick(50);
    }
    assert.ok(
      items.some((item) => item.kind === "user" && item.text?.startsWith("go")),
      `expected the kickoff user row, got: ${JSON.stringify(items)}`
    );
    assert.ok(
      items.some((item) => item.kind === "assistant" && item.text === "pong from the worker"),
      `expected the assistant reply, got: ${JSON.stringify(items)}`
    );
  } finally {
    codexOwned.stop();
    timeline.stop();
    monitor.stop();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fake.stop().catch(() => {});
    tasks.close();
    for (const dir of [home, repo, socketDir]) rmSync(dir, { recursive: true, force: true });
  }
});
