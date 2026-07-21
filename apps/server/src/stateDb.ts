import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Task, TaskEvent, TaskEventKind, TaskEventSource, TaskPr } from "@perch/shared";
import Database from "better-sqlite3";
import type { TaskDeliverable, TaskVerificationFacts } from "./taskPresentation.js";

const LATEST_SCHEMA_VERSION = 10;
const LEGACY_TASK_IMPORT = "tasks-json-v1";

const MIGRATIONS = [
  {
    version: 1,
    name: "shared-state-core",
    sql: `
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        projection_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX tasks_updated_at_idx ON tasks(updated_at DESC, id ASC);

      CREATE TABLE task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
        seq INTEGER NOT NULL CHECK (seq > 0),
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        message TEXT,
        data_json TEXT,
        UNIQUE(task_id, seq)
      ) STRICT;
      CREATE INDEX task_events_task_idx ON task_events(task_id, seq);
      CREATE TRIGGER task_events_immutable_update
      BEFORE UPDATE ON task_events
      BEGIN
        SELECT RAISE(ABORT, 'task events are immutable');
      END;
      CREATE TRIGGER task_events_immutable_delete
      BEFORE DELETE ON task_events
      BEGIN
        SELECT RAISE(ABORT, 'task events are immutable');
      END;

      CREATE TABLE runtimes (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
        generation INTEGER NOT NULL CHECK (generation >= 0),
        state TEXT NOT NULL CHECK (state IN ('starting', 'live', 'recoverable', 'recovering', 'ended')),
        agent TEXT NOT NULL,
        provider_session_id TEXT,
        pty_session_id TEXT,
        process_id INTEGER,
        process_started_at TEXT,
        worktree_id TEXT,
        parent_session_id TEXT,
        model TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ended_at TEXT,
        UNIQUE(task_id, generation)
      ) STRICT;
      CREATE INDEX runtimes_task_idx ON runtimes(task_id, generation DESC);

      CREATE TABLE operations (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'succeeded', 'failed')),
        claim_token TEXT,
        claimed_at TEXT,
        claim_expires_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        last_error TEXT,
        payload_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX operations_claim_idx ON operations(state, claim_expires_at, created_at);

      CREATE TABLE notification_outbox (
        id TEXT PRIMARY KEY,
        task_event_id INTEGER NOT NULL REFERENCES task_events(id) ON DELETE RESTRICT,
        channel TEXT NOT NULL CHECK (channel IN ('mate', 'push')),
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'delivered', 'failed')),
        intent_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        available_at TEXT NOT NULL,
        claimed_at TEXT,
        delivered_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(task_event_id, channel)
      ) STRICT;
      CREATE INDEX notification_outbox_pending_idx
        ON notification_outbox(state, available_at, created_at);

      CREATE TABLE legacy_imports (
        source TEXT PRIMARY KEY,
        imported_at TEXT NOT NULL,
        task_count INTEGER NOT NULL,
        event_count INTEGER NOT NULL
      ) STRICT;
    `
  },
  {
    version: 2,
    name: "durable-executor-claims",
    sql: `
      ALTER TABLE notification_outbox ADD COLUMN claim_token TEXT;
      ALTER TABLE notification_outbox ADD COLUMN claim_expires_at TEXT;
      CREATE INDEX notification_outbox_claim_idx
        ON notification_outbox(state, claim_expires_at, available_at, created_at);
    `
  },
  {
    version: 3,
    name: "authoritative-runtime-lifecycle",
    sql: `
      ALTER TABLE runtimes ADD COLUMN provider TEXT;
      ALTER TABLE runtimes ADD COLUMN worker_name TEXT;
      ALTER TABLE runtimes ADD COLUMN worktree_path TEXT;
      ALTER TABLE runtimes ADD COLUMN lease_id TEXT;
      ALTER TABLE runtimes ADD COLUMN owner_instance_id TEXT;
      CREATE UNIQUE INDEX runtimes_pty_session_unique
        ON runtimes(pty_session_id) WHERE pty_session_id IS NOT NULL;
      CREATE INDEX runtimes_state_idx ON runtimes(state, updated_at);
    `
  },
  {
    version: 4,
    name: "durable-mate-owner",
    sql: `
      CREATE TABLE durable_owners (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE owner_runtimes (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES durable_owners(id) ON DELETE RESTRICT,
        generation INTEGER NOT NULL CHECK (generation >= 0),
        state TEXT NOT NULL CHECK (state IN ('starting', 'live', 'recoverable', 'recovering', 'ended')),
        agent TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_session_id TEXT,
        pty_session_id TEXT,
        process_id INTEGER,
        process_started_at TEXT,
        cwd TEXT NOT NULL,
        model TEXT,
        owner_instance_id TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ended_at TEXT,
        UNIQUE(owner_id, generation)
      ) STRICT;
      CREATE UNIQUE INDEX owner_runtimes_pty_session_unique
        ON owner_runtimes(pty_session_id) WHERE pty_session_id IS NOT NULL;
      CREATE INDEX owner_runtimes_state_idx ON owner_runtimes(state, updated_at);

      CREATE TABLE owner_operations (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES durable_owners(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed')),
        generation INTEGER NOT NULL CHECK (generation >= 0),
        result_json TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX owner_operations_owner_idx ON owner_operations(owner_id, created_at DESC);

      ALTER TABLE runtimes ADD COLUMN parent_owner_id TEXT REFERENCES durable_owners(id) ON DELETE RESTRICT;
      CREATE INDEX runtimes_parent_owner_idx ON runtimes(parent_owner_id, state);
    `
  },
  {
    version: 5,
    name: "durable-claude-approvals",
    sql: `
      CREATE TABLE claude_approvals (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version = 1),
        state TEXT NOT NULL CHECK (state IN ('pending', 'decided', 'decision_sent', 'continued', 'denied', 'expired', 'canceled', 'local_fallback')),
        perch_session_id TEXT NOT NULL,
        claude_session_id TEXT NOT NULL,
        prompt_identity TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_input_json TEXT NOT NULL,
        tool_input_hash TEXT NOT NULL,
        summary TEXT NOT NULL,
        command TEXT,
        cwd TEXT,
        transcript_path TEXT,
        runtime_generation INTEGER,
        task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
        worker_session_id TEXT NOT NULL,
        parent_session_id TEXT,
        decision_policy TEXT NOT NULL CHECK (decision_policy = 'boss_only'),
        decision TEXT CHECK (decision IN ('allow', 'deny', 'allow_always')),
        selected_permission_json TEXT,
        decided_by TEXT,
        decided_at TEXT,
        decision_sent_at TEXT,
        confirmed_at TEXT,
        expires_at TEXT NOT NULL,
        failure_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX claude_approvals_session_idx
        ON claude_approvals(perch_session_id, created_at DESC);
      CREATE INDEX claude_approvals_open_idx
        ON claude_approvals(state, expires_at, created_at);
      CREATE INDEX claude_approvals_identity_idx
        ON claude_approvals(perch_session_id, prompt_identity, created_at DESC);
    `
  },
  {
    version: 6,
    name: "durable-claude-questions",
    sql: `
      CREATE TABLE claude_questions (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version = 1),
        state TEXT NOT NULL CHECK (state IN ('waiting', 'answer_sent', 'continued', 'expired', 'local_fallback', 'simultaneous_fallback')),
        perch_session_id TEXT NOT NULL,
        claude_session_id TEXT NOT NULL,
        tool_use_id TEXT NOT NULL,
        questions_json TEXT NOT NULL,
        questions_hash TEXT NOT NULL,
        answers_json TEXT,
        cwd TEXT,
        transcript_path TEXT,
        runtime_generation INTEGER,
        task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
        worker_session_id TEXT NOT NULL,
        parent_session_id TEXT,
        answer_policy TEXT NOT NULL CHECK (answer_policy = 'boss_only'),
        answered_by TEXT,
        answered_at TEXT,
        answer_sent_at TEXT,
        confirmed_at TEXT,
        expires_at TEXT NOT NULL,
        failure_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX claude_questions_session_idx
        ON claude_questions(perch_session_id, created_at DESC);
      CREATE INDEX claude_questions_open_idx
        ON claude_questions(state, expires_at, created_at);
      CREATE UNIQUE INDEX claude_questions_tool_use_idx
        ON claude_questions(perch_session_id, tool_use_id);
    `
  },
  {
    version: 7,
    name: "typed-claude-approval-kinds",
    sql: `
      ALTER TABLE claude_approvals ADD COLUMN interaction_kind TEXT NOT NULL DEFAULT 'permission_request'
        CHECK (interaction_kind IN ('permission_request', 'exit_plan_mode'));
      ALTER TABLE claude_approvals ADD COLUMN hook_event_name TEXT NOT NULL DEFAULT 'PermissionRequest'
        CHECK (hook_event_name IN ('PermissionRequest', 'PreToolUse'));
    `
  },
  {
    version: 8,
    name: "durable-claude-blocking-interactions",
    sql: `
      CREATE TABLE claude_interactions (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version = 1),
        kind TEXT NOT NULL CHECK (kind IN ('elicitation', 'elicitation_result', 'permission_denied', 'pty_manual_gate')),
        state TEXT NOT NULL CHECK (state IN ('waiting', 'response_sent', 'confirmed', 'expired', 'local_fallback', 'observed')),
        perch_session_id TEXT NOT NULL,
        claude_session_id TEXT,
        provider_request_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        summary TEXT NOT NULL,
        runtime_generation INTEGER,
        task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
        response_action TEXT CHECK (response_action IN ('accept', 'decline', 'cancel')),
        response_content_json TEXT,
        responded_by TEXT,
        responded_at TEXT,
        confirmed_at TEXT,
        expires_at TEXT,
        failure_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(perch_session_id, kind, provider_request_id)
      ) STRICT;
      CREATE INDEX claude_interactions_session_idx ON claude_interactions(perch_session_id, created_at DESC);
      CREATE INDEX claude_interactions_open_idx ON claude_interactions(state, created_at);
    `
  },
  {
    version: 9,
    name: "claude-inbox-correlation-and-deltas",
    sql: `
      CREATE TABLE claude_tool_occurrences (
        id TEXT PRIMARY KEY,
        perch_session_id TEXT NOT NULL,
        claude_session_id TEXT NOT NULL,
        tool_use_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_input_hash TEXT NOT NULL,
        runtime_generation INTEGER,
        occurrence INTEGER NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(perch_session_id, tool_use_id)
      ) STRICT;
      CREATE INDEX claude_tool_occurrences_match_idx
        ON claude_tool_occurrences(perch_session_id, claude_session_id, tool_name, tool_input_hash, consumed_at, created_at DESC);
      CREATE TABLE claude_inbox_deltas (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        request_type TEXT NOT NULL CHECK (request_type IN ('permission', 'question', 'interaction')),
        request_id TEXT NOT NULL,
        state TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        at TEXT NOT NULL
      ) STRICT;
      CREATE TRIGGER claude_approval_insert_delta AFTER INSERT ON claude_approvals BEGIN
        INSERT INTO claude_inbox_deltas(request_type, request_id, state, snapshot_json, at)
        VALUES ('permission', NEW.id, NEW.state, json_object('id', NEW.id, 'version', NEW.version, 'state', NEW.state, 'kind', NEW.interaction_kind, 'sessionId', NEW.perch_session_id, 'runtimeGeneration', NEW.runtime_generation, 'taskId', NEW.task_id), NEW.updated_at);
      END;
      CREATE TRIGGER claude_approval_update_delta AFTER UPDATE ON claude_approvals BEGIN
        INSERT INTO claude_inbox_deltas(request_type, request_id, state, snapshot_json, at)
        VALUES ('permission', NEW.id, NEW.state, json_object('id', NEW.id, 'version', NEW.version, 'state', NEW.state, 'kind', NEW.interaction_kind, 'sessionId', NEW.perch_session_id, 'runtimeGeneration', NEW.runtime_generation, 'taskId', NEW.task_id), NEW.updated_at);
      END;
      CREATE TRIGGER claude_question_insert_delta AFTER INSERT ON claude_questions BEGIN
        INSERT INTO claude_inbox_deltas(request_type, request_id, state, snapshot_json, at)
        VALUES ('question', NEW.id, NEW.state, json_object('id', NEW.id, 'version', NEW.version, 'state', NEW.state, 'sessionId', NEW.perch_session_id, 'runtimeGeneration', NEW.runtime_generation, 'taskId', NEW.task_id), NEW.updated_at);
      END;
      CREATE TRIGGER claude_question_update_delta AFTER UPDATE ON claude_questions BEGIN
        INSERT INTO claude_inbox_deltas(request_type, request_id, state, snapshot_json, at)
        VALUES ('question', NEW.id, NEW.state, json_object('id', NEW.id, 'version', NEW.version, 'state', NEW.state, 'sessionId', NEW.perch_session_id, 'runtimeGeneration', NEW.runtime_generation, 'taskId', NEW.task_id), NEW.updated_at);
      END;
      CREATE TRIGGER claude_interaction_insert_delta AFTER INSERT ON claude_interactions BEGIN
        INSERT INTO claude_inbox_deltas(request_type, request_id, state, snapshot_json, at)
        VALUES ('interaction', NEW.id, NEW.state, json_object('id', NEW.id, 'version', NEW.version, 'state', NEW.state, 'kind', NEW.kind, 'sessionId', NEW.perch_session_id, 'runtimeGeneration', NEW.runtime_generation, 'taskId', NEW.task_id), NEW.updated_at);
      END;
      CREATE TRIGGER claude_interaction_update_delta AFTER UPDATE ON claude_interactions BEGIN
        INSERT INTO claude_inbox_deltas(request_type, request_id, state, snapshot_json, at)
        VALUES ('interaction', NEW.id, NEW.state, json_object('id', NEW.id, 'version', NEW.version, 'state', NEW.state, 'kind', NEW.kind, 'sessionId', NEW.perch_session_id, 'runtimeGeneration', NEW.runtime_generation, 'taskId', NEW.task_id), NEW.updated_at);
      END;
    `
  },
  {
    version: 10,
    name: "separate-task-pr-and-verification-facts",
    sql: `
      CREATE TABLE task_pr_facts (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE RESTRICT,
        facts_json TEXT NOT NULL,
        observed_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE task_verification_facts (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
        request_seq INTEGER NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('requested', 'accepted', 'rejected', 'invalidated')),
        deliverable_json TEXT,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY(task_id, request_seq, decision)
      ) STRICT;

      INSERT OR IGNORE INTO task_pr_facts(task_id, facts_json, observed_at)
      SELECT id, json_extract(projection_json, '$.pr'), updated_at
      FROM tasks WHERE json_extract(projection_json, '$.pr') IS NOT NULL;

      INSERT OR IGNORE INTO task_verification_facts(task_id, request_seq, decision, deliverable_json, recorded_at)
      SELECT task_id, seq, 'requested', json_extract(data_json, '$.deliverable'), at
      FROM task_events WHERE kind = 'completion_requested';

      INSERT OR IGNORE INTO task_verification_facts(task_id, request_seq, decision, deliverable_json, recorded_at)
      SELECT task_id, json_extract(data_json, '$.completionDecision.requestSeq'),
             CASE kind WHEN 'completion_accepted' THEN 'accepted' ELSE 'rejected' END,
             json_extract(data_json, '$.completionDecision.deliverable'), at
      FROM task_events
      WHERE kind IN ('completion_accepted', 'completion_rejected')
        AND typeof(json_extract(data_json, '$.completionDecision.requestSeq')) = 'integer';
    `
  }
] as const;

export type NotificationChannel = "mate" | "push";

export type NotificationIntentInput = {
  channel: NotificationChannel;
  payload: Record<string, unknown>;
  availableAt?: string;
};

export type RuntimeState = "starting" | "live" | "recoverable" | "recovering" | "ended";

export type RuntimeRecord = {
  id: string;
  taskId: string;
  generation: number;
  state: RuntimeState;
  agent: string;
  provider?: string;
  providerSessionId?: string;
  ptySessionId?: string;
  processId?: number;
  processStartedAt?: string;
  worktreeId?: string;
  worktreePath?: string;
  leaseId?: string;
  parentSessionId?: string;
  parentOwnerId?: string;
  workerName?: string;
  ownerInstanceId?: string;
  model?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
};

export type DurableOwnerRecord = {
  id: string;
  role: string;
  createdAt: string;
  updatedAt: string;
};

export type OwnerRuntimeRecord = {
  id: string;
  ownerId: string;
  generation: number;
  state: RuntimeState;
  agent: string;
  provider: string;
  providerSessionId?: string;
  ptySessionId?: string;
  processId?: number;
  processStartedAt?: string;
  cwd: string;
  model?: string;
  ownerInstanceId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
};

export type OwnerOperationRecord = {
  id: string;
  ownerId: string;
  kind: string;
  idempotencyKey: string;
  state: "running" | "succeeded" | "failed";
  generation: number;
  result?: Record<string, unknown>;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type OperationState = "pending" | "claimed" | "succeeded" | "failed";

export type OperationRecord = {
  id: string;
  taskId: string;
  kind: string;
  idempotencyKey: string;
  state: OperationState;
  claimToken?: string;
  claimedAt?: string;
  claimExpiresAt?: string;
  attempts: number;
  lastError?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type NotificationOutboxRecord = {
  id: string;
  taskEventId: number;
  channel: NotificationChannel;
  state: "pending" | "claimed" | "delivered" | "failed";
  payload: Record<string, unknown>;
  attempts: number;
  availableAt: string;
  claimedAt?: string;
  claimToken?: string;
  claimExpiresAt?: string;
  deliveredAt?: string;
  lastError?: string;
  createdAt: string;
};

export type ClaudeApprovalState =
  | "pending"
  | "decided"
  | "decision_sent"
  | "continued"
  | "denied"
  | "expired"
  | "canceled"
  | "local_fallback";

export type ClaudeApprovalRecord = {
  id: string;
  version: 1;
  state: ClaudeApprovalState;
  interactionKind: "permission_request" | "exit_plan_mode";
  hookEventName: "PermissionRequest" | "PreToolUse";
  perchSessionId: string;
  claudeSessionId: string;
  promptIdentity: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolInputHash: string;
  summary: string;
  command?: string;
  cwd?: string;
  transcriptPath?: string;
  runtimeGeneration?: number;
  taskId?: string;
  workerSessionId: string;
  parentSessionId?: string;
  decisionPolicy: "boss_only";
  decision?: "allow" | "deny" | "allow_always";
  selectedPermission?: Record<string, unknown>;
  decidedBy?: string;
  decidedAt?: string;
  decisionSentAt?: string;
  confirmedAt?: string;
  expiresAt: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
};

export type ClaudeQuestionState =
  | "waiting"
  | "answer_sent"
  | "continued"
  | "expired"
  | "local_fallback"
  | "simultaneous_fallback";

export type ClaudeQuestionRecord = {
  id: string;
  version: 1;
  state: ClaudeQuestionState;
  perchSessionId: string;
  claudeSessionId: string;
  toolUseId: string;
  questions: unknown[];
  questionsHash: string;
  answers?: Record<string, string>;
  cwd?: string;
  transcriptPath?: string;
  runtimeGeneration?: number;
  taskId?: string;
  workerSessionId: string;
  parentSessionId?: string;
  answerPolicy: "boss_only";
  answeredBy?: string;
  answeredAt?: string;
  answerSentAt?: string;
  confirmedAt?: string;
  expiresAt: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
};

export type ClaudeInteractionRecord = {
  id: string;
  version: 1;
  kind: "elicitation" | "elicitation_result" | "permission_denied" | "pty_manual_gate";
  state: "waiting" | "response_sent" | "confirmed" | "expired" | "local_fallback" | "observed";
  perchSessionId: string;
  claudeSessionId?: string;
  providerRequestId: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  summary: string;
  runtimeGeneration?: number;
  taskId?: string;
  responseAction?: "accept" | "decline" | "cancel";
  responseContent?: Record<string, unknown>;
  respondedBy?: string;
  respondedAt?: string;
  confirmedAt?: string;
  expiresAt?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
};

export type ClaudeToolOccurrence = {
  id: string;
  perchSessionId: string;
  claudeSessionId: string;
  toolUseId: string;
  toolName: string;
  toolInputHash: string;
  runtimeGeneration?: number;
  occurrence: number;
  consumedAt?: string;
  createdAt: string;
};

export type ClaudeInboxDelta = {
  seq: number;
  requestType: "permission" | "question" | "interaction";
  requestId: string;
  state: string;
  snapshot: Record<string, unknown>;
  at: string;
};

type TaskEventInput = {
  kind: TaskEventKind;
  message?: string;
  source: TaskEventSource;
  data?: Record<string, unknown>;
};

type TaskRow = { projection_json: string };
type VerificationFactsRow = {
  request_seq: number;
  deliverable_json: string | null;
  accepted: number;
  accepted_deliverable_json: string | null;
};
type TaskEventRow = {
  id: number;
  seq: number;
  at: string;
  kind: TaskEventKind;
  source: TaskEventSource;
  message: string | null;
  data_json: string | null;
};

export class StateDb {
  readonly path: string;
  readonly tasks: TaskRepository;
  readonly runtimes: RuntimeRepository;
  readonly operations: OperationRepository;
  readonly owners: DurableOwnerRepository;
  readonly ownerRuntimes: OwnerRuntimeRepository;
  readonly ownerOperations: OwnerOperationRepository;
  readonly outbox: NotificationOutboxRepository;
  readonly claudeApprovals: ClaudeApprovalRepository;
  readonly claudeQuestions: ClaudeQuestionRepository;
  readonly claudeInteractions: ClaudeInteractionRepository;
  readonly claudeToolOccurrences: ClaudeToolOccurrenceRepository;
  readonly claudeInbox: ClaudeInboxRepository;
  private readonly db: Database.Database;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const home = env.PERCH_HOME ?? join(homedir(), ".perch");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.path = join(home, "state.sqlite");
    this.db = new Database(this.path);
    chmodSync(this.path, 0o600);
    this.configure();
    this.migrate();
    this.tasks = new TaskRepository(this.db);
    this.runtimes = new RuntimeRepository(this.db);
    this.operations = new OperationRepository(this.db);
    this.owners = new DurableOwnerRepository(this.db);
    this.ownerRuntimes = new OwnerRuntimeRepository(this.db);
    this.ownerOperations = new OwnerOperationRepository(this.db);
    this.outbox = new NotificationOutboxRepository(this.db);
    this.claudeApprovals = new ClaudeApprovalRepository(this.db);
    this.claudeQuestions = new ClaudeQuestionRepository(this.db);
    this.claudeInteractions = new ClaudeInteractionRepository(this.db);
    this.claudeToolOccurrences = new ClaudeToolOccurrenceRepository(this.db);
    this.claudeInbox = new ClaudeInboxRepository(this.db);
    this.importLegacyTasks(join(home, "tasks"));
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  schemaVersion(): number {
    return this.db.pragma("user_version", { simple: true }) as number;
  }

  journalMode(): string {
    return this.db.pragma("journal_mode", { simple: true }) as string;
  }

  foreignKeysEnabled(): boolean {
    return this.db.pragma("foreign_keys", { simple: true }) === 1;
  }

  // Rescan the legacy tree on every startup: per-record inserts are idempotent
  // (INSERT OR IGNORE on task id and (task_id, seq)), so legacy data that
  // appears later - a rollback to the JSON ledger, a restored backup - is
  // still picked up. Legacy sources are never modified or deleted; the marker
  // row only records cumulative counts and the last time new rows landed.
  importLegacyTasks(root: string): { imported: boolean; tasks: number; events: number } {
    const legacy = readLegacyTasks(root);
    if (legacy.length === 0) {
      return { imported: false, tasks: 0, events: 0 };
    }
    const run = this.db.transaction(() => {
      let taskCount = 0;
      let eventCount = 0;
      for (const entry of legacy) {
        const inserted = this.tasks.insertImported(entry.task, entry.events);
        taskCount += inserted.task;
        eventCount += inserted.events;
      }
      if (taskCount > 0 || eventCount > 0) {
        this.db
          .prepare(
            `INSERT INTO legacy_imports(source, imported_at, task_count, event_count) VALUES (?, ?, ?, ?)
             ON CONFLICT(source) DO UPDATE SET
               imported_at = excluded.imported_at,
               task_count = task_count + excluded.task_count,
               event_count = event_count + excluded.event_count`
          )
          .run(LEGACY_TASK_IMPORT, new Date().toISOString(), taskCount, eventCount);
      }
      return { imported: taskCount > 0 || eventCount > 0, tasks: taskCount, events: eventCount };
    });
    return run.immediate();
  }

  private configure(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
  }

  private migrate(): void {
    const current = this.db.pragma("user_version", { simple: true }) as number;
    if (current > LATEST_SCHEMA_VERSION) {
      throw new Error(`state database schema ${current} is newer than supported ${LATEST_SCHEMA_VERSION}`);
    }
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) {
        continue;
      }
      const apply = this.db.transaction(() => {
        const committed = this.db.pragma("user_version", { simple: true }) as number;
        if (migration.version <= committed) {
          return;
        }
        this.db.exec(migration.sql);
        this.db
          .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, new Date().toISOString());
        this.db.pragma(`user_version = ${migration.version}`);
      });
      apply.immediate();
    }
    const applied = this.db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as Array<{
      version: number;
      name: string;
    }>;
    for (const migration of MIGRATIONS) {
      const row = applied.find((candidate) => candidate.version === migration.version);
      if (!row || row.name !== migration.name) {
        throw new Error(`state database migration ${migration.version} is missing or inconsistent`);
      }
    }
  }
}

export class TaskRepository {
  constructor(private readonly db: Database.Database) {}

  countOpen(): number {
    return (
      this.db.prepare("SELECT count(*) AS count FROM tasks WHERE state != 'closed'").get() as { count: number }
    ).count;
  }

  list(): Task[] {
    const rows = this.db
      .prepare("SELECT projection_json FROM tasks ORDER BY updated_at DESC, id ASC")
      .all() as TaskRow[];
    return rows.map((row) => JSON.parse(row.projection_json) as Task);
  }

  find(id: string): Task | undefined {
    const row = this.db.prepare("SELECT projection_json FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? (JSON.parse(row.projection_json) as Task) : undefined;
  }

  save(task: Task): void {
    const result = this.db
      .prepare("UPDATE tasks SET state = ?, updated_at = ?, projection_json = ? WHERE id = ?")
      .run(task.state, task.updatedAt, JSON.stringify(task), task.id);
    if (result.changes !== 1) {
      throw new Error(`Unknown task: ${task.id}`);
    }
    this.savePrFacts(task);
  }

  create(task: Task, event: TaskEventInput): TaskEvent {
    const create = this.db.transaction(() => {
      this.insertTask(task);
      return this.appendEvent(task.id, event, []);
    });
    return create.immediate();
  }

  record(task: Task, event: TaskEventInput, intents: NotificationIntentInput[] = []): TaskEvent {
    const record = this.db.transaction(() => {
      this.save(task);
      return this.appendEvent(task.id, event, intents);
    });
    return record.immediate();
  }

  recordMany(
    task: Task,
    entries: Array<{ event: TaskEventInput; intents: NotificationIntentInput[] }>
  ): TaskEvent[] {
    const record = this.db.transaction(() => {
      this.save(task);
      return entries.map(({ event, intents }) => this.appendEvent(task.id, event, intents));
    });
    return record.immediate();
  }

  events(taskId: string): TaskEvent[] {
    const rows = this.db
      .prepare(
        "SELECT id, seq, at, kind, source, message, data_json FROM task_events WHERE task_id = ? ORDER BY seq"
      )
      .all(taskId) as TaskEventRow[];
    return rows.map(taskEventFromRow);
  }

  // The durable GitHub observations for a task's PR, written in the same
  // transaction as every projection save. Presentation derives from these
  // facts, not from the stored projection snapshot.
  prFacts(taskId: string): TaskPr | undefined {
    const row = this.db
      .prepare("SELECT facts_json FROM task_pr_facts WHERE task_id = ?")
      .get(taskId) as { facts_json: string } | undefined;
    return row ? (JSON.parse(row.facts_json) as TaskPr) : undefined;
  }

  prFactsByTask(): Map<string, TaskPr> {
    const rows = this.db
      .prepare("SELECT task_id, facts_json FROM task_pr_facts")
      .all() as Array<{ task_id: string; facts_json: string }>;
    return new Map(rows.map((row) => [row.task_id, JSON.parse(row.facts_json) as TaskPr]));
  }

  // The latest completion request and its mate decision, without loading the
  // task's whole event ledger. Task listing sits on hot paths and must not
  // fan out a full-history query per task.
  verificationFacts(taskId: string): TaskVerificationFacts | undefined {
    const row = this.db
      .prepare(
        `SELECT requested.request_seq, requested.deliverable_json,
                accepted.task_id IS NOT NULL AS accepted, accepted.deliverable_json AS accepted_deliverable_json
         FROM task_verification_facts requested
         LEFT JOIN task_verification_facts accepted
           ON accepted.task_id = requested.task_id
          AND accepted.request_seq = requested.request_seq
          AND accepted.decision = 'accepted'
         WHERE requested.task_id = ? AND requested.decision = 'requested'
         ORDER BY requested.request_seq DESC LIMIT 1`
      )
      .get(taskId) as VerificationFactsRow | undefined;
    return row ? verificationFactsFromRow(row) : undefined;
  }

  verificationFactsByTask(): Map<string, TaskVerificationFacts> {
    const rows = this.db
      .prepare(
        `SELECT requested.task_id, requested.request_seq, requested.deliverable_json,
                accepted.task_id IS NOT NULL AS accepted, accepted.deliverable_json AS accepted_deliverable_json
         FROM task_verification_facts requested
         JOIN (
           SELECT task_id, max(request_seq) AS request_seq
           FROM task_verification_facts WHERE decision = 'requested' GROUP BY task_id
         ) latest
           ON latest.task_id = requested.task_id AND latest.request_seq = requested.request_seq
         LEFT JOIN task_verification_facts accepted
           ON accepted.task_id = requested.task_id
          AND accepted.request_seq = requested.request_seq
          AND accepted.decision = 'accepted'
         WHERE requested.decision = 'requested'`
      )
      .all() as Array<VerificationFactsRow & { task_id: string }>;
    return new Map(rows.map((row) => [row.task_id, verificationFactsFromRow(row)]));
  }

  insertImported(task: Task, events: TaskEvent[]): { task: number; events: number } {
    const taskResult = this.db
      .prepare("INSERT OR IGNORE INTO tasks(id, state, updated_at, projection_json) VALUES (?, ?, ?, ?)")
      .run(task.id, task.state, task.updatedAt, JSON.stringify(task));
    if (taskResult.changes === 0) {
      return { task: 0, events: 0 };
    }
    this.savePrFacts(task);
    let eventCount = 0;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO task_events(task_id, seq, at, kind, source, message, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const event of events) {
      const result = insert.run(
        task.id,
        event.seq,
        event.at,
        event.kind,
        event.source,
        event.message ?? null,
        event.data ? JSON.stringify(event.data) : null
      );
      eventCount += result.changes;
      if (result.changes > 0) {
        this.saveVerificationFacts(task.id, event);
      }
    }
    return { task: taskResult.changes, events: eventCount };
  }

  private insertTask(task: Task): void {
    this.db
      .prepare("INSERT INTO tasks(id, state, updated_at, projection_json) VALUES (?, ?, ?, ?)")
      .run(task.id, task.state, task.updatedAt, JSON.stringify(task));
    this.savePrFacts(task);
  }

  private appendEvent(taskId: string, event: TaskEventInput, intents: NotificationIntentInput[]): TaskEvent {
    const next = this.db
      .prepare("SELECT coalesce(max(seq), 0) + 1 AS seq FROM task_events WHERE task_id = ?")
      .get(taskId) as { seq: number };
    const at = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO task_events(task_id, seq, at, kind, source, message, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        taskId,
        next.seq,
        at,
        event.kind,
        event.source,
        event.message ?? null,
        event.data ? JSON.stringify(event.data) : null
      );
    const insertIntent = this.db.prepare(
      `INSERT INTO notification_outbox(
         id, task_event_id, channel, state, intent_json, attempts, available_at, created_at
       ) VALUES (?, ?, ?, 'pending', ?, 0, ?, ?)`
    );
    for (const intent of intents) {
      insertIntent.run(
        randomUUID(),
        Number(result.lastInsertRowid),
        intent.channel,
        JSON.stringify(intent.payload),
        intent.availableAt ?? at,
        at
      );
    }
    const persisted = {
      seq: next.seq,
      at,
      kind: event.kind,
      source: event.source,
      ...(event.message ? { message: event.message } : {}),
      ...(event.data ? { data: event.data } : {})
    };
    this.saveVerificationFacts(taskId, persisted);
    return persisted;
  }

  private savePrFacts(task: Task): void {
    if (!task.pr) return;
    this.db.prepare(
      `INSERT INTO task_pr_facts(task_id, facts_json, observed_at) VALUES (?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET facts_json = excluded.facts_json, observed_at = excluded.observed_at`
    ).run(task.id, JSON.stringify(task.pr), task.updatedAt);
  }

  private saveVerificationFacts(taskId: string, event: TaskEvent): void {
    if (event.kind === "completion_requested") {
      const deliverable = event.data?.deliverable;
      this.db.prepare(
        `INSERT OR REPLACE INTO task_verification_facts(task_id, request_seq, decision, deliverable_json, recorded_at)
         VALUES (?, ?, 'requested', ?, ?)`
      ).run(taskId, event.seq, deliverable ? JSON.stringify(deliverable) : null, event.at);
      return;
    }
    if (event.kind !== "completion_accepted" && event.kind !== "completion_rejected") return;
    const decision = (event.data as { completionDecision?: { requestSeq?: unknown; deliverable?: unknown } } | undefined)
      ?.completionDecision;
    const requestSeq = decision?.requestSeq;
    if (!Number.isInteger(requestSeq)) return;
    this.db.prepare(
      `INSERT OR REPLACE INTO task_verification_facts(task_id, request_seq, decision, deliverable_json, recorded_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      taskId,
      requestSeq,
      event.kind === "completion_accepted" ? "accepted" : "rejected",
      decision?.deliverable ? JSON.stringify(decision.deliverable) : null,
      event.at
    );
  }
}

export class RuntimeRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: Omit<RuntimeRecord, "id" | "createdAt" | "updatedAt"> & { id?: string }): RuntimeRecord {
    const now = new Date().toISOString();
    const runtime: RuntimeRecord = { ...input, id: input.id ?? randomUUID(), createdAt: now, updatedAt: now };
    this.db
      .prepare(
        `INSERT INTO runtimes(
          id, task_id, generation, state, agent, provider_session_id, pty_session_id, process_id,
          process_started_at, worktree_id, parent_session_id, model, metadata_json, created_at, updated_at, ended_at,
          provider, worker_name, worktree_path, lease_id, owner_instance_id, parent_owner_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        runtime.id,
        runtime.taskId,
        runtime.generation,
        runtime.state,
        runtime.agent,
        runtime.providerSessionId ?? null,
        runtime.ptySessionId ?? null,
        runtime.processId ?? null,
        runtime.processStartedAt ?? null,
        runtime.worktreeId ?? null,
        runtime.parentSessionId ?? null,
        runtime.model ?? null,
        runtime.metadata ? JSON.stringify(runtime.metadata) : null,
        runtime.createdAt,
        runtime.updatedAt,
        runtime.endedAt ?? null,
        runtime.provider ?? null,
        runtime.workerName ?? null,
        runtime.worktreePath ?? null,
        runtime.leaseId ?? null,
        runtime.ownerInstanceId ?? null,
        runtime.parentOwnerId ?? null
      );
    return runtime;
  }

  latestForTask(taskId: string): RuntimeRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM runtimes WHERE task_id = ? ORDER BY generation DESC LIMIT 1")
      .get(taskId) as RuntimeRow | undefined;
    return row ? runtimeFromRow(row) : undefined;
  }

  // One query for every task's latest generation; task listing sits on hot
  // paths (hook events, codex stream deltas) and must not fan out per task.
  latestByTask(): Map<string, RuntimeRecord> {
    const rows = this.db
      .prepare(
        `SELECT runtimes.* FROM runtimes
         JOIN (SELECT task_id, max(generation) AS generation FROM runtimes GROUP BY task_id) latest
           ON latest.task_id = runtimes.task_id AND latest.generation = runtimes.generation`
      )
      .all() as RuntimeRow[];
    return new Map(rows.map((row) => [row.task_id, runtimeFromRow(row)]));
  }

  findBySession(sessionId: string): RuntimeRecord | undefined {
    const row = this.db.prepare("SELECT * FROM runtimes WHERE pty_session_id = ?").get(sessionId) as RuntimeRow | undefined;
    return row ? runtimeFromRow(row) : undefined;
  }

  active(): RuntimeRecord[] {
    return (this.db
      .prepare("SELECT * FROM runtimes WHERE state != 'ended' ORDER BY task_id, generation DESC")
      .all() as RuntimeRow[]).map(runtimeFromRow);
  }

  compareAndSwap(
    taskId: string,
    generation: number,
    expected: RuntimeState | readonly RuntimeState[],
    next: RuntimeState,
    patch: Partial<Omit<RuntimeRecord, "id" | "taskId" | "generation" | "createdAt">> = {}
  ): RuntimeRecord | undefined {
    const expectedStates = Array.isArray(expected) ? expected : [expected];
    if (expectedStates.length === 0) return undefined;
    const current = this.latestForTask(taskId);
    if (!current || current.generation !== generation || !expectedStates.includes(current.state)) return undefined;
    const updated: RuntimeRecord = {
      ...current,
      ...patch,
      state: next,
      updatedAt: new Date().toISOString(),
      ...(next === "ended" ? { endedAt: patch.endedAt ?? new Date().toISOString() } : {})
    };
    const result = this.db.prepare(
      `UPDATE runtimes SET state = ?, provider = ?, provider_session_id = ?, pty_session_id = ?,
        process_id = ?, process_started_at = ?, worktree_id = ?, worktree_path = ?, lease_id = ?,
        parent_session_id = ?, parent_owner_id = ?, worker_name = ?, owner_instance_id = ?, model = ?, metadata_json = ?,
        updated_at = ?, ended_at = ?
       WHERE task_id = ? AND generation = ? AND state IN (${expectedStates.map(() => "?").join(",")})`
    ).run(
      updated.state, updated.provider ?? null, updated.providerSessionId ?? null, updated.ptySessionId ?? null,
      updated.processId ?? null, updated.processStartedAt ?? null, updated.worktreeId ?? null,
      updated.worktreePath ?? null, updated.leaseId ?? null, updated.parentSessionId ?? null,
      updated.parentOwnerId ?? null, updated.workerName ?? null, updated.ownerInstanceId ?? null, updated.model ?? null,
      updated.metadata ? JSON.stringify(updated.metadata) : null, updated.updatedAt, updated.endedAt ?? null,
      taskId, generation, ...expectedStates
    );
    return result.changes === 1 ? updated : undefined;
  }

  replaceRecoveringGeneration(
    current: Pick<RuntimeRecord, "taskId" | "generation" | "id">,
    next: Omit<RuntimeRecord, "id" | "taskId" | "generation" | "createdAt" | "updatedAt"> & { id?: string }
  ): RuntimeRecord | undefined {
    return this.db.transaction(() => {
      const latest = this.latestForTask(current.taskId);
      if (
        !latest ||
        latest.id !== current.id ||
        latest.generation !== current.generation ||
        latest.state !== "recovering"
      ) {
        return undefined;
      }
      const ended = this.compareAndSwap(current.taskId, current.generation, "recovering", "ended");
      if (!ended) return undefined;
      return this.create({
        ...next,
        taskId: current.taskId,
        generation: current.generation + 1
      });
    })();
  }

  rebindParent(ownerId: string, oldSessionId: string | undefined, newSessionId: string): RuntimeRecord[] {
    const candidates = this.active().filter(
      (runtime) =>
        runtime.parentOwnerId === ownerId ||
        (oldSessionId !== undefined && !runtime.parentOwnerId && runtime.parentSessionId === oldSessionId)
    );
    const updated: RuntimeRecord[] = [];
    for (const runtime of candidates) {
      const next = this.compareAndSwap(runtime.taskId, runtime.generation, runtime.state, runtime.state, {
        parentOwnerId: ownerId,
        parentSessionId: newSessionId
      });
      if (next) updated.push(next);
    }
    return updated;
  }
}

export class DurableOwnerRepository {
  constructor(private readonly db: Database.Database) {}

  ensure(id: string, role: string): DurableOwnerRecord {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO durable_owners(id, role, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`
    ).run(id, role, now, now);
    return this.find(id)!;
  }
  find(id: string): DurableOwnerRecord | undefined {
    const row = this.db.prepare("SELECT * FROM durable_owners WHERE id = ?").get(id) as OwnerRow | undefined;
    return row ? ownerFromRow(row) : undefined;
  }
}

export class OwnerRuntimeRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: Omit<OwnerRuntimeRecord, "id" | "createdAt" | "updatedAt"> & { id?: string }): OwnerRuntimeRecord {
    const now = new Date().toISOString();
    const runtime: OwnerRuntimeRecord = { ...input, id: input.id ?? randomUUID(), createdAt: now, updatedAt: now };
    this.db.prepare(
      `INSERT INTO owner_runtimes(
         id, owner_id, generation, state, agent, provider, provider_session_id, pty_session_id,
         process_id, process_started_at, cwd, model, owner_instance_id, metadata_json,
         created_at, updated_at, ended_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      runtime.id, runtime.ownerId, runtime.generation, runtime.state, runtime.agent, runtime.provider,
      runtime.providerSessionId ?? null, runtime.ptySessionId ?? null, runtime.processId ?? null,
      runtime.processStartedAt ?? null, runtime.cwd, runtime.model ?? null, runtime.ownerInstanceId ?? null,
      runtime.metadata ? JSON.stringify(runtime.metadata) : null, runtime.createdAt, runtime.updatedAt,
      runtime.endedAt ?? null
    );
    return runtime;
  }

  latest(ownerId: string): OwnerRuntimeRecord | undefined {
    const row = this.db.prepare(
      "SELECT * FROM owner_runtimes WHERE owner_id = ? ORDER BY generation DESC LIMIT 1"
    ).get(ownerId) as OwnerRuntimeRow | undefined;
    return row ? ownerRuntimeFromRow(row) : undefined;
  }

  findBySession(sessionId: string): OwnerRuntimeRecord | undefined {
    const row = this.db.prepare("SELECT * FROM owner_runtimes WHERE pty_session_id = ?").get(sessionId) as OwnerRuntimeRow | undefined;
    return row ? ownerRuntimeFromRow(row) : undefined;
  }

  active(): OwnerRuntimeRecord[] {
    return (this.db.prepare("SELECT * FROM owner_runtimes WHERE state != 'ended' ORDER BY owner_id, generation DESC").all() as OwnerRuntimeRow[])
      .map(ownerRuntimeFromRow);
  }

  compareAndSwap(
    ownerId: string,
    generation: number,
    expected: RuntimeState | readonly RuntimeState[],
    next: RuntimeState,
    patch: Partial<Omit<OwnerRuntimeRecord, "id" | "ownerId" | "generation" | "createdAt">> = {}
  ): OwnerRuntimeRecord | undefined {
    const expectedStates = Array.isArray(expected) ? expected : [expected];
    const current = this.latest(ownerId);
    if (!current || current.generation !== generation || !expectedStates.includes(current.state)) return undefined;
    const updated: OwnerRuntimeRecord = {
      ...current,
      ...patch,
      state: next,
      updatedAt: new Date().toISOString(),
      ...(next === "ended" ? { endedAt: patch.endedAt ?? new Date().toISOString() } : {})
    };
    const result = this.db.prepare(
      `UPDATE owner_runtimes SET state = ?, provider = ?, provider_session_id = ?, pty_session_id = ?,
         process_id = ?, process_started_at = ?, cwd = ?, model = ?, owner_instance_id = ?, metadata_json = ?,
         updated_at = ?, ended_at = ?
       WHERE owner_id = ? AND generation = ? AND state IN (${expectedStates.map(() => "?").join(",")})`
    ).run(
      updated.state, updated.provider, updated.providerSessionId ?? null, updated.ptySessionId ?? null,
      updated.processId ?? null, updated.processStartedAt ?? null, updated.cwd, updated.model ?? null,
      updated.ownerInstanceId ?? null, updated.metadata ? JSON.stringify(updated.metadata) : null,
      updated.updatedAt, updated.endedAt ?? null, ownerId, generation, ...expectedStates
    );
    return result.changes === 1 ? updated : undefined;
  }
}

export class OwnerOperationRepository {
  constructor(private readonly db: Database.Database) {}

  createOrFind(input: { ownerId: string; kind: string; idempotencyKey: string; generation: number }): OwnerOperationRecord {
    const existing = this.findByKey(input.idempotencyKey);
    if (existing) return existing;
    const now = new Date().toISOString();
    try {
      this.db.prepare(
        `INSERT INTO owner_operations(id, owner_id, kind, idempotency_key, state, generation, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`
      ).run(randomUUID(), input.ownerId, input.kind, input.idempotencyKey, input.generation, now, now);
    } catch (error) {
      const raced = this.findByKey(input.idempotencyKey);
      if (raced) return raced;
      throw error;
    }
    return this.findByKey(input.idempotencyKey)!;
  }

  findByKey(key: string): OwnerOperationRecord | undefined {
    const row = this.db.prepare("SELECT * FROM owner_operations WHERE idempotency_key = ?").get(key) as OwnerOperationRow | undefined;
    return row ? ownerOperationFromRow(row) : undefined;
  }

  finish(id: string, state: "succeeded" | "failed", result?: Record<string, unknown>, error?: string): OwnerOperationRecord {
    const now = new Date().toISOString();
    this.db.prepare(
      "UPDATE owner_operations SET state = ?, result_json = ?, last_error = ?, updated_at = ? WHERE id = ?"
    ).run(state, result ? JSON.stringify(result) : null, error ?? null, now, id);
    const row = this.db.prepare("SELECT * FROM owner_operations WHERE id = ?").get(id) as OwnerOperationRow;
    return ownerOperationFromRow(row);
  }
}

export class OperationRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: {
    taskId: string;
    kind: string;
    idempotencyKey: string;
    payload?: Record<string, unknown>;
  }): OperationRecord {
    const existing = this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return existing;
    }
    const now = new Date().toISOString();
    const operation: OperationRecord = {
      id: randomUUID(),
      taskId: input.taskId,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      state: "pending",
      attempts: 0,
      ...(input.payload ? { payload: input.payload } : {}),
      createdAt: now,
      updatedAt: now
    };
    try {
      this.db
        .prepare(
          `INSERT INTO operations(
            id, task_id, kind, idempotency_key, state, attempts, payload_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          operation.id,
          operation.taskId,
          operation.kind,
          operation.idempotencyKey,
          operation.state,
          operation.attempts,
          operation.payload ? JSON.stringify(operation.payload) : null,
          operation.createdAt,
          operation.updatedAt
        );
      return operation;
    } catch (error) {
      const raced = this.findByIdempotencyKey(input.idempotencyKey);
      if (raced) {
        return raced;
      }
      throw error;
    }
  }

  findByIdempotencyKey(key: string): OperationRecord | undefined {
    const row = this.db.prepare("SELECT * FROM operations WHERE idempotency_key = ?").get(key) as
      | OperationRow
      | undefined;
    return row ? operationFromRow(row) : undefined;
  }

  find(id: string): OperationRecord | undefined {
    const row = this.db.prepare("SELECT * FROM operations WHERE id = ?").get(id) as OperationRow | undefined;
    return row ? operationFromRow(row) : undefined;
  }

  claim(input: {
    id?: string;
    kind?: string;
    kinds?: readonly string[];
    token: string;
    now: string;
    expiresAt: string;
  }): OperationRecord | undefined {
    if (input.kind && input.kinds) throw new Error("operation claim accepts kind or kinds, not both");
    if (input.kinds?.length === 0) return undefined;
    const kindsClause = input.kinds
      ? `AND kind IN (${input.kinds.map(() => "?").join(", ")})`
      : "";
    const claim = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT * FROM operations
           WHERE (? IS NULL OR id = ?)
             AND (? IS NULL OR kind = ?)
             ${kindsClause}
             AND (state = 'pending' OR (state = 'claimed' AND claim_expires_at <= ?))
           ORDER BY created_at, id LIMIT 1`
        )
        .get(
          input.id ?? null,
          input.id ?? null,
          input.kind ?? null,
          input.kind ?? null,
          ...(input.kinds ?? []),
          input.now
        ) as
        | OperationRow
        | undefined;
      if (!row) return undefined;
      const result = this.db
        .prepare(
          `UPDATE operations SET state = 'claimed', claim_token = ?, claimed_at = ?, claim_expires_at = ?,
             attempts = attempts + 1, updated_at = ?
           WHERE id = ? AND (state = 'pending' OR (state = 'claimed' AND claim_expires_at <= ?))`
        )
        .run(input.token, input.now, input.expiresAt, input.now, row.id, input.now);
      return result.changes === 1 ? this.find(row.id) : undefined;
    });
    return claim.immediate();
  }

  renew(id: string, token: string, expiresAt: string, now: string): OperationRecord {
    const result = this.db
      .prepare(
        `UPDATE operations SET claim_expires_at = ?, updated_at = ?
         WHERE id = ? AND state = 'claimed' AND claim_token = ?`
      )
      .run(expiresAt, now, id, token);
    if (result.changes !== 1) throw new Error(`operation claim lost: ${id}`);
    return this.find(id)!;
  }

  updatePayload(id: string, token: string, payload: Record<string, unknown>, now: string): OperationRecord {
    const result = this.db
      .prepare(
        `UPDATE operations SET payload_json = ?, updated_at = ?
         WHERE id = ? AND state = 'claimed' AND claim_token = ?`
      )
      .run(JSON.stringify(payload), now, id, token);
    if (result.changes !== 1) throw new Error(`operation claim lost: ${id}`);
    return this.find(id)!;
  }

  succeed(id: string, token: string, now: string): OperationRecord {
    return this.finish(id, token, "succeeded", undefined, now);
  }

  fail(id: string, token: string, error: string, now: string): OperationRecord {
    return this.finish(id, token, "failed", error, now);
  }

  private finish(id: string, token: string, state: "succeeded" | "failed", error: string | undefined, now: string): OperationRecord {
    const result = this.db
      .prepare(
        `UPDATE operations SET state = ?, claim_token = NULL, claimed_at = NULL, claim_expires_at = NULL,
           last_error = ?, updated_at = ?
         WHERE id = ? AND state = 'claimed' AND claim_token = ?`
      )
      .run(state, error ?? null, now, id, token);
    if (result.changes !== 1) throw new Error(`operation claim lost: ${id}`);
    return this.find(id)!;
  }
}

export class NotificationOutboxRepository {
  constructor(private readonly db: Database.Database) {}

  pending(limit = 100): NotificationOutboxRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM notification_outbox
         WHERE state = 'pending' AND available_at <= ?
         ORDER BY available_at, created_at, id LIMIT ?`
      )
      .all(new Date().toISOString(), limit) as NotificationOutboxRow[];
    return rows.map(notificationOutboxFromRow);
  }

  forTaskEvent(taskId: string, seq: number): NotificationOutboxRecord[] {
    const rows = this.db
      .prepare(
        `SELECT notification_outbox.* FROM notification_outbox
         JOIN task_events ON task_events.id = notification_outbox.task_event_id
         WHERE task_events.task_id = ? AND task_events.seq = ?
         ORDER BY notification_outbox.channel`
      )
      .all(taskId, seq) as NotificationOutboxRow[];
    return rows.map(notificationOutboxFromRow);
  }

  claim(input: { token: string; now: string; expiresAt: string }): NotificationOutboxRecord | undefined {
    const claim = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT notification_outbox.* FROM notification_outbox
           JOIN task_events current_event ON current_event.id = notification_outbox.task_event_id
           WHERE ((notification_outbox.state = 'pending' AND notification_outbox.available_at <= ?)
              OR (notification_outbox.state = 'claimed' AND notification_outbox.claim_expires_at <= ?))
             AND NOT EXISTS (
               SELECT 1 FROM notification_outbox earlier
               JOIN task_events earlier_event ON earlier_event.id = earlier.task_event_id
               WHERE earlier_event.task_id = current_event.task_id
                 AND earlier.channel = notification_outbox.channel
                 AND earlier_event.id < current_event.id
                 AND earlier.state IN ('pending', 'claimed')
             )
           ORDER BY notification_outbox.available_at, notification_outbox.task_event_id,
             notification_outbox.channel LIMIT 1`
        )
        .get(input.now, input.now) as NotificationOutboxRow | undefined;
      if (!row) return undefined;
      const result = this.db
        .prepare(
          `UPDATE notification_outbox SET state = 'claimed', claim_token = ?, claimed_at = ?, claim_expires_at = ?,
             attempts = attempts + 1
           WHERE id = ? AND ((state = 'pending' AND available_at <= ?)
             OR (state = 'claimed' AND claim_expires_at <= ?))`
        )
        .run(input.token, input.now, input.expiresAt, row.id, input.now, input.now);
      return result.changes === 1 ? this.find(row.id) : undefined;
    });
    return claim.immediate();
  }

  find(id: string): NotificationOutboxRecord | undefined {
    const row = this.db.prepare("SELECT * FROM notification_outbox WHERE id = ?").get(id) as
      | NotificationOutboxRow
      | undefined;
    return row ? notificationOutboxFromRow(row) : undefined;
  }

  deliver(id: string, token: string, now: string): NotificationOutboxRecord {
    const result = this.db
      .prepare(
        `UPDATE notification_outbox SET state = 'delivered', claim_token = NULL, claimed_at = NULL,
           claim_expires_at = NULL, delivered_at = ?, last_error = NULL
         WHERE id = ? AND state = 'claimed' AND claim_token = ?`
      )
      .run(now, id, token);
    if (result.changes !== 1) throw new Error(`outbox claim lost: ${id}`);
    return this.find(id)!;
  }

  // Bounded retention: settled rows (delivered, or failed for good after the
  // retry budget) age out so state.sqlite stays flat under fleet activity.
  // Pending and claimed rows are live work and are never touched; the claim
  // query's per-task ordering only looks at those states, so pruning cannot
  // reorder deliveries.
  prune(cutoff: string): number {
    const result = this.db
      .prepare(
        `DELETE FROM notification_outbox
         WHERE (state = 'delivered' AND delivered_at <= ?)
            OR (state = 'failed' AND available_at <= ?)`
      )
      .run(cutoff, cutoff);
    return result.changes;
  }

  retry(input: { id: string; token: string; error: string; availableAt: string; terminal: boolean }): NotificationOutboxRecord {
    const result = this.db
      .prepare(
        `UPDATE notification_outbox SET state = ?, claim_token = NULL, claimed_at = NULL,
           claim_expires_at = NULL, available_at = ?, last_error = ?
         WHERE id = ? AND state = 'claimed' AND claim_token = ?`
      )
      .run(input.terminal ? "failed" : "pending", input.availableAt, input.error, input.id, input.token);
    if (result.changes !== 1) throw new Error(`outbox claim lost: ${input.id}`);
    return this.find(input.id)!;
  }
}

export class ClaudeApprovalRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: Omit<ClaudeApprovalRecord, "id" | "version" | "state" | "createdAt" | "updatedAt">): ClaudeApprovalRecord {
    const now = new Date().toISOString();
    const record: ClaudeApprovalRecord = {
      ...input,
      id: randomUUID(),
      version: 1,
      state: "pending",
      createdAt: now,
      updatedAt: now
    };
    this.db.prepare(
      `INSERT INTO claude_approvals(
         id, version, state, interaction_kind, hook_event_name, perch_session_id, claude_session_id, prompt_identity,
         tool_name, tool_input_json, tool_input_hash, summary, command, cwd,
         transcript_path, runtime_generation, task_id, worker_session_id,
         parent_session_id, decision_policy, expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.id,
      record.version,
      record.state,
      record.interactionKind,
      record.hookEventName,
      record.perchSessionId,
      record.claudeSessionId,
      record.promptIdentity,
      record.toolName,
      JSON.stringify(record.toolInput),
      record.toolInputHash,
      record.summary,
      record.command ?? null,
      record.cwd ?? null,
      record.transcriptPath ?? null,
      record.runtimeGeneration ?? null,
      record.taskId ?? null,
      record.workerSessionId,
      record.parentSessionId ?? null,
      record.decisionPolicy,
      record.expiresAt,
      record.createdAt,
      record.updatedAt
    );
    return record;
  }

  find(id: string): ClaudeApprovalRecord | undefined {
    const row = this.db.prepare("SELECT * FROM claude_approvals WHERE id = ?").get(id) as
      | ClaudeApprovalRow
      | undefined;
    return row ? claudeApprovalFromRow(row) : undefined;
  }

  latestForIdentity(perchSessionId: string, promptIdentity: string): ClaudeApprovalRecord | undefined {
    const row = this.db.prepare(
      `SELECT * FROM claude_approvals
       WHERE perch_session_id = ? AND prompt_identity = ?
       ORDER BY created_at DESC LIMIT 1`
    ).get(perchSessionId, promptIdentity) as ClaudeApprovalRow | undefined;
    return row ? claudeApprovalFromRow(row) : undefined;
  }

  latestForSession(perchSessionId: string): ClaudeApprovalRecord | undefined {
    const row = this.db.prepare(
      `SELECT * FROM claude_approvals WHERE perch_session_id = ? ORDER BY created_at DESC LIMIT 1`
    ).get(perchSessionId) as ClaudeApprovalRow | undefined;
    return row ? claudeApprovalFromRow(row) : undefined;
  }

  effective(): ClaudeApprovalRecord[] {
    return (this.db.prepare(
      `SELECT current.* FROM claude_approvals current
       JOIN (
         SELECT perch_session_id, max(created_at) AS created_at
         FROM claude_approvals GROUP BY perch_session_id
       ) latest
       ON latest.perch_session_id = current.perch_session_id
         AND latest.created_at = current.created_at
       ORDER BY current.created_at`
    ).all() as ClaudeApprovalRow[]).map(claudeApprovalFromRow);
  }

  decide(
    id: string,
    decision: "allow" | "deny" | "allow_always",
    decidedBy: string,
    selectedPermission?: Record<string, unknown>,
    now = new Date().toISOString()
  ): { record?: ClaudeApprovalRecord; outcome: "accepted" | "idempotent" | "conflict" | "missing" } {
    const run = this.db.transaction(() => {
      const current = this.find(id);
      if (!current) return { outcome: "missing" as const };
      if (["decided", "decision_sent"].includes(current.state) && current.decision === decision &&
          (decision !== "allow_always" || JSON.stringify(current.selectedPermission) === JSON.stringify(selectedPermission))) {
        return { record: current, outcome: "idempotent" as const };
      }
      if (current.state !== "pending") return { record: current, outcome: "conflict" as const };
      const result = this.db.prepare(
        `UPDATE claude_approvals
         SET state = 'decided', decision = ?, selected_permission_json = ?, decided_by = ?, decided_at = ?, updated_at = ?
         WHERE id = ? AND state = 'pending'`
      ).run(decision, selectedPermission ? JSON.stringify(selectedPermission) : null, decidedBy, now, now, id);
      if (result.changes !== 1) return { record: this.find(id), outcome: "conflict" as const };
      return { record: this.find(id), outcome: "accepted" as const };
    });
    return run.immediate();
  }

  transition(
    id: string,
    expected: ClaudeApprovalState | readonly ClaudeApprovalState[],
    state: ClaudeApprovalState,
    patch: { failureReason?: string; confirmedAt?: string } = {},
    now = new Date().toISOString()
  ): ClaudeApprovalRecord | undefined {
    const expectedStates = Array.isArray(expected) ? expected : [expected];
    const result = this.db.prepare(
      `UPDATE claude_approvals
       SET state = ?, failure_reason = ?, confirmed_at = ?,
           decision_sent_at = CASE WHEN ? = 'decision_sent' THEN ? ELSE decision_sent_at END,
           updated_at = ?
       WHERE id = ? AND state IN (${expectedStates.map(() => "?").join(",")})`
    ).run(
      state,
      patch.failureReason ?? null,
      patch.confirmedAt ?? null,
      state,
      now,
      now,
      id,
      ...expectedStates
    );
    return result.changes === 1 ? this.find(id) : undefined;
  }
}

export class ClaudeQuestionRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: Omit<ClaudeQuestionRecord, "id" | "version" | "state" | "createdAt" | "updatedAt">): ClaudeQuestionRecord {
    const now = new Date().toISOString();
    const record: ClaudeQuestionRecord = {
      ...input,
      id: randomUUID(),
      version: 1,
      state: "waiting",
      createdAt: now,
      updatedAt: now
    };
    this.db.prepare(
      `INSERT INTO claude_questions(
         id, version, state, perch_session_id, claude_session_id, tool_use_id,
         questions_json, questions_hash, cwd, transcript_path, runtime_generation,
         task_id, worker_session_id, parent_session_id, answer_policy, expires_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.id, record.version, record.state, record.perchSessionId, record.claudeSessionId,
      record.toolUseId, JSON.stringify(record.questions), record.questionsHash, record.cwd ?? null,
      record.transcriptPath ?? null, record.runtimeGeneration ?? null, record.taskId ?? null,
      record.workerSessionId, record.parentSessionId ?? null, record.answerPolicy,
      record.expiresAt, record.createdAt, record.updatedAt
    );
    return record;
  }

  find(id: string): ClaudeQuestionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM claude_questions WHERE id = ?").get(id) as ClaudeQuestionRow | undefined;
    return row ? claudeQuestionFromRow(row) : undefined;
  }

  findByToolUse(perchSessionId: string, toolUseId: string): ClaudeQuestionRecord | undefined {
    const row = this.db.prepare(
      "SELECT * FROM claude_questions WHERE perch_session_id = ? AND tool_use_id = ?"
    ).get(perchSessionId, toolUseId) as ClaudeQuestionRow | undefined;
    return row ? claudeQuestionFromRow(row) : undefined;
  }

  latestForSession(perchSessionId: string): ClaudeQuestionRecord | undefined {
    const row = this.db.prepare(
      "SELECT * FROM claude_questions WHERE perch_session_id = ? ORDER BY created_at DESC LIMIT 1"
    ).get(perchSessionId) as ClaudeQuestionRow | undefined;
    return row ? claudeQuestionFromRow(row) : undefined;
  }

  activeForSession(perchSessionId: string): ClaudeQuestionRecord | undefined {
    const row = this.db.prepare(
      `SELECT * FROM claude_questions
       WHERE perch_session_id = ? AND state IN ('waiting', 'answer_sent')
       ORDER BY created_at DESC LIMIT 1`
    ).get(perchSessionId) as ClaudeQuestionRow | undefined;
    return row ? claudeQuestionFromRow(row) : undefined;
  }

  effective(): ClaudeQuestionRecord[] {
    return (this.db.prepare(
      `SELECT current.* FROM claude_questions current
       JOIN (SELECT perch_session_id, max(created_at) AS created_at FROM claude_questions GROUP BY perch_session_id) latest
       ON latest.perch_session_id = current.perch_session_id AND latest.created_at = current.created_at
       ORDER BY current.created_at`
    ).all() as ClaudeQuestionRow[]).map(claudeQuestionFromRow);
  }

  answer(
    id: string,
    answers: Record<string, string>,
    answeredBy: string,
    now = new Date().toISOString()
  ): { record?: ClaudeQuestionRecord; outcome: "accepted" | "idempotent" | "conflict" | "missing" } {
    const run = this.db.transaction(() => {
      const current = this.find(id);
      if (!current) return { outcome: "missing" as const };
      if (current.state === "answer_sent" && JSON.stringify(current.answers) === JSON.stringify(answers)) {
        return { record: current, outcome: "idempotent" as const };
      }
      if (current.state !== "waiting") return { record: current, outcome: "conflict" as const };
      const result = this.db.prepare(
        `UPDATE claude_questions SET state = 'answer_sent', answers_json = ?, answered_by = ?,
           answered_at = ?, answer_sent_at = ?, updated_at = ? WHERE id = ? AND state = 'waiting'`
      ).run(JSON.stringify(answers), answeredBy, now, now, now, id);
      return result.changes === 1
        ? { record: this.find(id), outcome: "accepted" as const }
        : { record: this.find(id), outcome: "conflict" as const };
    });
    return run.immediate();
  }

  transition(
    id: string,
    expected: ClaudeQuestionState | readonly ClaudeQuestionState[],
    state: ClaudeQuestionState,
    patch: { failureReason?: string; confirmedAt?: string } = {},
    now = new Date().toISOString()
  ): ClaudeQuestionRecord | undefined {
    const expectedStates = Array.isArray(expected) ? expected : [expected];
    const result = this.db.prepare(
      `UPDATE claude_questions SET state = ?, failure_reason = ?, confirmed_at = ?, updated_at = ?
       WHERE id = ? AND state IN (${expectedStates.map(() => "?").join(",")})`
    ).run(state, patch.failureReason ?? null, patch.confirmedAt ?? null, now, id, ...expectedStates);
    return result.changes === 1 ? this.find(id) : undefined;
  }
}

export class ClaudeInteractionRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: Omit<ClaudeInteractionRecord, "id" | "version" | "createdAt" | "updatedAt">): ClaudeInteractionRecord {
    const now = new Date().toISOString();
    const record: ClaudeInteractionRecord = { ...input, id: randomUUID(), version: 1, createdAt: now, updatedAt: now };
    this.db.prepare(
      `INSERT INTO claude_interactions(
        id, version, kind, state, perch_session_id, claude_session_id, provider_request_id,
        payload_json, payload_hash, summary, runtime_generation, task_id, expires_at,
        failure_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.id, record.version, record.kind, record.state, record.perchSessionId,
      record.claudeSessionId ?? null, record.providerRequestId, JSON.stringify(record.payload),
      record.payloadHash, record.summary, record.runtimeGeneration ?? null, record.taskId ?? null,
      record.expiresAt ?? null, record.failureReason ?? null, record.createdAt, record.updatedAt
    );
    return record;
  }

  find(id: string): ClaudeInteractionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM claude_interactions WHERE id = ?").get(id) as ClaudeInteractionRow | undefined;
    return row ? claudeInteractionFromRow(row) : undefined;
  }

  findProvider(sessionId: string, kind: ClaudeInteractionRecord["kind"], providerId: string): ClaudeInteractionRecord | undefined {
    const row = this.db.prepare(
      "SELECT * FROM claude_interactions WHERE perch_session_id = ? AND kind = ? AND provider_request_id = ?"
    ).get(sessionId, kind, providerId) as ClaudeInteractionRow | undefined;
    return row ? claudeInteractionFromRow(row) : undefined;
  }

  effective(): ClaudeInteractionRecord[] {
    return (this.db.prepare(
      `SELECT current.* FROM claude_interactions current
       JOIN (SELECT perch_session_id, max(created_at) AS created_at FROM claude_interactions GROUP BY perch_session_id) latest
       ON latest.perch_session_id = current.perch_session_id AND latest.created_at = current.created_at
       ORDER BY current.created_at`
    ).all() as ClaudeInteractionRow[]).map(claudeInteractionFromRow);
  }

  respond(id: string, action: "accept" | "decline" | "cancel", content: Record<string, unknown> | undefined, actor: string, now = new Date().toISOString()) {
    const current = this.find(id);
    if (!current) return { outcome: "missing" as const };
    if (current.state === "response_sent" && current.responseAction === action && JSON.stringify(current.responseContent ?? {}) === JSON.stringify(content ?? {})) {
      return { outcome: "idempotent" as const, record: current };
    }
    if (current.state !== "waiting") return { outcome: "conflict" as const, record: current };
    const result = this.db.prepare(
      `UPDATE claude_interactions SET state = 'response_sent', response_action = ?, response_content_json = ?,
       responded_by = ?, responded_at = ?, updated_at = ? WHERE id = ? AND state = 'waiting'`
    ).run(action, content ? JSON.stringify(content) : null, actor, now, now, id);
    return result.changes === 1
      ? { outcome: "accepted" as const, record: this.find(id)! }
      : { outcome: "conflict" as const, record: this.find(id) };
  }

  transition(id: string, expected: ClaudeInteractionRecord["state"], state: ClaudeInteractionRecord["state"], reason?: string) {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      "UPDATE claude_interactions SET state = ?, failure_reason = ?, confirmed_at = ?, updated_at = ? WHERE id = ? AND state = ?"
    ).run(state, reason ?? null, state === "confirmed" ? now : null, now, id, expected);
    return result.changes === 1 ? this.find(id) : undefined;
  }
}

export class ClaudeToolOccurrenceRepository {
  constructor(private readonly db: Database.Database) {}

  record(input: Omit<ClaudeToolOccurrence, "id" | "occurrence" | "createdAt">): ClaudeToolOccurrence {
    const prior = this.db.prepare("SELECT * FROM claude_tool_occurrences WHERE perch_session_id = ? AND tool_use_id = ?")
      .get(input.perchSessionId, input.toolUseId) as ClaudeToolOccurrenceRow | undefined;
    if (prior) return claudeToolOccurrenceFromRow(prior);
    const occurrence = Number(this.db.prepare("SELECT count(*) FROM claude_tool_occurrences WHERE perch_session_id = ? AND claude_session_id = ?")
      .pluck().get(input.perchSessionId, input.claudeSessionId)) + 1;
    const record: ClaudeToolOccurrence = { ...input, id: randomUUID(), occurrence, createdAt: new Date().toISOString() };
    this.db.prepare(`INSERT INTO claude_tool_occurrences(
      id, perch_session_id, claude_session_id, tool_use_id, tool_name, tool_input_hash,
      runtime_generation, occurrence, consumed_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.perchSessionId, record.claudeSessionId, record.toolUseId, record.toolName,
        record.toolInputHash, record.runtimeGeneration ?? null, record.occurrence, record.consumedAt ?? null, record.createdAt);
    return record;
  }

  consumeMatch(input: { perchSessionId: string; claudeSessionId: string; toolName: string; toolInputHash: string; runtimeGeneration?: number }): ClaudeToolOccurrence | undefined {
    const row = this.db.prepare(`SELECT * FROM claude_tool_occurrences
      WHERE perch_session_id = ? AND claude_session_id = ? AND tool_name = ? AND tool_input_hash = ?
        AND consumed_at IS NULL AND (runtime_generation IS ? OR runtime_generation = ?)
      ORDER BY created_at DESC LIMIT 1`)
      .get(input.perchSessionId, input.claudeSessionId, input.toolName, input.toolInputHash,
        input.runtimeGeneration ?? null, input.runtimeGeneration ?? null) as ClaudeToolOccurrenceRow | undefined;
    if (!row) return undefined;
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE claude_tool_occurrences SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").run(now, row.id);
    return result.changes === 1 ? { ...claudeToolOccurrenceFromRow(row), consumedAt: now } : undefined;
  }

  nextOccurrence(perchSessionId: string, claudeSessionId: string): number {
    return Number(this.db.prepare("SELECT count(*) FROM claude_approvals WHERE perch_session_id = ? AND claude_session_id = ?").pluck().get(perchSessionId, claudeSessionId)) + 1;
  }

  prune(cutoff: string): number {
    return this.db.prepare("DELETE FROM claude_tool_occurrences WHERE created_at < ? AND consumed_at IS NOT NULL").run(cutoff).changes;
  }
}

export class ClaudeInboxRepository {
  constructor(private readonly db: Database.Database) {}
  sequence(): number { return Number(this.db.prepare("SELECT coalesce(max(seq), 0) FROM claude_inbox_deltas").pluck().get()); }
  deltas(after = 0): ClaudeInboxDelta[] {
    return (this.db.prepare("SELECT * FROM claude_inbox_deltas WHERE seq > ? ORDER BY seq").all(after) as ClaudeInboxDeltaRow[])
      .map((row) => ({ seq: row.seq, requestType: row.request_type, requestId: row.request_id, state: row.state, snapshot: JSON.parse(row.snapshot_json), at: row.at }));
  }
  prune(beforeSequence: number): number {
    return this.db.prepare("DELETE FROM claude_inbox_deltas WHERE seq < ?").run(beforeSequence).changes;
  }
}

type RuntimeRow = {
  id: string;
  task_id: string;
  generation: number;
  state: RuntimeState;
  agent: string;
  provider: string | null;
  provider_session_id: string | null;
  pty_session_id: string | null;
  process_id: number | null;
  process_started_at: string | null;
  worktree_id: string | null;
  worktree_path: string | null;
  lease_id: string | null;
  parent_session_id: string | null;
  parent_owner_id: string | null;
  worker_name: string | null;
  owner_instance_id: string | null;
  model: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
};

type OwnerRow = {
  id: string;
  role: string;
  created_at: string;
  updated_at: string;
};

type OwnerRuntimeRow = {
  id: string;
  owner_id: string;
  generation: number;
  state: RuntimeState;
  agent: string;
  provider: string;
  provider_session_id: string | null;
  pty_session_id: string | null;
  process_id: number | null;
  process_started_at: string | null;
  cwd: string;
  model: string | null;
  owner_instance_id: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
};

type OwnerOperationRow = {
  id: string;
  owner_id: string;
  kind: string;
  idempotency_key: string;
  state: OwnerOperationRecord["state"];
  generation: number;
  result_json: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type OperationRow = {
  id: string;
  task_id: string;
  kind: string;
  idempotency_key: string;
  state: OperationState;
  claim_token: string | null;
  claimed_at: string | null;
  claim_expires_at: string | null;
  attempts: number;
  last_error: string | null;
  payload_json: string | null;
  created_at: string;
  updated_at: string;
};

type NotificationOutboxRow = {
  id: string;
  task_event_id: number;
  channel: NotificationChannel;
  state: NotificationOutboxRecord["state"];
  intent_json: string;
  attempts: number;
  available_at: string;
  claimed_at: string | null;
  claim_token: string | null;
  claim_expires_at: string | null;
  delivered_at: string | null;
  last_error: string | null;
  created_at: string;
};

type ClaudeApprovalRow = {
  id: string;
  version: 1;
  state: ClaudeApprovalState;
  interaction_kind: "permission_request" | "exit_plan_mode";
  hook_event_name: "PermissionRequest" | "PreToolUse";
  perch_session_id: string;
  claude_session_id: string;
  prompt_identity: string;
  tool_name: string;
  tool_input_json: string;
  tool_input_hash: string;
  summary: string;
  command: string | null;
  cwd: string | null;
  transcript_path: string | null;
  runtime_generation: number | null;
  task_id: string | null;
  worker_session_id: string;
  parent_session_id: string | null;
  decision_policy: "boss_only";
  decision: "allow" | "deny" | "allow_always" | null;
  selected_permission_json: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_sent_at: string | null;
  confirmed_at: string | null;
  expires_at: string;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
};

type ClaudeQuestionRow = {
  id: string;
  version: 1;
  state: ClaudeQuestionState;
  perch_session_id: string;
  claude_session_id: string;
  tool_use_id: string;
  questions_json: string;
  questions_hash: string;
  answers_json: string | null;
  cwd: string | null;
  transcript_path: string | null;
  runtime_generation: number | null;
  task_id: string | null;
  worker_session_id: string;
  parent_session_id: string | null;
  answer_policy: "boss_only";
  answered_by: string | null;
  answered_at: string | null;
  answer_sent_at: string | null;
  confirmed_at: string | null;
  expires_at: string;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
};

type ClaudeInteractionRow = {
  id: string;
  version: 1;
  kind: ClaudeInteractionRecord["kind"];
  state: ClaudeInteractionRecord["state"];
  perch_session_id: string;
  claude_session_id: string | null;
  provider_request_id: string;
  payload_json: string;
  payload_hash: string;
  summary: string;
  runtime_generation: number | null;
  task_id: string | null;
  response_action: "accept" | "decline" | "cancel" | null;
  response_content_json: string | null;
  responded_by: string | null;
  responded_at: string | null;
  confirmed_at: string | null;
  expires_at: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
};

type ClaudeToolOccurrenceRow = {
  id: string; perch_session_id: string; claude_session_id: string; tool_use_id: string;
  tool_name: string; tool_input_hash: string; runtime_generation: number | null;
  occurrence: number; consumed_at: string | null; created_at: string;
};
type ClaudeInboxDeltaRow = {
  seq: number; request_type: ClaudeInboxDelta["requestType"]; request_id: string;
  state: string; snapshot_json: string; at: string;
};

function taskEventFromRow(row: TaskEventRow): TaskEvent {
  return {
    seq: row.seq,
    at: row.at,
    kind: row.kind,
    source: row.source,
    ...(row.message ? { message: row.message } : {}),
    ...(row.data_json ? { data: JSON.parse(row.data_json) as Record<string, unknown> } : {})
  };
}

function verificationFactsFromRow(row: VerificationFactsRow): TaskVerificationFacts {
  const deliverable = row.deliverable_json
    ? (JSON.parse(row.deliverable_json) as TaskDeliverable)
    : undefined;
  const acceptedDeliverable = row.accepted_deliverable_json
    ? (JSON.parse(row.accepted_deliverable_json) as { revision?: string })
    : undefined;
  return {
    requestSeq: row.request_seq,
    accepted: row.accepted === 1,
    ...(deliverable ? { deliverable } : {}),
    ...(acceptedDeliverable?.revision ? { acceptedRevision: acceptedDeliverable.revision } : {})
  };
}

function runtimeFromRow(row: RuntimeRow): RuntimeRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    generation: row.generation,
    state: row.state,
    agent: row.agent,
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.provider_session_id ? { providerSessionId: row.provider_session_id } : {}),
    ...(row.pty_session_id ? { ptySessionId: row.pty_session_id } : {}),
    ...(row.process_id !== null ? { processId: row.process_id } : {}),
    ...(row.process_started_at ? { processStartedAt: row.process_started_at } : {}),
    ...(row.worktree_id ? { worktreeId: row.worktree_id } : {}),
    ...(row.worktree_path ? { worktreePath: row.worktree_path } : {}),
    ...(row.lease_id ? { leaseId: row.lease_id } : {}),
    ...(row.parent_session_id ? { parentSessionId: row.parent_session_id } : {}),
    ...(row.parent_owner_id ? { parentOwnerId: row.parent_owner_id } : {}),
    ...(row.worker_name ? { workerName: row.worker_name } : {}),
    ...(row.owner_instance_id ? { ownerInstanceId: row.owner_instance_id } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.metadata_json ? { metadata: JSON.parse(row.metadata_json) as Record<string, unknown> } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.ended_at ? { endedAt: row.ended_at } : {})
  };
}

function ownerFromRow(row: OwnerRow): DurableOwnerRecord {
  return { id: row.id, role: row.role, createdAt: row.created_at, updatedAt: row.updated_at };
}

function ownerRuntimeFromRow(row: OwnerRuntimeRow): OwnerRuntimeRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    generation: row.generation,
    state: row.state,
    agent: row.agent,
    provider: row.provider,
    ...(row.provider_session_id ? { providerSessionId: row.provider_session_id } : {}),
    ...(row.pty_session_id ? { ptySessionId: row.pty_session_id } : {}),
    ...(row.process_id !== null ? { processId: row.process_id } : {}),
    ...(row.process_started_at ? { processStartedAt: row.process_started_at } : {}),
    cwd: row.cwd,
    ...(row.model ? { model: row.model } : {}),
    ...(row.owner_instance_id ? { ownerInstanceId: row.owner_instance_id } : {}),
    ...(row.metadata_json ? { metadata: JSON.parse(row.metadata_json) as Record<string, unknown> } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.ended_at ? { endedAt: row.ended_at } : {})
  };
}

function ownerOperationFromRow(row: OwnerOperationRow): OwnerOperationRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    generation: row.generation,
    ...(row.result_json ? { result: JSON.parse(row.result_json) as Record<string, unknown> } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function operationFromRow(row: OperationRow): OperationRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    ...(row.claim_token ? { claimToken: row.claim_token } : {}),
    ...(row.claimed_at ? { claimedAt: row.claimed_at } : {}),
    ...(row.claim_expires_at ? { claimExpiresAt: row.claim_expires_at } : {}),
    attempts: row.attempts,
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.payload_json ? { payload: JSON.parse(row.payload_json) as Record<string, unknown> } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function notificationOutboxFromRow(row: NotificationOutboxRow): NotificationOutboxRecord {
  return {
    id: row.id,
    taskEventId: row.task_event_id,
    channel: row.channel,
    state: row.state,
    payload: JSON.parse(row.intent_json) as Record<string, unknown>,
    attempts: row.attempts,
    availableAt: row.available_at,
    ...(row.claimed_at ? { claimedAt: row.claimed_at } : {}),
    ...(row.claim_token ? { claimToken: row.claim_token } : {}),
    ...(row.claim_expires_at ? { claimExpiresAt: row.claim_expires_at } : {}),
    ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at
  };
}

function claudeApprovalFromRow(row: ClaudeApprovalRow): ClaudeApprovalRecord {
  return {
    id: row.id,
    version: row.version,
    state: row.state,
    interactionKind: row.interaction_kind,
    hookEventName: row.hook_event_name,
    perchSessionId: row.perch_session_id,
    claudeSessionId: row.claude_session_id,
    promptIdentity: row.prompt_identity,
    toolName: row.tool_name,
    toolInput: JSON.parse(row.tool_input_json) as Record<string, unknown>,
    toolInputHash: row.tool_input_hash,
    summary: row.summary,
    ...(row.command ? { command: row.command } : {}),
    ...(row.cwd ? { cwd: row.cwd } : {}),
    ...(row.transcript_path ? { transcriptPath: row.transcript_path } : {}),
    ...(row.runtime_generation !== null ? { runtimeGeneration: row.runtime_generation } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    workerSessionId: row.worker_session_id,
    ...(row.parent_session_id ? { parentSessionId: row.parent_session_id } : {}),
    decisionPolicy: row.decision_policy,
    ...(row.decision ? { decision: row.decision } : {}),
    ...(row.selected_permission_json ? { selectedPermission: JSON.parse(row.selected_permission_json) as Record<string, unknown> } : {}),
    ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
    ...(row.decision_sent_at ? { decisionSentAt: row.decision_sent_at } : {}),
    ...(row.confirmed_at ? { confirmedAt: row.confirmed_at } : {}),
    expiresAt: row.expires_at,
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function claudeQuestionFromRow(row: ClaudeQuestionRow): ClaudeQuestionRecord {
  return {
    id: row.id,
    version: row.version,
    state: row.state,
    perchSessionId: row.perch_session_id,
    claudeSessionId: row.claude_session_id,
    toolUseId: row.tool_use_id,
    questions: JSON.parse(row.questions_json) as unknown[],
    questionsHash: row.questions_hash,
    ...(row.answers_json ? { answers: JSON.parse(row.answers_json) as Record<string, string> } : {}),
    ...(row.cwd ? { cwd: row.cwd } : {}),
    ...(row.transcript_path ? { transcriptPath: row.transcript_path } : {}),
    ...(row.runtime_generation !== null ? { runtimeGeneration: row.runtime_generation } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    workerSessionId: row.worker_session_id,
    ...(row.parent_session_id ? { parentSessionId: row.parent_session_id } : {}),
    answerPolicy: row.answer_policy,
    ...(row.answered_by ? { answeredBy: row.answered_by } : {}),
    ...(row.answered_at ? { answeredAt: row.answered_at } : {}),
    ...(row.answer_sent_at ? { answerSentAt: row.answer_sent_at } : {}),
    ...(row.confirmed_at ? { confirmedAt: row.confirmed_at } : {}),
    expiresAt: row.expires_at,
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function claudeInteractionFromRow(row: ClaudeInteractionRow): ClaudeInteractionRecord {
  return {
    id: row.id,
    version: row.version,
    kind: row.kind,
    state: row.state,
    perchSessionId: row.perch_session_id,
    ...(row.claude_session_id ? { claudeSessionId: row.claude_session_id } : {}),
    providerRequestId: row.provider_request_id,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    payloadHash: row.payload_hash,
    summary: row.summary,
    ...(row.runtime_generation !== null ? { runtimeGeneration: row.runtime_generation } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.response_action ? { responseAction: row.response_action } : {}),
    ...(row.response_content_json ? { responseContent: JSON.parse(row.response_content_json) as Record<string, unknown> } : {}),
    ...(row.responded_by ? { respondedBy: row.responded_by } : {}),
    ...(row.responded_at ? { respondedAt: row.responded_at } : {}),
    ...(row.confirmed_at ? { confirmedAt: row.confirmed_at } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function claudeToolOccurrenceFromRow(row: ClaudeToolOccurrenceRow): ClaudeToolOccurrence {
  return {
    id: row.id, perchSessionId: row.perch_session_id, claudeSessionId: row.claude_session_id,
    toolUseId: row.tool_use_id, toolName: row.tool_name, toolInputHash: row.tool_input_hash,
    ...(row.runtime_generation !== null ? { runtimeGeneration: row.runtime_generation } : {}),
    occurrence: row.occurrence, ...(row.consumed_at ? { consumedAt: row.consumed_at } : {}), createdAt: row.created_at
  };
}

function isImportableTask(task: Task | null | undefined, id: string): task is Task {
  return (
    Boolean(task) &&
    task!.id === id &&
    typeof task!.state === "string" &&
    typeof task!.updatedAt === "string"
  );
}

function isImportableEvent(event: TaskEvent | null | undefined): event is TaskEvent {
  return (
    Boolean(event) &&
    Number.isInteger(event!.seq) &&
    event!.seq > 0 &&
    typeof event!.at === "string" &&
    typeof event!.kind === "string" &&
    typeof event!.source === "string" &&
    (event!.message === undefined || typeof event!.message === "string")
  );
}

function readLegacyTasks(root: string): Array<{ task: Task; events: TaskEvent[] }> {
  if (!existsSync(root)) {
    return [];
  }
  const entries: Array<{ task: Task; events: TaskEvent[] }> = [];
  for (const id of readdirSync(root).sort()) {
    try {
      const task = JSON.parse(readFileSync(join(root, id, "task.json"), "utf8")) as Task;
      if (!isImportableTask(task, id)) {
        continue;
      }
      const eventsPath = join(root, id, "events.jsonl");
      const events = existsSync(eventsPath)
        ? readFileSync(eventsPath, "utf8")
            .split("\n")
            .filter((line) => line.trim())
            .flatMap((line) => {
              try {
                const event = JSON.parse(line) as TaskEvent;
                return isImportableEvent(event) ? [event] : [];
              } catch {
                return [];
              }
            })
        : [];
      entries.push({ task, events });
    } catch {
      // Preserve the old ledger's tolerant startup behavior for malformed or partial records.
    }
  }
  return entries;
}
