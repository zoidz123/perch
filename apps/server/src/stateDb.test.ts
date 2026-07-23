import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Task, TaskEvent } from "@perch/shared";
import Database from "better-sqlite3";
import { StateDb } from "./stateDb.js";
import { TaskStore } from "./tasks.js";

function home(): string {
  return mkdtempSync(join(tmpdir(), "perch-state-"));
}

function env(root: string): NodeJS.ProcessEnv {
  return { PERCH_HOME: root } as NodeJS.ProcessEnv;
}

test("fresh startup creates the versioned WAL database with foreign keys enabled", () => {
  const root = home();
  const state = new StateDb(env(root));

  assert.equal(state.path, join(root, "state.sqlite"));
  assert.equal(existsSync(state.path), true);
  assert.equal(state.schemaVersion(), 13);
  assert.equal(state.journalMode(), "wal");
  assert.equal(state.foreignKeysEnabled(), true);

  const inspect = new Database(state.path, { readonly: true });
  assert.deepEqual(inspect.prepare("SELECT version, name FROM schema_migrations").all(), [
    { version: 1, name: "shared-state-core" },
    { version: 2, name: "durable-executor-claims" },
    { version: 3, name: "authoritative-runtime-lifecycle" },
    { version: 4, name: "durable-mate-owner" },
    { version: 5, name: "durable-claude-approvals" },
    { version: 6, name: "durable-claude-questions" },
    { version: 7, name: "typed-claude-approval-kinds" },
    { version: 8, name: "durable-claude-blocking-interactions" },
    { version: 9, name: "claude-inbox-correlation-and-deltas" },
    { version: 10, name: "separate-task-pr-and-verification-facts" },
    { version: 11, name: "task-review-facts" },
    { version: 12, name: "durable-prompt-deliveries" },
    { version: 13, name: "distinguish-unsubmitted-prompts" }
  ]);
  assert.deepEqual(
    inspect
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .pluck()
      .all(),
    [
      "claude_approvals",
      "claude_inbox_deltas",
      "claude_interactions",
      "claude_questions",
      "claude_tool_occurrences",
      "durable_owners",
      "legacy_imports",
      "notification_outbox",
      "operations",
      "owner_operations",
      "owner_runtimes",
      "prompt_deliveries",
      "runtimes",
      "schema_migrations",
      "task_events",
      "task_pr_facts",
      "task_review_facts",
      "task_verification_facts",
      "tasks"
    ]
  );

  inspect.close();
  state.close();
  rmSync(root, { recursive: true, force: true });
});

test("version 13 migrates an earlier prompt delivery schema without losing rows", () => {
  const root = home();
  const current = new StateDb(env(root));
  current.close();

  const legacy = new Database(join(root, "state.sqlite"));
  legacy.exec(`
    DROP INDEX prompt_deliveries_session_state_idx;
    DROP INDEX prompt_deliveries_task_idx;
    ALTER TABLE prompt_deliveries RENAME TO prompt_deliveries_current;
    CREATE TABLE prompt_deliveries (
      id TEXT PRIMARY KEY,
      perch_session_id TEXT NOT NULL,
      runtime_generation INTEGER,
      task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
      source TEXT NOT NULL CHECK (source IN ('human', 'agent')),
      state TEXT NOT NULL CHECK (state IN ('queued', 'typing', 'submitted', 'accepted', 'delivery_unknown')),
      prompt_text TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      receipt_kind TEXT CHECK (receipt_kind IN ('user_prompt_submit', 'transcript')),
      receipt_id TEXT,
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      typing_at TEXT,
      submitted_at TEXT,
      accepted_at TEXT,
      unknown_at TEXT,
      unknown_from_state TEXT CHECK (unknown_from_state IN ('queued', 'typing', 'submitted')),
      unknown_notified_at TEXT,
      updated_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO prompt_deliveries(
      id, perch_session_id, source, state, prompt_text, prompt_hash, failure_reason,
      created_at, typing_at, submitted_at, unknown_at, unknown_from_state,
      unknown_notified_at, updated_at
    ) VALUES (
      'legacy-delivery', 'pty:legacy', 'agent', 'delivery_unknown', 'Legacy prompt',
      'legacy-hash', 'receipt timeout', '2026-07-23T00:00:00.000Z',
      '2026-07-23T00:00:01.000Z', '2026-07-23T00:00:02.000Z',
      '2026-07-23T00:00:03.000Z', 'submitted', '2026-07-23T00:00:04.000Z',
      '2026-07-23T00:00:04.000Z'
    );
    DROP TABLE prompt_deliveries_current;
    CREATE INDEX prompt_deliveries_session_state_idx
      ON prompt_deliveries(perch_session_id, state, created_at);
    CREATE INDEX prompt_deliveries_task_idx
      ON prompt_deliveries(task_id, created_at);
    DELETE FROM schema_migrations WHERE version = 13;
    PRAGMA user_version = 12;
  `);
  legacy.close();

  const migrated = new StateDb(env(root));
  assert.equal(migrated.schemaVersion(), 13);
  assert.deepEqual(migrated.promptDeliveries.find("legacy-delivery"), {
    id: "legacy-delivery",
    perchSessionId: "pty:legacy",
    source: "agent",
    state: "delivery_unknown",
    promptText: "Legacy prompt",
    promptHash: "legacy-hash",
    failureReason: "receipt timeout",
    createdAt: "2026-07-23T00:00:00.000Z",
    typingAt: "2026-07-23T00:00:01.000Z",
    submittedAt: "2026-07-23T00:00:02.000Z",
    unknownAt: "2026-07-23T00:00:03.000Z",
    unknownFromState: "submitted",
    unknownNotifiedAt: "2026-07-23T00:00:04.000Z",
    updatedAt: "2026-07-23T00:00:04.000Z"
  });
  migrated.close();
  rmSync(root, { recursive: true, force: true });
});

test("legacy JSON and JSONL import idempotently at each startup without modifying the source", () => {
  const root = home();
  const task: Task = {
    id: "legacy-task-abcd",
    title: "Legacy task",
    project: "/tmp/repo",
    kind: "ship",
    mode: "direct-PR",
    state: "working",
    sessionId: "pty:legacy",
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:01:00.000Z"
  };
  const events: TaskEvent[] = [
    {
      seq: 1,
      at: "2026-07-01T10:00:00.000Z",
      kind: "created",
      source: "system",
      message: "Legacy task"
    },
    {
      seq: 2,
      at: "2026-07-01T10:01:00.000Z",
      kind: "working",
      source: "worker",
      data: { phase: "implement" }
    }
  ];
  const dir = join(root, "tasks", task.id);
  mkdirSync(dir, { recursive: true });
  const taskSource = `${JSON.stringify(task, null, 2)}\n`;
  const eventSource = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  writeFileSync(join(dir, "task.json"), taskSource);
  writeFileSync(join(dir, "events.jsonl"), eventSource);

  const first = new TaskStore(env(root));
  assert.deepEqual(first.find(task.id), { ...task, presentation: { state: "working" } });
  assert.deepEqual(first.events(task.id), events);
  assert.equal(first.stateDb.outbox.pending().length, 0, "historical events are not replayed as notifications");
  assert.equal(readFileSync(join(dir, "task.json"), "utf8"), taskSource);
  assert.equal(readFileSync(join(dir, "events.jsonl"), "utf8"), eventSource);
  first.close();

  const second = new TaskStore(env(root));
  assert.equal(second.list().length, 1);
  assert.deepEqual(second.events(task.id), events);
  const repeated = second.stateDb.importLegacyTasks(join(root, "tasks"));
  assert.deepEqual(repeated, { imported: false, tasks: 0, events: 0 });
  assert.equal(readFileSync(join(dir, "task.json"), "utf8"), taskSource);
  assert.equal(readFileSync(join(dir, "events.jsonl"), "utf8"), eventSource);
  second.close();

  const late: Task = {
    ...task,
    id: "late-task-ef01",
    title: "Late legacy task"
  };
  const lateDir = join(root, "tasks", late.id);
  mkdirSync(lateDir, { recursive: true });
  writeFileSync(join(lateDir, "task.json"), JSON.stringify(late));

  const third = new TaskStore(env(root));
  assert.equal(third.list().length, 2);
  assert.deepEqual(third.find(late.id), { ...late, presentation: { state: "working" } });
  assert.deepEqual(third.events(task.id), events);

  third.close();
  rmSync(root, { recursive: true, force: true });
});

test("malformed legacy records are skipped without aborting the import", () => {
  const root = home();
  const good: Task = {
    id: "good-task-abcd",
    title: "Good task",
    project: "/tmp/repo",
    kind: "ship",
    mode: "direct-PR",
    state: "working",
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:01:00.000Z"
  };
  const goodDir = join(root, "tasks", good.id);
  mkdirSync(goodDir, { recursive: true });
  writeFileSync(join(goodDir, "task.json"), JSON.stringify(good));
  writeFileSync(
    join(goodDir, "events.jsonl"),
    [
      JSON.stringify({ seq: 1, at: "2026-07-01T10:00:00.000Z", kind: "created", source: "system" }),
      JSON.stringify({ seq: 2, kind: "working", source: "worker" }),
      "not json at all",
      JSON.stringify({ seq: 3, at: "2026-07-01T10:01:00.000Z", kind: "working", source: "worker" }),
      ""
    ].join("\n")
  );

  const missingFieldsDir = join(root, "tasks", "missing-fields-abcd");
  mkdirSync(missingFieldsDir, { recursive: true });
  writeFileSync(join(missingFieldsDir, "task.json"), JSON.stringify({ id: "missing-fields-abcd", title: "no state" }));

  const unparseableDir = join(root, "tasks", "unparseable-abcd");
  mkdirSync(unparseableDir, { recursive: true });
  writeFileSync(join(unparseableDir, "task.json"), "{ definitely not json");

  const first = new TaskStore(env(root));
  assert.deepEqual(first.find(good.id), { ...good, presentation: { state: "working" } });
  assert.deepEqual(
    first.events(good.id).map((event) => event.seq),
    [1, 3]
  );
  assert.equal(first.list().length, 1);
  first.close();

  const second = new TaskStore(env(root));
  assert.equal(second.list().length, 1);
  assert.deepEqual(second.stateDb.importLegacyTasks(join(root, "tasks")), { imported: false, tasks: 0, events: 0 });
  second.close();
  rmSync(root, { recursive: true, force: true });
});

test("task projection, immutable event, and outbox intents commit or roll back together", () => {
  const root = home();
  const tasks = new TaskStore(env(root));
  const task = tasks.create({ title: "Atomic task event", project: "/tmp/repo" });
  let observed = 0;
  tasks.subscribe(() => {
    observed += 1;
  });

  assert.throws(
    () =>
      tasks.recordEvent(
        task.id,
        { kind: "working", source: "worker", message: "starting" },
        {
          notificationIntents: [
            {
              channel: "invalid" as "push",
              payload: { taskId: task.id }
            }
          ]
        }
      ),
    /CHECK constraint failed/
  );
  assert.equal(tasks.find(task.id)?.state, "queued");
  assert.equal(tasks.events(task.id).length, 1);
  assert.equal(tasks.stateDb.outbox.pending().length, 0);
  assert.equal(observed, 0);

  const updated = tasks.recordEvent(
    task.id,
    { kind: "working", source: "worker", message: "starting" },
    {
      notificationIntents: [
        { channel: "mate", payload: { taskId: task.id, kind: "working" } },
        { channel: "push", payload: { taskId: task.id, kind: "working" } }
      ]
    }
  );
  assert.equal(updated.state, "working");
  const committedEvent = tasks.events(task.id).at(-1)!;
  assert.equal(committedEvent.seq, 2);
  assert.deepEqual(
    tasks.stateDb.outbox.forTaskEvent(task.id, committedEvent.seq).map((intent) => intent.channel),
    ["mate", "push"]
  );
  assert.equal(observed, 1);

  const inspect = new Database(tasks.stateDb.path);
  assert.throws(() => inspect.prepare("UPDATE task_events SET message = 'changed' WHERE task_id = ?").run(task.id), /immutable/);
  assert.throws(() => inspect.prepare("DELETE FROM task_events WHERE task_id = ?").run(task.id), /immutable/);
  inspect.close();

  tasks.close();
  rmSync(root, { recursive: true, force: true });
});

test("causally-linked task event groups and their wake intents commit atomically", () => {
  const root = home();
  const tasks = new TaskStore(env(root));
  const task = tasks.create({ title: "Atomic turn receipt", project: "/tmp/repo" });

  assert.throws(
    () =>
      tasks.recordEvents(task.id, [
        { event: { kind: "turn_completed", source: "hook", data: { retryNeeded: true } } },
        {
          event: { kind: "stalled", source: "system", message: "retry needed" },
          notificationIntents: [{ channel: "invalid" as "mate", payload: { taskId: task.id } }]
        }
      ]),
    /CHECK constraint failed/
  );
  assert.deepEqual(tasks.events(task.id).map((event) => event.kind), ["created"]);
  assert.equal(tasks.stateDb.outbox.pending().length, 0);

  tasks.recordEvents(task.id, [
    { event: { kind: "turn_completed", source: "hook", data: { retryNeeded: true } } },
    { event: { kind: "stalled", source: "system", message: "retry needed" } }
  ]);
  assert.deepEqual(tasks.events(task.id).map((event) => event.kind), ["created", "turn_completed", "stalled"]);
  assert.deepEqual(
    tasks.stateDb.outbox.forTaskEvent(task.id, 3).map((intent) => intent.channel),
    ["mate"]
  );

  tasks.close();
  rmSync(root, { recursive: true, force: true });
});

test("task API state plus runtime and idempotent operation repositories persist across restart", () => {
  const root = home();
  const first = new TaskStore(env(root));
  const task = first.create({ title: "Persistent task", project: "/tmp/repo", mode: "no-mistakes" });
  first.update(task.id, { branch: "perch/persistent-task", sessionId: "pty:first" });
  first.recordEvent(task.id, { kind: "working", source: "system" });

  const runtime = first.stateDb.runtimes.create({
    taskId: task.id,
    generation: 0,
    state: "live",
    agent: "codex",
    providerSessionId: "thread-123",
    ptySessionId: "pty:first",
    metadata: { source: "dispatch" }
  });
  const operation = first.stateDb.operations.create({
    taskId: task.id,
    kind: "dispatch",
    idempotencyKey: "dispatch:request-123",
    payload: { prompt: "ship it" }
  });
  assert.equal(
    first.stateDb.operations.create({
      taskId: task.id,
      kind: "dispatch",
      idempotencyKey: "dispatch:request-123",
      payload: { prompt: "ignored duplicate" }
    }).id,
    operation.id
  );
  first.close();

  const restarted = new TaskStore(env(root));
  assert.equal(restarted.find(task.id)?.branch, "perch/persistent-task");
  assert.equal(restarted.find(task.id)?.state, "working");
  assert.deepEqual(
    restarted.events(task.id).map((event) => event.kind),
    ["created", "working"]
  );
  assert.equal(restarted.stateDb.runtimes.latestForTask(task.id)?.id, runtime.id);
  assert.equal(restarted.stateDb.runtimes.latestForTask(task.id)?.providerSessionId, "thread-123");
  assert.equal(restarted.stateDb.operations.findByIdempotencyKey("dispatch:request-123")?.id, operation.id);

  restarted.close();
  rmSync(root, { recursive: true, force: true });
});
