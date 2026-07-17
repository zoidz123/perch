import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AgentSession, RecentEventsResult, StartAgentRequest } from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import { AuditLog } from "./audit.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { HookRegistry } from "./hooks.js";
import { createControlServer, handleWebSocketRpcRequest } from "./http.js";
import { DISPATCH_CODEX_FALLBACK } from "./models.js";
import { DeviceRegistry } from "./pairing.js";
import { PrPoller } from "./prPoller.js";
import { ProjectRegistry } from "./projects.js";
import { FleetSettings } from "./settings.js";
import { TaskStore } from "./tasks.js";
import { TimelineStore } from "./timeline.js";
import { DEFAULT_MAX_SLOTS, WorktreePool } from "./worktrees.js";

// The user-configurable dispatch defaults (`perch config`): POST /tasks falls
// back to the fleet-level agent/model/effort when a dispatch omits them, an
// explicit per-task value always wins. With nothing configured and no per-task
// override, the built-in fallback prefers Codex when the CLI is on PATH and
// otherwise keeps the historical Claude/no-launch-model behavior.

const MATE_RESOLVED_DEFAULT = { agent: "claude", model: "claude-fable-5", modelSource: "auto" };

class CapturingAdapter implements AgentAdapter {
  readonly name = "fake-pty";
  sessions: AgentSession[] = [];
  startRequests: StartAgentRequest[] = [];

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
    this.startRequests.push(request);
    const session: AgentSession = {
      id: request.sessionId ?? `pty:${randomUUID()}`,
      title: request.title ?? request.command,
      agent: request.agent ?? "unknown",
      cwd: request.cwd,
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

const home = mkdtempSync(join(tmpdir(), "perch-defaults-home-"));
const repo = mkdtempSync(join(tmpdir(), "perch-defaults-repo-"));
execFileSync("git", ["init", "-q"], { cwd: repo });
execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init", "--allow-empty"], {
  cwd: repo
});

const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
const adapter = new CapturingAdapter();
const tasks = new TaskStore(env);
const timeline = new TimelineStore();
const settings = new FleetSettings(env);
let codexOnPath = true;
const serverOptions = {
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
  settings,
  codexOnPath: () => codexOnPath
};
const server = createControlServer(serverOptions);

let baseUrl = "";
const authed = { headers: { authorization: "Bearer test-token", "content-type": "application/json" } };

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  timeline.stop();
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of [home, repo]) rmSync(dir, { recursive: true, force: true });
});

async function dispatch(body: Record<string, unknown>): Promise<StartAgentRequest> {
  const response = await fetch(`${baseUrl}/tasks`, {
    ...authed,
    method: "POST",
    body: JSON.stringify({ project: repo, dispatch: true, prompt: "go", ...body })
  });
  assert.equal(response.status, 201, await response.text());
  const request = adapter.startRequests.at(-1);
  assert.ok(request, "dispatch reached the adapter");
  return request;
}

function configRpc(method: "GET" | "PATCH", body?: Record<string, unknown>) {
  return handleWebSocketRpcRequest(
    { type: "rpc", id: `rpc-config-${method.toLowerCase()}`, method, path: "/config", ...(body ? { body } : {}) },
    { kind: "server" },
    serverOptions
  );
}

test("fresh install with codex on PATH dispatches Codex on the built-in low crew fallback", async () => {
  const request = await dispatch({ title: "t-fresh-codex" });
  assert.equal(request.agent, "codex");
  assert.equal(request.command, "codex");
  assert.equal(request.model, DISPATCH_CODEX_FALLBACK.model);
  assert.equal(request.effort, DISPATCH_CODEX_FALLBACK.effort);

  const config = await fetch(`${baseUrl}/config`, authed);
  const body = (await config.json()) as {
    dispatchDefaults: unknown;
    dispatchResolved?: { agent?: string; model?: string; effort?: string };
  };
  assert.deepEqual(body.dispatchDefaults, {});
  assert.deepEqual(body.dispatchResolved, DISPATCH_CODEX_FALLBACK);
});

test("fresh install without codex on PATH preserves Claude with no launch model or effort", async () => {
  codexOnPath = false;
  try {
    const request = await dispatch({ title: "t-fresh-no-codex" });
    assert.equal(request.agent, "claude");
    assert.equal(request.command, "claude");
    assert.equal(request.model, undefined);
    assert.equal(request.effort, undefined);
  } finally {
    codexOnPath = true;
  }
});

test("per-task agent overrides keep model and effort agent-scoped", async () => {
  const request = await dispatch({ title: "t-explicit-claude", agent: "claude" });
  assert.equal(request.agent, "claude");
  assert.equal(request.model, undefined);
  assert.equal(request.effort, undefined);

  const codexRequest = await dispatch({ title: "t-explicit-codex", agent: "codex" });
  assert.equal(codexRequest.agent, "codex");
  assert.equal(codexRequest.model, DISPATCH_CODEX_FALLBACK.model);
  assert.equal(codexRequest.effort, DISPATCH_CODEX_FALLBACK.effort);

  const pinned = await dispatch({ title: "t-explicit-codex-model", agent: "codex", model: "gpt-5.4", effort: "low" });
  assert.equal(pinned.model, "gpt-5.4");
  assert.equal(pinned.effort, "low");
});

test("PERCH_DEFAULT_* env wins over the built-in Codex fallback", async () => {
  env.PERCH_DEFAULT_AGENT = "claude";
  try {
    const request = await dispatch({ title: "t-env-default" });
    assert.equal(request.agent, "claude");
    assert.equal(request.model, undefined);
    assert.equal(request.effort, undefined);
  } finally {
    delete env.PERCH_DEFAULT_AGENT;
  }
});

test("configured defaults fill omitted agent, model, and effort", async () => {
  const patched = await fetch(`${baseUrl}/config`, {
    ...authed,
    method: "PATCH",
    body: JSON.stringify({ dispatchDefaults: { agent: "codex", model: "gpt-5.5", effort: "high" } })
  });
  assert.equal(patched.status, 200);
  assert.deepEqual(await patched.json(), {
    dispatchDefaults: { agent: "codex", model: "gpt-5.5", effort: "high" },
    mateDefaults: {},
    mateResolved: MATE_RESOLVED_DEFAULT
  });

  const request = await dispatch({ title: "t-defaults" });
  assert.equal(request.agent, "codex");
  assert.equal(request.command, "codex");
  assert.equal(request.model, "gpt-5.5");
  assert.equal(request.effort, "high");

  // GET /config reads back the same effective values.
  const read = await fetch(`${baseUrl}/config`, authed);
  assert.deepEqual(await read.json(), {
    dispatchDefaults: { agent: "codex", model: "gpt-5.5", effort: "high" },
    mateDefaults: {},
    mateResolved: MATE_RESOLVED_DEFAULT
  });
});

test("PATCH /config also sets mateDefaults, independent of dispatchDefaults", async () => {
  const patched = await fetch(`${baseUrl}/config`, {
    ...authed,
    method: "PATCH",
    body: JSON.stringify({ mateDefaults: { agent: "codex", model: "opus", effort: "high" } })
  });
  assert.equal(patched.status, 200);
  const body = (await patched.json()) as { dispatchDefaults: unknown; mateDefaults: unknown };
  assert.deepEqual(body.mateDefaults, { agent: "codex", model: "opus", effort: "high" });
  // The dispatch defaults from the previous test are untouched by a
  // mateDefaults-only patch.
  assert.deepEqual(body.dispatchDefaults, { agent: "codex", model: "gpt-5.5", effort: "high" });

  const read = await fetch(`${baseUrl}/config`, authed);
  const readBody = (await read.json()) as { mateDefaults: unknown };
  assert.deepEqual(readBody.mateDefaults, { agent: "codex", model: "opus", effort: "high" });

  // Clean up so later tests in this file see empty mate defaults again.
  await fetch(`${baseUrl}/config`, {
    ...authed,
    method: "PATCH",
    body: JSON.stringify({ mateDefaults: { agent: null, model: null, effort: null } })
  });
});

test("WebSocket RPC GET/PATCH /config mirrors HTTP config behavior", async () => {
  const patch = await configRpc("PATCH", {
    dispatchDefaults: { agent: "codex", model: "gpt-5.4", effort: "low" }
  });
  assert.equal(patch.ok, true);
  assert.equal(patch.status, 200);
  assert.deepEqual(patch.body, {
    dispatchDefaults: { agent: "codex", model: "gpt-5.4", effort: "low" },
    mateDefaults: {},
    mateResolved: MATE_RESOLVED_DEFAULT
  });

  const read = await configRpc("GET");
  assert.equal(read.ok, true);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, {
    dispatchDefaults: { agent: "codex", model: "gpt-5.4", effort: "low" },
    mateDefaults: {},
    mateResolved: MATE_RESOLVED_DEFAULT
  });

  await configRpc("PATCH", {
    dispatchDefaults: { agent: "codex", model: "gpt-5.5", effort: "high" }
  });
});

test("an explicit per-task value always wins, and the default model/effort never leak onto a different agent", async () => {
  // Defaults are still codex/gpt-5.5/high from the previous test.
  const request = await dispatch({ title: "t-override", agent: "claude", model: "haiku" });
  assert.equal(request.agent, "claude");
  assert.equal(request.model, "haiku");
  // The codex default effort does not ride along onto a claude worker.
  assert.equal(request.effort, undefined);

  // An explicit value on the SAME agent as the default still wins field-wise.
  const codexRequest = await dispatch({ title: "t-override-codex", agent: "codex", model: "gpt-5.4", effort: "low" });
  assert.equal(codexRequest.model, "gpt-5.4");
  assert.equal(codexRequest.effort, "low");
});

test("persisted dispatchDefaults win over the built-in Codex fallback, even when partial", async () => {
  const patched = await fetch(`${baseUrl}/config`, {
    ...authed,
    method: "PATCH",
    body: JSON.stringify({ dispatchDefaults: { agent: "claude", model: null, effort: null } })
  });
  assert.equal(patched.status, 200);

  const request = await dispatch({ title: "t-persisted-partial" });
  assert.equal(request.agent, "claude");
  assert.equal(request.model, undefined);
  assert.equal(request.effort, undefined);
});

test("persisted Claude dispatch model never leaks onto an explicit Codex worker", async () => {
  const patched = await fetch(`${baseUrl}/config`, {
    ...authed,
    method: "PATCH",
    body: JSON.stringify({ dispatchDefaults: { agent: "claude", model: "opus", effort: null } })
  });
  assert.equal(patched.status, 200);

  const request = await dispatch({ title: "t-claude-default-explicit-codex", agent: "codex" });
  assert.equal(request.agent, "codex");
  assert.equal(request.model, DISPATCH_CODEX_FALLBACK.model);
  assert.equal(request.effort, DISPATCH_CODEX_FALLBACK.effort);
});

test("PATCH /config refuses values outside the whitelist with a 400", async () => {
  const badAgent = await fetch(`${baseUrl}/config`, {
    ...authed,
    method: "PATCH",
    body: JSON.stringify({ dispatchDefaults: { agent: "gemini" } })
  });
  assert.equal(badAgent.status, 400);
  assert.match(((await badAgent.json()) as { error: string }).error, /invalid default agent/);

  const badEffort = await fetch(`${baseUrl}/config`, {
    ...authed,
    method: "PATCH",
    body: JSON.stringify({ dispatchDefaults: { effort: "maximum" } })
  });
  assert.equal(badEffort.status, 400);

  const badMateAgent = await fetch(`${baseUrl}/config`, {
    ...authed,
    method: "PATCH",
    body: JSON.stringify({ mateDefaults: { agent: "gemini" } })
  });
  assert.equal(badMateAgent.status, 400);
  assert.match(((await badMateAgent.json()) as { error: string }).error, /invalid mate agent/);

  for (const body of [
    { unknownLayer: {} },
    { dispatchDefaults: { unknownKey: "value" } },
    { dispatchDefaults: { agent: true } },
    {}
  ]) {
    const invalidShape = await fetch(`${baseUrl}/config`, {
      ...authed,
      method: "PATCH",
      body: JSON.stringify(body)
    });
    assert.equal(invalidShape.status, 400, JSON.stringify(body));
  }
});

test("default worktree capacity supports more than eight dispatched tasks", () => {
  assert.equal(DEFAULT_MAX_SLOTS, 16);
  assert.ok(
    adapter.startRequests.length > 8,
    `expected this dispatch suite to exceed eight launches, got ${adapter.startRequests.length}`
  );
});
