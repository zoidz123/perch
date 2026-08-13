import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join as joinPath, resolve as resolvePath } from "node:path";
import { WebSocketServer } from "ws";
import type {
  AgentEvent,
  AgentKind,
  AnswerRequest,
  ApproveRequest,
  AttachmentResponse,
  CodexReasoningEffort,
  ConfigEntry,
  ConfigResponse,
  CompletionDecisionRequest,
  CompletionDecisionResponse,
  CreateDeviceResponse,
  CreateTaskRequest,
  DevicesResponse,
  DispatchDefaults,
  HealthResponse,
  InputRequest,
  LogsResponse,
  MateLaunchResolution,
  MateDefaults,
  ModelsResponse,
  ModelSwitchRequest,
  ModelSwitchResponse,
  StartAgentRequest,
  StartAgentResponse,
  ServerRequestResponse,
  SubmitResponse,
  Task,
  TaskDetailResponse,
  TaskEventKind,
  TaskEventRequest,
  TaskPr,
  MateMailboxMessage,
  WorkerReportRequest,
  TasksResponse,
  UsageResponse,
  WebSocketRpcRequest,
  WebSocketRpcResponse
} from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import type { AuditLog } from "./audit.js";
import type { ClientAuth, FleetMonitor } from "./fleetMonitor.js";
import {
  PERCH_SESSION_NOTE,
  hookEventName,
  isAllowedTranscriptPath,
  normalizeHookEvent,
  type HookEventPayload,
  type HookRegistry
} from "./hooks.js";
import { usageLimitFromClaudeHook } from "./usageLimitDetect.js";
import { isVerifiedPrelaunchDispatchFailure } from "./dispatchFailures.js";
import { ASK_USER_QUESTION_TOOL, KEY_DELAY_MS, questionKeystrokes } from "./askQuestion.js";
import { buildOffer, tokensEqual, type DeviceRegistry } from "./pairing.js";
import { EncryptedServerChannel } from "./e2ee/channel.js";
import { collectDoctor, type DoctorDeps } from "./deps.js";
import type { Project, ProjectRegistry } from "./projects.js";
import { suggestDirectories } from "./fsSuggest.js";
import { dispatchBrief } from "./brief.js";
import { extractPrUrl, type PrPoller } from "./prPoller.js";
import { AutoReviewService, freezeReviewTarget } from "./autoreview.js";
import { DeliveryService, receiptMatchesCurrentTarget } from "./delivery.js";
import type { StateMetrics } from "./stateMetrics.js";
import type { TaskStore } from "./tasks.js";
import type { TaskCompletionReconciler } from "./taskCompletion.js";
import {
  executeTeardown,
  landedGate,
  ownLeaseFor,
  type LandedVerdict
} from "./teardown.js";
import type { TimelineStore } from "./timeline.js";
import type { WorktreePool } from "./worktrees.js";
import { storeAttachment } from "./attachments.js";
import { CODEX_MATE_BOOTSTRAP_PROMPT, seedMateHome } from "./mate.js";
import { isProviderPrefixedModelId, modelSwitchSteps } from "./modelSwitch.js";
import { collectUsage } from "./usage.js";
import { listCodexModelsOnce } from "./adapters/codexAppServer.js";
import {
  collectCliModelRegistry,
  collectModelRegistry,
  collectModels,
  DISPATCH_CODEX_FALLBACK,
  listClaudeModels,
  MATE_CLAUDE_FALLBACK_MODEL,
  MATE_CODEX_FALLBACK,
  modelAgentsForIdentifier,
  resolveMateLaunch,
  resolveSessionModel,
  supportedEffortsForModel
} from "./models.js";
import type {
  CodexEffortResolver,
  DispatchDefaultsUpdate,
  FleetSettings,
  ModelAgentResolver,
  MateDefaultsUpdate
} from "./settings.js";
import type { CodexAppServerAdapter } from "./adapters/codexAppServerAdapter.js";
import {
  canonicalRepository,
  canonicalRepositoryForPath,
  markTaskWorkingFromActivity,
  startManagedAgent
} from "./agentLauncher.js";
import type { MateMailboxDeliveryRecord, OperationRecord } from "./stateDb.js";
import type { OperationExecutionContext, TaskScheduler } from "./taskScheduler.js";
import type { RuntimeManager } from "./runtimeManager.js";
import {
  isCodexMissingRolloutResumeError,
  isProvenLegacyChildDisabled,
  RecoveryCoordinator
} from "./recovery.js";
import { RecoveryContinuationCoordinator } from "./recoveryContinuation.js";
import type { OwnerManager } from "./ownerManager.js";
import { MateRecoveryCoordinator } from "./mateRecovery.js";
import { PERCH_VERSION } from "./version.js";
import {
  CLAUDE_APPROVAL_DECISIONS,
  ClaudeApprovalCoordinator,
  publicRecord,
  type ClaudeApprovalDecision
} from "./claudeApprovals.js";
import { ClaudeQuestionCoordinator, publicQuestion } from "./claudeQuestions.js";
import { ClaudeInteractionCoordinator, publicInteraction } from "./claudeInteractions.js";
import type { PromptDeliveryTracker } from "./promptDeliveries.js";
import { CodexHistorySyncCoordinator } from "./codexHistorySync.js";

export { markTaskWorkingFromActivity } from "./agentLauncher.js";

export type HttpServerOptions = {
  adapter: AgentAdapter;
  auditLog: AuditLog;
  authToken: string;
  // The server's long-term box secret key, used to derive the per-connection
  // shared key for the encrypted WS channel (the ?e2ee=1 transport).
  boxSecretKey: Uint8Array;
  monitor: FleetMonitor;
  devices: DeviceRegistry;
  port: number;
  // Resolved relay origin (config.relayUrl) advertised in the pairing offer, so
  // the offer matches the relay the server actually dials. Undefined = LAN-only.
  relayUrl?: string;
  hooks: HookRegistry;
  timeline: TimelineStore;
  projects: ProjectRegistry;
  worktrees: WorktreePool;
  tasks: TaskStore;
  prPoller: PrPoller;
  // Claude's state file (.claude.json) for pre-launch worktree trust seeding
  // (see agentLauncher). The entrypoint wires the real path; absent in test
  // fixtures means the launcher never seeds.
  claudeStateFile?: string;
  // Codex `--remote` control plane. Absent (or with no acquirable daemon) means
  // every Codex session runs on the plain PTY path and the model chip is off.
  // The app-server owning adapter: the only Codex driver. Model switching,
  // structured server-request answers, and the hook turn-boundary guard all
  // route through it.
  codexOwned?: CodexAppServerAdapter;
  // Launch-time hook reinstaller (see ManagedAgentLauncherOptions.installHooks).
  // Wired to the real installers by the entrypoint; absent in test fixtures so
  // tests never rewrite real provider config.
  installHooks?: (agent: AgentKind) => void;
  taskCompletion?: TaskCompletionReconciler;
  // State-machine measurements (G6), served at GET /doctor/state-metrics.
  metrics?: StateMetrics;
  // Environment-doctor injection (PATH source); absent in production.
  doctorDeps?: Pick<DoctorDeps, "env">;
  // Fleet-level user settings (dispatch defaults, `perch config`). Optional so
  // existing tests keep working; absent means no defaults are ever applied.
  settings?: FleetSettings;
  // Injected by tests for the built-in crew fallback. Production probes PATH.
  codexOnPath?: () => boolean;
  // Injected by tests. Production uses the same live registry as GET /models.
  modelRegistry?: () => Promise<ModelsResponse>;
  // Injected by transport tests so direct HTTP and relay RPC exercise the
  // same endpoint without reading real provider credentials.
  usageCollector?: () => Promise<UsageResponse>;
  taskScheduler?: TaskScheduler;
  runtimeManager?: RuntimeManager;
  recoveryCoordinator?: RecoveryCoordinator;
  recoveryContinuationCoordinator?: RecoveryContinuationCoordinator;
  ownerManager?: OwnerManager;
  mateRecoveryCoordinator?: MateRecoveryCoordinator;
  codexHistorySync?: CodexHistorySyncCoordinator;
  claudeApprovals?: ClaudeApprovalCoordinator;
  claudeQuestions?: ClaudeQuestionCoordinator;
  claudeInteractions?: ClaudeInteractionCoordinator;
  promptDeliveries?: PromptDeliveryTracker;
};

const CODEX_ON_PATH_TTL_MS = 30_000;
let codexOnPathCache: { value: boolean; at: number } | undefined;

function codexResolvableOnPath(): boolean {
  const now = Date.now();
  if (codexOnPathCache && now - codexOnPathCache.at < CODEX_ON_PATH_TTL_MS) {
    return codexOnPathCache.value;
  }
  let value = false;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      const candidate = joinPath(dir, "codex");
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      value = true;
      break;
    } catch {
      // Keep scanning PATH.
    }
  }
  codexOnPathCache = { value, at: now };
  return value;
}

export function createControlServer(options: HttpServerOptions) {
  options.monitor.setPendingSessionInputs(options.tasks.stateDb.pendingSessionInputs);
  options.claudeApprovals ??= new ClaudeApprovalCoordinator(options.tasks, options.monitor, {
    deadlineMs: process.env.PERCH_CLAUDE_APPROVAL_DEADLINE_MS
      ? Number(process.env.PERCH_CLAUDE_APPROVAL_DEADLINE_MS)
      : undefined
  });
  options.claudeApprovals.replay();
  options.claudeQuestions ??= new ClaudeQuestionCoordinator(options.tasks, options.monitor, {
    deadlineMs: process.env.PERCH_CLAUDE_QUESTION_DEADLINE_MS
      ? Number(process.env.PERCH_CLAUDE_QUESTION_DEADLINE_MS)
      : undefined
  });
  options.claudeQuestions.replay();
  options.claudeInteractions ??= new ClaudeInteractionCoordinator(options.tasks, options.monitor, {
    deadlineMs: Number(process.env.PERCH_CLAUDE_INTERACTION_DEADLINE_MS)
  });
  options.claudeInteractions.replay();
  const inboxSequence = options.tasks.stateDb.claudeInbox.sequence();
  options.tasks.stateDb.claudeInbox.prune(Math.max(0, inboxSequence - 10_000));
  options.monitor.setClaudeManualGateHandler((sessionId, approval) => {
    options.claudeInteractions!.recordManualGate(sessionId, approval.summary, approval.id);
  });
  if (!options.codexHistorySync && options.codexOwned) {
    options.codexHistorySync = new CodexHistorySyncCoordinator(options.tasks.stateDb, options.codexOwned);
  }
  options.recoveryCoordinator ??= new RecoveryCoordinator(options);
  options.recoveryContinuationCoordinator ??= new RecoveryContinuationCoordinator(options);
  if (!options.mateRecoveryCoordinator && options.ownerManager && options.taskScheduler) {
    const mateRecoveryOptions: HttpServerOptions & ConstructorParameters<typeof MateRecoveryCoordinator>[0] = {
      ...options,
      ownerManager: options.ownerManager,
      taskScheduler: options.taskScheduler
    };
    const mateRecoveryCoordinator = new MateRecoveryCoordinator(mateRecoveryOptions);
    options.mateRecoveryCoordinator = mateRecoveryCoordinator;
    mateRecoveryOptions.mateRecoveryCoordinator = mateRecoveryCoordinator;
  }
  options.monitor.setRpcHandler((rpc, auth) => handleWebSocketRpcRequest(rpc, auth, options));
  options.monitor.setSessionModelFallback((session) => sessionModelFallback(session, options));
  options.monitor.setStartAgentLauncher((input) => startManagedAgent(options, input));
  options.taskScheduler?.setExecutor((operation, context) => executeOperation(options, operation, context));

  const server = createServer((request, response) => {
    void route(request, response, options);
  });

  const wsServer = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = getRequestUrl(request);
    const sessionId = url.searchParams.get("sessionId") ?? undefined;

    // Encrypted transport (?e2ee=1): the device token is carried inside the
    // ciphertext, so the upgrade itself is unauthenticated. Authorization moves
    // to the E2E boundary (channel.awaitAuth). The legacy ?token= path below is
    // untouched, keeping the wire append-only.
    if (url.searchParams.get("e2ee") === "1") {
      wsServer.handleUpgrade(request, socket, head, (webSocket) => {
        const channel = new EncryptedServerChannel(
          webSocket,
          options.boxSecretKey,
          (token) => tokenToAuth(token, options)
        );
        channel
          .awaitAuth()
          .then((auth) => options.monitor.addClient(channel, sessionId, auth))
          .catch(() => {
            // Auth failed or the socket closed mid-handshake; the channel has
            // already closed the underlying socket. Nothing to add.
          });
      });
      return;
    }

    const auth = authenticate(request, options);
    if (!auth) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wsServer.handleUpgrade(request, socket, head, (webSocket) => {
      options.monitor.addClient(webSocket, sessionId, auth);
    });
  });

  return server;
}

function sessionModelFallback(
  session: { id: string; agent?: AgentKind; labels?: Record<string, string>; model?: string | null; modelLabel?: string | null; effort?: CodexReasoningEffort | null },
  options: HttpServerOptions
) {
  if (session.labels?.role !== "mate") {
    return undefined;
  }
  if (session.agent === "codex") {
    const defaults = options.settings?.mateDefaults() ?? {};
    const owner = options.ownerManager?.snapshot();
    const durableModel =
      owner?.provider === "codex" && owner.ptySessionId === session.id ? owner.model : undefined;
    const resolved = resolveMateLaunch(
      {
        agent: "codex",
        model: durableModel ?? (defaults.agent === "codex" ? defaults.model?.trim() : undefined),
        effort: defaults.agent === "codex" ? defaults.effort : MATE_CODEX_FALLBACK.effort
      },
      collectModels()
    );
    return resolveSessionModel("codex", { model: resolved.model, effort: resolved.effort });
  }
  if (session.agent === "claude") {
    const defaults = options.settings?.mateDefaults() ?? {};
    const model = defaults.agent === "claude" ? defaults.model : MATE_CLAUDE_FALLBACK_MODEL;
    return resolveSessionModel("claude", { model });
  }
  return undefined;
}

async function loadModelRegistry(options: HttpServerOptions): Promise<ModelsResponse | undefined> {
  try {
    return options.modelRegistry
      ? await options.modelRegistry()
      : await collectModelRegistry({ listCodexModels: listCodexModelsOnce });
  } catch {
    return undefined;
  }
}

// A per-model effort validator built from the live model registry, so PATCH
// /config rejects an effort the selected codex model does not support (e.g.
// `ultra` on gpt-5.5) while accepting the full per-model set (max/ultra for
// gpt-5.6). GET /models stays the single source of effort truth.
async function modelConfigResolvers(options: HttpServerOptions): Promise<{
  efforts: CodexEffortResolver;
  agents: ModelAgentResolver;
}> {
  const registry = await loadModelRegistry(options);
  return {
    efforts: (model) => supportedEffortsForModel(registry, "codex", model),
    agents: (model) => modelAgentsForIdentifier(registry, model)
  };
}

async function resolveMateLaunchNow(
  input: { agent: AgentKind; model?: string; effort?: CodexReasoningEffort },
  options: HttpServerOptions
): Promise<MateLaunchResolution> {
  const registry = await loadModelRegistry(options);
  return resolveMateLaunch(input, registry);
}

async function resolveAutomaticDispatchDefaults(options: HttpServerOptions): Promise<DispatchDefaults> {
  const registry = await loadModelRegistry(options);
  const crew = registry?.providers
    .find((provider) => provider.provider === "codex")
    ?.roleDefaults?.crew;
  return crew
    ? { agent: "codex", model: crew.model, ...(crew.effort ? { effort: crew.effort } : {}) }
    : DISPATCH_CODEX_FALLBACK;
}

async function buildConfigResponse(
  options: HttpServerOptions,
  layers: { dispatchDefaults: DispatchDefaults; mateDefaults: MateDefaults },
  projectPath?: string,
  includeEntries = false
): Promise<ConfigResponse> {
  const agent = layers.mateDefaults.agent ?? "claude";
  const mateResolved = await resolveMateLaunchNow(
    { agent, model: layers.mateDefaults.model, effort: layers.mateDefaults.effort },
    options
  );
  const dispatchResolved = !layers.dispatchDefaults.agent && (options.codexOnPath ?? codexResolvableOnPath)()
    ? await resolveAutomaticDispatchDefaults(options)
    : undefined;
  const response: ConfigResponse = { ...layers, ...(dispatchResolved ? { dispatchResolved } : {}), mateResolved };
  if (!includeEntries) return response;
  const stored = options.settings?.stored() ?? {};
  const environment = options.settings?.environmentOverrides() ?? {};
  const entries: Record<string, ConfigEntry> = {};
  const globalLayers = [
    ["dispatch", "dispatchDefaults", response.dispatchDefaults, dispatchResolved, stored.dispatchDefaults, environment.dispatchDefaults],
    ["mate", "mateDefaults", response.mateDefaults, mateResolved, stored.mateDefaults, environment.mateDefaults]
  ] as const;
  for (const [prefix, _layer, effective, fallback, persisted, env] of globalLayers) {
    for (const field of ["agent", "model", "effort"] as const) {
      const envValue = env?.[field] ?? null;
      const storedValue = persisted?.[field] ?? null;
      const effectiveValue = effective?.[field] ?? fallback?.[field] ?? null;
      entries[`${prefix}.${field}`] = {
        effectiveValue,
        source: envValue !== null
          ? "environment"
          : storedValue !== null
            ? "global"
            : prefix === "dispatch" && fallback?.[field] !== undefined
              ? "automatic"
              : "built-in",
        scope: "global",
        storedValue,
        defaultValue: field === "agent" ? (prefix === "dispatch" ? "auto" : "claude") : null,
        overriddenBy: envValue !== null && storedValue !== null
          ? `PERCH_${prefix === "dispatch" ? "DEFAULT" : "MATE"}_${field.toUpperCase()}`
          : null
      };
    }
  }
  response.entries = entries;
  return response;
}

function strictConfigPatch(body: Record<string, unknown>): {
  dispatchDefaults?: DispatchDefaultsUpdate;
  mateDefaults?: MateDefaultsUpdate;
} {
  const layers = new Set(["dispatchDefaults", "mateDefaults"]);
  const unknownLayer = Object.keys(body).find((key) => !layers.has(key));
  if (unknownLayer) throw new Error(`unknown config layer: ${unknownLayer}`);
  if (!Object.keys(body).length) throw new Error("dispatchDefaults or mateDefaults required");
  const result: { dispatchDefaults?: DispatchDefaultsUpdate; mateDefaults?: MateDefaultsUpdate } = {};
  for (const layer of layers) {
    const value = body[layer];
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${layer} must be an object`);
    const record = value as Record<string, unknown>;
    const unknownKey = Object.keys(record).find((key) => !new Set(["agent", "model", "effort"]).has(key));
    if (unknownKey) throw new Error(`unknown ${layer} key: ${unknownKey}`);
    for (const [key, field] of Object.entries(record)) {
      if (field !== null && typeof field !== "string") throw new Error(`${layer}.${key} must be a string or null`);
    }
    result[layer as "dispatchDefaults" | "mateDefaults"] = record as DispatchDefaultsUpdate;
  }
  return result;
}

type RpcResult = { status: number; body: unknown };

function taskListResponse(url: URL, tasks: TaskStore): TasksResponse {
  const includeClosed = url.searchParams.get("includeClosed") === "1";
  const listed = tasks.list();
  if (includeClosed) {
    return { tasks: listed };
  }
  return {
    tasks: listed
      .filter((task) => task.state !== "closed")
      .map(({ prompt: _prompt, ...task }) => task)
  };
}

// POST /mate/start body. Every field is optional and overrides the fleet's
// configured mate default for this launch; the app posts `{}` and gets the
// mate the boss configured with `mate.*` via `perch config`.
type MateStartRequest = {
  agent?: MateDefaults["agent"];
  model?: string;
  effort?: MateDefaults["effort"];
  new?: boolean;
  args?: string[];
};

// Explicit project registration (POST /projects): must name a real directory
// on this Mac, so a typo'd or stale path never lands in the registry.
async function registerProject(
  body: Record<string, unknown>,
  options: HttpServerOptions,
  auditMeta: Pick<Parameters<AuditLog["write"]>[0], "deviceId" | "remoteAddress">
): Promise<RpcResult> {
  if (body.mode !== undefined) {
    return rpcError(409, "project delivery modes are legacy-only; choose ship, scout, or operate when creating a task");
  }
  const allowedKeys = new Set(["rootPath", "name"]);
  const unknown = Object.keys(body).find((key) => !allowedKeys.has(key));
  if (unknown) return rpcError(400, `unknown project config key: ${unknown}`);
  if (typeof body.rootPath !== "string" || body.rootPath.trim().length === 0) {
    return rpcError(400, "rootPath required");
  }
  const root = resolvePath(body.rootPath);
  let isDirectory = false;
  try {
    isDirectory = statSync(root).isDirectory();
  } catch {
    // Nonexistent path: rejected below.
  }
  if (!isDirectory) {
    return rpcError(400, `Not a directory on this Mac: ${root}`);
  }
  const fields = typeof body.name === "string" && body.name ? { name: body.name } : {};
  const project = options.projects.touch(root, fields);
  return rpcOk(200, { project });
}

async function configureProject(
  body: Record<string, unknown>,
  options: HttpServerOptions,
  auditMeta: Pick<Parameters<AuditLog["write"]>[0], "deviceId" | "remoteAddress">
): Promise<RpcResult> {
  if (body.mode !== undefined) {
    return rpcError(409, "project delivery modes are legacy-only; choose ship, scout, or operate when creating a task");
  }
  const allowedKeys = new Set(["rootPath"]);
  const unknown = Object.keys(body).find((key) => !allowedKeys.has(key));
  if (unknown) return rpcError(400, `unknown project config key: ${unknown}`);
  if (typeof body.rootPath !== "string" || body.rootPath.trim().length === 0) {
    return rpcError(400, "rootPath required");
  }
  const root = resolvePath(body.rootPath);
  try {
    if (!statSync(root).isDirectory()) return rpcError(400, `Not a directory on this Mac: ${root}`);
  } catch {
    return rpcError(400, `Not a directory on this Mac: ${root}`);
  }
  return rpcError(410, "project delivery modes were removed; choose ship, scout, or operate when creating a task");
}

// Unregister a project (DELETE /projects). Refused while any non-closed task
// still references the path - removal protects active work, and it only
// forgets the registry entry; the repo on disk is untouched.
function unregisterProject(rootPath: unknown, options: HttpServerOptions): RpcResult {
  if (typeof rootPath !== "string" || rootPath.trim().length === 0) {
    return rpcError(400, "rootPath required");
  }
  const root = resolvePath(rootPath);
  const project = options.projects.find(root);
  if (!project) {
    return rpcError(404, `Unknown project: ${root}`);
  }
  const live = options.tasks
    .list()
    .filter((task) => task.state !== "closed" && resolvePath(task.project) === root);
  if (live.length > 0) {
    const titles = live.slice(0, 3).map((task) => `"${task.title}"`).join(", ");
    const suffix = live.length > 3 ? ` and ${live.length - 3} more` : "";
    const count = live.length === 1 ? "a live task" : `${live.length} live tasks`;
    const closer = live.length === 1 ? "it" : "them";
    return rpcError(409, `${project.name} still has ${count}: ${titles}${suffix}. Close or tear ${closer} down first.`);
  }
  options.projects.remove(root);
  return rpcOk(200, { ok: true });
}

export async function handleWebSocketRpcRequest(
  request: WebSocketRpcRequest,
  auth: ClientAuth,
  options: HttpServerOptions
): Promise<WebSocketRpcResponse> {
  const id = request.id;
  try {
    const result = await dispatchWebSocketRpc(request, auth, options);
    if (result.status >= 400) {
      return {
        type: "rpc_response",
        id,
        status: result.status,
        ok: false,
        error: errorFromBody(result.body)
      };
    }
    return { type: "rpc_response", id, status: result.status, ok: true, body: result.body };
  } catch (error) {
    return {
      type: "rpc_response",
      id,
      status: 500,
      ok: false,
      error: error instanceof Error ? error.message : "Internal server error"
    };
  }
}

async function dispatchWebSocketRpc(
  request: WebSocketRpcRequest,
  auth: ClientAuth,
  options: HttpServerOptions
): Promise<RpcResult> {
  if (request.method !== "GET" && request.method !== "POST" && request.method !== "PATCH" && request.method !== "DELETE") {
    return rpcError(400, "Unsupported method");
  }
  if (typeof request.path !== "string" || !request.path.startsWith("/")) {
    return rpcError(400, "path must be absolute");
  }

  const url = new URL(request.path, "http://localhost");
  const pathname = url.pathname;
  const method = request.method;
  const body = rpcBody<Record<string, unknown>>(request);
  const auditPeer = auditPeerFor(auth);

  if (method === "GET" && pathname === "/sessions") {
    return rpcOk(200, { sessions: options.monitor.withLiveState(await options.adapter.listSessions()) });
  }

  if (method === "GET" && pathname === "/claude-approvals") {
    return rpcOk(200, { requests: options.claudeApprovals!.list().map(publicRecord) });
  }
  if (method === "GET" && pathname === "/claude-questions") {
    return rpcOk(200, { requests: options.claudeQuestions!.list().map(publicQuestion) });
  }
  if (method === "GET" && pathname === "/claude-interactions") {
    return rpcOk(200, { requests: options.claudeInteractions!.list().map(publicInteraction) });
  }
  if (method === "GET" && pathname === "/claude-inbox") {
    const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
    return rpcOk(200, claudeInboxSnapshot(options, after));
  }

  const timelineMatch = pathname.match(/^\/sessions\/([^/]+)\/timeline$/);
  if (method === "GET" && timelineMatch) {
    const sessionId = decodeURIComponent(timelineMatch[1] ?? "");
    const canonicalSessionId = canonicalSessionIdFor(options.adapter, sessionId);
    const after = Number(url.searchParams.get("after") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 200);
    return rpcOk(200, options.timeline.fetch(canonicalSessionId, after, limit));
  }

  const logsMatch = pathname.match(/^\/sessions\/([^/]+)\/logs$/);
  if (method === "GET" && logsMatch) {
    const sessionId = decodeURIComponent(logsMatch[1] ?? "");
    const canonicalSessionId = canonicalSessionIdFor(options.adapter, sessionId);
    const lines = Number(url.searchParams.get("lines") ?? 120);
    const result = await options.adapter.readRecentEvents(sessionId, lines);
    const responseBody = {
      events: result.events.map((event) => withCanonicalSessionId(event, canonicalSessionId)),
      terminal: result.terminal,
      note: result.note
    };
    return rpcOk(200, responseBody);
  }

  if (method === "GET" && pathname === "/projects") {
    return rpcOk(200, { projects: options.projects.list() });
  }

  if (method === "POST" && pathname === "/projects") {
    const result = await registerProject(body, options, auditPeer);
    if (result.status === 200) {
      await audit(options.auditLog, { action: "add_project", ...auditPeer, cwd: resolvePath(String(body.rootPath)) });
    }
    return result;
  }

  if (method === "PATCH" && pathname === "/projects") {
    const result = await configureProject(body, options, auditPeer);
    if (result.status === 200) await audit(options.auditLog, { action: "set_config", ...auditPeer });
    return result;
  }

  if (method === "DELETE" && pathname === "/projects") {
    const rootPath = body.rootPath ?? url.searchParams.get("rootPath") ?? undefined;
    const result = unregisterProject(rootPath, options);
    if (result.status === 200) {
      await audit(options.auditLog, { action: "remove_project", ...auditPeer, cwd: resolvePath(String(rootPath)) });
    }
    return result;
  }

  if (method === "GET" && pathname === "/fs/suggest") {
    return rpcOk(200, { paths: suggestDirectories(url.searchParams.get("q") ?? "") });
  }

  if (method === "GET" && pathname === "/usage") {
    return rpcOk(200, await (options.usageCollector?.() ?? collectUsage()));
  }

  if (method === "GET" && pathname === "/models") {
    const registry = url.searchParams.get("claude") === "bundled"
      ? await collectCliModelRegistry({ listCodexModels: listCodexModelsOnce })
      : await collectModelRegistry({ listCodexModels: listCodexModelsOnce, listClaudeModels });
    return rpcOk(200, registry);
  }

  if (method === "GET" && pathname === "/config") {
    const responseBody = await buildConfigResponse(options, {
      dispatchDefaults: options.settings?.dispatchDefaults() ?? {},
      mateDefaults: options.settings?.mateDefaults() ?? {}
    }, url.searchParams.get("project") ?? undefined, url.searchParams.get("effective") === "1");
    return rpcOk(200, responseBody);
  }

  if (method === "PATCH" && pathname === "/config") {
    if (!options.settings) {
      return rpcError(501, "settings are not supported by this server");
    }
    try {
      const update = strictConfigPatch(body);
      const resolvers = await modelConfigResolvers(options);
      const responseBody = await buildConfigResponse(options, {
        dispatchDefaults: update.dispatchDefaults === undefined
          ? options.settings.dispatchDefaults()
          : options.settings.updateDispatchDefaults(update.dispatchDefaults, resolvers.efforts, resolvers.agents),
        mateDefaults: update.mateDefaults === undefined
          ? options.settings.mateDefaults()
          : options.settings.updateMateDefaults(update.mateDefaults, resolvers.efforts, resolvers.agents)
      });
      await audit(options.auditLog, { action: "set_config", ...auditPeer });
      return rpcOk(200, responseBody);
    } catch (error) {
      return rpcError(400, error instanceof Error ? error.message : String(error));
    }
  }

  if (method === "GET" && pathname === "/tasks") {
    return rpcOk(200, taskListResponse(url, options.tasks));
  }

  if (method === "POST" && pathname === "/tasks") {
    return createTaskRpc(body as CreateTaskRequest, options, auditPeer);
  }

  const taskMatch = pathname.match(/^\/tasks\/([^/]+)$/);
  if (method === "GET" && taskMatch) {
    const taskId = decodeURIComponent(taskMatch[1] ?? "");
    const task = options.tasks.find(taskId);
    if (!task) return rpcError(404, `Unknown task: ${taskId}`);
    const responseBody: TaskDetailResponse = { task, events: options.tasks.events(taskId) };
    return rpcOk(200, responseBody);
  }

  const teardownMatch = pathname.match(/^\/tasks\/([^/]+)\/teardown$/);
  if (method === "POST" && teardownMatch) {
    return teardownTaskRpc(decodeURIComponent(teardownMatch[1] ?? ""), body, options);
  }

  const recoverMatch = pathname.match(/^\/tasks\/([^/]+)\/recover$/);
  if (method === "POST" && recoverMatch) {
    return recoverTaskRpc(decodeURIComponent(recoverMatch[1] ?? ""), body, options, auditPeer);
  }

  const completionMatch = pathname.match(/^\/tasks\/([^/]+)\/completion$/);
  if (method === "POST" && completionMatch) {
    if (auth.kind !== "server") {
      return rpcError(403, "Completion verification requires the mate server token");
    }
    return completionDecisionRpc(
      decodeURIComponent(completionMatch[1] ?? ""),
      body as CompletionDecisionRequest,
      options,
      auditPeer
    );
  }

  const worktreeReleaseMatch = pathname.match(/^\/worktrees\/(.+)\/release$/);
  if (method === "POST" && worktreeReleaseMatch) {
    return releaseWorktreeRpc(decodeURIComponent(worktreeReleaseMatch[1] ?? ""), body, options, auditPeer);
  }

  if (method === "POST" && pathname === "/devices/push-token") {
    if (auth.kind !== "device") {
      return rpcError(403, "Only paired devices register push tokens");
    }
    if (typeof body.pushToken !== "string" || body.pushToken.length === 0 || body.pushToken.length > 200) {
      return rpcError(400, "pushToken required");
    }
    const saved = options.devices.setPushToken(auth.deviceId, body.pushToken);
    return saved ? rpcOk(200, { ok: true }) : rpcError(404, "Unknown device");
  }

  if (pathname === "/devices" || pathname.startsWith("/devices/")) {
    if (auth.kind !== "server") {
      return rpcError(403, "Device administration requires the server token");
    }
  }

  if (method === "GET" && pathname === "/devices") {
    return rpcOk(200, { devices: options.devices.list() });
  }

  if (method === "POST" && pathname === "/devices") {
    const created = buildOffer({
      registry: options.devices,
      port: options.port,
      relayUrl: options.relayUrl,
      deviceName: typeof body.name === "string" ? body.name : undefined
    });
    await audit(options.auditLog, { action: "pair_device", ...auditPeer });
    return rpcOk(201, created);
  }

  const deviceMatch = pathname.match(/^\/devices\/([^/]+)$/);
  if (method === "DELETE" && deviceMatch) {
    const deviceRef = decodeURIComponent(deviceMatch[1] ?? "");
    const device = options.devices.find(deviceRef);
    const removed = device ? options.devices.revoke(device.id) : false;
    if (device && removed) {
      options.monitor.disconnectDevice(device.id);
      await audit(options.auditLog, { action: "revoke_device", deviceId: device.id });
    }
    return removed ? rpcOk(200, { ok: true }) : rpcError(404, "Unknown or ambiguous device");
  }

  if (method === "POST" && pathname === "/agents/pty") {
    return startAgentRpc(body as StartAgentRequest, options, auditPeer);
  }

  if (method === "POST" && pathname === "/mate/start") {
    return startMateRpc(body as MateStartRequest, options, auditPeer);
  }
  if (method === "GET" && pathname === "/mate") {
    return mateStatusRpc(options);
  }

  const inputMatch = pathname.match(/^\/sessions\/([^/]+)\/input$/);
  if (method === "POST" && inputMatch) {
    const sessionId = decodeURIComponent(inputMatch[1] ?? "");
    const canonicalSessionId = canonicalSessionIdFor(options.adapter, sessionId);
    validateInput(body as InputRequest);
    if (auth.kind !== "device") {
      options.timeline.recordSource(canonicalSessionId, String(body.text), "agent");
    }
    const { queued } = await deliverInput(
      options,
      canonicalSessionId,
      String(body.text),
      auth.kind === "device" ? "human" : "agent",
      { queueMateUntilTurnBoundary: true, interrupt: body.interrupt === true }
    );
    await audit(options.auditLog, {
      action: "input",
      sessionId: canonicalSessionId,
      ...auditPeer,
      textLength: String(body.text).length
    });
    return rpcOk(202, { ok: true, queued });
  }

  const submitMatch = pathname.match(/^\/sessions\/([^/]+)\/submit$/);
  if (method === "POST" && submitMatch) {
    const sessionId = decodeURIComponent(submitMatch[1] ?? "");
    const canonicalSessionId = canonicalSessionIdFor(options.adapter, sessionId);
    validateInput(body as InputRequest);
    const { queued } = await deliverInputAccepted(options, canonicalSessionId, String(body.text), "human", {
      queueMateUntilTurnBoundary: true,
      interrupt: body.interrupt === true
    });
    await audit(options.auditLog, {
      action: "submit",
      sessionId: canonicalSessionId,
      ...auditPeer,
      textLength: String(body.text).length
    });
    const responseBody: SubmitResponse = { ok: true, queued };
    return rpcOk(202, responseBody);
  }

  const attachMatch = pathname.match(/^\/sessions\/([^/]+)\/attachments$/);
  if (method === "POST" && attachMatch) {
    const sessionId = decodeURIComponent(attachMatch[1] ?? "");
    const canonicalSessionId = canonicalSessionIdFor(options.adapter, sessionId);
    const filename = url.searchParams.get("filename") ?? "image";
    const stored = storeAttachment({
      sessionId: canonicalSessionId,
      filename,
      contentType: request.contentType ?? "application/octet-stream",
      bytes: Buffer.from(request.bodyBase64 ?? "", "base64")
    });
    await audit(options.auditLog, { action: "attach", sessionId: canonicalSessionId, ...auditPeer, textLength: 0 });
    const responseBody: AttachmentResponse = { path: stored.path, filename: stored.filename };
    return rpcOk(201, responseBody);
  }

  const modelMatch = pathname.match(/^\/sessions\/([^/]+)\/model$/);
  if (method === "POST" && modelMatch) {
    return switchModelRpc(
      decodeURIComponent(modelMatch[1] ?? ""),
      body as ModelSwitchRequest,
      options,
      auditPeer
    );
  }

  const approveMatch = pathname.match(/^\/sessions\/([^/]+)\/approve$/);
  if (method === "POST" && approveMatch) {
    const sessionId = decodeURIComponent(approveMatch[1] ?? "");
    const canonicalSessionId = canonicalSessionIdFor(options.adapter, sessionId);
    const decision = body.decision;
    if (typeof decision !== "string" || decision.length === 0) return rpcError(400, "decision must be a non-empty string");
    const pending = options.monitor.pendingApproval(canonicalSessionId);
    if (!pending) return rpcError(409, "No pending approval for this session");
    if (typeof body.id === "string" && body.id.length > 0 && body.id !== pending.id) {
      return rpcError(409, "The pending approval has changed");
    }
    if (pending.requestVersion === 1) {
      if (typeof body.id !== "string" || body.id !== pending.id) {
        return rpcError(409, "This Claude approval response must name the exact durable request");
      }
      if (!CLAUDE_APPROVAL_DECISIONS.includes(decision as ClaudeApprovalDecision) && !decision.startsWith("allow_always:")) {
        return rpcError(400, "unsupported Claude permission decision");
      }
      if (body.requestVersion !== 1 || body.runtimeGeneration !== (pending.runtimeGeneration ?? null)) {
        return rpcError(409, "Claude approval version or runtime generation changed");
      }
      const result = options.claudeApprovals!.decide(
        canonicalSessionId,
        body.id,
        decision as ClaudeApprovalDecision,
        approvalActor(auth)
      );
      if (result.status >= 400) return { status: result.status, body: result.body };
      await audit(options.auditLog, {
        action: decision === "allow" ? "approve" : "deny",
        sessionId: canonicalSessionId,
        approvalId: body.id,
        decision,
        ...auditPeer
      });
      options.monitor.publish({
        type: "message",
        sessionId: canonicalSessionId,
        role: "system",
        text: "Structured Claude decision sent; waiting for later Claude activity to confirm it",
        at: new Date().toISOString()
      });
      return { status: result.status, body: result.body };
    }
    if (pending.remoteResolutionUnavailable) {
      return rpcError(409, "Structured remote resolution is unavailable; answer this prompt on the desktop");
    }
    if (pending.decisions?.length) {
      if (typeof body.id !== "string" || body.id.length === 0) {
        return rpcError(409, "This approval response must name the pending approval");
      }
      const input = options.monitor.approvalDecisionInput(canonicalSessionId, body.id, decision);
      if (!input || !options.monitor.markApprovalSubmitted(canonicalSessionId, body.id, decision)) {
        return rpcError(409, "The response is stale, duplicated, or invalid for this approval");
      }
      try {
        for (const [index, key] of input.entries()) {
          await options.adapter.sendInput(canonicalSessionId, key);
          if (index < input.length - 1) await new Promise((resolve) => setTimeout(resolve, KEY_DELAY_MS));
        }
      } catch (error) {
        options.monitor.resetApprovalSubmitted(canonicalSessionId, body.id);
        throw error;
      }
      const denied = decision === "cancel" || decision === "deny";
      await audit(options.auditLog, {
        action: denied ? "deny" : "approve",
        sessionId: canonicalSessionId,
        approvalId: body.id,
        decision,
        ...auditPeer
      });
      options.monitor.publish({
        type: "message",
        sessionId: canonicalSessionId,
        role: "system",
        text: "Response sent; waiting for the terminal prompt to close",
        at: new Date().toISOString()
      });
      return rpcOk(202, { ok: true, pending: true });
    }
    if (decision !== "allow" && decision !== "deny") return rpcError(400, "decision must be allow or deny");
    const sessions = await options.adapter.listSessions();
    const agent = sessions.find((session) => session.id === canonicalSessionId)?.agent;
    const allowKey = agent === "codex" ? "y" : "1";
    if (!options.monitor.markApprovalSubmitted(canonicalSessionId, pending.id, decision)) {
      return rpcError(409, "The response is stale or duplicated for this approval");
    }
    try {
      await options.adapter.sendInput(canonicalSessionId, decision === "allow" ? allowKey : "\x1b");
    } catch (error) {
      options.monitor.resetApprovalSubmitted(canonicalSessionId, pending.id);
      throw error;
    }
    await audit(options.auditLog, {
      action: decision === "allow" ? "approve" : "deny",
      sessionId: canonicalSessionId,
      ...auditPeer
    });
    options.monitor.publish({
      type: "message",
      sessionId: canonicalSessionId,
      role: "system",
      text: "Response sent; waiting for the provider to confirm resolution",
      at: new Date().toISOString()
    });
    return rpcOk(202, { ok: true, pending: true });
  }

  const answerMatch = pathname.match(/^\/sessions\/([^/]+)\/answer$/);
  if (method === "POST" && answerMatch) {
    const sessionId = decodeURIComponent(answerMatch[1] ?? "");
    const canonicalSessionId = canonicalSessionIdFor(options.adapter, sessionId);
    const answer = body as AnswerRequest;
    if (!Array.isArray(answer.selections) || answer.selections.some((entry) => !Array.isArray(entry))) {
      return rpcError(400, "selections must be an array of arrays");
    }
    const pending = options.monitor.pendingQuestion(canonicalSessionId);
    if (!pending) return rpcError(409, "No pending question for this session");
    if (typeof answer.id === "string" && answer.id.length > 0 && answer.id !== pending.id) {
      return rpcError(409, "The pending question has changed");
    }
    if (pending.requestVersion === 1) {
      if (typeof answer.id !== "string" || answer.id !== pending.id) {
        return rpcError(409, "This Claude answer must name the exact durable question request");
      }
      if (answer.requestVersion !== 1 || answer.runtimeGeneration !== (pending.runtimeGeneration ?? null)) {
        return rpcError(409, "Claude question version or runtime generation changed");
      }
      const result = options.claudeQuestions!.answer(
        canonicalSessionId,
        answer.id,
        answer.selections,
        answer.customAnswers,
        approvalActor(auth)
      );
      if (result.status >= 400) return { status: result.status, body: result.body };
      await audit(options.auditLog, { action: "answer", sessionId: canonicalSessionId, ...auditPeer });
      options.monitor.publish({
        type: "message",
        sessionId: canonicalSessionId,
        role: "system",
        text: "Structured Claude answer sent; waiting for later Claude activity to confirm it",
        at: new Date().toISOString()
      });
      return { status: result.status, body: result.body };
    }
    if (pending.remoteResolutionUnavailable) {
      return rpcError(409, "Structured remote answering is unavailable; answer this question on the desktop");
    }
    const keystrokes = questionKeystrokes(pending.questions, answer.selections);
    for (const [index, key] of keystrokes.entries()) {
      await options.adapter.sendInput(canonicalSessionId, key);
      if (index < keystrokes.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, KEY_DELAY_MS));
      }
    }
    options.monitor.resolveQuestion(canonicalSessionId);
    options.monitor.applyExternalStatus(canonicalSessionId, "running", undefined, "system");
    await audit(options.auditLog, { action: "answer", sessionId: canonicalSessionId, ...auditPeer });
    options.monitor.publish({
      type: "message",
      sessionId: canonicalSessionId,
      role: "system",
      text: "Answered from mobile",
      at: new Date().toISOString()
    });
    return rpcOk(202, { ok: true });
  }

  const claudeInteractionMatch = pathname.match(/^\/sessions\/([^/]+)\/claude-interaction$/);
  if (method === "POST" && claudeInteractionMatch) {
    const canonical = canonicalSessionIdFor(options.adapter, decodeURIComponent(claudeInteractionMatch[1] ?? ""));
    if (typeof body.id !== "string" || !["accept", "decline", "cancel"].includes(String(body.action))) {
      return rpcError(400, "id and action are required");
    }
    const pendingInteraction = options.monitor.pendingClaudeInteraction(canonical);
    if (body.requestVersion !== 1 || body.runtimeGeneration !== (pendingInteraction?.runtimeGeneration ?? null)) {
      return rpcError(409, "Claude interaction version or runtime generation changed");
    }
    const content = body.content && typeof body.content === "object" && !Array.isArray(body.content) ? body.content as Record<string, unknown> : undefined;
    const result = options.claudeInteractions!.respond(canonical, body.id, body.action as "accept" | "decline" | "cancel", content, approvalActor(auth));
    return { status: result.status, body: result.body };
  }

  const enterMatch = pathname.match(/^\/sessions\/([^/]+)\/enter$/);
  if (method === "POST" && enterMatch) {
    const sessionId = decodeURIComponent(enterMatch[1] ?? "");
    const canonicalSessionId = canonicalSessionIdFor(options.adapter, sessionId);
    await options.adapter.sendEnter(sessionId);
    await audit(options.auditLog, { action: "enter", sessionId: canonicalSessionId, ...auditPeer });
    options.monitor.publish({
      type: "message",
      sessionId: canonicalSessionId,
      role: "system",
      text: "Enter sent",
      at: new Date().toISOString()
    });
    return rpcOk(202, { ok: true });
  }

  const stopMatch = pathname.match(/^\/sessions\/([^/]+)$/);
  if (method === "DELETE" && stopMatch) {
    const sessionId = decodeURIComponent(stopMatch[1] ?? "");
    const canonicalSessionId = canonicalSessionIdFor(options.adapter, sessionId);
    if (!options.adapter.stopSession) {
      return rpcError(501, "Stopping sessions is not supported by this server");
    }
    await options.adapter.stopSession(canonicalSessionId);
    await audit(options.auditLog, { action: "stop_session", sessionId: canonicalSessionId, ...auditPeer });
    return rpcOk(202, { ok: true });
  }

  const interruptMatch = pathname.match(/^\/sessions\/([^/]+)\/interrupt$/);
  if (method === "POST" && interruptMatch) {
    const sessionId = decodeURIComponent(interruptMatch[1] ?? "");
    const canonicalSessionId = canonicalSessionIdFor(options.adapter, sessionId);
    await options.adapter.interrupt(sessionId);
    await audit(options.auditLog, { action: "interrupt", sessionId: canonicalSessionId, ...auditPeer });
    options.monitor.publish({
      type: "message",
      sessionId: canonicalSessionId,
      role: "system",
      text: "Interrupt sent",
      at: new Date().toISOString()
    });
    return rpcOk(202, { ok: true });
  }

  return rpcError(404, "Not found");
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpServerOptions
): Promise<void> {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = getRequestUrl(request);
  const pathname = url.pathname;

  // /health is deliberately unauthenticated: the CLI uses it as a readiness
  // probe before it knows whether its token matches, and it exposes nothing
  // beyond liveness and the adapter name.
  if (request.method === "GET" && pathname === "/health") {
    const body: HealthResponse = {
      ok: true,
      adapter: options.adapter.name,
      version: PERCH_VERSION,
      at: new Date().toISOString()
    };
    writeJson(response, 200, body);
    return;
  }

  // Agent hook reports authenticate with their own per-session token (set in
  // the PTY environment), not the bearer token: the hook command runs inside
  // the agent's shell and never sees server or device tokens.
  if (request.method === "POST" && pathname === "/hooks") {
    await handleHookReport(request, response, options);
    return;
  }

  // Worker verbs: the dispatched agent reports task state with its own
  // per-session hook token (already in its PTY env), so this route accepts
  // either normal bearer/device auth or hook-token auth - like /hooks, but
  // fail-closed (a verb mutates the ledger, a hook report does not).
  const taskEventsMatch = pathname.match(/^\/tasks\/([^/]+)\/events$/);
  if (request.method === "POST" && taskEventsMatch) {
    await handleTaskEvent(request, response, options, decodeURIComponent(taskEventsMatch[1] ?? ""));
    return;
  }

  // Lossless worker deliverables: the full report + evidence commit durably
  // with a pending mate mailbox delivery. Worker-authored only - the same
  // fail-closed identity ladder as the events route, with no system fallback.
  const taskReportsMatch = pathname.match(/^\/tasks\/([^/]+)\/reports$/);
  if (request.method === "POST" && taskReportsMatch) {
    await handleWorkerReport(request, response, options, decodeURIComponent(taskReportsMatch[1] ?? ""));
    return;
  }

  // Typed worker operations.  Claude and other managed workers use the
  // perch CLI, while Codex roots use dynamic tools that relay to these exact
  // endpoints.  Neither path accepts a generic bearer token or a child run.
  const autoreviewMatch = pathname.match(/^\/tasks\/([^/]+)\/autoreview$/);
  if (request.method === "POST" && autoreviewMatch) {
    await handleAutoReviewRun(request, response, options, decodeURIComponent(autoreviewMatch[1] ?? ""));
    return;
  }
  const deliveryMatch = pathname.match(/^\/tasks\/([^/]+)\/delivery\/pr$/);
  if (request.method === "POST" && deliveryMatch) {
    await handleDeliveryCreatePr(request, response, options, decodeURIComponent(deliveryMatch[1] ?? ""));
    return;
  }

  // The mate's mailbox tools (read_messages / read_message / ack_message /
  // wait_for_messages). Claim and acknowledgment are fenced to the live mate
  // generation's own hook credential, so they sit above the bearer gate like
  // the other hook-token routes.
  if (pathname === "/mate/mailbox" || pathname.startsWith("/mate/mailbox/")) {
    await routeMateMailbox(request, response, options, pathname, url);
    return;
  }

  const auth = authenticate(request, options);
  if (!auth) {
    writeJson(response, 401, { error: "Unauthorized" });
    return;
  }

  try {
    if (request.method === "GET" && pathname === "/claude-approvals") {
      writeJson(response, 200, { requests: options.claudeApprovals!.list().map(publicRecord) });
      return;
    }
    if (request.method === "GET" && pathname === "/claude-questions") {
      writeJson(response, 200, { requests: options.claudeQuestions!.list().map(publicQuestion) });
      return;
    }
    if (request.method === "GET" && pathname === "/claude-interactions") {
      writeJson(response, 200, { requests: options.claudeInteractions!.list().map(publicInteraction) });
      return;
    }
    if (request.method === "GET" && pathname === "/claude-inbox") {
      const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
      writeJson(response, 200, claudeInboxSnapshot(options, after));
      return;
    }

    const timelineMatch = pathname.match(/^\/sessions\/([^/]+)\/timeline$/);
    if (request.method === "GET" && timelineMatch) {
      const sessionId = decodeURIComponent(timelineMatch[1] ?? "");
      const canonicalSessionId = canonicalSessionIdFor(options.adapter, sessionId);
      const after = Number(url.searchParams.get("after") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 200);
      writeJson(response, 200, options.timeline.fetch(canonicalSessionId, after, limit));
      return;
    }

    // A device may register ITS OWN push token (this is not administration -
    // the phone calls it after APNs registration succeeds).
    if (request.method === "POST" && pathname === "/devices/push-token") {
      if (auth.kind !== "device") {
        writeJson(response, 403, { error: "Only paired devices register push tokens" });
        return;
      }
      const body = await readJson<{ pushToken?: string }>(request);
      if (typeof body.pushToken !== "string" || body.pushToken.length === 0 || body.pushToken.length > 200) {
        throw new Error("pushToken required");
      }
      const saved = options.devices.setPushToken(auth.deviceId, body.pushToken);
      writeJson(response, saved ? 200 : 404, saved ? { ok: true } : { error: "Unknown device" });
      return;
    }

    // Device administration is server-token only: a stolen phone must not be
    // able to mint sibling tokens or revoke other devices to evade revocation.
    if (pathname === "/devices" || pathname.startsWith("/devices/")) {
      if (auth.kind !== "server") {
        writeJson(response, 403, { error: "Device administration requires the server token" });
        return;
      }
    }

    if (request.method === "GET" && pathname === "/devices") {
      const body: DevicesResponse = { devices: options.devices.list() };
      writeJson(response, 200, body);
      return;
    }

    if (request.method === "POST" && pathname === "/devices") {
      const body = await readJsonOrEmpty<{ name?: string }>(request);
      const created = buildOffer({
        registry: options.devices,
        port: options.port,
        relayUrl: options.relayUrl,
        deviceName: typeof body.name === "string" ? body.name : undefined
      });
      await audit(options.auditLog, {
        action: "pair_device",
        deviceId: created.device.id,
        remoteAddress: request.socket.remoteAddress
      });
      const responseBody: CreateDeviceResponse = created;
      writeJson(response, 201, responseBody);
      return;
    }

    const deviceMatch = pathname.match(/^\/devices\/([^/]+)$/);
    if (request.method === "DELETE" && deviceMatch) {
      const deviceRef = decodeURIComponent(deviceMatch[1] ?? "");
      // Resolve first (exact id or unique prefix; ambiguous prefixes match
      // nothing) so revocation can also cut the device's live connections.
      const device = options.devices.find(deviceRef);
      const removed = device ? options.devices.revoke(device.id) : false;
      if (device && removed) {
        options.monitor.disconnectDevice(device.id);
        await audit(options.auditLog, {
          action: "revoke_device",
          deviceId: device.id,
          remoteAddress: request.socket.remoteAddress
        });
      }
      writeJson(response, removed ? 200 : 404, removed ? { ok: true } : { error: "Unknown or ambiguous device" });
      return;
    }

    if (request.method === "GET" && pathname === "/sessions") {
      writeJson(response, 200, {
        sessions: options.monitor.withLiveState(await options.adapter.listSessions())
      });
      return;
    }

    if (request.method === "GET" && pathname === "/projects") {
      writeJson(response, 200, { projects: options.projects.list() });
      return;
    }

    // Register a project or set its delivery fields (mode, name).
    if (request.method === "POST" && pathname === "/projects") {
      const body = await readJsonOrEmpty<Record<string, unknown>>(request);
      const result = await registerProject(body, options, {
        remoteAddress: request.socket.remoteAddress
      });
      if (result.status === 200) {
        await audit(options.auditLog, {
          action: "add_project",
          cwd: resolvePath(String(body.rootPath)),
          remoteAddress: request.socket.remoteAddress
        });
      }
      writeJson(response, result.status, result.body);
      return;
    }

    if (request.method === "PATCH" && pathname === "/projects") {
      const body = await readJson<Record<string, unknown>>(request);
      const result = await configureProject(body, options, {
        remoteAddress: request.socket.remoteAddress
      });
      if (result.status === 200) {
        await audit(options.auditLog, {
          action: "set_config",
          cwd: resolvePath(String(body.rootPath)),
          remoteAddress: request.socket.remoteAddress
        });
      }
      writeJson(response, result.status, result.body);
      return;
    }

    // Unregister a project (registry-only; the repo on disk is untouched).
    if (request.method === "DELETE" && pathname === "/projects") {
      const body = await readJsonOrEmpty<{ rootPath?: string }>(request);
      const rootPath = body.rootPath ?? url.searchParams.get("rootPath") ?? undefined;
      const result = unregisterProject(rootPath, options);
      if (result.status === 200) {
        await audit(options.auditLog, {
          action: "remove_project",
          cwd: resolvePath(String(rootPath)),
          remoteAddress: request.socket.remoteAddress
        });
      }
      writeJson(response, result.status, result.body);
      return;
    }

    if (request.method === "GET" && pathname === "/fs/suggest") {
      const query = url.searchParams.get("q") ?? "";
      writeJson(response, 200, { paths: suggestDirectories(query) });
      return;
    }

    if (request.method === "GET" && pathname === "/worktrees") {
      writeJson(response, 200, { worktrees: await options.worktrees.listWithStatus() });
      return;
    }

    // Free an orphaned pool lease (dead session, closed task). The pool's own
    // release gate still refuses dirty/unlanded trees without {"force":true}.
    const worktreeReleaseMatch = pathname.match(/^\/worktrees\/(.+)\/release$/);
    if (request.method === "POST" && worktreeReleaseMatch) {
      const body = await readJsonOrEmpty<{ force?: boolean }>(request);
      const result = await releaseWorktreeRpc(
        decodeURIComponent(worktreeReleaseMatch[1] ?? ""),
        body,
        options,
        { remoteAddress: request.socket.remoteAddress }
      );
      writeJson(response, result.status, result.body);
      return;
    }

    // Environment doctor: every external tool perch depends on (agent CLIs,
    // gh), checked in the environment that actually spawns agents.
    // `perch doctor` renders it.
    if (request.method === "GET" && pathname === "/doctor") {
      writeJson(response, 200, await collectDoctor({ ...options.doctorDeps }));
      return;
    }

    // Fleet-level user config (`perch config`): the dispatch defaults POST
    // /tasks falls back to, and the mate defaults `perch mate` launches with.
    // Both verbs return the EFFECTIVE values - PERCH_DEFAULT_*/PERCH_MATE_*
    // env overrides win over the persisted settings file.
    if (request.method === "GET" && pathname === "/config") {
      const body = await buildConfigResponse(options, {
        dispatchDefaults: options.settings?.dispatchDefaults() ?? {},
        mateDefaults: options.settings?.mateDefaults() ?? {}
      }, url.searchParams.get("project") ?? undefined, url.searchParams.get("effective") === "1");
      writeJson(response, 200, body);
      return;
    }

    // Update the persisted defaults: a string sets a key, null clears it,
    // absent keys are untouched. Invalid values (agent outside the whitelist,
    // unknown effort) are refused with a 400 naming the accepted values.
    if (request.method === "PATCH" && pathname === "/config") {
      if (!options.settings) {
        writeJson(response, 501, { error: "settings are not supported by this server" });
        return;
      }
      const body = await readJson<Record<string, unknown>>(request);
      let dispatchDefaults: ConfigResponse["dispatchDefaults"];
      let mateDefaults: ConfigResponse["mateDefaults"];
      try {
        const update = strictConfigPatch(body);
        const resolvers = await modelConfigResolvers(options);
        dispatchDefaults = update.dispatchDefaults === undefined
          ? options.settings.dispatchDefaults()
          : options.settings.updateDispatchDefaults(update.dispatchDefaults, resolvers.efforts, resolvers.agents);
        mateDefaults = update.mateDefaults === undefined
          ? options.settings.mateDefaults()
          : options.settings.updateMateDefaults(update.mateDefaults, resolvers.efforts, resolvers.agents);
      } catch (error) {
        writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      await audit(options.auditLog, {
        action: "set_config",
        remoteAddress: request.socket.remoteAddress
      });
      const responseBody = await buildConfigResponse(options, { dispatchDefaults, mateDefaults });
      writeJson(response, 200, responseBody);
      return;
    }

    // State-machine measurements (G6): per-edge counts by source, watchdog and
    // reconciler counters, and the few measurable latencies. For the mate/CLI.
    if (request.method === "GET" && pathname === "/doctor/state-metrics") {
      writeJson(response, 200, options.metrics ? options.metrics.snapshot() : {});
      return;
    }

    // Local usage/credit snapshot for the agent providers on this Mac (Claude +
    // Codex). Read with the CLIs' existing credentials and memoized for
    // a few seconds so many phones never hammer the providers' endpoints.
    if (request.method === "GET" && pathname === "/usage") {
      writeJson(response, 200, await (options.usageCollector?.() ?? collectUsage()));
      return;
    }

    // Launch-time model catalog: versioned names + the CLI's resolved default,
    // read from the local Claude/Codex config on this Mac. The single source of
    // truth for the New Agent picker; the app carries only a small fallback.
    // The perch CLI opts into the bundled-only Claude catalog with
    // `?claude=bundled`; the default picker response keeps its existing behavior.
    if (request.method === "GET" && pathname === "/models") {
      const registry = url.searchParams.get("claude") === "bundled"
        ? await collectCliModelRegistry({ listCodexModels: listCodexModelsOnce })
        : await collectModelRegistry({ listCodexModels: listCodexModelsOnce, listClaudeModels });
      writeJson(response, 200, registry);
      return;
    }

    if (request.method === "GET" && pathname === "/tasks") {
      writeJson(response, 200, taskListResponse(url, options.tasks));
      return;
    }

    if (request.method === "POST" && pathname === "/tasks") {
      await handleCreateTask(request, response, options);
      return;
    }

    const taskMatch = pathname.match(/^\/tasks\/([^/]+)$/);
    if (request.method === "GET" && taskMatch) {
      const id = decodeURIComponent(taskMatch[1] ?? "");
      const task = options.tasks.find(id);
      if (!task) {
        writeJson(response, 404, { error: `Unknown task: ${id}` });
        return;
      }
      const body: TaskDetailResponse = { task, events: options.tasks.events(id) };
      writeJson(response, 200, body);
      return;
    }

    const teardownMatch = pathname.match(/^\/tasks\/([^/]+)\/teardown$/);
    if (request.method === "POST" && teardownMatch) {
      await handleTeardown(request, response, options, decodeURIComponent(teardownMatch[1] ?? ""));
      return;
    }

    const recoverMatch = pathname.match(/^\/tasks\/([^/]+)\/recover$/);
    if (request.method === "POST" && recoverMatch) {
      const body = await readJsonOrEmpty<{ idempotencyKey?: string }>(request);
      const result = await recoverTaskRpc(
        decodeURIComponent(recoverMatch[1] ?? ""),
        body,
        options,
        auditPeerFor(auth)
      );
      writeJson(response, result.status, result.body);
      return;
    }

    // Only the local mate/server authority can verify completion. Worker hook
    // credentials never enter this authenticated route, and paired devices do
    // not silently stand in for the mate's deliverable review.
    const completionMatch = pathname.match(/^\/tasks\/([^/]+)\/completion$/);
    if (request.method === "POST" && completionMatch) {
      if (auth.kind !== "server") {
        writeJson(response, 403, { error: "Completion verification requires the mate server token" });
        return;
      }
      const body = await readJson<CompletionDecisionRequest>(request);
      const result = await completionDecisionRpc(
        decodeURIComponent(completionMatch[1] ?? ""),
        body,
        options,
        auditPeerFor(auth)
      );
      writeJson(response, result.status, result.body);
      return;
    }

    if (request.method === "GET" && pathname === "/topology") {
      writeJson(response, 200, await options.adapter.getTopology());
      return;
    }

    if (request.method === "POST" && pathname === "/agents/pty") {
      if (!options.adapter.startAgent) {
        writeJson(response, 501, { error: "PTY agents are not supported by this server" });
        return;
      }

      const body = await readJson<StartAgentRequest>(request);
      const result = await startManagedAgent(options, {
        request: body,
        auditMeta: {
          remoteAddress: request.socket.remoteAddress
        }
      });
      const responseBody: StartAgentResponse = { session: result.session };
      writeJson(response, 201, responseBody);
      return;
    }

    // Start the fleet's one mate from a device (mobile-first: the no-mate
    // empty state needs a live button). Same spawn as `perch mate`; 409 with
    // the live mate's sessionId when one is already on deck.
    if (request.method === "POST" && pathname === "/mate/start") {
      // Bodyless is the common call (the app's "start the mate" button); an
      // explicit agent/model/effort overrides the fleet's mate defaults.
      const body = await readJsonOrEmpty<MateStartRequest>(request);
      const result = await startMateRpc(body, options, { remoteAddress: request.socket.remoteAddress });
      writeJson(response, result.status, result.body);
      return;
    }
    if (request.method === "GET" && pathname === "/mate") {
      const result = await mateStatusRpc(options);
      writeJson(response, result.status, result.body);
      return;
    }

    const logsMatch = pathname.match(/^\/sessions\/([^/]+)\/logs$/);
    if (request.method === "GET" && logsMatch) {
      const sessionId = decodeURIComponent(logsMatch[1] ?? "");
      const canonicalSessionId = canonicalSessionIdFor(options.adapter, sessionId);
      const lines = Number(url.searchParams.get("lines") ?? 120);
      // Non-terminal surfaces (e.g. browser) come back as terminal: false with
      // an empty event list instead of a failed capture, so this stays 200.
      const result = await options.adapter.readRecentEvents(sessionId, lines);
      const body: LogsResponse = {
        events: result.events.map((event) => withCanonicalSessionId(event, canonicalSessionId)),
        terminal: result.terminal,
        note: result.note
      };
      writeJson(response, 200, body);
      return;
    }

    const inputMatch = pathname.match(/^\/sessions\/([^/]+)\/input$/);
    if (request.method === "POST" && inputMatch) {
      const sessionId = decodeURIComponent(inputMatch[1] ?? "");
      const canonicalSessionId = canonicalSessionIdFor(options.adapter, sessionId);
      const body = await readJson<InputRequest>(request);
      validateInput(body);
      // Provenance: input over the server/session channel (the mate steering a
      // worker) is agent-driven; a device token here would be the human, which
      // falls through to the human default. Record before injecting so the
      // buffer entry exists before the transcript row can tail back.
      if (auth.kind !== "device") {
        options.timeline.recordSource(canonicalSessionId, body.text, "agent");
      }
      const { queued } = await deliverInput(
        options,
        canonicalSessionId,
        body.text,
        auth.kind === "device" ? "human" : "agent",
        { queueMateUntilTurnBoundary: true, interrupt: body.interrupt === true }
      );
      await audit(options.auditLog, {
        action: "input",
        sessionId: canonicalSessionId,
        remoteAddress: request.socket.remoteAddress,
        textLength: body.text.length
      });
      writeJson(response, 202, { ok: true, queued });
      return;
    }

    const submitMatch = pathname.match(/^\/sessions\/([^/]+)\/submit$/);
    if (request.method === "POST" && submitMatch) {
      const sessionId = decodeURIComponent(submitMatch[1] ?? "");
      const canonicalSessionId = canonicalSessionIdFor(options.adapter, sessionId);
      const body = await readJson<InputRequest>(request);
      validateInput(body);
      const { queued } = await deliverInputAccepted(options, canonicalSessionId, body.text, "human", {
        queueMateUntilTurnBoundary: true,
        interrupt: body.interrupt === true
      });
      await audit(options.auditLog, {
        action: "submit",
        sessionId: canonicalSessionId,
        remoteAddress: request.socket.remoteAddress,
        textLength: body.text.length
      });
      const responseBody: SubmitResponse = { ok: true, queued };
      writeJson(response, 202, responseBody);
      return;
    }

    const attachMatch = pathname.match(/^\/sessions\/([^/]+)\/attachments$/);
    if (request.method === "POST" && attachMatch) {
      const sessionId = decodeURIComponent(attachMatch[1] ?? "");
      const canonicalSessionId = canonicalSessionIdFor(options.adapter, sessionId);
      const contentType = request.headers["content-type"] ?? "application/octet-stream";
      const filename = url.searchParams.get("filename") ?? "image";
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(chunk as Buffer);
      }
      const stored = storeAttachment({
        sessionId: canonicalSessionId,
        filename,
        contentType,
        bytes: Buffer.concat(chunks)
      });
      await audit(options.auditLog, {
        action: "attach",
        sessionId: canonicalSessionId,
        remoteAddress: request.socket.remoteAddress,
        textLength: 0
      });
      const responseBody: AttachmentResponse = { path: stored.path, filename: stored.filename };
      writeJson(response, 201, responseBody);
      return;
    }

    const modelMatch = pathname.match(/^\/sessions\/([^/]+)\/model$/);
    if (request.method === "POST" && modelMatch) {
      const sessionId = decodeURIComponent(modelMatch[1] ?? "");
      const canonicalSessionId = canonicalSessionIdFor(options.adapter, sessionId);
      const body = await readJson<ModelSwitchRequest>(request);
      if (typeof body.model !== "string" || body.model.trim().length === 0) {
        throw new Error("model must be a non-empty string");
      }
      if (isProviderPrefixedModelId(body.model)) {
        writeJson(response, 400, { error: "model must be a local runtime id, not a provider gateway id" });
        return;
      }
      // Switching while a permission prompt is open would drive the wrong TUI
      // widget; make the caller resolve the prompt first.
      if (options.monitor.pendingApproval(canonicalSessionId)) {
        writeJson(response, 409, { error: "Resolve the open prompt before switching models" });
        return;
      }
      const sessions = await options.adapter.listSessions();
      const agent = sessions.find((session) => session.id === canonicalSessionId)?.agent;
      if (!agent) {
        writeJson(response, 404, { error: "Unknown session" });
        return;
      }
      // Codex switches over the app-server protocol (per-turn `turn/start` model
      // override, no keystrokes). No push fires on a model change; the override
      // applies on the next submitted turn.
      if (agent === "codex") {
        const armed = options.codexOwned?.switchModel(
          canonicalSessionId,
          body.model.trim(),
          body.effort
        );
        if (!armed) {
          writeJson(response, 409, {
            error: "This Codex session is not connected to its app-server; model switching is unavailable"
          });
          return;
        }
        // Reflect the switch in the live readout right away (the effort only
        // moves when the caller sends one; otherwise the session keeps its
        // current tier, so it is merged rather than reset).
        const switched = resolveSessionModel("codex", { model: body.model.trim() });
        options.monitor.setSessionModel(canonicalSessionId, {
          model: switched.model,
          modelLabel: switched.modelLabel,
          ...(body.effort ? { effort: body.effort } : {})
        });
        await audit(options.auditLog, {
          action: "model",
          sessionId: canonicalSessionId,
          remoteAddress: request.socket.remoteAddress,
          textLength: body.model.length
        });
        const codexResponse: ModelSwitchResponse = { ok: true };
        writeJson(response, 202, codexResponse);
        return;
      }
      const landed = await runModelSwitchSteps(options.adapter, canonicalSessionId, agent, body.model.trim());
      // The keystrokes went into the PTY either way, so the switch is audited
      // as attempted; only the chip and the response hinge on it landing.
      await audit(options.auditLog, {
        action: "model",
        sessionId: canonicalSessionId,
        remoteAddress: request.socket.remoteAddress,
        textLength: body.model.length
      });
      if (!landed) {
        writeJson(response, 504, { error: MODEL_SWITCH_UNCONFIRMED });
        return;
      }
      // Keep the live readout current with the model just submitted.
      const switched = resolveSessionModel(agent, { model: body.model.trim() });
      options.monitor.setSessionModel(canonicalSessionId, {
        model: switched.model,
        modelLabel: switched.modelLabel
      });
      const responseBody: ModelSwitchResponse = { ok: true };
      writeJson(response, 202, responseBody);
      return;
    }

    const serverRequestMatch = pathname.match(/^\/sessions\/([^/]+)\/server-request$/);
    if (request.method === "POST" && serverRequestMatch) {
      const sessionId = decodeURIComponent(serverRequestMatch[1] ?? "");
      const canonicalSessionId = canonicalSessionIdFor(options.adapter, sessionId);
      const body = await readJson<ServerRequestResponse>(request);
      if (typeof body.requestId !== "string" && typeof body.requestId !== "number") {
        throw new Error("requestId must be a string or number");
      }
      // Several requests can be open at once; answer exactly the id named,
      // whether or not it is the queue head the overview currently shows.
      const pending = options.monitor.pendingServerRequestById(canonicalSessionId, body.requestId);
      if (!pending) {
        if (options.monitor.pendingServerRequest(canonicalSessionId)) {
          writeJson(response, 409, { error: "The structured server request has changed" });
        } else {
          writeJson(response, 409, { error: "No structured server request for this session" });
        }
        return;
      }
      if (!options.codexOwned?.respondToServerRequest(canonicalSessionId, body)) {
        writeJson(response, 409, { error: "The response is stale or invalid for this request" });
        return;
      }
      await audit(options.auditLog, {
        action: body.decision === "decline" || body.decision === "deny" || body.decision === "cancel" ? "deny" : "approve",
        sessionId: canonicalSessionId,
        remoteAddress: request.socket.remoteAddress
      });
      options.monitor.publish({
        type: "message",
        sessionId: canonicalSessionId,
        role: "system",
        text: "Response sent; waiting for Codex confirmation",
        at: new Date().toISOString()
      });
      writeJson(response, 202, { ok: true, pending: true });
      return;
    }

    const approveMatch = pathname.match(/^\/sessions\/([^/]+)\/approve$/);
    if (request.method === "POST" && approveMatch) {
      const sessionId = decodeURIComponent(approveMatch[1] ?? "");
      const canonicalSessionId = canonicalSessionIdFor(options.adapter, sessionId);
      const body = await readJson<ApproveRequest>(request);
      if (typeof body.decision !== "string" || body.decision.length === 0) {
        throw new Error("decision must be a non-empty string");
      }

      if (options.monitor.pendingServerRequest(canonicalSessionId)) {
        writeJson(response, 409, { error: "This approval requires a structured app-server response" });
        return;
      }

      // Only answer a prompt that is actually open (and, when the client says
      // which one, the same one): a blind "1" after the desktop already
      // answered would land in the composer as literal text - or approve a
      // different prompt that opened in the meantime.
      const pending = options.monitor.pendingApproval(canonicalSessionId);
      if (!pending) {
        writeJson(response, 409, { error: "No pending approval for this session" });
        return;
      }
      if (typeof body.id === "string" && body.id.length > 0 && body.id !== pending.id) {
        writeJson(response, 409, { error: "The pending approval has changed" });
        return;
      }
      if (pending.requestVersion === 1) {
        if (typeof body.id !== "string" || body.id !== pending.id) {
          writeJson(response, 409, { error: "This Claude approval response must name the exact durable request" });
          return;
        }
        if (body.requestVersion !== 1 || body.runtimeGeneration !== (pending.runtimeGeneration ?? null)) {
          writeJson(response, 409, { error: "Claude approval version or runtime generation changed" });
          return;
        }
        if (!CLAUDE_APPROVAL_DECISIONS.includes(body.decision as ClaudeApprovalDecision) && !body.decision.startsWith("allow_always:")) {
          writeJson(response, 400, { error: "unsupported Claude permission decision" });
          return;
        }
        const result = options.claudeApprovals!.decide(
          canonicalSessionId,
          body.id,
          body.decision as ClaudeApprovalDecision,
          approvalActor(auth)
        );
        if (result.status < 400) {
          await audit(options.auditLog, {
            action: body.decision === "allow" ? "approve" : "deny",
            sessionId: canonicalSessionId,
            approvalId: body.id,
            decision: body.decision,
            remoteAddress: request.socket.remoteAddress,
            ...(auth.kind === "device" ? { deviceId: auth.deviceId } : {})
          });
          options.monitor.publish({
            type: "message",
            sessionId: canonicalSessionId,
            role: "system",
            text: "Structured Claude decision sent; waiting for later Claude activity to confirm it",
            at: new Date().toISOString()
          });
        }
        writeJson(response, result.status, result.body);
        return;
      }
      if (pending.remoteResolutionUnavailable) {
        writeJson(response, 409, { error: "Structured remote resolution is unavailable; answer this prompt on the desktop" });
        return;
      }

      if (pending.decisions?.length) {
        if (typeof body.id !== "string" || body.id.length === 0) {
          writeJson(response, 409, { error: "This approval response must name the pending approval" });
          return;
        }
        const input = options.monitor.approvalDecisionInput(canonicalSessionId, body.id, body.decision);
        if (!input || !options.monitor.markApprovalSubmitted(canonicalSessionId, body.id, body.decision)) {
          writeJson(response, 409, { error: "The response is stale, duplicated, or invalid for this approval" });
          return;
        }
        try {
          for (const [index, key] of input.entries()) {
            await options.adapter.sendInput(canonicalSessionId, key);
            if (index < input.length - 1) {
              await new Promise((resolve) => setTimeout(resolve, KEY_DELAY_MS));
            }
          }
        } catch (error) {
          options.monitor.resetApprovalSubmitted(canonicalSessionId, body.id);
          throw error;
        }
        const denied = body.decision === "cancel" || body.decision === "deny";
        await audit(options.auditLog, {
          action: denied ? "deny" : "approve",
          sessionId: canonicalSessionId,
          approvalId: body.id,
          decision: body.decision,
          remoteAddress: request.socket.remoteAddress
        });
        options.monitor.publish({
          type: "message",
          sessionId: canonicalSessionId,
          role: "system",
          text: "Response sent; waiting for the terminal prompt to close",
          at: new Date().toISOString()
        });
        writeJson(response, 202, { ok: true, pending: true });
        return;
      }

      if (body.decision !== "allow" && body.decision !== "deny") {
        throw new Error("decision must be allow or deny");
      }

      // Answer the real TUI prompt with the agent's own dialog keys: Claude
      // Code selects Allow with "1" and dismisses with Esc; codex accepts "y"
      // and Esc. Both verified against the current TUIs.
      const sessions = await options.adapter.listSessions();
      const agent = sessions.find((session) => session.id === canonicalSessionId)?.agent;
      const allowKey = agent === "codex" ? "y" : "1";
      if (!options.monitor.markApprovalSubmitted(canonicalSessionId, pending.id, body.decision)) {
        writeJson(response, 409, { error: "The response is stale or duplicated for this approval" });
        return;
      }
      try {
        await options.adapter.sendInput(canonicalSessionId, body.decision === "allow" ? allowKey : "\x1b");
      } catch (error) {
        options.monitor.resetApprovalSubmitted(canonicalSessionId, pending.id);
        throw error;
      }
      await audit(options.auditLog, {
        action: body.decision === "allow" ? "approve" : "deny",
        sessionId: canonicalSessionId,
        remoteAddress: request.socket.remoteAddress
      });
      options.monitor.publish({
        type: "message",
        sessionId: canonicalSessionId,
        role: "system",
        text: "Response sent; waiting for the provider to confirm resolution",
        at: new Date().toISOString()
      });
      writeJson(response, 202, { ok: true, pending: true });
      return;
    }

    const answerMatch = pathname.match(/^\/sessions\/([^/]+)\/answer$/);
    if (request.method === "POST" && answerMatch) {
      const sessionId = decodeURIComponent(answerMatch[1] ?? "");
      const canonicalSessionId = canonicalSessionIdFor(options.adapter, sessionId);
      const body = await readJson<AnswerRequest>(request);
      if (!Array.isArray(body.selections) || body.selections.some((entry) => !Array.isArray(entry))) {
        throw new Error("selections must be an array of arrays");
      }

      // Only answer a question that is actually open, and (when the client says
      // which) the same one: a stale answer would drive the wrong widget or
      // land as literal keystrokes after the desktop already answered.
      const pending = options.monitor.pendingQuestion(canonicalSessionId);
      if (!pending) {
        writeJson(response, 409, { error: "No pending question for this session" });
        return;
      }
      if (typeof body.id === "string" && body.id.length > 0 && body.id !== pending.id) {
        writeJson(response, 409, { error: "The pending question has changed" });
        return;
      }

      if (pending.requestVersion === 1) {
        if (typeof body.id !== "string" || body.id !== pending.id) {
          writeJson(response, 409, { error: "This Claude answer must name the exact durable question request" });
          return;
        }
        if (body.requestVersion !== 1 || body.runtimeGeneration !== (pending.runtimeGeneration ?? null)) {
          writeJson(response, 409, { error: "Claude question version or runtime generation changed" });
          return;
        }
        const result = options.claudeQuestions!.answer(
          canonicalSessionId,
          body.id,
          body.selections,
          body.customAnswers,
          approvalActor(auth)
        );
        if (result.status < 400) {
          await audit(options.auditLog, {
            action: "answer",
            sessionId: canonicalSessionId,
            remoteAddress: request.socket.remoteAddress,
            ...(auth.kind === "device" ? { deviceId: auth.deviceId } : {})
          });
          options.monitor.publish({
            type: "message",
            sessionId: canonicalSessionId,
            role: "system",
            text: "Structured Claude answer sent; waiting for later Claude activity to confirm it",
            at: new Date().toISOString()
          });
        }
        writeJson(response, result.status, result.body);
        return;
      }
      if (pending.remoteResolutionUnavailable) {
        writeJson(response, 409, { error: "Structured remote answering is unavailable; answer this question on the desktop" });
        return;
      }

      // Drive the real AskUserQuestion widget with its own keystrokes so the
      // desktop TUI visibly resolves, exactly like the approval path. Keys go
      // one at a time, spaced out: the widget drops a navigation run delivered
      // in a single write.
      const keystrokes = questionKeystrokes(pending.questions, body.selections);
      for (const [index, key] of keystrokes.entries()) {
        await options.adapter.sendInput(canonicalSessionId, key);
        if (index < keystrokes.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, KEY_DELAY_MS));
        }
      }
      options.monitor.resolveQuestion(canonicalSessionId);
      options.monitor.applyExternalStatus(canonicalSessionId, "running", undefined, "system");
      await audit(options.auditLog, {
        action: "answer",
        sessionId: canonicalSessionId,
        remoteAddress: request.socket.remoteAddress
      });
      options.monitor.publish({
        type: "message",
        sessionId: canonicalSessionId,
        role: "system",
        text: "Answered from mobile",
        at: new Date().toISOString()
      });
      writeJson(response, 202, { ok: true });
      return;
    }

    const claudeInteractionMatch = pathname.match(/^\/sessions\/([^/]+)\/claude-interaction$/);
    if (request.method === "POST" && claudeInteractionMatch) {
      const canonical = canonicalSessionIdFor(options.adapter, decodeURIComponent(claudeInteractionMatch[1] ?? ""));
      const body = await readJson<Record<string, unknown>>(request);
      if (typeof body.id !== "string" || !["accept", "decline", "cancel"].includes(String(body.action))) {
        writeJson(response, 400, { error: "id and action are required" });
        return;
      }
      const pendingInteraction = options.monitor.pendingClaudeInteraction(canonical);
      if (body.requestVersion !== 1 || body.runtimeGeneration !== (pendingInteraction?.runtimeGeneration ?? null)) {
        writeJson(response, 409, { error: "Claude interaction version or runtime generation changed" });
        return;
      }
      const content = body.content && typeof body.content === "object" && !Array.isArray(body.content) ? body.content as Record<string, unknown> : undefined;
      const result = options.claudeInteractions!.respond(canonical, body.id, body.action as "accept" | "decline" | "cancel", content, approvalActor(auth));
      writeJson(response, result.status, result.body);
      return;
    }

    const enterMatch = pathname.match(/^\/sessions\/([^/]+)\/enter$/);
    if (request.method === "POST" && enterMatch) {
      const sessionId = decodeURIComponent(enterMatch[1] ?? "");
      const canonicalSessionId = canonicalSessionIdFor(options.adapter, sessionId);
      await options.adapter.sendEnter(sessionId);
      await audit(options.auditLog, {
        action: "enter",
        sessionId: canonicalSessionId,
        remoteAddress: request.socket.remoteAddress
      });
      options.monitor.publish({
        type: "message",
        sessionId: canonicalSessionId,
        role: "system",
        text: "Enter sent",
        at: new Date().toISOString()
      });
      writeJson(response, 202, { ok: true });
      return;
    }

    const stopMatch = pathname.match(/^\/sessions\/([^/]+)$/);
    if (request.method === "DELETE" && stopMatch) {
      const sessionId = decodeURIComponent(stopMatch[1] ?? "");
      const canonicalSessionId = canonicalSessionIdFor(options.adapter, sessionId);
      if (!options.adapter.stopSession) {
        writeJson(response, 501, { error: "Stopping sessions is not supported by this server" });
        return;
      }
      await options.adapter.stopSession(canonicalSessionId);
      await audit(options.auditLog, {
        action: "stop_session",
        sessionId: canonicalSessionId,
        remoteAddress: request.socket.remoteAddress
      });
      writeJson(response, 202, { ok: true });
      return;
    }

    const interruptMatch = pathname.match(/^\/sessions\/([^/]+)\/interrupt$/);
    if (request.method === "POST" && interruptMatch) {
      const sessionId = decodeURIComponent(interruptMatch[1] ?? "");
      const canonicalSessionId = canonicalSessionIdFor(options.adapter, sessionId);
      await options.adapter.interrupt(sessionId);
      await audit(options.auditLog, {
        action: "interrupt",
        sessionId: canonicalSessionId,
        remoteAddress: request.socket.remoteAddress
      });
      options.monitor.publish({
        type: "message",
        sessionId: canonicalSessionId,
        role: "system",
        text: "Interrupt sent",
        at: new Date().toISOString()
      });
      writeJson(response, 202, { ok: true });
      return;
    }

    writeJson(response, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    writeJson(response, 500, { error: message });
  }
}

// Deliver composer text so it actually SUBMITS. Claude: a raw PTY write
// leaves the text sitting unsent in the TUI's input line, so the monitor's
// path ends with a distinct Enter. Codex: the session is app-server-owned,
// and the monitor's submitToAdapter routes to the owning adapter, which
// serializes the input and delivers it over the protocol (turn/start when
// idle, turn/steer into the active turn) - acknowledged, never keystrokes.
// Both paths queue-gate while a permission prompt is open.
async function deliverInput(
  options: HttpServerOptions,
  canonicalSessionId: string,
  text: string,
  source: "human" | "agent",
  behavior: { queueMateUntilTurnBoundary?: boolean; interrupt?: boolean } = {}
): Promise<{ queued: boolean }> {
  return options.monitor.queueOrSubmit(canonicalSessionId, text, { source, ...behavior });
}

const INPUT_ACCEPT_WAIT_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deliverInputAccepted(
  options: HttpServerOptions,
  canonicalSessionId: string,
  text: string,
  source: "human" | "agent",
  behavior: { queueMateUntilTurnBoundary?: boolean; interrupt?: boolean } = {}
): Promise<{ queued: boolean }> {
  const delivery = deliverInput(options, canonicalSessionId, text, source, behavior);
  let accepted = false;

  const result = await Promise.race([
    delivery.then((value) => {
      accepted = true;
      return value;
    }),
    sleep(INPUT_ACCEPT_WAIT_MS).then(() => {
      accepted = true;
      return { queued: false };
    })
  ]);

  if (accepted) {
    delivery.catch(() => {});
  }

  return result;
}

function idempotencyKeyError(key: unknown): string | undefined {
  if (key === undefined) return undefined;
  if (typeof key !== "string" || key.trim().length === 0) {
    return "idempotencyKey must be a non-empty string";
  }
  if (key.length > 200) return "idempotencyKey is too long (max 200 characters)";
  return undefined;
}

function legacyModeCreationError(mode: unknown): string | undefined {
  if (mode === undefined) return undefined;
  if (mode === "direct-PR" || mode === "no-mistakes" || mode === "local-only") {
    return `task delivery mode ${JSON.stringify(mode)} is legacy-only; create a ship, scout, or operate task instead`;
  }
  return "mode is no longer supported; create a ship, scout, or operate task instead";
}

function taskKindCreationError(kind: unknown): string | undefined {
  if (kind === undefined || kind === "ship" || kind === "scout" || kind === "operate") return undefined;
  return "kind must be ship, scout, or operate";
}

function dispatchIdempotencyKey(body: CreateTaskRequest, taskId: string): string {
  return body.idempotencyKey ? `dispatch:request:${body.idempotencyKey.trim()}` : `dispatch:task:${taskId}`;
}

function repeatedDispatchTask(body: CreateTaskRequest, options: HttpServerOptions): Task | undefined {
  if (body.dispatch !== true || !body.idempotencyKey || !options.taskScheduler) return undefined;
  const operation = options.tasks.stateDb.operations.findByIdempotencyKey(dispatchIdempotencyKey(body, "unused"));
  return operation ? options.tasks.find(operation.taskId) : undefined;
}

// Replaying a known idempotency key resumes an unsettled dispatch and returns
// the task as the operation left it. A durably failed key is never relaunched
// and never a server error: the caller gets the task in its failed state, and
// a fresh attempt requires a fresh key.
async function resumeRepeatedDispatch(
  body: CreateTaskRequest,
  repeated: Task,
  options: HttpServerOptions
): Promise<Task | undefined> {
  const operation = options.tasks.stateDb.operations.findByIdempotencyKey(dispatchIdempotencyKey(body, repeated.id));
  if (operation && options.taskScheduler && operation.state !== "failed") {
    await options.taskScheduler.run(operation.id);
  }
  return options.tasks.find(repeated.id);
}

// Create a task; dispatch: true composes the M0 pieces - acquire a pooled
// worktree of the project, start the worker session with labels.task and the
// brief-augmented prompt, and link everything onto the task record.
async function handleCreateTask(
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpServerOptions
): Promise<void> {
  const body = await readJson<CreateTaskRequest>(request);
  if (typeof body.title !== "string" || body.title.trim().length === 0) {
    writeJson(response, 400, { error: "title required" });
    return;
  }
  if (typeof body.project !== "string" || body.project.trim().length === 0) {
    writeJson(response, 400, { error: "project required" });
    return;
  }
  const resolvedProject = resolveDispatchProjectRoot(options.projects, body.project.trim());
  if ("error" in resolvedProject) {
    writeJson(response, 400, { error: resolvedProject.error });
    return;
  }
  body.project = resolvedProject.rootPath;
  const idempotencyError = idempotencyKeyError(body.idempotencyKey);
  if (idempotencyError) {
    writeJson(response, 400, { error: idempotencyError });
    return;
  }
  const kindError = taskKindCreationError(body.kind);
  if (kindError) {
    writeJson(response, 400, { error: kindError });
    return;
  }

  // Crew parentage defaults to the calling session: a request that also
  // carries its session hook credentials (x-perch-session/x-perch-token, the
  // same pair the task-verb endpoints verify) gets that session as `parent`
  // when the body omits it, so a mate that forgets the field still groups its
  // crew. An explicit `parent` always wins; plain bearer calls without the
  // headers stay ungrouped as before. Presented-but-invalid credentials are
  // rejected rather than ignored - silently dropping them would recreate the
  // ungrouped dispatch this defaulting exists to prevent.
  const hookSessionId = String(request.headers["x-perch-session"] ?? "");
  const hookToken = String(request.headers["x-perch-token"] ?? "");
  if (hookSessionId || hookToken) {
    if (!options.hooks.verify(hookSessionId, hookToken)) {
      writeJson(response, 401, { error: "Unauthorized" });
      return;
    }
    // A rebound codex daemon's env still names its spawn-time session; the
    // alias resolves that identity to the live session so crew still groups.
    if (!body.parent) body.parent = options.hooks.resolveAlias(hookSessionId);
  }

  const repeated = repeatedDispatchTask(body, options);
  if (repeated) {
    writeJson(response, 201, { task: await resumeRepeatedDispatch(body, repeated, options) });
    return;
  }

  const legacyModeError = legacyModeCreationError(body.mode);
  if (legacyModeError) {
    writeJson(response, 409, { error: legacyModeError });
    return;
  }

  if (body.dispatch === true && !options.adapter.startAgent) {
    writeJson(response, 501, { error: "PTY agents are not supported by this server" });
    return;
  }
  const task =
    body.dispatch === true
      ? await dispatchTaskWorker(options, body, { remoteAddress: request.socket.remoteAddress })
      : createTaskRecord(body, options);

  writeJson(response, 201, { task: options.tasks.find(task.id) ?? task });
}

function createTaskRecord(body: CreateTaskRequest, options: HttpServerOptions): Task {
  return options.tasks.create({
    title: body.title,
    project: body.project,
    prompt: body.prompt?.trim() || body.title.trim(),
    kind: body.kind
  });
}

// The one dispatch body behind POST /tasks on both transports (raw HTTP and
// relay RPC). These previously drifted: the RPC copy attached the codex
// control client AFTER the TUI spawned (missing the one-shot thread/started
// broadcast) and without the stream/turn callbacks, so a codex task
// dispatched over that path never streamed and never reported done.
async function dispatchTaskWorker(
  options: HttpServerOptions,
  body: CreateTaskRequest,
  auditMeta: Pick<Parameters<AuditLog["write"]>[0], "deviceId" | "remoteAddress">
): Promise<Task> {
  const scheduler = options.taskScheduler;
  if (scheduler) {
    const operation = createDispatchOperation(options, scheduler, body, auditMeta);
    if (operation.state !== "failed") {
      await scheduler.run(operation.id);
    }
    const task = options.tasks.find(operation.taskId);
    if (!task) throw new Error(`Unknown task: ${operation.taskId}`);
    return task;
  }
  const task = createTaskRecord(body, options);
  try {
    await executeDispatchLaunch(options, task, body, auditMeta);
  } catch (error) {
    recordDispatchFailure(options, task.id, error);
    throw error;
  }
  return options.tasks.find(task.id) ?? task;
}

// The task record and its dispatch operation land in one transaction: a
// concurrent first-time request that loses the idempotency-key race rolls its
// task back (nothing orphaned) and adopts the winner's operation instead.
function createDispatchOperation(
  options: HttpServerOptions,
  scheduler: TaskScheduler,
  body: CreateTaskRequest,
  auditMeta: Pick<Parameters<AuditLog["write"]>[0], "deviceId" | "remoteAddress">
): OperationRecord {
  let raced: OperationRecord | undefined;
  try {
    return options.tasks.stateDb.transaction(() => {
      const task = createTaskRecord(body, options);
      const operation = scheduler.create({
        taskId: task.id,
        idempotencyKey: dispatchIdempotencyKey(body, task.id),
        payload: { body, auditMeta }
      });
      if (operation.taskId !== task.id) {
        raced = operation;
        throw new Error(`dispatch idempotency key already belongs to task ${operation.taskId}`);
      }
      return operation;
    });
  } catch (error) {
    if (raced) return raced;
    throw error;
  }
}

async function executeDispatchOperation(
  options: HttpServerOptions,
  operation: OperationRecord,
  context: OperationExecutionContext
): Promise<void> {
  const payload = operation.payload as DispatchOperationPayload | undefined;
  if (!payload?.body || !payload.auditMeta) throw new Error("dispatch operation payload is incomplete");
  const task = options.tasks.find(operation.taskId);
  if (!task) throw new Error(`Unknown task: ${operation.taskId}`);

  let prepared = payload.prepared;
  if (!prepared) {
    prepared = await prepareDispatchLaunch(options, task, payload.body);
    context.checkpoint({ ...payload, prepared });
  }

  if (payload.launchStarted) {
    const live = (await options.adapter.listSessions()).find((session) => session.id === prepared.request.sessionId);
    if (!live) {
      throw new Error("dispatch outcome is ambiguous after restart; refusing a duplicate worker launch");
    }
    linkDispatchedTask(options, task.id, live.id, prepared.leaseId, prepared.request.labels?.parent);
    return;
  }

  const lease = options.worktrees.find(prepared.leaseId);
  if (!lease) throw new Error(`dispatch worktree lease disappeared: ${prepared.leaseId}`);
  await context.boundary("beforeLaunch");
  context.checkpoint({ ...payload, prepared, launchStarted: true });
  const result = await startManagedAgent(options, {
    request: prepared.request,
    worktreeLease: lease,
    projectRoot: payload.body.project,
    initialPromptSource: "agent",
    taskId: task.id,
    auditMeta: payload.auditMeta
  });
  await context.boundary("afterLaunch");
  linkDispatchedTask(options, task.id, result.session.id, lease.id, prepared.request.labels?.parent);
}

async function executeOperation(
  options: HttpServerOptions,
  operation: OperationRecord,
  context: OperationExecutionContext
): Promise<void> {
  if (operation.kind === "dispatch") {
    await executeDispatchOperation(options, operation, context);
    return;
  }
  if (operation.kind === "recovery") {
    if (!options.recoveryCoordinator) throw new Error("recovery coordinator is not configured");
    await options.recoveryCoordinator.execute(operation, context);
    return;
  }
  if (operation.kind === "continuation") {
    if (!options.recoveryContinuationCoordinator) {
      throw new Error("recovery continuation coordinator is not configured");
    }
    await options.recoveryContinuationCoordinator.execute(operation, context);
    return;
  }
  throw new Error(`unsupported operation kind: ${operation.kind}`);
}

async function recoverTaskRpc(
  taskId: string,
  body: Record<string, unknown>,
  options: HttpServerOptions,
  auditMeta: Pick<Parameters<AuditLog["write"]>[0], "deviceId" | "remoteAddress">
): Promise<RpcResult> {
  const task = options.tasks.find(taskId);
  if (!task) return rpcError(404, `Unknown task: ${taskId}`);
  if (!options.taskScheduler || !options.runtimeManager || !options.recoveryCoordinator) {
    return rpcError(501, "runtime recovery is not supported by this server");
  }
  const idempotencyError = idempotencyKeyError(body.idempotencyKey);
  if (idempotencyError) return rpcError(400, idempotencyError);
  const requestKey = typeof body.idempotencyKey === "string"
    ? `recovery:request:${body.idempotencyKey.trim()}`
    : undefined;
  const repeated = requestKey
    ? options.tasks.stateDb.operations.findByIdempotencyKey(requestKey)
    : undefined;
  if (repeated) {
    return resumeRecoveryOperation(task.id, repeated, options, options.taskScheduler);
  }
  const runtime = options.tasks.stateDb.runtimes.latestForTask(task.id);
  if (!runtime) return rpcError(409, `task ${task.id} has no durable runtime`);
  if (runtime.state === "live") {
    return rpcOk(200, { task: options.tasks.find(task.id), alreadyLive: true });
  }
  if (runtime.state === "recovering" || runtime.state === "starting") {
    return rpcError(409, `runtime recovery already in progress for ${task.id} g${runtime.generation}`);
  }
  if (runtime.state !== "recoverable") {
    return rpcError(409, `runtime ${task.id} g${runtime.generation} is ${runtime.state}, not recoverable`);
  }
  if (!task.runtime?.recoveryAvailable) {
    return rpcError(409, "provider session identity is missing or untrusted");
  }
  const key = requestKey ?? `recovery:${task.id}:g${runtime.generation}:${randomUUID()}`;
  const operation = options.taskScheduler.create({
    taskId: task.id,
    kind: "recovery",
    idempotencyKey: key,
    payload: { expectedGeneration: runtime.generation, auditMeta }
  });
  if (operation.taskId !== task.id || operation.kind !== "recovery") {
    return rpcError(409, "recovery idempotency key belongs to another operation");
  }
  return resumeRecoveryOperation(task.id, operation, options, options.taskScheduler);
}

async function resumeRecoveryOperation(
  taskId: string,
  operation: OperationRecord,
  options: HttpServerOptions,
  scheduler: TaskScheduler
): Promise<RpcResult> {
  if (operation.taskId !== taskId || operation.kind !== "recovery") {
    return rpcError(409, "recovery idempotency key belongs to another operation");
  }
  try {
    await scheduler.run(operation.id);
  } catch (error) {
    return rpcError(409, error instanceof Error ? error.message : String(error));
  }
  return rpcOk(200, { task: options.tasks.find(taskId), recovered: true });
}

type DispatchOperationPayload = {
  body: CreateTaskRequest;
  auditMeta: Pick<Parameters<AuditLog["write"]>[0], "deviceId" | "remoteAddress">;
  prepared?: { request: StartAgentRequest; leaseId: string };
  launchStarted?: boolean;
};

async function executeDispatchLaunch(
  options: HttpServerOptions,
  task: Task,
  body: CreateTaskRequest,
  auditMeta: Pick<Parameters<AuditLog["write"]>[0], "deviceId" | "remoteAddress">
): Promise<void> {
  const prepared = await prepareDispatchLaunch(options, task, body);
  const lease = options.worktrees.find(prepared.leaseId);
  if (!lease) throw new Error(`dispatch worktree lease disappeared: ${prepared.leaseId}`);
  const result = await startManagedAgent(options, {
    request: prepared.request,
    worktreeLease: lease,
    projectRoot: body.project,
    initialPromptSource: "agent",
    taskId: task.id,
    auditMeta
  });
  linkDispatchedTask(options, task.id, result.session.id, lease.id, prepared.request.labels?.parent);
}

async function prepareDispatchLaunch(
  options: HttpServerOptions,
  task: Task,
  body: CreateTaskRequest
): Promise<{ request: StartAgentRequest; leaseId: string }> {
  const namedTask = options.tasks.claimWorkerName(task.id);
  // Fleet dispatch defaults (`perch config`) fill omitted fields; explicit
  // per-task fields always win. With no explicit per-task override and no
  // configured defaults, the public built-in fallback prefers Codex on PATH
  // (the current Codex fallback at medium effort) and otherwise preserves the
  // historical Claude launch.
  // The model/effort describe the selected default agent as a unit: they never
  // leak onto an explicitly different agent.
  const configured = options.settings?.dispatchDefaults() ?? {};
  const codexAvailable = options.codexOnPath ?? codexResolvableOnPath;
  const builtInDefaults: DispatchDefaults = codexAvailable()
    ? await resolveAutomaticDispatchDefaults(options)
    : { agent: "claude" };
  const defaultAgent = configured.agent ?? builtInDefaults.agent ?? "claude";
  const agent = body.agent ?? defaultAgent;
  const configuredApplies = !configured.agent || configured.agent === agent;
  const builtInApplies = !builtInDefaults.agent || builtInDefaults.agent === agent;
  const model =
    body.model ?? (configuredApplies ? configured.model : undefined) ?? (builtInApplies ? builtInDefaults.model : undefined);
  const effort =
    body.effort ??
    (configuredApplies ? configured.effort : undefined) ??
    (builtInApplies ? builtInDefaults.effort : undefined);
  const lease = options.worktrees.findByHolder(task.id) ?? await options.worktrees.acquire(body.project, task.id);
  const prompt = body.prompt?.trim() || task.title;
  const kickoff = prompt + dispatchBrief(task, lease.path, agent);
  const request: StartAgentRequest = {
    command: agent,
    agent,
    sessionId: `pty:${randomUUID()}`,
    cwd: lease.path,
    title: `${agent} - ${task.title}`,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    labels: {
      task: task.id,
      ...(namedTask.workerName ? { workerName: namedTask.workerName } : {}),
      ...(body.parent ? { parent: body.parent } : {})
    },
    initialPrompt: kickoff
  };
  return { request, leaseId: lease.id };
}

function linkDispatchedTask(
  options: HttpServerOptions,
  taskId: string,
  sessionId: string,
  leaseId: string,
  parentSessionId?: string
): void {
  const task = options.tasks.find(taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  if (!task.sessionId) {
    options.tasks.update(taskId, {
      sessionId,
      worktreeId: leaseId,
      branch: `perch/${taskId}`,
      ...(parentSessionId ? { parentSessionId } : {})
    });
  } else if (task.sessionId !== sessionId) {
    throw new Error(`task ${taskId} is already linked to ${task.sessionId}`);
  }
  markTaskWorkingFromActivity(options, sessionId);
}

function recordDispatchFailure(options: HttpServerOptions, taskId: string, error: unknown): void {
  const task = options.tasks.find(taskId);
  if (!task || task.state === "failed") return;
  options.tasks.recordEvent(taskId, {
    kind: "failed",
    source: "system",
    message: `dispatch failed: ${error instanceof Error ? error.message : String(error)}`
  });
}

async function createTaskRpc(
  body: CreateTaskRequest,
  options: HttpServerOptions,
  auditPeer: Pick<Parameters<AuditLog["write"]>[0], "deviceId">
): Promise<RpcResult> {
  if (typeof body.title !== "string" || body.title.trim().length === 0) {
    return rpcError(400, "title required");
  }
  if (typeof body.project !== "string" || body.project.trim().length === 0) {
    return rpcError(400, "project required");
  }
  const resolvedProject = resolveDispatchProjectRoot(options.projects, body.project.trim());
  if ("error" in resolvedProject) {
    return rpcError(400, resolvedProject.error);
  }
  body.project = resolvedProject.rootPath;
  const idempotencyError = idempotencyKeyError(body.idempotencyKey);
  if (idempotencyError) return rpcError(400, idempotencyError);
  const kindError = taskKindCreationError(body.kind);
  if (kindError) return rpcError(400, kindError);
  const repeated = repeatedDispatchTask(body, options);
  if (repeated) {
    return rpcOk(201, { task: await resumeRepeatedDispatch(body, repeated, options) });
  }

  const legacyModeError = legacyModeCreationError(body.mode);
  if (legacyModeError) return rpcError(409, legacyModeError);

  if (body.dispatch === true && !options.adapter.startAgent) {
    return rpcError(501, "PTY agents are not supported by this server");
  }
  const task =
    body.dispatch === true
      ? await dispatchTaskWorker(options, body, auditPeer)
      : createTaskRecord(body, options);

  return rpcOk(201, { task: options.tasks.find(task.id) ?? task });
}

async function startAgentRpc(
  requestBody: StartAgentRequest,
  options: HttpServerOptions,
  auditPeer: Pick<Parameters<AuditLog["write"]>[0], "deviceId">
): Promise<RpcResult> {
  if (!options.adapter.startAgent) {
    return rpcError(501, "PTY agents are not supported by this server");
  }

  const result = await startManagedAgent(options, {
    request: requestBody,
    auditMeta: auditPeer
  });
  const responseBody: StartAgentResponse = { session: result.session };
  return rpcOk(201, responseBody);
}

// The fleet's one mate, started server-side: seed the neutral mate home
// (never a project directory - there is no directory to pick), then spawn
// exactly what `perch mate` (bin/perch.mjs) spawns. One mate per fleet: a
// live one answers 409 with its sessionId instead of a duplicate.
async function startMateRpc(
  body: MateStartRequest,
  options: HttpServerOptions,
  auditPeer: Pick<Parameters<AuditLog["write"]>[0], "deviceId" | "remoteAddress">
): Promise<RpcResult> {
  if (!options.adapter.startAgent) {
    return rpcError(501, "PTY agents are not supported by this server");
  }
  const sessions = options.monitor.withLiveState(await options.adapter.listSessions());
  const existing = sessions.find(
    (session) => session.labels?.role === "mate" && session.status !== "done" && session.status !== "error"
  );
  if (existing) {
    if (body.new === true) {
      return rpcError(409, `mate is already live as ${existing.id}; stop it before using --new`);
    }
    const runtime = options.ownerManager?.latestMate();
    if ((runtime?.state === "live" || runtime?.state === "recovering") && options.mateRecoveryCoordinator) {
      try {
        const recovery = await options.mateRecoveryCoordinator.recover(runtime);
        return rpcOk(200, {
          session: recovery.session,
          alreadyLive: true,
          recovery,
          mateOwner: options.ownerManager?.snapshot()
        });
      } catch (error) {
        return rpcError(409, error instanceof Error ? error.message : String(error));
      }
    }
    return { status: 409, body: { error: "mate already running", sessionId: existing.id } };
  }
  const prior = options.ownerManager?.latestMate();
  if (prior && prior.state !== "ended" && body.new !== true) {
    if (!options.mateRecoveryCoordinator) return rpcError(501, "mate recovery is not supported by this server");
    if (prior.state === "starting") {
      return rpcError(409, `mate recovery already in progress for generation ${prior.generation}`);
    }
    if (prior.state !== "recoverable" && prior.state !== "recovering") {
      return rpcError(409, `mate owner generation ${prior.generation} is ${prior.state}`);
    }
    try {
      const recovery = await options.mateRecoveryCoordinator.recover(prior);
      return rpcOk(200, {
        session: recovery.session,
        recovered: true,
        recovery,
        mateOwner: options.ownerManager?.snapshot()
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A recorded codex thread that never wrote a rollout can never be
      // resumed; left recoverable, every start would re-arm this same failure.
      // Retire that stale generation and fall through to a fresh mate launch
      // in this same request. Transient failures (and any other error shape)
      // keep the generation recoverable and still answer 409.
      const retired =
        prior.provider === "codex" && isCodexMissingRolloutResumeError(error)
          ? options.ownerManager?.retireUnrecoverableMate(prior.generation, message)
          : undefined;
      if (!retired) return rpcError(409, message);
    }
  }
  // Fleet mate defaults (`mate.*` via `perch config`) shape a fresh mate here just
  // as they do in `perch mate`, so starting one from the phone lands on the
  // same agent/model. Precedence mirrors dispatch: an explicit request field
  // wins, and a configured model/effort describes the DEFAULT agent's launch
  // as a unit - it never leaks onto an explicitly different agent.
  const defaults = options.settings?.mateDefaults() ?? {};
  const defaultAgent = defaults.agent ?? "claude";
  const agent = body.agent ?? defaultAgent;
  const launchDefaults = agent === defaultAgent ? defaults : {};
  const { model, effort } = await resolveMateLaunchNow(
    { agent, model: body.model ?? launchDefaults.model, effort: body.effort ?? launchDefaults.effort },
    options
  );
  const home = seedMateHome();
  try {
    // A freshly created Codex thread cannot be resumed by the native TUI until
    // its first acknowledged turn has materialized rollout-backed history.
    const result = await startManagedAgent(options, {
      request: {
        command: agent,
        agent,
        cwd: home,
        title: "mate",
        labels: { role: "mate" },
        ...(agent === "codex" ? { initialPrompt: CODEX_MATE_BOOTSTRAP_PROMPT } : {}),
        ...(Array.isArray(body.args) ? { args: body.args } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {})
      },
      auditMeta: auditPeer,
      ...(agent === "codex" ? { initialPromptSource: "agent" } : {}),
      ...(agent === "codex" ? { awaitInitialPromptCompletion: true } : {}),
      intentionalNewMate: body.new === true
    });
    return rpcOk(201, {
      session: result.session,
      fresh: true,
      mateOwner: options.ownerManager?.snapshot()
    });
  } catch (error) {
    return rpcError(409, error instanceof Error ? error.message : String(error));
  }
}

async function mateStatusRpc(options: HttpServerOptions): Promise<RpcResult> {
  const owner = options.ownerManager?.snapshot();
  const sessions = options.monitor.withLiveState(await options.adapter.listSessions());
  const session = owner?.ptySessionId
    ? sessions.find((candidate) => candidate.id === owner.ptySessionId)
    : sessions.find((candidate) => candidate.labels?.role === "mate");
  return rpcOk(200, { mateOwner: owner, ...(session ? { session } : {}) });
}

async function teardownTaskRpc(
  taskId: string,
  body: Record<string, unknown>,
  options: HttpServerOptions
): Promise<RpcResult> {
  const task = options.tasks.find(taskId);
  if (!task) {
    return rpcError(404, `Unknown task: ${taskId}`);
  }
  if (task.state === "closed") {
    return rpcOk(200, { task });
  }

  const force = body.force === true;
  let verdict: LandedVerdict | undefined;
  if (!force) {
    const ownLease = ownLeaseFor(task, options.worktrees);
    verdict = await landedGate(task, ownLease?.path, {
      verifiedPrelaunchDispatchFailure: isVerifiedPrelaunchDispatchFailure(task, options)
    });
    if (!verdict.landed) {
      return rpcError(409, `refusing teardown: ${verdict.reason}`);
    }
  }

  const updated = await executeTeardown(
    task,
    {
      tasks: options.tasks,
      worktrees: options.worktrees,
      adapter: options.adapter,
      auditLog: options.auditLog,
      runtimeManager: options.runtimeManager
    },
    { force, ...(verdict?.defaultBranch ? { defaultBranch: verdict.defaultBranch } : {}) }
  );
  return rpcOk(200, { task: updated });
}

// Longest a boss can type into the card's fix-instructions field; matches the
// message bound on the worker verbs.
const MAX_DECISION_INSTRUCTIONS_CHARS = 4000;

async function completionDecisionRpc(
  taskId: string,
  body: CompletionDecisionRequest,
  options: HttpServerOptions,
  auditPeer: Pick<Parameters<AuditLog["write"]>[0], "deviceId" | "remoteAddress">
): Promise<RpcResult> {
  const task = options.tasks.find(taskId);
  if (!task) return rpcError(404, `Unknown task: ${taskId}`);
  if (body.action !== "accept" && body.action !== "reject") {
    return rpcError(400, "action must be accept or reject");
  }
  if (!Number.isInteger(body.requestSeq) || body.requestSeq <= 0) {
    return rpcError(400, "requestSeq must be a positive integer");
  }
  if (typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim()) {
    return rpcError(400, "idempotencyKey must be a non-empty string");
  }
  if (body.idempotencyKey.length > 200) {
    return rpcError(400, "idempotencyKey is too long (max 200 characters)");
  }
  if (body.feedback !== undefined && typeof body.feedback !== "string") {
    return rpcError(400, "feedback must be a string");
  }
  const feedback = body.feedback?.trim();
  if (feedback && feedback.length > MAX_DECISION_INSTRUCTIONS_CHARS) {
    return rpcError(400, `feedback too long (max ${MAX_DECISION_INSTRUCTIONS_CHARS} characters)`);
  }
  if (body.action === "reject" && !feedback) {
    return rpcError(400, "feedback is required when rejecting completion");
  }

  const key = body.idempotencyKey.trim();
  const events = options.tasks.events(taskId);
  const duplicate = events.find((event) => {
    if (event.kind !== "completion_accepted" && event.kind !== "completion_rejected") return false;
    return (event.data as { completionDecision?: { idempotencyKey?: string } } | undefined)
      ?.completionDecision?.idempotencyKey === key;
  });
  if (duplicate) {
    const prior = (duplicate.data as {
      completionDecision?: { action?: string; requestSeq?: number; feedback?: string };
    }).completionDecision;
    if (
      prior?.action !== body.action ||
      prior.requestSeq !== body.requestSeq ||
      (prior.feedback ?? undefined) !== (feedback ?? undefined)
    ) {
      return rpcError(409, "idempotencyKey was already used for a different completion decision");
    }
    const responseBody: CompletionDecisionResponse = {
      ok: true,
      duplicate: true,
      task: options.tasks.find(taskId) ?? task
    };
    return rpcOk(200, responseBody);
  }

  const request = events.find((event) => event.seq === body.requestSeq);
  const latestRequest = [...events].reverse().find((event) => event.kind === "completion_requested");
  if (request?.kind !== "completion_requested" || latestRequest?.seq !== body.requestSeq) {
    return rpcError(409, "completion request is stale or unknown; re-read the task evidence");
  }
  if (task.state !== "completion_requested") {
    return rpcError(409, `Task is ${task.state}, not waiting for completion verification`);
  }

  if (body.action === "accept" && task.mode === undefined && task.kind === "ship") {
    const delivery = options.tasks.stateDb.delivery.find(task.id);
    const receipt = delivery ? options.tasks.stateDb.autoreview.find(delivery.receiptId) : undefined;
    const worktreePath = (task.worktreeId ? options.worktrees.find(task.worktreeId)?.path : undefined) ?? task.project;
    // The receipt's immutable base proves the reviewed diff. A later advance
    // of origin/main is GitHub branch-protection work, not a reason to make a
    // still-identical reviewed delivery impossible to accept.
    const current = receipt ? await freezeReviewTarget(worktreePath, receipt.baseOid).catch(() => undefined) : undefined;
    if (
      delivery?.state !== "created" || !task.pr?.headOid || delivery.headOid !== task.pr.headOid ||
      !receipt || !current || !receiptMatchesCurrentTarget(receipt, current)
    ) {
      return rpcError(409, "ship completion acceptance requires the current clean AutoReview receipt and server-created PR");
    }
  }
  if (body.action === "accept" && task.mode === undefined && task.kind !== "ship") {
    const requestedDeliverable = (request.data as { deliverable?: { kind?: unknown } } | undefined)?.deliverable;
    if (requestedDeliverable?.kind !== "report") {
      return rpcError(409, "scout and operate completion acceptance requires verified report evidence");
    }
  }

  // For local-only work the acceptance additionally records the checkout HEAD
  // the mate observed, so readiness derivation can refuse a deliverable that
  // moved between the request and the decision.
  let acceptedDeliverable: { kind: "local"; revision: string } | undefined;
  if (body.action === "accept" && task.mode === "local-only") {
    const revision = await options.prPoller.checkoutHead(task);
    if (revision) {
      acceptedDeliverable = { kind: "local", revision };
    }
    // The git call yielded the event loop, so the validated state may be gone:
    // a concurrent decision or worker retry must invalidate this one instead
    // of racing it into the ledger.
    const current = options.tasks.find(taskId);
    if (current?.state !== "completion_requested") {
      return rpcError(409, `Task is ${current?.state ?? "unknown"}, not waiting for completion verification`);
    }
    const latestNow = [...options.tasks.events(taskId)].reverse().find((event) => event.kind === "completion_requested");
    if (latestNow?.seq !== body.requestSeq) {
      return rpcError(409, "completion request is stale or unknown; re-read the task evidence");
    }
  }
  const decisionData = {
    completionDecision: {
      action: body.action,
      requestSeq: body.requestSeq,
      idempotencyKey: key,
      ...(feedback ? { feedback } : {}),
      ...(acceptedDeliverable ? { deliverable: acceptedDeliverable } : {})
    }
  };
  let updated: Task;
  try {
    updated = options.tasks.recordEvent(taskId, {
      kind: body.action === "accept" ? "completion_accepted" : "completion_rejected",
      source: "system",
      message: body.action === "accept" ? "mate verified the requested deliverable" : feedback,
      data: decisionData
    });
  } catch (error) {
    return rpcError(409, error instanceof Error ? error.message : String(error));
  }

  // A PR can merge while the mate is reviewing it. Preserve the landed and
  // auto-return semantics, but only publish merged after verification makes
  // done trustworthy.
  if (body.action === "accept" && updated.pr?.merged) {
    updated = options.tasks.recordEvent(taskId, {
      kind: "merged",
      source: "poller",
      message: updated.pr.url
    });
  }

  let feedbackDelivered = false;
  let queued = false;
  if (body.action === "reject" && feedback && task.sessionId) {
    try {
      const sessionId = canonicalSessionIdFor(options.adapter, task.sessionId);
      const sessions = await options.adapter.listSessions();
      const worker = sessions.find((session) => session.id === sessionId);
      if (worker && worker.status !== "done" && worker.status !== "error") {
        ({ queued } = await deliverInput(options, sessionId, `[perch] Completion rejected: ${feedback}`, "agent"));
        feedbackDelivered = true;
      }
    } catch {
      // The durable rejection and feedback remain in the task evidence. A
      // recovered worker or the mate can re-deliver them later.
    }
  }

  await audit(options.auditLog, {
    action: "task_completion_decision",
    ...auditPeer,
    taskId,
    sessionId: task.sessionId,
    textLength: feedback?.length
  });

  const responseBody: CompletionDecisionResponse = {
    ok: true,
    task: updated,
    ...(body.action === "reject" ? { feedbackDelivered, queued } : {})
  };
  return rpcOk(200, responseBody);
}

// Free a pool slot whose lease was orphaned: a session that died without a
// clean release, or a closed task's leftover tree. Live work is refused - a
// lease whose holder session is still running, or whose task is not closed,
// belongs to session stop / task teardown, never this verb. Without force the
// pool's own release gate applies verbatim (dirty or unlanded trees refuse
// with the gate's message); force discards the tree and frees the slot.
async function releaseWorktreeRpc(
  id: string,
  body: Record<string, unknown>,
  options: HttpServerOptions,
  auditPeer: Pick<Parameters<AuditLog["write"]>[0], "deviceId" | "remoteAddress">
): Promise<RpcResult> {
  const lease = options.worktrees.find(id);
  if (!lease) {
    return rpcError(404, `Unknown worktree: ${id}`);
  }
  if (lease.leasedBy) {
    const sessions = await options.adapter.listSessions();
    const holder = sessions.find((session) => session.id === lease.leasedBy);
    if (holder && holder.status !== "done" && holder.status !== "error") {
      return rpcError(
        409,
        `Worktree ${id} is leased by live session ${lease.leasedBy}; stop the session (or tear its task down) instead`
      );
    }
    // The task bound to THIS lease: holder is the worker session (or the task
    // itself pre-spawn). Task records keep worktreeId after release, so match
    // on the holder too - never refuse for a task whose lease this no longer is.
    const task = options.tasks
      .list()
      .find(
        (candidate) =>
          candidate.worktreeId === id &&
          (candidate.sessionId === lease.leasedBy || candidate.id === lease.leasedBy)
      );
    if (task && task.state !== "closed") {
      return rpcError(
        409,
        `Worktree ${id} belongs to task ${task.id} (${task.state}); use POST /tasks/${task.id}/teardown instead`
      );
    }
  }
  const force = body.force === true;
  try {
    await options.worktrees.release(id, { force });
  } catch (error) {
    return rpcError(409, error instanceof Error ? error.message : String(error));
  }
  await audit(options.auditLog, {
    action: "release_worktree",
    ...auditPeer,
    worktreeId: id,
    forced: force
  });
  return rpcOk(200, { ok: true, worktree: options.worktrees.find(id) });
}

async function switchModelRpc(
  sessionId: string,
  body: ModelSwitchRequest,
  options: HttpServerOptions,
  auditPeer: Pick<Parameters<AuditLog["write"]>[0], "deviceId">
): Promise<RpcResult> {
  const canonicalSessionId = canonicalSessionIdFor(options.adapter, sessionId);
  if (typeof body.model !== "string" || body.model.trim().length === 0) {
    return rpcError(400, "model must be a non-empty string");
  }
  if (isProviderPrefixedModelId(body.model)) {
    return rpcError(400, "model must be a local runtime id, not a provider gateway id");
  }
  if (options.monitor.pendingApproval(canonicalSessionId)) {
    return rpcError(409, "Resolve the open prompt before switching models");
  }
  const sessions = await options.adapter.listSessions();
  const agent = sessions.find((session) => session.id === canonicalSessionId)?.agent;
  if (!agent) {
    return rpcError(404, "Unknown session");
  }

  if (agent === "codex") {
    const armed = options.codexOwned?.switchModel(canonicalSessionId, body.model.trim(), body.effort);
    if (!armed) {
      return rpcError(409, "This Codex session is not connected to its app-server; model switching is unavailable");
    }
    const switched = resolveSessionModel("codex", { model: body.model.trim() });
    options.monitor.setSessionModel(canonicalSessionId, {
      model: switched.model,
      modelLabel: switched.modelLabel,
      ...(body.effort ? { effort: body.effort } : {})
    });
    await audit(options.auditLog, {
      action: "model",
      sessionId: canonicalSessionId,
      ...auditPeer,
      textLength: body.model.length
    });
    const responseBody: ModelSwitchResponse = { ok: true };
    return rpcOk(202, responseBody);
  }

  const landed = await runModelSwitchSteps(options.adapter, canonicalSessionId, agent, body.model.trim());
  await audit(options.auditLog, {
    action: "model",
    sessionId: canonicalSessionId,
    ...auditPeer,
    textLength: body.model.length
  });
  if (!landed) {
    return rpcError(504, MODEL_SWITCH_UNCONFIRMED);
  }
  const switched = resolveSessionModel(agent, { model: body.model.trim() });
  options.monitor.setSessionModel(canonicalSessionId, {
    model: switched.model,
    modelLabel: switched.modelLabel
  });
  const responseBody: ModelSwitchResponse = { ok: true };
  return rpcOk(202, responseBody);
}

// A switch the CLI never confirmed did not happen. Reporting it as applied is
// what let a following message be typed into the still-open confirm dialog and
// be consumed by it; the app aborts its send when the switch fails.
const MODEL_SWITCH_UNCONFIRMED =
  "The agent never confirmed the model switch; the session is still on its previous model";

// Drive the agent's keystroke model switch. Returns whether the CLI visibly
// applied it: a barriered submit that never sees its marker means the switch
// did not land (an unanswered dialog, a hung TUI, changed CLI copy). Adapters
// with no submitInput at all cannot report either way and stay lenient.
async function runModelSwitchSteps(
  adapter: AgentAdapter,
  sessionId: string,
  agent: AgentKind,
  model: string
): Promise<boolean> {
  for (const step of modelSwitchSteps(agent, model)) {
    if (step.kind === "submit") {
      const landed = await adapter.submitInput?.(sessionId, step.text, step.confirm);
      if (step.confirm && landed === false) {
        return false;
      }
    } else {
      await adapter.sendInput(sessionId, step.bytes);
      await new Promise((resolve) => setTimeout(resolve, step.settleMs));
    }
  }
  return true;
}

// The verbs a worker (or the phone) reports. Hook-token requests are pinned
// to the task's own session; pr_linked records PR identity without claiming
// completion, while done carrying a PR URL retains the compatibility path.
// Upper bound on a task event's structured data payload (~32 KB): plenty for
// a findings table, small enough that event rows stay cheap to store and read.
const MAX_TASK_EVENT_DATA_BYTES = 32 * 1024;
export const MAX_TASK_EVENT_MESSAGE_BYTES = 32 * 1024;

async function handleTaskEvent(
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpServerOptions,
  taskId: string
): Promise<void> {
  const task = options.tasks.find(taskId);
  if (!task) {
    writeJson(response, 404, { error: `Unknown task: ${taskId}` });
    return;
  }

  const bearer = authenticate(request, options);
  let source: "worker" | "system" = "system";
  if (bearer?.kind === "server" && request.headers["x-perch-root-session"] !== undefined) {
    const rootSessionId = String(request.headers["x-perch-root-session"] ?? "");
    const runtime = options.tasks.stateDb.runtimes.findBySession(rootSessionId);
    if (!rootSessionId || task.sessionId !== rootSessionId || runtime?.agent !== "codex") {
      writeJson(response, 401, { error: "Unauthorized" });
      return;
    }
    source = "worker";
  } else if (!bearer) {
    const presentedSessionId = String(request.headers["x-perch-session"] ?? "");
    const token = String(request.headers["x-perch-token"] ?? "");
    // Verification is against the presented (possibly spawn-time) identity;
    // the alias maps a rebound daemon's stale env credentials to the live
    // session the task now runs under.
    const sessionId = options.hooks.resolveAlias(presentedSessionId);
    const runtime = options.tasks.stateDb.runtimes.findBySession(sessionId);
    const reason = !presentedSessionId || !token
      ? "missing_credentials"
      : !options.hooks.verify(presentedSessionId, token)
        ? "invalid_credentials"
        : task.sessionId !== sessionId
          ? "task_session_mismatch"
          : runtime?.agent === "codex" && !allowsLegacyCodexHookReporting(runtime.metadata)
            ? "root_thread_required"
          : undefined;
    if (reason) {
      // curl -f intentionally hides the response body from workers. Keep the
      // rejection visible in server.log without ever printing the hook token.
      console.warn(
        `task-event: rejected status=401 task=${taskId} session=${presentedSessionId ? presentedSessionId.slice(0, 16) : "missing"} reason=${reason}`
      );
      writeJson(response, 401, { error: "Unauthorized" });
      return;
    }
    source = "worker";
  }

  const body = await readJson<TaskEventRequest>(request);
  const allowed: TaskEventKind[] = ["working", "pr_linked", "needs_decision", "blocked", "done", "failed", "note"];
  if (!allowed.includes(body.kind)) {
    writeJson(response, 400, { error: `kind must be one of ${allowed.join(", ")}` });
    return;
  }
  const message = typeof body.message === "string" ? body.message : undefined;
  if (message !== undefined) {
    const messageBytes = Buffer.byteLength(message, "utf8");
    if (messageBytes > MAX_TASK_EVENT_MESSAGE_BYTES) {
      writeJson(response, 413, {
        error:
          `message too large: ${messageBytes} bytes (max ${MAX_TASK_EVENT_MESSAGE_BYTES}); ` +
          "resubmit a shorter report or send a supplemental note"
      });
      return;
    }
  }
  let prUrl = typeof body.pr === "string" ? body.pr.trim() : body.kind === "done" ? extractPrUrl(message) : undefined;
  let pr: TaskPr | undefined;
  const legacyTask = task.mode !== undefined;
  // New ship tasks may only get their PR identity from delivery_create_pr.
  // Legacy records retain the old discovery path strictly for recovery.
  const requiresPr = legacyTask ? task.kind !== "scout" && task.mode !== "local-only" : task.kind === "ship";
  if (body.kind === "pr_linked" && source !== "worker") {
    writeJson(response, 401, { error: "pr_linked requires task-session credentials" });
    return;
  }
  if (body.kind === "pr_linked" && !requiresPr) {
    writeJson(response, 409, { error: "PR links are only valid for remote ship tasks" });
    return;
  }
  if (body.kind === "pr_linked" && !legacyTask) {
    writeJson(response, 409, { error: "ship PRs are created and linked only by perch.delivery_create_pr" });
    return;
  }
  if (body.kind === "pr_linked" && !prUrl) {
    writeJson(response, 400, { error: "pr is required for pr_linked" });
    return;
  }
  if (body.kind === "done" && !legacyTask && task.kind !== "ship" && prUrl) {
    writeJson(response, 409, { error: "scout and operate tasks cannot attach a code PR" });
    return;
  }
  if (body.kind === "done" && !legacyTask && task.kind === "ship") {
    const delivery = options.tasks.stateDb.delivery.find(task.id);
    const receipt = delivery ? options.tasks.stateDb.autoreview.find(delivery.receiptId) : undefined;
    const worktreePath = (task.worktreeId ? options.worktrees.find(task.worktreeId)?.path : undefined) ?? task.project;
    const current = receipt ? await freezeReviewTarget(worktreePath, receipt.baseOid).catch(() => undefined) : undefined;
    if (
      delivery?.state !== "created" || !task.pr?.url || !task.pr.headOid || delivery.headOid !== task.pr.headOid ||
      !receipt || !current || !receiptMatchesCurrentTarget(receipt, current)
    ) {
      writeJson(response, 409, { error: "ship completion requires a matching server-created PR and clean AutoReview receipt" });
      return;
    }
    prUrl = task.pr.url;
  } else if (body.kind === "done" && requiresPr && !prUrl) {
    if (task.pr?.url) {
      prUrl = task.pr.url;
    } else if (task.branch) {
      const discovered = await options.prPoller.discoverTaskPr(task);
      if (!discovered.ok) {
        writeJson(response, 409, { error: discovered.reason });
        return;
      }
      prUrl = discovered.prUrl;
    }
  }
  if (body.kind === "pr_linked" && prUrl) {
    const checkoutPath = (task.worktreeId ? options.worktrees.find(task.worktreeId)?.path : undefined) ?? task.project;
    const attachment = await options.prPoller.resolveTaskPr(task, prUrl, checkoutPath);
    if (!attachment.ok) {
      writeJson(response, 409, { error: attachment.reason });
      return;
    }
    pr = attachment.pr;
  }
  if (body.kind === "done" && requiresPr && prUrl && legacyTask) {
    const checkoutPath = (task.worktreeId ? options.worktrees.find(task.worktreeId)?.path : undefined) ?? task.project;
    const attachment = await options.prPoller.resolveTaskPr(task, prUrl, checkoutPath);
    if (!attachment.ok) {
      writeJson(response, 409, { error: attachment.reason });
      return;
    }
    pr = attachment.pr;
  }

  // Structured payload: persisted onto the event verbatim, bounded so one
  // verb cannot bloat the ledger or the fan-out to phones and the mate.
  let data: Record<string, unknown> | undefined;
  if (body.data !== undefined) {
    if (body.data === null || typeof body.data !== "object" || Array.isArray(body.data)) {
      writeJson(response, 400, { error: "data must be a JSON object" });
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(body.data), "utf8");
    if (bytes > MAX_TASK_EVENT_DATA_BYTES) {
      writeJson(response, 400, {
        error: `data too large: ${bytes} bytes (max ${MAX_TASK_EVENT_DATA_BYTES})`
      });
      return;
    }
    data = body.data;
  }

  let linked = false;
  let updated: Task | undefined;
  if (pr) {
    try {
      const result = options.tasks.linkPr(taskId, pr, {
        source,
        message: pr.url,
        data: {
          ...(data ?? {}),
          pr: {
            url: pr.url,
            ...(pr.number !== undefined ? { number: pr.number } : {}),
            ...(pr.repo ? { repo: pr.repo } : {}),
            ...(pr.headRepo ? { headRepo: pr.headRepo } : {}),
            ...(pr.head ? { head: pr.head } : {}),
            ...(pr.headOid ? { headOid: pr.headOid } : {})
          }
        }
      });
      updated = result.task;
      linked = result.linked;
    } catch (error) {
      writeJson(response, 409, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
  }

  if (linked) {
    // PR identity is useful before completion. Start tracking the newly
    // durable fact immediately, then let polling update only PR observations.
    options.prPoller.armFast(taskId);
    void options.prPoller.tick().catch(() => {});
  }

  if (body.kind === "pr_linked") {
    writeJson(response, 200, { task: updated ?? options.tasks.find(taskId) ?? task });
    return;
  }

  try {
    // Keep the worker's long-standing `done` wire verb, but interpret every
    // report as a completion claim. Trusted done is created only by the mate's
    // explicit /completion accept action.
    const kind = body.kind === "done" ? "completion_requested" : body.kind;
    // Bind the completion claim to the exact deliverable inside the event
    // itself. A later PR head observation cannot inherit this acceptance. The
    // task is re-read after the awaits above so the deliverable reflects
    // current facts, not the handler-entry snapshot.
    const current = options.tasks.find(taskId) ?? task;
    let eventData = data;
    if (kind === "completion_requested") {
      const attachedPr = pr ? { ...current.pr, ...pr } : current.pr;
      const revision = current.mode === "local-only" ? await options.prPoller.checkoutHead(current) : undefined;
      // A local deliverable pins an exact commit or nothing: an unreadable
      // checkout HEAD leaves the revision absent, and readiness derivation
      // stays conservatively withheld rather than trusting a branch name.
      const deliverable = current.mode === "local-only"
        ? { kind: "local", ...(revision ? { revision } : {}) }
        : !legacyTask && current.kind !== "ship"
          ? { kind: "report" }
          : { kind: "pr", headOid: attachedPr?.headOid };
      eventData = { ...(data ?? {}), deliverable };
    }
    updated = options.tasks.recordEvent(taskId, { kind, message, source, ...(eventData ? { data: eventData } : {}) });
  } catch (error) {
    writeJson(response, 409, { error: error instanceof Error ? error.message : String(error) });
    return;
  }

  writeJson(response, 200, { task: updated });
}

function allowsLegacyCodexHookReporting(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.codexTaskReportingMode === "legacy_hook_compat" && isProvenLegacyChildDisabled(metadata);
}

// Lossless report bounds. Density is preserved byte-for-byte within these
// explicit limits; oversize submissions are rejected loudly (413), never
// silently truncated. Larger artifacts belong in repo files referenced from
// the report by path or content hash.
export const MAX_WORKER_REPORT_SUMMARY_BYTES = 4 * 1024;
export const MAX_WORKER_REPORT_BODY_BYTES = 256 * 1024;
export const MAX_WORKER_REPORT_EVIDENCE_BYTES = 256 * 1024;
// Routing summaries in mailbox list/wait responses are clipped to this many
// characters (flagged summaryTruncated); read_message always returns the
// untruncated original.
const MAILBOX_SUMMARY_CHARS = 2_000;
// A mailbox claim leases the message to the current mate generation for this
// long; an expired lease returns the message to pending automatically.
const MAILBOX_CLAIM_TTL_MS = 10 * 60_000;
const MAILBOX_WAIT_MAX_SECONDS = 30;

// Worker identity ladder for report submission, mirroring handleTaskEvent:
// the Codex root-tool relay (server bearer + verified root session) or the
// task session's own hook credential (with the root_thread_required gate).
// There is no bearer/system fallback - reports are worker-authored only.
function authenticateWorkerReport(
  request: IncomingMessage,
  options: HttpServerOptions,
  task: Task
): { sessionId: string } | { status: number; error: string } {
  const bearer = authenticate(request, options);
  if (bearer?.kind === "server" && request.headers["x-perch-root-session"] !== undefined) {
    const rootSessionId = String(request.headers["x-perch-root-session"] ?? "");
    const runtime = options.tasks.stateDb.runtimes.findBySession(rootSessionId);
    if (!rootSessionId || task.sessionId !== rootSessionId || runtime?.agent !== "codex") {
      return { status: 401, error: "Unauthorized" };
    }
    return { sessionId: rootSessionId };
  }
  if (bearer) return { status: 401, error: "worker reports require task-session credentials" };
  const presentedSessionId = String(request.headers["x-perch-session"] ?? "");
  const token = String(request.headers["x-perch-token"] ?? "");
  const sessionId = options.hooks.resolveAlias(presentedSessionId);
  const runtime = options.tasks.stateDb.runtimes.findBySession(sessionId);
  const reason = !presentedSessionId || !token
    ? "missing_credentials"
    : !options.hooks.verify(presentedSessionId, token)
      ? "invalid_credentials"
      : task.sessionId !== sessionId
        ? "task_session_mismatch"
        : runtime?.agent === "codex" && !allowsLegacyCodexHookReporting(runtime.metadata)
          ? "root_thread_required"
        : undefined;
  if (reason) {
    console.warn(
      `worker-report: rejected status=401 task=${task.id} session=${presentedSessionId ? presentedSessionId.slice(0, 16) : "missing"} reason=${reason}`
    );
    return { status: 401, error: "Unauthorized" };
  }
  return { sessionId };
}

type AutoReviewRunRequest = {
  baseRef?: unknown;
  idempotencyKey?: unknown;
  testArgv?: unknown;
  authorDispositions?: unknown;
  supersedesAttemptId?: unknown;
};

async function handleAutoReviewRun(
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpServerOptions,
  taskId: string
): Promise<void> {
  const task = options.tasks.find(taskId);
  if (!task) return writeJson(response, 404, { error: `Unknown task: ${taskId}` });
  const auth = authenticateWorkerReport(request, options, task);
  if ("error" in auth) return writeJson(response, auth.status, { error: auth.error });
  const runtime = options.tasks.stateDb.runtimes.findBySession(auth.sessionId);
  if (!runtime || runtime.taskId !== task.id || runtime.state !== "live") {
    return writeJson(response, 409, { error: "AutoReview requires the task's current live root runtime" });
  }
  const body = await readJson<AutoReviewRunRequest>(request);
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  const testArgv = Array.isArray(body.testArgv) && body.testArgv.every((part) => typeof part === "string") ? body.testArgv : [];
  const baseRef = typeof body.baseRef === "string" && body.baseRef.trim() ? body.baseRef.trim() : "origin/main";
  const authorDispositions = Array.isArray(body.authorDispositions) && body.authorDispositions.every(isRecord)
    ? body.authorDispositions as Array<Record<string, unknown>>
    : undefined;
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return writeJson(response, 400, { error: "idempotencyKey must be a non-empty string up to 200 characters" });
  }
  if (testArgv.length === 0) return writeJson(response, 400, { error: "testArgv must be a non-empty argv array" });
  const worktreePath = (task.worktreeId ? options.worktrees.find(task.worktreeId)?.path : undefined) ?? runtime.worktreePath ?? task.project;
  if (runtime.worktreePath && resolvePath(runtime.worktreePath) !== resolvePath(worktreePath)) {
    return writeJson(response, 409, { error: "AutoReview runtime worktree does not match the authorized task worktree" });
  }
  try {
    const result = await new AutoReviewService(options.tasks.stateDb).run({
      task, runtime, sessionId: auth.sessionId, worktreePath, baseRef,
      idempotencyKey: `autoreview:${task.id}:${idempotencyKey}`, testArgv, authorDispositions,
      ...(typeof body.supersedesAttemptId === "string" ? { supersedesAttemptId: body.supersedesAttemptId } : {})
    });
    options.tasks.recordEvent(task.id, {
      kind: "note", source: "system", message: `AutoReview ${result.attempt.state}`,
      data: { autoreview: { attemptId: result.attempt.id, state: result.attempt.state, findings: result.attempt.findings.length } }
    });
    writeJson(response, 200, { attempt: publicAutoReviewAttempt(result.attempt), duplicate: result.duplicate });
  } catch (error) {
    writeJson(response, 409, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleDeliveryCreatePr(
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpServerOptions,
  taskId: string
): Promise<void> {
  const task = options.tasks.find(taskId);
  if (!task) return writeJson(response, 404, { error: `Unknown task: ${taskId}` });
  const auth = authenticateWorkerReport(request, options, task);
  if ("error" in auth) return writeJson(response, auth.status, { error: auth.error });
  const runtime = options.tasks.stateDb.runtimes.findBySession(auth.sessionId);
  if (!runtime || runtime.taskId !== task.id || runtime.state !== "live") {
    return writeJson(response, 409, { error: "delivery requires the task's current live root runtime" });
  }
  const body = await readJson<{ idempotencyKey?: unknown }>(request);
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return writeJson(response, 400, { error: "idempotencyKey must be a non-empty string up to 200 characters" });
  }
  const worktreePath = (task.worktreeId ? options.worktrees.find(task.worktreeId)?.path : undefined) ?? runtime.worktreePath ?? task.project;
  if (runtime.worktreePath && resolvePath(runtime.worktreePath) !== resolvePath(worktreePath)) {
    return writeJson(response, 409, { error: "delivery runtime worktree does not match the authorized task worktree" });
  }
  try {
    const result = await new DeliveryService(options.tasks.stateDb).createPr({
      task, runtime, worktreePath, idempotencyKey: `delivery:${task.id}:${idempotencyKey}`
    });
    const linked = options.tasks.linkPr(task.id, result.pr, {
      source: "system", message: result.pr.url,
      data: { delivery: { receiptId: result.receipt.id, idempotent: result.duplicate } }
    });
    options.prPoller.armFast(task.id);
    void options.prPoller.tick().catch(() => {});
    writeJson(response, 200, { task: linked.task, pr: result.pr, receipt: publicAutoReviewAttempt(result.receipt), duplicate: result.duplicate });
  } catch (error) {
    writeJson(response, 409, { error: error instanceof Error ? error.message : String(error) });
  }
}

function publicAutoReviewAttempt(attempt: import("./stateDb.js").AutoReviewAttemptRecord): Record<string, unknown> {
  return {
    id: attempt.id, state: attempt.state, baseOid: attempt.baseOid, headOid: attempt.headOid, treeOid: attempt.treeOid,
    diffSha256: attempt.diffSha256, findings: attempt.findings, requested: {
      engine: attempt.requestedEngine, model: attempt.requestedModel, reasoning: attempt.requestedReasoning
    }, actual: {
      engine: attempt.actualEngine, model: attempt.actualModel, reasoning: attempt.actualReasoning, fallback: attempt.fallbackReason
    }, ...(attempt.failureCode ? { failureCode: attempt.failureCode } : {})
  };
}

async function handleWorkerReport(
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpServerOptions,
  taskId: string
): Promise<void> {
  const task = options.tasks.find(taskId);
  if (!task) {
    writeJson(response, 404, { error: `Unknown task: ${taskId}` });
    return;
  }
  const auth = authenticateWorkerReport(request, options, task);
  if ("error" in auth) {
    writeJson(response, auth.status, { error: auth.error });
    return;
  }

  let body: WorkerReportRequest;
  try {
    body = await readJson<WorkerReportRequest>(request);
  } catch {
    writeJson(response, 400, { error: "request body must be JSON" });
    return;
  }
  if (typeof body.summary !== "string" || !body.summary.trim()) {
    writeJson(response, 400, { error: "summary is required" });
    return;
  }
  if (typeof body.report !== "string" || !body.report.trim()) {
    writeJson(response, 400, { error: "report is required" });
    return;
  }
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (!idempotencyKey || idempotencyKey.length > 200) {
    writeJson(response, 400, { error: "idempotencyKey is required (at most 200 characters)" });
    return;
  }
  const format = typeof body.format === "string" && body.format.trim() ? body.format.trim() : "markdown";
  if (format.length > 64) {
    writeJson(response, 400, { error: "format must be at most 64 characters" });
    return;
  }
  const summaryBytes = Buffer.byteLength(body.summary, "utf8");
  if (summaryBytes > MAX_WORKER_REPORT_SUMMARY_BYTES) {
    writeJson(response, 413, {
      error: `summary too large: ${summaryBytes} bytes (max ${MAX_WORKER_REPORT_SUMMARY_BYTES}); the summary routes, the report carries the content`
    });
    return;
  }
  const reportBytes = Buffer.byteLength(body.report, "utf8");
  if (reportBytes > MAX_WORKER_REPORT_BODY_BYTES) {
    writeJson(response, 413, {
      error: `report too large: ${reportBytes} bytes (max ${MAX_WORKER_REPORT_BODY_BYTES}); commit large artifacts to the branch and reference them by path or content hash - nothing is truncated server-side`
    });
    return;
  }
  let evidence: Record<string, unknown> | undefined;
  if (body.evidence !== undefined) {
    if (body.evidence === null || typeof body.evidence !== "object" || Array.isArray(body.evidence)) {
      writeJson(response, 400, { error: "evidence must be a JSON object" });
      return;
    }
    const evidenceBytes = Buffer.byteLength(JSON.stringify(body.evidence), "utf8");
    if (evidenceBytes > MAX_WORKER_REPORT_EVIDENCE_BYTES) {
      writeJson(response, 413, {
        error: `evidence too large: ${evidenceBytes} bytes (max ${MAX_WORKER_REPORT_EVIDENCE_BYTES}); reference larger artifacts by path or content hash - nothing is truncated server-side`
      });
      return;
    }
    evidence = body.evidence;
  }

  try {
    const result = options.tasks.recordWorkerReport(taskId, {
      sessionId: auth.sessionId,
      idempotencyKey,
      format,
      summary: body.summary,
      report: body.report,
      ...(evidence ? { evidence } : {})
    });
    writeJson(response, 200, {
      reportId: result.report.id,
      duplicate: result.duplicate,
      reportBytes: result.report.reportBytes,
      reportSha256: result.report.reportSha256
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJson(response, message.includes("idempotency key") ? 409 : 500, { error: message });
  }
}

// Claim/acknowledge identity: the live mate generation's own hook credential.
// Mechanical refusals: workers and native children (session mismatch), paired
// devices and bearer callers (no hook credential), superseded mate sessions
// (alias/session mismatch), and stale generations (compare-and-swap at ack).
function authenticateMateMailbox(
  request: IncomingMessage,
  options: HttpServerOptions
): { sessionId: string; generation: number } | { status: number; error: string } {
  const presentedSessionId = String(request.headers["x-perch-session"] ?? "");
  const token = String(request.headers["x-perch-token"] ?? "");
  if (!presentedSessionId || !token) {
    return { status: 401, error: "mate mailbox access requires the mate session's hook credentials" };
  }
  if (!options.hooks.verify(presentedSessionId, token)) {
    return { status: 401, error: "Unauthorized" };
  }
  const sessionId = options.hooks.resolveAlias(presentedSessionId);
  const mate = options.ownerManager?.latestMate();
  if (!mate || mate.state !== "live") {
    return { status: 409, error: "no live mate generation is registered" };
  }
  if (!mate.ptySessionId || mate.ptySessionId !== sessionId) {
    return { status: 403, error: "mailbox claims are restricted to the live mate session" };
  }
  return { sessionId, generation: mate.generation };
}

// Routing projection: a stable pointer plus safe metadata. Never the report
// body; the summary is clipped (and flagged) when long.
function mailboxMessageProjection(
  options: HttpServerOptions,
  record: MateMailboxDeliveryRecord,
  withClaim: boolean
): MateMailboxMessage {
  const event = options.tasks.stateDb.tasks.eventById(record.taskEventId);
  const report = record.reportId ? options.tasks.stateDb.workerReports.find(record.reportId) : undefined;
  const fullSummary = report?.summary ?? event?.message ?? "";
  const truncated = fullSummary.length > MAILBOX_SUMMARY_CHARS;
  const task = options.tasks.find(record.taskId);
  return {
    id: record.id,
    taskId: record.taskId,
    ...(task?.workerName ? { workerName: task.workerName } : {}),
    kind: event?.kind ?? "note",
    taskEventSeq: event?.seq ?? 0,
    orderKey: record.taskEventId,
    state: record.state,
    ...(fullSummary
      ? { summary: truncated ? fullSummary.slice(0, MAILBOX_SUMMARY_CHARS) : fullSummary }
      : {}),
    ...(truncated ? { summaryTruncated: true } : {}),
    ...(record.reportId ? { reportId: record.reportId } : {}),
    at: event?.at ?? record.createdAt,
    ...(withClaim && record.claimToken ? { claimToken: record.claimToken } : {}),
    ...(withClaim && record.claimExpiresAt ? { claimExpiresAt: record.claimExpiresAt } : {})
  };
}

async function routeMateMailbox(
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpServerOptions,
  pathname: string,
  url: URL
): Promise<void> {
  const mailbox = options.tasks.stateDb.mateMailbox;

  // Non-mutating observability: the boss (server/device bearer) or the mate
  // may list. Listing never claims and never acknowledges.
  if (request.method === "GET" && pathname === "/mate/mailbox") {
    const bearer = authenticate(request, options);
    const mateAuth = bearer ? undefined : authenticateMateMailbox(request, options);
    if (!bearer && mateAuth && "error" in mateAuth) {
      writeJson(response, mateAuth.status, { error: mateAuth.error });
      return;
    }
    const includeAcknowledged = url.searchParams.get("includeAcknowledged") === "1";
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const messages = mailbox
      .list({ includeAcknowledged, limit: Number.isFinite(limit) ? limit : 100 })
      .map((record) => mailboxMessageProjection(options, record, false));
    writeJson(response, 200, { messages, pending: mailbox.pendingCount(new Date().toISOString()) });
    return;
  }

  // read_messages: claim the oldest unacknowledged messages for the live mate
  // generation. Tokens are (re)minted per call; stale tokens can never ack.
  if (request.method === "POST" && pathname === "/mate/mailbox/read") {
    const auth = authenticateMateMailbox(request, options);
    if ("error" in auth) {
      writeJson(response, auth.status, { error: auth.error });
      return;
    }
    const body = await readJsonOrEmpty<{ limit?: number }>(request);
    const limit = Number.isInteger(body.limit) && (body.limit as number) > 0 ? (body.limit as number) : 10;
    const now = new Date().toISOString();
    const claimed = mailbox.claim({ generation: auth.generation, limit, ttlMs: MAILBOX_CLAIM_TTL_MS, now });
    writeJson(response, 200, {
      messages: claimed.map((record) => mailboxMessageProjection(options, record, true)),
      pending: mailbox.pendingCount(new Date().toISOString())
    });
    return;
  }

  // wait_for_messages: a bounded latency optimization over the same durable
  // mailbox - never the correctness layer. Returns immediately when anything
  // is pending, empty on timeout; a lost wait loses nothing.
  if (request.method === "GET" && pathname === "/mate/mailbox/wait") {
    const auth = authenticateMateMailbox(request, options);
    if ("error" in auth) {
      writeJson(response, auth.status, { error: auth.error });
      return;
    }
    const requested = Number(url.searchParams.get("timeoutSeconds") ?? 25);
    const timeoutSeconds = Math.max(0, Math.min(Number.isFinite(requested) ? requested : 25, MAILBOX_WAIT_MAX_SECONDS));
    const deadline = Date.now() + timeoutSeconds * 1000;
    // The socket can disappear mid-wait (client gone, server shutdown). A
    // vanished waiter must cost nothing: stop polling and never write to a
    // dead response - the durable mailbox still holds every message.
    try {
      for (;;) {
        const now = new Date().toISOString();
        if (mailbox.pendingCount(now) > 0) {
          if (response.writableEnded || request.destroyed) return;
          const messages = mailbox.list({ limit: 50 }).map((record) => mailboxMessageProjection(options, record, false));
          writeJson(response, 200, { messages, timedOut: false });
          return;
        }
        if (Date.now() >= deadline || response.writableEnded || request.destroyed) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
      }
      if (!response.writableEnded && !request.destroyed) writeJson(response, 200, { messages: [], timedOut: true });
    } catch {
      // A torn-down socket while replying is a disconnect, not a server fault.
    }
    return;
  }

  // read_message: the original full report and evidence, byte-for-byte, plus
  // the full source event. The mate (or the boss over bearer auth) reads here
  // before semantic acknowledgment.
  const messageMatch = pathname.match(/^\/mate\/mailbox\/message\/([^/]+)$/);
  if (request.method === "GET" && messageMatch) {
    const bearer = authenticate(request, options);
    const mateAuth = bearer ? undefined : authenticateMateMailbox(request, options);
    if (!bearer && mateAuth && "error" in mateAuth) {
      writeJson(response, mateAuth.status, { error: mateAuth.error });
      return;
    }
    const record = mailbox.find(decodeURIComponent(messageMatch[1] ?? ""));
    if (!record) {
      writeJson(response, 404, { error: "Unknown mailbox message" });
      return;
    }
    const event = options.tasks.stateDb.tasks.eventById(record.taskEventId);
    const report = record.reportId ? options.tasks.stateDb.workerReports.find(record.reportId) : undefined;
    writeJson(response, 200, {
      message: mailboxMessageProjection(options, record, false),
      ...(event ? { event } : {}),
      ...(report
        ? {
            report: {
              id: report.id,
              taskId: report.taskId,
              sessionId: report.sessionId,
              ...(report.runtimeId ? { runtimeId: report.runtimeId } : {}),
              ...(report.runtimeGeneration !== undefined ? { runtimeGeneration: report.runtimeGeneration } : {}),
              ...(report.workerName ? { workerName: report.workerName } : {}),
              format: report.format,
              summary: report.summary,
              report: report.report,
              ...(report.evidence ? { evidence: report.evidence } : {}),
              reportBytes: report.reportBytes,
              reportSha256: report.reportSha256,
              acceptedAt: report.acceptedAt
            }
          }
        : {})
    });
    return;
  }

  // ack_message / ack_messages: idempotent semantic acknowledgment, fenced by
  // claim token + live generation. Acknowledgment marks mailbox processing
  // only - trusted task completion still requires POST /tasks/:id/completion.
  if (request.method === "POST" && pathname === "/mate/mailbox/ack") {
    const auth = authenticateMateMailbox(request, options);
    if ("error" in auth) {
      writeJson(response, auth.status, { error: auth.error });
      return;
    }
    type AckEntry = { id?: string; claimToken?: string; idempotencyKey?: string; disposition?: string };
    const body = await readJsonOrEmpty<{ acks?: AckEntry[] } & AckEntry>(request);
    const entries: AckEntry[] = Array.isArray(body.acks) ? body.acks : [body];
    if (entries.length === 0 || entries.length > 50) {
      writeJson(response, 400, { error: "acks must contain between 1 and 50 entries" });
      return;
    }
    const results = entries.map((entry) => {
      if (!entry.id || typeof entry.id !== "string") return { id: entry.id ?? "", outcome: "invalid", error: "id is required" };
      if (!entry.claimToken || typeof entry.claimToken !== "string") {
        return { id: entry.id, outcome: "invalid", error: "claimToken is required" };
      }
      const key = typeof entry.idempotencyKey === "string" ? entry.idempotencyKey.trim() : "";
      if (!key || key.length > 200) {
        return { id: entry.id, outcome: "invalid", error: "idempotencyKey is required (at most 200 characters)" };
      }
      const disposition =
        typeof entry.disposition === "string" && entry.disposition.trim()
          ? entry.disposition.trim().slice(0, 200)
          : undefined;
      const result = options.tasks.stateDb.mateMailbox.ack({
        id: entry.id,
        claimToken: entry.claimToken,
        generation: auth.generation,
        idempotencyKey: key,
        ...(disposition ? { disposition } : {}),
        sessionId: auth.sessionId,
        now: new Date().toISOString()
      });
      switch (result.outcome) {
        case "acknowledged":
          return { id: entry.id, outcome: "acknowledged", duplicate: result.duplicate };
        case "not_found":
          return { id: entry.id, outcome: "error", error: "unknown mailbox message" };
        case "ack_conflict":
          return { id: entry.id, outcome: "error", error: "already acknowledged with a different idempotency key" };
        case "not_claimed":
          return { id: entry.id, outcome: "error", error: "message is not claimed; read_messages first" };
        case "stale_token":
          return { id: entry.id, outcome: "error", error: "claim token is stale or expired; read_messages again" };
        case "stale_generation":
          return { id: entry.id, outcome: "error", error: "claim belongs to a different mate generation; read_messages again" };
      }
    });
    writeJson(response, 200, { results });
    return;
  }

  writeJson(response, 404, { error: "Not found" });
}

function canonicalPolicyPath(path: unknown): string {
  if (typeof path !== "string" || path.trim().length === 0) return "";
  const resolved = resolvePath(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function boundedPolicyString(value: unknown, maxLength: number): string {
  return typeof value === "string" && value.length <= maxLength ? value.trim() : "";
}

// Resolve a client-supplied project reference to a tracked project: an exact
// rootPath match first (paths are resolved before comparison), else a unique
// name match. An ambiguous name (two tracked projects share it) or no match
// returns undefined, which the caller turns into a 400.
function resolveTrackedProject(projects: ProjectRegistry, ref: string): Project | undefined {
  const byPath = projects.find(ref);
  if (byPath) {
    return byPath;
  }
  const byName = projects.list().filter((project) => project.name === ref);
  return byName.length === 1 ? byName[0] : undefined;
}

// Resolve a task-dispatch `project` reference to a concrete repository root.
// A bare registered name (or a path matching a tracked project) resolves to
// that project's registered rootPath; an absolute path with no registry match
// is used as given (the unchanged legacy behavior). A bare name that matches no
// tracked project is rejected here rather than silently path-joined against the
// server's cwd - the join used to surface as a confusing "not a git repository"
// from the worktree pool.
function resolveDispatchProjectRoot(
  projects: ProjectRegistry,
  ref: string
): { rootPath: string } | { error: string } {
  const tracked = resolveTrackedProject(projects, ref);
  if (tracked) {
    return { rootPath: tracked.rootPath };
  }
  if (isAbsolute(ref)) {
    return { rootPath: resolvePath(ref) };
  }
  return { error: `Unknown project: "${ref}" is not in the projects registry` };
}

// Teardown: fm-teardown's landed-gate, then end session -> release worktree
// -> close the ledger entry. force skips the gate (explicit confirm upstream).
async function handleTeardown(
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpServerOptions,
  taskId: string
): Promise<void> {
  const task = options.tasks.find(taskId);
  if (!task) {
    writeJson(response, 404, { error: `Unknown task: ${taskId}` });
    return;
  }
  if (task.state === "closed") {
    writeJson(response, 200, { task });
    return;
  }
  const body = await readJson<{ force?: boolean }>(request).catch(() => ({}) as { force?: boolean });
  const force = body.force === true;
  let verdict: LandedVerdict | undefined;

  if (!force) {
    const ownLease = ownLeaseFor(task, options.worktrees);
    verdict = await landedGate(task, ownLease?.path, {
      verifiedPrelaunchDispatchFailure: isVerifiedPrelaunchDispatchFailure(task, options)
    });
    if (!verdict.landed) {
      writeJson(response, 409, { error: `refusing teardown: ${verdict.reason}` });
      return;
    }
  }

  const updated = await executeTeardown(
    task,
    {
      tasks: options.tasks,
      worktrees: options.worktrees,
      adapter: options.adapter,
      auditLog: options.auditLog,
      runtimeManager: options.runtimeManager
    },
    {
      force,
      remoteAddress: request.socket.remoteAddress,
      ...(verdict?.defaultBranch ? { defaultBranch: verdict.defaultBranch } : {})
    }
  );
  writeJson(response, 200, { task: updated });
}

// Hook reports: verify the per-session token, normalize the event, then fan
// out status / approval / timeline correlation. Always answers 200-shaped
// (fail-open): a rejected hook must never disturb the agent session.
async function handleHookReport(
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpServerOptions
): Promise<void> {
  let synchronousClaudeControl = false;
  try {
    const presentedSessionId = String(request.headers["x-perch-session"] ?? "");
    const token = String(request.headers["x-perch-token"] ?? "");
    // Hook posts from a rebound codex daemon's shells carry the daemon's
    // spawn-time identity; attribute them to the live session it aliases to.
    const sessionId = options.hooks.resolveAlias(presentedSessionId);
    const payload = await readJsonOrEmpty<HookEventPayload>(request);
    const requestedEventName = hookEventName(payload);
    synchronousClaudeControl = requestedEventName === "PermissionRequest" ||
      requestedEventName === "Elicitation" || requestedEventName === "ElicitationResult" ||
      (requestedEventName === "PreToolUse" &&
        (payload.tool_name === ASK_USER_QUESTION_TOOL || payload.tool_name === "ExitPlanMode"));
    if (!presentedSessionId || !options.hooks.verify(presentedSessionId, token)) {
      // PermissionRequest is synchronous control, so authentication failure
      // must be visible to the bridge and fall back to Claude's local dialog.
      // Telemetry hooks retain their historical fail-open 200 response.
      writeJson(
        response,
        synchronousClaudeControl ? 401 : 200,
        synchronousClaudeControl ? { error: "Invalid Perch hook session or token" } : { ok: false }
      );
      return;
    }
    if (request.headers["x-perch-observe-only"] === "1" && requestedEventName === "PreToolUse") {
      options.claudeApprovals!.recordPreToolUse(sessionId, payload);
      writeJson(response, 200, { ok: true });
      return;
    }

    const normalized = normalizeHookEvent(payload);
    // The transcript format follows the agent that owns the session, not the
    // payload shape: codex emits Claude-compatible flat payloads, so shape
    // detection cannot distinguish them.
    const sessions = await options.adapter.listSessions();
    const agent = sessions.find((session) => session.id === sessionId)?.agent;
    const format = agent === "codex" ? ("codex" as const) : ("claude" as const);
    const usageLimit = agent === "claude" ? usageLimitFromClaudeHook(payload) : undefined;
    if (hookEventName(payload) === "SessionStart" && normalized.correlation?.agentSessionId) {
      const provider = agent === "codex" ? "codex" : "claude";
      options.runtimeManager?.recordProviderSession(
        sessionId,
        provider,
        normalized.correlation.agentSessionId
      );
      options.ownerManager?.recordProviderSession(
        sessionId,
        provider,
        normalized.correlation.agentSessionId
      );
      options.recoveryCoordinator?.observeSessionStart(
        sessionId,
        provider,
        normalized.correlation.agentSessionId,
        payload
      );
      options.mateRecoveryCoordinator?.observeSessionStart(
        sessionId,
        provider,
        normalized.correlation.agentSessionId,
        payload
      );
    }
    // One line per hook in the server log; invaluable when diagnosing why a
    // session shows no status/timeline.
    console.log(
      `hook: ${hookEventName(payload) || "?"} session=${sessionId.slice(0, 12)} transcript=${payload.transcript_path ?? "-"}`
    );

    const eventName = hookEventName(payload);
    const codexOwnedTurnBoundary = format === "codex" && options.codexOwned?.has(sessionId) === true;

    if (eventName === "UserPromptSubmit" && format === "claude" && typeof payload.prompt === "string") {
      options.promptDeliveries?.acknowledgeHook(
        sessionId,
        payload.prompt,
        typeof payload.session_id === "string" ? payload.session_id : undefined
      );
    }

    // Snapshot the immutable task-event sequence before the automatic
    // new-turn working event. App-server-owned Codex control owns this
    // boundary; hook-driven providers use their verified hooks.
    if (eventName === "UserPromptSubmit" && !codexOwnedTurnBoundary) {
      options.taskCompletion?.onTurnStarted(sessionId, format);
    }

    // Any verified hook report is proof of life: a dispatched task whose
    // worker has started (SessionStart/UserPromptSubmit/...) leaves `queued`
    // even if the worker never curls its own `working` event. Only a verified
    // UserPromptSubmit marks a new turn: a Stop or trailing hook from the turn
    // that reported a deliberate `blocked` verb must not clobber it.
    markTaskWorkingFromActivity(options, sessionId, {
      newTurn: eventName === "UserPromptSubmit"
    });

    if (normalized.correlation?.transcriptPath) {
      // Hook payloads originate inside the agent's PTY (any child process
      // holds the hook token), so only transcript paths under known agent
      // transcript directories are ever tailed. Codex sends its rollout path
      // here too and needs the codex row normalizer.
      if (isAllowedTranscriptPath(normalized.correlation.transcriptPath)) {
        const correlation = options.hooks.correlate(
          sessionId,
          normalized.correlation.agentSessionId,
          normalized.correlation.transcriptPath
        );
        // App-server-owned Codex sessions get their timeline from protocol
        // notifications; tailing the rollout here would double every row.
        if (correlation.transcriptPath && !(format === "codex" && options.codexOwned?.has(sessionId))) {
          options.timeline.attach(
            sessionId,
            correlation.transcriptPath,
            isAllowedTranscriptPath,
            format,
            format === "codex" ? correlation.agentSessionId : undefined
          );
        }
      } else {
        console.log(`hook: ignoring transcript_path outside allowed transcript dirs for session=${sessionId.slice(0, 12)}`);
      }
    }

    if (normalized.status) {
      options.monitor.applyExternalStatus(sessionId, normalized.status);
    }
    if (usageLimit) {
      options.monitor.reportUsageLimit(sessionId, "claude", usageLimit);
    }

    // Claude Stop and plain-Codex Stop are authoritative turn boundaries.
    // Daemon-controlled Codex uses app-server turn/completed instead, avoiding
    // double evidence when a newer Codex also emits compatibility hooks.
    const turnResult =
      eventName === "Stop" && !codexOwnedTurnBoundary
        ? options.taskCompletion?.onTurnCompleted(sessionId, format, {
            continuation: payload.stop_hook_active === true
          })
        : undefined;

    let structuredClaudeApprovalId: string | undefined;
    let structuredClaudeQuestionId: string | undefined;
    let structuredClaudeInteractionId: string | undefined;
    let handledStructuredClaudeQuestion = false;
    const claudeQuestionControl = format === "claude" && eventName === "PreToolUse" && payload.tool_name === ASK_USER_QUESTION_TOOL;
    const claudeExitPlanControl = format === "claude" && eventName === "PreToolUse" && payload.tool_name === "ExitPlanMode";
    if (format === "claude" && eventName === "PreToolUse") {
      options.claudeApprovals!.recordPreToolUse(sessionId, payload);
    }
    if (normalized.approval && format === "claude" && eventName === "PermissionRequest") {
      structuredClaudeApprovalId = options.claudeApprovals!.register(sessionId, payload).record.id;
    } else if (normalized.approval) {
      const at = new Date().toISOString();
      options.monitor.setPendingApproval(sessionId, {
        id: normalized.approval.id,
        summary: normalized.approval.summary,
        command: normalized.approval.command,
        at,
        source: "hook",
        ...(format === "codex" ? { remoteResolutionUnavailable: true } : {})
      });
      options.monitor.publish({
        type: "approval_request",
        sessionId,
        id: normalized.approval.id,
        summary: normalized.approval.summary,
        command: normalized.approval.command,
        at
      });
    }
    if (claudeExitPlanControl) {
      const registered = options.claudeApprovals!.registerExitPlan(sessionId, payload);
      if (registered.record && ["pending", "decided", "decision_sent"].includes(registered.record.state)) {
        structuredClaudeApprovalId = registered.record.id;
        options.monitor.applyExternalStatus(sessionId, "needs_approval", "claude", "adapter");
      }
    }

    if (format === "claude" && eventName === "PreToolUse" && payload.tool_name === ASK_USER_QUESTION_TOOL) {
      const registered = options.claudeQuestions!.register(sessionId, payload);
      handledStructuredClaudeQuestion = Boolean(registered.record);
      structuredClaudeQuestionId = registered.record?.state === "waiting" || registered.record?.state === "answer_sent"
        ? registered.record.id
        : undefined;
    }

    if (format === "claude" && (eventName === "Elicitation" || eventName === "ElicitationResult")) {
      structuredClaudeInteractionId = options.claudeInteractions!.register(sessionId, payload).record?.id;
    }
    if (format === "claude" && eventName === "PermissionDenied") {
      options.claudeInteractions!.observePermissionDenied(sessionId, payload);
    }

    if (normalized.question && !handledStructuredClaudeQuestion) {
      options.monitor.setPendingQuestion(sessionId, {
        id: normalized.question.id,
        questions: normalized.question.questions,
        at: new Date().toISOString(),
        ...(format === "claude"
          ? { state: "local_fallback" as const, remoteResolutionUnavailable: true }
          : {})
      });
    }

    if (format === "claude" && eventName !== "PermissionRequest" && !claudeExitPlanControl) {
      options.claudeApprovals!.confirmLaterActivity(sessionId, eventName);
    }
    if (
      format === "claude" &&
      !(eventName === "PreToolUse" && payload.tool_name === ASK_USER_QUESTION_TOOL)
    ) {
      options.claudeQuestions!.confirmLaterActivity(sessionId, eventName);
    }
    if (format === "claude" && eventName !== "Elicitation" && eventName !== "ElicitationResult") {
      options.claudeInteractions!.confirmLaterActivity(sessionId, eventName);
    }

    if (structuredClaudeInteractionId) {
      const record = await options.claudeInteractions!.wait(
        structuredClaudeInteractionId,
        () => !response.destroyed && !request.socket.destroyed
      );
      const output = options.claudeInteractions!.hookOutput(record);
      if (output) writeJson(response, 200, output);
      else { response.writeHead(204); response.end(); }
      return;
    }

    if (structuredClaudeQuestionId) {
      const record = await options.claudeQuestions!.waitForAnswer(
        structuredClaudeQuestionId,
        () => !response.destroyed && !request.socket.destroyed
      );
      const hookOutput = options.claudeQuestions!.hookOutput(record);
      if (hookOutput) writeJson(response, 200, hookOutput);
      else {
        response.writeHead(204);
        response.end();
      }
      return;
    }
    if (claudeQuestionControl) {
      response.writeHead(204);
      response.end();
      return;
    }
    if (structuredClaudeApprovalId) {
      const record = await options.claudeApprovals!.waitForDecision(
        structuredClaudeApprovalId,
        () => !response.destroyed && !request.socket.destroyed
      );
      const hookOutput = options.claudeApprovals!.hookOutput(record);
      if (hookOutput) {
        // Stdout from the installed command contains exactly this object. No
        // acknowledgement, suggestions, or permission-rule updates are mixed
        // into Claude's decision channel.
        writeJson(response, 200, hookOutput);
      } else {
        response.writeHead(204);
        response.end();
      }
      return;
    }
    if (claudeExitPlanControl) {
      response.writeHead(204);
      response.end();
      return;
    }

    // SessionStart answers with the Claude-compatible shape that current Codex
    // also documents. Both installed SessionStart hooks echo this body to
    // stdout, so solo agents receive the note as developer context. Codex task
    // workers keep the same note in their dispatch brief.
    if (eventName === "SessionStart") {
      writeJson(response, 200, {
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: PERCH_SESSION_NOTE }
      });
      return;
    }

    // Claude can safely continue the same loop once. stop_hook_active is the
    // provider's loop guard: a second missing report is already durable and
    // wakes the mate, but never triggers another continuation. Codex
    // turn/completed is a settled notification and has no equivalent control.
    if (
      format === "claude" &&
      eventName === "Stop" &&
      turnResult?.retryNeeded === true &&
      payload.stop_hook_active !== true &&
      turnResult.taskState !== "done" &&
      turnResult.taskState !== "completion_requested"
    ) {
      writeJson(response, 200, {
        hookSpecificOutput: {
          hookEventName: "Stop",
          additionalContext:
            "Perch recorded this turn as retry-needed because no accepted task outcome followed its start. Before stopping, report one accurate outcome event: needs_decision, blocked, done (completion request), or failed. Do not claim work that is not complete."
        }
      });
      return;
    }
    if (format === "claude" && eventName === "Stop") {
      // Valid empty structured output means "allow Stop" without exposing the
      // server's internal acknowledgement as hook feedback.
      writeJson(response, 200, {});
      return;
    }

    writeJson(response, 200, { ok: true });
  } catch {
    writeJson(
      response,
      synchronousClaudeControl ? 503 : 200,
      synchronousClaudeControl
        ? { error: "Perch could not hold this Claude interaction; use the native local UI" }
        : { ok: false }
    );
  }
}

// A request is authorized by the server token (CLI, local tools) or by any
// paired device token (mobile app). Device tokens are individually revocable
// via DELETE /devices/:id; device administration itself is server-token only.
function authenticate(
  request: IncomingMessage,
  options: Pick<HttpServerOptions, "authToken" | "devices">
): ClientAuth | undefined {
  const header = request.headers.authorization;
  const queryToken = getRequestUrl(request).searchParams.get("token") ?? undefined;
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : queryToken;

  if (!presented) {
    return undefined;
  }
  return tokenToAuth(presented, options);
}

// Resolves a presented token to how the client is authorized: the server token
// (CLI, local tools) or a paired device's revocable token. Shared by the plain
// ?token= path and the encrypted channel (where the token arrives inside the
// ciphertext, verified at the E2E boundary).
function tokenToAuth(
  token: string,
  options: Pick<HttpServerOptions, "authToken" | "devices">
): ClientAuth | undefined {
  if (tokensEqual(token, options.authToken)) {
    return { kind: "server" };
  }
  const device = options.devices.verify(token);
  return device ? { kind: "device", deviceId: device.id } : undefined;
}

function getRequestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://localhost");
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "authorization,content-type");
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

// Best-effort audit: a full disk or unwritable log must never fail a mutation
// that already executed.
function audit(auditLog: AuditLog, record: Parameters<AuditLog["write"]>[0]): Promise<void> {
  return auditLog.write(record).catch((error) => {
    console.error("audit write failed:", error instanceof Error ? error.message : error);
  });
}

function canonicalSessionIdFor(adapter: AgentAdapter, sessionId: string): string {
  return adapter.canonicalSessionId?.(sessionId) ?? sessionId;
}

function withCanonicalSessionId(event: AgentEvent, sessionId: string): AgentEvent {
  return event.sessionId === sessionId ? event : ({ ...event, sessionId } as AgentEvent);
}

function rpcOk(status: number, body: unknown): RpcResult {
  return { status, body };
}

function rpcError(status: number, error: string): RpcResult {
  return { status, body: { error } };
}

function errorFromBody(body: unknown): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return body.error;
  }
  return "Request failed";
}

function rpcBody<T extends Record<string, unknown>>(request: WebSocketRpcRequest): T {
  if (request.body === undefined || request.body === null) {
    return {} as T;
  }
  if (typeof request.body !== "object" || Array.isArray(request.body)) {
    throw new Error("body must be an object");
  }
  return request.body as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function auditPeerFor(auth: ClientAuth): Pick<Parameters<AuditLog["write"]>[0], "deviceId"> {
  return auth.kind === "device" ? { deviceId: auth.deviceId } : {};
}

// Approval authority is deliberately not inferred from chat. A paired boss
// device or the local administrative server token may decide; Mate only gets
// the durable wake/reference and cannot authorize by replying in prose.
function approvalActor(auth: ClientAuth): string {
  return auth.kind === "device" ? `boss:device:${auth.deviceId}` : "boss:local-server-token";
}

function claudeInboxSnapshot(options: HttpServerOptions, after: number): Record<string, unknown> {
  const sequence = options.tasks.stateDb.claudeInbox.sequence();
  return {
    version: 1,
    sequence,
    snapshot: {
      permissions: options.claudeApprovals!.list().map(publicRecord),
      questions: options.claudeQuestions!.list().map(publicQuestion),
      interactions: options.claudeInteractions!.list().map(publicInteraction)
    },
    deltas: options.tasks.stateDb.claudeInbox.deltas(after)
  };
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

async function readJsonOrEmpty<T extends object>(request: IncomingMessage): Promise<Partial<T>> {
  try {
    return await readJson<T>(request);
  } catch {
    return {};
  }
}

function validateInput(body: InputRequest): void {
  if (!body || typeof body.text !== "string" || body.text.length === 0) {
    throw new Error("text is required");
  }
  if (body.interrupt !== undefined && typeof body.interrupt !== "boolean") {
    throw new Error("interrupt must be a boolean");
  }
}
