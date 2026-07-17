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
import { createControlServer } from "./http.js";
import { DeviceRegistry } from "./pairing.js";
import { PrPoller } from "./prPoller.js";
import { ProjectRegistry } from "./projects.js";
import { TaskStore } from "./tasks.js";
import { TimelineStore } from "./timeline.js";
import { WorktreePool } from "./worktrees.js";

// Dispatch-time plan-id stamping and lookup-by-plan over HTTP: POST /tasks
// accepts planId (and defaults it from a planEdit), and GET /tasks?planId
// filters to exactly the tasks stamped with that plan.

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

async function withServer(run: (ctx: { port: number; tasks: TaskStore }) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "perch-task-plan-"));
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
    prPoller: new PrPoller(tasks, async () => {
      throw new Error("gh disabled in tests");
    })
  };
  const server = createControlServer(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run({ port, tasks });
  } finally {
    timeline.stop();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}

const bearer = { authorization: "Bearer test-token", "content-type": "application/json" };

function createTask(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/tasks`, { method: "POST", headers: bearer, body: JSON.stringify(body) });
}

test("POST /tasks stamps planId and GET /tasks?planId filters to the stamped tasks", async () => {
  await withServer(async ({ port }) => {
    const plan = "docs/plans/2026-07-08-hub.md";
    const a = await createTask(port, { title: "build the hub", project: "/tmp/repo", planId: plan });
    assert.equal(a.status, 201);
    assert.equal(((await a.json()) as { task: Task }).task.planId, plan);
    await createTask(port, { title: "hub follow-up", project: "/tmp/repo", planId: plan });
    await createTask(port, { title: "unrelated", project: "/tmp/repo" });

    const filtered = await fetch(`http://127.0.0.1:${port}/tasks?planId=${encodeURIComponent(plan)}`, {
      headers: bearer
    });
    assert.equal(filtered.status, 200);
    const { tasks } = (await filtered.json()) as TasksResponse;
    assert.equal(tasks.length, 2);
    assert.ok(tasks.every((task) => task.planId === plan));

    // No planId filter returns everything (append-only: the old shape still works).
    const all = await fetch(`http://127.0.0.1:${port}/tasks`, { headers: bearer });
    assert.equal(((await all.json()) as TasksResponse).tasks.length, 3);
  });
});

test("a planEdit defaults planId to the edited plan's path and validates the path", async () => {
  await withServer(async ({ port }) => {
    const path = "docs/plans/2026-07-08-hub.md";
    const ok = await createTask(port, {
      title: "revise the hub plan",
      project: "/tmp/repo",
      planEdit: { path, content: "# Hub plan\n\nrevised\n" }
    });
    assert.equal(ok.status, 201);
    // planId defaults to the edited plan's path so the edit's own task is
    // discoverable by listByPlan.
    assert.equal(((await ok.json()) as { task: Task }).task.planId, path);

    // A path outside docs/plans, with traversal, or not .md is refused with 400.
    for (const bad of ["README.md", "docs/plans/../secret.md", "docs/plans/x.txt", "docs/plans/nested/x.md"]) {
      const refused = await createTask(port, {
        title: "bad edit",
        project: "/tmp/repo",
        planEdit: { path: bad, content: "x" }
      });
      assert.equal(refused.status, 400, `path ${bad} must be refused`);
      assert.match(((await refused.json()) as { error: string }).error, /planEdit\.path/);
    }

    // Missing content is refused too.
    const noContent = await createTask(port, {
      title: "no content",
      project: "/tmp/repo",
      planEdit: { path }
    });
    assert.equal(noContent.status, 400);
    assert.match(((await noContent.json()) as { error: string }).error, /planEdit\.content/);
  });
});
