import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { AgentSession, Task } from "@perch/shared";
import { recoveryE2eEnv } from "./recoveryE2eEnv.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const serverEntry = join(repoRoot, "apps/server/dist/index.js");
const requested = (process.env.PERCH_REAL_MATE_E2E ?? "").toLowerCase();

for (const provider of ["claude", "codex"] as const) {
  test(`private-home E2E: real ${provider} mate and two-child fleet survive a server crash`, {
    skip: requested !== "all" && requested !== provider,
    timeout: 300_000
  }, async () => {
    const home = mkdtempSync(join(tmpdir(), `perch-${provider}-mate-recovery-e2e-`));
    const port = await freePort();
    assertIsolated(home, port);
    let server: ChildProcess | undefined;
    try {
      server = startServer(home, port);
      const token = await waitForToken(home);
      await waitForHealth(port, token);
      const started = await request<{ session: AgentSession }>(port, token, "/mate/start", {
        method: "POST",
        body: JSON.stringify({ agent: provider })
      });
      if (provider === "codex") {
        await waitForTerminalText(port, token, started.session.id, "OpenAI Codex");
      }
      let beforeMate = provider === "claude"
        ? await waitForMate(port, token, (mate) =>
            mate.mateOwner?.state === "live" && Boolean(mate.mateOwner.providerSessionId)
          )
        : undefined;
      await request(port, token, `/sessions/${encodeURIComponent(started.session.id)}/submit`, {
        method: "POST",
        body: JSON.stringify({ text: "Reply with MATE_RECOVERY_E2E_READY and wait for more input." })
      });
      beforeMate ??= await waitForMate(port, token, (mate) =>
        mate.mateOwner?.state === "live" && Boolean(mate.mateOwner.providerSessionId)
      );
      await waitForAssistantText(port, token, started.session.id, "MATE_RECOVERY_E2E_READY");
      const oldMateSession = started.session.id;
      const oldMateProviderSession = beforeMate.mateOwner!.providerSessionId!;
      const oldMateGeneration = beforeMate.mateOwner!.generation;

      const originals: Task[] = [];
      for (let index = 0; index < 2; index += 1) {
        const created = await request<{ task: Task }>(port, token, "/tasks", {
          method: "POST",
          body: JSON.stringify({
            title: `${provider} mate recovery child ${index + 1}`,
            project: repoRoot,
            kind: "scout",
            mode: "local-only",
            agent: provider,
            parent: oldMateSession,
            dispatch: true,
            prompt:
              `Do not change files. Report working immediately, then run the shell command sleep 45. ` +
              `After it finishes, reply with CHILD_RECOVERY_E2E_READY_${index + 1} and keep the task working.`
          })
        });
        const original = await waitForTask(port, token, created.task.id, (task) =>
          task.runtime?.state === "live" && Boolean(task.runtime.providerSessionId)
        );
        await waitForWorkerWorkingEvent(port, token, original.id);
        originals.push(await waitForTask(port, token, original.id, (task) => task.state === "working"));
      }

      await crashServer(server, home, port);
      server = startServer(home, port);
      await waitForHealth(port, token);
      await waitForMate(port, token, (mate) => mate.mateOwner?.state === "recoverable");
      for (const original of originals) {
        await waitForTask(port, token, original.id, (task) => task.runtime?.state === "recoverable");
      }

      const recover = () => fetch(`http://127.0.0.1:${port}/mate/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}"
      });
      const responses = await Promise.all([recover(), recover()]);
      const bodies = await Promise.all(responses.map(async (response) => ({
        status: response.status,
        body: await response.json() as { session?: AgentSession; error?: string }
      })));
      assert.deepEqual(bodies.map((entry) => entry.status), [200, 200], JSON.stringify(bodies));
      assert.equal(bodies[0]?.body.session?.id, bodies[1]?.body.session?.id);

      const afterMate = await waitForMate(port, token, (mate) => mate.mateOwner?.state === "live");
      assert.equal(afterMate.mateOwner?.providerSessionId, oldMateProviderSession);
      assert.equal(afterMate.mateOwner?.generation, oldMateGeneration + 1);
      assert.notEqual(afterMate.session?.id, oldMateSession);

      for (const original of originals) {
        const recovered = await waitForTask(port, token, original.id, (task) => task.runtime?.state === "live");
        assert.equal(recovered.runtime?.providerSessionId, original.runtime?.providerSessionId);
        assert.equal(recovered.runtime?.generation, original.runtime!.generation + 1);
        assert.equal(recovered.parentSessionId, afterMate.session?.id);
        assert.equal(recovered.workerName, original.workerName);
        assert.equal(recovered.worktreeId, original.worktreeId);
        assert.equal(recovered.runtime?.model, original.runtime?.model);
        await waitForRecoveredTurn(port, token, original.id, recovered.sessionId!);
        await request(port, token, `/tasks/${encodeURIComponent(original.id)}/teardown`, {
          method: "POST",
          body: JSON.stringify({ force: true })
        });
      }
    } finally {
      if (server) await stopServer(server, home, port).catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  });
}

type MateStatus = {
  mateOwner?: {
    generation: number;
    state: string;
    providerSessionId?: string;
  };
  session?: AgentSession;
};

function startServer(home: string, port: number): ChildProcess {
  assertIsolated(home, port);
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...recoveryE2eEnv(home),
      PORT: String(port),
      PERCH_RELAY_URL: "off",
      PERCH_RECOVERY_IDENTITY_TIMEOUT_MS: "30000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.pipe(process.stderr);
  child.stderr?.pipe(process.stderr);
  assert.ok(child.pid);
  console.error(`mate-recovery-e2e start provider-home=${resolve(home)} pid=${child.pid} port=${port}`);
  return child;
}

async function crashServer(child: ChildProcess, home: string, port: number): Promise<void> {
  assertIsolated(home, port);
  assert.ok(child.pid);
  console.error(`mate-recovery-e2e crash pid=${child.pid} home=${resolve(home)} port=${port}`);
  assert.equal(child.kill("SIGKILL"), true);
  await waitForExit(child);
}

async function stopServer(child: ChildProcess, home: string, port: number): Promise<void> {
  assertIsolated(home, port);
  if (child.exitCode !== null || child.signalCode !== null) return;
  assert.equal(child.kill("SIGTERM"), true);
  await waitForExit(child);
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("isolated server did not exit")), 15_000);
    child.once("exit", () => { clearTimeout(timer); resolvePromise(); });
  });
}

function assertIsolated(home: string, port: number): void {
  assert.notEqual(resolve(home), resolve(homedir(), ".perch"));
  assert.notEqual(port, 8787);
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
  throw new Error("isolated server token did not appear");
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
  throw new Error("isolated server did not become healthy");
}

async function waitForMate(port: number, token: string, predicate: (status: MateStatus) => boolean): Promise<MateStatus> {
  let latest: MateStatus | undefined;
  const trusted = new Set<string>();
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const status = await request<MateStatus>(port, token, "/mate");
    latest = status;
    if (predicate(status)) return status;
    if (status.session && !trusted.has(status.session.id)) {
      if (await acceptTrustPromptIfPresent(port, token, status.session.id)) trusted.add(status.session.id);
    }
    await delay(250);
  }
  const logs = latest?.session
    ? await request<{ events: Array<{ text?: string }> }>(
        port,
        token,
        `/sessions/${encodeURIComponent(latest.session.id)}/logs?lines=200`
      ).catch(() => undefined)
    : undefined;
  throw new Error(`mate did not reach expected durable state: ${JSON.stringify({ latest, logs })}`);
}

async function waitForTask(
  port: number,
  token: string,
  taskId: string,
  predicate: (task: Task) => boolean
): Promise<Task> {
  const trusted = new Set<string>();
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { task } = await request<{ task: Task }>(port, token, `/tasks/${encodeURIComponent(taskId)}`);
    if (predicate(task)) return task;
    if (task.sessionId && !trusted.has(task.sessionId)) {
      if (await acceptTrustPromptIfPresent(port, token, task.sessionId)) trusted.add(task.sessionId);
    }
    await delay(250);
  }
  throw new Error(`task ${taskId} did not reach expected state`);
}

async function waitForRecoveredTurn(port: number, token: string, taskId: string, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
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
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const detail = await request<{
      events: Array<{ kind: string; source: string }>;
    }>(port, token, `/tasks/${encodeURIComponent(taskId)}`);
    if (detail.events.some((event) => event.kind === "working" && event.source === "worker")) return;
    await delay(250);
  }
  throw new Error(`task ${taskId} did not report working before the crash`);
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

async function waitForTerminalText(
  port: number,
  token: string,
  sessionId: string,
  expected: string,
  occurrences = 1
): Promise<void> {
  let trusted = false;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const logs = await request<{ events: Array<{ type: string; text?: string }> }>(
      port,
      token,
      `/sessions/${encodeURIComponent(sessionId)}/logs?lines=200`
    );
    const text = logs.events.map((event) => event.text ?? "").join("");
    if (text.split(expected).length - 1 >= occurrences) return;
    if (!trusted && isTrustPrompt(text)) {
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

function isTrustPrompt(text: string): boolean {
  return text.includes("Do you trust the contents of this directory?") || text.includes("Yes, I trust this folder");
}

async function waitForAssistantText(port: number, token: string, sessionId: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const timeline = await request<{ items: Array<{ kind: string; text?: string }> }>(
      port,
      token,
      `/sessions/${encodeURIComponent(sessionId)}/timeline`
    );
    if (timeline.items.some((item) => item.kind === "assistant" && item.text?.includes(expected))) return;
    await acceptTrustPromptIfPresent(port, token, sessionId);
    await delay(250);
  }
  throw new Error(`session ${sessionId} did not persist assistant text ${expected}`);
}

async function request<T>(port: number, token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers }
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

const delay = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
