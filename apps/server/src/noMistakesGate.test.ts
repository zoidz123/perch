import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  AgentSession,
  NoMistakesDispatchRefusal,
  NoMistakesInitResult,
  RecentEventsResult,
  StartAgentRequest,
  WebSocketRpcRequest
} from "@perch/shared";
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

// T3: setting a project's mode to no-mistakes over HTTP is consent to run
// `no-mistakes init` right away (O2), and dispatching a task whose effective
// mode is no-mistakes against an unready gate is refused with a structured
// 422 before any task record or worktree lease exists. Never the real binary
// in tests: PATH shims record what ran, scratch git repos carry the gate
// remote.

class DispatchAdapter implements AgentAdapter {
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
  async startAgent(request: StartAgentRequest): Promise<AgentSession> {
    const id = `pty:${randomUUID()}`;
    const session: AgentSession = {
      id,
      title: request.title ?? request.command,
      agent: request.agent ?? "claude",
      cwd: request.cwd,
      workspaceId: "perch-pty",
      paneId: id,
      surfaceId: id,
      kind: "terminal",
      status: "running",
      lastActivityAt: new Date().toISOString()
    };
    this.sessions.push(session);
    return session;
  }
}

type Fixture = {
  port: number;
  home: string;
  bin: string;
  repo: string;
  initLog: string;
  adapter: DispatchAdapter;
  tasks: TaskStore;
  projects: ProjectRegistry;
  rpc: (
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown
  ) => ReturnType<typeof handleWebSocketRpcRequest>;
};

// A fake no-mistakes binary: records every `init` invocation's cwd, then does
// what the real init does to readiness - adds the `no-mistakes` git remote.
function writeInitShim(bin: string, initLog: string): void {
  writeFileSync(
    join(bin, "no-mistakes"),
    [
      "#!/bin/sh",
      'if [ "$1" = "init" ]; then',
      `  echo "$PWD" >> "${initLog}"`,
      '  git remote add no-mistakes "$PWD/.fake-gate.git" 2>/dev/null || true',
      '  echo "gate refreshed"',
      "  exit 0",
      "fi",
      'echo "no-mistakes version v1.31.2"'
    ].join("\n"),
    { mode: 0o755 }
  );
}

function initRuns(initLog: string): string[] {
  return existsSync(initLog)
    ? readFileSync(initLog, "utf8").trim().split("\n").filter(Boolean)
    : [];
}

async function withServer(run: (ctx: Fixture) => Promise<void>): Promise<void> {
  // realpath: on macOS the tmpdir is a symlink (/var -> /private/var), and the
  // shim logs the shell's fully resolved $PWD.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "perch-nm-home-")));
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "perch-nm-bin-")));
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "perch-nm-repo-")));
  const initLog = join(home, "init-runs.log");
  // The worktree pool needs a real repo with a commit to lease slots from.
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# demo\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], {
    cwd: repo
  });

  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  const adapter = new DispatchAdapter();
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
    }),
    // The gate's binary lookup rides the doctor's injected PATH, so tests
    // control exactly which tools exist.
    doctorDeps: { env: { PATH: bin } }
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
    await run({ port, home, bin, repo, initLog, adapter, tasks, projects, rpc });
  } finally {
    timeline.stop();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const dir of [home, bin, repo]) rmSync(dir, { recursive: true, force: true });
  }
}

const authed = { authorization: "Bearer test-token", "content-type": "application/json" };

function post(port: number, path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: authed,
    body: JSON.stringify(body)
  });
}

test("POST /projects with mode no-mistakes runs init in the repo, idempotently, audit-logged", async () => {
  await withServer(async ({ port, home, bin, repo, initLog }) => {
    writeInitShim(bin, initLog);

    const first = await post(port, "/projects", { rootPath: repo, mode: "no-mistakes" });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as {
      project: { mode?: string };
      noMistakes?: NoMistakesInitResult;
    };
    assert.equal(firstBody.project.mode, "no-mistakes");
    assert.equal(firstBody.noMistakes?.ran, true);
    assert.equal(firstBody.noMistakes?.initialized, true, "init added the gate remote");
    assert.equal(firstBody.noMistakes?.ready, true);
    assert.equal(firstBody.noMistakes?.output, "gate refreshed");

    // Re-setting the mode re-runs init (idempotent upstream) and stays ready.
    const second = await post(port, "/projects", { rootPath: repo, mode: "no-mistakes" });
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as { noMistakes?: NoMistakesInitResult };
    assert.equal(secondBody.noMistakes?.ready, true);

    assert.deepEqual(initRuns(initLog), [repo, repo], "init ran once per mode set, cwd = repo root");

    const audit = readFileSync(join(home, "audit.jsonl"), "utf8");
    const initEntries = audit
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { action: string; cwd?: string })
      .filter((entry) => entry.action === "no_mistakes_init");
    assert.equal(initEntries.length, 2);
    assert.equal(initEntries[0]?.cwd, repo);
  });
});

test("POST /projects with mode no-mistakes but no binary saves the project with a doctor --fix warning", async () => {
  await withServer(async ({ port, repo, initLog, projects }) => {
    const response = await post(port, "/projects", { rootPath: repo, mode: "no-mistakes" });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      project: { mode?: string };
      noMistakes?: NoMistakesInitResult;
    };
    assert.equal(body.project.mode, "no-mistakes", "the project is saved either way");
    assert.equal(projects.find(repo)?.mode, "no-mistakes");
    assert.equal(body.noMistakes?.ran, false);
    assert.equal(body.noMistakes?.ready, false);
    assert.match(body.noMistakes?.warning ?? "", /perch doctor --fix/);
    assert.deepEqual(initRuns(initLog), [], "nothing to run without the binary");
  });
});

test("upstream init failure surfaces its error text verbatim", async () => {
  await withServer(async ({ port, bin, repo, initLog }) => {
    writeFileSync(
      join(bin, "no-mistakes"),
      '#!/bin/sh\nif [ "$1" = "init" ]; then echo "fatal: no origin remote configured" >&2; exit 1; fi\necho v1',
      { mode: 0o755 }
    );
    const response = await post(port, "/projects", { rootPath: repo, mode: "no-mistakes" });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { noMistakes?: NoMistakesInitResult };
    assert.equal(body.noMistakes?.ran, true);
    assert.equal(body.noMistakes?.ready, false);
    assert.match(body.noMistakes?.warning ?? "", /no origin remote configured/);
    assert.deepEqual(initRuns(initLog), []);
  });
});

test("registration without an explicit no-mistakes mode never initializes", async () => {
  await withServer(async ({ port, bin, repo, initLog, projects }) => {
    writeInitShim(bin, initLog);

    // Passive session-start registration.
    projects.touch(repo);
    // Explicit registration with no mode, and with a different mode.
    assert.equal((await post(port, "/projects", { rootPath: repo })).status, 200);
    assert.equal((await post(port, "/projects", { rootPath: repo, mode: "direct-PR" })).status, 200);

    assert.deepEqual(initRuns(initLog), [], "init rides explicit no-mistakes intent only");
  });
});

test("dispatch with effective mode no-mistakes and no binary is refused with a structured 422", async () => {
  await withServer(async ({ port, repo, adapter, tasks, projects }) => {
    // Project default carries the mode; the task body sets none (default path).
    projects.touch(repo, { mode: "no-mistakes" });

    const response = await post(port, "/tasks", { title: "gated work", project: repo, dispatch: true });
    assert.equal(response.status, 422);
    const body = (await response.json()) as NoMistakesDispatchRefusal;
    assert.match(body.error, /perch doctor --fix/);
    assert.equal(body.noMistakes.binaryFound, false);
    assert.ok(body.noMistakes.missing.some((item) => item.includes("perch doctor --fix")));

    assert.equal(tasks.list().length, 0, "refusal happens before the task record exists");
    assert.equal(adapter.sessions.length, 0, "no worker spawned");
  });
});

test("dispatch against an uninitialized repo is refused with the init fix, and no lease leaks", async () => {
  await withServer(async ({ port, home, bin, repo, adapter, tasks, initLog, projects }) => {
    writeInitShim(bin, initLog);
    projects.touch(repo, { mode: "no-mistakes" });
    // Binary present, but the repo never ran init (no gate remote).

    const response = await post(port, "/tasks", { title: "gated work", project: repo, dispatch: true });
    assert.equal(response.status, 422);
    const body = (await response.json()) as NoMistakesDispatchRefusal;
    assert.equal(body.noMistakes.binaryFound, true);
    assert.equal(body.noMistakes.initialized, false);
    assert.match(body.error, /repo not initialized/);
    assert.match(body.error, /--mode no-mistakes/);

    assert.equal(tasks.list().length, 0);
    assert.equal(adapter.sessions.length, 0);
    assert.ok(!existsSync(join(home, "worktrees")), "no worktree lease was acquired");
  });
});

test("the RPC surface mirrors the 422 refusal", async () => {
  await withServer(async ({ repo, tasks, projects, rpc }) => {
    projects.touch(repo, { mode: "no-mistakes" });
    const refused = await rpc("POST", "/tasks", { title: "gated work", project: repo, dispatch: true });
    assert.equal(refused.status, 422);
    assert.match(refused.ok ? "" : (refused.error ?? ""), /perch doctor --fix/);
    assert.equal(tasks.list().length, 0);
  });
});

test("a per-task no-mistakes override is gated even when the project mode says direct-PR", async () => {
  await withServer(async ({ port, repo, tasks, projects }) => {
    projects.touch(repo, { mode: "direct-PR" });
    const response = await post(port, "/tasks", {
      title: "risky change",
      project: repo,
      mode: "no-mistakes",
      dispatch: true
    });
    assert.equal(response.status, 422, "the explicit body mode wins over the project default");
    assert.equal(tasks.list().length, 0);
  });
});

test("direct-PR dispatch is untouched: no gate check, worker spawns normally", async () => {
  await withServer(async ({ port, repo, adapter, tasks }) => {
    // No binary anywhere, no project mode, no body mode: O1 keeps the default
    // direct-PR, which must never hit the readiness gate.
    const byDefault = await post(port, "/tasks", { title: "plain work", project: repo, dispatch: true });
    assert.equal(byDefault.status, 201);
    const created = (await byDefault.json()) as {
      task: { id: string; mode: string; sessionId?: string; state: string };
    };
    assert.equal(created.task.mode, "direct-PR");
    assert.ok(created.task.sessionId, "worker spawned");
    assert.equal(created.task.state, "working", "session activation moves the task out of queued");
    assert.equal(adapter.sessions.length, 1);

    const listed = await fetch(`http://127.0.0.1:${port}/tasks`, { headers: authed });
    assert.equal(listed.status, 200);
    const listBody = (await listed.json()) as { tasks: Array<{ id: string; state: string }> };
    assert.equal(
      listBody.tasks.find((task) => task.id === created.task.id)?.state,
      "working",
      "app-visible task list reflects the synthesized working state"
    );
    const workingEvents = tasks.events(created.task.id).filter((event) => event.kind === "working");
    assert.equal(workingEvents.length, 1, "dispatch synthesis is not noisy");
    assert.equal(workingEvents[0]?.source, "system");
  });
});

test("an explicit direct-PR override dispatches even when the gated project default is unready", async () => {
  await withServer(async ({ port, repo, adapter, projects }) => {
    projects.touch(repo, { mode: "no-mistakes" });
    const response = await post(port, "/tasks", {
      title: "ungated on purpose",
      project: repo,
      mode: "direct-PR",
      dispatch: true
    });
    assert.equal(response.status, 201);
    const created = (await response.json()) as { task: { mode: string } };
    assert.equal(created.task.mode, "direct-PR");
    assert.equal(adapter.sessions.length, 1);
  });
});

test("a ready gate dispatches normally with mode no-mistakes", async () => {
  await withServer(async ({ port, bin, repo, adapter, initLog }) => {
    writeInitShim(bin, initLog);
    // Set the mode over HTTP first: consent -> init -> ready.
    const registered = await post(port, "/projects", { rootPath: repo, mode: "no-mistakes" });
    assert.equal(registered.status, 200);

    const response = await post(port, "/tasks", { title: "gated work", project: repo, dispatch: true });
    assert.equal(response.status, 201);
    const created = (await response.json()) as { task: { mode: string; sessionId?: string } };
    assert.equal(created.task.mode, "no-mistakes");
    assert.ok(created.task.sessionId, "worker spawned into the ready gate");
    assert.equal(adapter.sessions.length, 1);
  });
});
