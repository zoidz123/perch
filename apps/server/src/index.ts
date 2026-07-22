import { statSync } from "node:fs";
import { basename } from "node:path";
import { PtyAgentAdapter } from "./adapters/pty.js";
import { CodexAppServerAdapter } from "./adapters/codexAppServerAdapter.js";
import { CodexDaemonManager } from "./adapters/codexDaemon.js";
import { RoutingAgentAdapter } from "./adapters/routingAdapter.js";
import { AuditLog } from "./audit.js";
import {
  markTaskWorkingFromActivity,
  resolveApprovalForTask,
  resolveCodexServerRequest,
  surfaceCodexServerRequest,
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
// Codex is app-server-owned: perch spawns one `codex app-server` daemon per
// session workdir on a private unix socket and is its sole standing
// authoritative client. There is no Codex PTY and no keystroke path; rollback
// is by release or commit, not a runtime switch.
const codexDaemons = new CodexDaemonManager();
const codexOwned = new CodexAppServerAdapter({
  daemons: codexDaemons,
  // The daemon process runs the agent's tool shells, so it carries the same
  // per-session hook wiring a PTY session would.
  sessionEnv: (sessionId, request) => ({
    PERCH_SESSION_ID: sessionId,
    PERCH_HOOK_URL: `http://127.0.0.1:${config.port}/hooks`,
    PERCH_HOOK_TOKEN: hooks.ensure(sessionId).token,
    ...taskCapabilityEnvironment(tasks, request)
  })
});
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
const adapter = new RoutingAgentAdapter(ptyAdapter, codexOwned);
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
  // A structured provider signal, hook, or terminal fallback reported quota
  // exhaustion. Block the owning task through the normal mate wake channel.
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
    // A surviving codex daemon's environment still authenticates with the
    // session identity it was spawned with; keep those durable credentials
    // until the runtime either rebinds (aliasing them to the live session) or
    // ends. Pruning them here would strand every tool shell of a daemon the
    // sweep below deliberately keeps alive.
    const keepCredentials = new Set(live);
    for (const runtime of [...tasks.stateDb.runtimes.active(), ...tasks.stateDb.ownerRuntimes.active()]) {
      if (typeof runtime.metadata?.appServerSocketPath !== "string") continue;
      const daemonSessionId =
        typeof runtime.metadata.appServerDaemonSessionId === "string"
          ? runtime.metadata.appServerDaemonSessionId
          : runtime.ptySessionId;
      if (daemonSessionId) keepCredentials.add(daemonSessionId);
    }
    hooks.prune(keepCredentials);
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

// Protocol notifications own every app-server-owned Codex session's timeline,
// status, approvals, streaming, and turn lifecycle. This is the single wiring
// point from the owning adapter into the monitor/task/timeline world.
codexOwned.wireEvents({
  onTimelineItem: (item, live) => timeline.ingest(item, { live }),
  onStatus: (sessionId, status) => {
    // Status alone never recovers a blocked task: approval resolution also
    // transitions back to `running` mid-turn (see onTurnStarted below).
    monitor.applyExternalStatus(sessionId, status, "codex", "adapter");
  },
  onServerRequest: (sessionId, request) => surfaceCodexServerRequest({ monitor, tasks }, sessionId, request),
  onServerRequestResolved: (sessionId, request) => resolveCodexServerRequest({ monitor, tasks }, sessionId, request),
  onAssistantStream: (sessionId, ev) => {
    markTaskWorkingFromActivity({ tasks }, sessionId);
    monitor.publish({
      type: "assistant_stream",
      sessionId,
      itemId: ev.itemId,
      text: ev.text,
      done: ev.done,
      at: new Date().toISOString()
    });
  },
  onTurnStarted: (sessionId) => {
    // An actual turn start is the one signal allowed to recover a blocked
    // task back to working.
    taskCompletion.onTurnStarted(sessionId, "codex");
    markTaskWorkingFromActivity({ tasks }, sessionId, { newTurn: true });
  },
  onTurnComplete: (sessionId) => {
    markTaskWorkingFromActivity({ tasks }, sessionId);
    taskCompletion.onTurnCompleted(sessionId, "codex");
  },
  onThreadStarted: (sessionId, threadId) => {
    runtimeManager.recordProviderSession(sessionId, "codex", threadId);
    ownerManager.recordProviderSession(sessionId, "codex", threadId);
  },
  onModelResolved: (sessionId, model) =>
    monitor.setSessionModel(sessionId, resolveSessionModel("codex", { model })),
  onUsageLimit: (sessionId, limit) => monitor.reportUsageLimit(sessionId, "codex", limit),
  onSessionExit: (sessionId, exitContext) => {
    hooks.unregister(sessionId);
    timeline.detach(sessionId);
    removeAttachments(sessionId);
    ownerManager.interruptSession(sessionId);
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
    pushRouter.sessionExited(sessionId);
  }
});

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
// path for everything this skips. Runs once at startup so expired leases from
// sessions that did not survive can reclaim immediately, and then on an
// interval.
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
  codexOwned,
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
  // Retire daemons orphaned by a previous exit before any launch can acquire
  // new ones - EXCEPT daemons recorded on active app-server-owned runtimes:
  // those hold live thread state that recovery rebinds to without a respawn.
  // Only after the port bind - the effective single-instance lock - so a
  // second server racing against a live one dies on EADDRINUSE without
  // SIGTERMing its live daemons.
  const keepSockets = new Set<string>();
  for (const runtime of [...tasks.stateDb.runtimes.active(), ...tasks.stateDb.ownerRuntimes.active()]) {
    const socketPath = runtime.metadata?.appServerSocketPath;
    if (typeof socketPath === "string" && socketPath.length > 0) keepSockets.add(socketPath);
  }
  codexDaemons.sweepOrphans(keepSockets);
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
  // Leave live owned sessions' daemons running: they hold the in-memory
  // thread state the next server life rebinds to (runtime rows just flipped
  // recoverable above). Sockets recorded on still-active worker and mate
  // runtimes survive too, so a daemon awaiting a not-yet-run recovery is
  // never torn down by a second graceful restart. Everything else goes.
  const surviving = codexOwned.liveSocketPaths();
  for (const runtime of [...tasks.stateDb.runtimes.active(), ...tasks.stateDb.ownerRuntimes.active()]) {
    const socketPath = runtime.metadata?.appServerSocketPath;
    if (typeof socketPath === "string" && socketPath.length > 0) surviving.add(socketPath);
  }
  codexOwned.stop({ keepDaemons: true });
  codexDaemons.stopAll(surviving);
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
