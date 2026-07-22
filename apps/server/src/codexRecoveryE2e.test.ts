import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { Task } from "@perch/shared";

// Real-codex end-to-end for the app-server-owned topology (opt-in:
// PERCH_REAL_CODEX_E2E=1, requires a signed-in codex install and network).
// Exercises the full production stack from dist/: dispatch launches an
// owned worker (no PTY), the kickoff is the acknowledged first turn, the
// session surfaces its native attach command, a server restart flips the
// runtime recoverable, duplicate-safe recovery thread/resumes the exact
// thread into g+1, the continuation turn starts unprompted, and the resumed
// conversation still remembers pre-restart context.

const RUN_REAL = process.env.PERCH_REAL_CODEX_E2E === "1";
const repoRoot = resolve(import.meta.dirname, "../../..");
const serverEntry = join(repoRoot, "apps/server/dist/index.js");
let serverLogs = "";

test("private-home E2E: real Codex thread survives server restart and explicit duplicate-safe recovery", {
  skip: !RUN_REAL,
  timeout: 240_000
}, async () => {
  // A SHORT real-path home: the per-session daemon socket lives under
  // $PERCH_HOME/codex-daemons and must stay inside the macOS 104-byte
  // sun_path limit (the default /var/folders/... tmpdir is too deep).
  const home = mkdtempSync("/private/tmp/perch-e2e-");
  const port = await freePort();
  assertIsolatedRecoveryTarget(home, port);
  const secret = randomUUID();
  let server: ChildProcess | undefined;
  let disposableThread: string | undefined;
  try {
    server = startServer(home, port);
    const token = await waitForToken(home);
    await waitForHealth(port, token);
    const created = await request<{ task: Task }>(port, token, "/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: "real codex recovery e2e",
        project: repoRoot,
        kind: "scout",
        mode: "local-only",
        agent: "codex",
        dispatch: true,
        prompt:
          `Do not change files. Remember the UUID ${secret}. Report working immediately, then run the shell command sleep 30. ` +
          `After it finishes, reply with the prefix RECOVERY_E2E_READY_ followed immediately by that UUID and keep the task working.`
      })
    });
    let original = await waitForTask(port, token, created.task.id, (task) =>
      task.runtime?.state === "live" && Boolean(task.runtime.providerSessionId)
    );
    const originalThread = original.runtime!.providerSessionId!;
    disposableThread = originalThread;
    const originalSession = original.sessionId!;
    const originalGeneration = original.runtime!.generation;

    // The kickoff contract landed durably: submitted, then accepted.
    await waitForTaskEvent(port, token, created.task.id, (event) => event.data?.reason === "kickoff_accepted");

    // The owned session surfaces the exact native desktop attach command for
    // its thread and daemon socket - and it has no terminal surface.
    const sessions = await request<{
      sessions: Array<{ id: string; attachCommand?: string }>;
    }>(port, token, "/sessions");
    const ownedSession = sessions.sessions.find((session) => session.id === originalSession);
    assert.ok(ownedSession, "the dispatched session is listed");
    assert.match(
      ownedSession!.attachCommand ?? "",
      new RegExp(`^codex resume ${originalThread} --remote unix://`),
      "the session carries its native TUI attach command"
    );

    await waitForWorkerWorkingEvent(port, token, created.task.id);
    original = await waitForTask(port, token, created.task.id, (task) => task.state === "working");

    await stopServer(server, home, port);
    server = startServer(home, port);
    await waitForHealth(port, token);
    await waitForTask(port, token, created.task.id, (task) => task.runtime?.state === "recoverable");

    const idempotencyKey = randomUUID();
    const recover = () => fetch(`http://127.0.0.1:${port}/tasks/${encodeURIComponent(created.task.id)}/recover`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey })
    });
    const responses = await Promise.all([recover(), recover()]);
    const outcomes = await Promise.all(responses.map(async (response) => ({
      status: response.status,
      body: await response.text()
    })));
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status).sort(),
      [200, 200],
      `${JSON.stringify(outcomes)}\n${serverLogs.slice(-12_000)}`
    );
    const recovered = await waitForTask(port, token, created.task.id, (task) => task.runtime?.state === "live");
    assert.equal(recovered.runtime?.providerSessionId, originalThread);
    assert.equal(recovered.runtime?.generation, originalGeneration + 1);
    assert.notEqual(recovered.sessionId, originalSession);
    assert.equal(recovered.state, original.state);
    assert.equal(recovered.workerName, original.workerName);
    assert.equal(recovered.parentSessionId, original.parentSessionId);
    assert.equal(recovered.worktreeId, original.worktreeId);

    const recoveredSessions = await request<{
      sessions: Array<{ id: string; attachCommand?: string }>;
    }>(port, token, "/sessions");
    const recoveredSession = recoveredSessions.sessions.find((session) => session.id === recovered.sessionId);
    assert.equal(recoveredSessions.sessions.filter((session) => session.id === recovered.sessionId).length, 1);
    assert.match(
      recoveredSession?.attachCommand ?? "",
      new RegExp(`^codex resume ${originalThread} --remote unix://`),
      "the recovered generation still attaches to the same thread"
    );

    // The continuation turn starts without any human input.
    await waitForRecoveredTurn(port, token, created.task.id, recovered.sessionId!);
    await request(port, token, `/sessions/${encodeURIComponent(recovered.sessionId!)}/submit`, {
      method: "POST",
      body: JSON.stringify({
        text: "Without using tools, reply with the prefix RECOVERY_E2E_CONTEXT_ followed immediately by the UUID I asked you to remember before the restart."
      })
    });
    // Protocol-native timeline: the resumed thread proves it kept its context.
    await waitForTimelineText(port, token, recovered.sessionId!, `RECOVERY_E2E_CONTEXT_${secret}`);

    await request(port, token, `/tasks/${encodeURIComponent(created.task.id)}/teardown`, {
      method: "POST",
      body: JSON.stringify({ force: true })
    });
  } finally {
    if (server) await stopServer(server, home, port).catch(() => {});
    if (disposableThread) {
      try {
        execFileSync("codex", ["delete", disposableThread, "--force"], { cwd: repoRoot, stdio: "ignore" });
      } catch {
        console.error(`codex-recovery-e2e could not delete disposable thread ${disposableThread}`);
      }
    }
    rmSync(home, { recursive: true, force: true });
    execFileSync("git", ["worktree", "prune"], { cwd: repoRoot });
  }
});

function startServer(home: string, port: number): ChildProcess {
  assertIsolatedRecoveryTarget(home, port);
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PERCH_HOME: home,
      PORT: String(port),
      PERCH_RELAY_URL: "off",
      PERCH_RECOVERY_IDENTITY_TIMEOUT_MS: "30000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (chunk) => { serverLogs += String(chunk); });
  child.stderr?.on("data", (chunk) => { serverLogs += String(chunk); });
  assert.ok(child.pid, "isolated recovery server did not expose a child PID");
  console.error(`codex-recovery-e2e start pid=${child.pid} home=${resolve(home)} port=${port}`);
  return child;
}

async function stopServer(child: ChildProcess, home: string, port: number): Promise<void> {
  assertIsolatedRecoveryTarget(home, port);
  assert.ok(child.pid, "isolated recovery server is missing its exact child PID");
  console.error(`codex-recovery-e2e stop pid=${child.pid} home=${resolve(home)} port=${port}`);
  if (child.exitCode !== null) return;
  assert.equal(child.kill("SIGTERM"), true, `failed to signal exact recovery server child ${child.pid}`);
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not stop")), 15_000);
    child.once("exit", () => { clearTimeout(timer); resolvePromise(); });
  });
}

function assertIsolatedRecoveryTarget(home: string, port: number): void {
  assert.notEqual(resolve(home), resolve(homedir(), ".perch"), "refusing recovery E2E against ~/.perch");
  assert.notEqual(port, 8787, "refusing recovery E2E against the real Perch port 8787");
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return port;
}

async function waitForToken(home: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { return readFileSync(join(home, "token"), "utf8").trim(); } catch {}
    await delay(100);
  }
  throw new Error("server token did not appear");
}

async function waitForHealth(port: number, token: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: `Bearer ${token}` }
      });
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error("server did not become healthy");
}

async function waitForTask(
  port: number,
  token: string,
  taskId: string,
  predicate: (task: Task) => boolean
): Promise<Task> {
  let latest: Task | undefined;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const { task } = await request<{ task: Task }>(port, token, `/tasks/${encodeURIComponent(taskId)}`);
    latest = task;
    if (predicate(task)) return task;
    await delay(250);
  }
  throw new Error(
    `task ${taskId} did not reach expected state: ${JSON.stringify(latest)}\n${serverLogs.slice(-12_000)}`
  );
}

async function waitForTaskEvent(
  port: number,
  token: string,
  taskId: string,
  predicate: (event: { kind: string; source: string; data?: Record<string, unknown> }) => boolean
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const detail = await request<{
      events: Array<{ kind: string; source: string; data?: Record<string, unknown> }>;
    }>(port, token, `/tasks/${encodeURIComponent(taskId)}`);
    if (detail.events.some(predicate)) return;
    await delay(250);
  }
  throw new Error(`task ${taskId} never recorded the expected event\n${serverLogs.slice(-12_000)}`);
}

async function waitForRecoveredTurn(port: number, token: string, taskId: string, sessionId: string): Promise<void> {
  await waitForTaskEvent(port, token, taskId, (event) =>
    event.kind === "turn_started" && event.data?.sessionId === sessionId
  );
}

async function waitForWorkerWorkingEvent(port: number, token: string, taskId: string): Promise<void> {
  await waitForTaskEvent(port, token, taskId, (event) => event.kind === "working" && event.source === "worker");
}

// The protocol-native transcript: GET /timeline is the phone's view, so the
// assertion reads exactly what a device would.
async function waitForTimelineText(port: number, token: string, sessionId: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const timeline = await request<{ items: Array<{ kind: string; text?: string }> }>(
      port,
      token,
      `/sessions/${encodeURIComponent(sessionId)}/timeline?limit=500`
    );
    if (timeline.items.some((item) => item.kind === "assistant" && item.text?.includes(expected))) return;
    await delay(250);
  }
  throw new Error(`session ${sessionId} never produced "${expected}" in its timeline\n${serverLogs.slice(-12_000)}`);
}

async function request<T>(port: number, token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });
  if (!response.ok) {
    throw new Error(`${path} -> ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
