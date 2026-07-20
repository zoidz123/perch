import { statSync } from "node:fs";
import { basename } from "node:path";
import { PtyAgentAdapter } from "./adapters/pty.js";
import { CodexControlPlane } from "./codexControl.js";
import { codexOnPath, selectCodexDriver } from "./adapters/codexDaemon.js";
import { AuditLog } from "./audit.js";
import {
  markTaskWorkingFromActivity,
  resolveApprovalForTask,
  taskCapabilityEnvironment,
  surfaceApprovalToTask
} from "./agentLauncher.js";
import { ChartRegistry, wireChartArchive } from "./charts.js";
import { claudeStateFilePath } from "./claudeTrust.js";
import { readConfig } from "./config.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { removeAttachments, removePidFile, writePidFile } from "./home.js";
import { HookRegistry, installClaudeHooks, installCodexHooks } from "./hooks.js";
import { labelForClaudeModelId, resolveSessionModel } from "./models.js";
import { createControlServer } from "./http.js";
import { DeviceRegistry, serverIdentity, tokensEqual } from "./pairing.js";
import { readOrCreateBoxKeyPair } from "./e2ee/keys.js";
import { RelayClient } from "./relayClient.js";
import type { ClientAuth } from "./fleetMonitor.js";
import { deliverMateWake, wireChartWake } from "./mateWake.js";
import { PrPoller } from "./prPoller.js";
import { ProjectRegistry } from "./projects.js";
import { StatusReconciler } from "./reconciler.js";
import { FleetSettings } from "./settings.js";
import { cleanupSessionExitWorktree } from "./sessionExitCleanup.js";
import { StateMetrics } from "./stateMetrics.js";
import { TaskStore } from "./tasks.js";
import { TaskWatchdog, reportUsageLimitToTask } from "./taskWatchdog.js";
import { TaskCompletionReconciler } from "./taskCompletion.js";
import { executeTeardown, landedGate, ownLeaseFor } from "./teardown.js";
import { WorktreePool } from "./worktrees.js";
import { ApnsPushSender, apnsConfigFromEnv, NoopPushSender } from "./push.js";
import { PushRouter } from "./pushRouter.js";
import { TimelineStore } from "./timeline.js";
import { TaskScheduler } from "./taskScheduler.js";
import { OutboxWorker } from "./outboxWorker.js";
import { RuntimeManager } from "./runtimeManager.js";
import { OwnerManager } from "./ownerManager.js";

const config = readConfig();
const hooks = new HookRegistry(process.env);
const timeline = new TimelineStore();
// G6: every task transition and session status change is stamped with its
// source and counted; GET /doctor/state-metrics serves the snapshot.
const metrics = new StateMetrics();
// Codex `--remote` control plane: perch-owned `codex app-server` daemon + a
// control client per session for the model chip and protocol turn submission.
// Enabled from any normal codex install (no standalone gate); off cleanly when
// codex is absent, on Windows, or via PERCH_CODEX_REMOTE=0 - Codex then runs on
// the plain PTY path.
const codexControl = new CodexControlPlane({
  enabled: selectCodexDriver({ codexOnPath: codexOnPath() }) === "app-server-remote"
});
console.log(
  codexControl.isEnabled()
    ? "codex: app-server --remote topology enabled"
    : "codex: app-server --remote disabled (PTY-only)"
);
const ptyAdapter = new PtyAgentAdapter(undefined, {
  // Every perch-owned PTY carries its hook wiring; the installed Claude hook
  // is inert in terminals without these variables.
  sessionEnv: (sessionId, request) => ({
    PERCH_SESSION_ID: sessionId,
    PERCH_HOOK_URL: `http://127.0.0.1:${config.port}/hooks`,
    PERCH_HOOK_TOKEN: hooks.ensure(sessionId).token,
    ...taskCapabilityEnvironment(tasks, request)
  }),
  onSessionExit: (sessionId, exitContext) => {
    hooks.unregister(sessionId);
    timeline.detach(sessionId);
    void codexControl.detach(sessionId);
    removeAttachments(sessionId);
    ownerManager.interruptSession(sessionId);
    // Process death updates runtime liveness without changing task meaning.
    // Worktree cleanup is task-aware: a task
    // lease stays protected unless the task-layer landed gate authorizes
    // teardown; non-task sessions still return through the pool path.
    void cleanupSessionExitWorktree(sessionId, exitContext, {
      tasks,
      worktrees,
      adapter,
      auditLog,
      metrics,
      runtimeManager
    }).catch((error) => {
      console.warn(
        `worktree: session-exit cleanup failed for ${sessionId}: ${
          error instanceof Error ? error.message : error
        }`
      );
    });
    // A dead mate while crew tasks are live is a push-once backstop moment.
    pushRouter.sessionExited(sessionId);
  }
});
const adapter = ptyAdapter;
const auditLog = new AuditLog(config.auditLogPath);
const devices = new DeviceRegistry();
// Derive (or load) the long-term box keypair on boot; its public half is
// already published in the pairing offer via buildOffer, its secret half backs
// the encrypted WS channel.
const boxKeyPair = readOrCreateBoxKeyPair();
const projects = new ProjectRegistry();
const settings = new FleetSettings();
const worktrees = new WorktreePool();
const tasks = new TaskStore();
const runtimeManager = new RuntimeManager(tasks);
const ownerManager = new OwnerManager(tasks);
tasks.claimLegacyActiveWorkerNames();
runtimeManager.bootstrapLegacyTasks();
runtimeManager.repairLegacySessionGoneArtifacts();
const taskScheduler = new TaskScheduler({
  stateDb: tasks.stateDb,
  operationKinds: ["dispatch", "recovery", "continuation"],
  onFailure: async (operation, error) => {
    if (operation.kind !== "dispatch") return;
    const task = tasks.find(operation.taskId);
    if (!task || task.state === "failed") return;
    if (operation.payload?.launchStarted !== true) {
      const lease = worktrees.findByHolder(task.id);
      if (lease) await worktrees.release(lease.id, { force: true }).catch(() => {});
    }
    tasks.recordEvent(task.id, {
      kind: "failed",
      source: "system",
      message: `dispatch failed: ${error instanceof Error ? error.message : String(error)}`
    });
  }
});
let taskWatchdog: TaskWatchdog | undefined;
const prPoller = new PrPoller(tasks, undefined, {
  metrics,
  resolveCheckout: (task) =>
    (task.worktreeId ? worktrees.find(task.worktreeId)?.path : undefined) ?? task.project
});
const taskCompletion = new TaskCompletionReconciler({
  tasks,
  lastAssistantText: (sessionId) => timeline.lastAssistantText(sessionId)
});
prPoller.start();
const apnsConfig = apnsConfigFromEnv();
const apnsPush = apnsConfig ? new ApnsPushSender(apnsConfig, () => devices.pushTokens()) : undefined;
const push = apnsPush ?? new NoopPushSender();
console.log(apnsConfig ? `push: APNs enabled (${apnsConfig.host})` : "push: APNs not configured (noop sender)");
const monitor = new FleetMonitor(adapter, {
  reconcileMs: config.reconcileMs,
  auditLog,
  // Release timeline items/tailers for sessions purged from the fleet.
  onPrune: (activeSessionIds) => timeline.prune(activeSessionIds),
  // Revocation must reach the relay transport: sever the device's relay data
  // socket even if it is not a current FleetMonitor client. LAN-only servers
  // have no relay client, so this is a no-op there.
  onDisconnectDevice: (deviceId) => relayClient?.disconnectDevice(deviceId),
  onStatusChange: ({ sessionId, from, to, source }) =>
    metrics.recordSessionStatus(sessionId, from, to, source),
  // A worker CLI printed its provider usage-limit line and stalled: block the
  // owning task with the provider/message/retry time. recordEvent fires the
  // mate wake channel, so the orchestrator is notified immediately.
  onUsageLimit: (sessionId, _agent, limit) => reportUsageLimitToTask(tasks, sessionId, limit, metrics),
  onApprovalNeeded: (sessionId, approval) => surfaceApprovalToTask(tasks, sessionId, approval),
  onApprovalResolved: (sessionId, approval) => resolveApprovalForTask(tasks, sessionId, approval),
  // Task state follows actual delivery, including a queued prompt's eventual
  // flush. Merely placing text behind an approval gate does not resume it.
  onInputSubmitted: (sessionId) =>
    markTaskWorkingFromActivity({ tasks }, sessionId, { newTurn: true }),
  onQueuedInputRejected: (sessionId, count, reason) => {
    const task = tasks.list().find((candidate) => candidate.sessionId === sessionId);
    if (!task || task.state === "closed") return;
    tasks.recordEvent(task.id, {
      kind: "stalled",
      source: "system",
      message: `${count} accepted follow-up message${count === 1 ? " was" : "s were"} not delivered: ${reason}`,
      data: { reason: "terminal_input_rejected", sessionId, count }
    });
  }
});
monitor.setRuntimeSnapshot((sessionId) => runtimeManager.snapshotForSession(sessionId));
void adapter
  .listSessions()
  .then((sessions) => {
    const live = new Set(sessions.map((session) => session.id));
    hooks.prune(live);
    runtimeManager.reconcile(live, (sessionId) => Boolean(adapter.runtimeProcess?.(sessionId)));
    ownerManager.reconcile(live, (sessionId) => Boolean(adapter.runtimeProcess?.(sessionId)));
  })
  .catch((error) => {
    console.warn(
      `runtime: startup reconcile failed: ${error instanceof Error ? error.message : error}`
    );
  });

// Push routing by conversation: mate replies push like messages, crew stays
// silent behind the mate (with the escalation fallback as the safety net),
// solo sessions keep their turn-done pushes, approvals always push.
const pushRouter = new PushRouter(
  {
    push,
    projectName: (path) => {
      if (!path) {
        return undefined;
      }
      return projects.find(path)?.name ?? basename(path);
    },
    lastAssistantText: (sessionId) => timeline.lastAssistantText(sessionId),
    hasActiveViewer: (sessionId) => monitor.hasDeviceViewer(sessionId),
    findSession: (sessionId) => monitor.findSession(sessionId),
    hasLiveTasks: () =>
      tasks
        .list()
        .some((task) => ["queued", "working", "needs_you", "blocked"].includes(task.state))
  },
  { fallbackMs: config.escalationFallbackMs }
);
monitor.setPushRouter(pushRouter);

// Task-event side effects are delivered from the durable outbox. WebSocket
// snapshots still update from the synchronous task-store listener path.
const outboxWorker = new OutboxWorker({
  stateDb: tasks.stateDb,
  deliver: {
    mate: ({ task, event }) => deliverMateWake(task, event, adapter, monitor),
    push: ({ task, event }) => pushRouter.deliverTaskEvent(task, event)
  }
});

// Charts: registration and file changes ride the fleet WebSocket to the
// owning session's subscribers (append-only "chart" message), and a fresh
// registration is a boss-facing moment - it pushes like approvals do, never
// absorbed as crew noise. Crew charts additionally fan out to the supervising
// (mate) session's subscribers, so they surface in the mate's chat too.
const charts = new ChartRegistry();
charts.subscribe((chart, event) => {
  const message = {
    type: "chart" as const,
    chartId: chart.id,
    name: chart.name,
    reason: event.kind,
    ...(chart.taskId ? { taskId: chart.taskId } : {}),
    ...(chart.taskTitle ? { taskTitle: chart.taskTitle } : {}),
    at: new Date().toISOString()
  };
  monitor.publish({ ...message, sessionId: chart.sessionId });
  if (chart.parentSessionId && chart.parentSessionId !== chart.sessionId) {
    monitor.publish({ ...message, sessionId: chart.parentSessionId });
  }
  if (event.kind === "registered") {
    pushRouter.chartReady(chart.sessionId, monitor.findSession(chart.sessionId), chart.name);
  }
});
// A crew chart records one durable chart_ready task event at registration.
// The normal parent/mate wake path relays it immediately; a closing task
// archives its charts (still servable from the snapshot, just no longer
// "latest").
wireChartWake(charts, tasks, (chartId) => `http://127.0.0.1:${config.port}/charts/${chartId}/review`);
wireChartArchive(tasks, charts);

// Task-transition measurements (G6): the ledger stamps every event with its
// source; edges (state actually moved) feed the metrics.
tasks.subscribe((task, event) => {
  if (event.previousState !== task.state) {
    metrics.recordTaskTransition(task.id, event.previousState, task.state, event.kind, event.source);
  }
});

// Auto-return on merge: when the poller (or any source) records a `merged`
// event, return the task's worktree to the pool without waiting for a manual
// teardown. The landed-gate still runs - a merged PR passes it regardless of
// SHA divergence (squash + rebase), but an uncommitted working tree is still
// refused and left for a human. executeTeardown is idempotent and single-flight
// against a concurrent manual POST /tasks/:id/teardown.
tasks.subscribe((task, event) => {
  if (event.kind !== "merged") {
    return;
  }
  void (async () => {
    const lease = ownLeaseFor(task, worktrees);
    const verdict = await landedGate(task, lease?.path);
    if (!verdict.landed) {
      return;
    }
    // A trail entry so the ledger shows the return was automatic.
    tasks.recordEvent(task.id, {
      kind: "note",
      source: "system",
      message: `auto-return on merge: ${verdict.reason}`
    });
    await executeTeardown(task, { tasks, worktrees, adapter, auditLog, runtimeManager });
  })().catch(() => {});
});

// Structured timeline items stream to subscribed clients as they land.
timeline.subscribe((item) => {
  monitor.publish({
    type: "timeline_item",
    sessionId: item.sessionId,
    item,
    at: item.at
  });
});

// Transcript-reported models feed the same live readout the launch stamp and
// model switches use, so CLI-spawned claude sessions (the mate included) and
// desktop-side `/model` switches report a model too. setSessionModel merges
// and dedupes, so repeat rows with an unchanged model are free.
timeline.subscribeModel((sessionId, model) => {
  monitor.setSessionModel(sessionId, {
    model,
    modelLabel: labelForClaudeModelId(model) ?? model
  });
});

// Codex writes the authoritative effective model + effort after applying
// thread settings. Only the rollout correlated to the session's current
// provider thread may move live state; stale recovery/reattach files are
// ignored. setSessionModel keeps partial fields separate and dedupes repeats.
timeline.subscribeCodexThreadSettings((sessionId, threadId, settings) => {
  if (hooks.correlation(sessionId)?.agentSessionId !== threadId) return;
  const resolved = settings.model ? resolveSessionModel("codex", { model: settings.model }) : undefined;
  monitor.setSessionModel(sessionId, {
    ...settings,
    ...(resolved?.modelLabel ? { modelLabel: resolved.modelLabel } : {})
  });
});

// Marker-based and idempotent; failure must never block startup.
try {
  installClaudeHooks();
} catch (error) {
  console.error("perch: could not install Claude hooks:", error instanceof Error ? error.message : error);
}

try {
  if (!installCodexHooks()) {
    console.warn("codex hooks: install skipped (config.toml unwritable or hooks disabled)");
  }
} catch (error) {
  console.error("perch: could not install codex hooks:", error instanceof Error ? error.message : error);
}

// Ground-truth reconciliation and watchdogs (G1-G3). Hooks and worker verbs
// stay the fast path; these sweeps only turn a lost push into a temporary lie.
const transcriptAgeMs = (sessionId: string): number | undefined => {
  const path = hooks.correlation(sessionId)?.transcriptPath;
  if (!path) {
    return undefined;
  }
  try {
    return Math.max(0, Date.now() - statSync(path).mtimeMs);
  } catch {
    return undefined;
  }
};
const reconciler = new StatusReconciler(
  {
    listSessions: async () => monitor.withLiveState(await adapter.listSessions()),
    screenTail: async (sessionId) => {
      try {
        const result = await adapter.readRecentEvents(sessionId, 8);
        if (!result.terminal) {
          return undefined;
        }
        return result.events
          .map((event) => (event.type === "terminal_output" ? (event.text ?? "") : ""))
          .filter(Boolean)
          .join("\n");
      } catch {
        return undefined;
      }
    },
    transcriptAgeMs,
    applyStatus: (sessionId, status) =>
      monitor.applyExternalStatus(sessionId, status, undefined, "reconciler"),
    metrics
  },
  { sweepMs: config.statusSweepMs, staleMs: config.statusStaleMs }
);
reconciler.start();
taskWatchdog = new TaskWatchdog(
  {
    tasks,
    sessionActivityAt: (sessionId) => timeline.lastActivityAt(sessionId),
    lastAssistantText: (sessionId) => timeline.lastAssistantText(sessionId),
    // Ground truth for the G4 backstop: listSessions sweeps liveness (a still-
    // running server also drives the fast onSessionExit path here), and returns
    // only sessions the adapter currently holds. A working task whose session is
    // absent has no live worker.
    liveSessionIds: async () => new Set((await adapter.listSessions()).map((session) => session.id)),
    runtimeInterrupted: (sessionId, message) =>
      runtimeManager.interruptSession(sessionId, message) !== undefined,
    metrics
  },
  {
    scoutSilenceMs: config.stallScoutMs,
    shipSilenceMs: config.stallShipMs,
    launchStallMs: config.launchStallMs
  }
);
taskWatchdog.start();

// Reclaim worktree leases whose sessions are gone (clean trees only; dirty
// trees stay leased and visible rather than losing work). A holder also counts
// as live while its task is still open, so a stalled-but-decidable task never
// loses its slot to the reaper; POST /worktrees/:id/release is the explicit
// path for everything this skips. Runs once at startup - server-owned PTYs die
// with the server, so a previous life's expired leases reclaim immediately -
// and then on an interval.
const reclaimOrphanedLeases = () =>
  (async () => {
    const live = new Set((await adapter.listSessions()).map((session) => session.id));
    const heldByOpenTask = (holder: string) =>
      tasks
        .list()
        .some(
          (task) => (task.sessionId === holder || task.id === holder) && task.state !== "closed"
        );
    const reaped = await worktrees.reap((holder) => live.has(holder) || heldByOpenTask(holder));
    if (reaped.length > 0) {
      console.log(`worktree: reaped ${reaped.join(", ")}`);
    }
  })().catch(() => {});
void reclaimOrphanedLeases();
const reaper = setInterval(() => void reclaimOrphanedLeases(), 5 * 60_000);
reaper.unref?.();

const server = createControlServer({
  adapter,
  auditLog,
  authToken: config.authToken,
  boxSecretKey: boxKeyPair.secretKey,
  monitor,
  devices,
  port: config.port,
  relayUrl: config.relayUrl,
  hooks,
  timeline,
  projects,
  worktrees,
  tasks,
  prPoller,
  claudeStateFile: claudeStateFilePath(),
  codexControl,
  // Re-assert perch's hook entries at every launch: an external rewrite of
  // ~/.claude/settings.json (any tool persisting from a stale snapshot) would
  // otherwise silence hooks for all sessions launched after it until the next
  // server boot.
  installHooks: (agent) => {
    if (agent === "claude") {
      installClaudeHooks();
    } else if (agent === "codex") {
      installCodexHooks();
    }
  },
  taskCompletion,
  metrics,
  charts,
  settings,
  taskScheduler,
  runtimeManager,
  ownerManager
});

// Off-LAN reach: a relay is on by default (config.relayUrl resolves to the
// hosted default unless PERCH_RELAY_URL overrides or opts out). We dial it
// outbound and hold the control socket open so a paired phone can reach this Mac
// from anywhere. Each phone connection becomes an encrypted FleetMonitor client
// exactly like the LAN path; the relay only ever forwards opaque ciphertext.
// LAN-only servers (PERCH_RELAY_URL=off) never dial and stay fully functional.
const resolveClientToken = (token: string): ClientAuth | undefined => {
  if (tokensEqual(token, config.authToken)) {
    return { kind: "server" };
  }
  const device = devices.verify(token);
  return device ? { kind: "device", deviceId: device.id } : undefined;
};
const relayClient = config.relayUrl
  ? new RelayClient({
      url: config.relayUrl,
      serverId: serverIdentity().serverId,
      secretKey: boxKeyPair.secretKey,
      verifyToken: resolveClientToken,
      addClient: (socket, sessionId, auth) => monitor.addClient(socket, sessionId, auth),
      onLog: (message) => console.log(message)
    })
  : undefined;
if (relayClient) {
  console.log(`relay: ready to dial ${config.relayUrl} after the local port is owned`);
} else {
  console.log("relay: disabled (LAN-only; unset PERCH_RELAY_URL to use the default relay)");
}

// The monitor is client-driven: the first WebSocket client starts the adapter
// event subscription, the last to disconnect stops it. An idle server (no
// connected clients) performs no adapter work.

server.listen(config.port, "0.0.0.0", () => {
  writePidFile();
  // Owning the HTTP port is the process-level single-instance guard. Start
  // relay traffic only after the bind succeeds so a duplicate process that
  // loses EADDRINUSE cannot register the same Mac remotely while it exits.
  if (relayClient) {
    console.log(`relay: dialing ${config.relayUrl} for off-LAN reach`);
    relayClient.start();
  }
  // Retire daemons orphaned by a non-graceful previous exit before any launch
  // can acquire new ones (acquires only happen via HTTP handlers, so post-bind
  // is still pre-first-acquire): their session-scoped hook credentials are
  // stale and their socket paths will never be dialed again. Only after the
  // port bind - the effective single-instance lock - so a second server racing
  // against a live one dies on EADDRINUSE without SIGTERMing its live daemons.
  codexControl.sweepOrphanDaemons();
  taskScheduler.start();
  outboxWorker.start();
  console.log(`Perch server listening on http://0.0.0.0:${config.port}`);
});

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("exit", () => {
  removePidFile();
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) {
    // A second SIGINT/SIGTERM means "stop waiting": a hung in-flight launch
    // must never make the server unkillable short of SIGKILL.
    console.error("perch: forced shutdown on repeated signal");
    process.exit(1);
  }
  shuttingDown = true;
  removePidFile();
  // Durable state makes waiting optional: an unfinished dispatch or outbox
  // delivery resumes from SQLite on the next start, so the graceful drain is
  // bounded rather than open-ended.
  await withTimeout(Promise.all([taskScheduler.stop(), outboxWorker.stop()]), 10_000);
  timeline.stop();
  prPoller.stop();
  reconciler.stop();
  taskWatchdog?.stop();
  pushRouter.stop();
  charts.stop();
  relayClient?.stop();
  monitor.stop();
  for (const runtime of tasks.stateDb.runtimes.active()) {
    if (runtime.ptySessionId) {
      runtimeManager.interruptSession(runtime.ptySessionId, "server shutdown interrupted runtime");
    }
  }
  for (const runtime of tasks.stateDb.ownerRuntimes.active()) {
    if (runtime.ptySessionId) ownerManager.interruptSession(runtime.ptySessionId);
  }
  codexControl.stop();
  // server.close() waits for open connections; drop WebSocket clients so a
  // connected phone cannot hang the shutdown.
  monitor.closeAllClients();
  adapter.stop();
  tasks.close();
  server.close(() => {
    process.exit(0);
  });
}

function withTimeout(work: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([
    work.catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, ms))
  ]);
}
