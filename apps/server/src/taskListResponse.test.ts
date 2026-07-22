import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession, RecentEventsResult, Task, TasksResponse } from "@perch/shared";
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

const RELAY_FRAME_LIMIT = 1024 * 1024;

class NoopAdapter implements AgentAdapter {
  readonly name = "fake-pty";
  async getTopology() { return { windows: [], generatedAt: "" }; }
  async listSessions(): Promise<AgentSession[]> { return []; }
  async readRecentEvents(): Promise<RecentEventsResult> { return { events: [], terminal: true }; }
  async sendInput(): Promise<void> {}
  async sendEnter(): Promise<void> {}
  async interrupt(): Promise<void> {}
}

async function withServer(run: (ctx: {
  port: number;
  tasks: TaskStore;
  rpc: (path: string) => ReturnType<typeof handleWebSocketRpcRequest>;
}) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "perch-task-list-"));
  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  const adapter = new NoopAdapter();
  const monitor = new FleetMonitor(adapter, { broadcastMs: 5 });
  const tasks = new TaskStore(env);
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
    worktrees: new WorktreePool({ env }),
    tasks,
    prPoller: new PrPoller(tasks, async () => { throw new Error("gh disabled in tests"); })
  };
  const server = createControlServer(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run({
      port,
      tasks,
      rpc: (path) => handleWebSocketRpcRequest(
        { type: "rpc", id: "task-list", method: "GET", path },
        { kind: "device", deviceId: "phone" },
        options
      )
    });
  } finally {
    timeline.stop();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    tasks.close();
    rmSync(home, { recursive: true, force: true });
  }
}

const bearer = { authorization: "Bearer test-token" };

test("GET /tasks defaults to the prompt-free live snapshot while includeClosed preserves the full ledger", async () => {
  await withServer(async ({ port, tasks, rpc }) => {
    const prompt = "x".repeat(2_400);
    for (let index = 0; index < 450; index += 1) {
      const task = tasks.create({ title: `closed ${index}`, project: "/tmp/repo", prompt });
      tasks.recordEvent(task.id, { kind: "failed", source: "worker" });
      tasks.recordEvent(task.id, { kind: "closed", source: "system" });
    }
    const live = tasks.create({ title: "still live", project: "/tmp/repo", prompt: "private live brief" });

    const full = await fetch(`http://127.0.0.1:${port}/tasks?includeClosed=1`, { headers: bearer });
    const fullText = await full.text();
    assert.ok(Buffer.byteLength(fullText) > RELAY_FRAME_LIMIT, "the old full-ledger response exceeds the relay frame cap");
    const fullTasks = (JSON.parse(fullText) as TasksResponse).tasks;
    assert.equal(fullTasks.length, 451);
    assert.equal(fullTasks.find((task) => task.id === live.id)?.prompt, "private live brief");

    const response = await fetch(`http://127.0.0.1:${port}/tasks`, { headers: bearer });
    const responseText = await response.text();
    const listed = (JSON.parse(responseText) as TasksResponse).tasks;
    assert.ok(Buffer.byteLength(responseText) < RELAY_FRAME_LIMIT / 10, "the live snapshot stays comfortably below 1 MiB");
    assert.deepEqual(listed.map((task) => task.id), [live.id]);
    assert.ok(listed.every((task) => !("prompt" in task)));

    const relayResponse = await rpc("/tasks");
    assert.equal(relayResponse.ok, true);
    const relayTasks = (relayResponse.ok ? relayResponse.body : undefined) as TasksResponse;
    assert.deepEqual(relayTasks.tasks.map((task) => task.id), [live.id]);
    assert.ok(relayTasks.tasks.every((task) => !("prompt" in task)));

    const detail = await fetch(`http://127.0.0.1:${port}/tasks/${encodeURIComponent(live.id)}`, { headers: bearer });
    assert.equal(((await detail.json()) as { task: Task }).task.prompt, "private live brief");
  });
});
