import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import type { AgentSession, RecentEventsResult, StartAgentRequest } from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import type { CodexAppServerAdapter } from "./adapters/codexAppServerAdapter.js";
import { CodexRpcError } from "./adapters/codexAppServer.js";
import { FakeCodexOwnedAdapter } from "./adapters/fakeCodexAppServer.js";
import type { PtyAgentAdapter } from "./adapters/pty.js";
import { RoutingAgentAdapter } from "./adapters/routingAdapter.js";
import { AuditLog } from "./audit.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { HookRegistry } from "./hooks.js";
import { createControlServer } from "./http.js";
import { DeviceRegistry } from "./pairing.js";
import { PrPoller } from "./prPoller.js";
import { ProjectRegistry } from "./projects.js";
import { codexRecoveryDriver, RecoveryCoordinator, type RecoveryProviderDriver } from "./recovery.js";
import { RuntimeManager } from "./runtimeManager.js";
import type { OperationRecord } from "./stateDb.js";
import { TaskStore } from "./tasks.js";
import { TaskScheduler } from "./taskScheduler.js";
import { CodexHistorySyncCoordinator } from "./codexHistorySync.js";
import { nativeChildRunSummary, recordNativeChildRunObservation } from "./nativeChildRuns.js";
import { TimelineStore } from "./timeline.js";
import { WorktreePool } from "./worktrees.js";

class RecoveryAdapter implements AgentAdapter {
  readonly name = "recovery-test";
  readonly sessions: AgentSession[] = [];
  readonly requests: StartAgentRequest[] = [];
  readonly stopped: string[] = [];
  onStart?: (sessionId: string) => void;
  refuseStop = false;

  async getTopology() { return { windows: [], generatedAt: new Date().toISOString() }; }
  async listSessions() { return this.sessions.map((session) => ({ ...session })); }
  async readRecentEvents(_sessionId: string): Promise<RecentEventsResult> { return { events: [], terminal: true }; }
  async sendInput() {}
  async sendEnter() {}
  async interrupt() {}
  async startAgent(request: StartAgentRequest): Promise<AgentSession> {
    this.requests.push(request);
    const session: AgentSession = {
      id: request.sessionId!,
      kind: "terminal",
      title: request.title ?? "recovered",
      status: "idle",
      agent: request.agent ?? "codex",
      cwd: request.cwd,
      labels: request.labels,
      lastActivityAt: new Date().toISOString()
    };
    this.sessions.push(session);
    queueMicrotask(() => this.onStart?.(session.id));
    return session;
  }
  async stopSession(sessionId: string) {
    this.stopped.push(sessionId);
    if (this.refuseStop) return;
    const index = this.sessions.findIndex((session) => session.id === sessionId);
    if (index >= 0) this.sessions.splice(index, 1);
  }
  runtimeProcess(sessionId: string) {
    return this.sessions.some((session) => session.id === sessionId)
      ? { processId: 999_999, processStartedAt: "2026-07-14T00:00:00.000Z" }
      : undefined;
  }
}

const driver: RecoveryProviderDriver = {
  provider: "codex",
  prepare: (runtime, task) => ({
    expectedProviderSessionId: runtime.providerSessionId!,
    request: {
      command: "codex",
      agent: "codex",
      args: ["resume", runtime.providerSessionId!],
      sessionId: `pty:${randomUUID()}`,
      cwd: task.project,
      title: task.title,
      model: runtime.model,
      labels: { task: task.id, workerName: runtime.workerName!, parent: runtime.parentSessionId! }
    },
    launchInput: { codexOwnedResume: { threadId: runtime.providerSessionId! } }
  })
};

const CODEX_THREAD_ID = "12345678-1234-4234-9234-123456789abc";

function harness(providerSessionId = CODEX_THREAD_ID, agent: "claude" | "codex" = "codex") {
  const home = mkdtempSync(join(tmpdir(), "perch-recovery-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const runtimeManager = new RuntimeManager(tasks);
  const adapter = new RecoveryAdapter();
  // Codex recovery drives the app-server owning adapter; the routing facade
  // is what the coordinator sees, exactly like production.
  const codexOwned = new FakeCodexOwnedAdapter();
  const codexHistorySync = new CodexHistorySyncCoordinator(
    tasks.stateDb,
    codexOwned as unknown as CodexAppServerAdapter
  );
  const routing = new RoutingAgentAdapter(
    adapter as unknown as PtyAgentAdapter,
    codexOwned as unknown as CodexAppServerAdapter
  );
  const monitor = new FleetMonitor(routing);
  const task = tasks.create({ title: "recover this task", project: home });
  const named = tasks.claimWorkerName(task.id);
  tasks.update(task.id, { sessionId: "pty:old", parentSessionId: "pty:mate", worktreeId: "wt:kept" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  const starting = runtimeManager.beginLaunch(tasks.find(task.id)!, {
    command: agent,
    agent,
    sessionId: "pty:old",
    model: "gpt-test",
    labels: { workerName: named.workerName!, parent: "pty:mate" }
  });
  runtimeManager.markLive(starting, "pty:old");
  if (providerSessionId) runtimeManager.recordProviderSession("pty:old", agent, providerSessionId);
  runtimeManager.interruptSession("pty:old", "test interruption");
  const worktreeRoot = join(home, "worktrees");
  const poolDir = join(worktreeRoot, "test-pool");
  mkdirSync(poolDir, { recursive: true });
  writeFileSync(join(poolDir, "state.json"), JSON.stringify({
    slots: [{
      id: "wt:kept",
      repoRoot: home,
      slot: "1",
      path: home,
      createdAt: new Date().toISOString(),
      leasedBy: "pty:old",
      leasedAt: new Date().toISOString()
    }]
  }));
  const options = {
    adapter: routing,
    codexOwned: codexOwned as unknown as CodexAppServerAdapter,
    auditLog: new AuditLog(join(home, "audit.jsonl")),
    monitor,
    projects: new ProjectRegistry({ PERCH_HOME: home } as NodeJS.ProcessEnv),
    worktrees: new WorktreePool({ root: worktreeRoot }),
    hooks: new HookRegistry(),
    timeline: new TimelineStore(),
    tasks,
    port: 8787,
    runtimeManager,
    codexHistorySync,
    identityTimeoutMs: 100,
    providers: [driver]
  };
  const coordinator = new RecoveryCoordinator(options);
  // Production wiring (http.ts): the launcher resolves a held identity
  // expectation by feeding the coordinator the thread id the protocol
  // response carried.
  (options as { recoveryCoordinator?: RecoveryCoordinator }).recoveryCoordinator = coordinator;
  return {
    home, tasks, task: tasks.find(task.id)!, runtimeManager, adapter, codexOwned, coordinator, options,
    cleanup() {
      monitor.stop();
      tasks.close();
      rmSync(home, { recursive: true, force: true });
    }
  };
}

function operation(taskId: string, generation = 0, payload: Record<string, unknown> = {}): OperationRecord {
  const now = new Date().toISOString();
  return {
    id: `op-${Math.random()}`,
    taskId,
    kind: "recovery",
    idempotencyKey: `recovery-${Math.random()}`,
    state: "claimed",
    claimToken: "token",
    attempts: 1,
    payload: { expectedGeneration: generation, ...payload },
    createdAt: now,
    updatedAt: now
  };
}

function context(boundary?: (name: "beforeLaunch" | "afterLaunch") => void) {
  let payload: Record<string, unknown> = {};
  return {
    checkpoint(next: Record<string, unknown>) { payload = next; return operation("unused", 0, payload); },
    boundary(name: "beforeLaunch" | "afterLaunch") { boundary?.(name); },
    payload: () => payload
  };
}

test("Codex recovery resumes the exact thread and atomically binds g+1 without changing task identity", async () => {
  const h = harness();
  await h.coordinator.execute(operation(h.task.id), context());
  const task = h.tasks.find(h.task.id)!;
  assert.equal(task.state, "working");
  assert.equal(task.workerName, h.task.workerName);
  assert.equal(task.parentSessionId, "pty:mate");
  assert.equal(task.worktreeId, "wt:kept");
  assert.equal(task.runtime?.generation, 1);
  assert.equal(task.runtime?.state, "live");
  assert.equal(task.runtime?.providerSessionId, CODEX_THREAD_ID);
  // The resume went through the owning adapter against the exact thread.
  assert.equal(h.codexOwned.launches.length, 1);
  assert.deepEqual(h.codexOwned.launches[0]?.resume, { threadId: CODEX_THREAD_ID });
  assert.deepEqual(h.codexOwned.historyCatchUps, [task.sessionId]);
  assert.equal(h.tasks.stateDb.codexHistorySyncs.latestForSession(task.sessionId!)?.state, "succeeded");
  assert.equal(
    h.tasks.stateDb.operations.findByIdempotencyKey(`continuation:${h.task.id}:g1`)?.state,
    "pending",
    "continuation intent is created only after the verified g1 bind"
  );
  const firstSession = task.sessionId;
  await h.coordinator.execute(operation(h.task.id), context());
  assert.equal(h.codexOwned.launches.length, 1);
  assert.equal(h.tasks.find(h.task.id)?.sessionId, firstSession);
  h.cleanup();
});

test("Codex legacy compatibility requires persisted and model capability proof", async () => {
  const h = harness();
  const runtime = h.tasks.stateDb.runtimes.latestForTask(h.task.id)!;
  const prepare = (capability: Record<string, string>) => codexRecoveryDriver.prepare(
    {
      ...runtime,
      state: "recovering",
      metadata: { codexNativeMultiAgentCapability: capability }
    },
    h.task
  );

  const persistedV2 = await prepare({ effective: "v2", persisted: "v2", model: "disabled" });
  assert.equal(persistedV2.allowReplacementProviderSessionId, true);
  assert.equal(persistedV2.launchInput?.codexOwnedResume?.migration?.reason, "unverified_native_multi_agent_capability");

  const modelForcedV2 = await prepare({ effective: "v2", persisted: "disabled", model: "v2" });
  assert.equal(modelForcedV2.allowReplacementProviderSessionId, true);
  assert.equal(modelForcedV2.launchInput?.codexOwnedResume?.migration?.reason, "unverified_native_multi_agent_capability");

  const disabled = await prepare({ effective: "disabled", persisted: "disabled", model: "disabled" });
  assert.equal(disabled.allowReplacementProviderSessionId, undefined);
  assert.equal(disabled.launchInput?.codexOwnedResume?.legacyChildDisabled, true);
  assert.equal(disabled.launchInput?.codexOwnedResume?.migration, undefined);
  h.cleanup();
});

test("missing or mismatched identity and stale process ownership never launch", async () => {
  const missing = harness("");
  await assert.rejects(missing.coordinator.execute(operation(missing.task.id), context()), /missing or untrusted/);
  assert.equal(missing.codexOwned.launches.length, 0);
  missing.cleanup();

  const mismatched = harness();
  mismatched.tasks.stateDb.runtimes.compareAndSwap(mismatched.task.id, 0, "recoverable", "recoverable", { provider: "claude" });
  await assert.rejects(mismatched.coordinator.execute(operation(mismatched.task.id), context()), /missing or untrusted/);
  assert.equal(mismatched.codexOwned.launches.length, 0);
  mismatched.cleanup();

  const stale = harness();
  stale.tasks.stateDb.runtimes.compareAndSwap(stale.task.id, 0, "recoverable", "recoverable", { processId: process.pid });
  await assert.rejects(stale.coordinator.execute(operation(stale.task.id), context()), /still present/);
  assert.equal(stale.tasks.find(stale.task.id)?.runtime?.state, "recoverable");
  stale.cleanup();
});

test("SessionStart mismatch and generation CAS loss stop the fresh worker and leave safe evidence", async () => {
  const mismatch = harness();
  mismatch.codexOwned.resumedThreadOverride = "wrong-thread";
  await assert.rejects(mismatch.coordinator.execute(operation(mismatch.task.id), context()), /identity mismatch/);
  assert.equal(mismatch.codexOwned.stopped.length, 1);
  assert.equal(mismatch.tasks.find(mismatch.task.id)?.runtime?.state, "recoverable");
  assert.equal(mismatch.tasks.stateDb.operations.findByIdempotencyKey(`continuation:${mismatch.task.id}:g1`), undefined);
  assert.match(String(mismatch.tasks.stateDb.runtimes.latestForTask(mismatch.task.id)?.metadata?.lastRecoveryFailure), /identity mismatch/);
  mismatch.cleanup();

  const cas = harness();
  await assert.rejects(
    cas.coordinator.execute(operation(cas.task.id), context((name) => {
      if (name === "afterLaunch") {
        cas.tasks.stateDb.runtimes.compareAndSwap(cas.task.id, 0, "recovering", "recoverable");
      }
    })),
    /generation conflict/
  );
  assert.equal(cas.codexOwned.stopped.length, 1);
  assert.equal(cas.tasks.find(cas.task.id)?.runtime?.state, "recoverable");
  cas.cleanup();
});

test("out-of-band identity alone never binds a candidate whose PTY already exited", async () => {
  const h = harness();
  // The candidate resumes and proves identity over the protocol, then dies
  // before the coordinator can bind: protocol identity alone must not bind.
  const originalObserve = h.coordinator.observeSessionStart.bind(h.coordinator);
  h.coordinator.observeSessionStart = (sessionId, provider, providerSessionId, payload) => {
    h.codexOwned.killSession(sessionId);
    originalObserve(sessionId, provider, providerSessionId, payload);
  };
  await assert.rejects(h.coordinator.execute(operation(h.task.id), context()), /exited before the runtime bind/);
  assert.equal(h.tasks.find(h.task.id)?.runtime?.state, "recoverable");
  assert.equal(h.tasks.find(h.task.id)?.runtime?.generation, 0);
  assert.match(
    String(h.tasks.stateDb.runtimes.latestForTask(h.task.id)?.metadata?.lastRecoveryFailure),
    /exited before the runtime bind/
  );
  h.cleanup();
});

test("failed candidate cleanup keeps the recovery claim held with durable evidence", async () => {
  const h = harness();
  h.codexOwned.refuseStop = true;
  h.codexOwned.resumedThreadOverride = "wrong-thread";

  await assert.rejects(h.coordinator.execute(operation(h.task.id), context()), /cleanup failed/);

  const runtime = h.tasks.stateDb.runtimes.latestForTask(h.task.id)!;
  assert.equal(runtime.state, "recovering");
  assert.equal(runtime.metadata?.candidateSessionId, (await h.codexOwned.listSessions())[0]?.id);
  assert.match(String(runtime.metadata?.lastRecoveryFailure), /cleanup failed/);
  assert.equal(h.tasks.events(h.task.id).at(-1)?.data?.recoveryAvailable, false);
  h.cleanup();
});

test("a recovery claim resumed by a new server owner is reclaimed safely before relaunch", async () => {
  const h = harness();
  assert.ok(h.runtimeManager.claimRecovery(h.task.id, 0));
  const priorOwner = h.runtimeManager.instanceId;
  const restartedManager = new RuntimeManager(h.tasks);
  const restartedOptions = { ...h.options, runtimeManager: restartedManager };
  const restarted = new RecoveryCoordinator(restartedOptions);
  (restartedOptions as { recoveryCoordinator?: RecoveryCoordinator }).recoveryCoordinator = restarted;
  await restarted.execute(
    operation(h.task.id, 0, { claimed: true, claimOwnerInstanceId: priorOwner }),
    context()
  );
  assert.equal(h.tasks.find(h.task.id)?.runtime?.generation, 1);
  assert.equal(h.codexOwned.launches.length, 1);
  h.cleanup();
});

test("a resumed operation never revokes a recovering claim held by another owner", async () => {
  const h = harness();
  assert.ok(h.runtimeManager.claimRecovery(h.task.id, 0));
  const crashedOwner = h.runtimeManager.instanceId;
  const restartedManager = new RuntimeManager(h.tasks);
  assert.equal(restartedManager.reconcile(new Set(), () => false).at(-1)?.state, "recoverable");
  assert.ok(restartedManager.claimRecovery(h.task.id, 0));
  const restarted = new RecoveryCoordinator({ ...h.options, runtimeManager: restartedManager });

  await assert.rejects(
    restarted.execute(
      operation(h.task.id, 0, {
        claimed: true,
        claimOwnerInstanceId: crashedOwner,
        launchStarted: true,
        sessionId: "pty:crashed-candidate"
      }),
      context()
    ),
    /held by another owner/
  );
  await assert.rejects(
    restarted.execute(
      operation(h.task.id, 0, { claimed: true, claimOwnerInstanceId: crashedOwner }),
      context()
    ),
    /held by another owner/
  );

  const runtime = h.tasks.stateDb.runtimes.latestForTask(h.task.id)!;
  assert.equal(runtime.state, "recovering");
  assert.equal(runtime.ownerInstanceId, restartedManager.instanceId);
  assert.equal(h.codexOwned.launches.length, 0);
  h.cleanup();
});

test("POST /tasks/:id/recover drives one duplicate-safe durable operation", async () => {
  const h = harness();
  const scheduler = new TaskScheduler({ stateDb: h.tasks.stateDb, operationKinds: ["dispatch", "recovery"] });
  const server = createControlServer({
    ...h.options,
    authToken: "recovery-token",
    boxSecretKey: new Uint8Array(32),
    devices: new DeviceRegistry({ PERCH_HOME: h.home } as NodeJS.ProcessEnv),
    prPoller: new PrPoller(h.tasks),
    taskScheduler: scheduler,
    recoveryCoordinator: h.coordinator
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const recover = (body = "{}") => fetch(`http://127.0.0.1:${port}/tasks/${encodeURIComponent(h.task.id)}/recover`, {
      method: "POST",
      headers: { authorization: "Bearer recovery-token", "content-type": "application/json" },
      body
    });
    const oversized = await recover(JSON.stringify({ idempotencyKey: "k".repeat(201) }));
    assert.equal(oversized.status, 400);
    assert.match((await oversized.json()).error, /too long/);
    assert.equal(h.codexOwned.launches.length, 0);
    const repeatedBody = JSON.stringify({ idempotencyKey: "same-recovery" });
    const responses = await Promise.all([recover(repeatedBody), recover(repeatedBody)]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    assert.equal(h.codexOwned.launches.length, 1);
    const duplicate = await recover(repeatedBody);
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).recovered, true);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await scheduler.stop();
    h.cleanup();
  }
});

test("unproven legacy Codex recovery migrates once and preserves root-only reporting", async () => {
  const h = harness();
  const daemonSocket = "/fake/daemons/surviving.sock";
  h.options.hooks.ensure("pty:old");
  h.tasks.stateDb.runtimes.compareAndSwap(h.task.id, 0, "recoverable", "recoverable", {
    metadata: {
      source: "managed-launch",
      codexDriver: "app-server-owned",
      appServerSocketPath: daemonSocket
    }
  });
  const options = { ...h.options, providers: [codexRecoveryDriver] };
  const coordinator = new RecoveryCoordinator(options);
  (options as { recoveryCoordinator?: RecoveryCoordinator }).recoveryCoordinator = coordinator;
  h.tasks.recordEvent(h.task.id, {
    kind: "note",
    source: "system",
    message: "codex kickoff submitted over the app-server protocol; acceptance pending",
    data: { reason: "kickoff_submitted", clientUserMessageId: `perch:kickoff:${h.task.id}` }
  });
  h.codexOwned.wireEvents({
    onNativeChildObservation: (sessionId, observation) =>
      recordNativeChildRunObservation(h.tasks.stateDb, sessionId, observation),
    onTaskEvent: async (sessionId, event) => {
      const runtime = h.tasks.stateDb.runtimes.findBySession(sessionId);
      if (!runtime) return { success: false, text: "root runtime is not bound" };
      h.tasks.recordEvent(runtime.taskId, { ...event, source: "worker" });
      return { success: true, text: "recorded" };
    }
  });
  h.codexOwned.onSubmitAcknowledgedTurn = async (sessionId) => {
    const bound = h.tasks.stateDb.runtimes.findBySession(sessionId);
    assert.equal(bound?.state, "live", "migration handoff starts only after the new root is bound");
    assert.equal(
      (bound?.metadata?.codexMigrationHandoff as { state?: string } | undefined)?.state,
      "submitted",
      "migration handoff intent is durable before submission"
    );
    h.codexOwned.events.onNativeChildObservation?.(sessionId, {
      childThreadId: "child-during-handoff",
      parentThreadId: bound!.providerSessionId!,
      state: "running",
      observedAt: new Date().toISOString(),
      protocol: { itemType: "subAgentActivity", event: "started" }
    });
    const report = await h.codexOwned.events.onTaskEvent?.(sessionId, {
      kind: "note",
      message: "root report during migration handoff"
    });
    assert.equal(report?.success, true);
  };

  await coordinator.execute(operation(h.task.id), context());

  const g1 = h.tasks.stateDb.runtimes.latestForTask(h.task.id)!;
  assert.equal(g1.generation, 1);
  assert.equal(g1.state, "live");
  assert.equal(h.codexOwned.launches[0]?.resume?.socketPath, daemonSocket, "the recorded socket rode codexOwnedResume");
  assert.equal(h.codexOwned.launches[0]?.resume?.migration?.reason, "unverified_native_multi_agent_capability");
  assert.equal(h.codexOwned.launches[0]?.resume?.rootTaskReportingTool, undefined);
  assert.notEqual(g1.providerSessionId, CODEX_THREAD_ID);
  assert.equal(g1.metadata?.codexDriver, "app-server-owned");
  assert.notEqual(g1.metadata?.appServerSocketPath, daemonSocket);
  assert.equal(g1.metadata?.codexTaskReportingMode, "root_dynamic_tool");
  assert.equal(
    (g1.metadata?.codexThreadMigration as { fromThreadId?: string } | undefined)?.fromThreadId,
    CODEX_THREAD_ID
  );
  assert.equal(g1.metadata?.appServerDaemonSessionId, undefined);
  assert.equal(h.options.hooks.resolveAlias("pty:old"), "pty:old");
  assert.equal(h.codexOwned.launches[0]?.request.initialPrompt, undefined);
  assert.match(h.codexOwned.submitted[0]?.text ?? "", /migrated this task to a fresh Codex thread/);
  // The fresh thread never saw the original kickoff, so the handoff is the only
  // place it learns the reporting contract, its branch, and its worktree.
  const handoffText = h.codexOwned.submitted[0]?.text ?? "";
  assert.match(handoffText, /Report status only with the root thread's perch\.report_task_event tool/);
  assert.match(handoffText, new RegExp(`Create and work on branch perch/${h.task.id}`));
  assert.match(handoffText, /Native children must not report Perch task lifecycle events\./);
  assert.equal(h.codexOwned.submitted.length, 1);
  assert.equal(h.codexOwned.historyReads, 0);
  assert.ok(h.tasks.events(h.task.id).some((event) => event.data?.reason === "kickoff_superseded_by_migration"));
  assert.ok(h.tasks.events(h.task.id).some((event) => event.message === "root report during migration handoff"));
  assert.deepEqual(
    nativeChildRunSummary(h.tasks.stateDb, g1.ptySessionId!).map((child) => child.childThreadId),
    ["child-during-handoff"]
  );
  assert.ok(h.tasks.events(h.task.id).some((event) => event.data?.reason === "codex_thread_migrated"));

  const scheduler = new TaskScheduler({ stateDb: h.tasks.stateDb, operationKinds: ["dispatch", "recovery"] });
  const server = createControlServer({
    ...options,
    authToken: "rebind-token",
    boxSecretKey: new Uint8Array(32),
    devices: new DeviceRegistry({ PERCH_HOME: h.home } as NodeJS.ProcessEnv),
    prPoller: new PrPoller(h.tasks),
    taskScheduler: scheduler,
    recoveryCoordinator: coordinator
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const postHookEvent = (sessionId: string, token: string) => fetch(`http://127.0.0.1:${port}/tasks/${encodeURIComponent(h.task.id)}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-perch-session": sessionId,
        "x-perch-token": token
      },
      body: JSON.stringify({ kind: "note", message: "inherited hook claim" })
    });
    const g1Hook = h.options.hooks.ensure(g1.ptySessionId!);
    const inherited = await postHookEvent(g1.ptySessionId!, g1Hook.token);
    assert.equal(inherited.status, 401);
    const root = await fetch(`http://127.0.0.1:${port}/tasks/${encodeURIComponent(h.task.id)}/events`, {
      method: "POST",
      headers: {
        authorization: "Bearer rebind-token",
        "content-type": "application/json",
        "x-perch-root-session": g1.ptySessionId!
      },
      body: JSON.stringify({ kind: "note", message: "root dynamic-tool report" })
    });
    assert.equal(root.status, 200);
    assert.equal(h.tasks.events(h.task.id).at(-1)?.source, "worker");

    h.codexOwned.killSession(g1.ptySessionId!);
    h.tasks.stateDb.runtimes.compareAndSwap(h.task.id, 1, "live", "recoverable", { metadata: g1.metadata });
    await coordinator.execute(operation(h.task.id, 1), context());
    const g2 = h.tasks.stateDb.runtimes.latestForTask(h.task.id)!;
    assert.equal(g2.generation, 2);
    assert.equal(h.codexOwned.launches[1]?.resume?.socketPath, g1.metadata?.appServerSocketPath);
    assert.equal(h.codexOwned.launches[1]?.resume?.rootTaskReportingTool, true);
    assert.equal(h.codexOwned.launches[1]?.resume?.migration, undefined);
    assert.equal(g2.providerSessionId, g1.providerSessionId);
    assert.equal(g2.metadata?.appServerSocketPath, g1.metadata?.appServerSocketPath);
    assert.equal(g2.metadata?.codexTaskReportingMode, "root_dynamic_tool");
    assert.equal(h.tasks.find(h.task.id)?.sessionId, g2.ptySessionId);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await scheduler.stop();
    h.cleanup();
  }
});

test("Codex migration handoffs reconcile crash windows without blind replay", async () => {
  const crashedBeforeSubmit = harness();
  const crashedOptions = { ...crashedBeforeSubmit.options, providers: [codexRecoveryDriver] };
  const crashedCoordinator = new RecoveryCoordinator(crashedOptions);
  (crashedOptions as { recoveryCoordinator?: RecoveryCoordinator }).recoveryCoordinator = crashedCoordinator;
  await crashedCoordinator.execute(operation(crashedBeforeSubmit.task.id), context());
  let live = crashedBeforeSubmit.tasks.stateDb.runtimes.latestForTask(crashedBeforeSubmit.task.id)!;
  const stableId = `perch:migration:${crashedBeforeSubmit.task.id}:g1`;
  crashedBeforeSubmit.tasks.stateDb.runtimes.compareAndSwap(
    live.taskId,
    live.generation,
    "live",
    "live",
    {
      metadata: {
        ...live.metadata,
        codexMigrationHandoff: {
          state: "pending",
          clientUserMessageId: stableId,
          handoff: "task_brief"
        }
      }
    }
  );
  crashedBeforeSubmit.codexOwned.submitted.length = 0;
  await crashedCoordinator.execute(operation(crashedBeforeSubmit.task.id), context());
  live = crashedBeforeSubmit.tasks.stateDb.runtimes.latestForTask(crashedBeforeSubmit.task.id)!;
  assert.equal((live.metadata?.codexMigrationHandoff as { state?: string })?.state, "accepted");
  assert.deepEqual(crashedBeforeSubmit.codexOwned.submitted.map((entry) => entry.clientUserMessageId), [stableId]);
  crashedBeforeSubmit.cleanup();

  const acceptedAfterCrash = harness();
  const acceptedOptions = { ...acceptedAfterCrash.options, providers: [codexRecoveryDriver] };
  const acceptedCoordinator = new RecoveryCoordinator(acceptedOptions);
  (acceptedOptions as { recoveryCoordinator?: RecoveryCoordinator }).recoveryCoordinator = acceptedCoordinator;
  await acceptedCoordinator.execute(operation(acceptedAfterCrash.task.id), context());
  live = acceptedAfterCrash.tasks.stateDb.runtimes.latestForTask(acceptedAfterCrash.task.id)!;
  const acceptedId = `perch:migration:${acceptedAfterCrash.task.id}:g1`;
  acceptedAfterCrash.tasks.stateDb.runtimes.compareAndSwap(live.taskId, live.generation, "live", "live", {
    metadata: {
      ...live.metadata,
      codexMigrationHandoff: {
        state: "submitted",
        clientUserMessageId: acceptedId,
        handoff: "task_brief"
      }
    }
  });
  acceptedAfterCrash.codexOwned.submitted.length = 0;
  acceptedAfterCrash.codexOwned.history.set(acceptedId, { id: "turn-from-history" });
  await acceptedCoordinator.execute(operation(acceptedAfterCrash.task.id), context());
  live = acceptedAfterCrash.tasks.stateDb.runtimes.latestForTask(acceptedAfterCrash.task.id)!;
  assert.deepEqual(live.metadata?.codexMigrationHandoff, {
    state: "accepted",
    clientUserMessageId: acceptedId,
    handoff: "task_brief",
    turnId: "turn-from-history"
  });
  assert.equal(acceptedAfterCrash.codexOwned.submitted.length, 0);
  acceptedAfterCrash.cleanup();
});

test("Codex migration handoff rejection and unknown delivery park durably", async () => {
  const rejected = harness();
  const rejectedOptions = { ...rejected.options, providers: [codexRecoveryDriver] };
  const rejectedCoordinator = new RecoveryCoordinator(rejectedOptions);
  (rejectedOptions as { recoveryCoordinator?: RecoveryCoordinator }).recoveryCoordinator = rejectedCoordinator;
  rejected.codexOwned.nextSubmitError = new CodexRpcError("turn/start", "handoff denied", -32600);
  await assert.rejects(
    rejectedCoordinator.execute(operation(rejected.task.id), context()),
    /migration handoff was rejected/
  );
  let live = rejected.tasks.stateDb.runtimes.latestForTask(rejected.task.id)!;
  assert.equal(live.state, "live");
  assert.equal((live.metadata?.codexMigrationHandoff as { state?: string })?.state, "rejected");
  assert.equal(rejected.tasks.find(rejected.task.id)?.state, "blocked");
  rejected.cleanup();

  const unknown = harness();
  const unknownOptions = { ...unknown.options, providers: [codexRecoveryDriver] };
  const unknownCoordinator = new RecoveryCoordinator(unknownOptions);
  (unknownOptions as { recoveryCoordinator?: RecoveryCoordinator }).recoveryCoordinator = unknownCoordinator;
  await unknownCoordinator.execute(operation(unknown.task.id), context());
  live = unknown.tasks.stateDb.runtimes.latestForTask(unknown.task.id)!;
  unknown.tasks.stateDb.runtimes.compareAndSwap(live.taskId, live.generation, "live", "live", {
    metadata: {
      ...live.metadata,
      codexMigrationHandoff: {
        state: "submitted",
        clientUserMessageId: `perch:migration:${unknown.task.id}:g1`,
        handoff: "task_brief"
      }
    }
  });
  unknown.codexOwned.historyReadError = new Error("history unavailable");
  await assert.rejects(
    unknownCoordinator.execute(operation(unknown.task.id), context()),
    /acceptance is unknown/
  );
  live = unknown.tasks.stateDb.runtimes.latestForTask(unknown.task.id)!;
  assert.equal((live.metadata?.codexMigrationHandoff as { state?: string })?.state, "delivery_unknown");
  assert.equal(unknown.tasks.find(unknown.task.id)?.state, "blocked");
  const submittedBeforeReconcile = unknown.codexOwned.submitted.length;
  const unknownId = `perch:migration:${unknown.task.id}:g1`;
  unknown.codexOwned.historyReadError = null;
  unknown.codexOwned.history.set(unknownId, { id: "turn-confirmed-after-outage" });
  await unknownCoordinator.execute(operation(unknown.task.id), context());
  live = unknown.tasks.stateDb.runtimes.latestForTask(unknown.task.id)!;
  assert.deepEqual(live.metadata?.codexMigrationHandoff, {
    state: "accepted",
    clientUserMessageId: unknownId,
    handoff: "task_brief",
    turnId: "turn-confirmed-after-outage"
  });
  assert.equal(unknown.codexOwned.submitted.length, submittedBeforeReconcile);
  assert.equal(unknown.tasks.find(unknown.task.id)?.state, "working");
  assert.ok(unknown.tasks.events(unknown.task.id).some(
    (event) => event.data?.reason === "codex_migration_handoff_reconciled"
  ));
  const absentId = `${unknownId}:authoritatively-absent`;
  unknown.tasks.stateDb.runtimes.compareAndSwap(live.taskId, live.generation, "live", "live", {
    metadata: {
      ...live.metadata,
      codexMigrationHandoff: {
        state: "delivery_unknown",
        clientUserMessageId: absentId,
        handoff: "task_brief",
        failureReason: "prior transport outage"
      }
    }
  });
  await unknownCoordinator.execute(operation(unknown.task.id), context());
  assert.equal(unknown.codexOwned.submitted.at(-1)?.clientUserMessageId, absentId);
  assert.equal(unknown.codexOwned.submitted.length, submittedBeforeReconcile + 1);
  unknown.cleanup();
});

test("the production provider-neutral coordinator drives Claude through its verified SessionStart", async () => {
  const h = harness(CODEX_THREAD_ID, "claude");
  const { providers: _testProviders, ...productionOptions } = h.options;
  const coordinator = new RecoveryCoordinator(productionOptions);
  h.adapter.onStart = (sessionId) => coordinator.observeSessionStart(
    sessionId,
    "claude",
    CODEX_THREAD_ID,
    {
      hook_event_name: "SessionStart",
      session_id: CODEX_THREAD_ID,
      transcript_path: join(homedir(), ".claude", "projects", "recovery-test", `${CODEX_THREAD_ID}.jsonl`)
    }
  );

  await coordinator.execute(operation(h.task.id), context());

  const recovered = h.tasks.find(h.task.id)!;
  assert.equal(h.adapter.requests[0]?.command, "claude");
  assert.deepEqual(h.adapter.requests[0]?.args, ["--resume", CODEX_THREAD_ID]);
  assert.equal(recovered.runtime?.provider, "claude");
  assert.equal(recovered.runtime?.generation, 1);
  assert.equal(recovered.runtime?.state, "live");
  h.cleanup();
});
