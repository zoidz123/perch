import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, extname, join as joinPath, resolve as resolvePath } from "node:path";
import { WebSocketServer } from "ws";
import type {
  AgentEvent,
  AgentKind,
  AnswerRequest,
  ApproveRequest,
  AttachmentResponse,
  Chart,
  ChartAssetResponse,
  ChartFeedbackRequest,
  ChartFeedbackResponse,
  ChartHtmlResponse,
  ChartLayoutWarningsRequest,
  FinalizeChartResponse,
  RegisterChartRequest,
  RegisterChartResponse,
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
  NoMistakesDispatchRefusal,
  NoMistakesAuthorizationRequest,
  NoMistakesAuthorizationResponse,
  NoMistakesInitResult,
  PlanDocResponse,
  StartAgentRequest,
  StartAgentResponse,
  ServerRequestResponse,
  SubmitResponse,
  Task,
  TaskDecisionRequest,
  TaskDecisionResponse,
  TaskDetailResponse,
  TaskEventKind,
  TaskEventRequest,
  TaskPr,
  TasksResponse,
  UsageResponse,
  WebSocketRpcRequest,
  WebSocketRpcResponse
} from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import type { AuditLog } from "./audit.js";
import {
  buildChartsHub,
  chartAuthoringPath,
  chartChromeAsset,
  chartCssPath,
  chartReviewHtml,
  formatChartFeedback,
  formatLayoutWarnings,
  injectChartSdk,
  type ChartRegistry
} from "./charts.js";
import type { ClientAuth, FleetMonitor } from "./fleetMonitor.js";
import {
  CHART_CAPABILITY_NOTE,
  hookEventName,
  isAllowedTranscriptPath,
  normalizeHookEvent,
  type HookEventPayload,
  type HookRegistry
} from "./hooks.js";
import { usageLimitFromClaudeHook } from "./usageLimitDetect.js";
import { ASK_USER_QUESTION_TOOL, KEY_DELAY_MS, questionKeystrokes } from "./askQuestion.js";
import { buildOffer, tokensEqual, type DeviceRegistry } from "./pairing.js";
import { EncryptedServerChannel } from "./e2ee/channel.js";
import {
  collectDoctor,
  noMistakesBinary,
  noMistakesRuntimeFacts,
  repoGateState,
  runNoMistakesInit,
  type DoctorDeps
} from "./deps.js";
import {
  decisionInjectionLine,
  decisionMateFyi,
  decisionSummary,
  parseNoMistakesGate,
  type GateDecision
} from "./findings.js";
import { taskWakeIdentity } from "./mateWake.js";
import type { Project, ProjectRegistry } from "./projects.js";
import { suggestDirectories } from "./fsSuggest.js";
import { dispatchBrief } from "./brief.js";
import { renderChartsGalleryHtml } from "./chartsGallery.js";
import { renderPlanHtml, resolvePlanDocPath } from "./planRender.js";
import { extractPrUrl, type PrPoller } from "./prPoller.js";
import type { StateMetrics } from "./stateMetrics.js";
import type { TaskStore } from "./tasks.js";
import type { TaskCompletionReconciler } from "./taskCompletion.js";
import { executeTeardown, landedGate, ownLeaseFor } from "./teardown.js";
import type { TimelineStore } from "./timeline.js";
import type { WorktreePool } from "./worktrees.js";
import { storeAttachment } from "./attachments.js";
import { seedMateHome } from "./mate.js";
import { isProviderPrefixedModelId, modelSwitchSteps } from "./modelSwitch.js";
import { collectUsage } from "./usage.js";
import { listCodexModelsOnce } from "./adapters/codexAppServer.js";
import {
  collectCliModelRegistry,
  collectModelRegistry,
  DISPATCH_CODEX_FALLBACK,
  listClaudeModels,
  MATE_CLAUDE_FALLBACK_MODEL,
  MATE_CODEX_FALLBACK,
  resolveMateLaunch,
  resolveSessionModel,
  supportedEffortsForModel
} from "./models.js";
import type {
  CodexEffortResolver,
  DispatchDefaultsUpdate,
  FleetSettings,
  MateDefaultsUpdate
} from "./settings.js";
import type { CodexControlPlane } from "./codexControl.js";
import {
  attachCodexRollout,
  canonicalRepository,
  canonicalRepositoryForPath,
  markTaskWorkingFromActivity,
  startManagedAgent
} from "./agentLauncher.js";
import type { OperationRecord } from "./stateDb.js";
import type { OperationExecutionContext, TaskScheduler } from "./taskScheduler.js";
import type { RuntimeManager } from "./runtimeManager.js";
import { RecoveryCoordinator } from "./recovery.js";
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
  codexControl?: CodexControlPlane;
  // Launch-time hook reinstaller (see ManagedAgentLauncherOptions.installHooks).
  // Wired to the real installers by the entrypoint; absent in test fixtures so
  // tests never rewrite real provider config.
  installHooks?: (agent: AgentKind) => void;
  taskCompletion?: TaskCompletionReconciler;
  // Charts (artifact review): registry + watchers behind the /charts routes.
  charts?: ChartRegistry;
  // State-machine measurements (G6), served at GET /doctor/state-metrics.
  metrics?: StateMetrics;
  // Environment-doctor and fake-runtime injection. Production always uses
  // the signed bundled runtime and never resolves no-mistakes from PATH.
  doctorDeps?: Pick<DoctorDeps, "env" | "noMistakesPath">;
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
  claudeApprovals?: ClaudeApprovalCoordinator;
  claudeQuestions?: ClaudeQuestionCoordinator;
  claudeInteractions?: ClaudeInteractionCoordinator;
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
  options.recoveryCoordinator ??= new RecoveryCoordinator(options);
  options.recoveryContinuationCoordinator ??= new RecoveryContinuationCoordinator(options);
  if (!options.mateRecoveryCoordinator && options.ownerManager && options.taskScheduler) {
    options.mateRecoveryCoordinator = new MateRecoveryCoordinator({
      ...options,
      ownerManager: options.ownerManager,
      taskScheduler: options.taskScheduler
    });
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
  session: { agent?: AgentKind; labels?: Record<string, string>; model?: string | null; modelLabel?: string | null; effort?: CodexReasoningEffort | null },
  options: HttpServerOptions
) {
  if (session.labels?.role !== "mate") {
    return undefined;
  }
  if (session.agent === "codex") {
    const defaults = options.settings?.mateDefaults() ?? {};
    const configured = defaults.agent === "codex" ? defaults.model?.trim() : undefined;
    const model = configured && configured.toLowerCase() !== "auto" ? configured : MATE_CODEX_FALLBACK.model;
    const effort = defaults.agent === "codex" ? defaults.effort : MATE_CODEX_FALLBACK.effort;
    return resolveSessionModel("codex", { model, effort });
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
async function codexEffortResolver(options: HttpServerOptions): Promise<CodexEffortResolver> {
  const registry = await loadModelRegistry(options);
  return (model) => supportedEffortsForModel(registry, "codex", model);
}

async function resolveMateLaunchNow(
  input: { agent: AgentKind; model?: string; effort?: CodexReasoningEffort },
  options: HttpServerOptions
): Promise<MateLaunchResolution> {
  const model = input.model?.trim();
  const registry = !model || model.toLowerCase() === "auto" ? await loadModelRegistry(options) : undefined;
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
  const project = projectPath ? options.projects.find(projectPath) : undefined;
  entries["task.mode"] = {
    effectiveValue: project?.mode ?? "direct-PR",
    source: project?.mode ? "project" : "built-in",
    scope: "project",
    storedValue: project?.mode ?? null,
    defaultValue: "direct-PR",
    overriddenBy: null
  };
  entries["task.yolo"] = {
    effectiveValue: project?.yolo ?? false,
    source: project?.yolo !== undefined ? "project" : "built-in",
    scope: "project",
    storedValue: project?.yolo ?? null,
    defaultValue: false,
    overriddenBy: null
  };
  const runtime = noMistakesRuntimeFacts();
  for (const [suffix, value] of Object.entries({
    version: runtime?.version ?? null,
    path: runtime?.path ?? null,
    "SHA-256": runtime?.sha256 ?? null,
    source: runtime?.source ?? "bundled",
    architecture: runtime?.architecture ?? null,
    protocol: runtime?.protocol ?? null
  })) {
    entries[`runtime.no-mistakes.${suffix}`] = {
      effectiveValue: value,
      source: "bundled",
      scope: "runtime",
      storedValue: null,
      defaultValue: null,
      overriddenBy: null,
      readOnly: true
    };
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

// POST /mate/start body. Every field is optional and overrides the fleet's
// configured mate default for this launch; the app posts `{}` and gets the
// mate the boss configured with `perch config mate-*`.
type MateStartRequest = {
  agent?: MateDefaults["agent"];
  model?: string;
  effort?: MateDefaults["effort"];
  new?: boolean;
  args?: string[];
};

// Explicit project registration (POST /projects): must name a real directory
// on this Mac, so a typo'd or stale path never lands in the registry.
// Setting mode: "no-mistakes" is consent to run `no-mistakes init` in the repo
// right now (O2) - idempotent upstream, audit-logged like every other mutating
// action. Passive session-start registration (`touch`) never reaches this
// path, so it never initializes anything.
async function registerProject(
  body: Record<string, unknown>,
  options: HttpServerOptions,
  auditMeta: Pick<Parameters<AuditLog["write"]>[0], "deviceId" | "remoteAddress">
): Promise<RpcResult> {
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
  const fields = {
    ...(typeof body.name === "string" && body.name ? { name: body.name } : {}),
    ...(body.mode === "direct-PR" || body.mode === "no-mistakes" || body.mode === "local-only"
      ? { mode: body.mode as Project["mode"] }
      : {}),
    ...(typeof body.yolo === "boolean" ? { yolo: body.yolo } : {})
  };
  if (body.mode === "no-mistakes") {
    const noMistakes = await initNoMistakesGate(root, options, auditMeta);
    if (!noMistakes.ready) {
      return {
        status: 422,
        body: { error: noMistakes.warning ?? "no-mistakes activation failed", noMistakes }
      };
    }
    const project = options.projects.touch(root, fields);
    return rpcOk(200, { project, noMistakes });
  }
  const project = options.projects.touch(root, fields);
  return rpcOk(200, { project });
}

async function configureProject(
  body: Record<string, unknown>,
  options: HttpServerOptions,
  auditMeta: Pick<Parameters<AuditLog["write"]>[0], "deviceId" | "remoteAddress">
): Promise<RpcResult> {
  const allowedKeys = new Set(["rootPath", "mode", "yolo"]);
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
  const modes = new Set(["direct-PR", "no-mistakes", "local-only"]);
  if (body.mode !== undefined && body.mode !== null && (typeof body.mode !== "string" || !modes.has(body.mode))) {
    return rpcError(400, "mode must be direct-PR, no-mistakes, local-only, or null");
  }
  if (body.yolo !== undefined && body.yolo !== null && typeof body.yolo !== "boolean") {
    return rpcError(400, "yolo must be a boolean or null");
  }
  if (body.mode === undefined && body.yolo === undefined) return rpcError(400, "mode or yolo required");
  let noMistakes: NoMistakesInitResult | undefined;
  if (body.mode === "no-mistakes") {
    noMistakes = await initNoMistakesGate(root, options, auditMeta);
    if (!noMistakes.ready) {
      return { status: 422, body: { error: noMistakes.warning ?? "no-mistakes activation failed", noMistakes } };
    }
  }
  const project = options.projects.configure(root, {
    ...(body.mode !== undefined ? { mode: body.mode as Project["mode"] | null } : {}),
    ...(body.yolo !== undefined ? { yolo: body.yolo as boolean | null } : {})
  });
  return rpcOk(200, { project, ...(noMistakes ? { noMistakes } : {}) });
}

// The consent-driven init run behind a mode: "no-mistakes" set. The project is
// validated and initialized before the registry mutation. Any failure leaves
// the prior project mode untouched.
async function initNoMistakesGate(
  root: string,
  options: HttpServerOptions,
  auditMeta: Pick<Parameters<AuditLog["write"]>[0], "deviceId" | "remoteAddress">
): Promise<NoMistakesInitResult> {
  if (!noMistakesBinary(options.doctorDeps)) {
    const { initialized } = await repoGateState(root);
    return {
      ran: false,
      initialized,
      ready: false,
      warning: "bundled no-mistakes runtime is unavailable or corrupt - reinstall this exact perchctl version"
    };
  }
  const result = await runNoMistakesInit(root, options.doctorDeps);
  await audit(options.auditLog, { action: "no_mistakes_init", ...auditMeta, cwd: root });
  const { initialized } = await repoGateState(root);
  if (!result.ok) {
    // Upstream's own error text, verbatim (e.g. its no-origin-remote message).
    return { ran: true, initialized, ready: false, warning: `no-mistakes init failed: ${result.output}` };
  }
  return {
    ran: true,
    initialized,
    ready: initialized,
    ...(result.output ? { output: result.output } : {})
  };
}

// Dispatch readiness gate (T3): a task about to be dispatched with effective
// mode no-mistakes must find the gate actually ready - binary on PATH and the
// repo initialized. Anything less is refused with a structured 422 naming the
// exact fix, BEFORE the task record, worktree lease, or worker session exist:
// silently spawning a worker into a mode it cannot honor (or silently
// downgrading to ungated direct-PR) both violate the boss's intent. Absent an
// explicit mode the task stays direct-PR (O1), so this never fires by default.
async function refuseUnreadyNoMistakesDispatch(
  body: CreateTaskRequest,
  options: HttpServerOptions
): Promise<RpcResult | undefined> {
  if (body.dispatch !== true) return undefined;
  const mode = body.mode ?? options.projects.find(body.project)?.mode ?? "direct-PR";
  if (mode !== "no-mistakes") return undefined;
  const root = resolvePath(body.project);
  const binaryFound = noMistakesBinary(options.doctorDeps) !== undefined;
  const { initialized } = await repoGateState(root);
  const missing: string[] = [];
  if (!binaryFound) {
    missing.push("bundled no-mistakes runtime unavailable or corrupt: reinstall this exact perchctl version");
  }
  if (!initialized) {
    missing.push(
      `repo not initialized: run \`perch project add ${root} --mode no-mistakes\` (or \`no-mistakes init\` in the repo)`
    );
  }
  if (missing.length === 0) return undefined;
  const refusal: NoMistakesDispatchRefusal = {
    error: `no-mistakes gate is not ready for ${root} - ${missing.join("; ")}`,
    noMistakes: { binaryFound, initialized, missing }
  };
  return { status: 422, body: refusal };
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
      const resolveEfforts = await codexEffortResolver(options);
      const responseBody = await buildConfigResponse(options, {
        dispatchDefaults: update.dispatchDefaults === undefined
          ? options.settings.dispatchDefaults()
          : options.settings.updateDispatchDefaults(update.dispatchDefaults, resolveEfforts),
        mateDefaults: update.mateDefaults === undefined
          ? options.settings.mateDefaults()
          : options.settings.updateMateDefaults(update.mateDefaults, resolveEfforts)
      });
      await audit(options.auditLog, { action: "set_config", ...auditPeer });
      return rpcOk(200, responseBody);
    } catch (error) {
      return rpcError(400, error instanceof Error ? error.message : String(error));
    }
  }

  if (method === "GET" && pathname === "/tasks") {
    const planId = url.searchParams.get("planId");
    const tasks = planId ? options.tasks.listByPlan(planId) : options.tasks.list();
    const responseBody: TasksResponse = { tasks };
    return rpcOk(200, responseBody);
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

  const decisionMatch = pathname.match(/^\/tasks\/([^/]+)\/decision$/);
  if (method === "POST" && decisionMatch) {
    return taskDecisionRpc(
      decodeURIComponent(decisionMatch[1] ?? ""),
      body as TaskDecisionRequest,
      options,
      auditPeer
    );
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
      auth.kind === "device" ? "human" : "agent"
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
    const { queued } = await deliverInputAccepted(options, canonicalSessionId, String(body.text), "human");
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

  if (method === "GET" && pathname === "/charts") {
    return rpcOk(200, { charts: options.charts?.list() ?? [] });
  }

  // The unified hub listing over the relay (the mobile Charts sheet).
  if (method === "GET" && pathname === "/charts/hub") {
    return chartsHubResult(options);
  }

  // A committed plan doc rendered in chart styling, as JSON for relay clients
  // (which cannot fetch raw HTML). The mobile hub loads html into a WKWebView.
  if (method === "GET" && pathname === "/charts/plan") {
    const result = renderPlanDoc(options, url.searchParams.get("path") ?? "");
    return result.html === undefined
      ? rpcError(result.status, result.error ?? "Unknown plan doc")
      : rpcOk(200, { html: result.html } satisfies PlanDocResponse);
  }

  // Approve a chart -> finalized (the mobile hub's approve action).
  const chartFinalizeMatch = pathname.match(/^\/charts\/([^/]+)\/finalize$/);
  if (method === "POST" && chartFinalizeMatch) {
    return finalizeChartResult(decodeURIComponent(chartFinalizeMatch[1] ?? ""), options, auditPeer);
  }

  // Registration over RPC carries no hook token (hook tokens live in the
  // agent's PTY env and ride raw HTTP), so this is the bearer path only.
  if (method === "POST" && pathname === "/charts") {
    if (auth.kind !== "server") {
      return rpcError(403, "Chart registration needs the session hook token or the server token");
    }
    return registerChartBearer(body as RegisterChartRequest, options, auditPeer);
  }

  // Relay clients cannot fetch raw HTML/bytes (every RPC response is JSON),
  // so the chart document and its sibling assets are additionally exposed as
  // JSON here. LAN clients keep using the raw /charts routes.
  const chartHtmlMatch = pathname.match(/^\/charts\/([^/]+)\/html$/);
  if (method === "GET" && chartHtmlMatch) {
    return chartHtmlRpc(decodeURIComponent(chartHtmlMatch[1] ?? ""), options);
  }

  const chartAssetMatch = pathname.match(/^\/charts\/([^/]+)\/asset64$/);
  if (method === "GET" && chartAssetMatch) {
    return chartAssetRpc(
      decodeURIComponent(chartAssetMatch[1] ?? ""),
      url.searchParams.get("path") ?? "",
      options
    );
  }

  const chartFeedbackMatch = pathname.match(/^\/charts\/([^/]+)\/feedback$/);
  if (method === "POST" && chartFeedbackMatch) {
    return chartFeedbackRpc(
      decodeURIComponent(chartFeedbackMatch[1] ?? ""),
      body as ChartFeedbackRequest,
      options,
      auditPeer
    );
  }

  const chartLayoutMatch = pathname.match(/^\/charts\/([^/]+)\/layout-warnings$/);
  if (method === "POST" && chartLayoutMatch) {
    return chartLayoutWarningsRpc(
      decodeURIComponent(chartLayoutMatch[1] ?? ""),
      body as ChartLayoutWarningsRequest,
      options,
      auditPeer
    );
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

  // The external no-mistakes CLI/daemon calls this immediately before run
  // creation, gate push, and review-agent launch. A per-session hook token is
  // non-forgeable and short-lived; every supplied scope field is checked
  // against the durable task and current runtime generation before mode can
  // authorize the expensive capability.
  if (request.method === "POST" && pathname === "/hooks/no-mistakes/authorize") {
    await handleNoMistakesAuthorization(request, response, options);
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

  // Chart registration: the drawing agent registers with its own per-session
  // hook token (the `chart` verb alongside the brief's task verbs); the server
  // token may also register on a named session (the mate drawing charts).
  // Fail-closed like the task verbs - registration mutates the registry.
  if (request.method === "POST" && pathname === "/charts") {
    await handleRegisterChart(request, response, options);
    return;
  }

  // Perch-owned chart statics (the stylesheet and the review chrome): shipped
  // in the public repo, they carry no user data, and they must load as
  // subresources of token-authed pages - a <link> tag or the sandboxed chart
  // iframe cannot attach the query token - so like /health they skip auth.
  // Everything chart-SPECIFIC (the HTML, sibling assets, feedback) stays
  // behind auth in routeCharts.
  if (request.method === "GET" && /^\/charts(?:\/[^/]+)?\/chart\.css$/.test(pathname)) {
    serveChartCss(response);
    return;
  }
  const chromeAssetMatch = pathname.match(/^\/charts\/chrome\/([^/]+)$/);
  if (request.method === "GET" && chromeAssetMatch) {
    serveChartChromeAsset(response, decodeURIComponent(chromeAssetMatch[1] ?? ""));
    return;
  }
  // The authoring guide is the same class of perch-owned static: the chart
  // capability note tells agents to curl it first, from any repo, so like
  // chart.css it must resolve without auth or a perch checkout.
  if (request.method === "GET" && pathname === "/charts/authoring") {
    serveChartAuthoring(response);
    return;
  }

  const auth = authenticate(request, options);
  if (!auth && isLocalChartReviewRequest(request, pathname)) {
    if (await routeCharts(request, response, options, pathname, { kind: "server" }, url, true)) {
      return;
    }
  }
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

    // Register a project or set its delivery fields (mode, yolo, name).
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
    // gh, no-mistakes) plus per-registered-project gate readiness, checked in
    // the environment that actually spawns agents. `perch doctor` renders it.
    if (request.method === "GET" && pathname === "/doctor") {
      writeJson(
        response,
        200,
        await collectDoctor({ ...options.doctorDeps, projects: options.projects.list() })
      );
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
        const resolveEfforts = await codexEffortResolver(options);
        dispatchDefaults = update.dispatchDefaults === undefined
          ? options.settings.dispatchDefaults()
          : options.settings.updateDispatchDefaults(update.dispatchDefaults, resolveEfforts);
        mateDefaults = update.mateDefaults === undefined
          ? options.settings.mateDefaults()
          : options.settings.updateMateDefaults(update.mateDefaults, resolveEfforts);
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
      const planId = url.searchParams.get("planId");
      const tasks = planId ? options.tasks.listByPlan(planId) : options.tasks.list();
      const body: TasksResponse = { tasks };
      writeJson(response, 200, body);
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

    // The boss answers a parked no-mistakes gate from the phone (device or
    // server token; hook tokens never - a worker must not answer its own gate).
    const decisionMatch = pathname.match(/^\/tasks\/([^/]+)\/decision$/);
    if (request.method === "POST" && decisionMatch) {
      const body = await readJson<TaskDecisionRequest>(request);
      const result = await taskDecisionRpc(
        decodeURIComponent(decisionMatch[1] ?? ""),
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
        auth.kind === "device" ? "human" : "agent"
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
      const { queued } = await deliverInputAccepted(options, canonicalSessionId, body.text, "human");
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
      // applies on the next submitted turn and the `--remote` TUI footer
      // reflects it. When the session is PTY-only (no daemon) the chip is off.
      if (agent === "codex") {
        const armed = options.codexControl?.switchModel(
          canonicalSessionId,
          body.model.trim(),
          body.effort
        );
        if (!armed) {
          writeJson(response, 409, {
            error: "This Codex session is running PTY-only; model switching needs the app-server daemon"
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
      if (!options.codexControl?.respondToServerRequest(canonicalSessionId, body)) {
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

    if (await routeCharts(request, response, options, pathname, auth, url)) {
      return;
    }

    writeJson(response, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    writeJson(response, 500, { error: message });
  }
}

// The authed /charts surface: list, the perch-owned stylesheet, chart HTML
// with the annotation SDK injected, directory-confined sibling assets, boss
// feedback, and the SDK's layout-audit intake. Returns false when the path is
// not a charts route so route() falls through to its 404.
async function routeCharts(
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpServerOptions,
  pathname: string,
  auth: ClientAuth,
  url: URL,
  localReview = false
): Promise<boolean> {
  const charts = options.charts;
  if (!charts || !(pathname === "/charts" || pathname.startsWith("/charts/"))) {
    return false;
  }
  const auditPeer =
    auth.kind === "device"
      ? { deviceId: auth.deviceId, remoteAddress: request.socket.remoteAddress }
      : { remoteAddress: request.socket.remoteAddress };

  if (request.method === "GET" && pathname === "/charts") {
    writeJson(response, 200, { charts: charts.list() });
    return true;
  }

  // The unified hub listing (before the /charts/:id match, which "hub" would
  // otherwise capture as an id): charts grouped by project + committed plans.
  if (request.method === "GET" && pathname === "/charts/hub") {
    const result = chartsHubResult(options);
    writeJson(response, result.status, result.body);
    return true;
  }

  // A committed plan doc rendered in chart styling (before /charts/:id, which
  // "plan" would otherwise capture as an id). The hub taps into it to show plan
  // content in the same look a chart gets.
  if (request.method === "GET" && pathname === "/charts/plan") {
    const result = renderPlanDoc(options, url.searchParams.get("path") ?? "");
    if (result.html === undefined) {
      writeJson(response, result.status, { error: result.error });
      return true;
    }
    response.writeHead(result.status, { "content-type": "text/html; charset=utf-8" });
    response.end(result.html);
    return true;
  }

  // The desktop Charts gallery: a server-rendered browse page over the unified
  // hub listing - every chart and plan grouped by project, each a link into its
  // existing review/plan page.
  // Before the /charts/:id match, which would otherwise capture "gallery" as an
  // id. Chart review links deliberately stay tokenless: local GET review is
  // easy, while the chart iframe must never receive or inherit a bearer token.
  if (request.method === "GET" && pathname === "/charts/gallery") {
    const hub = buildChartsHub(charts.list(), options.projects.list(), chartProjectResolver(options));
    const token = url.searchParams.get("token") ?? "";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderChartsGalleryHtml(hub, token));
    return true;
  }

  // Approve a chart -> finalized. A boss action from the desktop gallery.
  const finalizeMatch = pathname.match(/^\/charts\/([^/]+)\/finalize$/);
  if (request.method === "POST" && finalizeMatch) {
    const result = await finalizeChartResult(
      decodeURIComponent(finalizeMatch[1] ?? ""),
      options,
      auditPeer
    );
    writeJson(response, result.status, result.body);
    return true;
  }

  // Note: chart.css (as /charts/chart.css and chart-relative ./chart.css) and
  // the review-chrome assets are served BEFORE auth in route() - subresources
  // of a token-authed page cannot attach the query token. Local desktop review
  // GETs can read the review surface without a bearer token; feedback and
  // layout POSTs still need the scoped nonce minted by GET /review.

  const htmlMatch = pathname.match(/^\/charts\/([^/]+)(?:\/index\.html)?$/);
  if (request.method === "GET" && htmlMatch) {
    const chart = charts.find(decodeURIComponent(htmlMatch[1] ?? ""));
    if (!chart) {
      writeJson(response, 404, { error: "Unknown chart" });
      return true;
    }
    // Snapshot-first: the durable copy under ~/.perch/charts/<id>/ keeps the
    // chart rendering after its worktree (the author's scratch copy) is gone.
    let html: string;
    try {
      html = readFileSync(charts.htmlFileFor(chart), "utf8");
    } catch {
      writeJson(response, 404, { error: `Chart file is gone: ${chart.file}` });
      return true;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(injectChartSdk(html));
    return true;
  }

  // The desktop review surface (T3): the chart in a sandboxed iframe with the
  // annotation chrome around it. The review page may be opened bare on
  // loopback, but mutating review POSTs require the scoped nonce minted here.
  const reviewMatch = pathname.match(/^\/charts\/([^/]+)\/review$/);
  if (request.method === "GET" && reviewMatch) {
    const chart = charts.find(decodeURIComponent(reviewMatch[1] ?? ""));
    if (!chart) {
      writeJson(response, 404, { error: "Unknown chart" });
      return true;
    }
    if (isLoopbackAddress(request.socket.remoteAddress) && url.searchParams.has("token")) {
      response.writeHead(303, { location: pathname });
      response.end();
      return true;
    }
    const reviewNonce = charts.issueReviewNonce(chart.id);
    if (!reviewNonce) {
      writeJson(response, 404, { error: "Unknown chart" });
      return true;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "set-cookie": chartReviewCookie(chart.id, reviewNonce)
    });
    response.end(chartReviewHtml(chart, { reviewNonce }));
    return true;
  }

  const feedbackMatch = pathname.match(/^\/charts\/([^/]+)\/feedback$/);
  if (request.method === "POST" && feedbackMatch) {
    const chartId = decodeURIComponent(feedbackMatch[1] ?? "");
    if (localReview && !validChartReviewPost(request, charts, chartId)) {
      writeJson(response, 401, { error: "Chart review POST requires a valid review nonce" });
      return true;
    }
    const body = await readJsonOrEmpty<ChartFeedbackRequest>(request);
    const result = await chartFeedbackRpc(
      chartId,
      body as ChartFeedbackRequest,
      options,
      auditPeer
    );
    writeJson(response, result.status, result.body);
    return true;
  }

  const layoutMatch = pathname.match(/^\/charts\/([^/]+)\/layout-warnings$/);
  if (request.method === "POST" && layoutMatch) {
    const chartId = decodeURIComponent(layoutMatch[1] ?? "");
    if (localReview && !validChartReviewPost(request, charts, chartId)) {
      writeJson(response, 401, { error: "Chart review POST requires a valid review nonce" });
      return true;
    }
    const body = await readJsonOrEmpty<ChartLayoutWarningsRequest>(request);
    const result = await chartLayoutWarningsRpc(
      chartId,
      body as ChartLayoutWarningsRequest,
      options,
      auditPeer
    );
    writeJson(response, result.status, result.body);
    return true;
  }

  // Sibling assets referenced by the chart, confined to its directory
  // (snapshot-first via assetFileFor, with traversal protection).
  const assetMatch = pathname.match(/^\/charts\/([^/]+)\/(.+)$/);
  if (request.method === "GET" && assetMatch) {
    const chart = charts.find(decodeURIComponent(assetMatch[1] ?? ""));
    if (!chart) {
      writeJson(response, 404, { error: "Unknown chart" });
      return true;
    }
    const assetPath = decodeURIComponent(assetMatch[2] ?? "");
    const file = charts.assetFileFor(chart, assetPath);
    if (!file) {
      writeJson(response, 403, { error: "Forbidden" });
      return true;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      writeJson(response, 404, { error: "Not found" });
      return true;
    }
    response.writeHead(200, { "content-type": assetContentType(file) });
    response.end(bytes);
    return true;
  }

  return false;
}

function chartReviewCookie(chartId: string, nonce: string): string {
  return `${chartReviewCookieName(chartId)}=${nonce}; Max-Age=${Math.floor(
    12 * 60 * 60
  )}; Path=/charts/${encodeURIComponent(chartId)}; HttpOnly; SameSite=Strict`;
}

function validChartReviewPost(request: IncomingMessage, charts: ChartRegistry, chartId: string): boolean {
  const nonce = String(request.headers["x-perch-chart-review"] ?? "").trim();
  if (!nonce) {
    return false;
  }
  const cookie = chartReviewCookieValue(request, chartId);
  if (!cookie || !tokensEqual(cookie, nonce)) {
    return false;
  }
  return charts.verifyReviewNonce(chartId, nonce);
}

function chartReviewCookieValue(request: IncomingMessage, chartId: string): string | undefined {
  const name = `${chartReviewCookieName(chartId)}=`;
  const header = String(request.headers.cookie ?? "");
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(name)) {
      return trimmed.slice(name.length);
    }
  }
  return undefined;
}

function chartReviewCookieName(chartId: string): string {
  return `perch_chart_review_${chartId}`;
}

function serveChartCss(response: ServerResponse): void {
  let css: string;
  try {
    css = readFileSync(chartCssPath(), "utf8");
  } catch {
    writeJson(response, 404, { error: "chart.css is not installed on this server yet" });
    return;
  }
  response.writeHead(200, { "content-type": "text/css; charset=utf-8" });
  response.end(css);
}

function serveChartAuthoring(response: ServerResponse): void {
  let markdown: string;
  try {
    markdown = readFileSync(chartAuthoringPath(), "utf8");
  } catch {
    writeJson(response, 404, { error: "the chart authoring guide is not installed on this server yet" });
    return;
  }
  response.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
  response.end(markdown);
}

function isLocalChartReviewRequest(request: IncomingMessage, pathname: string): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    return false;
  }
  if (request.method === "GET") {
    if (/^\/charts\/[0-9a-f]+\/review$/.test(pathname) || /^\/charts\/[0-9a-f]+(?:\/index\.html)?$/.test(pathname)) {
      return true;
    }
    const assetMatch = pathname.match(/^\/charts\/[0-9a-f]+\/([^/]+)/);
    const reserved = new Set(["asset64", "feedback", "finalize", "html", "layout-warnings", "review"]);
    return !!assetMatch && !reserved.has(assetMatch[1] ?? "");
  }
  if (request.method === "POST") {
    return /^\/charts\/[0-9a-f]+\/(?:feedback|layout-warnings)$/.test(pathname);
  }
  return false;
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

// The review-chrome statics (chartChromeAsset is a fixed two-file allowlist,
// so the request name never touches the filesystem as a path).
function serveChartChromeAsset(response: ServerResponse, name: string): void {
  const asset = chartChromeAsset(name);
  if (!asset) {
    writeJson(response, 404, { error: "Not found" });
    return;
  }
  let body: string;
  try {
    body = readFileSync(asset.path, "utf8");
  } catch {
    writeJson(response, 404, { error: "Not found" });
    return;
  }
  response.writeHead(200, { "content-type": asset.contentType });
  response.end(body);
}

const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8"
};

function assetContentType(file: string): string {
  return ASSET_CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

// Deliver composer text so it actually SUBMITS - a raw PTY write leaves the
// text sitting unsent in the agent TUI's input line (both claude and codex
// treat embedded/trailing newlines as composer content, never as Enter), so
// every delivery path must end with a distinct Enter. Codex `--remote`: when a
// control client owns the shared thread and no permission prompt is open,
// submit the turn over the protocol so any armed model override actually
// reaches the daemon (and the turn shows in the real TUI). Any miss falls
// through to the monitor's PTY path (text landed in the input line, then a
// separate Enter), which also queue-gates while a permission prompt is open.
async function deliverInput(
  options: HttpServerOptions,
  canonicalSessionId: string,
  text: string,
  source: "human" | "agent"
): Promise<{ queued: boolean }> {
  if (
    options.codexControl?.has(canonicalSessionId) &&
    !options.monitor.pendingApproval(canonicalSessionId)
  ) {
    if (await options.codexControl.submitTurn(canonicalSessionId, text, source)) {
      // Protocol submission bypasses FleetMonitor.submitToAdapter, so mirror
      // its post-submit lifecycle signal here. This is an accepted new turn,
      // not generic running/status activity.
      markTaskWorkingFromActivity({ tasks: options.tasks }, canonicalSessionId, { newTurn: true });
      return { queued: false };
    }
  }
  return options.monitor.queueOrSubmit(canonicalSessionId, text);
}

const INPUT_ACCEPT_WAIT_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deliverInputAccepted(
  options: HttpServerOptions,
  canonicalSessionId: string,
  text: string,
  source: "human" | "agent"
): Promise<{ queued: boolean }> {
  const delivery = deliverInput(options, canonicalSessionId, text, source);
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

// The revised plan markdown of an edit-a-finalized-plan dispatch is staged
// centrally and committed by the worker; bound it so a bad request cannot
// stage an unbounded file. Generous next to a plan doc's real size.
const MAX_PLAN_EDIT_CONTENT_BYTES = 512 * 1024;

// Validate a plan-edit request's target path and content. The path must be a
// repo-relative flat `docs/plans/<name>.md` with no traversal (the worker
// resolves it inside its own worktree; the server never writes to a repo).
// Returns an error message, or undefined when valid.
function planEditError(planEdit: { path?: unknown; content?: unknown }): string | undefined {
  const path = planEdit.path;
  if (typeof path !== "string" || path.trim().length === 0) {
    return "planEdit.path required";
  }
  const parts = path.trim().split("/");
  if (path.trim().startsWith("/") || /^[a-zA-Z]:/.test(path.trim())) {
    return "planEdit.path must be repo-relative, not absolute";
  }
  if (parts.includes("..") || parts.includes(".") || parts.includes("")) {
    return "planEdit.path must not contain empty, . or .. segments";
  }
  if (parts.length !== 3 || parts[0] !== "docs" || parts[1] !== "plans" || !/\.md$/i.test(path.trim())) {
    return "planEdit.path must be docs/plans/<name>.md";
  }
  if (typeof planEdit.content !== "string" || planEdit.content.length === 0) {
    return "planEdit.content required";
  }
  const bytes = Buffer.byteLength(planEdit.content, "utf8");
  if (bytes > MAX_PLAN_EDIT_CONTENT_BYTES) {
    return `planEdit.content too large: ${bytes} bytes (max ${MAX_PLAN_EDIT_CONTENT_BYTES})`;
  }
  return undefined;
}

// The planId a dispatched task is stamped with: an explicit planId wins;
// otherwise a plan-edit defaults to the edited plan's path (so the edit's own
// task is discoverable by `listByPlan`).
function resolveTaskPlanId(body: CreateTaskRequest): string | undefined {
  if (typeof body.planId === "string" && body.planId.trim().length > 0) {
    return body.planId.trim();
  }
  if (body.planEdit && typeof body.planEdit.path === "string") {
    return body.planEdit.path.trim();
  }
  return undefined;
}

function idempotencyKeyError(key: unknown): string | undefined {
  if (key === undefined) return undefined;
  if (typeof key !== "string" || key.trim().length === 0) {
    return "idempotencyKey must be a non-empty string";
  }
  if (key.length > 200) return "idempotencyKey is too long (max 200 characters)";
  return undefined;
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
  const idempotencyError = idempotencyKeyError(body.idempotencyKey);
  if (idempotencyError) {
    writeJson(response, 400, { error: idempotencyError });
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
    if (!body.parent) body.parent = hookSessionId;
  }

  if (body.planEdit) {
    const err = planEditError(body.planEdit);
    if (err) {
      writeJson(response, 400, { error: err });
      return;
    }
  }

  const repeated = repeatedDispatchTask(body, options);
  if (repeated) {
    writeJson(response, 201, { task: await resumeRepeatedDispatch(body, repeated, options) });
    return;
  }

  const refused = await refuseUnreadyNoMistakesDispatch(body, options);
  if (refused) {
    writeJson(response, refused.status, refused.body);
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
    kind: body.kind,
    // Per-project delivery mode is the default; an explicit mode wins.
    mode: body.mode ?? options.projects.find(body.project)?.mode,
    planId: resolveTaskPlanId(body)
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
  // Edit-a-finalized-plan-as-a-commit: stage the revised markdown centrally
  // (never in the repo) and point the brief at it; the worker commits it.
  const planBrief = body.planEdit
    ? { edit: { relativePath: body.planEdit.path, stagedPath: options.tasks.stagePlanEdit(task.id, body.planEdit.content) } }
    : {};
  const prompt = body.prompt?.trim() || task.title;
  const kickoff = prompt + dispatchBrief(task, lease.path, planBrief, agent);
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
  const idempotencyError = idempotencyKeyError(body.idempotencyKey);
  if (idempotencyError) return rpcError(400, idempotencyError);

  if (body.planEdit) {
    const err = planEditError(body.planEdit);
    if (err) return rpcError(400, err);
  }

  const repeated = repeatedDispatchTask(body, options);
  if (repeated) {
    return rpcOk(201, { task: await resumeRepeatedDispatch(body, repeated, options) });
  }

  const refused = await refuseUnreadyNoMistakesDispatch(body, options);
  if (refused) return refused;

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
      return rpcError(409, error instanceof Error ? error.message : String(error));
    }
  }
  // Fleet mate defaults (`perch config mate-*`) shape a fresh mate here just
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
    const result = await startManagedAgent(options, {
      request: {
        command: agent,
        agent,
        cwd: home,
        title: "mate",
        labels: { role: "mate" },
        ...(Array.isArray(body.args) ? { args: body.args } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {})
      },
      auditMeta: auditPeer,
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
  if (!force) {
    const ownLease = ownLeaseFor(task, options.worktrees);
    const verdict = await landedGate(task, ownLease?.path);
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
    { force }
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

  const decisionData = {
    completionDecision: {
      action: body.action,
      requestSeq: body.requestSeq,
      idempotencyKey: key,
      ...(feedback ? { feedback } : {})
    }
  };
  let updated = options.tasks.recordEvent(taskId, {
    kind: body.action === "accept" ? "completion_accepted" : "completion_rejected",
    source: "system",
    message: body.action === "accept" ? "mate verified the requested deliverable" : feedback,
    data: decisionData
  });

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

// The boss's answer to a parked no-mistakes gate (v2 phone surface, O3): the
// decision becomes the matching `no-mistakes axi respond ...` line injected
// into the worker session's composer (queue-gated like every mobile message),
// with a ledger note, an audit record, and an FYI wake to the mate so it
// never double-answers a gate the boss already resolved.
async function taskDecisionRpc(
  taskId: string,
  body: TaskDecisionRequest,
  options: HttpServerOptions,
  auditPeer: Pick<Parameters<AuditLog["write"]>[0], "deviceId">
): Promise<RpcResult> {
  const task = options.tasks.find(taskId);
  if (!task) {
    return rpcError(404, `Unknown task: ${taskId}`);
  }

  if (body.action !== "approve" && body.action !== "fix" && body.action !== "skip") {
    return rpcError(400, "action must be approve, fix, or skip");
  }
  if (body.findingIds !== undefined) {
    if (
      !Array.isArray(body.findingIds) ||
      body.findingIds.some((id) => typeof id !== "string" || id.trim().length === 0)
    ) {
      return rpcError(400, "findingIds must be an array of non-empty strings");
    }
  }
  if (body.instructions !== undefined) {
    if (typeof body.instructions !== "string") {
      return rpcError(400, "instructions must be a string");
    }
    if (body.instructions.length > MAX_DECISION_INSTRUCTIONS_CHARS) {
      return rpcError(400, `instructions too long (max ${MAX_DECISION_INSTRUCTIONS_CHARS} characters)`);
    }
  }
  const findingIds = body.findingIds?.length ? body.findingIds : undefined;
  const instructions = body.instructions?.trim() ? body.instructions.trim() : undefined;
  // Upstream's respond only takes --findings/--instructions with fix; anything
  // the boss typed must reach the pipeline, so refuse rather than drop it.
  if (body.action !== "fix" && (findingIds || instructions)) {
    return rpcError(400, 'findingIds and instructions only apply to action "fix"');
  }

  if (task.state !== "needs_you") {
    return rpcError(409, `Task is ${task.state}, not waiting on a decision`);
  }
  // The gate being answered: the latest needs_decision carrying findings.
  const gate = [...options.tasks.events(taskId)]
    .reverse()
    .map((event) => (event.kind === "needs_decision" ? parseNoMistakesGate(event.data) : undefined))
    .find((parsed) => parsed !== undefined);
  if (!gate) {
    return rpcError(409, "No parked no-mistakes gate on this task");
  }
  if (findingIds) {
    const known = new Set(gate.findings.map((finding) => finding.id));
    const unknown = findingIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      return rpcError(409, `Unknown finding ids (the gate may have changed): ${unknown.join(", ")}`);
    }
  }

  // The injection target is the worker session driving the pipeline; a dead
  // worker cannot receive the answer, so fail loudly instead of queueing into
  // the void.
  if (!task.sessionId) {
    return rpcError(409, "Task has no worker session to deliver the decision to");
  }
  const sessionId = canonicalSessionIdFor(options.adapter, task.sessionId);
  const sessions = await options.adapter.listSessions();
  const worker = sessions.find((session) => session.id === sessionId);
  if (!worker || worker.status === "done" || worker.status === "error") {
    return rpcError(409, "The worker session is gone; the decision cannot be delivered");
  }

  const decision: GateDecision = {
    action: body.action,
    ...(findingIds ? { findingIds } : {}),
    ...(instructions ? { instructions } : {})
  };
  const line = decisionInjectionLine(gate, decision);
  const { queued } = await deliverInput(options, sessionId, line, "human");

  // The ledger keeps the story: a note never moves state (the worker's own
  // `working` resume does), and the card reads it to stop re-asking.
  let updated = task;
  try {
    updated = options.tasks.recordEvent(taskId, {
      kind: "note",
      source: "system",
      message: `boss decision on ${gate.step} gate: ${decisionSummary(decision)}`,
      data: { noMistakesDecision: { step: gate.step, ...decision } }
    });
  } catch {
    // The injection already landed; a failed note must not fail the verb.
  }

  await audit(options.auditLog, {
    action: "task_decision",
    sessionId,
    ...auditPeer,
    taskId,
    textLength: line.length
  });

  // O3: FYI-wake the mate so it never double-answers this gate.
  const mate = sessions.find((session) => session.labels?.role === "mate");
  if (mate && mate.id !== sessionId) {
    try {
      await options.monitor.queueOrSubmit(mate.id, decisionMateFyi(taskWakeIdentity(updated), gate, decision));
    } catch {
      // The mate wake is best-effort; the decision already reached the worker.
    }
  }

  const responseBody: TaskDecisionResponse = { ok: true, queued, task: updated };
  return rpcOk(202, responseBody);
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
    const armed = options.codexControl?.switchModel(canonicalSessionId, body.model.trim(), body.effort);
    if (!armed) {
      return rpcError(409, "This Codex session is running PTY-only; model switching needs the app-server daemon");
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
// to the task's own session; a done verb carrying a PR URL arms the poller.
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
  if (!bearer) {
    const sessionId = String(request.headers["x-perch-session"] ?? "");
    const token = String(request.headers["x-perch-token"] ?? "");
    const reason = !sessionId || !token
      ? "missing_credentials"
      : !options.hooks.verify(sessionId, token)
        ? "invalid_credentials"
        : task.sessionId !== sessionId
          ? "task_session_mismatch"
          : undefined;
    if (reason) {
      // curl -f intentionally hides the response body from workers. Keep the
      // rejection visible in server.log without ever printing the hook token.
      console.warn(
        `task-event: rejected status=401 task=${taskId} session=${sessionId ? sessionId.slice(0, 16) : "missing"} reason=${reason}`
      );
      writeJson(response, 401, { error: "Unauthorized" });
      return;
    }
    source = "worker";
  }

  const body = await readJson<TaskEventRequest>(request);
  const allowed: TaskEventKind[] = ["working", "needs_decision", "blocked", "done", "failed", "note"];
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
  let prUrl = typeof body.pr === "string" ? body.pr : extractPrUrl(message);
  let pr: TaskPr | undefined;
  // Scouts deliver reports, and local-only tasks deliberately have no remote
  // delivery contract. Only remote ship modes discover and validate PRs.
  const requiresPr = task.kind !== "scout" && task.mode !== "local-only";
  if (body.kind === "done" && requiresPr && !prUrl && !task.pr?.merged && task.branch) {
    const discovered = await options.prPoller.discoverTaskPr(task);
    if (!discovered.ok) {
      writeJson(response, 409, { error: discovered.reason });
      return;
    }
    prUrl = discovered.prUrl;
  }
  if (body.kind === "done" && requiresPr && prUrl && !task.pr?.merged) {
    const checkoutPath = (task.worktreeId ? options.worktrees.find(task.worktreeId)?.path : undefined) ?? task.project;
    const attachment = await options.prPoller.resolveTaskPr(task, prUrl, checkoutPath);
    if (!attachment.ok) {
      writeJson(response, 409, { error: attachment.reason });
      return;
    }
    pr = attachment.pr;
  }

  // Structured payload (data.noMistakes findings and friends): persisted onto
  // the event verbatim, bounded so one verb cannot bloat the ledger or the
  // fan-out to phones and the mate.
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

  let updated;
  try {
    // Keep the worker's long-standing `done` wire verb, but interpret every
    // report as a completion claim. Trusted done is created only by the mate's
    // explicit /completion accept action.
    const kind = body.kind === "done" ? "completion_requested" : body.kind;
    updated = options.tasks.recordEvent(taskId, { kind, message, source, ...(data ? { data } : {}) });
  } catch (error) {
    writeJson(response, 409, { error: error instanceof Error ? error.message : String(error) });
    return;
  }

  // A finished worker naming its PR arms the reconcile loop: one eager poll
  // now, plus a fast window while the fresh PR's checks are expected to move.
  if (pr && !updated.pr?.merged) {
    updated = options.tasks.update(taskId, { pr: { ...updated.pr, ...pr } });
    options.prPoller.armFast(taskId);
    void options.prPoller.tick().catch(() => {});
  }

  writeJson(response, 200, { task: updated });
}

async function handleNoMistakesAuthorization(
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpServerOptions
): Promise<void> {
  const sessionId = String(request.headers["x-perch-session"] ?? "");
  const token = String(request.headers["x-perch-token"] ?? "");
  if (!sessionId || !token || !options.hooks.verify(sessionId, token)) {
    writeJson(response, 401, { error: "Unauthorized" });
    return;
  }

  // Runtime ownership is authoritative and is bound before the kickoff prompt
  // can run. Task projection linkage follows immediately after launch, so
  // deriving through the runtime also closes that small initial dispatch race.
  const sessionRuntime = options.tasks.stateDb.runtimes.findBySession(sessionId);
  const task = sessionRuntime
    ? options.tasks.find(sessionRuntime.taskId)
    : options.tasks.list().find((candidate) => candidate.sessionId === sessionId);
  if (!task) {
    writeJson(response, 403, { error: "No durable task is linked to this worker session" });
    return;
  }

  const body = await readJson<NoMistakesAuthorizationRequest>(request);
  const protocolVersion = boundedPolicyString(body.protocolVersion, 16);
  const requestId = boundedPolicyString(body.requestId, 128);
  const taskId = boundedPolicyString(body.taskId, 256);
  const requestSessionId = boundedPolicyString(body.sessionId, 256);
  const projectPath = boundedPolicyString(body.projectPath, 4_096);
  const repository = boundedPolicyString(body.repository, 4_096);
  const worktreePath = boundedPolicyString(body.worktreePath, 4_096);
  const branch = boundedPolicyString(body.branch, 512);
  const operation = boundedPolicyString(body.operation, 32);
  const durableMode = boundedPolicyString(body.durableMode, 32);
  const requestGeneration = Number.isSafeInteger(body.runtimeGeneration) ? body.runtimeGeneration : -1;
  const runtime = sessionRuntime ?? options.tasks.stateDb.runtimes.latestForTask(task.id);
  const expectedWorktree = runtime?.worktreePath ??
    (task.worktreeId ? options.worktrees.find(task.worktreeId)?.path : undefined);
  const expectedBranch = task.branch ?? `perch/${task.id}`;
  const expectedRepository = canonicalRepositoryForPath(expectedWorktree ?? task.project) ??
    canonicalRepositoryForPath(task.project);
  const replayed = requestId.length > 0 && options.tasks.events(task.id).some((event) => {
    const evidence = event.data?.noMistakesAuthorization;
    return Boolean(
      evidence &&
      typeof evidence === "object" &&
      "requestId" in evidence &&
      (evidence as { requestId?: unknown }).requestId === requestId
    );
  });

  let reason = "authorized";
  if (
    protocolVersion !== "1" ||
    !/^[a-f0-9]{32}$/.test(requestId) ||
    !taskId ||
    !requestSessionId ||
    !projectPath ||
    !repository ||
    !worktreePath ||
    !branch ||
    !operation ||
    !durableMode ||
    requestGeneration < 0
  ) {
    reason = "invalid_request";
  } else if (replayed) {
    reason = "request_replayed";
  } else if (taskId !== task.id) {
    reason = "task_mismatch";
  } else if (requestSessionId !== sessionId) {
    reason = "session_mismatch";
  } else if (canonicalPolicyPath(projectPath) !== canonicalPolicyPath(task.project)) {
    reason = "project_mismatch";
  } else if (!expectedRepository || canonicalRepository(repository) !== expectedRepository) {
    reason = "repository_mismatch";
  } else if (!runtime) {
    reason = "runtime_missing";
  } else if (requestGeneration !== runtime.generation) {
    reason = "runtime_generation_mismatch";
  } else if (runtime.ptySessionId !== sessionId) {
    reason = "runtime_session_mismatch";
  } else if (runtime.state !== "live") {
    reason = "runtime_not_live";
  } else if (!expectedWorktree || canonicalPolicyPath(worktreePath) !== canonicalPolicyPath(expectedWorktree)) {
    reason = "worktree_mismatch";
  } else if (branch !== expectedBranch) {
    reason = "branch_mismatch";
  } else if (!new Set(["run", "gate-push", "agent-launch"]).has(operation)) {
    reason = "unsupported_operation";
  } else if (durableMode !== task.mode) {
    reason = "durable_mode_mismatch";
  } else if (task.mode !== "no-mistakes") {
    reason = "durable_task_mode_denied";
  }

  let allowed = reason === "authorized";
  const decision = (): NoMistakesAuthorizationResponse => ({
    protocolVersion: "1",
    requestId,
    operation: operation as NoMistakesAuthorizationResponse["operation"],
    taskId,
    runtimeGeneration: requestGeneration,
    sessionId: requestSessionId,
    projectPath,
    repository: canonicalRepository(repository),
    worktreePath,
    branch,
    durableMode: durableMode as NoMistakesAuthorizationResponse["durableMode"],
    allowed,
    reason
  });
  try {
    options.tasks.recordEvent(task.id, {
      kind: "note",
      source: "system",
      message: `no-mistakes authorization ${allowed ? "allowed" : "denied"}: ${reason}`,
      data: {
        noMistakesAuthorization: {
          ...decision(),
          evidenceVersion: 1
        }
      }
    });
  } catch {
    allowed = false;
    reason = "durable_audit_failed";
    writeJson(response, 503, decision());
    return;
  }

  await audit(options.auditLog, {
    action: "no_mistakes_authorization",
    sessionId,
    taskId: task.id,
    worktreeId: runtime?.worktreeId,
    runtimeGeneration: runtime?.generation ?? -1,
    durableMode: task.mode,
    requestId,
    protocolVersion,
    operation,
    repository: canonicalRepository(repository),
    decision: allowed ? "allow" : "deny",
    reason
  });
  writeJson(response, allowed ? 200 : 403, decision());
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

// Chart registration (the `chart` verb): hook-token callers are pinned to
// their own session, exactly like the task verbs; the server token registers
// on a named session (the mate). Devices never register - fail-closed.
async function handleRegisterChart(
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpServerOptions
): Promise<void> {
  if (!options.charts) {
    writeJson(response, 501, { error: "Charts are not enabled on this server" });
    return;
  }
  const body = await readJsonOrEmpty<RegisterChartRequest>(request);
  const bearer = authenticate(request, options);
  let result: RpcResult;
  if (bearer) {
    if (bearer.kind !== "server") {
      writeJson(response, 403, { error: "Chart registration needs the session hook token or the server token" });
      return;
    }
    result = await registerChartBearer(body as RegisterChartRequest, options, {
      remoteAddress: request.socket.remoteAddress
    });
  } else {
    const sessionId = String(request.headers["x-perch-session"] ?? "");
    const token = String(request.headers["x-perch-token"] ?? "");
    if (!sessionId || !token || !options.hooks.verify(sessionId, token)) {
      writeJson(response, 401, { error: "Unauthorized" });
      return;
    }
    result = await registerChartCore(body.file, sessionId, options, {
      remoteAddress: request.socket.remoteAddress
    });
  }
  writeJson(response, result.status, result.body);
}

// Bearer registration must name a LIVE owning session: feedback routes into
// that session's PTY, so binding a chart to a bogus id would make every
// review dead-end on the dead-session error.
async function registerChartBearer(
  body: RegisterChartRequest,
  options: HttpServerOptions,
  auditMeta: Pick<Parameters<AuditLog["write"]>[0], "deviceId" | "remoteAddress">
): Promise<RpcResult> {
  if (typeof body.sessionId !== "string" || body.sessionId.trim().length === 0) {
    return rpcError(400, "sessionId required when registering with the server token");
  }
  const canonical = canonicalSessionIdFor(options.adapter, body.sessionId);
  const sessions = await options.adapter.listSessions();
  if (!sessions.some((session) => session.id === canonical)) {
    return rpcError(400, `Unknown session: ${body.sessionId}`);
  }
  // Optional project tag: resolve it to a tracked project's rootPath now, so a
  // chart with no task still groups under its project. Unresolvable is a hard
  // 400 (never silently dropped into "ungrouped").
  let projectRoot: string | undefined;
  if (typeof body.project === "string" && body.project.trim().length > 0) {
    const resolved = resolveTrackedProject(options.projects, body.project.trim());
    if (!resolved) {
      return rpcError(400, `Unknown project: ${body.project}`);
    }
    projectRoot = resolved.rootPath;
  }
  return registerChartCore(body.file, canonical, options, auditMeta, projectRoot);
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

async function registerChartCore(
  file: unknown,
  owningSessionId: string,
  options: HttpServerOptions,
  auditMeta: Pick<Parameters<AuditLog["write"]>[0], "deviceId" | "remoteAddress">,
  projectRoot?: string
): Promise<RpcResult> {
  if (!options.charts) {
    return rpcError(501, "Charts are not enabled on this server");
  }
  if (typeof file !== "string" || file.trim().length === 0) {
    return rpcError(400, "file required");
  }
  // Task linkage: the owning session's open task, when it has one.
  const task = options.tasks
    .list()
    .find((candidate) => candidate.sessionId === owningSessionId && candidate.state !== "closed");
  // Crew parentage: the owning session's supervising session (normally the
  // mate), captured now so the chart surfaces up the chain after the worker
  // session is gone.
  let parentSessionId: string | undefined;
  try {
    const sessions = await options.adapter.listSessions();
    parentSessionId = sessions.find((session) => session.id === owningSessionId)?.labels?.parent;
  } catch {
    // Parentage is best-effort; registration must not fail on a fleet hiccup.
  }
  let chart: Chart;
  try {
    chart = options.charts.register(file, {
      sessionId: owningSessionId,
      ...(task ? { taskId: task.id, taskTitle: task.title } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(projectRoot ? { projectRoot } : {})
    });
  } catch (error) {
    return rpcError(400, error instanceof Error ? error.message : String(error));
  }
  await audit(options.auditLog, {
    action: "register_chart",
    sessionId: owningSessionId,
    chartId: chart.id,
    ...(task ? { taskId: task.id } : {}),
    ...auditMeta
  });
  const responseBody: RegisterChartResponse = { chart, url: `/charts/${chart.id}` };
  return rpcOk(201, responseBody);
}

// Boss feedback on a chart -> one normalized block into the owning session's
// composer through the queue-gated path (queues while a permission prompt is
// open, exactly like any composer message - attention, never an approval
// gate). A dead owning session is an explicit 409 naming the alternatives
// (mate / fresh agent); feedback is never silently queued for a corpse.
// The unified hub listing: every registered chart grouped by its owning project
// (resolved through task linkage) with that project's committed docs/plans,
// plus charts that resolve
// to no tracked project. One read source for the mobile hub and the desktop
// /charts gallery.
function chartsHubResult(options: HttpServerOptions): RpcResult {
  const charts = options.charts;
  if (!charts) {
    return rpcError(501, "Charts are not enabled on this server");
  }
  const hub = buildChartsHub(charts.list(), options.projects.list(), chartProjectResolver(options));
  return rpcOk(200, hub);
}

// Map a chart to its owning tracked project's rootPath for hub grouping. An
// explicit `projectRoot` (the mate path) wins when it still names a tracked
// project; otherwise fall back to task-linkage inference (a dispatched
// worker's task carries its project). Untagged, task-less charts resolve to
// undefined and land in "ungrouped".
function chartProjectResolver(options: HttpServerOptions): (chart: Chart) => string | undefined {
  return (chart) => {
    if (chart.projectRoot && options.projects.find(chart.projectRoot)) {
      return chart.projectRoot;
    }
    return chart.taskId ? options.tasks.find(chart.taskId)?.project : undefined;
  };
}

// Render a tracked project's committed plan doc as a chart-styled HTML page.
// Read-only and strictly confined to tracked projects' docs/plans - `requested`
// may be the absolute path the hub lists (ChartPlanDoc.path) or a repo-relative
// docs/plans/<name>.md; anything resolving outside is a 404, never a read. Both
// front-ends (the mobile hub and the desktop gallery) tap into it to render a
// plan's content in the same look a chart gets.
function renderPlanDoc(options: HttpServerOptions, requested: string): { status: number; html?: string; error?: string } {
  const wanted = requested.trim();
  if (!wanted) {
    return { status: 400, error: "path required" };
  }
  const roots = options.projects.list().map((project) => project.rootPath);
  const file = resolvePlanDocPath(wanted, roots);
  if (!file) {
    return { status: 404, error: "Unknown plan doc" };
  }
  let markdown: string;
  try {
    markdown = readFileSync(file, "utf8");
  } catch {
    return { status: 404, error: `Plan doc is gone: ${file}` };
  }
  return { status: 200, html: renderPlanHtml(markdown, file) };
}

// Approve a chart into the finalized state. A boss action from either
// front-end (button or command) - device/bearer auth, audit-logged like every
// other mutating action. Idempotent in the registry.
async function finalizeChartResult(
  chartId: string,
  options: HttpServerOptions,
  auditMeta: Pick<Parameters<AuditLog["write"]>[0], "deviceId" | "remoteAddress">
): Promise<RpcResult> {
  const charts = options.charts;
  if (!charts) {
    return rpcError(501, "Charts are not enabled on this server");
  }
  const chart = charts.finalize(chartId);
  if (!chart) {
    return rpcError(404, `Unknown chart: ${chartId}`);
  }
  await audit(options.auditLog, {
    action: "finalize_chart",
    chartId: chart.id,
    ...auditMeta
  });
  const responseBody: FinalizeChartResponse = { chart };
  return rpcOk(200, responseBody);
}

// The chart document as JSON (SDK injected), for the relay RPC surface.
function chartHtmlRpc(chartId: string, options: HttpServerOptions): RpcResult {
  const charts = options.charts;
  if (!charts) {
    return rpcError(501, "Charts are not enabled on this server");
  }
  const chart = charts.find(chartId);
  if (!chart) {
    return rpcError(404, `Unknown chart: ${chartId}`);
  }
  // Snapshot-first, like the raw HTML route: the chart outlives its worktree.
  let html: string;
  try {
    html = readFileSync(charts.htmlFileFor(chart), "utf8");
  } catch {
    return rpcError(404, `Chart file is gone: ${chart.file}`);
  }
  const responseBody: ChartHtmlResponse = { chart, html: injectChartSdk(html) };
  return rpcOk(200, responseBody);
}

// A chart sibling asset (or chart.css) as base64 JSON, for the relay RPC
// surface. Same directory confinement as the raw asset route.
function chartAssetRpc(chartId: string, assetPath: string, options: HttpServerOptions): RpcResult {
  const charts = options.charts;
  if (!charts) {
    return rpcError(501, "Charts are not enabled on this server");
  }
  const chart = charts.find(chartId);
  if (!chart) {
    return rpcError(404, `Unknown chart: ${chartId}`);
  }
  if (!assetPath) {
    return rpcError(400, "path required");
  }
  const file = assetPath === "chart.css" ? chartCssPath() : charts.assetFileFor(chart, assetPath);
  if (!file) {
    return rpcError(403, "Forbidden");
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    return rpcError(404, "Not found");
  }
  const responseBody: ChartAssetResponse = {
    base64: bytes.toString("base64"),
    contentType: assetContentType(file)
  };
  return rpcOk(200, responseBody);
}

async function chartFeedbackRpc(
  chartId: string,
  body: ChartFeedbackRequest,
  options: HttpServerOptions,
  auditMeta: Pick<Parameters<AuditLog["write"]>[0], "deviceId" | "remoteAddress">
): Promise<RpcResult> {
  const charts = options.charts;
  if (!charts) {
    return rpcError(501, "Charts are not enabled on this server");
  }
  const chart = charts.find(chartId);
  if (!chart) {
    return rpcError(404, `Unknown chart: ${chartId}`);
  }
  const annotations = Array.isArray(body.annotations) ? body.annotations : [];
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (annotations.length === 0 && !message) {
    return rpcError(400, "feedback needs annotations or a message");
  }
  const sessions = options.monitor.withLiveState(await options.adapter.listSessions());
  const owner = sessions.find((session) => session.id === chart.sessionId);
  if (!owner || owner.status === "done" || owner.status === "error") {
    const mate = sessions.find(
      (session) =>
        session.labels?.role === "mate" && session.status !== "done" && session.status !== "error"
    );
    return {
      status: 409,
      body: {
        error: `The session that drew this chart is gone (${chart.sessionId}). Route the feedback to the mate or start a fresh agent with the chart as context.`,
        chartId: chart.id,
        alternatives: ["mate", "new_agent"],
        ...(mate ? { mateSessionId: mate.id } : {})
      }
    };
  }
  const block = formatChartFeedback(chart, { message, annotations });
  const { queued } = await deliverInput(options, chart.sessionId, block, "human");
  await audit(options.auditLog, {
    action: "chart_feedback",
    sessionId: chart.sessionId,
    chartId: chart.id,
    ...(chart.taskId ? { taskId: chart.taskId } : {}),
    ...auditMeta,
    textLength: block.length
  });
  const responseBody: ChartFeedbackResponse = { ok: true, queued };
  return rpcOk(202, responseBody);
}

// Layout-audit findings from the injected SDK, delivered to the drawing agent
// through the same composer path but prefixed as machine feedback. Unchanged
// or empty reports are dropped (never spam the composer on every reload), and
// a dead owning session degrades to delivered:false - unlike boss feedback,
// there is no one to fix the layout, so nothing needs re-routing.
async function chartLayoutWarningsRpc(
  chartId: string,
  body: ChartLayoutWarningsRequest,
  options: HttpServerOptions,
  auditMeta: Pick<Parameters<AuditLog["write"]>[0], "deviceId" | "remoteAddress">
): Promise<RpcResult> {
  const charts = options.charts;
  if (!charts) {
    return rpcError(501, "Charts are not enabled on this server");
  }
  const chart = charts.find(chartId);
  if (!chart) {
    return rpcError(404, `Unknown chart: ${chartId}`);
  }
  const raw = body.layout_warnings ?? body.layoutWarnings ?? [];
  const { changed, warnings } = charts.recordLayoutWarnings(chart.id, raw);
  if (!changed || warnings.length === 0) {
    return rpcOk(200, { ok: true, delivered: false });
  }
  const sessions = options.monitor.withLiveState(await options.adapter.listSessions());
  const owner = sessions.find((session) => session.id === chart.sessionId);
  if (!owner || owner.status === "done" || owner.status === "error") {
    return rpcOk(200, { ok: true, delivered: false, note: "owning session is gone" });
  }
  const block = formatLayoutWarnings(chart, warnings);
  // Machine-origin provenance: the audit is not the boss typing.
  options.timeline.recordSource(chart.sessionId, block, "agent");
  const { queued } = await deliverInput(options, chart.sessionId, block, "agent");
  await audit(options.auditLog, {
    action: "chart_layout",
    sessionId: chart.sessionId,
    chartId: chart.id,
    ...(chart.taskId ? { taskId: chart.taskId } : {}),
    ...auditMeta,
    textLength: block.length
  });
  return rpcOk(202, { ok: true, queued, delivered: true });
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

  if (!force) {
    const ownLease = ownLeaseFor(task, options.worktrees);
    const verdict = await landedGate(task, ownLease?.path);
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
    { force, remoteAddress: request.socket.remoteAddress }
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
    const sessionId = String(request.headers["x-perch-session"] ?? "");
    const token = String(request.headers["x-perch-token"] ?? "");
    const payload = await readJsonOrEmpty<HookEventPayload>(request);
    const requestedEventName = hookEventName(payload);
    synchronousClaudeControl = requestedEventName === "PermissionRequest" ||
      requestedEventName === "Elicitation" || requestedEventName === "ElicitationResult" ||
      (requestedEventName === "PreToolUse" &&
        (payload.tool_name === ASK_USER_QUESTION_TOOL || payload.tool_name === "ExitPlanMode"));
    if (!sessionId || !options.hooks.verify(sessionId, token)) {
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
    const codexControlOwnsTurnBoundary = format === "codex" && options.codexControl?.has(sessionId) === true;

    // Snapshot the immutable task-event sequence before the automatic
    // new-turn working event. Native Codex control owns this boundary when
    // attached; plain Codex PTY fallback uses its verified hooks like Claude.
    if (eventName === "UserPromptSubmit" && !codexControlOwnsTurnBoundary) {
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

    // Codex hooks carry the codex session id but no transcript path; the
    // rollout filename embeds that id, so resolve it by scanning the sessions
    // dir. The file can appear moments after SessionStart, hence the retry.
    if (
      format === "codex" &&
      normalized.correlation?.agentSessionId &&
      !normalized.correlation.transcriptPath &&
      !options.hooks.correlation(sessionId)?.transcriptPath
    ) {
      attachCodexRollout(options, sessionId, normalized.correlation.agentSessionId);
    }

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
        if (correlation.transcriptPath) {
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
      eventName === "Stop" && !codexControlOwnsTurnBoundary
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
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: CHART_CAPABILITY_NOTE }
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
}
