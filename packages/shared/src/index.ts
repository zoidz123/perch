export type AgentKind = "codex" | "claude" | "shell" | "unknown";

export type SurfaceKind = "terminal" | "browser" | "unknown";

export type AgentSessionStatus =
  | "idle"
  | "running"
  | "waiting"
  | "needs_approval"
  | "done"
  | "error";

export type AgentSession = {
  id: string;
  title: string;
  // Short temporary identity for a dispatched worker. Stable for the linked
  // task/session lifetime; absent for mates, solo sessions, and older records.
  workerName?: string;
  agent: AgentKind;
  cwd?: string;
  // Git branch of cwd at spawn time, when cwd is a repo (best-effort).
  branch?: string;
  // Grouping labels from StartAgentRequest (crew parentage, task linkage).
  labels?: Record<string, string>;
  // Pool lease id when the session runs in a perch-managed worktree.
  worktreeId?: string;
  workspaceId?: string;
  paneId?: string;
  surfaceId?: string;
  kind: SurfaceKind;
  status: AgentSessionStatus;
  // The exact model + reasoning effort the session is running RIGHT NOW,
  // resolved server-side from what the agent is actually configured to use
  // (launch flag, the CLI's own config default, or a live in-session switch)
  // and kept current as it changes. `model` is the CLI model id (e.g.
  // "gpt-5.5", "opus"); `modelLabel` is its versioned display name (e.g.
  // "GPT-5.5", "Opus 4.8"); `effort` is the Codex reasoning tier (Claude has
  // no effort control, so it is Codex-only). Append-only + best-effort: absent
  // only when it genuinely can't be resolved, and older clients ignore them.
  model?: string;
  modelLabel?: string;
  effort?: CodexReasoningEffort;
  lastActivityAt: string;
  // Small last-lines preview for the fleet overview tier. Terminal surfaces
  // only, captured on activity - not full scrollback (that is the detail tier).
  tail?: string;
  // Optional desktop location for a Perch-owned process. The session `id`
  // remains the canonical agent id; this is only where it is attached locally.
  desktop?: DesktopContext;
  // Set while the agent is blocked on a permission prompt; cleared when the
  // prompt resolves. Drives the native approval card on the phone.
  pendingApproval?: PendingApproval;
  // Authoritative Codex app-server request. Unlike `pendingApproval`, this is
  // resolved through the matching JSON-RPC request id, never PTY keystrokes.
  pendingServerRequest?: PendingServerRequest;
  // Set while the agent is blocked on an interactive question (Claude's
  // AskUserQuestion widget); cleared when it resolves. Drives the native
  // question card on the phone. Distinct from pendingApproval: the answer is a
  // choice among options, not an allow/deny.
  pendingQuestion?: PendingQuestion;
  pendingClaudeInteraction?: PendingClaudeInteraction;
  // Composer messages held server-side until the session can accept input.
  queuedCount?: number;
  // Durable logical-worker/runtime identity. PTY sessions are replaceable
  // generations; this snapshot survives reconnects and is separate from the
  // task's semantic state.
  runtime?: RuntimeSnapshot;
};

export type PendingApproval = {
  id: string;
  summary: string;
  command?: string;
  at: string;
  remoteResolutionUnavailable?: boolean;
  // Exact choices for a terminal-owned prompt. Older hook approvals omit this
  // and retain the generic Allow / Deny controls.
  decisions?: ApprovalDecision[];
  context?: {
    app?: string;
    tool?: string;
  };
  source?: "hook" | "screen";
  // Set after Perch delivers the selected PTY response. The prompt remains
  // pending until the rendered-screen resolution barrier confirms it closed.
  submittedDecision?: string;
  // Durable Claude PermissionRequest metadata. Absent for Codex and degraded
  // PTY-detected prompts. Chat text is only a notification; this versioned
  // request id and state are the remote decision authority.
  requestVersion?: 1;
  state?: "pending" | "decided" | "decision_sent" | "continued" | "denied" | "expired" | "canceled" | "local_fallback";
  decisionPolicy?: "boss_only";
  expiresAt?: string;
  claudeSessionId?: string;
  runtimeGeneration?: number;
  taskId?: string;
  workerSessionId?: string;
  toolInputHash?: string;
  cwd?: string;
  interactionKind?: "permission_request" | "exit_plan_mode" | "pty_manual_gate";
};

export type ApprovalDecision = {
  id: string;
  label: string;
  destructive?: boolean;
  persistence?: "turn" | "session" | "always";
};

export type ServerRequestFamily =
  | "command_execution"
  | "file_change"
  | "permissions"
  | "mcp_elicitation"
  | "request_user_input";

export type ServerRequestDecision = {
  // Stable client token. The server maps it to the family-specific wire result.
  id: string;
  label: string;
  destructive?: boolean;
  persistence?: "turn" | "session" | "always";
};

export type PendingServerRequest = {
  // Exact JSON-RPC request identity. RequestId is string | number in Codex
  // 0.144.1; preserving the primitive avoids lossy string coercion.
  requestId: string | number;
  threadId: string;
  turnId?: string | null;
  itemId?: string;
  callId?: string;
  family: ServerRequestFamily;
  summary: string;
  content: Record<string, unknown>;
  decisions: ServerRequestDecision[];
  persistence?: {
    source: "schema" | "advertised";
    session?: boolean;
    always?: boolean;
    metadata?: Record<string, unknown>;
  };
  at: string;
};

export type QuestionOption = {
  label: string;
  description?: string;
};

export type QuestionItem = {
  // Short tab label shown as a chip in the TUI (e.g. "Git strategy").
  header?: string;
  question: string;
  // When true the user may pick several options; otherwise exactly one.
  multiSelect?: boolean;
  options: QuestionOption[];
};

// An open interactive question recovered from a hook's tool_input. The phone
// renders the questions/options and posts chosen indices back; the server
// translates them into the widget's own keystrokes.
export type PendingQuestion = {
  id: string;
  questions: QuestionItem[];
  at: string;
  requestVersion?: 1;
  state?: "waiting" | "answer_sent" | "continued" | "expired" | "local_fallback" | "simultaneous_fallback";
  answerPolicy?: "boss_only";
  remoteResolutionUnavailable?: boolean;
  submittedAnswers?: Record<string, string>;
  expiresAt?: string;
  claudeSessionId?: string;
  toolUseId?: string;
  runtimeGeneration?: number;
  taskId?: string;
  workerSessionId?: string;
  questionsHash?: string;
  cwd?: string;
};

export type PendingClaudeInteraction = {
  id: string;
  requestVersion: 1;
  kind: "elicitation" | "elicitation_result" | "permission_denied" | "pty_manual_gate";
  state: "waiting" | "response_sent" | "confirmed" | "expired" | "local_fallback" | "observed";
  summary: string;
  at: string;
  providerRequestId: string;
  mode?: "form" | "url";
  message?: string;
  url?: string;
  requestedSchema?: Record<string, unknown>;
  proposedAction?: "accept" | "decline" | "cancel";
  proposedContent?: Record<string, unknown>;
  responseAction?: "accept" | "decline" | "cancel";
  allowedActions: Array<"accept" | "decline" | "cancel">;
  remoteResolutionUnavailable?: boolean;
  runtimeGeneration?: number;
  taskId?: string;
  failureReason?: string;
};

export type DesktopContext = {
  sessionId?: string;
  workspaceId?: string;
  paneId?: string;
  surfaceId?: string;
  terminal?: string;
  cols?: number;
  rows?: number;
};

export type TopologySurface = {
  id: string;
  title: string;
  kind: SurfaceKind;
  active: boolean;
  url?: string;
  command?: string;
  sessionId?: string;
};

export type TopologyPane = {
  id: string;
  title: string;
  active: boolean;
  surfaces: TopologySurface[];
};

export type TopologyWorkspace = {
  id: string;
  title: string;
  active: boolean;
  panes: TopologyPane[];
};

export type TopologyWindow = {
  id: string;
  title: string;
  active: boolean;
  workspaces: TopologyWorkspace[];
};

export type TopologyResponse = {
  windows: TopologyWindow[];
  generatedAt: string;
};

export type AgentEvent =
  | {
      type: "message";
      sessionId: string;
      role: "user" | "agent" | "system";
      text: string;
      at: string;
    }
  | {
      // Live terminal delta. `raw` carries coalesced PTY bytes; `text` is a
      // rendered fallback used by /logs.
      // `seq` is a per-session monotonic counter so clients can detect gaps
      // and request a fresh snapshot.
      type: "terminal_output";
      sessionId: string;
      text?: string;
      raw?: string;
      seq?: number;
      at: string;
    }
  | {
      // Structured timeline entry recovered from the agent's session file.
      type: "timeline_item";
      sessionId: string;
      item: TimelineItem;
      at: string;
    }
  | {
      // Live, incremental assistant text for an in-flight turn. Codex emits its
      // response as `item/agentMessage/delta` app-server notifications that the
      // desktop TUI renders live but that never reach the rollout JSONL (only
      // the finished message does), so the phone would otherwise see nothing
      // until the turn ends. This ephemeral preview carries the FULL accumulated
      // text so far for `itemId` (idempotent replace, gap-proof); it is NOT
      // persisted - the finished message still arrives as a `timeline_item` from
      // the transcript tailer, which supersedes the preview. `done` marks the
      // final frame for the message. Append-only: older clients ignore it.
      type: "assistant_stream";
      sessionId: string;
      itemId: string;
      text: string;
      done?: boolean;
      at: string;
    }
  | {
      // Full serialized screen (ANSI), sent when the detail tier opens and
      // whenever a client needs to resync. Deltas after `seq` apply on top.
      type: "terminal_snapshot";
      sessionId: string;
      data: string;
      cols: number;
      rows: number;
      seq: number;
      at: string;
    }
  | {
      type: "approval_request";
      sessionId: string;
      id: string;
      summary: string;
      command?: string;
      at: string;
    }
  | {
      type: "status";
      sessionId: string;
      status: AgentSessionStatus;
      at: string;
    }
  | {
      // A registered chart appeared, its HTML file changed on disk, its owning
      // task closed (archived), or it was approved (finalized); clients showing
      // it refetch GET /charts/:id. Routed to the owning session's detail
      // subscribers, and additionally to the parent (mate) session's
      // subscribers for crew charts. Append-only: older clients ignore it and
      // ignore reasons they do not know.
      type: "chart";
      sessionId: string;
      chartId: string;
      name: string;
      reason: "registered" | "updated" | "archived" | "finalized";
      // Task linkage for crew charts, so a supervising surface can tag the
      // card with the originating task.
      taskId?: string;
      taskTitle?: string;
      at: string;
    };

export type HealthResponse = {
  ok: true;
  adapter: string;
  version: string;
  at: string;
};

export type SessionsResponse = {
  sessions: AgentSession[];
};

export type LogsResponse = {
  events: AgentEvent[];
  // false when the requested surface is not a terminal (e.g. a browser surface).
  // Older clients can ignore these fields and just read `events`.
  terminal?: boolean;
  note?: string;
};

// Result of an adapter output-capture read. `terminal` is false for surfaces
// that cannot produce terminal output (e.g. browser surfaces), in which case
// `events` is empty and `note` explains why - instead of failing the capture.
export type RecentEventsResult = {
  events: AgentEvent[];
  terminal: boolean;
  note?: string;
};

export type InputRequest = {
  text: string;
  // Optional per-turn model/effort override, folded into the submit so the
  // model chip is a single round trip on the app-server path (Codex
  // `turn/start` takes `model`/`effort` "for this turn and subsequent turns").
  // Append-only: PTY-driven agents ignore these; only the Codex app-server
  // driver acts on them. An empty/blank `model` MUST be treated as omitted
  // (Codex errors on model=""). Gated by the client's model-chip capability.
  model?: string;
  effort?: CodexReasoningEffort;
};

// Codex reasoning-effort levels (app-server `turn/start` `effort`). Append-only;
// unknown values degrade to the CLI's default. Distinct from Claude, which has
// no effort control - clients only surface this for Codex sessions.
export type CodexReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type StartAgentRequest = {
  command: string;
  args?: string[];
  cwd?: string;
  title?: string;
  agent?: AgentKind;
  desktop?: DesktopContext;
  // Submitted to the agent once its session reports ready (SessionStart
  // hook), so prompts sent at spawn time are never dropped mid-boot.
  initialPrompt?: string;
  // Launch-time model for the spawned CLI, translated to the agent's model
  // flag (claude `--model <alias>`, codex `-m <id>`). Omitted/empty uses the
  // CLI's own default. This is a spawn argument only - it sets the model a new
  // session starts on and does not switch a running session's model.
  model?: string;
  // Launch-time reasoning effort for the spawned CLI (Codex only, translated to
  // `-c model_reasoning_effort=<level>`). Omitted lets the CLI's own config
  // default apply (~/.codex/config.toml `model_reasoning_effort`). Claude has no
  // effort control and ignores this.
  effort?: CodexReasoningEffort;
  // Spawn in a fresh pooled worktree of `cwd` instead of `cwd` itself; the
  // lease is bound to the session and released when it ends.
  worktree?: boolean;
  // Free-form grouping labels (crew parentage, task linkage).
  labels?: Record<string, string>;
  // Server-internal: a pre-minted perch session id the adapter must adopt
  // instead of generating one. The Codex `--remote` path uses it so the daemon
  // (spawned before the session exists, and which runs the agent's tool shells)
  // can carry this session's hook wiring. Ignored unless well-formed.
  sessionId?: string;
};

export type StartAgentResponse = {
  session: AgentSession;
};

// --- Tasks (M1): the bookkeeping ledger over sessions ---------------------
// A task is "what work is happening"; a session is "what a worker is doing".
// The server owns tasks as dumb CRUD + a state machine; all policy (dispatch
// composition, absorb/escalate, teardown gate) stays in the caller/mate.

export type TaskKind = "ship" | "scout";
export type TaskMode = "direct-PR" | "no-mistakes" | "local-only";

// queued -> working -> needs_you|blocked -> completion_requested -> done -> landed -> closed
// (failed is terminal from any non-closed state).
export type TaskState =
  | "queued"
  | "working"
  | "needs_you"
  | "blocked"
  | "completion_requested"
  | "done"
  | "landed"
  | "closed"
  | "failed";

export type TaskPr = {
  url: string;
  // GitHub owner/repo for the PR base repo and head repo. These are recorded
  // after the server verifies the PR belongs to the task project and branch.
  repo?: string;
  headRepo?: string;
  head?: string;
  // The PR head commit the done gate verified against the worker's checkout
  // HEAD. Recorded when the gate proved the PR carries the worker's delivered
  // commits (which is how a reused branch, whose name differs from the
  // auto-assigned task branch, is admitted).
  headOid?: string;
  checks?: "pending" | "passing" | "failing";
  checkDetails?: TaskPrCheck[];
  mergeReady?: boolean;
  isDraft?: boolean;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  merged?: boolean;
};

export type TaskPrCheck = {
  name: string;
  state: "pending" | "passing" | "failing" | "unknown";
};

export type RuntimeState = "starting" | "live" | "recoverable" | "recovering" | "ended";

export type RuntimeSnapshot = {
  id: string;
  workerId: string;
  generation: number;
  state: RuntimeState;
  provider?: string;
  providerSessionId?: string;
  agent: AgentKind;
  model?: string;
  workerName?: string;
  parentSessionId?: string;
  worktreeId?: string;
  worktreePath?: string;
  leaseId?: string;
  ptySessionId?: string;
  processId?: number;
  processStartedAt?: string;
  ownerInstanceId?: string;
  recoveryAvailable: boolean;
  recoveryUnavailableReason?: "provider_session_unknown" | "runtime_not_recoverable";
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
};

export type Task = {
  id: string;
  title: string;
  // Short temporary identity for the worker, distinct from the work title.
  // Optional so existing ledger records remain readable without migration.
  workerName?: string;
  project: string; // repo root path
  kind: TaskKind;
  mode: TaskMode;
  state: TaskState;
  // Original boss/mate brief before the server appends its worker reporting
  // contract. Optional so historical projections remain readable.
  prompt?: string;
  sessionId?: string; // the worker session
  parentSessionId?: string; // durable crew parentage for notification routing
  worktreeId?: string; // the pool lease
  branch?: string;
  pr?: TaskPr;
  // The finalized plan this task builds from, stamped at dispatch. An opaque
  // key (the plan doc's repo-relative path, e.g. "docs/plans/2026-07-08-foo.md",
  // or the finalizing chart's id) so a plan edit can look up its affected
  // in-flight tasks deterministically instead of guessing. Absent on
  // unstamped tasks.
  planId?: string;
  // Derived from the authoritative runtimes table. It is returned by APIs but
  // is not part of the persisted task projection.
  runtime?: RuntimeSnapshot;
  createdAt: string;
  updatedAt: string;
};

// Worker verbs (the five, plus poller/system-sourced reconciliations).
// "stalled" and "chart_ready" are server-emitted only. They move no task
// state and exist to wake the orchestrator at the moment attention is needed.
export type TaskEventKind =
  | "created"
  | "working"
  | "needs_decision"
  | "blocked"
  | "completion_requested"
  | "completion_accepted"
  | "completion_rejected"
  | "turn_started"
  | "turn_completed"
  | "done"
  | "failed"
  | "checks_green"
  | "merge_ready"
  | "merged"
  | "landed"
  | "closed"
  | "stalled"
  | "chart_ready"
  | "runtime_interrupted"
  | "note";

export type TaskEventSource = "worker" | "hook" | "poller" | "system";

export type TaskEvent = {
  seq: number;
  at: string;
  kind: TaskEventKind;
  message?: string;
  source: TaskEventSource;
  data?: Record<string, unknown>;
};

export type CreateTaskRequest = {
  title: string;
  project: string; // repo root
  kind?: TaskKind;
  mode?: TaskMode;
  prompt?: string; // kickoff brief body
  agent?: AgentKind;
  model?: string; // launch-time model for the dispatched worker session
  effort?: CodexReasoningEffort; // launch-time reasoning effort (Codex only)
  // Compose the M0 pieces server-side: acquire a worktree, start the worker
  // session (labels.task set, brief as initialPrompt), and link them.
  dispatch?: boolean;
  // Optional caller key for retrying the same durable dispatch request.
  // Reusing it returns the original task and never launches a second worker.
  idempotencyKey?: string;
  parent?: string; // crew parentage (labels.parent)
  // The finalized plan this task builds from.
  // Stamped onto the Task so plan edits find affected work by lookup, not guess.
  // When `planEdit` is set and `planId` is omitted, the server defaults it to
  // the edited plan's path.
  planId?: string;
  // Edit-a-finalized-plan-as-a-commit: the boss's revised plan markdown, landed
  // as a git commit by the dispatched worker (never a server fs write - the
  // HARD INVARIANT is the server never touches a project repo). The server
  // stages the content centrally under the task dir and the dispatch brief
  // tells the worker to commit it to `path` as the first commit of its branch.
  planEdit?: {
    // Repo-relative destination, must live under docs/plans/ and end in .md.
    path: string;
    // The full new markdown content of the plan doc.
    content: string;
  };
};

export type TaskEventRequest = {
  kind: TaskEventKind; // the worker verb
  message?: string;
  pr?: string; // convenience: a PR url attached to a done verb
  // Structured payload persisted onto the event verbatim (server-bounded in
  // size). data.noMistakes carries a NoMistakesGate when a worker's ask-user
  // gate parks the no-mistakes pipeline. Append-only wire change.
  data?: Record<string, unknown>;
};

export type CompletionDecisionRequest = {
  action: "accept" | "reject";
  // The immutable completion_requested event being decided. This prevents a
  // late answer from accepting a newer worker claim after a reject/retry.
  requestSeq: number;
  // Required for reject and persisted verbatim as the worker's next brief.
  feedback?: string;
  // Caller-generated retry key. Reusing it with the same decision is a no-op;
  // reusing it for a different decision is rejected.
  idempotencyKey: string;
};

export type CompletionDecisionResponse = {
  ok: true;
  duplicate?: boolean;
  feedbackDelivered?: boolean;
  queued?: boolean;
  task: Task;
};

// The documented shape of TaskEvent.data.noMistakes: a worker driving the
// no-mistakes pipeline hits an ask-user gate and POSTs needs_decision with
// the gate's findings table copied verbatim - perch never parses pipeline
// output itself, so upstream vocabulary (severity, action) passes through
// as-is. Append-only: add optional fields, never remove or narrow.
export type NoMistakesFinding = {
  id: string;
  severity: string; // upstream's word, verbatim (error, warning, ...)
  file?: string;
  line?: number;
  action?: string; // what the gate proposes (fix, ask-user, ...)
  description: string; // full finding text, verbatim, never paraphrased
};

export type NoMistakesGate = {
  step: string; // the pipeline step that parked the run (review, test, ...)
  runId?: string;
  findings: NoMistakesFinding[];
};

// Rides the POST /projects response when the request set mode: "no-mistakes"
// (O2: the mode set is the consent, so init runs immediately). Append-only.
export type NoMistakesInitResult = {
  ran: boolean; // init executed (binary present)
  initialized: boolean; // gate remote present after the attempt
  ready: boolean; // binary present AND initialized
  // What is missing or what upstream printed, verbatim, with the fix command.
  warning?: string;
  output?: string; // upstream init output on success
};

// 422 body when POST /tasks refuses to dispatch a no-mistakes task into a
// gate that is not ready: each missing piece names the command that fixes it.
export type NoMistakesDispatchRefusal = {
  error: string;
  noMistakes: {
    binaryFound: boolean;
    initialized: boolean;
    missing: string[];
  };
};

// Server-verified authorization contract consumed by the no-mistakes launch
// boundary. The worker supplies its non-secret task scope; the server derives
// mode and runtime generation from the durable ledger behind its per-session
// hook credential.
export type NoMistakesAuthorizationRequest = {
  protocolVersion: "1";
  requestId: string;
  operation: "run" | "gate-push" | "agent-launch";
  taskId: string;
  runtimeGeneration: number;
  sessionId: string;
  projectPath: string;
  repository: string;
  worktreePath: string;
  branch: string;
  durableMode: TaskMode;
};

export type NoMistakesAuthorizationResponse = {
  protocolVersion: "1";
  requestId: string;
  operation: "run" | "gate-push" | "agent-launch";
  taskId: string;
  runtimeGeneration: number;
  sessionId: string;
  projectPath: string;
  repository: string;
  worktreePath: string;
  branch: string;
  durableMode: TaskMode;
  allowed: boolean;
  reason: string;
};

// The boss's answer to a parked no-mistakes gate (POST /tasks/:id/decision,
// device/server token; also a relay RPC). One action per gate, mirroring
// upstream's `axi respond` verbs; findingIds and instructions ride only with
// "fix" (the other actions take neither). The server translates the answer
// into the matching `no-mistakes axi respond ...` line and injects it into
// the worker session's composer through the queue-gated path - perch itself
// never drives axi.
export type TaskDecisionAction = "approve" | "fix" | "skip";

export type TaskDecisionRequest = {
  action: TaskDecisionAction;
  findingIds?: string[];
  instructions?: string;
};

export type TaskDecisionResponse = { ok: true; queued: boolean; task: Task };

export type TasksResponse = { tasks: Task[] };
export type TaskDetailResponse = { task: Task; events: TaskEvent[] };

// --- Charts: artifact review built into the perch server -------------------
// A chart is an HTML file an agent draws up for boss review, bound at
// registration to its owning session (and task, when the session has one).
// Key = hash of the canonical file path. All shapes are append-only.

// A chart's pipeline stage: a brainstorm draft, or finalized (approved) into
// an implementation plan. Two states only; orthogonal to the task-lifecycle
// `archived` flag below.
export type ChartStatus = "draft" | "finalized";

export type Chart = {
  id: string;
  // Display name: the file's basename without .html.
  name: string;
  // Canonical absolute path of the chart HTML on this Mac.
  file: string;
  // Pipeline stage: "draft" (brainstorm) or "finalized" (approved). Absent on
  // charts registered before the two-state model shipped; read as "draft".
  status?: ChartStatus;
  // When the chart was marked finalized (approved).
  finalizedAt?: string;
  // The session feedback routes to (composer injection into its PTY).
  sessionId: string;
  // Task linkage when the owning session was a dispatched worker.
  taskId?: string;
  // Owning project declared at registration (the mate path): the resolved
  // absolute rootPath of a tracked project this chart is about. Lets a chart
  // group under its project even without task linkage. Absent on charts that
  // never declared one; grouping then falls back to task linkage.
  projectRoot?: string;
  // The owning task's title at registration, so surfaces can tag a crew
  // chart without a task lookup.
  taskTitle?: string;
  // Crew parentage at registration (the owning session's labels.parent,
  // normally the mate): crew charts also surface in this session's chat.
  parentSessionId?: string;
  // When the durable copy under ~/.perch/charts/<id>/ was last written.
  // The server serves from that snapshot, so a chart outlives its worktree.
  snapshotAt?: string;
  // Set when the owning task closed: still servable and viewable, but no
  // longer part of "what is latest".
  archived?: boolean;
  archivedAt?: string;
  registeredAt: string;
  updatedAt: string;
};

export type RegisterChartRequest = {
  // Path to the chart HTML file. Hook-token callers send only this; the
  // server resolves the owning session from the token. Server-token callers
  // must name the owning session explicitly (the mate registering charts).
  file: string;
  sessionId?: string;
  // The project this chart is about (the mate path, where there is no task to
  // infer it from). Accepts a tracked project's absolute rootPath OR its name;
  // the server resolves it to a rootPath and persists it as `chart.projectRoot`.
  // Optional: omitting it preserves task-linkage grouping. An unresolvable
  // value is rejected (400), never silently dropped.
  project?: string;
};

export type RegisterChartResponse = {
  chart: Chart;
  // Server-relative URL the chart is served at (SDK injected).
  url: string;
};

export type ChartsResponse = { charts: Chart[] };

// A committed implementation plan discovered by scanning a project's
// docs/plans/*.md. Every committed plan doc is a finalized plan, regardless
// of its own `Status:` header (which
// tracks implementation status, a different axis).
export type ChartPlanDoc = {
  // Absolute path of the plan markdown on this Mac.
  path: string;
  // Repo-relative path, e.g. "docs/plans/2026-07-08-foo.md".
  relativePath: string;
  // First `# ` heading, or the filename when the doc has none.
  title: string;
  // YYYY-MM-DD parsed from the filename prefix, when present.
  date?: string;
};

// One tracked project's slice of the hub: its registered charts (with
// Draft/Finalized status) and its committed implementation plans.
export type ChartsHubProject = {
  rootPath: string;
  name: string;
  charts: Chart[];
  plans: ChartPlanDoc[];
};

// The unified hub listing both front-ends consume (the mobile Charts sheet and
// the desktop /charts gallery): everything grouped by project, plus charts that
// resolve to no tracked project (drawn outside a task).
export type ChartsHubResponse = {
  projects: ChartsHubProject[];
  ungrouped: Chart[];
};

// The result of approving a chart (POST /charts/:id/finalize): the chart in its
// finalized state.
export type FinalizeChartResponse = { chart: Chart };

// A committed plan doc rendered in chart styling (GET /charts/plan?path=...):
// the raw HTTP route returns this HTML directly as text/html; the relay RPC
// wraps it as JSON so relay clients (which cannot fetch raw HTML) load it into
// a WKWebView. Read-only; the server confines reads to tracked projects'
// docs/plans.
export type PlanDocResponse = { html: string };

// One annotation from the review surface, in the injected SDK's shape:
// element (selector + quoted text), text-range, or Mermaid node target.
export type ChartAnnotation = {
  prompt?: string;
  selector?: string;
  tag?: string;
  text?: string;
  target?: Record<string, unknown>;
};

export type ChartFeedbackRequest = {
  // Free-form message alongside (or instead of) the annotations.
  message?: string;
  annotations?: ChartAnnotation[];
};

export type ChartFeedbackResponse = {
  ok: true;
  // True when the block was queued server-side (permission prompt open).
  queued: boolean;
};

// A layout-audit finding from the injected SDK (machine feedback).
export type ChartLayoutWarning = {
  selector: string;
  kind: string;
  overflowPx: number;
  viewportWidth: number;
  severity: "error" | "warning";
};

export type ChartLayoutWarningsRequest = {
  layout_warnings?: ChartLayoutWarning[];
  layoutWarnings?: ChartLayoutWarning[];
};

// JSON-wrapped chart document for transports that cannot fetch raw HTML
// (the relay RPC surface, where every response rides a JSON rpc_response).
// `html` already has the annotation SDK injected, same as GET /charts/:id.
export type ChartHtmlResponse = {
  chart: Chart;
  html: string;
};

// A chart sibling asset (or chart.css) as base64, for the same JSON-only
// transports. Directory confinement matches the raw asset route.
export type ChartAssetResponse = {
  base64: string;
  contentType: string;
};

export type CommandResponse = {
  ok: true;
};

export type InterruptResponse = {
  ok: true;
};

// Normalized, agent-agnostic event the fleet monitor consumes. Adapters
// translate their backend's native event stream into these so the monitor and
// HTTP layer carry no backend-specific knowledge.
//   status   - an agent-status signal for a workspace (and optionally a session)
//   activity - a "something changed" signal for a workspace/session
//   topology - the set of windows/workspaces/panes/surfaces changed; re-snapshot
//   gap      - the event stream fell behind; do a full re-snapshot
export type FleetEventKind = "status" | "activity" | "topology" | "gap";

export type FleetEvent = {
  kind: FleetEventKind;
  at: string;
  workspaceId?: string;
  sessionId?: string;
  status?: AgentSessionStatus;
  agent?: AgentKind;
  // Native backend event name, kept for diagnostics only.
  name?: string;
};

export type WebSocketRpcRequest = {
  // Request/response control command carried on the same authenticated,
  // E2E WebSocket as the fleet stream. Relay clients use this instead of
  // treating the relay as an HTTP API origin.
  type: "rpc";
  id: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  bodyBase64?: string;
  contentType?: string;
};

export type WebSocketRpcResponse =
  | {
      type: "rpc_response";
      id: string;
      status: number;
      ok: true;
      body?: unknown;
    }
  | {
      type: "rpc_response";
      id: string;
      status: number;
      ok: false;
      error: string;
    };

// Inbound messages a client sends to open/close the focused-detail tier for one
// pane. The fleet overview is always on and needs no subscription; subscribing
// is purely additive and never narrows fleet coverage.
export type WebSocketClientEvent =
  | {
      type: "subscribe";
      sessionId: string;
    }
  | {
      type: "unsubscribe";
      sessionId: string;
    }
  | {
      type: "start_agent";
      request: StartAgentRequest;
    }
  | {
      // Raw terminal input bytes for an attached client (keystrokes). Lower
      // latency than the HTTP input endpoint; used by CLI attach and the app.
      type: "input";
      sessionId: string;
      data: string;
    }
  | {
      // PTY resize. Last-interacting-client-wins; passive viewers (the phone
      // mirror) must never send this.
      type: "resize";
      sessionId: string;
      cols: number;
      rows: number;
    }
  | WebSocketRpcRequest;

export type WebSocketServerEvent =
  | {
      type: "hello";
      at: string;
    }
  | {
      // Fleet overview tier: a lightweight snapshot of every session, pushed on
      // connect and whenever state changes. Always delivered to every client.
      type: "fleet";
      sessions: AgentSession[];
      at: string;
    }
  | {
      // Detail tier (and system notices). Per-session events are delivered only
      // to clients subscribed to event.sessionId; sessionId "system" broadcasts.
      type: "event";
      event: AgentEvent;
    }
  | WebSocketRpcResponse;

// End-to-end encryption envelope (Phase 0 of the WAN relay). The phone and the
// server run a NaCl box channel over the raw WebSocket; once a future relay is
// in the path it forwards these frames as opaque blobs it cannot read. Perch's
// a leading version byte supports explicit append-only protocol evolution
// byte, honoring the append-only wire guardrail: bump it only on a breaking
// frame change, and a decoder that meets an unknown version closes fatally so
// the peer reconnects and renegotiates rather than mis-parsing.
export const E2EE_VERSION = 0x01;

// A base64-encoded encrypted perch frame. Before base64 the bytes are laid out
// as [1B version][24B nonce][ciphertext incl. 16B Poly1305 tag]. It is opaque
// to any relay: self-describing (the version byte) and independent of transport
// or relay internals.
export type EncryptedFrame = string;

// Plaintext handshake frames (public keys only) exchanged before the channel
// opens; these are the only non-ciphertext frames a relay ever sees. The phone
// sends `e2ee_hello` with a fresh per-connection ephemeral public key; the
// server replies `e2ee_ready` once it has derived the shared key.
export type E2eeHandshake =
  | { type: "e2ee_hello"; key: string } // key = base64 phone ephemeral public key
  | { type: "e2ee_ready" };

// The first ENCRYPTED frame the phone sends after the handshake. It carries the
// per-device revocable token end-to-end (inside the ciphertext, never on the
// relay), so the server authorizes the channel with DeviceRegistry.verify at
// the E2E boundary instead of at the WebSocket upgrade.
export type E2eeAuth = { type: "e2ee_auth"; token: string };

// Pairing offer v1: encoded as base64url JSON in perch://pair#offer=... QR
// codes. `pk` now carries the server's long-term NaCl box public key (base64,
// 32 bytes) and is the client capability marker that gates the encrypted
// transport: a client that reads `pk` speaks the E2E channel, one that does not
// still connects with the legacy `?token=` path. Adding it stayed append-only,
// so v1 parsers that ignore `pk` keep working.
export type PairingOffer = {
  v: 1;
  serverId: string;
  name: string;
  endpoints: string[];
  token: string;
  pk?: string;
};

export type DeviceInfo = {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt?: string;
};

export type DevicesResponse = {
  devices: DeviceInfo[];
};

export type CreateDeviceResponse = {
  device: DeviceInfo;
  offer: PairingOffer;
  url: string;
};

// One normalized entry in a session's structured timeline, recovered by
// tailing the agent's own session file (e.g. Claude's transcript JSONL).
// seq is per-session and monotonic; clients page with ?after=seq.
export type TimelineItemKind = "user" | "assistant" | "tool_call" | "tool_result" | "system";

// Provenance of a user turn: who submitted it. "human" is the boss (phone
// composer or desktop keystrokes); "agent" is a non-human origin - the mate
// steering a worker or a task dispatch kickoff. Absent = unknown/legacy, which
// clients MUST render as a human turn (the safe default). Only ever set on
// user items. Append-only per the wire-protocol guardrail: a future, finer
// value (e.g. "mate") can be added without breaking older clients, which
// degrade an unrecognized value to the human treatment.
export type TimelineItemSource = "human" | "agent";

export type TimelineItem = {
  seq: number;
  id: string;
  sessionId: string;
  kind: TimelineItemKind;
  text?: string;
  tool?: {
    name: string;
    input?: string;
  };
  at: string;
  source?: TimelineItemSource;
};

export type TimelineResponse = {
  items: TimelineItem[];
  lastSeq: number;
};


export type ApproveRequest = {
  // Generic approvals use allow/deny. Screen-owned prompts advertise their
  // exact decision ids on PendingApproval and reject every other value.
  decision: string;
  id?: string;
  requestVersion?: 1;
  runtimeGeneration?: number | null;
};

export type ServerRequestResponse = {
  requestId: string | number;
  decision?: string;
  // Family-specific structured content. Used by MCP form elicitation,
  // permissions grants, and request_user_input answers.
  content?: Record<string, unknown>;
};

// Answer an open AskUserQuestion prompt from a client. `selections` is
// per-question: each entry lists the chosen option indices (one for
// single-select, zero or more for multiSelect). `id` pins the answer to the
// exact prompt so a stale answer is rejected if it was already resolved.
export type AnswerRequest = {
  id?: string;
  selections: number[][];
  // Free-form "Other" text keyed by the exact question text. Structured
  // Claude questions return these values through updatedInput.answers.
  customAnswers?: Record<string, string>;
  requestVersion?: 1;
  runtimeGeneration?: number | null;
};

export type SubmitResponse = {
  ok: true;
  // True when the message was queued server-side because the session cannot
  // accept input right now (e.g. a permission prompt is open).
  queued: boolean;
};

// Response for POST /sessions/:id/attachments: the absolute path the uploaded
// image was stored at (referenced in the injected prompt) and its stored name.
export type AttachmentResponse = {
  path: string;
  filename: string;
};

// POST /sessions/:id/model: switch the running agent to `model` for the next
// turn. The server picks the per-agent strategy: Claude submits `/model
// <alias>` keystrokes; Codex on the app-server driver sets `model` on the next
// `turn/start` over the protocol (no keystrokes, no stray-prompt risk).
// Append-only: `effort` is optional and Codex-only; older servers ignore it.
export type ModelSwitchRequest = {
  model: string;
  effort?: CodexReasoningEffort;
};

export type ModelSwitchResponse = {
  ok: boolean;
};

// Local usage and credit snapshot for the agent providers on the Mac, with no
// separate login: Claude from its OAuth usage endpoint
// and Codex from the ChatGPT backend usage endpoint, both using the token the
// CLI already stored. Append-only: clients tolerate missing fields, unknown
// providers, and unknown window kinds.
export type UsageWindowKind = "session" | "week";

export type UsageWindow = {
  kind: UsageWindowKind;
  // 0-100: how much of this rolling window is consumed.
  percentUsed: number;
  // ISO-8601 instant the window rolls over (empty string if the source omitted it).
  resetsAt: string;
  windowMinutes?: number;
};

// Overage/credit balance, in whole dollars. All optional: a provider may expose
// only some of these, and subscription plans often expose none.
export type UsageCredits = {
  usedDollars?: number;
  limitDollars?: number;
  remainingDollars?: number;
};

export type ProviderUsage = {
  // "claude" | "codex" today; append-only, so treat unknown values leniently.
  provider: AgentKind;
  // false when the source is unavailable (not logged in, expired, no data);
  // `note` explains the gap rather than the panel faking numbers.
  available: boolean;
  note?: string;
  // Plan label as the provider reports it (e.g. "max", "pro").
  plan?: string;
  windows: UsageWindow[];
  credits?: UsageCredits;
  // Which local source produced this, for transparency in the UI/writeup
  // (e.g. "oauth-usage-api", "backend-usage-api", "cli-usage", "rollout-jsonl").
  source?: string;
  // True when a live refresh just failed and this is the last successful
  // snapshot served instead of dropping to unavailable. The panel keeps its
  // meters and honestly labels them stale.
  stale?: boolean;
  // ISO-8601 instant the data in `windows`/`credits` was actually captured.
  // For a fresh read this is ~now; for a stale serve it is the age of the
  // retained snapshot, so the UI can say "as of 3m ago".
  asOf?: string;
};

export type UsageResponse = {
  at: string;
  providers: ProviderUsage[];
};

// Launch-time model catalog for a provider, served by the perch server (which
// runs on the same Mac as the CLIs). It exists so the New Agent picker shows
// versioned model names + a grounded descriptor instead of a bare CLI alias,
// and so "Default" resolves to the model the CLI is actually configured to use.
// Append-only: clients tolerate missing fields, unknown providers, and extra
// options they don't recognize.
export type ModelCatalogEntry = {
  // Spawn value handed to the CLI's model flag (claude `--model <id>`,
  // codex `-m <id>`). Kept for older clients; new clients should prefer
  // `runtimeId ?? id` so display/enrichment ids can remain separate.
  id: string;
  // Versioned, human name for the model the id currently resolves to
  // (e.g. "Opus 4.8", "GPT-5.5").
  label: string;
  // One-line secondary descriptor for display. For Claude this is the context
  // window (e.g. "1M context"); for Codex it is the provider's own model
  // description (the codex app-server `model/list` RPC does not expose a
  // context window). Empty when nothing is known.
  detail?: string;
  // Runtime-verified model id for local launch/switch. This is the only value
  // Perch should feed into `claude --model`, `codex -m`, Claude `/model`, or
  // Codex app-server `turn/start`.
  runtimeId?: string;
  // Provider/API catalog identifiers used for enrichment and future routing.
  // These are not local runtime ids unless a runtime source maps them.
  gatewayId?: string;
  apiId?: string;
  nativeProviderId?: string;
  runtimeSource?: string;
  source?: string[];
  status?: "available" | "fallback" | "stale" | "deprecated" | "hidden" | "unknown";
  stale?: boolean;
  hidden?: boolean;
  deprecated?: boolean;
  supportedReasoningEfforts?: CodexReasoningEffort[];
  defaultReasoningEffort?: CodexReasoningEffort;
  serviceTiers?: string[];
  isDefault?: boolean;
};

export type ProviderModelCatalog = {
  // "claude" | "codex" today; append-only, so treat unknown values leniently.
  provider: AgentKind;
  label?: string;
  options: ModelCatalogEntry[];
  // The model the CLI uses when no model flag is passed, resolved from local
  // config (claude `~/.claude/settings.json` `model`, codex
  // `~/.codex/config.toml` `model`). Absent when it can't be resolved; clients
  // then fall back to a generic "Default" label.
  defaultId?: string;
  defaultLabel?: string;
  defaultDetail?: string;
  // Where the default came from, for transparency in the UI/writeup
  // (e.g. "claude-settings", "codex-config", "catalog-default").
  defaultSource?: string;
  defaultReasoningEffort?: CodexReasoningEffort;
  // Perch-owned launch policy. These values deliberately stay independent of
  // `defaultId`, which describes the provider CLI's current local default.
  // A role default always names a concrete runtime model from this catalog.
  roleDefaults?: Partial<Record<"orchestrator" | "crew", PerchModelRoleDefault>>;
  runtimeSource?: string;
  source?: string[];
  status?: "available" | "fallback" | "stale" | "offline" | "unknown";
};

export type PerchModelRoleDefault = {
  model: string;
  effort?: CodexReasoningEffort;
};

export type ModelRegistrySourceStatus = {
  name: string;
  role?: "runtime" | "enrichment" | "fallback" | "cache";
  ok: boolean;
  status?: "ok" | "failed" | "skipped" | "fallback" | "stale";
  reason?: string;
  at?: string;
};

export type ModelRegistryCacheStatus = {
  path?: string;
  hit?: boolean;
  stale?: boolean;
  ageMs?: number;
  asOf?: string;
  reason?: string;
};

export type ModelsResponse = {
  at: string;
  generatedAt?: string;
  cache?: ModelRegistryCacheStatus;
  sources?: ModelRegistrySourceStatus[];
  providers: ProviderModelCatalog[];
};

// Environment doctor (GET /doctor): the external tools perch depends on -
// agent CLIs, gh, the no-mistakes gate - checked on the Mac the server runs
// on (the environment that actually spawns agents). The CLI renders this;
// `perch doctor --fix` (T2) installs from the same install hints.
// Append-only: clients tolerate unknown tool names and extra fields.
export type DoctorToolStatus = {
  // "claude" | "codex" | "gh" | "no-mistakes" today; append-only.
  name: string;
  required: boolean;
  found: boolean;
  // Resolved absolute path when found.
  path?: string;
  // Parsed version string (e.g. "2.1.19", "v1.31.2"); absent when the
  // binary was found but did not report one.
  version?: string;
  // Extra state beyond presence: gh auth state, no-mistakes daemon state,
  // or why the version probe failed.
  note?: string;
  // The exact command that installs this tool (shown when missing).
  installHint: string;
  // True when installHint is an official unattended installer that
  // `perch doctor --fix` may run after per-tool consent.
  installer?: boolean;
};

// One entry in the `perch doctor --fix` plan, computed server-side from the
// dependency table so the CLI stays a dumb executor and the planner is
// testable without network. kind "install" carries the exact official
// installer command --fix runs after consent; kind "manual" is report-only -
// tools whose install or sign-in needs an interactive flow --fix must never
// automate.
export type DoctorFixAction = {
  name: string;
  kind: "install" | "manual";
  // kind=install: the exact shell command --fix runs (printed verbatim,
  // including the env defaults below, before anything executes).
  command?: string;
  // kind=install: env defaults for the command - upstream's own documented
  // knobs (configuration, never patching). The CLI applies each variable only
  // when the user has not already set it, so an exported value always wins.
  env?: Record<string, string>;
  // kind=install: plain-language note shown with the action (e.g. the
  // no-mistakes telemetry opt-out and how to re-enable it).
  note?: string;
  // kind=manual: the exact next commands the user runs themselves.
  commands?: string[];
  // kind=manual: why --fix cannot automate this.
  reason?: string;
};

// Per-registered-project no-mistakes gate readiness: a repo is initialized
// when `no-mistakes init` added its `no-mistakes` git remote, and ready when
// the binary is also installed.
export type DoctorProjectGate = {
  rootPath: string;
  name: string;
  mode?: string;
  initialized: boolean;
  ready: boolean;
  note?: string;
};

export type DoctorResponse = {
  at: string;
  // True when every required tool is present.
  ok: boolean;
  tools: DoctorToolStatus[];
  noMistakes: {
    binaryFound: boolean;
    projects: DoctorProjectGate[];
  };
  // What `perch doctor --fix` would do right now; empty when there is
  // nothing to install and nothing manual outstanding.
  fix: DoctorFixAction[];
};

// Fleet-level dispatch defaults (user-configurable, `perch config`): applied
// by POST /tasks when the request omits agent/model/effort; an explicit
// per-task value always wins, and with nothing configured the built-in
// behavior (claude, CLI-default model) is unchanged. One static default -
// deliberately no routing heuristics or per-task policies.
export type DispatchDefaults = {
  agent?: AgentKind; // restricted to "claude" | "codex" on write
  model?: string; // free-form; passed verbatim to the CLI's model flag
  effort?: CodexReasoningEffort;
};

// Fleet-level mate defaults (`mate.*` via `perch config`): applied by `perch mate`
// when it spawns the mate's StartAgentRequest. `agent` picks which CLI the
// mate launches as (claude|codex) - LAUNCH-TIME ONLY, choosing a fresh
// mate's agent at start; there is no mid-conversation agent switch or
// relaunch machinery.
export type MateDefaults = {
  agent?: AgentKind; // restricted to "claude" | "codex" on write
  // A concrete runtime id, or "auto" to use the registry's Perch-owned
  // orchestrator role default. It never means the provider CLI default.
  model?: string;
  effort?: CodexReasoningEffort;
};

export type MateLaunchResolution = {
  agent: AgentKind;
  model: string;
  effort?: CodexReasoningEffort;
  modelSource: "pinned" | "auto" | "fallback";
};

export type ConfigValue = string | boolean | number | null;

export type ConfigEntry = {
  effectiveValue: ConfigValue;
  source: "environment" | "global" | "project" | "built-in" | "automatic" | "bundled";
  scope: "global" | "project" | "runtime";
  storedValue: ConfigValue;
  defaultValue: ConfigValue;
  overriddenBy: string | null;
  readOnly?: boolean;
};

// GET /config and PATCH /config both return the EFFECTIVE defaults
// (PERCH_DEFAULT_*/PERCH_MATE_* env overrides win over the persisted settings
// file).
export type ConfigResponse = {
  dispatchDefaults: DispatchDefaults;
  // Present only while the dispatch layer is unset. It shows the concrete
  // Perch policy that the next worker will receive without persisting it.
  dispatchResolved?: DispatchDefaults;
  mateDefaults: MateDefaults;
  mateResolved?: MateLaunchResolution;
  entries?: Record<string, ConfigEntry>;
};
