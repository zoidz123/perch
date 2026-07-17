import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RecentEventsResult } from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import { AuditLog } from "./audit.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { HookRegistry } from "./hooks.js";
import { createControlServer } from "./http.js";
import { DeviceRegistry } from "./pairing.js";
import { PrPoller } from "./prPoller.js";
import { ProjectRegistry } from "./projects.js";
import { StateMetrics } from "./stateMetrics.js";
import { TaskStore } from "./tasks.js";
import { TimelineStore } from "./timeline.js";
import { WorktreePool } from "./worktrees.js";

test("metrics count edges by source, counters, and latency percentiles", () => {
  const metrics = new StateMetrics();

  metrics.recordSessionStatus("pty:a", "running", "idle", "hook");
  metrics.recordSessionStatus("pty:a", "idle", "running", "hook");
  metrics.recordSessionStatus("pty:b", "running", "idle", "reconciler");
  metrics.recordSessionStatus("pty:c", undefined, "running", "adapter");
  metrics.recordTaskTransition("t-1", "working", "done", "done", "worker");
  metrics.recordTaskTransition("t-2", "working", "blocked", "blocked", "system");
  metrics.increment("reconciler.corrections");
  metrics.increment("reconciler.corrections");
  for (let value = 1; value <= 100; value += 1) {
    metrics.observe("reconciler.correctionLagMs", value);
  }

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.sessionEdges["running->idle"]?.hook, 1);
  assert.equal(snapshot.sessionEdges["running->idle"]?.reconciler, 1);
  assert.equal(snapshot.sessionEdges["?->running"]?.adapter, 1);
  assert.equal(snapshot.taskEdges["working->done"]?.worker, 1);
  assert.equal(snapshot.taskEdges["working->blocked"]?.system, 1);
  assert.equal(snapshot.counters["reconciler.corrections"], 2);

  const lag = snapshot.latenciesMs["reconciler.correctionLagMs"];
  assert.equal(lag?.count, 100);
  assert.equal(lag?.max, 100);
  assert.ok(lag !== undefined && lag.p95 >= 95 && lag.p95 <= 100);
  assert.ok(lag !== undefined && lag.p50 >= 50 && lag.p50 <= 60);

  // The rolling transition log carries provenance and stays bounded.
  assert.equal(snapshot.recent.length, 6);
  for (let index = 0; index < 200; index += 1) {
    metrics.recordSessionStatus("pty:spam", "idle", "running", "hook");
  }
  assert.equal(metrics.snapshot().recent.length, 100);
});

test("GET /doctor/state-metrics serves the counted snapshot behind bearer auth", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-metrics-"));
  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  const adapter: AgentAdapter = {
    name: "fake",
    async getTopology() {
      return { windows: [], generatedAt: "" };
    },
    async listSessions() {
      return [];
    },
    async readRecentEvents(): Promise<RecentEventsResult> {
      return { events: [], terminal: true };
    },
    async sendInput() {},
    async sendEnter() {},
    async interrupt() {}
  };
  const metrics = new StateMetrics();
  const tasks = new TaskStore(env);
  const server = createControlServer({
    adapter,
    auditLog: new AuditLog(join(home, "audit.jsonl")),
    authToken: "test-token",
    boxSecretKey: new Uint8Array(32),
    monitor: new FleetMonitor(adapter),
    devices: new DeviceRegistry(env),
    port: 0,
    hooks: new HookRegistry(),
    timeline: new TimelineStore(),
    projects: new ProjectRegistry(env),
    worktrees: new WorktreePool({ env }),
    tasks,
    prPoller: new PrPoller(tasks, async () => undefined),
    metrics
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    metrics.recordSessionStatus("pty:a", "running", "idle", "reconciler");
    metrics.increment("reconciler.corrections");

    const denied = await fetch(`http://127.0.0.1:${port}/doctor/state-metrics`);
    assert.equal(denied.status, 401);

    const fetched = await fetch(`http://127.0.0.1:${port}/doctor/state-metrics`, {
      headers: { authorization: "Bearer test-token" }
    });
    assert.equal(fetched.status, 200);
    const body = (await fetched.json()) as ReturnType<StateMetrics["snapshot"]>;
    assert.equal(body.sessionEdges["running->idle"]?.reconciler, 1);
    assert.equal(body.counters["reconciler.corrections"], 1);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});
