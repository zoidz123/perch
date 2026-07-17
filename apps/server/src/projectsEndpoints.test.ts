import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

// First-class project add/remove: POST /projects rejects paths that are not
// real directories, DELETE /projects unregisters - refusing while any
// non-closed task still references the path - and the same behavior rides the
// WS/relay RPC surface so phones work off-LAN.

class NoopAdapter implements AgentAdapter {
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
  async sendInput(): Promise<void> {}
  async sendEnter(): Promise<void> {}
  async interrupt(): Promise<void> {}
}

type Fixture = {
  port: number;
  home: string;
  tasks: TaskStore;
  projects: ProjectRegistry;
  rpc: (method: "GET" | "POST" | "DELETE", path: string, body?: unknown) => ReturnType<typeof handleWebSocketRpcRequest>;
};

async function withServer(run: (ctx: Fixture) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "perch-projects-http-"));
  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  const adapter = new NoopAdapter();
  const monitor = new FleetMonitor(adapter, { broadcastMs: 5 });
  const tasks = new TaskStore(env);
  const projects = new ProjectRegistry(env);
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
    projects,
    worktrees: new WorktreePool({ env }),
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
    await run({ port, home, tasks, projects, rpc });
  } finally {
    timeline.stop();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}

const authed = { authorization: "Bearer test-token", "content-type": "application/json" };

function call(port: number, method: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/projects`, {
    method,
    headers: authed,
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}

test("POST /projects registers a real directory and rejects nonexistent paths with 400", async () => {
  await withServer(async ({ port, home }) => {
    const dir = join(home, "repo");
    mkdirSync(dir);

    const ok = await call(port, "POST", { rootPath: dir, mode: "direct-PR" });
    assert.equal(ok.status, 200);
    const { project } = (await ok.json()) as { project: { rootPath: string; mode?: string } };
    assert.equal(project.rootPath, dir);
    assert.equal(project.mode, "direct-PR");

    const missing = await call(port, "POST", { rootPath: join(home, "nope") });
    assert.equal(missing.status, 400);
    const body = (await missing.json()) as { error: string };
    assert.match(body.error, /Not a directory/);
  });
});

test("DELETE /projects unregisters a project (body or query), leaving disk untouched", async () => {
  await withServer(async ({ port, home, projects }) => {
    const dir = join(home, "repo");
    mkdirSync(dir);
    projects.touch(dir);

    const removed = await call(port, "DELETE", { rootPath: dir });
    assert.equal(removed.status, 200);
    assert.equal(projects.find(dir), undefined);
    assert.ok((await import("node:fs")).existsSync(dir), "removal never touches the directory itself");

    // Query form, and the 404 for a path that is not registered.
    projects.touch(dir);
    const viaQuery = await fetch(
      `http://127.0.0.1:${port}/projects?rootPath=${encodeURIComponent(dir)}`,
      { method: "DELETE", headers: authed }
    );
    assert.equal(viaQuery.status, 200);

    const unknown = await call(port, "DELETE", { rootPath: join(home, "never-registered") });
    assert.equal(unknown.status, 404);
  });
});

test("DELETE /projects refuses with 409 while a non-closed task references the project", async () => {
  await withServer(async ({ port, home, projects, tasks }) => {
    const dir = join(home, "repo");
    mkdirSync(dir);
    projects.touch(dir);
    const task = tasks.create({ title: "ship the thing", project: dir });

    const refused = await call(port, "DELETE", { rootPath: dir });
    assert.equal(refused.status, 409);
    const body = (await refused.json()) as { error: string };
    assert.match(body.error, /live task/);
    assert.match(body.error, /ship the thing/);
    assert.ok(projects.find(dir), "refused delete leaves the project registered");

    // Close the task; removal now goes through.
    tasks.recordEvent(task.id, { kind: "done", source: "system" });
    tasks.recordEvent(task.id, { kind: "closed", source: "system" });
    const removed = await call(port, "DELETE", { rootPath: dir });
    assert.equal(removed.status, 200);
  });
});

test("the RPC surface (relay path) mirrors POST and DELETE /projects", async () => {
  await withServer(async ({ home, projects, tasks, rpc }) => {
    const dir = join(home, "repo");
    mkdirSync(dir);

    const added = await rpc("POST", "/projects", { rootPath: dir });
    assert.equal(added.status, 200);
    assert.ok(added.ok);
    assert.ok(projects.find(dir));

    const badAdd = await rpc("POST", "/projects", { rootPath: join(home, "nope") });
    assert.equal(badAdd.status, 400);

    const task = tasks.create({ title: "live work", project: dir });
    const refused = await rpc("DELETE", "/projects", { rootPath: dir });
    assert.equal(refused.status, 409);
    assert.match(refused.ok ? "" : (refused.error ?? ""), /live task/);

    tasks.recordEvent(task.id, { kind: "failed", source: "system" });
    tasks.recordEvent(task.id, { kind: "closed", source: "system" });
    const removed = await rpc("DELETE", "/projects", { rootPath: dir });
    assert.equal(removed.status, 200);
    assert.equal(projects.find(dir), undefined);
  });
});
