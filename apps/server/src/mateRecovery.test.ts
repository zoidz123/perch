import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import type { AgentSession, RecentEventsResult, StartAgentRequest } from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import { AuditLog } from "./audit.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { HookRegistry, type HookEventPayload } from "./hooks.js";
import { createControlServer } from "./http.js";
import { MateRecoveryCoordinator } from "./mateRecovery.js";
import { OwnerManager } from "./ownerManager.js";
import { ProjectRegistry } from "./projects.js";
import { DeviceRegistry } from "./pairing.js";
import { PrPoller } from "./prPoller.js";
import { RecoveryCoordinator, type RecoveryProviderDriver } from "./recovery.js";
import { RuntimeManager } from "./runtimeManager.js";
import { TaskScheduler } from "./taskScheduler.js";
import { TaskStore } from "./tasks.js";
import { FleetSettings } from "./settings.js";
import { TimelineStore } from "./timeline.js";
import { WorktreePool } from "./worktrees.js";

const MATE_CONVERSATION = "12345678-1234-4234-9234-123456789abc";
const CHILD_CONVERSATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

class MateRecoveryAdapter implements AgentAdapter {
  readonly name = "mate-recovery-test";
  readonly sessions: AgentSession[] = [];
  readonly requests: StartAgentRequest[] = [];
  recentEvents: RecentEventsResult = { events: [], terminal: true };
  onStart?: (request: StartAgentRequest, session: AgentSession) => void;

  async getTopology() { return { windows: [], generatedAt: new Date().toISOString() }; }
  async listSessions() { return this.sessions.map((session) => ({ ...session })); }
  async readRecentEvents(): Promise<RecentEventsResult> { return this.recentEvents; }
  async sendInput() {}
  async sendEnter() {}
  async interrupt() {}
  async startAgent(request: StartAgentRequest): Promise<AgentSession> {
    this.requests.push(request);
    const session: AgentSession = {
      id: request.sessionId ?? `pty:${randomUUID()}`,
      kind: "terminal",
      title: request.title ?? "agent",
      status: "idle",
      agent: request.agent ?? "claude",
      cwd: request.cwd,
      labels: request.labels,
      lastActivityAt: new Date().toISOString()
    };
    this.sessions.push(session);
    queueMicrotask(() => this.onStart?.(request, session));
    return session;
  }
  async stopSession(sessionId: string) {
    const index = this.sessions.findIndex((session) => session.id === sessionId);
    if (index >= 0) this.sessions.splice(index, 1);
  }
  runtimeProcess(sessionId: string) {
    return this.sessions.some((session) => session.id === sessionId)
      ? { processId: 999_999, processStartedAt: "2026-07-14T00:00:00.000Z" }
      : undefined;
  }
}

const childDriver: RecoveryProviderDriver = {
  provider: "claude",
  prepare: (runtime, task) => ({
    expectedProviderSessionId: runtime.providerSessionId!,
    request: {
      command: "claude",
      agent: "claude",
      args: ["--resume", runtime.providerSessionId!],
      sessionId: `pty:${randomUUID()}`,
      cwd: task.project,
      title: task.title,
      labels: { task: task.id, parent: runtime.parentSessionId! }
    }
  }),
  verifySessionStart: () => true
};

test("mate owner identity persists and startup reconciliation makes a dead PTY recoverable", () => {
  const home = mkdtempSync(join(tmpdir(), "perch-owner-manager-"));
  let tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  try {
    const first = new OwnerManager(tasks);
    const starting = first.beginMateLaunch({
      command: "claude",
      agent: "claude",
      sessionId: "pty:old-mate",
      cwd: join(home, "mate"),
      model: "best",
      labels: { role: "mate" }
    });
    first.markLive(starting, "pty:old-mate", { processId: 999_999, processStartedAt: "2026-07-14T00:00:00.000Z" });
    first.recordProviderSession("pty:old-mate", "claude", MATE_CONVERSATION);

    tasks.close();
    tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
    const afterRestart = new OwnerManager(tasks);
    const changed = afterRestart.reconcile(new Set(), () => false);
    assert.equal(changed.length, 1);
    assert.equal(afterRestart.snapshot()?.id, "owner:mate");
    assert.equal(afterRestart.snapshot()?.generation, 0);
    assert.equal(afterRestart.snapshot()?.state, "recoverable");
    assert.equal(afterRestart.snapshot()?.providerSessionId, MATE_CONVERSATION);
    assert.equal(afterRestart.snapshot()?.recoveryAvailable, true);
  } finally {
    tasks.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("one duplicate-safe mate operation resumes the exact conversation and its recoverable child fleet", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-mate-fleet-recovery-"));
  const transcriptDir = join(homedir(), ".claude", "projects", "perch-mate-recovery-test");
  mkdirSync(transcriptDir, { recursive: true });
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const ownerManager = new OwnerManager(tasks);
  const runtimeManager = new RuntimeManager(tasks);
  const adapter = new MateRecoveryAdapter();
  const monitor = new FleetMonitor(adapter);
  const timeline = new TimelineStore();
  const options = {
    adapter,
    auditLog: new AuditLog(join(home, "audit.jsonl")),
    monitor,
    projects: new ProjectRegistry({ PERCH_HOME: home } as NodeJS.ProcessEnv),
    worktrees: new WorktreePool({ env: { PERCH_HOME: home } as NodeJS.ProcessEnv }),
    hooks: new HookRegistry(),
    timeline,
    tasks,
    port: 8787,
    runtimeManager,
    ownerManager
  };
  const childRecovery = new RecoveryCoordinator({ ...options, providers: [childDriver], identityTimeoutMs: 500 });
  const scheduler = new TaskScheduler({ stateDb: tasks.stateDb, operationKinds: ["recovery"] });
  scheduler.setExecutor((operation, context) => childRecovery.execute(operation, context));
  const mateRecovery = new MateRecoveryCoordinator({ ...options, taskScheduler: scheduler, identityTimeoutMs: 500 });
  const server = createControlServer({
    ...options,
    authToken: "test-token",
    boxSecretKey: new Uint8Array(32),
    devices: new DeviceRegistry({ PERCH_HOME: home } as NodeJS.ProcessEnv),
    prPoller: new PrPoller(tasks, async () => { throw new Error("gh disabled in tests"); }),
    settings: new FleetSettings({ PERCH_HOME: home } as NodeJS.ProcessEnv),
    taskScheduler: scheduler,
    recoveryCoordinator: childRecovery,
    mateRecoveryCoordinator: mateRecovery
  });

  try {
    const mateStart = ownerManager.beginMateLaunch({
      command: "claude",
      agent: "claude",
      sessionId: "pty:old-mate",
      cwd: join(home, "mate"),
      model: "best",
      labels: { role: "mate" }
    });
    ownerManager.markLive(mateStart, "pty:old-mate");
    ownerManager.recordProviderSession("pty:old-mate", "claude", MATE_CONVERSATION);

    const task = tasks.create({ title: "child", project: home });
    tasks.update(task.id, { sessionId: "pty:old-child", parentSessionId: "pty:old-mate" });
    tasks.recordEvent(task.id, { kind: "working", source: "worker" });
    const childStart = runtimeManager.beginLaunch(tasks.find(task.id)!, {
      command: "claude",
      agent: "claude",
      sessionId: "pty:old-child",
      cwd: home,
      labels: { task: task.id, parent: "pty:old-mate" }
    });
    runtimeManager.markLive(childStart, "pty:old-child");
    runtimeManager.recordProviderSession("pty:old-child", "claude", CHILD_CONVERSATION);
    runtimeManager.interruptSession("pty:old-child", "server crash");
    const recoverableMate = ownerManager.interruptSession("pty:old-mate")!;

    adapter.onStart = (request, session) => {
      const providerSessionId = request.labels?.role === "mate" ? MATE_CONVERSATION : CHILD_CONVERSATION;
      const payload: HookEventPayload = {
        hook_event_name: "SessionStart",
        session_id: providerSessionId,
        transcript_path: join(transcriptDir, `${providerSessionId}.jsonl`)
      };
      if (request.labels?.role === "mate") mateRecovery.observeSessionStart(session.id, "claude", providerSessionId, payload);
      else childRecovery.observeSessionStart(session.id, "claude", providerSessionId, payload);
    };

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const start = () => fetch(`http://127.0.0.1:${port}/mate/start`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: "{}"
    });
    const responses = await Promise.all([start(), start()]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    const [firstBody, duplicateBody] = await Promise.all(responses.map((response) => response.json())) as Array<{
      session: AgentSession;
      recovery: Omit<import("./mateRecovery.js").MateFleetRecoveryResult, "session"> & { session: AgentSession };
    }>;
    const first = firstBody.recovery;
    const duplicate = duplicateBody.recovery;
    assert.equal(first.session.id, duplicate.session.id);
    const statusResponse = await fetch(`http://127.0.0.1:${port}/mate`, {
      headers: { authorization: "Bearer test-token" }
    });
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json() as { mateOwner: { state: string; providerSessionId: string }; session: AgentSession };
    assert.equal(status.mateOwner.state, "live");
    assert.equal(status.mateOwner.providerSessionId, MATE_CONVERSATION);
    assert.equal(status.session.id, first.session.id);
    assert.equal(first.recoveredMate, true);
    assert.deepEqual(first.children.recovered, [task.id]);
    assert.deepEqual(first.children.failed, []);
    assert.equal(ownerManager.snapshot()?.generation, 1);
    assert.equal(ownerManager.snapshot()?.providerSessionId, MATE_CONVERSATION);
    assert.equal(tasks.find(task.id)?.runtime?.generation, 1);
    assert.equal(tasks.find(task.id)?.parentSessionId, first.session.id);
    assert.equal(tasks.find(task.id)?.runtime?.parentSessionId, first.session.id);
    assert.equal(tasks.stateDb.runtimes.latestForTask(task.id)?.parentOwnerId, "owner:mate");
    assert.equal(adapter.requests.filter((request) => request.labels?.role === "mate").length, 1);
    assert.equal(adapter.requests.filter((request) => request.labels?.task === task.id).length, 1);
    assert.deepEqual(adapter.requests[0]?.args, ["--resume", MATE_CONVERSATION]);
    assert.deepEqual(adapter.requests[1]?.args, ["--resume", CHILD_CONVERSATION]);
  } finally {
    server.closeAllConnections?.();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await scheduler.stop();
    monitor.stop();
    timeline.stop();
    tasks.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(transcriptDir, { recursive: true, force: true });
  }
});

test("a child recovery that failed is retried by the next mate fleet reconcile", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-mate-fleet-retry-"));
  const transcriptDir = join(homedir(), ".claude", "projects", "perch-mate-recovery-retry-test");
  mkdirSync(transcriptDir, { recursive: true });
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const ownerManager = new OwnerManager(tasks);
  const runtimeManager = new RuntimeManager(tasks);
  const adapter = new MateRecoveryAdapter();
  const monitor = new FleetMonitor(adapter);
  const timeline = new TimelineStore();
  const options = {
    adapter,
    auditLog: new AuditLog(join(home, "audit.jsonl")),
    monitor,
    projects: new ProjectRegistry({ PERCH_HOME: home } as NodeJS.ProcessEnv),
    worktrees: new WorktreePool({ env: { PERCH_HOME: home } as NodeJS.ProcessEnv }),
    hooks: new HookRegistry(),
    timeline,
    tasks,
    port: 8787,
    runtimeManager,
    ownerManager
  };
  const childRecovery = new RecoveryCoordinator({ ...options, providers: [childDriver], identityTimeoutMs: 300 });
  const scheduler = new TaskScheduler({ stateDb: tasks.stateDb, operationKinds: ["recovery"] });
  scheduler.setExecutor((operation, context) => childRecovery.execute(operation, context));
  const mateRecovery = new MateRecoveryCoordinator({ ...options, taskScheduler: scheduler, identityTimeoutMs: 500 });

  try {
    const mateStart = ownerManager.beginMateLaunch({
      command: "claude",
      agent: "claude",
      sessionId: "pty:old-mate",
      cwd: join(home, "mate"),
      labels: { role: "mate" }
    });
    ownerManager.markLive(mateStart, "pty:old-mate");
    ownerManager.recordProviderSession("pty:old-mate", "claude", MATE_CONVERSATION);

    const task = tasks.create({ title: "child", project: home });
    tasks.update(task.id, { sessionId: "pty:old-child", parentSessionId: "pty:old-mate" });
    tasks.recordEvent(task.id, { kind: "working", source: "worker" });
    const childStart = runtimeManager.beginLaunch(tasks.find(task.id)!, {
      command: "claude",
      agent: "claude",
      sessionId: "pty:old-child",
      cwd: home,
      labels: { task: task.id, parent: "pty:old-mate" }
    });
    runtimeManager.markLive(childStart, "pty:old-child");
    runtimeManager.recordProviderSession("pty:old-child", "claude", CHILD_CONVERSATION);
    runtimeManager.interruptSession("pty:old-child", "server crash");
    const recoverableMate = ownerManager.interruptSession("pty:old-mate")!;

    let childIdentityReady = false;
    adapter.onStart = (request, session) => {
      const isMate = request.labels?.role === "mate";
      if (!isMate && !childIdentityReady) return;
      const providerSessionId = isMate ? MATE_CONVERSATION : CHILD_CONVERSATION;
      const payload: HookEventPayload = {
        hook_event_name: "SessionStart",
        session_id: providerSessionId,
        transcript_path: join(transcriptDir, `${providerSessionId}.jsonl`)
      };
      if (isMate) mateRecovery.observeSessionStart(session.id, "claude", providerSessionId, payload);
      else childRecovery.observeSessionStart(session.id, "claude", providerSessionId, payload);
    };

    const first = await mateRecovery.recover(recoverableMate);
    assert.equal(first.recoveredMate, true);
    assert.deepEqual(first.children.recovered, []);
    assert.equal(first.children.failed.length, 1);
    assert.equal(first.children.failed[0]?.taskId, task.id);

    childIdentityReady = true;
    const liveMate = ownerManager.latestMate()!;
    assert.equal(liveMate.state, "live");
    const second = await mateRecovery.recover(liveMate);
    assert.equal(second.recoveredMate, false);
    assert.deepEqual(second.children.failed, []);
    assert.deepEqual(second.children.recovered, [task.id]);
    assert.equal(tasks.find(task.id)?.runtime?.generation, 1);
  } finally {
    await scheduler.stop();
    monitor.stop();
    timeline.stop();
    tasks.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(transcriptDir, { recursive: true, force: true });
  }
});

test("a mate recovery failure is shell-safe, returns the claim to recoverable, and stays retryable", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-mate-prepare-fail-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const ownerManager = new OwnerManager(tasks);
  const runtimeManager = new RuntimeManager(tasks);
  const adapter = new MateRecoveryAdapter();
  const monitor = new FleetMonitor(adapter);
  const timeline = new TimelineStore();
  const scheduler = new TaskScheduler({ stateDb: tasks.stateDb, operationKinds: ["recovery"] });
  const base = {
    adapter,
    auditLog: new AuditLog(join(home, "audit.jsonl")),
    monitor,
    projects: new ProjectRegistry({ PERCH_HOME: home } as NodeJS.ProcessEnv),
    worktrees: new WorktreePool({ env: { PERCH_HOME: home } as NodeJS.ProcessEnv }),
    hooks: new HookRegistry(),
    timeline,
    tasks,
    port: 8787,
    runtimeManager,
    ownerManager,
    taskScheduler: scheduler,
    identityTimeoutMs: 500
  };
  const throwingDriver: RecoveryProviderDriver = {
    provider: "codex",
    prepare: () => { throw new Error("codex CLI does not support resume"); }
  };
  const workingDriver: RecoveryProviderDriver = {
    provider: "codex",
    prepare: (runtime) => ({
      expectedProviderSessionId: runtime.providerSessionId!,
      request: {
        command: "codex",
        agent: "codex",
        args: ["resume", runtime.providerSessionId!],
        sessionId: `pty:${randomUUID()}`,
        cwd: home,
        title: "mate"
      }
    }),
    verifyIdentity: async ({ providerSessionId }) => providerSessionId
  };
  const identityFailingDriver: RecoveryProviderDriver = {
    ...workingDriver,
    verifyIdentity: async () => { throw new Error("identity failed"); }
  };

  try {
    const starting = ownerManager.beginMateLaunch({
      command: "codex",
      agent: "codex",
      sessionId: "pty:old-codex-mate",
      cwd: home,
      labels: { role: "mate" }
    });
    ownerManager.markLive(starting, "pty:old-codex-mate");
    ownerManager.recordProviderSession("pty:old-codex-mate", "codex", MATE_CONVERSATION);
    const recoverable = ownerManager.interruptSession("pty:old-codex-mate")!;

    const failing = new MateRecoveryCoordinator({ ...base, mateProviders: [throwingDriver] });
    await assert.rejects(failing.recover(recoverable), /codex CLI does not support resume/);
    assert.equal(ownerManager.latestMate()?.state, "recoverable");

    adapter.recentEvents = {
      events: [{
        type: "terminal_output",
        sessionId: "pty:failed-recovery",
        text: "\x1b[6nresume failed\x1b]10;?\x1b\\",
        at: new Date().toISOString()
      }],
      terminal: true
    };
    const identityFailing = new MateRecoveryCoordinator({ ...base, mateProviders: [identityFailingDriver] });
    await assert.rejects(identityFailing.recover(ownerManager.latestMate()!), (error: Error) => {
      assert.equal(error.message, "identity failed; terminal: resume failed");
      assert.doesNotMatch(error.message, /\x1b/);
      return true;
    });
    assert.equal(ownerManager.latestMate()?.state, "recoverable");

    const retry = new MateRecoveryCoordinator({ ...base, mateProviders: [workingDriver] });
    const result = await retry.recover(ownerManager.latestMate()!);
    assert.equal(result.recoveredMate, true);
    assert.equal(ownerManager.snapshot()?.state, "live");
    assert.equal(ownerManager.snapshot()?.generation, 1);
  } finally {
    await scheduler.stop();
    monitor.stop();
    timeline.stop();
    tasks.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("Codex mate recovery uses native resume syntax and binds only the verified exact thread", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-codex-mate-recovery-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const ownerManager = new OwnerManager(tasks);
  const runtimeManager = new RuntimeManager(tasks);
  const adapter = new MateRecoveryAdapter();
  const monitor = new FleetMonitor(adapter);
  const timeline = new TimelineStore();
  const scheduler = new TaskScheduler({ stateDb: tasks.stateDb, operationKinds: ["recovery"] });
  const codexDriver: RecoveryProviderDriver = {
    provider: "codex",
    prepare: (runtime) => ({
      expectedProviderSessionId: runtime.providerSessionId!,
      request: {
        command: "codex",
        agent: "codex",
        args: ["resume", runtime.providerSessionId!],
        sessionId: `pty:${randomUUID()}`,
        cwd: home,
        title: "mate"
      }
    }),
    verifyIdentity: async ({ providerSessionId }) => providerSessionId
  };
  const recovery = new MateRecoveryCoordinator({
    adapter,
    auditLog: new AuditLog(join(home, "audit.jsonl")),
    monitor,
    projects: new ProjectRegistry({ PERCH_HOME: home } as NodeJS.ProcessEnv),
    worktrees: new WorktreePool({ env: { PERCH_HOME: home } as NodeJS.ProcessEnv }),
    hooks: new HookRegistry(),
    timeline,
    tasks,
    port: 8787,
    runtimeManager,
    ownerManager,
    taskScheduler: scheduler,
    mateProviders: [codexDriver],
    identityTimeoutMs: 500
  });

  try {
    const starting = ownerManager.beginMateLaunch({
      command: "codex",
      agent: "codex",
      sessionId: "pty:old-codex-mate",
      cwd: home,
      labels: { role: "mate" }
    });
    ownerManager.markLive(starting, "pty:old-codex-mate");
    ownerManager.recordProviderSession("pty:old-codex-mate", "codex", MATE_CONVERSATION);
    const recoverable = ownerManager.interruptSession("pty:old-codex-mate")!;

    const result = await recovery.recover(recoverable);
    assert.equal(result.recoveredMate, true);
    assert.deepEqual(adapter.requests[0]?.args, ["resume", MATE_CONVERSATION]);
    assert.equal(ownerManager.snapshot()?.provider, "codex");
    assert.equal(ownerManager.snapshot()?.providerSessionId, MATE_CONVERSATION);
    assert.equal(ownerManager.snapshot()?.generation, 1);
  } finally {
    await scheduler.stop();
    monitor.stop();
    timeline.stop();
    tasks.close();
    rmSync(home, { recursive: true, force: true });
  }
});
