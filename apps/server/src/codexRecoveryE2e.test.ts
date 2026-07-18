import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { Task } from "@perch/shared";
import WebSocket from "ws";

const RUN_REAL = process.env.PERCH_REAL_CODEX_E2E === "1";
const repoRoot = resolve(import.meta.dirname, "../../..");
const serverEntry = join(repoRoot, "apps/server/dist/index.js");
let serverLogs = "";

test("private-home E2E: real Codex thread survives server restart and explicit duplicate-safe recovery", {
  skip: !RUN_REAL,
  timeout: 180_000
}, async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-codex-recovery-e2e-"));
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
    const freshSnapshot = await terminalSnapshot(port, token, originalSession);
    assert.equal(freshSnapshot.cols, 100);
    assert.equal(freshSnapshot.rows, 32);
    assert.match(freshSnapshot.data, /\x1b\[>[0-9;]+u/, "fresh live attach must restore Codex keyboard mode");
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

    const sessions = await request<{ sessions: Array<{ id: string }> }>(port, token, "/sessions");
    assert.equal(sessions.sessions.filter((session) => session.id === recovered.sessionId).length, 1);
    await waitForRecoveredTurn(port, token, created.task.id, recovered.sessionId!);
    await request(port, token, `/sessions/${encodeURIComponent(recovered.sessionId!)}/submit`, {
      method: "POST",
      body: JSON.stringify({
        text: "Without using tools, reply with the prefix RECOVERY_E2E_CONTEXT_ followed immediately by the UUID I asked you to remember before the restart."
      })
    });
    await waitForTerminalText(port, token, recovered.sessionId!, `RECOVERY_E2E_CONTEXT_${secret}`);

    const recoveredSnapshot = await terminalSnapshot(port, token, recovered.sessionId!);
    assert.equal(recoveredSnapshot.cols, 100);
    assert.equal(recoveredSnapshot.rows, 32);
    assert.match(
      recoveredSnapshot.data,
      /\x1b\[>[0-9;]+u/,
      "crash-recovery attach must restore the same Codex keyboard mode as a fresh attach"
    );

    const firstLine = `RECOVERY_MULTILINE_ONE_${secret}`;
    const secondLine = `RECOVERY_MULTILINE_TWO_${secret}`;
    await sendTerminalInput(port, token, recovered.sessionId!, `${firstLine}\x1b[13;2u${secondLine}`);
    const multilineSnapshot = await terminalSnapshot(port, token, recovered.sessionId!);
    assert.ok(multilineSnapshot.data.includes(firstLine), "recovered composer must retain the first draft line");
    assert.ok(multilineSnapshot.data.includes(secondLine), "Shift+Enter must insert a second draft line");
    await sendTerminalInput(port, token, recovered.sessionId!, "\x15");
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
  const trusted = new Set<string>();
  let latest: Task | undefined;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const { task } = await request<{ task: Task }>(port, token, `/tasks/${encodeURIComponent(taskId)}`);
    latest = task;
    if (predicate(task)) return task;
    if (task.sessionId && !trusted.has(task.sessionId)) {
      if (await acceptTrustPromptIfPresent(port, token, task.sessionId)) trusted.add(task.sessionId);
    }
    if (task.sessionId) await dismissCodexHookMenuIfPresent(port, token, task.sessionId);
    await delay(250);
  }
  const logs = latest?.sessionId
    ? await request<{ events: Array<{ text?: string }> }>(
        port,
        token,
        `/sessions/${encodeURIComponent(latest.sessionId)}/logs?lines=200`
      ).catch(() => undefined)
    : undefined;
  throw new Error(
    `task ${taskId} did not reach expected state: ${JSON.stringify({ latest, logs })}\n${serverLogs.slice(-12_000)}`
  );
}

async function waitForRecoveredTurn(port: number, token: string, taskId: string, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const detail = await request<{
      events: Array<{ seq: number; kind: string; data?: Record<string, unknown> }>;
    }>(port, token, `/tasks/${encodeURIComponent(taskId)}`);
    const started = detail.events.find(
      (event) => event.kind === "turn_started" && event.data?.sessionId === sessionId
    );
    if (started) return;
    await delay(250);
  }
  throw new Error(`task ${taskId} did not start a recovered turn without human input`);
}

async function waitForWorkerWorkingEvent(port: number, token: string, taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const detail = await request<{
      events: Array<{ kind: string; source: string }>;
    }>(port, token, `/tasks/${encodeURIComponent(taskId)}`);
    if (detail.events.some((event) => event.kind === "working" && event.source === "worker")) return;
    await delay(250);
  }
  throw new Error(`task ${taskId} did not report working before the restart`);
}

async function waitForTerminalText(port: number, token: string, sessionId: string, expected: string): Promise<void> {
  let trusted = false;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const logs = await request<{ events: Array<{ type: string; text?: string }> }>(
      port,
      token,
      `/sessions/${encodeURIComponent(sessionId)}/logs?lines=200`
    );
    const terminal = logs.events
      .filter((event) => event.type === "terminal_output")
      .map((event) => event.text ?? "")
      .join("");
    if (terminal.includes(expected)) return;
    if (!trusted && isTrustPrompt(terminal)) {
      await request(port, token, `/sessions/${encodeURIComponent(sessionId)}/submit`, {
        method: "POST",
        body: JSON.stringify({ text: "1" })
      });
      trusted = true;
    }
    await delay(250);
  }
  throw new Error(`session ${sessionId} did not emit ${expected}`);
}

async function acceptTrustPromptIfPresent(port: number, token: string, sessionId: string): Promise<boolean> {
  const logs = await request<{ events: Array<{ text?: string }> }>(
    port,
    token,
    `/sessions/${encodeURIComponent(sessionId)}/logs?lines=200`
  ).catch(() => undefined);
  const text = logs?.events.map((event) => event.text ?? "").join("") ?? "";
  if (!isTrustPrompt(text)) return false;
  await request(port, token, `/sessions/${encodeURIComponent(sessionId)}/submit`, {
    method: "POST",
    body: JSON.stringify({ text: "1" })
  });
  return true;
}

async function dismissCodexHookMenuIfPresent(port: number, token: string, sessionId: string): Promise<boolean> {
  const logs = await request<{ events: Array<{ text?: string }> }>(
    port,
    token,
    `/sessions/${encodeURIComponent(sessionId)}/logs?lines=200`
  ).catch(() => undefined);
  const text = logs?.events.map((event) => event.text ?? "").join("") ?? "";
  const hookToggle = text.includes("Turn hooks on or off") && text.includes("Press esc to go back");
  const hookSummary = text.includes("Lifecycle hooks from config") && text.includes("esc to close");
  if (!hookToggle && !hookSummary) return false;
  await sendTerminalInput(port, token, sessionId, "\x1b");
  return true;
}

function isTrustPrompt(text: string): boolean {
  return text.includes("Do you trust the contents of this directory?") || text.includes("Yes, I trust this folder");
}

async function request<T = unknown>(
  port: number,
  token: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers }
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

async function terminalSnapshot(
  port: number,
  token: string,
  sessionId: string
): Promise<{ data: string; cols: number; rows: number }> {
  return await new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`timed out waiting for terminal snapshot for ${sessionId}`));
    }, 10_000);
    socket.on("open", () => {
      // Match a real desktop attach: geometry arrives before subscription, so
      // Codex redraws at the terminal's actual size before Perch snapshots it.
      socket.send(JSON.stringify({ type: "resize", sessionId, cols: 100, rows: 32 }));
      socket.send(JSON.stringify({ type: "subscribe", sessionId }));
    });
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as {
        type?: string;
        event?: { type?: string; sessionId?: string; data?: string; cols?: number; rows?: number };
      };
      if (
        message.type === "event" &&
        message.event?.type === "terminal_snapshot" &&
        message.event.sessionId === sessionId &&
        typeof message.event.data === "string" &&
        typeof message.event.cols === "number" &&
        typeof message.event.rows === "number"
      ) {
        clearTimeout(timer);
        socket.close();
        resolvePromise({ data: message.event.data, cols: message.event.cols, rows: message.event.rows });
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function sendTerminalInput(port: number, token: string, sessionId: string, data: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "input", sessionId, data }), (error) => {
        if (error) {
          reject(error);
          return;
        }
        setTimeout(() => {
          socket.close();
          resolvePromise();
        }, 250);
      });
    });
    socket.on("error", reject);
  });
}

const delay = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
