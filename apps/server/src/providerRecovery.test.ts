import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { test } from "node:test";
import { PtyAgentAdapter, type PtyProcess, type SpawnPty } from "./adapters/pty.js";
import { HookRegistry, installClaudeHooks, type HookEventPayload } from "./hooks.js";
import { claudeRecoveryDriver, providerRecoveryDriver } from "./providerRecovery.js";
import { RuntimeManager } from "./runtimeManager.js";
import { TaskStore } from "./tasks.js";
import { TaskWatchdog } from "./taskWatchdog.js";

const CONVERSATION_ID = "12345678-1234-4234-9234-123456789abc";

function harness() {
  const home = mkdtempSync(join(tmpdir(), "perch-claude-recovery-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const manager = new RuntimeManager(tasks);
  const created = tasks.create({ title: "resume Claude", project: "/repo" });
  const task = tasks.claimWorkerName(created.id);
  tasks.update(task.id, {
    sessionId: "pty:old",
    parentSessionId: "pty:mate",
    worktreeId: "wt:repo/3"
  });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  const starting = manager.beginLaunch(tasks.find(task.id)!, {
    command: "claude",
    agent: "claude",
    sessionId: "pty:old",
    cwd: "/repo/worktree",
    model: "opus",
    labels: { task: task.id, workerName: task.workerName!, parent: "pty:mate" }
  }, {
    id: "wt:repo/3",
    repoRoot: "/repo",
    slot: "3",
    path: "/repo/worktree",
    createdAt: "2026-07-14T00:00:00.000Z",
    leasedBy: task.id,
    leasedAt: "2026-07-14T00:00:00.000Z"
  });
  manager.markLive(starting, "pty:old", {
    processId: 10,
    processStartedAt: "2026-07-14T00:00:00.000Z"
  });
  manager.recordProviderSession("pty:old", "claude", CONVERSATION_ID);
  manager.interruptSession("pty:old", "test interruption");
  const claimed = manager.claimRecovery(task.id, 0)!;
  return {
    home,
    tasks,
    manager,
    task: tasks.find(task.id)!,
    claimed,
    cleanup() {
      tasks.close();
      rmSync(home, { recursive: true, force: true });
    }
  };
}

test("Claude driver uses exact resume syntax and preserves logical worker identity", () => {
  const h = harness();
  try {
    const prepared = claudeRecoveryDriver.prepare(h.claimed, h.task);
    assert.deepEqual(prepared.request.args, ["--resume", CONVERSATION_ID]);
    assert.equal(prepared.request.command, "claude");
    assert.equal(prepared.request.agent, "claude");
    assert.match(prepared.request.sessionId!, /^pty:[0-9a-f-]{36}$/);
    assert.notEqual(prepared.request.sessionId, "pty:old");
    assert.equal(prepared.request.cwd, "/repo/worktree");
    assert.equal(prepared.request.model, "opus");
    assert.equal(prepared.request.labels?.task, h.task.id);
    assert.equal(prepared.request.labels?.workerName, h.task.workerName);
    assert.equal(prepared.request.labels?.parent, "pty:mate");
    assert.equal(prepared.expectedProviderSessionId, CONVERSATION_ID);
  } finally {
    h.cleanup();
  }
});

test("Claude driver verifies the resumed SessionStart UUID and transcript identity", () => {
  const transcript = join(homedir(), ".claude", "projects", "perch-recovery-test", `${CONVERSATION_ID}.jsonl`);
  assert.equal(claudeRecoveryDriver.verifySessionStart(CONVERSATION_ID, {
    hook_event_name: "SessionStart",
    session_id: CONVERSATION_ID,
    transcript_path: transcript
  }), true);
  assert.equal(claudeRecoveryDriver.verifySessionStart(CONVERSATION_ID, {
    hook_event_name: "SessionStart",
    session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    transcript_path: transcript
  }), false);
  assert.equal(claudeRecoveryDriver.verifySessionStart(CONVERSATION_ID, {
    hook_event_name: "SessionStart",
    session_id: CONVERSATION_ID,
    transcript_path: join(homedir(), ".claude", "projects", "perch-recovery-test", "other.jsonl")
  }), false);
  assert.equal(claudeRecoveryDriver.verifySessionStart(CONVERSATION_ID, {
    hook_event_name: "SessionStart",
    session_id: CONVERSATION_ID,
    transcript_path: "/tmp/outside.jsonl"
  }), false);
});

test("deterministic PTY launch adopts the fresh session and mints a fresh hook token", async () => {
  const h = harness();
  const hooks = new HookRegistry();
  let spawned: { args: string[]; env: NodeJS.ProcessEnv } | undefined;
  const process: PtyProcess = {
    pid: processId(),
    write() {},
    kill() {},
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} })
  };
  const spawn: SpawnPty = (_command, args, options) => {
    spawned = { args, env: options.env };
    return process;
  };
  const adapter = new PtyAgentAdapter(spawn, {
    sessionEnv: (sessionId) => ({
      PERCH_SESSION_ID: sessionId,
      PERCH_HOOK_URL: "http://127.0.0.1:1234/hooks",
      PERCH_HOOK_TOKEN: hooks.register(sessionId).token
    })
  });
  try {
    const prepared = claudeRecoveryDriver.prepare(h.claimed, h.task);
    const session = await adapter.startAgent(prepared.request);
    assert.equal(session.id, prepared.request.sessionId);
    assert.deepEqual(spawned?.args, ["--resume", CONVERSATION_ID, "--model", "opus"]);
    assert.equal(spawned?.env.PERCH_SESSION_ID, session.id);
    assert.equal(spawned?.env.PERCH_HOOK_URL, "http://127.0.0.1:1234/hooks");
    const token = spawned?.env.PERCH_HOOK_TOKEN;
    assert.equal(typeof token, "string");
    assert.equal(hooks.verify(session.id, token!), true);
    assert.equal(hooks.verify("pty:old", token!), false);
  } finally {
    adapter.stop();
    h.cleanup();
  }
});

const realClaudeSessionId = process.env.PERCH_REAL_CLAUDE_RECOVERY_SESSION_ID;
test("E2E: a real managed Claude PTY resumes and reports the exact SessionStart identity", {
  skip: !realClaudeSessionId
}, async () => {
  assert.ok(realClaudeSessionId);
  assert.equal(installClaudeHooks(), true);
  const perchSessionId = `pty:${randomUUID()}`;
  const token = randomUUID();
  let resolveStart!: (payload: HookEventPayload) => void;
  const started = new Promise<HookEventPayload>((resolve) => {
    resolveStart = resolve;
  });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (
        request.headers["x-perch-session"] === perchSessionId &&
        request.headers["x-perch-token"] === token
      ) {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HookEventPayload;
        if (payload.hook_event_name === "SessionStart") resolveStart(payload);
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const adapter = new PtyAgentAdapter(undefined, {
    sessionEnv: () => ({
      PERCH_SESSION_ID: perchSessionId,
      PERCH_HOOK_URL: `http://127.0.0.1:${port}`,
      PERCH_HOOK_TOKEN: token
    })
  });
  try {
    const session = await adapter.startAgent({
      command: "claude",
      args: ["--resume", realClaudeSessionId],
      agent: "claude",
      sessionId: perchSessionId,
      cwd: process.cwd()
    });
    const timedOut = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Claude SessionStart timed out")), 30_000);
      timer.unref();
    });
    const payload = await Promise.race([started, timedOut]);
    assert.equal(session.id, perchSessionId);
    assert.equal(claudeRecoveryDriver.verifySessionStart(realClaudeSessionId, payload), true);
    await adapter.stopSession(session.id);
  } finally {
    adapter.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("verified Claude recovery atomically binds one live generation g+1", () => {
  const h = harness();
  try {
    const prepared = claudeRecoveryDriver.prepare(h.claimed, h.task);
    const live = h.manager.bindRecoveredRuntime(h.claimed, {
      sessionId: prepared.request.sessionId!,
      provider: "claude",
      providerSessionId: CONVERSATION_ID,
      ownership: { processId: 20, processStartedAt: "2026-07-14T01:00:00.000Z" }
    });
    assert.equal(live.generation, 1);
    assert.equal(live.state, "live");
    assert.equal(live.providerSessionId, CONVERSATION_ID);
    assert.equal(live.ptySessionId, prepared.request.sessionId);
    assert.equal(live.workerName, h.task.workerName);
    assert.equal(live.parentSessionId, "pty:mate");
    assert.equal(live.worktreeId, "wt:repo/3");
    assert.equal(live.worktreePath, "/repo/worktree");
    assert.equal(live.model, "opus");
    assert.equal(h.tasks.find(h.task.id)?.sessionId, prepared.request.sessionId);
    assert.throws(() => h.manager.bindRecoveredRuntime(h.claimed, {
      sessionId: "pty:duplicate",
      provider: "claude",
      providerSessionId: CONVERSATION_ID
    }), /runtime generation conflict/);
  } finally {
    h.cleanup();
  }
});

test("a failed g+1 insert rolls the old recovering generation back intact", () => {
  const h = harness();
  try {
    assert.throws(() => h.manager.bindRecoveredRuntime(h.claimed, {
      sessionId: "pty:old",
      provider: "claude",
      providerSessionId: CONVERSATION_ID
    }), /UNIQUE constraint failed/);
    const latest = h.tasks.stateDb.runtimes.latestForTask(h.task.id);
    assert.equal(latest?.id, h.claimed.id);
    assert.equal(latest?.generation, 0);
    assert.equal(latest?.state, "recovering");
    assert.equal(h.tasks.find(h.task.id)?.sessionId, "pty:old");
  } finally {
    h.cleanup();
  }
});

function processId(): number {
  return Math.max(1, process.pid);
}

test("identity mismatch and restart-during-resume leave durable recoverable evidence", () => {
  const mismatch = harness();
  try {
    assert.throws(() => mismatch.manager.bindRecoveredRuntime(mismatch.claimed, {
      sessionId: "pty:candidate",
      provider: "claude",
      providerSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    }), /provider identity mismatch/);
    const failed = mismatch.manager.failRecovery(mismatch.claimed, "Claude SessionStart identity mismatch", "pty:candidate");
    assert.equal(failed?.state, "recoverable");
    assert.equal(failed?.metadata?.lastRecoveryFailure, "Claude SessionStart identity mismatch");
    const evidence = mismatch.tasks.events(mismatch.task.id).at(-1);
    assert.equal(evidence?.kind, "runtime_interrupted");
    assert.equal(evidence?.data?.reason, "recovery_failed");
    assert.equal(evidence?.data?.candidateSessionId, "pty:candidate");
  } finally {
    mismatch.cleanup();
  }

  const restart = harness();
  try {
    assert.equal(restart.claimed.state, "recovering");
    assert.equal(restart.claimed.ownerInstanceId, restart.manager.instanceId);
    // The claiming instance's own reconcile must never revoke its held claim.
    assert.equal(restart.manager.reconcile(new Set(), () => false).length, 0);
    assert.equal(restart.tasks.find(restart.task.id)?.runtime?.state, "recovering");
    const reconciled = new RuntimeManager(restart.tasks).reconcile(new Set(), () => false);
    assert.equal(reconciled.length, 1);
    assert.equal(restart.tasks.find(restart.task.id)?.runtime?.state, "recoverable");
    assert.equal(restart.tasks.find(restart.task.id)?.runtime?.generation, 0);
  } finally {
    restart.cleanup();
  }
});

test("a TaskWatchdog sweep during Claude resume never revokes the held recovery claim", () => {
  const h = harness();
  const watchdog = new TaskWatchdog({
    tasks: h.tasks,
    runtimeInterrupted: (sessionId, message) => h.manager.interruptSession(sessionId, message) !== undefined
  });
  try {
    const prepared = claudeRecoveryDriver.prepare(h.claimed, h.task);
    // The task and the recovering row still name the dead pre-recovery PTY,
    // so a sweep with no live sessions sees the old session as gone.
    watchdog.reconcileDeadSessions(new Set());
    assert.equal(h.tasks.stateDb.runtimes.latestForTask(h.task.id)?.state, "recovering");
    const live = h.manager.bindRecoveredRuntime(h.claimed, {
      sessionId: prepared.request.sessionId!,
      provider: "claude",
      providerSessionId: CONVERSATION_ID,
      ownership: { processId: 30, processStartedAt: "2026-07-14T02:00:00.000Z" }
    });
    assert.equal(live.generation, 1);
    assert.equal(live.state, "live");
  } finally {
    watchdog.stop();
    h.cleanup();
  }
});

test("a later recovery failure without a candidate clears stale candidate evidence", () => {
  const h = harness();
  try {
    const first = h.manager.failRecovery(h.claimed, "first failure", "pty:candidate");
    assert.equal(first?.metadata?.candidateSessionId, "pty:candidate");
    const reclaimed = h.manager.claimRecovery(h.task.id, 0)!;
    assert.equal(reclaimed.metadata?.candidateSessionId, "pty:candidate");
    const failed = h.manager.failRecovery(reclaimed, "second failure");
    assert.equal(failed?.metadata?.lastRecoveryFailure, "second failure");
    assert.equal(failed?.metadata?.candidateSessionId, undefined);
    const evidence = h.tasks.events(h.task.id).at(-1);
    assert.equal(evidence?.data?.reason, "recovery_failed");
    assert.equal(evidence?.data?.candidateSessionId, undefined);
  } finally {
    h.cleanup();
  }
});

test("prepare guard failures report the actual conflict, not a generic identity error", () => {
  const h = harness();
  try {
    assert.throws(
      () => claudeRecoveryDriver.prepare({ ...h.claimed, state: "recoverable" }, h.task),
      /runtime is recoverable, not a held recovering claim/
    );
    assert.throws(
      () => claudeRecoveryDriver.prepare({ ...h.claimed, agent: "codex", provider: "codex" }, h.task),
      /runtime identity is agent=codex provider=codex, not claude/
    );
    assert.throws(
      () => claudeRecoveryDriver.prepare({ ...h.claimed, providerSessionId: undefined }, h.task),
      /trusted provider session identity is missing/
    );
  } finally {
    h.cleanup();
  }
});

test("provider selection is isolated to Claude and rejects unavailable identity", () => {
  assert.equal(providerRecoveryDriver("claude"), claudeRecoveryDriver);
  assert.equal(providerRecoveryDriver("codex"), undefined);
  const h = harness();
  try {
    const malformed = h.tasks.stateDb.runtimes.compareAndSwap(
      h.claimed.taskId,
      h.claimed.generation,
      "recovering",
      "recovering",
      { providerSessionId: "not-a-uuid" }
    )!;
    assert.throws(() => claudeRecoveryDriver.prepare(malformed, h.task), /recovery unavailable/);
  } finally {
    h.cleanup();
  }
});
