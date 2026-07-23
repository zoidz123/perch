import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Task, TaskEvent, TaskEventKind, TaskEventSource, TaskPr, TaskState } from "@perch/shared";
import { BOSS_EVENT_KINDS } from "./mateWake.js";
import { PUSH_EVENT_KINDS } from "./pushRouter.js";
import { StateDb, type NotificationIntentInput } from "./stateDb.js";
import { runtimeSnapshot } from "./runtimeManager.js";
import { deriveTaskPresentation, type TaskPresentationFacts } from "./taskPresentation.js";

// Ledger 1: tasks - "what work is happening". Dumb CRUD plus a server-enforced
// state machine; all policy (dispatch composition, absorb/escalate, teardown
// rules) lives in the callers. SQLite owns the current projection and immutable
// event history. The old JSON/JSONL tree is an import-only compatibility source.

const MAX_TASKS = 500;

// Deliberately small, neutral call signs: identity only, never persona. The
// first free name is deterministic across restarts because reservations live
// on non-closed task records. Closed work releases its name for reuse.
const WORKER_NAMES = [
  "Alder",
  "Birch",
  "Cedar",
  "Cove",
  "Dune",
  "Ember",
  "Fern",
  "Flint",
  "Gale",
  "Grove",
  "Harbor",
  "Iris",
  "Jade",
  "Kite",
  "Lark",
  "Maple",
  "Moss",
  "Nova",
  "Oak",
  "Pine",
  "Reed",
  "Ridge",
  "Sage",
  "Slate",
  "Stone",
  "Vale",
  "Wren"
] as const;

// Which event kinds move the task to which state. Events not listed here
// (note, created) leave the state alone.
const EVENT_STATE: Partial<Record<TaskEventKind, TaskState>> = {
  working: "working",
  needs_decision: "needs_you",
  blocked: "blocked",
  completion_requested: "completion_requested",
  completion_accepted: "done",
  completion_rejected: "working",
  done: "done",
  failed: "failed",
  merged: "landed",
  landed: "landed",
  closed: "closed"
};

// Legal transitions: forward through the lifecycle, with needs_you/blocked as
// detours that resume via working. `failed` is reachable from any live state;
// nothing leaves closed.
const TRANSITIONS: Record<TaskState, TaskState[]> = {
  queued: ["working", "needs_you", "blocked", "completion_requested", "done", "failed"],
  working: ["working", "needs_you", "blocked", "completion_requested", "done", "failed"],
  needs_you: ["working", "needs_you", "blocked", "completion_requested", "done", "failed"],
  blocked: ["working", "needs_you", "blocked", "completion_requested", "done", "failed"],
  completion_requested: ["working", "done", "failed"],
  done: ["landed", "failed", "closed"],
  landed: ["closed", "failed"],
  failed: ["working", "closed"],
  closed: []
};

export type NewTask = {
  title: string;
  project: string;
  prompt?: string;
  kind?: Task["kind"];
  mode?: Task["mode"];
  // The finalized plan this task builds from (task <-> plan linkage). Stored
  // verbatim so `listByPlan` can find a plan's in-flight work deterministically.
  planId?: string;
};

export type TaskEventListener = (
  task: Task,
  // previousState is the state before this event's transition (equal to
  // task.state when the event moved nothing), so observers can meter edges.
  event: {
    kind: TaskEventKind;
    message?: string;
    source: TaskEventSource;
    data?: Record<string, unknown>;
    previousState: TaskState;
  }
) => void;

export class TaskStore {
  private readonly root: string;
  private readonly listeners: TaskEventListener[] = [];
  readonly stateDb: StateDb;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.root = join(env.PERCH_HOME ?? join(homedir(), ".perch"), "tasks");
    this.stateDb = new StateDb(env);
  }

  close(): void {
    this.stateDb.close();
  }

  // Observe recorded events (push policy, crew broadcasting). Fired after the
  // event is durably appended.
  subscribe(listener: TaskEventListener): void {
    this.listeners.push(listener);
  }

  create(input: NewTask): Task {
    if (!input.title?.trim()) {
      throw new Error("task title is required");
    }
    if (!input.project?.trim()) {
      throw new Error("task project is required");
    }
    if (this.stateDb.tasks.countOpen() >= MAX_TASKS) {
      throw new Error(`task store is full (${MAX_TASKS} open tasks); close some first`);
    }
    const now = new Date().toISOString();
    // The random id suffix can collide (1/65536 per same-slug pair); regenerate
    // it on a primary-key conflict instead of failing the request.
    for (let attempt = 0; ; attempt += 1) {
      const task: Task = {
        id: taskId(input.title),
        title: input.title.trim(),
        project: input.project,
        kind: input.kind ?? "ship",
        mode: input.mode ?? "direct-PR",
        state: "queued",
        ...(input.prompt ? { prompt: input.prompt } : {}),
        ...(input.planId ? { planId: input.planId } : {}),
        createdAt: now,
        updatedAt: now
      };
      try {
        this.stateDb.tasks.create(task, { kind: "created", source: "system", message: task.title });
        return task;
      } catch (error) {
        if (attempt >= 4 || !isTaskIdCollision(error)) {
          throw error;
        }
      }
    }
  }

  list(): Task[] {
    const runtimes = this.stateDb.runtimes.latestByTask();
    const prFacts = this.stateDb.tasks.prFactsByTask();
    const verifications = this.stateDb.tasks.verificationFactsByTask();
    const reviews = this.stateDb.tasks.reviewFactsByTask();
    return this.stateDb.tasks.list().map((task) => {
      const runtime = runtimes.get(task.id);
      return this.withPresentation(runtime ? { ...task, runtime: runtimeSnapshot(runtime) } : task, {
        pr: prFacts.get(task.id),
        verification: verifications.get(task.id),
        review: reviews.get(task.id)
      });
    });
  }

  find(id: string): Task | undefined {
    try {
      const task = this.stateDb.tasks.find(safeId(id));
      return task ? this.withPresentation(this.withRuntime(task)) : undefined;
    } catch {
      return undefined;
    }
  }

  // Claim once, immediately before dispatch. This synchronous ledger write is
  // the allocation lock: concurrent dispatches cannot observe the same free
  // name, and a restart reads the persisted claim instead of renaming work.
  claimWorkerName(id: string): Task {
    const task = this.mustFind(id);
    if (task.workerName) {
      return { ...task };
    }
    const reserved = new Set(
      this.list()
        .filter((candidate) => candidate.state !== "closed")
        .map((candidate) => candidate.workerName)
        .filter((name): name is string => Boolean(name))
    );
    task.workerName = WORKER_NAMES.find((name) => !reserved.has(name)) ?? numberedWorkerName(reserved);
    task.updatedAt = nextTimestamp(task.updatedAt);
    this.stateDb.tasks.save(withoutDerived(task));
    return this.withPresentation({ ...task });
  }

  // Upgrade only old, still-open records that already own a worker session.
  // Each claim is a normal projection save; event history and closed records
  // are never rewritten.
  claimLegacyActiveWorkerNames(): Task[] {
    const claimed: Task[] = [];
    for (const task of this.list()) {
      if (task.state !== "closed" && task.sessionId && !task.workerName) {
        claimed.push(this.claimWorkerName(task.id));
      }
    }
    return claimed;
  }

  // Every task stamped with this plan (task <-> plan linkage): the deterministic
  // lookup a plan edit uses to find its affected in-flight work instead of
  // guessing. Recency-sorted, like
  // `list`. An empty/absent planId matches nothing.
  listByPlan(planId: string): Task[] {
    if (!planId) {
      return [];
    }
    return this.list().filter((task) => task.planId === planId);
  }

  // Stage a plan-edit's proposed markdown centrally under the task's own dir
  // (~/.perch/tasks/<id>/), NEVER in a project repo - the server never writes
  // to a repo. The dispatched worker reads this file and commits it to the
  // plan's docs/plans/ path itself. Returns the staged file's absolute path.
  stagePlanEdit(id: string, content: string): string {
    const dir = join(this.root, safeId(id));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "plan-edit.md");
    writeFileSync(path, content, { mode: 0o600 });
    return path;
  }

  // Merge partial fields (session/worktree linkage, pr, branch) without
  // touching the state machine.
  update(id: string, fields: Partial<Omit<Task, "id" | "state" | "createdAt">>): Task {
    const task = this.mustFind(id);
    Object.assign(task, fields);
    task.updatedAt = nextTimestamp(task.updatedAt);
    this.stateDb.tasks.save(withoutDerived(task));
    return this.withPresentation({ ...task });
  }

  // Attach the stable PR identity and its ledger receipt in one SQLite
  // transaction. A link is evidence only: it never moves the task lifecycle.
  // Replaying the same report refreshes mutable observations without another
  // receipt; replacing a different task PR is refused.
  linkPr(
    id: string,
    pr: TaskPr,
    event: { message?: string; source: TaskEventSource; data?: Record<string, unknown> }
  ): { task: Task; linked: boolean } {
    const task = this.mustFind(id);
    if (task.pr) {
      if (!samePrIdentity(task.pr, pr)) {
        throw new Error(`task is already linked to ${task.pr.url}`);
      }
      const refreshed = { ...task.pr, ...pr };
      if (prObservationChanged(task.pr, refreshed)) {
        task.pr = refreshed;
        task.updatedAt = nextTimestamp(task.updatedAt);
        this.stateDb.tasks.save(withoutDerived(task));
      }
      return { task: this.withPresentation({ ...task }), linked: false };
    }

    const previousState = task.state;
    task.pr = { ...pr };
    task.updatedAt = nextTimestamp(task.updatedAt);
    const linkedEvent = { kind: "pr_linked" as const, ...event };
    const notificationIntents = taskEventNotificationIntents(task, linkedEvent);
    this.stateDb.tasks.record(withoutDerived(task), linkedEvent, notificationIntents);
    const updated = this.withPresentation({ ...task });
    for (const listener of this.listeners) {
      try {
        listener({ ...updated }, { ...linkedEvent, previousState });
      } catch {
        // Observers never disturb the ledger.
      }
    }
    return { task: updated, linked: true };
  }

  // Append an event; when the event kind implies a state, the transition is
  // validated against the state machine (illegal ones throw, nothing is
  // written). Returns the updated task.
  recordEvent(
    id: string,
    event: { kind: TaskEventKind; message?: string; source: TaskEventSource; data?: Record<string, unknown> },
    options: { notificationIntents?: NotificationIntentInput[] } = {}
  ): Task {
    const task = this.mustFind(id);
    const previousState = task.state;
    const next = EVENT_STATE[event.kind];
    if (task.state === "completion_requested" && event.kind === "working") {
      throw new Error("illegal transition: completion_requested -> working requires completion_rejected");
    }
    if (next && next !== task.state) {
      if (!TRANSITIONS[task.state].includes(next)) {
        throw new Error(`illegal transition: ${task.state} -> ${next} (via ${event.kind})`);
      }
      task.state = next;
    }
    task.updatedAt = nextTimestamp(task.updatedAt);
    const notificationIntents = options.notificationIntents ?? taskEventNotificationIntents(task, event);
    this.stateDb.tasks.record(withoutDerived(task), event, notificationIntents);
    // Derive after the append so listeners observe the presentation this event
    // produced, never the one it replaced.
    const updated = this.withPresentation({ ...task });
    for (const listener of this.listeners) {
      try {
        listener({ ...updated }, { ...event, previousState });
      } catch {
        // Observers never disturb the ledger.
      }
    }
    return updated;
  }

  // Append a causally-linked event group in one SQLite transaction. Used when
  // runtime evidence and its boss-visible receipt must either both survive a
  // crash or neither become visible.
  recordEvents(
    id: string,
    entries: Array<{
      event: { kind: TaskEventKind; message?: string; source: TaskEventSource; data?: Record<string, unknown> };
      notificationIntents?: NotificationIntentInput[];
    }>
  ): Task {
    if (entries.length === 0) return this.withPresentation(this.mustFind(id));
    const task = this.mustFind(id);
    const notifications: Array<{ task: Task; event: (typeof entries)[number]["event"]; previousState: TaskState }> = [];
    const persisted = entries.map(({ event, notificationIntents }) => {
      const previousState = task.state;
      const next = EVENT_STATE[event.kind];
      if (task.state === "completion_requested" && event.kind === "working") {
        throw new Error("illegal transition: completion_requested -> working requires completion_rejected");
      }
      if (next && next !== task.state) {
        if (!TRANSITIONS[task.state].includes(next)) {
          throw new Error(`illegal transition: ${task.state} -> ${next} (via ${event.kind})`);
        }
        task.state = next;
      }
      task.updatedAt = nextTimestamp(task.updatedAt);
      notifications.push({ task: { ...task }, event, previousState });
      return {
        event,
        intents: notificationIntents ?? taskEventNotificationIntents(task, event)
      };
    });
    this.stateDb.tasks.recordMany(withoutDerived(task), persisted);
    // Same listener contract as recordEvent: every notification snapshot
    // carries a derived presentation, computed from the committed facts once
    // for the whole batch.
    const facts: TaskPresentationFacts = {
      pr: this.stateDb.tasks.prFacts(task.id),
      verification: this.stateDb.tasks.verificationFacts(task.id),
      review: this.stateDb.tasks.reviewFacts(task.id)
    };
    for (const notification of notifications) {
      for (const listener of this.listeners) {
        try {
          listener(this.withPresentation(notification.task, facts), {
            ...notification.event,
            previousState: notification.previousState
          });
        } catch {
          // Observers never disturb the ledger.
        }
      }
    }
    return this.withPresentation({ ...task }, facts);
  }

  private withRuntime(task: Task): Task {
    const runtime = this.stateDb.runtimes.latestForTask(task.id);
    return runtime ? { ...task, runtime: runtimeSnapshot(runtime) } : task;
  }

  private withPresentation(task: Task, facts?: TaskPresentationFacts): Task {
    const { presentation: _presentation, ...persisted } = task;
    const resolved = facts ?? {
      pr: this.stateDb.tasks.prFacts(task.id),
      verification: this.stateDb.tasks.verificationFacts(task.id),
      review: this.stateDb.tasks.reviewFacts(task.id)
    };
    return { ...persisted, presentation: deriveTaskPresentation(persisted, resolved) };
  }

  events(id: string): TaskEvent[] {
    try {
      return this.stateDb.tasks.events(safeId(id));
    } catch {
      return [];
    }
  }

  // Epoch ms of the worker verb that parked this task, or undefined when its
  // current needs_you/blocked state is not worker-authored. The latest
  // state-moving event of ANY source speaks for the park: a trailing `note`
  // (or any other state-preserving kind) neither confirms nor surrenders it,
  // while a later state transition - a resume, a system re-park - supersedes
  // an older worker park, so system-authored stale states stay recoverable
  // from PR proof.
  workerParkedAt(task: Task): number | undefined {
    const expected =
      task.state === "needs_you" ? "needs_decision" : task.state === "blocked" ? "blocked" : undefined;
    if (!expected) return undefined;
    const events = this.events(task.id);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!;
      if (EVENT_STATE[event.kind] === undefined) {
        continue;
      }
      return event.source === "worker" && event.kind === expected ? Date.parse(event.at) : undefined;
    }
    return undefined;
  }

  // Writers mutate and persist this snapshot. It reads the raw projection
  // (which never stores a presentation) so write paths do not spend fact
  // queries deriving a presentation they immediately discard.
  private mustFind(id: string): Task {
    let task: Task | undefined;
    try {
      task = this.stateDb.tasks.find(safeId(id));
    } catch {
      task = undefined;
    }
    if (!task) {
      throw new Error(`Unknown task: ${id}`);
    }
    return this.withRuntime(task);
  }
}

// Only kinds a channel actually delivers become outbox rows; events both
// channels absorb at delivery time (notes, created, heartbeat-adjacent kinds)
// would otherwise accumulate as dead pending work.
function taskEventNotificationIntents(
  task: Task,
  event: { kind: TaskEventKind; message?: string; source: TaskEventSource; data?: Record<string, unknown> }
): NotificationIntentInput[] {
  const payload = { task: { ...task }, event: { ...event } };
  const intents: NotificationIntentInput[] = [];
  if (BOSS_EVENT_KINDS.has(event.kind)) {
    intents.push({ channel: "mate", payload });
  }
  if (PUSH_EVENT_KINDS.has(event.kind)) {
    intents.push({ channel: "push", payload });
  }
  return intents;
}

function samePrIdentity(existing: TaskPr, incoming: TaskPr): boolean {
  return (
    existing.url === incoming.url &&
    optionalIdentityFieldMatches(existing.number, incoming.number) &&
    optionalIdentityFieldMatches(existing.repo, incoming.repo) &&
    optionalIdentityFieldMatches(existing.headRepo, incoming.headRepo) &&
    optionalIdentityFieldMatches(existing.head, incoming.head)
  );
}

function optionalIdentityFieldMatches<T>(existing: T | undefined, incoming: T | undefined): boolean {
  return existing === undefined || incoming === undefined || existing === incoming;
}

function prObservationChanged(existing: TaskPr, incoming: TaskPr): boolean {
  return Object.entries(incoming).some(
    ([key, value]) => existing[key as keyof TaskPr] !== value
  );
}

// "fix the flaky auth test" -> "fix-the-flaky-auth-a1b2" - readable slug plus
// a short random suffix for uniqueness.
function taskId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 4)
    .join("-");
  return `${slug || "task"}-${randomBytes(2).toString("hex")}`;
}

function isTaskIdCollision(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY"
  );
}

// Task ids become directory names; refuse anything path-shaped.
function safeId(id: string): string {
  const base = basename(id);
  if (base !== id || id.includes("..")) {
    throw new Error(`Invalid task id: ${id}`);
  }
  return id;
}

function numberedWorkerName(reserved: Set<string>): string {
  for (let number = 1; ; number += 1) {
    const candidate = `Worker ${number}`;
    if (!reserved.has(candidate)) {
      return candidate;
    }
  }
}

function nextTimestamp(previous: string): string {
  const now = Date.now();
  const prior = Date.parse(previous);
  return new Date(Number.isNaN(prior) ? now : Math.max(now, prior + 1)).toISOString();
}

function withoutDerived(task: Task): Task {
  const { runtime: _runtime, presentation: _presentation, ...persisted } = task;
  return persisted;
}
