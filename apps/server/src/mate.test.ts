import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession, RecentEventsResult, StartAgentRequest } from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import { AuditLog } from "./audit.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { HookRegistry } from "./hooks.js";
import { createControlServer } from "./http.js";
import { seedMateHome } from "./mate.js";
import { MATE_CLAUDE_FALLBACK_MODEL, MATE_CODEX_FALLBACK } from "./models.js";
import { DeviceRegistry } from "./pairing.js";
import { PrPoller } from "./prPoller.js";
import { ProjectRegistry } from "./projects.js";
import { FleetSettings } from "./settings.js";
import { TaskStore } from "./tasks.js";
import { TimelineStore } from "./timeline.js";
import { WorktreePool } from "./worktrees.js";

class FakePtyAdapter implements AgentAdapter {
  readonly name = "fake-pty";
  sessions: AgentSession[] = [];
  requests: StartAgentRequest[] = [];

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
    this.requests.push(request);
    const session: AgentSession = {
      id: `pty:${randomUUID()}`,
      title: request.title ?? request.command,
      agent: request.agent ?? "claude",
      cwd: request.cwd,
      labels: request.labels,
      workspaceId: "perch-pty",
      paneId: "p",
      surfaceId: "s",
      kind: "terminal",
      status: "running",
      lastActivityAt: new Date().toISOString()
    };
    this.sessions.push(session);
    return session;
  }
}

function serverFixture(home: string) {
  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  const adapter = new FakePtyAdapter();
  const tasks = new TaskStore(env);
  const timeline = new TimelineStore();
  const monitor = new FleetMonitor(adapter, { broadcastMs: 5 });
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
    settings: new FleetSettings(env)
  });
  return { adapter, monitor, timeline, server };
}

test("GET /sessions returns the latest observed Codex runtime effort instead of the launch stamp", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-live-codex-settings-"));
  const { adapter, monitor, timeline, server } = serverFixture(home);
  adapter.sessions.push({
    id: "pty:codex-live",
    title: "Codex",
    agent: "codex",
    kind: "terminal",
    status: "running",
    lastActivityAt: new Date().toISOString()
  });
  monitor.setSessionModel("pty:codex-live", {
    model: "gpt-5.6-sol",
    modelLabel: "GPT-5.6 Sol",
    effort: "low"
  });
  monitor.setSessionModel("pty:codex-live", { effort: "medium" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/sessions`, {
      headers: { authorization: "Bearer test-token" }
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { sessions: AgentSession[] };
    assert.equal(body.sessions[0]?.model, "gpt-5.6-sol");
    assert.equal(body.sessions[0]?.effort, "medium");
  } finally {
    timeline.stop();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});

test("POST /mate/start seeds the mate home and spawns the labeled mate; a live mate answers 409", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-mate-home-"));
  // seedMateHome inside the route reads process.env, like the CLI does.
  const priorHome = process.env.PERCH_HOME;
  process.env.PERCH_HOME = home;

  const { adapter, timeline, server } = serverFixture(home);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const authed = { headers: { authorization: "Bearer test-token", "content-type": "application/json" } };

  try {
    const started = await fetch(`http://127.0.0.1:${port}/mate/start`, { ...authed, method: "POST" });
    assert.equal(started.status, 201);
    const { session } = (await started.json()) as { session: AgentSession };
    assert.equal(session.labels?.role, "mate");
    assert.equal(session.agent, "claude");
    assert.equal(session.title, "mate");

    // The mate home is neutral by design: always $PERCH_HOME/mate, seeded
    // with the perch-managed spec - the endpoint takes no directory.
    const mateHome = join(home, "mate");
    assert.equal(session.cwd, mateHome);
    assert.equal(adapter.requests[0]?.cwd, mateHome);
    const spec = readFileSync(join(mateHome, "AGENTS.md"), "utf8");
    assert.ok(spec.length > 0);
    assert.ok(lstatSync(join(mateHome, "CLAUDE.md")).isSymbolicLink());

    // The mate home is infrastructure, never a registered project: the app
    // renders the registry as the mate's scope headers, and a "mate" entry
    // there would be a bogus project.
    const projects = await fetch(`http://127.0.0.1:${port}/projects`, authed);
    const projectsBody = (await projects.json()) as { projects: Array<{ rootPath: string }> };
    assert.ok(
      projectsBody.projects.every((p) => p.rootPath !== mateHome),
      "mate home must not register as a project"
    );

    // One mate per fleet: a second start reports the live one instead.
    const dup = await fetch(`http://127.0.0.1:${port}/mate/start`, { ...authed, method: "POST" });
    assert.equal(dup.status, 409);
    const dupBody = (await dup.json()) as { error: string; sessionId: string };
    assert.equal(dupBody.sessionId, session.id);
    assert.equal(adapter.requests.length, 1);

    // An ended mate no longer blocks: the fleet gets a fresh one.
    adapter.sessions[0] = { ...adapter.sessions[0]!, status: "done" };
    const restarted = await fetch(`http://127.0.0.1:${port}/mate/start`, { ...authed, method: "POST" });
    assert.equal(restarted.status, 201);
    assert.equal(adapter.requests.length, 2);
  } finally {
    timeline.stop();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (priorHome === undefined) delete process.env.PERCH_HOME;
    else process.env.PERCH_HOME = priorHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// The app's start-mate button posts an empty body, so the fleet's configured
// mate (`perch config mate-*`) must be read server-side - otherwise a mate
// started from the phone lands on a different agent than `perch mate` gives.
test("POST /mate/start applies the fleet mate defaults, and an explicit override wins", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-mate-defaults-"));
  const priorHome = process.env.PERCH_HOME;
  process.env.PERCH_HOME = home;

  const { adapter, timeline, server } = serverFixture(home);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const authed = { headers: { authorization: "Bearer test-token", "content-type": "application/json" } };

  try {
    const patched = await fetch(`http://127.0.0.1:${port}/config`, {
      ...authed,
      method: "PATCH",
      body: JSON.stringify({ mateDefaults: { agent: "codex", model: "gpt-5.5", effort: "high" } })
    });
    assert.equal(patched.status, 200);

    // The app's call: no body at all. The mate launches as the configured one.
    const started = await fetch(`http://127.0.0.1:${port}/mate/start`, { ...authed, method: "POST" });
    assert.equal(started.status, 201, await started.text());
    const configured = adapter.requests.at(-1);
    assert.equal(configured?.agent, "codex");
    assert.equal(configured?.command, "codex");
    assert.equal(configured?.model, "gpt-5.5");
    assert.equal(configured?.effort, "high");
    assert.equal(configured?.labels?.role, "mate");

    // An explicit request field beats the registry; and the configured
    // model/effort describe the DEFAULT agent's launch as a unit - they never
    // ride along onto an explicitly different agent.
    adapter.sessions[0] = { ...adapter.sessions[0]!, status: "done" };
    const overridden = await fetch(`http://127.0.0.1:${port}/mate/start`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ agent: "claude", model: "opus" })
    });
    assert.equal(overridden.status, 201, await overridden.text());
    const explicit = adapter.requests.at(-1);
    assert.equal(explicit?.agent, "claude");
    assert.equal(explicit?.command, "claude");
    assert.equal(explicit?.model, "opus");
    assert.equal(explicit?.effort, undefined);
  } finally {
    timeline.stop();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (priorHome === undefined) delete process.env.PERCH_HOME;
    else process.env.PERCH_HOME = priorHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// The Claude CLI's global default drifts (any session's /model switch saves
// itself as the default), so a Claude mate must never launch without an
// explicit model. Precedence: request model > configured mate default >
// registry role default > pinned fallback - never a bare `claude`.
test("POST /mate/start uses the Claude registry role default when nothing names one", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-mate-fallback-"));
  const priorHome = process.env.PERCH_HOME;
  process.env.PERCH_HOME = home;

  const { adapter, timeline, server } = serverFixture(home);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const authed = { headers: { authorization: "Bearer test-token", "content-type": "application/json" } };

  try {
    // The fixture's static registry owns the concrete launch policy too.
    const started = await fetch(`http://127.0.0.1:${port}/mate/start`, { ...authed, method: "POST" });
    assert.equal(started.status, 201, await started.text());
    assert.equal(adapter.requests.at(-1)?.agent, "claude");
    assert.equal(adapter.requests.at(-1)?.model, "claude-fable-5");

    // A configured mate default model still wins over the fallback.
    const patched = await fetch(`http://127.0.0.1:${port}/config`, {
      ...authed,
      method: "PATCH",
      body: JSON.stringify({ mateDefaults: { agent: "claude", model: "haiku" } })
    });
    assert.equal(patched.status, 200);
    adapter.sessions[0] = { ...adapter.sessions[0]!, status: "done" };
    const configured = await fetch(`http://127.0.0.1:${port}/mate/start`, { ...authed, method: "POST" });
    assert.equal(configured.status, 201, await configured.text());
    assert.equal(adapter.requests.at(-1)?.model, "haiku");

    // Configured defaults describe the DEFAULT agent's launch as a unit: an
    // explicitly different agent drops them, and a Claude mate then lands on
    // its registry role default rather than a bare `claude`.
    const repatched = await fetch(`http://127.0.0.1:${port}/config`, {
      ...authed,
      method: "PATCH",
      body: JSON.stringify({ mateDefaults: { agent: "codex", model: "gpt-5.5" } })
    });
    assert.equal(repatched.status, 200);
    adapter.sessions[1] = { ...adapter.sessions[1]!, status: "done" };
    const explicitClaude = await fetch(`http://127.0.0.1:${port}/mate/start`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ agent: "claude" })
    });
    assert.equal(explicitClaude.status, 201, await explicitClaude.text());
    assert.equal(adapter.requests.at(-1)?.agent, "claude");
    assert.equal(adapter.requests.at(-1)?.model, "claude-fable-5");

    // A configured Codex mate carries the configured model; the fallback does
    // not overwrite it.
    adapter.sessions[2] = { ...adapter.sessions[2]!, status: "done" };
    const codexMate = await fetch(`http://127.0.0.1:${port}/mate/start`, { ...authed, method: "POST" });
    assert.equal(codexMate.status, 201, await codexMate.text());
    assert.equal(adapter.requests.at(-1)?.agent, "codex");
    assert.equal(adapter.requests.at(-1)?.model, "gpt-5.5");
  } finally {
    timeline.stop();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (priorHome === undefined) delete process.env.PERCH_HOME;
    else process.env.PERCH_HOME = priorHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("POST /mate/start pins Codex fallback model and xhigh effort for an explicitly Codex mate", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-mate-codex-fallback-"));
  const priorHome = process.env.PERCH_HOME;
  process.env.PERCH_HOME = home;

  const { adapter, timeline, server } = serverFixture(home);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const authed = { headers: { authorization: "Bearer test-token", "content-type": "application/json" } };

  try {
    const started = await fetch(`http://127.0.0.1:${port}/mate/start`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ agent: "codex" })
    });
    assert.equal(started.status, 201, await started.text());
    assert.equal(adapter.requests.at(-1)?.agent, "codex");
    assert.equal(adapter.requests.at(-1)?.model, MATE_CODEX_FALLBACK.model);
    assert.equal(adapter.requests.at(-1)?.effort, MATE_CODEX_FALLBACK.effort);

    adapter.sessions[0] = { ...adapter.sessions[0]!, status: "done" };
    const withEffort = await fetch(`http://127.0.0.1:${port}/mate/start`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ agent: "codex", effort: "low" })
    });
    assert.equal(withEffort.status, 201, await withEffort.text());
    assert.equal(adapter.requests.at(-1)?.model, MATE_CODEX_FALLBACK.model);
    assert.equal(adapter.requests.at(-1)?.effort, "low");
  } finally {
    timeline.stop();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (priorHome === undefined) delete process.env.PERCH_HOME;
    else process.env.PERCH_HOME = priorHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("GET /sessions fills missing Codex mate model from effective mate defaults", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-mate-session-model-"));
  const priorHome = process.env.PERCH_HOME;
  process.env.PERCH_HOME = home;

  const { adapter, timeline, server } = serverFixture(home);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const authed = { headers: { authorization: "Bearer test-token", "content-type": "application/json" } };

  try {
    const patched = await fetch(`http://127.0.0.1:${port}/config`, {
      ...authed,
      method: "PATCH",
      body: JSON.stringify({ mateDefaults: { agent: "codex" } })
    });
    assert.equal(patched.status, 200, await patched.text());
    adapter.sessions.push({
      id: `pty:${randomUUID()}`,
      title: "mate",
      agent: "codex",
      cwd: join(home, "mate"),
      labels: { role: "mate" },
      workspaceId: "perch-pty",
      paneId: "p",
      surfaceId: "s",
      kind: "terminal",
      status: "running",
      lastActivityAt: new Date().toISOString()
    });

    const response = await fetch(`http://127.0.0.1:${port}/sessions`, authed);
    if (response.status !== 200) {
      assert.fail(await response.text());
    }
    const body = (await response.json()) as { sessions: AgentSession[] };
    const mate = body.sessions.find((session) => session.labels?.role === "mate");
    assert.equal(mate?.model, MATE_CODEX_FALLBACK.model);
    assert.equal(mate?.modelLabel, "GPT 5.6 Sol");
    assert.equal(mate?.effort, MATE_CODEX_FALLBACK.effort);
  } finally {
    timeline.stop();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (priorHome === undefined) delete process.env.PERCH_HOME;
    else process.env.PERCH_HOME = priorHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("GET /sessions fills missing Claude mate model with a friendly label and no effort", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-mate-claude-session-model-"));
  const priorHome = process.env.PERCH_HOME;
  process.env.PERCH_HOME = home;

  const { adapter, timeline, server } = serverFixture(home);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const authed = { headers: { authorization: "Bearer test-token", "content-type": "application/json" } };

  try {
    adapter.sessions.push({
      id: `pty:${randomUUID()}`,
      title: "mate",
      agent: "claude",
      cwd: join(home, "mate"),
      labels: { role: "mate" },
      workspaceId: "perch-pty",
      paneId: "p",
      surfaceId: "s",
      kind: "terminal",
      status: "running",
      lastActivityAt: new Date().toISOString()
    });

    const response = await fetch(`http://127.0.0.1:${port}/sessions`, authed);
    if (response.status !== 200) {
      assert.fail(await response.text());
    }
    const body = (await response.json()) as { sessions: AgentSession[] };
    const mate = body.sessions.find((session) => session.labels?.role === "mate");
    assert.equal(mate?.model, MATE_CLAUDE_FALLBACK_MODEL);
    assert.equal(mate?.modelLabel, "Best");
    assert.equal(mate?.effort, undefined);
  } finally {
    timeline.stop();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (priorHome === undefined) delete process.env.PERCH_HOME;
    else process.env.PERCH_HOME = priorHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("GET /sessions preserves an explicit Claude mate model label and no effort", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-mate-claude-explicit-model-"));
  const priorHome = process.env.PERCH_HOME;
  process.env.PERCH_HOME = home;

  const { adapter, timeline, server } = serverFixture(home);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const authed = { headers: { authorization: "Bearer test-token", "content-type": "application/json" } };

  try {
    const started = await fetch(`http://127.0.0.1:${port}/mate/start`, {
      ...authed,
      method: "POST",
      body: JSON.stringify({ agent: "claude", model: "opus[1m]", effort: "xhigh" })
    });
    if (started.status !== 201) {
      assert.fail(await started.text());
    }

    const response = await fetch(`http://127.0.0.1:${port}/sessions`, authed);
    if (response.status !== 200) {
      assert.fail(await response.text());
    }
    const body = (await response.json()) as { sessions: AgentSession[] };
    const mate = body.sessions.find((session) => session.labels?.role === "mate");
    assert.equal(mate?.model, "opus[1m]");
    assert.equal(mate?.modelLabel, "Opus 4.8");
    assert.equal(mate?.effort, undefined);
  } finally {
    timeline.stop();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (priorHome === undefined) delete process.env.PERCH_HOME;
    else process.env.PERCH_HOME = priorHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("seedMateHome refreshes the spec but never touches the mate's own files", () => {
  const home = mkdtempSync(join(tmpdir(), "perch-mate-seed-"));
  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  try {
    const mateHome = seedMateHome(env);
    assert.equal(mateHome, join(home, "mate"));
    assert.ok(existsSync(join(mateHome, "AGENTS.md")));
    assert.ok(lstatSync(join(mateHome, "CLAUDE.md")).isSymbolicLink());

    // Re-seeding is idempotent (the CLAUDE.md symlink already exists).
    assert.equal(seedMateHome(env), mateHome);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
