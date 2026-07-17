import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession, RecentEventsResult, WebSocketRpcRequest } from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import { AuditLog } from "./audit.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { HookRegistry } from "./hooks.js";
import { createControlServer, handleWebSocketRpcRequest } from "./http.js";
import { DeviceRegistry } from "./pairing.js";
import { PrPoller } from "./prPoller.js";
import { ProjectRegistry } from "./projects.js";
import { TaskStore } from "./tasks.js";
import { TimelineStore } from "./timeline.js";
import { WorktreePool } from "./worktrees.js";

// POST /worktrees/:id/release frees orphaned pool leases (dead session, closed
// task) that no other API can reach. It refuses live holders with 409, honors
// the pool's own landed-gate without force, and discards with {"force":true}.
// The same verb rides the WS/relay RPC surface.

class StubAdapter implements AgentAdapter {
  readonly name = "fake-pty";
  sessions: AgentSession[] = [];
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
}

function makeRepo(home: string): string {
  const dir = join(home, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "pipe" });
  const run = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  run(["config", "user.email", "t@t"]);
  run(["config", "user.name", "t"]);
  writeFileSync(join(dir, "readme.md"), "hello\n");
  run(["add", "."]);
  run(["commit", "-qm", "init"]);
  return dir;
}

type Fixture = {
  port: number;
  home: string;
  repo: string;
  adapter: StubAdapter;
  tasks: TaskStore;
  worktrees: WorktreePool;
  rpc: (method: "GET" | "POST" | "DELETE", path: string, body?: unknown) => ReturnType<typeof handleWebSocketRpcRequest>;
};

async function withServer(run: (ctx: Fixture) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "perch-wt-http-"));
  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  const adapter = new StubAdapter();
  const monitor = new FleetMonitor(adapter, { broadcastMs: 5 });
  const tasks = new TaskStore(env);
  const worktrees = new WorktreePool({ env });
  const timeline = new TimelineStore();
  const options = {
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
    worktrees,
    tasks,
    prPoller: new PrPoller(tasks, async () => {
      throw new Error("gh disabled in tests");
    })
  };
  const server = createControlServer(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const rpc: Fixture["rpc"] = (method, path, body) =>
    handleWebSocketRpcRequest(
      { type: "rpc", id: "t", method, path, ...(body ? { body } : {}) } as WebSocketRpcRequest,
      { kind: "server" },
      options
    );
  try {
    await run({ port, home, repo: makeRepo(home), adapter, tasks, worktrees, rpc });
  } finally {
    timeline.stop();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}

const authed = { authorization: "Bearer test-token", "content-type": "application/json" };

function sessionRecord(id: string, status: AgentSession["status"]): AgentSession {
  return {
    id,
    title: "worker",
    agent: "claude",
    kind: "terminal",
    status,
    lastActivityAt: new Date(0).toISOString()
  };
}

function release(port: number, id: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/worktrees/${encodeURIComponent(id)}/release`, {
    method: "POST",
    headers: authed,
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}

test("release honors the landed-gate without force and discards with force", async () => {
  await withServer(async ({ port, repo, worktrees }) => {
    const lease = await worktrees.acquire(repo, "pty:dead");
    writeFileSync(join(lease.path, "scratch.txt"), "uncommitted\n");

    const refused = await release(port, lease.id);
    assert.equal(refused.status, 409);
    const body = (await refused.json()) as { error: string };
    assert.match(body.error, /uncommitted changes; pass force to discard/);
    assert.equal(worktrees.find(lease.id)?.leasedBy, "pty:dead", "refused release keeps the lease");

    const forced = await release(port, lease.id, { force: true });
    assert.equal(forced.status, 200);
    const forcedBody = (await forced.json()) as { ok: boolean; worktree?: { leasedBy?: string } };
    assert.equal(forcedBody.ok, true);
    assert.equal(worktrees.find(lease.id)?.leasedBy, undefined, "forced release frees the slot");
    assert.ok(!existsSync(join(lease.path, "scratch.txt")), "forced release cleans the tree");
  });
});

test("release refuses 409 while the holder session is still alive", async () => {
  await withServer(async ({ port, repo, adapter, worktrees }) => {
    const lease = await worktrees.acquire(repo, "pty:alive");
    adapter.sessions = [sessionRecord("pty:alive", "running")];

    const refused = await release(port, lease.id, { force: true });
    assert.equal(refused.status, 409);
    const body = (await refused.json()) as { error: string };
    assert.match(body.error, /live session/);
    assert.equal(worktrees.find(lease.id)?.leasedBy, "pty:alive");

    // A session record that already ended does not count as alive.
    adapter.sessions = [sessionRecord("pty:alive", "done")];
    const freed = await release(port, lease.id);
    assert.equal(freed.status, 200);
    assert.equal(worktrees.find(lease.id)?.leasedBy, undefined);
  });
});

test("release refuses 409 while the leased task is not closed", async () => {
  await withServer(async ({ port, repo, tasks, worktrees }) => {
    const lease = await worktrees.acquire(repo, "pty:worker");
    const task = tasks.create({ title: "ship the thing", project: repo });
    tasks.update(task.id, { sessionId: "pty:worker", worktreeId: lease.id });
    tasks.recordEvent(task.id, { kind: "working", source: "worker" });

    const refused = await release(port, lease.id, { force: true });
    assert.equal(refused.status, 409);
    const body = (await refused.json()) as { error: string };
    assert.match(body.error, /teardown/);
    assert.equal(worktrees.find(lease.id)?.leasedBy, "pty:worker");

    // Closed task: the lease is orphaned and the verb goes through.
    tasks.recordEvent(task.id, { kind: "failed", source: "system" });
    tasks.recordEvent(task.id, { kind: "closed", source: "system" });
    const freed = await release(port, lease.id);
    assert.equal(freed.status, 200);
    assert.equal(worktrees.find(lease.id)?.leasedBy, undefined);
  });
});

test("release 404s for unknown worktrees", async () => {
  await withServer(async ({ port }) => {
    const missing = await release(port, "wt:nope/1");
    assert.equal(missing.status, 404);
    const body = (await missing.json()) as { error: string };
    assert.match(body.error, /Unknown worktree/);
  });
});

test("the RPC surface (relay path) mirrors POST /worktrees/:id/release", async () => {
  await withServer(async ({ repo, worktrees, rpc }) => {
    const lease = await worktrees.acquire(repo, "pty:dead");
    writeFileSync(join(lease.path, "scratch.txt"), "uncommitted\n");

    const refused = await rpc("POST", `/worktrees/${encodeURIComponent(lease.id)}/release`);
    assert.equal(refused.status, 409);
    assert.match(refused.ok ? "" : (refused.error ?? ""), /uncommitted/);

    const forced = await rpc("POST", `/worktrees/${encodeURIComponent(lease.id)}/release`, { force: true });
    assert.equal(forced.status, 200);
    assert.ok(forced.ok);
    assert.equal(worktrees.find(lease.id)?.leasedBy, undefined);
  });
});
