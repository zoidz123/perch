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
import {
  CodexDeliveryUnknownError,
  normalizeCodexLaunchRequest,
  type CodexAppServerAdapter
} from "./adapters/codexAppServerAdapter.js";
import { isCodexRpcError } from "./adapters/codexAppServer.js";
import type { AuditLog, AuditRecord } from "./audit.js";
import { seedClaudeWorktreeTrust } from "./claudeTrust.js";
import type { FleetMonitor } from "./fleetMonitor.js";
import { claudeTranscriptPath, isAllowedTranscriptPath, type HookRegistry } from "./hooks.js";
import { resolveSessionModel } from "./models.js";
import { assertLocalRuntimeModelId } from "./modelSwitch.js";
import type { ProjectRegistry } from "./projects.js";
import type { TaskStore } from "./tasks.js";
import type { TaskCompletionReconciler } from "./taskCompletion.js";
import type { RuntimeManager } from "./runtimeManager.js";
import type { RecoveryCoordinator } from "./recovery.js";
import type { OwnerManager } from "./ownerManager.js";
import type { PromptDeliveryTracker } from "./promptDeliveries.js";
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
  // The app-server owning adapter: the ONLY Codex driver. Codex launches fail
  // loudly without it - there is deliberately no PTY fallback for Codex.
  codexOwned?: CodexAppServerAdapter;
  // Reinstalls the provider's hook entries ahead of a launch. Provider config
  // (~/.claude/settings.json, ~/.codex/hooks.json) is shared state that other
  // tools rewrite wholesale from stale snapshots, dropping perch's entries and
  // silencing every hook for sessions launched afterwards; the boot-time
  // install alone cannot heal that. The entrypoint wires the real installers;
  // absent in tests that must not touch real config.
  installHooks?: (agent: AgentKind) => void;
  taskCompletion?: TaskCompletionReconciler;
  runtimeManager?: RuntimeManager;
  recoveryCoordinator?: RecoveryCoordinator;
  ownerManager?: OwnerManager;
  mateRecoveryCoordinator?: MateRecoveryCoordinator;
  promptDeliveries?: PromptDeliveryTracker;
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
  awaitInitialPromptCompletion?: boolean;
  // A recovery failure must preserve the task-held worktree for another try.
  retainWorktreeOnFailure?: boolean;
  // Codex recovery: resume this exact thread instead of starting a fresh one.
  // `socketPath` names the daemon socket recorded on the interrupted runtime;
  // when that daemon still answers, the session rebinds to it without a
  // respawn (the daemon holds the live thread state). `runtimeFingerprint` is
  // the codex runtime recorded at launch: a mismatch with the current runtime
  // refuses the rebind and falls through to a fresh respawn+rollout-resume.
  codexOwnedResume?: { threadId: string; socketPath?: string; runtimeFingerprint?: string };
};

export type StartManagedAgentResult = {
  session: AgentSession;
  request: StartAgentRequest;
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

export async function startManagedAgent(
  options: ManagedAgentLauncherOptions,
  input: StartManagedAgentInput
): Promise<StartManagedAgentResult> {
  const request = cloneStartRequest(input.request);
  validateStartAgent(request);
  const isCodexLaunch = launchAgentKind(request.command, request.agent) === "codex";
  let codexOwnedResume = input.codexOwnedResume;
  if (isCodexLaunch) {
    const normalized = normalizeCodexLaunchRequest(request);
    Object.assign(request, normalized.request);
    if (!normalized.request.args) delete request.args;
    if (normalized.resumeThreadId && !codexOwnedResume) {
      codexOwnedResume = { threadId: normalized.resumeThreadId };
    }
  }
  if (isCodexLaunch && !options.codexOwned) {
    throw new Error("codex sessions require the app-server owning adapter");
  }
  if (!isCodexLaunch && !options.adapter.startAgent) {
    throw new Error("PTY agents are not supported by this server");
  }

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

  // Claude's initial kickoff rides the spawn argv as the CLI's positional
  // query (interactive TUI, prompt submitted natively at boot) - never typed
  // into the PTY after launch. Later follow-ups keep the existing delivery.
  const claudeKickoffInArgs = prepareClaudeKickoffArg(request);

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
  const claudeKickoffDelivery =
    claudeKickoffInArgs && request.sessionId && typeof request.initialPrompt === "string"
        ? options.promptDeliveries?.create(
          request.sessionId,
          request.initialPrompt,
          input.initialPromptSource ?? "human",
          { allowLateReceipt: true }
        )
      : undefined;
  if (claudeKickoffDelivery) options.promptDeliveries?.markTyping(claudeKickoffDelivery.id);
  let session: AgentSession | undefined;
  try {
    if (isCodexLaunch && options.codexOwned) {
      // Codex is app-server-owned: the adapter starts (or resumes) the thread
      // itself and returns only after the protocol response carried the
      // authoritative thread id. There is no PTY and no keystroke path.
      session = await options.codexOwned.startOwned(
        request,
        {
          ...(codexOwnedResume ? { resume: codexOwnedResume } : {}),
          ...(input.awaitInitialPromptCompletion ? { deferAttachCommand: true } : {})
        }
      );
    } else {
      session = await options.adapter.startAgent!(request);
    }
    // Startup gates can delay the positional prompt substantially. Bound the
    // uncertainty without resending; this kickoff remains eligible for a
    // later genuine receipt that resolves the warning.
    if (claudeKickoffDelivery) options.promptDeliveries?.markSubmitted(claudeKickoffDelivery.id, 120_000);

    if (request.sessionId && session.id !== request.sessionId) {
      // The adapter refused the pre-minted id: drop the stale id's hook
      // registration so its credentials cannot outlive the launch.
      options.hooks.unregister(request.sessionId);
    }

    if (lease) {
      await options.worktrees.assign(lease.id, session.id);
      session.worktreeId = lease.id;
      // The owned adapter hands out session copies, so the lease must also be
      // recorded on its internal session or later listSessions snapshots
      // would lose the worktree association.
      if (isCodexLaunch) options.codexOwned?.setWorktreeId(session.id, lease.id);
    }

    const codexThreadId = isCodexLaunch ? options.codexOwned?.threadIdOf(session.id) : null;
    const codexSocketPath = isCodexLaunch ? options.codexOwned?.socketPathOf(session.id) : undefined;
    const codexRuntimeFingerprint = isCodexLaunch ? options.codexOwned?.runtimeFingerprint() : undefined;

    if (runtime) {
      options.runtimeManager?.markLive(runtime, session.id, options.adapter.runtimeProcess?.(session.id), {
        ...(request.model ? { model: request.model } : {}),
        ...(lease ? { worktreeId: lease.id, leaseId: lease.id, worktreePath: lease.path } : {}),
        ...(isCodexLaunch
          ? {
              metadata: {
                source: "managed-launch",
                codexDriver: "app-server-owned",
                ...(codexSocketPath ? { appServerSocketPath: codexSocketPath } : {}),
                ...(codexRuntimeFingerprint
                  ? { appServerRuntimeFingerprint: codexRuntimeFingerprint }
                  : {})
              }
            }
          : {})
      });
    }
    if (ownerRuntime) {
      options.ownerManager?.markLive(
        ownerRuntime,
        session.id,
        options.adapter.runtimeProcess?.(session.id),
        isCodexLaunch
          ? {
              metadata: {
                source: "mate-launch",
                codexDriver: "app-server-owned",
                ...(codexSocketPath ? { appServerSocketPath: codexSocketPath } : {}),
                ...(codexRuntimeFingerprint
                  ? { appServerRuntimeFingerprint: codexRuntimeFingerprint }
                  : {})
              }
            }
          : {}
      );
    }

    // The thread id from the thread/start (or thread/resume) RESPONSE is the
    // provider identity - recorded durably at launch, and fed to the recovery
    // coordinators so a held identity expectation resolves without hooks or
    // rollout scanning.
    if (isCodexLaunch && codexThreadId) {
      options.runtimeManager?.recordProviderSession(session.id, "codex", codexThreadId);
      options.ownerManager?.recordProviderSession(session.id, "codex", codexThreadId);
      options.recoveryCoordinator?.observeSessionStart(session.id, "codex", codexThreadId);
      options.mateRecoveryCoordinator?.observeSessionStart(session.id, "codex", codexThreadId);
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
    // the tailer must actively re-resolve to the live fork. This is scoped to
    // `--resume` launches only; fresh sessions do not fork, and app-server-owned
    // Codex sessions use protocol events instead of transcript tailing.
    if (isClaudeResumeLaunch(request)) {
      options.timeline.followClaudeResume(session.id, isAllowedTranscriptPath);
    }

    if (typeof request.initialPrompt === "string" && request.initialPrompt.trim().length > 0) {
      if (input.initialPromptSource) {
        options.timeline.recordSource(session.id, request.initialPrompt, input.initialPromptSource);
      }
      if (isCodexLaunch && options.codexOwned) {
        // Codex: the kickoff is the first acknowledged turn/start against the
        // thread the launch just established - never a PTY write. Task
        // kickoffs journal intent/acceptance durably; other initial prompts
        // ride the gate-aware composer path (which submits over the protocol
        // for owned sessions).
        if (input.taskId && input.initialPromptSource === "agent") {
          await submitCodexKickoff(options, session.id, input.taskId, request.initialPrompt);
        } else if (input.awaitInitialPromptCompletion) {
          await options.codexOwned.submitAcknowledgedTurnAndWait(session.id, request.initialPrompt, {
            clientUserMessageId: `perch:${randomUUID()}`,
            source: input.initialPromptSource ?? "human"
          });
          session = options.codexOwned.revealAttachCommand(session.id);
        } else {
          await options.codexOwned.submitAcknowledgedTurn(session.id, request.initialPrompt, {
            clientUserMessageId: `perch:${randomUUID()}`,
            source: input.initialPromptSource ?? "human"
          });
        }
      } else if (!claudeKickoffInArgs) {
        // Non-Claude, non-Codex agents keep the queued PTY delivery. Claude's
        // kickoff already left in the spawn argv above.
        options.monitor.queueInitialPrompt(session.id, request.initialPrompt);
      }
    }

    // A resumed codex task runtime may hold a kickoff journaled as submitted
    // but never acknowledged (the previous life died in the window between
    // send and response, or between acceptance and persistence). Reconcile it
    // against authoritative thread history - never a blind resend.
    if (isCodexLaunch && codexOwnedResume && input.taskId) {
      void reconcileCodexKickoff(options, session.id, input.taskId);
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
      ...(lease ? { worktreeId: lease.id } : {})
    };
  } catch (error) {
    if (claudeKickoffDelivery) {
      options.promptDeliveries?.markUnknown(
        claudeKickoffDelivery.id,
        `Claude launch failed before kickoff acceptance could be confirmed: ${
          error instanceof Error ? error.message : String(error)
        }; not resent`
      );
    }
    if (runtime) options.runtimeManager?.markLaunchFailed(runtime);
    if (ownerRuntime) options.ownerManager?.markLaunchFailed(ownerRuntime);
    if (session?.id) {
      if (options.codexOwned?.has(session.id)) {
        await options.codexOwned.stopSession(session.id).catch(() => {});
      } else if (options.adapter.stopSession) {
        await options.adapter.stopSession(session.id).catch(() => {});
      }
    }
    if (request.sessionId) {
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
// depends on a SessionStart hook arriving. Resumed, continued, and caller-
// identified sessions keep their provider identity while still receiving a
// pre-minted Perch session id. Mutates request and appends the provider flag
// only for fresh sessions.
function prepareClaudeIdentity(
  request: StartAgentRequest,
  cwd: string
): { agentSessionId: string; transcriptPath: string } | undefined {
  if (launchAgentKind(request.command, request.agent) !== "claude") return undefined;
  const args = request.args ?? [];
  request.sessionId ??= `pty:${randomUUID()}`;
  if (args.includes("--resume") || args.includes("--continue") || args.includes("--session-id")) {
    return undefined;
  }
  const sessionId = request.sessionId;
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

// Hard ceiling for a Claude kickoff delivered as a spawn argument. macOS and
// Linux both bound a single argv entry well above this, but the combined
// argv+env budget (ARG_MAX, and Linux's 128KiB per-string MAX_ARG_STRLEN) is
// finite: a prompt beyond this limit must fail the launch truthfully rather
// than be silently truncated by the OS or the CLI.
export const CLAUDE_KICKOFF_ARG_MAX_BYTES = 120_000;

// Claude's initial kickoff is passed as the CLI's positional query in the
// spawn argv (node-pty spawns argv arrays directly - no shell, so no
// interpolation and multiline/Unicode text survives byte-for-byte). The TUI
// submits it natively at boot; nothing is ever typed into the PTY for the
// initial prompt. Tradeoff, documented deliberately: process argv is readable
// ACROSS users for the life of the session - /proc/<pid>/cmdline is
// world-readable on default Linux, and `ps aux` shows it on macOS - unlike
// transcript files, which are 0600 same-user. On shared machines this widens
// exposure of a sensitive brief relative to the previous typed-prompt path.
// Returns whether the kickoff now rides the argv (and must not be queued).
function prepareClaudeKickoffArg(request: StartAgentRequest): boolean {
  if (launchAgentKind(request.command, request.agent) !== "claude") return false;
  const prompt = request.initialPrompt;
  if (typeof prompt !== "string" || prompt.trim().length === 0) return false;
  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes > CLAUDE_KICKOFF_ARG_MAX_BYTES) {
    throw new Error(
      `claude kickoff prompt is ${bytes} bytes, above the ${CLAUDE_KICKOFF_ARG_MAX_BYTES}-byte spawn-argument limit; shorten the brief (the launch was refused rather than truncating it)`
    );
  }
  request.args = [...(request.args ?? []), prompt];
  return true;
}

// Stable kickoff identity for a dispatched codex task: one id per task, the
// same across restarts, persisted on the ledger before the send. Codex echoes
// it back as the userMessage item's clientId in thread history, which is what
// makes lost-response and restart reconciliation possible without resending.
export function codexKickoffClientMessageId(taskId: string): string {
  return `perch-kickoff:${taskId}`;
}

type CodexKickoffDeps = Pick<ManagedAgentLauncherOptions, "tasks" | "codexOwned">;

// Submit a dispatched task's kickoff as the first acknowledged turn/start.
// Ledger contract: `kickoff_submitted` (intent, durable, BEFORE the send) ->
// `kickoff_accepted` (the provider's turn id, only from a successful
// response or history reconciliation). A rejection parks the task blocked
// with the provider's real error; an unknown outcome parks it blocked
// truthfully as unknown - never a PTY retry, never a blind resend.
export async function submitCodexKickoff(
  deps: CodexKickoffDeps,
  sessionId: string,
  taskId: string,
  kickoff: string
): Promise<void> {
  if (!deps.codexOwned) return;
  const clientUserMessageId = codexKickoffClientMessageId(taskId);
  deps.tasks.recordEvent(taskId, {
    kind: "note",
    source: "system",
    message: "codex kickoff submitted over the app-server protocol; acceptance pending",
    data: { reason: "kickoff_submitted", sessionId, clientUserMessageId }
  });
  try {
    const { turnId } = await deps.codexOwned.submitAcknowledgedTurn(sessionId, kickoff, {
      clientUserMessageId,
      source: "agent"
    });
    recordKickoffAccepted(deps, taskId, sessionId, clientUserMessageId, turnId);
    markTaskWorkingFromActivity(deps, sessionId, { newTurn: true });
  } catch (error) {
    recordKickoffFailure(deps, taskId, sessionId, error);
  }
}

// Resolve a kickoff journaled as submitted but never acknowledged, after a
// recovery resume: authoritative thread history decides. Present -> record
// acceptance; verifiably absent -> the one history-verified resubmission;
// unreadable -> blocked as unknown. This is the restart boundary guarantee:
// a crash between provider acceptance and local persistence can never
// duplicate the kickoff, because the resubmit only happens when history
// proves the first send never landed.
export async function reconcileCodexKickoff(
  deps: CodexKickoffDeps,
  sessionId: string,
  taskId: string
): Promise<void> {
  if (!deps.codexOwned) return;
  const events = deps.tasks.events(taskId);
  const submitted = events.some((event) => event.data?.reason === "kickoff_submitted");
  const accepted = events.some((event) => event.data?.reason === "kickoff_accepted");
  if (!submitted || accepted) return;
  const clientUserMessageId = codexKickoffClientMessageId(taskId);
  let landedTurnId: string | null | undefined;
  try {
    const landed = await deps.codexOwned.findAcceptedTurn(sessionId, clientUserMessageId);
    landedTurnId = landed ? (landed.id ?? null) : undefined;
  } catch (error) {
    recordKickoffFailure(deps, taskId, sessionId, new CodexDeliveryUnknownError(
      `kickoff acceptance is unknown after restart: thread history could not be read (${
        error instanceof Error ? error.message : error
      }); not resent`
    ));
    return;
  }
  if (landedTurnId !== undefined) {
    recordKickoffAccepted(deps, taskId, sessionId, clientUserMessageId, landedTurnId, true);
    return;
  }
  const operation = deps.tasks.stateDb.operations.latestForTask(taskId, "dispatch");
  const kickoff = (operation?.payload as { prepared?: { request?: StartAgentRequest } } | undefined)
    ?.prepared?.request?.initialPrompt;
  if (typeof kickoff !== "string" || kickoff.trim().length === 0) {
    recordKickoffFailure(deps, taskId, sessionId, new CodexDeliveryUnknownError(
      "kickoff acceptance is unknown after restart: history shows no accepted kickoff and the dispatch record no longer carries the original prompt; not resent"
    ));
    return;
  }
  try {
    const { turnId } = await deps.codexOwned.submitAcknowledgedTurn(sessionId, kickoff, {
      clientUserMessageId,
      source: "agent"
    });
    recordKickoffAccepted(deps, taskId, sessionId, clientUserMessageId, turnId);
    markTaskWorkingFromActivity(deps, sessionId, { newTurn: true });
  } catch (error) {
    recordKickoffFailure(deps, taskId, sessionId, error);
  }
}

function recordKickoffAccepted(
  deps: CodexKickoffDeps,
  taskId: string,
  sessionId: string,
  clientUserMessageId: string,
  turnId: string | null,
  reconciled = false
): void {
  try {
    deps.tasks.recordEvent(taskId, {
      kind: "note",
      source: "system",
      message: reconciled
        ? "codex kickoff confirmed accepted from thread history after reconnect"
        : "codex accepted the kickoff turn",
      data: {
        reason: "kickoff_accepted",
        sessionId,
        clientUserMessageId,
        ...(turnId ? { turnId } : {}),
        ...(reconciled ? { reconciled: true } : {})
      }
    });
  } catch {
    // Ledger bookkeeping must never disturb the session.
  }
}

function recordKickoffFailure(deps: CodexKickoffDeps, taskId: string, sessionId: string, error: unknown): void {
  const task = deps.tasks.find(taskId);
  // A task already parked (needs_you, blocked, failed) owns its truthful
  // outcome; only a still-silent queued/working task is parked here.
  if (!task || (task.state !== "queued" && task.state !== "working")) return;
  const message = error instanceof Error ? error.message : String(error);
  try {
    if (isCodexRpcError(error)) {
      deps.tasks.recordEvent(taskId, {
        kind: "blocked",
        source: "system",
        message: `codex rejected the kickoff turn: ${message}`,
        data: { reason: "kickoff_rejected", sessionId, code: error.code }
      });
    } else if (error instanceof CodexDeliveryUnknownError) {
      deps.tasks.recordEvent(taskId, {
        kind: "blocked",
        source: "system",
        message: `codex kickoff acceptance is unknown: ${message}`,
        data: { reason: "kickoff_unknown", sessionId }
      });
    } else {
      deps.tasks.recordEvent(taskId, {
        kind: "blocked",
        source: "system",
        message: `codex kickoff failed: ${message}`,
        data: { reason: "kickoff_failed", sessionId }
      });
    }
  } catch {
    // Ledger bookkeeping must never disturb the session.
  }
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

function taskForSession(options: { tasks: TaskStore }, sessionId: string) {
  return options.tasks.list().find((task) => task.sessionId === sessionId);
}

// The monitor/task surface the codex server-request projection needs; the
// index wiring calls these outside the launcher, so they must not demand the
// full launcher option bag.
export type CodexServerRequestSink = {
  monitor: Pick<FleetMonitor, "setPendingServerRequest" | "resolveServerRequest" | "pendingServerRequest">;
  tasks: TaskStore;
};

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

export function surfaceCodexServerRequest(
  options: CodexServerRequestSink,
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

export function resolveCodexServerRequest(
  options: CodexServerRequestSink,
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
