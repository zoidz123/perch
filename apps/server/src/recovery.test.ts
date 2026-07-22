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

test("a daemon rebind re-records the socket every cycle and aliases the stale env identity to the live runtime", async () => {
  const h = harness();
  const daemonSocket = "/fake/daemons/surviving.sock";
  // Boot-time state: the durable hook credential the daemon env still carries,
  // and the launch-recorded driver facts on the interrupted g0 runtime.
  const stale = h.options.hooks.ensure("pty:old");
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

  await coordinator.execute(operation(h.task.id), context());

  const g1 = h.tasks.stateDb.runtimes.latestForTask(h.task.id)!;
  assert.equal(g1.generation, 1);
  assert.equal(g1.state, "live");
  assert.equal(h.codexOwned.launches[0]?.resume?.socketPath, daemonSocket, "the recorded socket rode codexOwnedResume");
  // The bind re-recorded the driver facts, so the NEXT restart's keep-sweep
  // and rebind still find the daemon - not just the first cycle.
  assert.equal(g1.metadata?.codexDriver, "app-server-owned");
  assert.equal(g1.metadata?.appServerSocketPath, daemonSocket);
  assert.equal(g1.metadata?.appServerDaemonSessionId, "pty:old");
  assert.equal(g1.metadata?.appServerDaemonGeneration, 0);
  assert.equal(h.options.hooks.resolveAlias("pty:old"), g1.ptySessionId);

  // A task-event POST with the stale env credentials (the surviving daemon's
  // tool shells can never see fresh ones) resolves to the live session.
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
    const postEvent = () => fetch(`http://127.0.0.1:${port}/tasks/${encodeURIComponent(h.task.id)}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-perch-session": "pty:old",
        "x-perch-token": stale.token
      },
      body: JSON.stringify({ kind: "note", message: "still reporting after the rebind" })
    });
    const first = await postEvent();
    assert.equal(first.status, 200);
    assert.equal(h.tasks.events(h.task.id).at(-1)?.source, "worker");

    // Second restart cycle: the daemon (and its unchanged env) outlives g1
    // too. The re-recorded socket must rebind again and re-point the alias.
    h.codexOwned.killSession(g1.ptySessionId!);
    h.tasks.stateDb.runtimes.compareAndSwap(h.task.id, 1, "live", "recoverable", { metadata: g1.metadata });
    await coordinator.execute(operation(h.task.id, 1), context());
    const g2 = h.tasks.stateDb.runtimes.latestForTask(h.task.id)!;
    assert.equal(g2.generation, 2);
    assert.equal(h.codexOwned.launches[1]?.resume?.socketPath, daemonSocket);
    assert.equal(g2.metadata?.appServerSocketPath, daemonSocket);
    assert.equal(g2.metadata?.appServerDaemonSessionId, "pty:old");
    assert.equal(g2.metadata?.appServerDaemonGeneration, 0);
    assert.equal(h.options.hooks.resolveAlias("pty:old"), g2.ptySessionId);

    const second = await postEvent();
    assert.equal(second.status, 200);
    assert.equal(h.tasks.events(h.task.id).at(-1)?.source, "worker");
    assert.equal(h.tasks.find(h.task.id)?.sessionId, g2.ptySessionId);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await scheduler.stop();
    h.cleanup();
  }
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
