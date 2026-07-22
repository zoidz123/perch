import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AgentKind,
  AgentSession,
  CodexReasoningEffort,
  PendingServerRequest,
  PendingApproval,
  StartAgentRequest
} from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import type { AuditLog, AuditRecord } from "./audit.js";
import { seedClaudeWorktreeTrust } from "./claudeTrust.js";
import type { CodexControlPlane } from "./codexControl.js";
import type { FleetMonitor } from "./fleetMonitor.js";
import { claudeTranscriptPath, findCodexRollout, isAllowedTranscriptPath, type HookRegistry } from "./hooks.js";
import { resolveSessionModel } from "./models.js";
import { assertLocalRuntimeModelId } from "./modelSwitch.js";
import type { ProjectRegistry } from "./projects.js";
import type { TaskStore } from "./tasks.js";
import type { TaskCompletionReconciler } from "./taskCompletion.js";
import type { RuntimeManager } from "./runtimeManager.js";
import type { RecoveryCoordinator } from "./recovery.js";
import type { OwnerManager } from "./ownerManager.js";
import type { MateRecoveryCoordinator } from "./mateRecovery.js";
import type { TimelineStore } from "./timeline.js";
import type { WorktreeLease, WorktreePool } from "./worktrees.js";

type LaunchAuditMeta = Pick<AuditRecord, "deviceId" | "remoteAddress">;

export type ManagedAgentLauncherOptions = {
  adapter: AgentAdapter;
  auditLog: AuditLog;
  monitor: FleetMonitor;
  projects: ProjectRegistry;
  worktrees: WorktreePool;
  hooks: HookRegistry;
  timeline: TimelineStore;
  tasks: TaskStore;
  port: number;
  // Claude's state file (.claude.json) for pre-launch worktree trust seeding.
  // The server entrypoint wires the real path; absent means no seeding.
  claudeStateFile?: string;
  codexControl?: CodexControlPlane;
  // Reinstalls the provider's hook entries ahead of a launch. Provider config
  // (~/.claude/settings.json, ~/.codex/hooks.json) is shared state that other
  // tools rewrite wholesale from stale snapshots, dropping perch's entries and
  // silencing every hook for sessions launched afterwards; the boot-time
  // install alone cannot heal that. The entrypoint wires the real installers;
  // absent in tests that must not touch real config.
  installHooks?: (agent: AgentKind) => void;
  taskCompletion?: TaskCompletionReconciler;
  // How long a dispatched codex worker may show no first-turn evidence before
  // its kickoff is retried once (and, after a second window, parked blocked).
  // Tests shrink it; production uses CODEX_KICKOFF_RETRY_MS.
  codexKickoffRetryMs?: number;
  runtimeManager?: RuntimeManager;
  recoveryCoordinator?: RecoveryCoordinator;
  ownerManager?: OwnerManager;
  mateRecoveryCoordinator?: MateRecoveryCoordinator;
};

export type StartManagedAgentInput = {
  request: StartAgentRequest;
  auditMeta?: LaunchAuditMeta;
  taskId?: string;
  // Task dispatch already leases to the task id before launch. The launcher
  // still owns binding that lease to the session and releasing it on failure.
  worktreeLease?: WorktreeLease;
  // Project root to register after launch. Defaults to the lease repo root or
  // request cwd; task dispatch passes the original project root.
  projectRoot?: string;
  // Mate home is infrastructure, not a project.
  registerProject?: boolean;
  // Task kickoffs are agent-authored and need provenance before queueing.
  initialPromptSource?: "human" | "agent";
  // Recovery already owns the authoritative `recovering` generation and
  // binds g+1 only after provider identity verification.
  trackRuntime?: boolean;
  // Durable-owner recovery already holds the mate generation and binds its
  // replacement only after provider identity verification.
  trackOwner?: boolean;
  intentionalNewMate?: boolean;
  // A recovery failure must preserve the task-held worktree for another try.
  retainWorktreeOnFailure?: boolean;
  // Codex recovery uses the CLI's verified native `resume <id>` path. A fresh
  // remote daemon does not reliably broadcast identity for a resumed thread.
  disableCodexRemote?: boolean;
};

export type StartManagedAgentResult = {
  session: AgentSession;
  request: StartAgentRequest;
  codexRemote: boolean;
  worktreeId?: string;
};

// Non-secret launch context for pipeline clients. These values are useful for
// forming an authorization request but are never authority by themselves;
// /hooks/no-mistakes/authorize verifies them against the hook credential and
// durable task/runtime records.
export function taskCapabilityEnvironment(
  tasks: TaskStore,
  request: StartAgentRequest,
  cwd = request.cwd ?? process.cwd()
): Record<string, string> {
  const taskId = request.labels?.task;
  if (!taskId) return {};
  const task = tasks.find(taskId);
  if (!task) return {};
  const runtime = (request.sessionId
    ? tasks.stateDb.runtimes.findBySession(request.sessionId)
    : undefined) ?? tasks.stateDb.runtimes.latestForTask(task.id);
  const repository = canonicalRepositoryForPath(task.project);
  if (!runtime || !repository) return {};
  return {
    PERCH_TASK_ID: task.id,
    PERCH_TASK_MODE: task.mode,
    PERCH_TASK_PROJECT: canonicalLaunchPath(task.project),
    PERCH_TASK_REPOSITORY: repository,
    PERCH_TASK_WORKTREE: canonicalLaunchPath(cwd),
    PERCH_TASK_BRANCH: task.branch ?? `perch/${task.id}`,
    PERCH_RUNTIME_GENERATION: String(runtime.generation)
  };
}

export function canonicalRepository(value: string): string {
  const trimmed = value.trim().replace(/\.git$/, "");
  try {
    const parsed = new URL(trimmed);
    const authority = trimmed.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i)?.[1];
    if (authority && parsed.host) {
      const credentialFreeHost = authority.slice(authority.lastIndexOf("@") + 1).toLowerCase();
      return `${credentialFreeHost}/${parsed.pathname.replace(/^\/+/, "")}`;
    }
  } catch {
    // SCP-style and local remote forms are handled below.
  }
  const withoutUser = trimmed.includes("@") ? trimmed.slice(trimmed.lastIndexOf("@") + 1) : trimmed;
  return withoutUser.replace(":", "/").replace(/^\/+/, "").toLowerCase();
}

export function canonicalRepositoryForPath(path: string): string | undefined {
  try {
    const remote = execFileSync("git", ["-C", path, "remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const canonical = canonicalRepository(remote);
    return canonical || undefined;
  } catch {
    return undefined;
  }
}

function canonicalLaunchPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

// One codex rollout resolver loop per session: many hooks/control signals can
// arrive before the first attach, and each would otherwise spawn overlapping
// filesystem polls.
const codexRolloutResolving = new Set<string>();

export async function startManagedAgent(
  options: ManagedAgentLauncherOptions,
  input: StartManagedAgentInput
): Promise<StartManagedAgentResult> {
  if (!options.adapter.startAgent) {
    throw new Error("PTY agents are not supported by this server");
  }

  const request = cloneStartRequest(input.request);
  validateStartAgent(request);

  if (request.worktree === true && input.worktreeLease) {
    throw new Error("worktree launch cannot specify both worktree=true and an existing lease");
  }

  let lease = input.worktreeLease;
  let releaseLeaseOnFailure = Boolean(input.worktreeLease);
  if (request.worktree === true) {
    const repoRoot = request.cwd ?? process.cwd();
    lease = await options.worktrees.acquire(repoRoot, "pending");
    releaseLeaseOnFailure = true;
    request.cwd = lease.path;
  } else if (lease) {
    request.cwd = lease.path;
  }

  const cwd = request.cwd ?? process.cwd();

  // Claude's folder-trust dialog renders before any hook loads, so no device
  // can answer it: seed trust ahead of launch for a pool worktree created
  // from a registered project (registration is the human trust decision this
  // inherits). Never for paths perch does not manage; codex is untouched.
  if (
    options.claudeStateFile &&
    lease &&
    launchAgentKind(request.command, request.agent) === "claude" &&
    options.projects.find(lease.repoRoot)
  ) {
    const trustSeeded = seedClaudeWorktreeTrust(options.claudeStateFile, lease.path);
    if (!trustSeeded) {
      console.warn(
        `claude trust: could not pre-trust ${lease.path}; launching anyway so Claude can show the manual trust gate`
      );
    }
  }

  // Self-heal hook installation before the agent process starts (it reads its
  // hook config once, at startup). Idempotent and a fast no-op when the
  // entries are already present; failure never blocks the launch - the
  // pre-minted identity below keeps the timeline attached regardless.
  try {
    options.installHooks?.(launchAgentKind(request.command, request.agent));
  } catch (error) {
    console.warn(
      `hooks: launch-time reinstall failed: ${error instanceof Error ? error.message : error}`
    );
  }

  // Hook-independent Claude session identity: mint the provider session id
  // ourselves so the transcript location is known before the process exists.
  const claudeIdentity = prepareClaudeIdentity(request, cwd);

  const launchModel = resolveSessionModel(launchAgentKind(request.command, request.agent), {
    model: request.model,
    effort: request.effort
  });
  if (launchModel.effort && !request.effort) request.effort = launchModel.effort;

  const task = input.taskId && input.trackRuntime !== false ? options.tasks.find(input.taskId) : undefined;
  const runtime = task
    ? options.runtimeManager?.beginLaunch(
        task,
        { ...request, ...(launchModel.model ? { model: launchModel.model } : {}) },
        lease
      )
    : undefined;
  const ownerRuntime = request.labels?.role === "mate" && input.trackOwner !== false
    ? options.ownerManager?.beginMateLaunch(request, input.intentionalNewMate === true)
    : undefined;
  let codexSocketPath: string | null = null;
  let session: AgentSession | undefined;
  try {
    codexSocketPath = input.disableCodexRemote
      ? null
      : await prepareCodexRemote(options, request, cwd, launchModel.effort);
    if (codexSocketPath && request.sessionId) {
      await attachCodexControl(options, request.sessionId, codexSocketPath, cwd);
    }
    session = await options.adapter.startAgent(request);

    if (request.sessionId && session.id !== request.sessionId) {
      // The adapter refused the pre-minted id. Drop the misaddressed control
      // client so a stale id cannot receive model or turn commands - but the
      // spawned TUI stays dialed into the daemon, so daemon ownership moves to
      // the adapter's id (releasing it here would kill the live session's
      // backend; the session's exit releases it instead).
      options.codexControl?.transferDaemon(request.sessionId, session.id);
      await options.codexControl?.detach(request.sessionId).catch(() => {});
      options.hooks.unregister(request.sessionId);
    }

    if (lease) {
      await options.worktrees.assign(lease.id, session.id);
      session.worktreeId = lease.id;
    }

    if (runtime) {
      options.runtimeManager?.markLive(runtime, session.id, options.adapter.runtimeProcess?.(session.id), {
        ...(request.model ? { model: request.model } : {}),
        ...(lease ? { worktreeId: lease.id, leaseId: lease.id, worktreePath: lease.path } : {})
      });
    }
    if (ownerRuntime) {
      options.ownerManager?.markLive(ownerRuntime, session.id, options.adapter.runtimeProcess?.(session.id));
    }

    options.monitor.setSessionModel(
      session.id,
      resolveSessionModel(session.agent, {
        model: request.model,
        effort: request.effort
      })
    );

    // Attach the timeline tailer to the pre-minted transcript path right at
    // launch. The file does not exist yet; the tailer polls for its creation
    // and reads it from offset 0, so rows written before this attach (or
    // during any later gap) backfill and the timeline is complete, never
    // live-from-now. Hook correlation, when it arrives, re-points to the same
    // path and is a no-op; when hooks are lost entirely this is the only
    // attachment, and the watchdog's activity feed (timeline.lastActivityAt)
    // stays truthful. Recording the provider session id here also makes
    // recovery available from launch instead of provider_session_unknown.
    if (claudeIdentity && session.id === request.sessionId) {
      options.hooks.correlate(session.id, claudeIdentity.agentSessionId, claudeIdentity.transcriptPath);
      if (isAllowedTranscriptPath(claudeIdentity.transcriptPath)) {
        options.timeline.attach(session.id, claudeIdentity.transcriptPath, isAllowedTranscriptPath, "claude");
      }
      options.runtimeManager?.recordProviderSession(session.id, "claude", claudeIdentity.agentSessionId);
      options.ownerManager?.recordProviderSession(session.id, "claude", claudeIdentity.agentSessionId);
    }

    const shouldRegisterProject = input.registerProject ?? request.labels?.role !== "mate";
    if (shouldRegisterProject) {
      options.projects.touch(input.projectRoot ?? lease?.repoRoot ?? cwd);
    }

    // A resumed Claude session forks its transcript into a fresh jsonl (new
    // uuid) and abandons the resumed-from file the SessionStart hook names, so
    // the tailer must actively re-resolve to the live fork - the Claude
    // analogue of the codex rollout scan. Scoped to `--resume` launches only;
    // fresh sessions do not fork, and codex resume uses `resume` (no dashes).
    if (isClaudeResumeLaunch(request)) {
      options.timeline.followClaudeResume(session.id, isAllowedTranscriptPath);
    }

    if (typeof request.initialPrompt === "string" && request.initialPrompt.trim().length > 0) {
      if (input.initialPromptSource) {
        options.timeline.recordSource(session.id, request.initialPrompt, input.initialPromptSource);
      }
      options.monitor.queueInitialPrompt(session.id, request.initialPrompt);
      // The queued kickoff is typed into the TUI best-effort; a codex TUI that
      // was not ready yet swallows it silently and the worker then sits empty
      // forever. Watch for first-turn evidence and retry the kickoff once.
      if (
        input.taskId &&
        input.initialPromptSource === "agent" &&
        launchAgentKind(request.command, request.agent) === "codex"
      ) {
        armCodexKickoffWatchdog(options, session.id, input.taskId, request.initialPrompt, options.codexKickoffRetryMs);
      }
    }

    await audit(options.auditLog, {
      action: "start_agent",
      sessionId: session.id,
      ...input.auditMeta,
      command: request.command,
      cwd: request.cwd,
      ...(input.taskId ? { taskId: input.taskId } : {})
    });

    return {
      session,
      request,
      codexRemote: Boolean(codexSocketPath),
      ...(lease ? { worktreeId: lease.id } : {})
    };
  } catch (error) {
    if (runtime) options.runtimeManager?.markLaunchFailed(runtime);
    if (ownerRuntime) options.ownerManager?.markLaunchFailed(ownerRuntime);
    if (session?.id && options.adapter.stopSession) {
      await options.adapter.stopSession(session.id).catch(() => {});
    }
    if (request.sessionId) {
      await options.codexControl?.detach(request.sessionId).catch(() => {});
      options.hooks.unregister(request.sessionId);
    }
    if (lease && releaseLeaseOnFailure && !input.retainWorktreeOnFailure) {
      await options.worktrees.release(lease.id, { force: true }).catch(() => {});
    }
    throw error;
  }
}

function cloneStartRequest(request: StartAgentRequest): StartAgentRequest {
  return {
    ...request,
    ...(request.args ? { args: [...request.args] } : {}),
    ...(request.labels ? { labels: { ...request.labels } } : {}),
    ...(request.desktop ? { desktop: { ...request.desktop } } : {})
  };
}

const CLAUDE_SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Pre-mint a fresh Claude launch's provider session id (`--session-id <uuid>`,
// supported since well before the 2.1.x floor the hook installer already
// requires) and derive its transcript path, so timeline attachment never
// depends on a SessionStart hook arriving. Skipped for resumed/continued
// sessions - those keep their provider identity and fork transcripts, which
// followClaudeResume owns - and when the caller passed --session-id itself.
// Mutates request: adopts/mints request.sessionId (the PTY adapter honors
// pre-minted pty: ids, mirroring the codex --remote path) and appends the flag.
function prepareClaudeIdentity(
  request: StartAgentRequest,
  cwd: string
): { agentSessionId: string; transcriptPath: string } | undefined {
  if (launchAgentKind(request.command, request.agent) !== "claude") return undefined;
  const args = request.args ?? [];
  if (args.includes("--resume") || args.includes("--continue") || args.includes("--session-id")) {
    return undefined;
  }
  const sessionId = request.sessionId ?? `pty:${randomUUID()}`;
  const agentSessionId = sessionId.startsWith("pty:") ? sessionId.slice("pty:".length) : "";
  if (!CLAUDE_SESSION_UUID.test(agentSessionId)) return undefined;
  request.sessionId = sessionId;
  request.args = [...args, "--session-id", agentSessionId];
  return { agentSessionId, transcriptPath: claudeTranscriptPath(cwd, agentSessionId) };
}

// Is this a resumed Claude launch (`claude --resume <id>`)? Only these fork the
// transcript, and only Claude uses the `--resume` flag - codex resume is a bare
// `resume` subcommand - so this both scopes and disambiguates the re-resolver.
function isClaudeResumeLaunch(request: StartAgentRequest): boolean {
  return (
    launchAgentKind(request.command, request.agent) === "claude" &&
    (request.args ?? []).includes("--resume")
  );
}

// Is this launch a Codex session? The New Agent sheet sends agent: "codex";
// otherwise infer from the command basename.
function isCodexLaunch(command: string, agent?: AgentKind): boolean {
  if (agent) return agent === "codex";
  const base = command.trim().split(/[\\/]/).pop() ?? "";
  return base.toLowerCase().includes("codex");
}

async function prepareCodexRemote(
  options: ManagedAgentLauncherOptions,
  request: StartAgentRequest,
  cwd: string,
  effort?: CodexReasoningEffort
): Promise<string | null> {
  if (!options.codexControl || !isCodexLaunch(request.command, request.agent)) return null;

  // Pre-mint this session's id + hook token and set them on the request so the
  // PTY adapter adopts the same id. The daemon is spawned before the session
  // exists, so seed it with hook wiring now.
  const sessionId = request.sessionId ?? `pty:${randomUUID()}`;
  request.sessionId = sessionId;
  const hookEnv: Record<string, string> = {
    PERCH_SESSION_ID: sessionId,
    PERCH_HOOK_URL: `http://127.0.0.1:${options.port}/hooks`,
    PERCH_HOOK_TOKEN: options.hooks.ensure(sessionId).token,
    ...taskCapabilityEnvironment(options.tasks, request, cwd)
  };
  const handle = await options.codexControl.prepareRemote(cwd, { effort, env: hookEnv });
  if (!handle) return null;

  request.args = ["--remote", `unix://${handle.socketPath}`, ...(request.args ?? [])];
  return handle.socketPath;
}

// A dispatched task stays `queued` until its worker shows life. Claude workers
// reliably curl a `working` event themselves, but a codex worker can report
// nothing (or inherit stale hook credentials), so any observed activity flips
// queued -> working. A parked task is different: the verb may be a deliberate
// worker report, so only an explicit new-turn start or successfully submitted
// composer input (`newTurn`) may restore it to `working` - trailing activity
// from the turn that reported the block (Stop hooks, residual assistant-stream
// /turn-complete frames) must not.
export function markTaskWorkingFromActivity(
  options: { tasks: TaskStore },
  sessionId: string,
  opts: { newTurn?: boolean } = {}
): void {
  const task = options.tasks.list().find((candidate) => candidate.sessionId === sessionId);
  if (!task) return;
  const resumesParkedTask =
    opts.newTurn === true && (task.state === "blocked" || task.state === "needs_you");
  if (task.state !== "queued" && !resumesParkedTask) return;
  try {
    options.tasks.recordEvent(task.id, { kind: "working", source: "system", message: "worker session active" });
  } catch {
    // Never let the activity flip disturb the session.
  }
}

function publishCodexStream(
  options: ManagedAgentLauncherOptions,
  sessionId: string,
  ev: { itemId: string; text: string; done: boolean }
): void {
  options.monitor.publish({
    type: "assistant_stream",
    sessionId,
    itemId: ev.itemId,
    text: ev.text,
    done: ev.done,
    at: new Date().toISOString()
  });
}

function taskForSession(options: ManagedAgentLauncherOptions, sessionId: string) {
  return options.tasks.list().find((task) => task.sessionId === sessionId);
}

export function surfaceApprovalToTask(
  tasks: TaskStore,
  sessionId: string,
  approval: PendingApproval
): void {
  const task = tasks.list().find((candidate) => candidate.sessionId === sessionId);
  if (!task || !["queued", "working", "needs_you", "blocked"].includes(task.state)) return;
  tasks.recordEvent(task.id, {
    kind: "needs_decision",
    source: "system",
    message: approval.summary,
    data: {
      reason: "approval_request",
      approvalId: approval.id,
      source: approval.source ?? "hook",
      decisions: approval.decisions,
      context: approval.context,
      command: approval.command,
      cwd: approval.cwd,
      requestVersion: approval.requestVersion,
      runtimeGeneration: approval.runtimeGeneration,
      decisionPolicy: approval.decisionPolicy
    }
  });
}

export function resolveApprovalForTask(
  tasks: TaskStore,
  sessionId: string,
  approval: PendingApproval
): void {
  const task = tasks.list().find((candidate) => candidate.sessionId === sessionId);
  if (!task || task.state !== "needs_you") return;
  const last = tasks.events(task.id).at(-1);
  if (last?.data?.reason !== "approval_request" || last.data.approvalId !== approval.id) return;
  tasks.recordEvent(task.id, {
    kind: "working",
    source: "system",
    message: "Permission request resolved",
    data: {
      reason: "approval_request_resolved",
      approvalId: approval.id,
      decision: approval.submittedDecision
    }
  });
}

function codexServerRequestEventData(request: PendingServerRequest): Record<string, unknown> {
  return {
    reason: "codex_server_request",
    requestId: request.requestId,
    threadId: request.threadId,
    turnId: request.turnId,
    itemId: request.itemId,
    callId: request.callId,
    family: request.family,
    decisions: request.decisions,
    persistence: request.persistence
  };
}

function surfaceCodexServerRequest(
  options: ManagedAgentLauncherOptions,
  sessionId: string,
  request: PendingServerRequest
): void {
  if (!options.monitor.setPendingServerRequest(sessionId, request)) return;
  const task = taskForSession(options, sessionId);
  if (!task || !["queued", "working", "needs_you", "blocked"].includes(task.state)) return;
  options.tasks.recordEvent(task.id, {
    kind: "needs_decision",
    source: "system",
    message: request.summary,
    data: codexServerRequestEventData(request)
  });
}

function resolveCodexServerRequest(
  options: ManagedAgentLauncherOptions,
  sessionId: string,
  request: PendingServerRequest
): void {
  if (!options.monitor.resolveServerRequest(sessionId, request.requestId)) return;
  const task = taskForSession(options, sessionId);
  if (!task || task.state !== "needs_you") return;
  const last = options.tasks.events(task.id).at(-1);
  if (last?.data?.reason !== "codex_server_request") return;
  const remaining = options.monitor.pendingServerRequest(sessionId);
  if (remaining) {
    // Another request is still open: the task stays needs_you. Only when the
    // ledger's needs_decision moment named the request that just resolved does
    // it re-point at the surviving queue head; otherwise it still names an
    // open request and re-pointing would duplicate that request's event.
    if (last.data.requestId !== request.requestId) return;
    options.tasks.recordEvent(task.id, {
      kind: "needs_decision",
      source: "system",
      message: remaining.summary,
      data: codexServerRequestEventData(remaining)
    });
    return;
  }
  if (last.data.requestId !== request.requestId) return;
  options.tasks.recordEvent(task.id, {
    kind: "working",
    source: "system",
    message: "Codex approval resolved",
    data: { reason: "codex_server_request_resolved", requestId: request.requestId }
  });
}

async function attachCodexControl(
  options: ManagedAgentLauncherOptions,
  sessionId: string,
  socketPath: string,
  cwd: string
): Promise<void> {
  if (!options.codexControl) return;
  let sharedThreadId: string | undefined;
  const ensureRollout = () => {
    if (sharedThreadId) attachCodexRollout(options, sessionId, sharedThreadId);
  };
  const attached = await options.codexControl.attach(sessionId, {
    socketPath,
    cwd,
    onSharedThread: (threadId) => {
      sharedThreadId = threadId;
      options.runtimeManager?.recordProviderSession(sessionId, "codex", threadId);
      options.ownerManager?.recordProviderSession(sessionId, "codex", threadId);
      // Feed the recovery verifier for remote-topology sessions. Recovery
      // currently launches codex PTY-only (disableCodexRemote), so no
      // identity expectation matches here today; the codex driver's
      // out-of-band verifier resolves it instead. This stays wired so a
      // future remote-enabled recovery carries same-daemon evidence.
      options.recoveryCoordinator?.observeSessionStart(sessionId, "codex", threadId);
      options.mateRecoveryCoordinator?.observeSessionStart(sessionId, "codex", threadId);
      ensureRollout();
    },
    onAssistantStream: (ev) => {
      ensureRollout();
      markTaskWorkingFromActivity(options, sessionId);
      publishCodexStream(options, sessionId, ev);
    },
    onStatus: (status) => {
      // Status alone never recovers a blocked task: approval resolution also
      // transitions back to `running` mid-turn (see onTurnStarted below).
      options.monitor.applyExternalStatus(sessionId, status, "codex", "adapter");
    },
    onServerRequest: (request) => surfaceCodexServerRequest(options, sessionId, request),
    onServerRequestResolved: (request) => resolveCodexServerRequest(options, sessionId, request),
    onTurnStarted: () => {
      // An actual turn start (legacy task_started / raw v2 turn/started) is
      // the one signal allowed to recover a blocked task back to working.
      options.taskCompletion?.onTurnStarted(sessionId, "codex");
      markTaskWorkingFromActivity(options, sessionId, { newTurn: true });
    },
    onTurnComplete: (ev) => {
      ensureRollout();
      markTaskWorkingFromActivity(options, sessionId);
      options.taskCompletion?.onTurnCompleted(sessionId, "codex");
    },
    onUsageLimit: (limit) => {
      options.monitor.reportUsageLimit(sessionId, "codex", limit);
    }
  });
  if (!attached) {
    console.warn(`codex: control attach failed session=${sessionId.slice(0, 12)}`);
  }
}

export function attachCodexRollout(
  options: {
    hooks: HookRegistry;
    timeline: TimelineStore;
  },
  sessionId: string,
  agentSessionId: string
): void {
  if (codexRolloutResolving.has(sessionId)) return;
  codexRolloutResolving.add(sessionId);
  void (async () => {
    try {
      // 60s window: the rollout file only appears at the thread's first turn,
      // and turn signals re-arm a fresh pass, so a later first turn still
      // attaches.
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (options.hooks.correlation(sessionId)?.transcriptPath) {
          return;
        }
        const rollout = findCodexRollout(agentSessionId);
        if (rollout) {
          if (isAllowedTranscriptPath(rollout)) {
            options.hooks.correlate(sessionId, agentSessionId, rollout);
            options.timeline.attach(sessionId, rollout, isAllowedTranscriptPath, "codex", agentSessionId);
            console.log(`codex rollout attached session=${sessionId.slice(0, 12)}`);
          }
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } finally {
      codexRolloutResolving.delete(sessionId);
    }
  })();
}

export const CODEX_KICKOFF_RETRY_MS = 45_000;

// One armed kickoff watchdog per session, however many callers race to arm it.
const codexKickoffWatchdogs = new Set<string>();

export type CodexKickoffWatchdogDeps = {
  tasks: TaskStore;
  monitor: Pick<FleetMonitor, "queueOrSubmit">;
  hooks: Pick<HookRegistry, "correlation">;
  timeline: Pick<TimelineStore, "recordSource">;
};

// First-turn evidence for a dispatched codex worker, strongest first: the
// provider's own turn lifecycle recorded against this exact session, a worker
// verb (only ever curled from inside a running turn), or the rollout
// correlation (codex writes the rollout file only at the thread's first turn).
// Deliberately excludes transcript text, rendered-screen state, and elapsed
// time - none of those prove the kickoff was accepted.
export function codexFirstTurnEvidence(
  deps: Pick<CodexKickoffWatchdogDeps, "tasks" | "hooks">,
  sessionId: string,
  taskId: string
): "turn" | "worker" | "rollout" | undefined {
  for (const event of deps.tasks.events(taskId)) {
    if ((event.kind === "turn_started" || event.kind === "turn_completed") && event.data?.sessionId === sessionId) {
      return "turn";
    }
    if (event.source === "worker") return "worker";
  }
  return deps.hooks.correlation(sessionId)?.transcriptPath ? "rollout" : undefined;
}

// A dispatched codex worker whose kickoff was swallowed (typed into a TUI that
// was not ready) must not sit silently empty. After one window with no
// first-turn evidence, resubmit the exact original kickoff once; after a
// second window still without evidence, park the task blocked so the mate
// adjudicates instead of the worker "working" forever. Evidence is re-checked
// immediately before the retry, so a first turn that lands in the window
// suppresses it, and the per-session guard makes the retry exactly-once even
// when arming races. A submitted retry is journaled on the task ledger so a
// rearm after a server restart never submits a second one.
export function armCodexKickoffWatchdog(
  deps: CodexKickoffWatchdogDeps,
  sessionId: string,
  taskId: string,
  kickoff: string,
  windowMs = CODEX_KICKOFF_RETRY_MS
): void {
  if (codexKickoffWatchdogs.has(sessionId)) return;
  codexKickoffWatchdogs.add(sessionId);
  const disarm = () => codexKickoffWatchdogs.delete(sessionId);
  const retrySpent = () =>
    deps.tasks
      .events(taskId)
      .some(
        (event) =>
          event.kind === "note" && event.data?.reason === "kickoff_retried" && event.data?.sessionId === sessionId
      );
  const finalPass = (retry: "submitted" | "gated") => {
    try {
      if (codexFirstTurnEvidence(deps, sessionId, taskId)) return;
      const task = deps.tasks.find(taskId);
      // A task already parked (needs_you, blocked, failed) owns its truthful
      // outcome; only a still-silent queued/working task is parked here.
      if (!task || (task.state !== "queued" && task.state !== "working")) return;
      deps.tasks.recordEvent(taskId, {
        kind: "blocked",
        source: "system",
        message:
          retry === "submitted"
            ? "codex worker shows no first turn after launch and one kickoff retry; the kickoff prompt was never accepted"
            : "codex worker shows no first turn after launch and the kickoff retry was skipped by an open permission gate; the kickoff prompt was never accepted",
        data: { reason: "kickoff_not_accepted", sessionId, retry }
      });
    } catch {
      // Ledger bookkeeping must never disturb the session.
    } finally {
      disarm();
    }
  };
  const retryPass = async () => {
    let retry: "submitted" | "gated";
    try {
      if (codexFirstTurnEvidence(deps, sessionId, taskId)) return disarm();
      if (retrySpent()) {
        // A previous server life already spent the one retry; only the final
        // adjudication window remains.
        retry = "submitted";
      } else {
        // Exactly one retry of the exact original kickoff. queueIfGated: false -
        // an open permission gate means the worker is not silently empty (the
        // approval flow owns that outcome), and queued text typed later could
        // land after the gate resolves and duplicate an accepted kickoff. Only
        // an actually submitted retry earns a provenance record and the
        // spent-retry journal entry.
        const result = await deps.monitor.queueOrSubmit(sessionId, kickoff, { queueIfGated: false });
        retry = result.gated ? "gated" : "submitted";
        if (!result.gated) {
          deps.timeline.recordSource(sessionId, kickoff, "agent");
          deps.tasks.recordEvent(taskId, {
            kind: "note",
            source: "system",
            message: "codex kickoff retried after a silent launch window",
            data: { reason: "kickoff_retried", sessionId }
          });
        }
      }
    } catch {
      // The session already ended; exit reporting owns the truthful outcome.
      return disarm();
    }
    const finalTimer = setTimeout(() => finalPass(retry), windowMs);
    finalTimer.unref?.();
  };
  const retryTimer = setTimeout(() => void retryPass(), windowMs);
  retryTimer.unref?.();
}

// The armed watchdog is process memory; a server restart inside its window
// would otherwise leave a silent dispatched worker unwatched (the generic
// launch-stall backstop can be fooled by TUI banner activity). Rearm at boot
// from durable state alone: still-queued/working codex task dispatches whose
// session is live and shows no first-turn evidence, with the exact original
// kickoff read back from the dispatch operation's prepared launch request.
export async function rearmCodexKickoffWatchdogs(
  deps: CodexKickoffWatchdogDeps & { adapter: Pick<AgentAdapter, "listSessions"> },
  windowMs = CODEX_KICKOFF_RETRY_MS
): Promise<void> {
  let live: Set<string>;
  try {
    live = new Set((await deps.adapter.listSessions()).map((session) => session.id));
  } catch {
    return;
  }
  for (const task of deps.tasks.list()) {
    try {
      if (task.state !== "queued" && task.state !== "working") continue;
      if (!task.sessionId || !live.has(task.sessionId)) continue;
      const operation = deps.tasks.stateDb.operations.latestForTask(task.id, "dispatch");
      const request = (operation?.payload as { prepared?: { request?: StartAgentRequest } } | undefined)?.prepared
        ?.request;
      if (!request || typeof request.initialPrompt !== "string" || request.initialPrompt.trim().length === 0) continue;
      if (request.sessionId !== task.sessionId) continue;
      if (launchAgentKind(request.command, request.agent) !== "codex") continue;
      if (codexFirstTurnEvidence(deps, task.sessionId, task.id)) continue;
      armCodexKickoffWatchdog(deps, task.sessionId, task.id, request.initialPrompt, windowMs);
    } catch {
      // One task's bad records must never block the boot rearm sweep.
    }
  }
}

// Resolve the agent kind for a launch, mirroring the PTY adapter's inference so
// model/effort can be resolved before the session exists. Explicit agent wins.
function launchAgentKind(command: string, agent?: AgentKind): AgentKind {
  if (agent) return agent;
  const base = command.trim().split(/[\\/]/).pop()?.toLowerCase() ?? "";
  for (const kind of ["codex", "claude"] as const) {
    if (base.includes(kind)) return kind;
  }
  return "unknown";
}

export function validateStartAgent(body: StartAgentRequest): void {
  if (!body || typeof body.command !== "string" || body.command.trim().length === 0) {
    throw new Error("command is required");
  }

  if (body.args !== undefined && !Array.isArray(body.args)) {
    throw new Error("args must be an array");
  }

  if (body.args?.some((arg) => typeof arg !== "string")) {
    throw new Error("args must be strings");
  }

  if (body.model !== undefined && typeof body.model !== "string") {
    throw new Error("model must be a string");
  }
  if (typeof body.model === "string" && body.model.trim().length > 0) {
    assertLocalRuntimeModelId(body.model.trim());
  }

  if (body.desktop !== undefined) {
    if (!body.desktop || typeof body.desktop !== "object" || Array.isArray(body.desktop)) {
      throw new Error("desktop must be an object");
    }

    for (const key of ["sessionId", "workspaceId", "paneId", "surfaceId", "terminal"] as const) {
      if (body.desktop[key] !== undefined && typeof body.desktop[key] !== "string") {
        throw new Error(`desktop.${key} must be a string`);
      }
    }

    for (const key of ["cols", "rows"] as const) {
      if (body.desktop[key] !== undefined && !Number.isInteger(body.desktop[key])) {
        throw new Error(`desktop.${key} must be an integer`);
      }
    }
  }
}

function audit(auditLog: AuditLog, record: Parameters<AuditLog["write"]>[0]): Promise<void> {
  return auditLog.write(record).catch((error) => {
    console.error("audit write failed:", error instanceof Error ? error.message : error);
  });
}
