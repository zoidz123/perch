import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AgentSession, Task } from "@perch/shared";
import Database from "better-sqlite3";
import WebSocket from "ws";
import { recoveryE2eEnv } from "./recoveryE2eEnv.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const serverEntry = join(repoRoot, "apps/server/dist/index.js");
const perchBin = fileURLToPath(new URL("../../../bin/perch.mjs", import.meta.url));
const execFileAsync = promisify(execFile);
const requested = (process.env.PERCH_REAL_MATE_E2E ?? "").toLowerCase();
const LONG_LIVED_MATE_TURNS = 24;

for (const provider of ["claude", "codex"] as const) {
  test(`private-home E2E: real ${provider} mate and two-child fleet survive a server crash`, {
    skip: requested !== "all" && requested !== provider,
    timeout: 300_000
  }, async () => {
    const home = provider === "codex"
      ? mkdtempSync("/private/tmp/perch-codex-mate-crash-e2e-")
      : mkdtempSync(join(tmpdir(), `perch-${provider}-mate-recovery-e2e-`));
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
      const ownedBeforeCrash = provider === "codex" ? ownerRuntimeSnapshot(home) : undefined;
      const daemonBeforeCrash =
        ownedBeforeCrash?.socketPath ? daemonPid(ownedBeforeCrash.socketPath) : undefined;

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
              `Do not use tools or change files. Reply with exactly CHILD_RECOVERY_E2E_READY_${index + 1}.`
          })
        });
        const original = await waitForTask(port, token, created.task.id, (task) =>
          task.runtime?.state === "live" && Boolean(task.runtime.providerSessionId)
        );
        await waitForAssistantText(port, token, original.sessionId!, `CHILD_RECOVERY_E2E_READY_${index + 1}`);
        originals.push(await waitForTask(port, token, original.id, (task) => task.state === "working"));
      }

      await crashServer(server, home, port);
      if (daemonBeforeCrash && ownedBeforeCrash?.socketPath) {
        assert.equal(processExists(daemonBeforeCrash), true);
        assert.equal(existsSync(ownedBeforeCrash.socketPath), true);
      }
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
      if (daemonBeforeCrash && ownedBeforeCrash?.socketPath) {
        const adopted = ownerRuntimeSnapshot(home);
        assert.equal(adopted.socketPath, ownedBeforeCrash.socketPath);
        assert.equal(daemonPid(ownedBeforeCrash.socketPath), daemonBeforeCrash);
      }

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

test("private-home E2E: graceful Codex Mate and two-child fleet preserve exact threads", {
  skip: requested !== "all" && requested !== "codex",
  timeout: 300_000
}, async () => {
  const home = mkdtempSync("/private/tmp/perch-mate-graceful-e2e-");
  const port = await freePort();
  assertIsolated(home, port);
  writeFileSync(
    join(home, "settings.json"),
    `${JSON.stringify({ mateDefaults: { agent: "codex", model: "opus", effort: "high" } })}\n`
  );
  let server: ChildProcess | undefined;
  try {
    server = startServer(home, port);
    const token = await waitForToken(home);
    await waitForHealth(port, token);
    const started = await request<{ session: AgentSession }>(port, token, "/mate/start", {
      method: "POST",
      body: "{}"
    });
    const before = await waitForMate(port, token, (mate) =>
      mate.mateOwner?.state === "live" &&
      mate.mateOwner.model === "gpt-5.6-sol" &&
      Boolean(mate.mateOwner.providerSessionId)
    );
    const oldSession = started.session.id;
    const oldGeneration = before.mateOwner!.generation;
    const providerThread = before.mateOwner!.providerSessionId!;
    const oldOwned = ownerRuntimeSnapshot(home);
    assert.equal(oldOwned.model, "gpt-5.6-sol");
    assert.ok(oldOwned.socketPath);
    const oldDaemonPid = daemonPid(oldOwned.socketPath);
    assert.equal(processExists(oldDaemonPid), true);
    await request(port, token, `/sessions/${encodeURIComponent(oldSession)}/submit`, {
      method: "POST",
      body: JSON.stringify({
        text: "Reply with MATE_GRACEFUL_E2E_READY and wait for more input."
      })
    });
    await waitForAssistantText(port, token, oldSession, "MATE_GRACEFUL_E2E_READY");
    for (let index = 0; index < LONG_LIVED_MATE_TURNS; index += 1) {
      const marker = `MATE_GRACEFUL_HISTORY_${String(index + 1).padStart(2, "0")}`;
      await request(port, token, `/sessions/${encodeURIComponent(oldSession)}/submit`, {
        method: "POST",
        body: JSON.stringify({
          text: `Reply with exactly ${marker}.`
        })
      });
      await waitForAssistantText(port, token, oldSession, marker);
    }

    const originals: Task[] = [];
    for (let index = 0; index < 2; index += 1) {
      const created = await request<{ task: Task }>(port, token, "/tasks", {
        method: "POST",
        body: JSON.stringify({
          title: `graceful Codex Mate child ${index + 1}`,
          project: repoRoot,
          kind: "scout",
          mode: "local-only",
          agent: "codex",
          parent: oldSession,
          dispatch: true,
          prompt:
            `Do not use tools or change files. Reply with exactly GRACEFUL_CHILD_READY_${index + 1}.`
        })
      });
      const original = await waitForTask(port, token, created.task.id, (task) =>
        task.runtime?.state === "live" && Boolean(task.runtime.providerSessionId)
      );
      await waitForAssistantText(
        port,
        token,
        original.sessionId!,
        `GRACEFUL_CHILD_READY_${index + 1}`
      );
      originals.push(await waitForTask(port, token, original.id, (task) => task.state === "working"));
    }

    const stop = await execFileAsync(process.execPath, [perchBin, "server", "stop"], {
      env: {
        ...recoveryE2eEnv(home),
        PERCH_SERVER_URL: `http://127.0.0.1:${port}`,
        PERCH_RELAY_URL: "off"
      },
      timeout: 30_000
    });
    assert.match(stop.stdout, /stopped/);
    await waitForExit(server);
    assert.equal(processExists(oldDaemonPid), false);
    assert.equal(existsSync(oldOwned.socketPath), false);
    assert.equal(existsSync(`${oldOwned.socketPath}.pid`), false);
    await assertPortCanBind(port);
    const recoverable = ownerRuntimeSnapshot(home);
    assert.equal(recoverable.state, "recoverable");
    assert.equal(recoverable.generation, oldGeneration);
    assert.equal(recoverable.providerSessionId, providerThread);
    assert.equal(recoverable.model, "gpt-5.6-sol");
    const operationsBeforeRestart = mateRecoveryOperationCount(home);

    server = startServer(home, port);
    await waitForHealth(port, token);
    const quiet = await waitForMate(port, token, (mate) => mate.mateOwner?.state === "recoverable");
    assert.equal(quiet.mateOwner?.generation, oldGeneration);
    assert.equal(quiet.session, undefined);
    const quietSessions = await request<{ sessions: AgentSession[] }>(port, token, "/sessions");
    assert.equal(quietSessions.sessions.some((session) => session.labels?.role === "mate"), false);
    assert.equal(mateRecoveryOperationCount(home), operationsBeforeRestart);
    assert.equal(processExists(oldDaemonPid), false);
    assert.equal(existsSync(oldOwned.socketPath), false);
    for (const original of originals) {
      const recoverableChild = await waitForTask(
        port,
        token,
        original.id,
        (task) => task.runtime?.state === "recoverable"
      );
      assert.equal(
        recoverableChild.runtime?.providerSessionId,
        original.runtime?.providerSessionId
      );
      assert.equal(recoverableChild.runtime?.generation, original.runtime?.generation);
    }

    const recover = () => fetch(`http://127.0.0.1:${port}/mate/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}"
    });
    const responses = await Promise.all([recover(), recover()]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    const bodies = await Promise.all(responses.map((response) => response.json() as Promise<{ session: AgentSession }>));
    assert.equal(bodies[0]?.session.id, bodies[1]?.session.id);
    const recovered = await waitForMate(port, token, (mate) =>
      mate.mateOwner?.state === "live" && mate.mateOwner.generation === oldGeneration + 1
    );
    assert.equal(recovered.mateOwner?.providerSessionId, providerThread);
    assert.equal(recovered.mateOwner?.model, "gpt-5.6-sol");
    assert.notEqual(recovered.session?.id, oldSession);
    const liveSessions = await request<{ sessions: AgentSession[] }>(port, token, "/sessions");
    const mates = liveSessions.sessions.filter((session) => session.labels?.role === "mate");
    assert.equal(mates.length, 1);
    assert.equal(mates[0]?.model, "gpt-5.6-sol");
    assert.equal(mates[0]?.modelLabel, "GPT 5.6 Sol");
    assert.equal(mateRecoveryOperationCount(home), operationsBeforeRestart + 1);
    const freshOwned = ownerRuntimeSnapshot(home);
    assert.ok(freshOwned.socketPath);
    const freshDaemonPid = daemonPid(freshOwned.socketPath);
    assert.notEqual(freshDaemonPid, oldDaemonPid);
    assert.equal(processExists(freshDaemonPid), true);
    const fleetMate = await waitForFleetMate(port, token);
    assert.equal(fleetMate.model, "gpt-5.6-sol");
    assert.equal(fleetMate.modelLabel, "GPT 5.6 Sol");
    await request(port, token, `/sessions/${encodeURIComponent(recovered.session!.id)}/submit`, {
      method: "POST",
      body: JSON.stringify({
        text: "Reply with MATE_GRACEFUL_E2E_RECOVERED and wait for more input."
      })
    });
    await waitForAssistantText(
      port,
      token,
      recovered.session!.id,
      "MATE_GRACEFUL_E2E_RECOVERED"
    );
    const mateHistorySync = await waitForHistorySync(home, recovered.session!.id);
    assert.ok(mateHistorySync.pages >= 2);

    for (const original of originals) {
      const recoveredChild = await waitForTask(
        port,
        token,
        original.id,
        (task) => task.runtime?.state === "live"
      );
      assert.equal(
        recoveredChild.runtime?.providerSessionId,
        original.runtime?.providerSessionId
      );
      assert.equal(
        recoveredChild.runtime?.generation,
        original.runtime!.generation + 1
      );
      assert.notEqual(recoveredChild.sessionId, original.sessionId);
      assert.equal(recoveredChild.parentSessionId, recovered.session?.id);
      assert.equal(recoveredChild.workerName, original.workerName);
      assert.equal(recoveredChild.worktreeId, original.worktreeId);
      await waitForRecoveredTurn(port, token, original.id, recoveredChild.sessionId!);
      await waitForHistorySync(home, recoveredChild.sessionId!);
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

type MateStatus = {
  mateOwner?: {
    generation: number;
    state: string;
    providerSessionId?: string;
    model?: string;
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

function ownerRuntimeSnapshot(home: string): {
  generation: number;
  state: string;
  providerSessionId?: string;
  model?: string;
  socketPath?: string;
} {
  const db = new Database(join(home, "state.sqlite"), { readonly: true });
  try {
    const row = db.prepare(
      `SELECT generation, state, provider_session_id, model, metadata_json
       FROM owner_runtimes WHERE owner_id = 'owner:mate' ORDER BY generation DESC LIMIT 1`
    ).get() as {
      generation: number;
      state: string;
      provider_session_id: string | null;
      model: string | null;
      metadata_json: string | null;
    };
    assert.ok(row);
    const metadata = row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, unknown> : {};
    return {
      generation: row.generation,
      state: row.state,
      ...(row.provider_session_id ? { providerSessionId: row.provider_session_id } : {}),
      ...(row.model ? { model: row.model } : {}),
      ...(typeof metadata.appServerSocketPath === "string"
        ? { socketPath: metadata.appServerSocketPath }
        : {})
    };
  } finally {
    db.close();
  }
}

function mateRecoveryOperationCount(home: string): number {
  const db = new Database(join(home, "state.sqlite"), { readonly: true });
  try {
    const row = db.prepare(
      "SELECT count(*) AS count FROM owner_operations WHERE owner_id = 'owner:mate' AND kind = 'mate-fleet-recovery'"
    ).get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

async function waitForHistorySync(
  home: string,
  sessionId: string
): Promise<{ state: string; pages: number; items: number }> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const db = new Database(join(home, "state.sqlite"), { readonly: true });
    try {
      const row = db.prepare(
        `SELECT state, pages, items FROM codex_history_syncs
         WHERE perch_session_id = ? ORDER BY created_at DESC LIMIT 1`
      ).get(sessionId) as { state: string; pages: number; items: number } | undefined;
      if (row && ["succeeded", "truncated"].includes(row.state)) return row;
    } finally {
      db.close();
    }
    await delay(250);
  }
  throw new Error(`history sync did not finish for ${sessionId}`);
}

function daemonPid(socketPath: string): number {
  const pid = Number(readFileSync(`${socketPath}.pid`, "utf8").trim());
  assert.ok(Number.isInteger(pid) && pid > 1);
  return pid;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function assertPortCanBind(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolvePromise);
  });
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => error ? reject(error) : resolvePromise())
  );
}

async function waitForFleetMate(port: number, token: string): Promise<AgentSession> {
  return new Promise<AgentSession>((resolvePromise, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/fleet?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("fleet WebSocket did not project the recovered Mate"));
    }, 15_000);
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { type?: string; sessions?: AgentSession[] };
      const mate = frame.sessions?.find((session) => session.labels?.role === "mate");
      if (frame.type !== "fleet" || !mate) return;
      clearTimeout(timer);
      socket.close();
      resolvePromise(mate);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const delay = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
