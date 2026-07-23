import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  AgentSession,
  Chart,
  ChartsHubResponse,
  FinalizeChartResponse,
  PendingApproval,
  RecentEventsResult
} from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import { AuditLog } from "./audit.js";
import {
  ChartRegistry,
  buildChartsHub,
  chartChromeAsset,
  chartReviewHtml,
  chartSdkJs,
  collectChartAssetRefs,
  formatChartFeedback,
  formatLayoutWarnings,
  injectChartSdk,
  resolveChartAsset,
  scanPlanDocs,
  wireChartArchive,
  type ChartEventKind
} from "./charts.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { wireChartWake, wireMateWake } from "./mateWake.js";
import { HookRegistry } from "./hooks.js";
import { createControlServer, handleWebSocketRpcRequest } from "./http.js";
import { OwnerManager } from "./ownerManager.js";
import { DeviceRegistry } from "./pairing.js";
import { PrPoller } from "./prPoller.js";
import { ProjectRegistry } from "./projects.js";
import { TaskStore } from "./tasks.js";
import { TaskCompletionReconciler } from "./taskCompletion.js";
import { TimelineStore } from "./timeline.js";
import { WorktreePool } from "./worktrees.js";

// Charts server core: registration
// auth (hook token + bearer), SDK injection, asset confinement, feedback
// normalization and delivery through the queue-gated composer path, the
// dead-session error, and the layout-audit intake.

class FakeAdapter implements AgentAdapter {
  readonly name = "fake-pty";
  sessions: AgentSession[] = [];
  submitted: Array<{ sessionId: string; text: string }> = [];
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
  async submitInput(sessionId: string, text: string): Promise<boolean> {
    this.submitted.push({ sessionId, text });
    return true;
  }
}

function liveSession(id: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
    title: "claude",
    agent: "claude",
    kind: "terminal",
    status: "running",
    lastActivityAt: new Date().toISOString(),
    ...overrides
  } as AgentSession;
}

type Fixture = {
  port: number;
  home: string;
  adapter: FakeAdapter;
  charts: ChartRegistry;
  chartEvents: Array<{ chart: Chart; kind: ChartEventKind }>;
  hooks: HookRegistry;
  tasks: TaskStore;
  ownerManager: OwnerManager;
  monitor: FleetMonitor;
  completedTurns: Array<{ sessionId: string; provider: string }>;
  chartFile: string;
  // The exact options object the server runs on, for driving the WebSocket
  // RPC surface (handleWebSocketRpcRequest) against the same state.
  options: Parameters<typeof createControlServer>[0];
};

async function withServer(run: (ctx: Fixture) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "perch-charts-"));
  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  const adapter = new FakeAdapter();
  const monitor = new FleetMonitor(adapter, { broadcastMs: 5 });
  const tasks = new TaskStore(env);
  const ownerManager = new OwnerManager(tasks);
  const timeline = new TimelineStore();
  const charts = new ChartRegistry(env);
  const chartEvents: Fixture["chartEvents"] = [];
  charts.subscribe((chart, event) => chartEvents.push({ chart, kind: event.kind }));
  const hooks = new HookRegistry();
  const completedTurns: Fixture["completedTurns"] = [];
  tasks.subscribe((_task, event) => {
    if (event.kind === "turn_completed") {
      completedTurns.push({
        sessionId: String(event.data?.sessionId ?? ""),
        provider: String(event.data?.provider ?? "")
      });
    }
  });
  const options = {
    adapter,
    auditLog: new AuditLog(join(home, "audit.jsonl")),
    authToken: "test-token",
    boxSecretKey: new Uint8Array(32),
    monitor,
    devices: new DeviceRegistry(env),
    port: 0,
    hooks,
    timeline,
    projects: new ProjectRegistry(env),
    worktrees: new WorktreePool({ env }),
    tasks,
    ownerManager,
    prPoller: new PrPoller(tasks, async () => {
      throw new Error("gh disabled in tests");
    }),
    charts,
    taskCompletion: new TaskCompletionReconciler({ tasks })
  };
  const server = createControlServer(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const chartDir = join(home, "drawings");
  mkdirSync(chartDir);
  const chartFile = join(chartDir, "roadmap.html");
  writeFileSync(chartFile, "<html><body><h1>Roadmap</h1></body></html>");
  try {
    await run({ port, home, adapter, charts, chartEvents, hooks, tasks, ownerManager, monitor, completedTurns, chartFile, options });
  } finally {
    charts.stop();
    timeline.stop();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}

function recordLiveMate(ownerManager: OwnerManager, sessionId: string): void {
  const runtime = ownerManager.beginMateLaunch({
    command: "claude",
    agent: "claude",
    sessionId,
    cwd: "/tmp/perch-mate"
  });
  ownerManager.markLive(runtime, sessionId);
}

const bearer = { authorization: "Bearer test-token", "content-type": "application/json" };

function hookHeaders(sessionId: string, token: string): Record<string, string> {
  return { "x-perch-session": sessionId, "x-perch-token": token, "content-type": "application/json" };
}

function post(port: number, path: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function reviewAuth(response: Response): Promise<{ nonce: string; cookie: string; html: string }> {
  const html = await response.text();
  const rawJson = /<script id="perch-chart-session" type="application\/json">([^<]+)<\/script>/.exec(html)?.[1];
  assert.ok(rawJson, "review page includes session JSON");
  const session = JSON.parse(rawJson) as { reviewNonce?: string };
  assert.ok(session.reviewNonce, "review page includes a scoped review nonce");
  const setCookie = response.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /perch_chart_review_/);
  return { nonce: session.reviewNonce, cookie: setCookie.split(";", 1)[0] ?? "", html };
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("POST /charts registers with the session hook token and binds the session's open task", async () => {
  await withServer(async ({ port, adapter, hooks, tasks, chartFile, chartEvents }) => {
    const sessionId = "pty:worker";
    adapter.sessions = [liveSession(sessionId)];
    const { token } = hooks.register(sessionId);
    const task = tasks.create({ title: "draw the roadmap", project: "/tmp/p" });
    tasks.update(task.id, { sessionId });

    const response = await post(port, "/charts", hookHeaders(sessionId, token), { file: chartFile });
    assert.equal(response.status, 201);
    const body = (await response.json()) as { chart: Chart; url: string };
    assert.equal(body.chart.sessionId, sessionId);
    assert.equal(body.chart.taskId, task.id);
    assert.equal(body.chart.name, "roadmap");
    assert.equal(body.url, `/charts/${body.chart.id}`);
    assert.equal(chartEvents.length, 1);
    assert.equal(chartEvents[0]?.kind, "registered");
  });
});

test("POST /charts rejects a bad hook token and non-server bearer callers", async () => {
  await withServer(async ({ port, hooks, chartFile }) => {
    hooks.register("pty:worker");
    const wrong = await post(port, "/charts", hookHeaders("pty:worker", "not-the-token"), { file: chartFile });
    assert.equal(wrong.status, 401);

    // A paired device's token must not register charts (fail-closed).
    const created = await post(port, "/devices", bearer, { name: "phone" });
    assert.equal(created.status, 201);
    const { offer } = (await created.json()) as { offer: { token: string } };
    const device = await post(
      port,
      "/charts",
      { authorization: `Bearer ${offer.token}`, "content-type": "application/json" },
      { file: chartFile }
    );
    assert.equal(device.status, 403);
  });
});

test("POST /charts with the server token needs a LIVE explicit sessionId (the mate path)", async () => {
  await withServer(async ({ port, adapter, chartFile }) => {
    const missing = await post(port, "/charts", bearer, { file: chartFile });
    assert.equal(missing.status, 400);

    const unknown = await post(port, "/charts", bearer, { file: chartFile, sessionId: "pty:ghost" });
    assert.equal(unknown.status, 400);

    adapter.sessions = [liveSession("pty:mate", { labels: { role: "mate" } })];
    const ok = await post(port, "/charts", bearer, { file: chartFile, sessionId: "pty:mate" });
    assert.equal(ok.status, 201);
    const body = (await ok.json()) as { chart: Chart };
    assert.equal(body.chart.sessionId, "pty:mate");
  });
});

test("POST /charts refuses paths that are not existing HTML files", async () => {
  await withServer(async ({ port, adapter, home }) => {
    adapter.sessions = [liveSession("pty:mate")];
    const nowhere = await post(port, "/charts", bearer, { file: join(home, "nope.html"), sessionId: "pty:mate" });
    assert.equal(nowhere.status, 400);
    const notHtml = join(home, "notes.txt");
    writeFileSync(notHtml, "hi");
    const wrongType = await post(port, "/charts", bearer, { file: notHtml, sessionId: "pty:mate" });
    assert.equal(wrongType.status, 400);
    assert.match(((await wrongType.json()) as { error: string }).error, /HTML/);
  });
});

test("GET /charts/:id serves the chart with the SDK injected", async () => {
  await withServer(async ({ port, adapter, chartFile }) => {
    adapter.sessions = [liveSession("pty:mate")];
    const registered = await post(port, "/charts", bearer, { file: chartFile, sessionId: "pty:mate" });
    const { chart } = (await registered.json()) as { chart: Chart };

    const anonymous = await fetch(`http://127.0.0.1:${port}/charts/${chart.id}`);
    assert.equal(anonymous.status, 200);

    const response = await fetch(`http://127.0.0.1:${port}/charts/${chart.id}`, { headers: bearer });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const html = await response.text();
    assert.match(html, /<h1>Roadmap<\/h1>/);
    // The injected SDK sits inline before </body> (no second authed fetch).
    assert.ok(html.includes("createArtifactSdk(deriveLavishQueueKey"));
    assert.ok(html.replace(/\s+/g, "").endsWith("</script></body></html>"));
  });
});

test("sibling assets are directory-confined: traversal is 403, siblings serve", async () => {
  await withServer(async ({ port, adapter, chartFile, home }) => {
    adapter.sessions = [liveSession("pty:mate")];
    writeFileSync(join(home, "drawings", "notes.txt"), "sibling ok");
    writeFileSync(join(home, "secret.txt"), "outside");
    const registered = await post(port, "/charts", bearer, { file: chartFile, sessionId: "pty:mate" });
    const { chart } = (await registered.json()) as { chart: Chart };

    const sibling = await fetch(`http://127.0.0.1:${port}/charts/${chart.id}/notes.txt`, { headers: bearer });
    assert.equal(sibling.status, 200);
    assert.equal(await sibling.text(), "sibling ok");

    const traversal = await fetch(`http://127.0.0.1:${port}/charts/${chart.id}/..%2Fsecret.txt`, {
      headers: bearer
    });
    assert.equal(traversal.status, 403);

    const absolute = await fetch(
      `http://127.0.0.1:${port}/charts/${chart.id}/${encodeURIComponent("/etc/hosts")}`,
      { headers: bearer }
    );
    assert.equal(absolute.status, 403);
  });
});

test("resolveChartAsset confines assets to the chart directory", () => {
  assert.equal(resolveChartAsset("/tmp/charts", "diagram.svg"), "/tmp/charts/diagram.svg");
  assert.equal(resolveChartAsset("/tmp/charts", "sub/diagram.svg"), "/tmp/charts/sub/diagram.svg");
  assert.equal(resolveChartAsset("/tmp/charts", "../escape.txt"), null);
  assert.equal(resolveChartAsset("/tmp/charts", "sub/../../escape.txt"), null);
  assert.equal(resolveChartAsset("/tmp/charts", "/etc/passwd"), null);
});

test("feedback normalizes into a readable [perch chart] block", () => {
  const chart = {
    id: "abc",
    name: "roadmap",
    file: "/tmp/roadmap.html",
    sessionId: "pty:s",
    registeredAt: "",
    updatedAt: ""
  } as Chart;
  const block = formatChartFeedback(chart, {
    message: "overall direction is right",
    annotations: [
      { prompt: "make this the goal", selector: "h1", tag: "h1", text: "Roadmap" },
      { prompt: "tighten this", tag: "text", text: "the exact selected words", target: { type: "text-range" } },
      { prompt: "split this step", target: { type: "mermaid-node", label: "Deploy", nodeId: "n3" } }
    ]
  });
  const lines = block.split("\n");
  assert.equal(lines[0], "[perch chart] roadmap · 4 notes");
  assert.equal(lines[1], '1. h1 "Roadmap" - make this the goal');
  assert.equal(lines[2], '2. text "the exact selected words" - tighten this');
  assert.equal(lines[3], '3. diagram node "Deploy" - split this step');
  assert.equal(lines[4], "4. overall direction is right");
  assert.match(lines[5] ?? "", /Update the chart file in place/);
});

test("feedback lands in the owning session's composer and the audit log", async () => {
  await withServer(async ({ port, adapter, chartFile, home }) => {
    adapter.sessions = [liveSession("pty:worker")];
    const registered = await post(port, "/charts", bearer, { file: chartFile, sessionId: "pty:worker" });
    const { chart } = (await registered.json()) as { chart: Chart };

    const empty = await post(port, `/charts/${chart.id}/feedback`, bearer, {});
    assert.equal(empty.status, 400);

    const response = await post(port, `/charts/${chart.id}/feedback`, bearer, {
      annotations: [{ prompt: "bigger title", selector: "h1", text: "Roadmap" }]
    });
    assert.equal(response.status, 202);
    const body = (await response.json()) as { ok: boolean; queued: boolean };
    assert.equal(body.queued, false);
    assert.equal(adapter.submitted.length, 1);
    assert.equal(adapter.submitted[0]?.sessionId, "pty:worker");
    assert.match(adapter.submitted[0]?.text ?? "", /^\[perch chart\] roadmap · 1 note/);

    const audit = await import("node:fs/promises").then((fs) => fs.readFile(join(home, "audit.jsonl"), "utf8"));
    assert.match(audit, /"action":"chart_feedback"/);
    assert.match(audit, new RegExp(`"chartId":"${chart.id}"`));
  });
});

test("feedback queues (never injects) while a permission prompt is open", async () => {
  await withServer(async ({ port, adapter, monitor, chartFile }) => {
    adapter.sessions = [liveSession("pty:worker", { status: "needs_approval" })];
    const registered = await post(port, "/charts", bearer, { file: chartFile, sessionId: "pty:worker" });
    const { chart } = (await registered.json()) as { chart: Chart };
    monitor.setPendingApproval("pty:worker", {
      id: "appr-1",
      summary: "Run rm -rf",
      at: new Date().toISOString()
    } as PendingApproval);

    const response = await post(port, `/charts/${chart.id}/feedback`, bearer, { message: "looks good" });
    assert.equal(response.status, 202);
    const body = (await response.json()) as { queued: boolean };
    assert.equal(body.queued, true);
    // Nothing reached the PTY: the block waits behind the open prompt.
    assert.equal(adapter.submitted.length, 0);
  });
});

test("feedback from an ended worker routes whole-chart feedback to its registered live parent", async () => {
  await withServer(async ({ port, adapter, hooks, tasks, ownerManager, chartFile, home }) => {
    adapter.sessions = [
      liveSession("pty:worker", { labels: { parent: "pty:attacker" } }),
      liveSession("pty:mate", { labels: { role: "mate" } })
    ];
    const task = tasks.create({ title: "draw the roadmap", project: "/tmp/p" });
    tasks.update(task.id, { sessionId: "pty:worker", parentSessionId: "pty:mate" });
    recordLiveMate(ownerManager, "pty:mate");
    const { token } = hooks.register("pty:worker");
    const registered = await post(port, "/charts", hookHeaders("pty:worker", token), { file: chartFile });
    const { chart } = (await registered.json()) as { chart: Chart };
    assert.equal(chart.parentSessionId, "pty:mate");

    adapter.sessions = [liveSession("pty:mate", { labels: { role: "mate" } })];
    const response = await post(port, `/charts/${chart.id}/feedback`, bearer, {
      message: "Keep the decision visible",
      sessionId: "pty:attacker"
    });
    assert.equal(response.status, 202);
    assert.equal(adapter.submitted.length, 1);
    assert.equal(adapter.submitted[0]?.sessionId, "pty:mate");
    assert.match(adapter.submitted[0]?.text ?? "", /Keep the decision visible/);

    const audit = await import("node:fs/promises").then((fs) => fs.readFile(join(home, "audit.jsonl"), "utf8"));
    assert.match(audit, /"sessionId":"pty:mate"/);
  });
});

test("feedback from an ended worker routes element annotations to its registered live parent", async () => {
  await withServer(async ({ port, adapter, hooks, tasks, ownerManager, chartFile }) => {
    adapter.sessions = [
      liveSession("pty:worker", { labels: { parent: "pty:attacker" } }),
      liveSession("pty:mate", { labels: { role: "mate" } })
    ];
    const task = tasks.create({ title: "annotate the roadmap", project: "/tmp/p" });
    tasks.update(task.id, { sessionId: "pty:worker", parentSessionId: "pty:mate" });
    recordLiveMate(ownerManager, "pty:mate");
    const { token } = hooks.register("pty:worker");
    const registered = await post(port, "/charts", hookHeaders("pty:worker", token), { file: chartFile });
    const { chart } = (await registered.json()) as { chart: Chart };

    adapter.sessions = [liveSession("pty:mate", { labels: { role: "mate" } })];
    const response = await post(port, `/charts/${chart.id}/feedback`, bearer, {
      annotations: [{ prompt: "Make this precise", selector: "h1", tag: "h1", text: "Roadmap" }]
    });
    assert.equal(response.status, 202);
    assert.equal(adapter.submitted.length, 1);
    assert.equal(adapter.submitted[0]?.sessionId, "pty:mate");
    assert.match(adapter.submitted[0]?.text ?? "", /h1 "Roadmap" - Make this precise/);
  });
});

test("feedback stays truthful when neither the worker nor its registered parent is live", async () => {
  await withServer(async ({ port, adapter, hooks, tasks, ownerManager, chartFile }) => {
    adapter.sessions = [
      liveSession("pty:worker", { labels: { parent: "pty:attacker" } }),
      liveSession("pty:intended-mate", { labels: { role: "mate" } })
    ];
    const task = tasks.create({ title: "review the roadmap", project: "/tmp/p" });
    tasks.update(task.id, { sessionId: "pty:worker", parentSessionId: "pty:intended-mate" });
    recordLiveMate(ownerManager, "pty:intended-mate");
    const { token } = hooks.register("pty:worker");
    const registered = await post(port, "/charts", hookHeaders("pty:worker", token), { file: chartFile });
    const { chart } = (await registered.json()) as { chart: Chart };

    adapter.sessions = [liveSession("pty:other-mate", { labels: { role: "mate" } })];
    const response = await post(port, `/charts/${chart.id}/feedback`, bearer, { message: "who reads this?" });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { error: string; alternatives: string[] };
    assert.match(body.error, /registered parent \(pty:intended-mate\) are unavailable/);
    assert.deepEqual(body.alternatives, ["new_agent"]);
    assert.equal(adapter.submitted.length, 0);
  });
});

test("feedback rejects a labeled parent without live Mate ownership", async () => {
  await withServer(async ({ port, adapter, hooks, tasks, chartFile }) => {
    adapter.sessions = [
      liveSession("pty:worker"),
      liveSession("pty:parent", { labels: { role: "mate" } })
    ];
    const task = tasks.create({ title: "verify the roadmap", project: "/tmp/p" });
    tasks.update(task.id, { sessionId: "pty:worker", parentSessionId: "pty:parent" });
    const { token } = hooks.register("pty:worker");
    const registered = await post(port, "/charts", hookHeaders("pty:worker", token), { file: chartFile });
    const { chart } = (await registered.json()) as { chart: Chart };
    assert.equal(chart.parentSessionId, undefined);

    adapter.sessions = [liveSession("pty:parent", { labels: { role: "mate" } })];
    const response = await post(port, `/charts/${chart.id}/feedback`, bearer, { message: "do not misroute" });
    assert.equal(response.status, 409);
    assert.equal(adapter.submitted.length, 0);
  });
});

test("feedback reports a delivery race as recipient unavailable", async () => {
  await withServer(async ({ port, adapter, hooks, tasks, ownerManager, monitor, chartFile }) => {
    adapter.sessions = [liveSession("pty:worker"), liveSession("pty:mate", { labels: { role: "mate" } })];
    const task = tasks.create({ title: "race the roadmap", project: "/tmp/p" });
    tasks.update(task.id, { sessionId: "pty:worker", parentSessionId: "pty:mate" });
    recordLiveMate(ownerManager, "pty:mate");
    const { token } = hooks.register("pty:worker");
    const registered = await post(port, "/charts", hookHeaders("pty:worker", token), { file: chartFile });
    const { chart } = (await registered.json()) as { chart: Chart };

    adapter.sessions = [liveSession("pty:mate", { labels: { role: "mate" } })];
    for (const message of [
      "worker session has ended; follow-up input was not accepted",
      "Unknown PTY session: pty:mate",
      "Session pty:mate has ended",
      "unknown codex app-server session: pty:mate"
    ]) {
      monitor.queueOrSubmit = async () => {
        throw new Error(message);
      };
      const response = await post(port, `/charts/${chart.id}/feedback`, bearer, { message: "too late" });
      assert.equal(response.status, 409);
    }
    assert.equal(adapter.submitted.length, 0);
  });
});

test("feedback retries the verified parent when the owner exits during delivery", async () => {
  await withServer(async ({ port, adapter, hooks, tasks, ownerManager, monitor, chartFile }) => {
    adapter.sessions = [
      liveSession("pty:worker"),
      liveSession("pty:mate", { labels: { role: "mate" } })
    ];
    const task = tasks.create({ title: "retry the roadmap", project: "/tmp/p" });
    tasks.update(task.id, { sessionId: "pty:worker", parentSessionId: "pty:mate" });
    recordLiveMate(ownerManager, "pty:mate");
    const { token } = hooks.register("pty:worker");
    const registered = await post(port, "/charts", hookHeaders("pty:worker", token), { file: chartFile });
    const { chart } = (await registered.json()) as { chart: Chart };

    const queueOrSubmit = monitor.queueOrSubmit.bind(monitor);
    monitor.queueOrSubmit = async (...args) => {
      if (args[0] === "pty:worker") {
        adapter.sessions = [liveSession("pty:mate", { labels: { role: "mate" } })];
        throw new Error("Unknown PTY session: pty:worker");
      }
      return queueOrSubmit(...args);
    };
    const response = await post(port, `/charts/${chart.id}/feedback`, bearer, { message: "route this" });
    assert.equal(response.status, 202);
    assert.equal(adapter.submitted.length, 1);
    assert.equal(adapter.submitted[0]?.sessionId, "pty:mate");
  });
});

test("layout warnings deliver once as machine feedback and dedupe repeats", async () => {
  await withServer(async ({ port, adapter, chartFile }) => {
    adapter.sessions = [liveSession("pty:worker")];
    const registered = await post(port, "/charts", bearer, { file: chartFile, sessionId: "pty:worker" });
    const { chart } = (await registered.json()) as { chart: Chart };

    const warnings = {
      layout_warnings: [
        { selector: "div.card", kind: "clipped-text", overflowPx: 12.5, viewportWidth: 390, severity: "error" }
      ]
    };
    const first = await post(port, `/charts/${chart.id}/layout-warnings`, bearer, warnings);
    assert.equal(first.status, 202);
    assert.equal(((await first.json()) as { delivered: boolean }).delivered, true);
    assert.equal(adapter.submitted.length, 1);
    assert.match(adapter.submitted[0]?.text ?? "", /^\[perch chart layout\] roadmap · 1 finding/);
    assert.match(adapter.submitted[0]?.text ?? "", /automated layout audit, not the boss/);
    assert.match(adapter.submitted[0]?.text ?? "", /clipped-text at div\.card: 12\.5px overflow at 390px viewport \(error\)/);

    // The identical report (a reload) is dropped instead of spamming the agent.
    const repeat = await post(port, `/charts/${chart.id}/layout-warnings`, bearer, warnings);
    assert.equal(repeat.status, 200);
    assert.equal(((await repeat.json()) as { delivered: boolean }).delivered, false);
    assert.equal(adapter.submitted.length, 1);
  });
});

test("formatLayoutWarnings pluralizes and names the file to fix", () => {
  const chart = { id: "x", name: "n", file: "/tmp/n.html", sessionId: "s", registeredAt: "", updatedAt: "" } as Chart;
  const block = formatLayoutWarnings(chart, [
    { selector: "html", kind: "page-horizontal-overflow", overflowPx: 37, viewportWidth: 390, severity: "error" },
    { selector: "", kind: "overlapping-text", overflowPx: 0, viewportWidth: 390, severity: "warning" }
  ]);
  assert.match(block, /· 2 findings/);
  assert.match(block, /overlapping-text at \(page\)/);
  assert.match(block, /Fix these in \/tmp\/n\.html/);
});

test("editing a registered chart file emits an updated event (live refresh)", async () => {
  await withServer(async ({ port, adapter, chartFile, chartEvents }) => {
    adapter.sessions = [liveSession("pty:worker")];
    await post(port, "/charts", bearer, { file: chartFile, sessionId: "pty:worker" });
    assert.equal(chartEvents.filter((event) => event.kind === "registered").length, 1);

    writeFileSync(chartFile, "<html><body><h1>Roadmap v2</h1></body></html>");
    await waitFor(() => chartEvents.some((event) => event.kind === "updated"));
    const updated = chartEvents.find((event) => event.kind === "updated");
    assert.equal(updated?.chart.name, "roadmap");
  });
});

test("re-registering the same file mints a distinct chart and preserves the first owner", async () => {
  await withServer(async ({ port, adapter, chartFile, home, chartEvents }) => {
    adapter.sessions = [liveSession("pty:a"), liveSession("pty:b")];
    writeFileSync(chartFile, "<html><body><h1>First owner</h1></body></html>");
    const first = await post(port, "/charts", bearer, { file: chartFile, sessionId: "pty:a" });
    writeFileSync(chartFile, "<html><body><h1>Second owner</h1></body></html>");
    const second = await post(port, "/charts", bearer, { file: chartFile, sessionId: "pty:b" });
    const chartA = ((await first.json()) as { chart: Chart }).chart;
    const chartB = ((await second.json()) as { chart: Chart }).chart;
    assert.notEqual(chartA.id, chartB.id);
    assert.equal(chartA.sessionId, "pty:a");
    assert.equal(chartB.sessionId, "pty:b");
    assert.match(readFileSync(join(home, "charts", chartA.id, "index.html"), "utf8"), /First owner/);
    assert.match(readFileSync(join(home, "charts", chartB.id, "index.html"), "utf8"), /Second owner/);

    writeFileSync(chartFile, "<html><body><h1>Latest live edit</h1></body></html>");
    await waitFor(() => chartEvents.some((event) => event.kind === "updated" && event.chart.id === chartB.id));
    assert.match(readFileSync(join(home, "charts", chartB.id, "index.html"), "utf8"), /Latest live edit/);
    assert.match(readFileSync(join(home, "charts", chartA.id, "index.html"), "utf8"), /First owner/);

    const list = await fetch(`http://127.0.0.1:${port}/charts`, { headers: bearer });
    const { charts } = (await list.json()) as { charts: Chart[] };
    assert.equal(charts.length, 2);
  });
});

// --- The relay RPC surface: charts over the tunneled WebSocket ------------
// Relay clients cannot fetch raw HTML/bytes, so the document and sibling
// assets ride JSON rpc_responses (GET /charts/:id/html, /charts/:id/asset64).

function rpcGet(options: Fixture["options"], path: string) {
  return handleWebSocketRpcRequest(
    { type: "rpc", id: "t", method: "GET", path },
    { kind: "device", deviceId: "phone" },
    options as Parameters<typeof handleWebSocketRpcRequest>[2]
  );
}

test("GET /charts/:id/html over RPC returns the SDK-injected document as JSON", async () => {
  await withServer(async ({ adapter, hooks, charts, chartFile, options }) => {
    const sessionId = "pty:worker";
    adapter.sessions = [liveSession(sessionId)];
    hooks.register(sessionId);
    const chart = charts.register(chartFile, { sessionId });

    const response = await rpcGet(options, `/charts/${chart.id}/html`);
    assert.equal(response.ok, true);
    assert.equal(response.status, 200);
    const body = (response as { body: { chart: Chart; html: string } }).body;
    assert.equal(body.chart.id, chart.id);
    assert.ok(body.html.includes("<h1>Roadmap</h1>"));
    assert.ok(body.html.includes("createArtifactSdk"));

    const missing = await rpcGet(options, "/charts/nope/html");
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);
  });
});

test("GET /charts/:id/asset64 over RPC is base64, confined, and serves chart.css", async () => {
  await withServer(async ({ adapter, charts, chartFile, home, options }) => {
    const sessionId = "pty:worker";
    adapter.sessions = [liveSession(sessionId)];
    const chart = charts.register(chartFile, { sessionId });
    writeFileSync(join(home, "drawings", "diagram.svg"), "<svg/>");
    writeFileSync(join(home, "secret.txt"), "top secret");

    const asset = await rpcGet(options, `/charts/${chart.id}/asset64?path=diagram.svg`);
    assert.equal(asset.status, 200);
    const assetBody = (asset as { body: { base64: string; contentType: string } }).body;
    assert.equal(Buffer.from(assetBody.base64, "base64").toString("utf8"), "<svg/>");
    assert.equal(assetBody.contentType, "image/svg+xml");

    // chart.css resolves to the perch-owned stylesheet, not a chart sibling.
    const css = await rpcGet(options, `/charts/${chart.id}/asset64?path=chart.css`);
    assert.equal(css.status, 200);
    assert.equal((css as { body: { contentType: string } }).body.contentType, "text/css; charset=utf-8");

    const traversal = await rpcGet(options, `/charts/${chart.id}/asset64?path=..%2Fsecret.txt`);
    assert.equal(traversal.ok, false);
    assert.equal(traversal.status, 403);

    const empty = await rpcGet(options, `/charts/${chart.id}/asset64`);
    assert.equal(empty.status, 400);
  });
});

test("the SDK bundle assembles from the vendored source and parses", () => {
  const js = chartSdkJs();
  // Parse-only: browser globals are not needed to construct the function.
  assert.doesNotThrow(() => new Function(js));
  assert.ok(js.includes("createArtifactSdk(deriveLavishQueueKey"));
  assert.ok(js.includes("escapeAnnotationText(nodeLabel)"));
  assert.ok(!/^import /m.test(js));
  assert.ok(!/^export /m.test(js));
  const html = injectChartSdk("<html><body>x</body></html>", "console.log(1)");
  assert.ok(html.includes("console.log(1)\n</script></body>"));
  // Without a </body> the script appends at the end.
  assert.ok(injectChartSdk("plain", "1").endsWith("</script>"));
});

// --- T3: the desktop review chrome ------------------------------------------

test("GET /charts/:id/review serves local review chrome and iframe content without carrying a token", async () => {
  await withServer(async ({ port, adapter, chartFile }) => {
    adapter.sessions = [liveSession("pty:worker")];
    const registered = await post(port, "/charts", bearer, { file: chartFile, sessionId: "pty:worker" });
    const { chart } = (await registered.json()) as { chart: Chart };

    const anonymous = await fetch(`http://127.0.0.1:${port}/charts/${chart.id}/review`);
    assert.equal(anonymous.status, 200);
    assert.match(anonymous.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(anonymous.headers.get("referrer-policy"), "no-referrer");
    const { html: anonymousHtml, nonce } = await reviewAuth(anonymous);
    assert.match(anonymousHtml, /<iframe id="chart"[^>]*sandbox="allow-scripts/);
    assert.match(anonymousHtml, /<iframe id="chart"[^>]*referrerpolicy="no-referrer"/);
    assert.ok(anonymousHtml.includes(`data-chart-src="/charts/${chart.id}"`));
    assert.ok(!anonymousHtml.includes("token="));
    assert.ok(anonymousHtml.includes(`"reviewNonce":"${nonce}"`));

    const iframe = await fetch(`http://127.0.0.1:${port}/charts/${chart.id}`);
    assert.equal(iframe.status, 200);
    assert.match(await iframe.text(), /<h1>Roadmap<\/h1>/);

    const unknown = await fetch(`http://127.0.0.1:${port}/charts/nope/review`, { headers: bearer });
    assert.equal(unknown.status, 404);

    // Loopback review strips query tokens before rendering the chrome.
    const response = await fetch(`http://127.0.0.1:${port}/charts/${chart.id}/review?token=test-token`);
    assert.equal(response.status, 200);
    assert.equal(response.url, `http://127.0.0.1:${port}/charts/${chart.id}/review`);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const { html } = await reviewAuth(response);
    // The chart sits in a sandboxed iframe; the client loads it tokenless.
    assert.match(html, /<iframe id="chart"[^>]*sandbox="allow-scripts/);
    assert.match(html, /<iframe id="chart"[^>]*referrerpolicy="no-referrer"/);
    assert.ok(html.includes(`data-chart-src="/charts/${chart.id}"`));
    // The session blob binds the chrome to the chart and its owning session.
    assert.match(html, /<script id="perch-chart-session" type="application\/json">/);
    assert.ok(html.includes('"sessionId":"pty:worker"'));
    assert.ok(html.includes('src="/charts/chrome/chrome-client.js"'));
    // The HTML itself never embeds the presented token.
    assert.ok(!html.includes("test-token"));
  });
});

test("local chart review GET is easy, but POST feedback requires the review nonce", async () => {
  await withServer(async ({ port, adapter, chartFile }) => {
    adapter.sessions = [liveSession("pty:worker")];
    const registered = await post(port, "/charts", bearer, { file: chartFile, sessionId: "pty:worker" });
    const { chart } = (await registered.json()) as { chart: Chart };

    const list = await fetch(`http://127.0.0.1:${port}/charts`);
    assert.equal(list.status, 401);

    const tasks = await fetch(`http://127.0.0.1:${port}/tasks`);
    assert.equal(tasks.status, 401);

    const anonymousFeedback = await fetch(`http://127.0.0.1:${port}/charts/${chart.id}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "looks good" })
    });
    assert.equal(anonymousFeedback.status, 401);
    assert.equal(adapter.submitted.length, 0);

    const review = await fetch(`http://127.0.0.1:${port}/charts/${chart.id}/review`);
    assert.equal(review.status, 200);
    const { nonce, cookie } = await reviewAuth(review);
    const missingCookie = await fetch(`http://127.0.0.1:${port}/charts/${chart.id}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-perch-chart-review": nonce },
      body: JSON.stringify({ message: "still not enough" })
    });
    assert.equal(missingCookie.status, 401);
    const feedback = await fetch(`http://127.0.0.1:${port}/charts/${chart.id}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-perch-chart-review": nonce, cookie },
      body: JSON.stringify({ message: "looks good" })
    });
    assert.equal(feedback.status, 202);
    assert.equal(adapter.submitted.length, 1);
    assert.equal(adapter.submitted[0]?.sessionId, "pty:worker");
    assert.match(adapter.submitted[0]?.text ?? "", /^\[perch chart\] roadmap · 1 note\n1\. looks good/);

    const layout = await fetch(`http://127.0.0.1:${port}/charts/${chart.id}/layout-warnings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        layout_warnings: [{ selector: "h1", kind: "clipped-text", overflowPx: 10, viewportWidth: 390, severity: "error" }]
      })
    });
    assert.equal(layout.status, 401);

    const finalize = await fetch(`http://127.0.0.1:${port}/charts/${chart.id}/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(finalize.status, 401);
  });
});

test("GET /charts/gallery renders the registered charts behind auth", async () => {
  await withServer(async ({ port, adapter, chartFile }) => {
    adapter.sessions = [liveSession("pty:worker")];
    const registered = await post(port, "/charts", bearer, { file: chartFile, sessionId: "pty:worker" });
    const { chart } = (await registered.json()) as { chart: Chart };

    // Authed like the rest of the /charts surface.
    const anonymous = await fetch(`http://127.0.0.1:${port}/charts/gallery`);
    assert.equal(anonymous.status, 401);

    // "gallery" is matched before the /charts/:id capture, so it renders the
    // gallery, not a 404 "unknown chart".
    const response = await fetch(`http://127.0.0.1:${port}/charts/gallery?token=test-token`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const html = await response.text();
    assert.match(html, /Charts gallery/);
    assert.match(html, /<link rel="stylesheet" href="\/charts\/chart\.css">/);
    // The chart is listed with a tokenless link into its review room.
    assert.ok(html.includes(`href="/charts/${chart.id}/review"`));
    assert.ok(!html.includes("token=test-token"));
    assert.match(html, /roadmap/);
    // The ungrouped chart (no task) surfaces under its own section.
    assert.match(html, /<h2>Ungrouped<\/h2>/);
  });
});

test("chartReviewHtml escapes chart names and the session JSON", () => {
  const chart: Chart = {
    id: "abc",
    name: 'road<map> "v1"',
    file: "/tmp/road<map>.html",
    sessionId: "pty:worker",
    registeredAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z"
  };
  const html = chartReviewHtml(chart);
  assert.ok(html.includes("road&lt;map&gt; &quot;v1&quot;"));
  assert.ok(!html.includes("<map>"));
  // JSON blob escapes < so a name can never close the script tag early.
  assert.ok(html.includes('"name":"road\\u003cmap> \\"v1\\""'));
  assert.ok(html.includes('aria-keyshortcuts="Enter"'));
  assert.ok(html.includes('<kbd aria-hidden="true">↵</kbd>'));
  assert.ok(html.includes('<span class="composer-guide">Enter to send</span>'));
});

test("chart statics (chart.css + review chrome) serve WITHOUT auth as subresources", async () => {
  await withServer(async ({ port, adapter, chartFile }) => {
    adapter.sessions = [liveSession("pty:worker")];
    const registered = await post(port, "/charts", bearer, { file: chartFile, sessionId: "pty:worker" });
    const { chart } = (await registered.json()) as { chart: Chart };

    // A <link>/sandboxed iframe cannot attach the query token, and these are
    // perch-owned files shipped in the public repo - so no auth, like /health.
    const css = await fetch(`http://127.0.0.1:${port}/charts/chart.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);

    // Chart-relative ./chart.css (as authored per AUTHORING.md) also resolves.
    const relative = await fetch(`http://127.0.0.1:${port}/charts/${chart.id}/chart.css`);
    assert.equal(relative.status, 200);
    assert.match(relative.headers.get("content-type") ?? "", /text\/css/);

    const chromeCss = await fetch(`http://127.0.0.1:${port}/charts/chrome/chrome.css`);
    assert.equal(chromeCss.status, 200);
    assert.match(chromeCss.headers.get("content-type") ?? "", /text\/css/);
    assert.match(await chromeCss.text(), /--gold: #c9a227/);

    const chromeJs = await fetch(`http://127.0.0.1:${port}/charts/chrome/chrome-client.js`);
    assert.equal(chromeJs.status, 200);
    assert.match(chromeJs.headers.get("content-type") ?? "", /application\/javascript/);
    const chromeSource = await chromeJs.text();
    assert.match(chromeSource, /\/feedback/);
    assert.match(chromeSource, /x-perch-chart-review/);
    assert.ok(!chromeSource.includes("function authedUrl"));
    assert.ok(!chromeSource.includes("frame.src = authedUrl"));

    // Anything beyond the two chrome files 404s. Local browser review may load
    // chart-specific content without a bearer token, but only on loopback.
    const other = await fetch(`http://127.0.0.1:${port}/charts/chrome/server.js`);
    assert.equal(other.status, 404);
    const chartHtml = await fetch(`http://127.0.0.1:${port}/charts/${chart.id}`);
    assert.equal(chartHtml.status, 200);
  });
});

test("GET /charts/authoring serves the authoring guide as markdown WITHOUT auth", async () => {
  await withServer(async ({ port }) => {
    // Same class of perch-owned static as chart.css: the capability note in
    // every solo session points here, from repos with no perch checkout.
    const response = await fetch(`http://127.0.0.1:${port}/charts/authoring`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/markdown/);
    const markdown = await response.text();
    assert.match(markdown, /# Drawing charts/);
    assert.match(markdown, /chart\.css/);
    const mandates = [
      "**Verdict / Answer** - put one decisive line at the very top.",
      "### Exploratory report",
      "**Findings** - use at most four short bullets.",
      "**Evidence** - link or name the short proof behind the findings; do not paste an evidence dump.",
      "Do not force an exploratory report into Problem / Fix framing.",
      "### Code-change report",
      "**Root cause** - state the concrete cause in at most three short bullets.",
      "**Fix** - use at most four short bullets.",
      "**Verification** - name the tests, browser proof, or CI result that establishes the change.",
      "**Remaining risks** - optionally end with one short line.",
      "Keep the entire chart to one screen.",
      "Cut content until a reader can get the point in about 15 seconds.",
      "Prefer bullets, short cards, and tables over paragraphs.",
      "Reserve `<blockquote>` for one key line only."
    ];
    const bans = [
      "Narrative prose paragraphs.",
      "Restated background or context.",
      "Evidence dumps; link the evidence or drop it.",
      "ELI5 explanations or analogies unless the boss explicitly asks for them."
    ];
    for (const mandate of mandates) {
      assert.ok(markdown.includes(mandate), `missing authoring mandate: ${mandate}`);
    }
    for (const ban of bans) {
      assert.ok(markdown.includes(ban), `missing authoring ban: ${ban}`);
    }
  });
});

test("chart reference demonstrates the terse exploratory verdict-findings-evidence format", () => {
  const html = readFileSync(new URL("../assets/charts/reference.html", import.meta.url), "utf8");
  const verdict = html.indexOf("<h1>Exploratory charts should make evidence-led decisions in 15 seconds</h1>");
  const findings = html.indexOf("<h2>Findings</h2>");
  const evidence = html.indexOf("<h2>Evidence</h2>");
  assert.ok(verdict >= 0 && verdict < findings && findings < evidence);

  const findingsList = html.slice(findings, evidence);
  const evidenceList = html.slice(evidence);
  assert.equal([...findingsList.matchAll(/<li>/g)].length, 4);
  assert.equal([...evidenceList.matchAll(/<li>/g)].length, 2);
  assert.match(html, /<blockquote>Recommendation:/);
  assert.doesNotMatch(html, /<style\b|style=/);
});

test("POST /hooks answers SessionStart and Claude Stop records turn completion evidence", async () => {
  await withServer(async ({ port, adapter, hooks, tasks, completedTurns }) => {
    adapter.sessions = [liveSession("pty:worker")];
    const task = tasks.create({ title: "hook boundary", project: "/tmp/repo" });
    tasks.update(task.id, { sessionId: "pty:worker" });
    const { token } = hooks.register("pty:worker");
    const report = (body: object) =>
      fetch(`http://127.0.0.1:${port}/hooks`, {
        method: "POST",
        headers: {
          "x-perch-session": "pty:worker",
          "x-perch-token": token,
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      });

    // SessionStart carries Claude hook output: the installed SessionStart
    // hook echoes this body to stdout and Claude injects additionalContext.
    const start = await report({ hook_event_name: "SessionStart", session_id: "agent-1" });
    assert.equal(start.status, 200);
    const startBody = (await start.json()) as {
      hookSpecificOutput?: { hookEventName: string; additionalContext: string };
    };
    assert.equal(startBody.hookSpecificOutput?.hookEventName, "SessionStart");
    const note = startBody.hookSpecificOutput?.additionalContext ?? "";
    assert.match(note, /running under perch/);
    assert.match(note, /\$\{PERCH_HOOK_URL%\/hooks\}\/charts\/authoring/);
    assert.match(note, /\.charts\/<slug>\.html/);
    assert.match(note, /\[perch chart\]/);

    adapter.sessions = [liveSession("pty:worker", { agent: "codex", title: "codex" })];
    const codexStart = await report({
      session_id: "codex-agent-1",
      cwd: "/tmp/repo",
      hook_event_name: "SessionStart",
      source: "startup"
    });
    assert.equal(codexStart.status, 200);
    assert.deepEqual(await codexStart.json(), {
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: note }
    });
    adapter.sessions = [liveSession("pty:worker")];

    const turnStart = await report({ hook_event_name: "UserPromptSubmit" });
    assert.deepEqual((await turnStart.json()) as object, { ok: true });
    tasks.recordEvent(task.id, { kind: "working", source: "worker", message: "still working" });

    // A first missing-outcome Stop is durable and returns non-error feedback
    // that lets Claude continue once to report accurately.
    const stop = await report({ hook_event_name: "Stop" });
    const stopBody = (await stop.json()) as {
      hookSpecificOutput?: { hookEventName: string; additionalContext: string };
    };
    assert.equal(stopBody.hookSpecificOutput?.hookEventName, "Stop");
    assert.match(stopBody.hookSpecificOutput?.additionalContext ?? "", /retry-needed/);
    await waitFor(() => completedTurns.length === 1);
    assert.deepEqual(completedTurns, [{ sessionId: "pty:worker", provider: "claude" }]);
    assert.deepEqual(
      tasks.events(task.id).slice(-2).map((event) => event.kind),
      ["turn_completed", "stalled"]
    );

    // Provider loop guard: a repeated Stop is observed but never continued
    // again, and the existing stall remains single-shot.
    const repeated = await report({ hook_event_name: "Stop", stop_hook_active: true });
    assert.deepEqual((await repeated.json()) as object, {});
    assert.equal(tasks.events(task.id).filter((event) => event.kind === "stalled").length, 1);

    // An unverified report never gets the note.
    const forged = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: "POST",
      headers: {
        "x-perch-session": "pty:worker",
        "x-perch-token": "wrong",
        "content-type": "application/json"
      },
      body: JSON.stringify({ hook_event_name: "SessionStart" })
    });
    assert.deepEqual((await forged.json()) as object, { ok: false });
  });
});

test("chartChromeAsset is a fixed allowlist, never a filesystem path", () => {
  assert.ok(chartChromeAsset("chrome.css")?.path.endsWith("assets/charts/chrome/chrome.css"));
  assert.ok(chartChromeAsset("chrome-client.js")?.path.endsWith("assets/charts/chrome/chrome-client.js"));
  assert.equal(chartChromeAsset("../vendor/artifact-sdk.js"), undefined);
  assert.equal(chartChromeAsset("chrome.css/../chrome.css"), undefined);
  assert.equal(chartChromeAsset(""), undefined);
});

// --- T6: snapshots (charts outlive worktrees) + chain-of-command surfacing ---

test("registration snapshots the chart and its referenced siblings into ~/.perch/charts/<id>", async () => {
  await withServer(async ({ port, adapter, home, chartFile }) => {
    adapter.sessions = [liveSession("pty:worker")];
    mkdirSync(join(home, "drawings", "img"));
    writeFileSync(join(home, "drawings", "img", "logo.png"), "png-bytes");
    writeFileSync(join(home, "drawings", "unreferenced.txt"), "not copied");
    writeFileSync(
      chartFile,
      '<html><body><h1>Roadmap</h1><img src="img/logo.png"><a href="https://example.com/x">x</a></body></html>'
    );

    const registered = await post(port, "/charts", bearer, { file: chartFile, sessionId: "pty:worker" });
    const { chart } = (await registered.json()) as { chart: Chart };
    assert.ok(chart.snapshotAt);

    const snapshot = join(home, "charts", chart.id);
    assert.match(readFileSync(join(snapshot, "index.html"), "utf8"), /<h1>Roadmap<\/h1>/);
    assert.equal(readFileSync(join(snapshot, "img", "logo.png"), "utf8"), "png-bytes");
    // Only referenced siblings are copied; the rest of the directory is not.
    assert.ok(!existsSync(join(snapshot, "unreferenced.txt")));
  });
});

test("editing the chart re-snapshots (the durable copy tracks live refresh)", async () => {
  await withServer(async ({ port, adapter, home, chartFile, chartEvents }) => {
    adapter.sessions = [liveSession("pty:worker")];
    const registered = await post(port, "/charts", bearer, { file: chartFile, sessionId: "pty:worker" });
    const { chart } = (await registered.json()) as { chart: Chart };

    writeFileSync(chartFile, "<html><body><h1>Roadmap v2</h1></body></html>");
    await waitFor(() => chartEvents.some((event) => event.kind === "updated"));
    assert.match(readFileSync(join(home, "charts", chart.id, "index.html"), "utf8"), /Roadmap v2/);
  });
});

test("a chart still renders after its worktree copy is deleted; dead-owner feedback stays a 409", async () => {
  await withServer(async ({ port, adapter, hooks, home, chartFile }) => {
    mkdirSync(join(home, "drawings", "img"));
    writeFileSync(join(home, "drawings", "img", "logo.png"), "png-bytes");
    writeFileSync(chartFile, '<html><body><h1>Durable</h1><img src="img/logo.png"></body></html>');
    const { token } = hooks.register("pty:worker");
    const registered = await post(port, "/charts", hookHeaders("pty:worker", token), { file: chartFile });
    const { chart } = (await registered.json()) as { chart: Chart };

    // The worktree (the author's scratch copy) is torn down; the owner dies.
    rmSync(join(home, "drawings"), { recursive: true, force: true });
    adapter.sessions = [];

    const html = await fetch(`http://127.0.0.1:${port}/charts/${chart.id}`, { headers: bearer });
    assert.equal(html.status, 200);
    assert.match(await html.text(), /<h1>Durable<\/h1>/);
    const asset = await fetch(`http://127.0.0.1:${port}/charts/${chart.id}/img/logo.png`, { headers: bearer });
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), "png-bytes");
    // Traversal confinement holds for the snapshot dir too.
    const traversal = await fetch(`http://127.0.0.1:${port}/charts/${chart.id}/..%2Fcharts.json`, {
      headers: bearer
    });
    assert.equal(traversal.status, 403);

    // Rendering outlives the owner, feedback does not: still the explicit 409.
    const feedback = await post(port, `/charts/${chart.id}/feedback`, bearer, { message: "nice" });
    assert.equal(feedback.status, 409);
    const body = (await feedback.json()) as { alternatives: string[] };
    assert.deepEqual(body.alternatives, ["new_agent"]);
  });
});

test("closing the owning task archives its charts; re-registering same path creates a fresh active chart", async () => {
  await withServer(async ({ port, adapter, hooks, tasks, charts, chartFile, chartEvents }) => {
    wireChartArchive(tasks, charts);
    const sessionId = "pty:worker";
    adapter.sessions = [liveSession(sessionId)];
    const { token } = hooks.register(sessionId);
    const task = tasks.create({ title: "draw the roadmap", project: "/tmp/p" });
    tasks.update(task.id, { sessionId });
    const registered = await post(port, "/charts", hookHeaders(sessionId, token), { file: chartFile });
    const { chart } = (await registered.json()) as { chart: Chart };
    assert.equal(chart.taskId, task.id);
    assert.equal(chart.taskTitle, "draw the roadmap");
    assert.equal(chart.archived, undefined);

    tasks.recordEvent(task.id, { kind: "done", source: "worker" });
    tasks.recordEvent(task.id, { kind: "closed", source: "system" });

    const archivedEvent = chartEvents.find((event) => event.kind === "archived");
    assert.equal(archivedEvent?.chart.id, chart.id);
    const list = await fetch(`http://127.0.0.1:${port}/charts`, { headers: bearer });
    const { charts: listed } = (await list.json()) as { charts: Chart[] };
    assert.equal(listed[0]?.archived, true);
    assert.ok(listed[0]?.archivedAt);

    // Archived is still servable and viewable.
    const html = await fetch(`http://127.0.0.1:${port}/charts/${chart.id}`, { headers: bearer });
    assert.equal(html.status, 200);

    // A fresh registration on the same file is active under a new identity.
    const again = await post(port, "/charts", bearer, { file: chartFile, sessionId });
    const { chart: reactivated } = (await again.json()) as { chart: Chart };
    assert.notEqual(reactivated.id, chart.id);
    assert.equal(reactivated.archived, undefined);
    assert.equal(charts.find(chart.id)?.archived, true);
  });
});

test("a crew chart wakes the supervising session with the review link", async () => {
  await withServer(async ({ port, adapter, hooks, tasks, ownerManager, charts, monitor, chartFile }) => {
    wireMateWake(tasks, adapter, monitor);
    wireChartWake(charts, tasks, (chartId) => `http://mac:4711/charts/${chartId}/review`);
    const sessionId = "pty:worker";
    adapter.sessions = [
      liveSession(sessionId, { labels: { parent: "pty:attacker" } }),
      liveSession("pty:mate", { labels: { role: "mate" } })
    ];
    const { token } = hooks.register(sessionId);
    const task = tasks.create({ title: "draw the roadmap", project: "/tmp/p" });
    tasks.update(task.id, { sessionId, parentSessionId: "pty:mate" });
    recordLiveMate(ownerManager, "pty:mate");

    const registered = await post(port, "/charts", hookHeaders(sessionId, token), { file: chartFile });
    const { chart } = (await registered.json()) as { chart: Chart };
    assert.equal(chart.parentSessionId, "pty:mate");

    await waitFor(() => adapter.submitted.length > 0);
    assert.equal(adapter.submitted[0]?.sessionId, "pty:mate");
    assert.equal(
      adapter.submitted[0]?.text,
      `[perch] ${task.id} · chart_ready: "roadmap" - review at http://mac:4711/charts/${chart.id}/review`
    );
    const chartEvents = tasks.events(task.id).filter((event) => event.kind === "chart_ready");
    assert.equal(chartEvents.length, 1);
    assert.deepEqual(chartEvents[0]?.data, {
      chartId: chart.id,
      chartName: "roadmap",
      reviewUrl: `http://mac:4711/charts/${chart.id}/review`,
      parentSessionId: "pty:mate"
    });

    // A live-refresh edit never re-wakes the mate: registration is the moment.
    writeFileSync(chartFile, "<html><body>v2</body></html>");
    await waitFor(() => charts.find(chart.id)?.snapshotAt !== chart.snapshotAt);
    assert.equal(adapter.submitted.length, 1);
  });
});

test("a solo chart (no task, no parent) wakes nobody", async () => {
  await withServer(async ({ port, adapter, hooks, tasks, charts, chartFile }) => {
    wireChartWake(charts, tasks, (chartId) => `/charts/${chartId}/review`);
    adapter.sessions = [
      liveSession("pty:solo"),
      liveSession("pty:mate", { labels: { role: "mate" } })
    ];
    const { token } = hooks.register("pty:solo");
    const registered = await post(port, "/charts", hookHeaders("pty:solo", token), { file: chartFile });
    assert.equal(registered.status, 201);
    // Give any stray async wake a beat to (not) land.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(adapter.submitted.length, 0);
  });
});

test("a scout chart is persisted and wakes the current live mate", async () => {
  await withServer(async ({ port, adapter, hooks, tasks, charts, monitor, chartFile }) => {
    wireMateWake(tasks, adapter, monitor);
    wireChartWake(charts, tasks, (chartId) => `http://mac:4711/charts/${chartId}/review`);
    const sessionId = "pty:scout";
    adapter.sessions = [
      liveSession(sessionId, { labels: { parent: "pty:old-parent" } }),
      liveSession("pty:mate", { labels: { role: "mate" } })
    ];
    const { token } = hooks.register(sessionId);
    const task = tasks.create({ title: "scout the relay", project: "/tmp/p", kind: "scout" });
    tasks.update(task.id, { sessionId, parentSessionId: "pty:old-parent" });
    tasks.recordEvent(task.id, { kind: "working", source: "worker" });

    const registered = await post(port, "/charts", hookHeaders(sessionId, token), { file: chartFile });
    const { chart } = (await registered.json()) as { chart: Chart };
    await waitFor(() => adapter.submitted.length === 1);

    assert.equal(tasks.find(task.id)?.state, "working");
    assert.equal(tasks.events(task.id).filter((event) => event.kind === "chart_ready").length, 1);
    assert.equal(adapter.submitted[0]?.sessionId, "pty:mate");
    assert.equal(
      adapter.submitted[0]?.text,
      `[perch] ${task.id} · chart_ready: "roadmap" - review at http://mac:4711/charts/${chart.id}/review`
    );

    tasks.recordEvent(task.id, { kind: "blocked", source: "worker", message: "need access" });
    await waitFor(() => adapter.submitted.length === 2);
    tasks.recordEvent(task.id, { kind: "done", source: "worker", message: "scout complete" });
    await waitFor(() => adapter.submitted.length === 3);
    assert.equal(tasks.events(task.id).filter((event) => event.kind === "chart_ready").length, 1);
  });
});

// --- Two-state model (draft/finalized) + unified hub listing -----------------
// Unified charts hub phase 1.

test("a fresh chart is a draft; finalize flips it once and emits a finalized event", async () => {
  await withServer(async ({ port, adapter, chartFile, chartEvents, charts }) => {
    adapter.sessions = [liveSession("pty:worker")];
    const registered = await post(port, "/charts", bearer, { file: chartFile, sessionId: "pty:worker" });
    const { chart } = (await registered.json()) as { chart: Chart };
    assert.equal(chart.status, "draft");
    assert.equal(chart.finalizedAt, undefined);

    const finalized = charts.finalize(chart.id);
    assert.equal(finalized?.status, "finalized");
    assert.ok(finalized?.finalizedAt);
    assert.equal(chartEvents.filter((event) => event.kind === "finalized").length, 1);

    // Idempotent: a second finalize returns the chart unchanged and re-notifies
    // nobody.
    const again = charts.finalize(chart.id);
    assert.equal(again?.status, "finalized");
    assert.equal(again?.finalizedAt, finalized?.finalizedAt);
    assert.equal(chartEvents.filter((event) => event.kind === "finalized").length, 1);

    assert.equal(charts.finalize("nope"), undefined);
  });
});

test("POST /charts/:id/finalize approves the chart, audit-logged; 404 for unknown", async () => {
  await withServer(async ({ port, adapter, chartFile, home }) => {
    adapter.sessions = [liveSession("pty:worker")];
    const registered = await post(port, "/charts", bearer, { file: chartFile, sessionId: "pty:worker" });
    const { chart } = (await registered.json()) as { chart: Chart };

    const response = await post(port, `/charts/${chart.id}/finalize`, bearer, {});
    assert.equal(response.status, 200);
    const body = (await response.json()) as FinalizeChartResponse;
    assert.equal(body.chart.status, "finalized");
    assert.ok(body.chart.finalizedAt);

    // The flip is durable in the list.
    const list = await fetch(`http://127.0.0.1:${port}/charts`, { headers: bearer });
    const { charts: listed } = (await list.json()) as { charts: Chart[] };
    assert.equal(listed[0]?.status, "finalized");

    const audit = await import("node:fs/promises").then((fs) => fs.readFile(join(home, "audit.jsonl"), "utf8"));
    assert.match(audit, /"action":"finalize_chart"/);
    assert.match(audit, new RegExp(`"chartId":"${chart.id}"`));

    const unknown = await post(port, "/charts/nope/finalize", bearer, {});
    assert.equal(unknown.status, 404);
  });
});

test("re-registering a finalized chart preserves the finalized old chart and starts a draft", async () => {
  await withServer(async ({ port, adapter, chartFile, charts }) => {
    adapter.sessions = [liveSession("pty:a"), liveSession("pty:b")];
    const first = await post(port, "/charts", bearer, { file: chartFile, sessionId: "pty:a" });
    const { chart } = (await first.json()) as { chart: Chart };
    charts.finalize(chart.id);

    const second = await post(port, "/charts", bearer, { file: chartFile, sessionId: "pty:b" });
    const { chart: reregistered } = (await second.json()) as { chart: Chart };
    assert.notEqual(reregistered.id, chart.id);
    assert.equal(reregistered.sessionId, "pty:b");
    assert.equal(reregistered.status, "draft");
    assert.equal(reregistered.finalizedAt, undefined);
    assert.equal(charts.find(chart.id)?.status, "finalized");
    assert.ok(charts.find(chart.id)?.finalizedAt);
  });
});

test("scanPlanDocs parses date + H1 title, sorts newest first, skips non-plans", () => {
  const root = mkdtempSync(join(tmpdir(), "perch-plans-"));
  try {
    assert.deepEqual(scanPlanDocs(root), []); // no docs/plans dir yet
    const plans = join(root, "docs", "plans");
    mkdirSync(plans, { recursive: true });
    writeFileSync(join(plans, "2026-07-01-alpha.md"), "Status:  Active\n\n# Alpha plan\n\nbody");
    writeFileSync(join(plans, "2026-07-08-beta.md"), "# Beta plan\n");
    writeFileSync(join(plans, "no-date-note.md"), "plain, no heading");
    writeFileSync(join(plans, "README.md"), "# Index\n"); // the generated index, skipped
    writeFileSync(join(plans, "notes.txt"), "not markdown"); // skipped

    const docs = scanPlanDocs(root);
    assert.deepEqual(
      docs.map((doc) => doc.relativePath),
      ["docs/plans/no-date-note.md", "docs/plans/2026-07-08-beta.md", "docs/plans/2026-07-01-alpha.md"]
    );
    const beta = docs.find((doc) => doc.relativePath.endsWith("beta.md"));
    assert.equal(beta?.title, "Beta plan");
    assert.equal(beta?.date, "2026-07-08");
    const undated = docs.find((doc) => doc.relativePath.endsWith("no-date-note.md"));
    assert.equal(undated?.date, undefined);
    assert.equal(undated?.title, "no-date-note"); // no H1 -> filename fallback
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildChartsHub groups charts by resolved project, attaches plans, and ungroups the rest", () => {
  const root = mkdtempSync(join(tmpdir(), "perch-hub-"));
  try {
    const alpha = join(root, "alpha");
    mkdirSync(join(alpha, "docs", "plans"), { recursive: true });
    writeFileSync(join(alpha, "docs", "plans", "2026-07-08-a.md"), "# A plan\n");
    const beta = join(root, "beta"); // tracked but empty -> omitted from the hub
    mkdirSync(beta, { recursive: true });

    const chartInAlpha = { id: "c1", taskId: "t1" } as Chart;
    const soloChart = { id: "c2" } as Chart; // no task -> ungrouped
    const orphanChart = { id: "c3", taskId: "t-gone" } as Chart; // task resolves nowhere

    const hub = buildChartsHub(
      [chartInAlpha, soloChart, orphanChart],
      [
        { rootPath: alpha, name: "alpha" },
        { rootPath: beta, name: "beta" }
      ],
      (chart) => (chart.taskId === "t1" ? alpha : undefined)
    );

    assert.equal(hub.projects.length, 1);
    assert.equal(hub.projects[0]?.rootPath, alpha);
    assert.deepEqual(
      hub.projects[0]?.charts.map((chart) => chart.id),
      ["c1"]
    );
    assert.equal(hub.projects[0]?.plans[0]?.title, "A plan");
    assert.deepEqual(hub.ungrouped.map((chart) => chart.id).sort(), ["c2", "c3"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GET /charts/hub returns charts grouped by their task's project with plans", async () => {
  await withServer(async ({ port, adapter, hooks, tasks, home, chartFile, options }) => {
    const root = join(home, "myproj");
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    writeFileSync(join(root, "docs", "plans", "2026-07-08-hub.md"), "# Hub plan\n");
    options.projects.touch(root);

    const sessionId = "pty:worker";
    adapter.sessions = [liveSession(sessionId)];
    const { token } = hooks.register(sessionId);
    const task = tasks.create({ title: "draw", project: root });
    tasks.update(task.id, { sessionId });
    await post(port, "/charts", hookHeaders(sessionId, token), { file: chartFile });

    const response = await fetch(`http://127.0.0.1:${port}/charts/hub`, { headers: bearer });
    assert.equal(response.status, 200);
    const hub = (await response.json()) as ChartsHubResponse;
    const group = hub.projects.find((project) => project.rootPath === root);
    assert.ok(group, "the chart's project is grouped");
    assert.equal(group?.charts.length, 1);
    assert.equal(group?.charts[0]?.status, "draft");
    assert.equal(group?.plans[0]?.title, "Hub plan");
    assert.equal(group?.plans[0]?.date, "2026-07-08");
  });
});

test("a mate chart tagged with a project rootPath groups under that project", async () => {
  await withServer(async ({ port, adapter, home, options, chartFile }) => {
    const root = join(home, "perch");
    mkdirSync(root, { recursive: true });
    options.projects.touch(root);
    adapter.sessions = [liveSession("pty:mate", { labels: { role: "mate" } })];

    // The mate registers via the server token with no task, naming its project.
    const registered = await post(port, "/charts", bearer, {
      file: chartFile,
      sessionId: "pty:mate",
      project: root
    });
    assert.equal(registered.status, 201);
    const { chart } = (await registered.json()) as { chart: Chart };
    assert.equal(chart.projectRoot, root, "the resolved rootPath is persisted on the chart");
    assert.equal(chart.taskId, undefined, "no task linkage");

    const response = await fetch(`http://127.0.0.1:${port}/charts/hub`, { headers: bearer });
    const hub = (await response.json()) as ChartsHubResponse;
    const group = hub.projects.find((project) => project.rootPath === root);
    assert.ok(group, "the tagged chart groups under its project");
    assert.equal(group?.charts.length, 1);
    assert.equal(hub.ungrouped.length, 0, "nothing falls through to ungrouped");
  });
});

test("a project tag by name resolves to the tracked project's rootPath", async () => {
  await withServer(async ({ port, adapter, home, options, chartFile }) => {
    const root = join(home, "some-dir", "perch");
    mkdirSync(root, { recursive: true });
    options.projects.touch(root); // name derives from basename -> "perch"
    adapter.sessions = [liveSession("pty:mate", { labels: { role: "mate" } })];

    const registered = await post(port, "/charts", bearer, {
      file: chartFile,
      sessionId: "pty:mate",
      project: "perch"
    });
    assert.equal(registered.status, 201);
    const { chart } = (await registered.json()) as { chart: Chart };
    assert.equal(chart.projectRoot, root);

    const response = await fetch(`http://127.0.0.1:${port}/charts/hub`, { headers: bearer });
    const hub = (await response.json()) as ChartsHubResponse;
    assert.ok(hub.projects.find((project) => project.rootPath === root));
  });
});

test("an unresolvable project tag is a hard 400, never a silent ungroup", async () => {
  await withServer(async ({ port, adapter, chartFile }) => {
    adapter.sessions = [liveSession("pty:mate", { labels: { role: "mate" } })];
    const response = await post(port, "/charts", bearer, {
      file: chartFile,
      sessionId: "pty:mate",
      project: "no-such-project"
    });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /Unknown project/);
  });
});

test("a mate chart with no project tag stays ungrouped (backward compatible)", async () => {
  await withServer(async ({ port, adapter, home, options, chartFile }) => {
    const root = join(home, "mateproj");
    mkdirSync(root, { recursive: true });
    options.projects.touch(root);
    adapter.sessions = [liveSession("pty:mate", { labels: { role: "mate" } })];

    // The mate registers via the server token with no task and no project tag.
    const registered = await post(port, "/charts", bearer, { file: chartFile, sessionId: "pty:mate" });
    assert.equal(registered.status, 201);
    const { chart } = (await registered.json()) as { chart: Chart };
    assert.equal(chart.projectRoot, undefined);

    const response = await fetch(`http://127.0.0.1:${port}/charts/hub`, { headers: bearer });
    const hub = (await response.json()) as ChartsHubResponse;
    assert.equal(hub.projects.length, 0, "no project group forms for the untagged mate chart");
    assert.equal(hub.ungrouped.length, 1, "the mate chart falls into ungrouped");
  });
});

test("re-registering a tagged chart without a project tag does not inherit stale path metadata", async () => {
  await withServer(async ({ port, adapter, home, options, chartFile }) => {
    const root = join(home, "perch");
    mkdirSync(root, { recursive: true });
    options.projects.touch(root);
    adapter.sessions = [liveSession("pty:mate", { labels: { role: "mate" } })];

    const first = await post(port, "/charts", bearer, { file: chartFile, sessionId: "pty:mate", project: root });
    assert.equal(first.status, 201);
    const again = await post(port, "/charts", bearer, { file: chartFile, sessionId: "pty:mate" });
    assert.equal(again.status, 201);
    const { chart: firstChart } = (await first.json()) as { chart: Chart };
    const { chart: secondChart } = (await again.json()) as { chart: Chart };
    assert.notEqual(firstChart.id, secondChart.id);
    assert.equal(firstChart.projectRoot, root);
    assert.equal(secondChart.projectRoot, undefined);
  });
});

test("buildChartsHub: an explicit projectRoot wins; a task-linked chart is unaffected", () => {
  const root = mkdtempSync(join(tmpdir(), "perch-hub-explicit-"));
  try {
    const alpha = join(root, "alpha");
    mkdirSync(alpha, { recursive: true });
    const beta = join(root, "beta");
    mkdirSync(beta, { recursive: true });

    const tagged = { id: "c1", projectRoot: alpha } as Chart; // explicit -> alpha
    const taskLinked = { id: "c2", taskId: "t1" } as Chart; // task -> beta
    const both = { id: "c3", taskId: "t1", projectRoot: alpha } as Chart; // explicit wins

    const hub = buildChartsHub(
      [tagged, taskLinked, both],
      [
        { rootPath: alpha, name: "alpha" },
        { rootPath: beta, name: "beta" }
      ],
      // Explicit projectRoot preferred; else task t1 -> beta.
      (chart) => chart.projectRoot ?? (chart.taskId === "t1" ? beta : undefined)
    );

    const alphaGroup = hub.projects.find((project) => project.rootPath === alpha);
    const betaGroup = hub.projects.find((project) => project.rootPath === beta);
    assert.deepEqual(alphaGroup?.charts.map((chart) => chart.id).sort(), ["c1", "c3"]);
    assert.deepEqual(betaGroup?.charts.map((chart) => chart.id), ["c2"]);
    assert.equal(hub.ungrouped.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GET /charts/plan renders a tracked project's plan doc in chart styling, confined", async () => {
  await withServer(async ({ port, home, options }) => {
    const root = join(home, "planproj");
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    const planPath = join(root, "docs", "plans", "2026-07-08-hub.md");
    writeFileSync(planPath, "# Hub plan\n\nBuild the **hub** with a `chart`.\n\n- one\n- two\n");
    options.projects.touch(root);

    // Absolute path (as the hub lists it) renders as chart-styled HTML.
    const abs = await fetch(`http://127.0.0.1:${port}/charts/plan?path=${encodeURIComponent(planPath)}`, {
      headers: bearer
    });
    assert.equal(abs.status, 200);
    assert.match(abs.headers.get("content-type") ?? "", /text\/html/);
    const html = await abs.text();
    // The theme is inlined, not linked: the phone loads this string with no base
    // URL, so a relative chart.css could not resolve (dark-on-dark). Self-
    // contained + legible on the dark canvas is the contract now.
    assert.doesNotMatch(html, /<link[^>]+stylesheet/i);
    assert.match(html, /<style>[\s\S]*--canvas:\s*#0a0908[\s\S]*<\/style>/);
    assert.match(html, /<title>Hub plan · Perch<\/title>/);
    assert.match(html, /<strong>hub<\/strong>/);
    assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);

    // The repo-relative form resolves against the same tracked project.
    const rel = await fetch(
      `http://127.0.0.1:${port}/charts/plan?path=${encodeURIComponent("docs/plans/2026-07-08-hub.md")}`,
      { headers: bearer }
    );
    assert.equal(rel.status, 200);

    // Anonymous is rejected by auth like every other chart route.
    const anon = await fetch(`http://127.0.0.1:${port}/charts/plan?path=${encodeURIComponent(planPath)}`);
    assert.equal(anon.status, 401);

    // Traversal, an untracked project's file, and a missing doc all 404.
    const traversal = await fetch(
      `http://127.0.0.1:${port}/charts/plan?path=${encodeURIComponent("docs/plans/../../etc/passwd.md")}`,
      { headers: bearer }
    );
    assert.equal(traversal.status, 404);
    const untracked = await fetch(
      `http://127.0.0.1:${port}/charts/plan?path=${encodeURIComponent("/etc/passwd.md")}`,
      { headers: bearer }
    );
    assert.equal(untracked.status, 404);
    const missing = await fetch(
      `http://127.0.0.1:${port}/charts/plan?path=${encodeURIComponent("docs/plans/2026-07-08-gone.md")}`,
      { headers: bearer }
    );
    assert.equal(missing.status, 404);
  });
});

test("collectChartAssetRefs finds relative refs and skips absolute/scheme'd ones", () => {
  const refs = collectChartAssetRefs(`
    <link rel="stylesheet" href="./chart.css">
    <img src="img/logo.png"> <img src='img/logo.png?v=2'>
    <div style="background: url(bg/paper.jpg)"></div>
    <div style="background-image: url('deep/tex%20ture.png')"></div>
    <a href="https://example.com/a">a</a>
    <script src="//cdn.example.com/x.js"></script>
    <img src="/charts/other/root.png">
    <img src="data:image/png;base64,AAAA">
    <a href="#section">jump</a>
  `);
  assert.deepEqual(refs.sort(), ["./chart.css", "bg/paper.jpg", "deep/tex ture.png", "img/logo.png"]);
});
