import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TaskStore } from "./tasks.js";

function store(): { store: TaskStore; home: string } {
  const home = mkdtempSync(join(tmpdir(), "perch-tasks-"));
  return { store: new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv), home };
}

test("task lifecycle: create, verbs advance state, events append", () => {
  const { store: tasks, home } = store();

  const task = tasks.create({ title: "Fix the flaky auth test", project: "/tmp/repo" });
  assert.match(task.id, /^fix-the-flaky-auth-[0-9a-f]{4}$/);
  assert.equal(task.state, "queued");
  assert.equal(task.kind, "ship");
  assert.equal(task.mode, "direct-PR");

  tasks.recordEvent(task.id, { kind: "working", source: "worker", message: "reproducing" });
  tasks.recordEvent(task.id, { kind: "needs_decision", source: "worker", message: "two fixes possible" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  const done = tasks.recordEvent(task.id, {
    kind: "done",
    source: "worker",
    message: "PR https://github.com/o/r/pull/7"
  });
  assert.equal(done.state, "done");

  const merged = tasks.recordEvent(task.id, { kind: "merged", source: "poller" });
  assert.equal(merged.state, "landed");
  const closed = tasks.recordEvent(task.id, { kind: "closed", source: "system" });
  assert.equal(closed.state, "closed");

  const events = tasks.events(task.id);
  assert.equal(events[0]?.kind, "created");
  assert.deepEqual(
    events.map((event) => event.seq),
    [1, 2, 3, 4, 5, 6, 7]
  );

  rmSync(home, { recursive: true, force: true });
});

test("illegal transitions are rejected and write nothing", () => {
  const { store: tasks, home } = store();
  const task = tasks.create({ title: "scout the cache layer", project: "/tmp/repo", kind: "scout" });

  // queued cannot jump straight to landed or closed.
  assert.throws(() => tasks.recordEvent(task.id, { kind: "merged", source: "poller" }), /illegal transition/);
  assert.throws(() => tasks.recordEvent(task.id, { kind: "closed", source: "system" }), /illegal transition/);
  assert.equal(tasks.find(task.id)?.state, "queued");
  // The rejected events never hit the log.
  assert.equal(tasks.events(task.id).length, 1);

  // closed is terminal.
  tasks.recordEvent(task.id, { kind: "failed", source: "worker" });
  tasks.recordEvent(task.id, { kind: "closed", source: "system" });
  assert.throws(() => tasks.recordEvent(task.id, { kind: "working", source: "worker" }), /illegal transition/);

  rmSync(home, { recursive: true, force: true });
});

test("update merges linkage fields without touching state", () => {
  const { store: tasks, home } = store();
  const task = tasks.create({ title: "add version flag", project: "/tmp/repo" });

  const updated = tasks.update(task.id, {
    sessionId: "pty:abc",
    worktreeId: "wt:repo/1",
    branch: "perch/add-version-flag",
    pr: { url: "https://github.com/o/r/pull/9", checks: "pending" }
  });
  assert.equal(updated.sessionId, "pty:abc");
  assert.equal(updated.state, "queued");
  assert.equal(tasks.find(task.id)?.pr?.url, "https://github.com/o/r/pull/9");

  // note events append without a state change.
  tasks.recordEvent(task.id, { kind: "note", source: "system", message: "dispatched" });
  assert.equal(tasks.find(task.id)?.state, "queued");

  rmSync(home, { recursive: true, force: true });
});

test("PR links persist one identity receipt while refreshing the observed head", () => {
  const { store: tasks, home } = store();
  const task = tasks.create({ title: "show the PR badge", project: "/tmp/repo" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  const pr = {
    url: "https://github.com/o/r/pull/62",
    number: 62,
    repo: "o/r",
    headRepo: "o/r",
    head: "perch/show-pr-badge",
    headOid: "abc123"
  };

  const linked = tasks.linkPr(task.id, pr, {
    source: "worker",
    message: pr.url,
    data: { pr }
  });
  assert.equal(linked.linked, true);
  assert.equal(linked.task.state, "working");
  assert.equal(linked.task.presentation?.state, "working");
  assert.deepEqual(tasks.stateDb.tasks.prFacts(task.id), pr);
  const linkEvent = tasks.events(task.id).at(-1)!;
  assert.equal(linkEvent.kind, "pr_linked");
  assert.deepEqual((linkEvent.data?.pr as typeof pr), pr);
  assert.deepEqual(
    tasks.stateDb.outbox.forTaskEvent(task.id, linkEvent.seq).map((intent) => intent.channel).sort(),
    ["mate", "push"]
  );

  const duplicate = tasks.linkPr(task.id, pr, { source: "worker", message: pr.url, data: { pr } });
  assert.equal(duplicate.linked, false);
  assert.equal(tasks.events(task.id).filter((event) => event.kind === "pr_linked").length, 1);
  const advanced = tasks.linkPr(
    task.id,
    { ...pr, headOid: "def456" },
    { source: "worker", message: pr.url, data: { pr: { ...pr, headOid: "def456" } } }
  );
  assert.equal(advanced.linked, false);
  assert.equal(advanced.task.pr?.headOid, "def456");
  assert.equal(tasks.events(task.id).filter((event) => event.kind === "pr_linked").length, 1);
  assert.throws(
    () => tasks.linkPr(task.id, { ...pr, url: "https://github.com/o/r/pull/63", number: 63 }, { source: "worker" }),
    /already linked/
  );

  tasks.close();
  const restarted = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  assert.deepEqual(restarted.find(task.id)?.pr, { ...pr, headOid: "def456" });
  assert.deepEqual(restarted.stateDb.tasks.prFacts(task.id), { ...pr, headOid: "def456" });
  restarted.close();
  rmSync(home, { recursive: true, force: true });
});

test("worker names are unique concurrently, stable across restart, and released only when closed", () => {
  const { store: tasks, home } = store();
  const first = tasks.create({ title: "first concurrent job", project: "/tmp/repo" });
  const second = tasks.create({ title: "second concurrent job", project: "/tmp/repo" });

  const namedFirst = tasks.claimWorkerName(first.id);
  const namedSecond = tasks.claimWorkerName(second.id);
  assert.ok(namedFirst.workerName);
  assert.ok(namedSecond.workerName);
  assert.notEqual(namedFirst.workerName, namedSecond.workerName);

  const restarted = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  assert.equal(restarted.claimWorkerName(first.id).workerName, namedFirst.workerName, "restart keeps the persisted claim");

  restarted.recordEvent(first.id, { kind: "failed", source: "worker" });
  const third = restarted.create({ title: "third concurrent job", project: "/tmp/repo" });
  assert.notEqual(
    restarted.claimWorkerName(third.id).workerName,
    namedFirst.workerName,
    "failed but open work keeps its reservation"
  );

  restarted.recordEvent(first.id, { kind: "closed", source: "system" });
  const fourth = restarted.create({ title: "fourth concurrent job", project: "/tmp/repo" });
  assert.equal(restarted.claimWorkerName(fourth.id).workerName, namedFirst.workerName, "closed work releases its name");
  assert.equal(restarted.find(first.id)?.workerName, namedFirst.workerName, "historical records retain their identity");

  rmSync(home, { recursive: true, force: true });
});

test("completion request and original prompt persist across restart", () => {
  const { store: tasks, home } = store();
  const task = tasks.create({
    title: "write the audit",
    project: "/tmp/repo",
    prompt: "Create audit.md with findings A and B"
  });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  tasks.recordEvent(task.id, {
    kind: "completion_requested",
    source: "worker",
    message: "audit.md is ready"
  });
  tasks.close();

  const restarted = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  assert.equal(restarted.find(task.id)?.state, "completion_requested");
  assert.equal(restarted.find(task.id)?.prompt, "Create audit.md with findings A and B");
  assert.equal(restarted.events(task.id).at(-1)?.kind, "completion_requested");
  restarted.close();
  rmSync(home, { recursive: true, force: true });
});

test("legacy active workers receive an atomic persisted name without rewriting historical records", () => {
  const { store: tasks, home } = store();
  const active = tasks.create({ title: "legacy active", project: "/tmp/repo" });
  tasks.update(active.id, { sessionId: "pty:legacy" });
  const historical = tasks.create({ title: "legacy historical", project: "/tmp/repo" });
  tasks.recordEvent(historical.id, { kind: "done", source: "worker" });
  tasks.recordEvent(historical.id, { kind: "closed", source: "system" });

  const restarted = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const claimed = restarted.claimLegacyActiveWorkerNames();
  assert.equal(claimed.length, 1);
  assert.ok(restarted.find(active.id)?.workerName);
  assert.ok(!("workerName" in restarted.find(historical.id)!));

  const stable = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  assert.equal(stable.claimLegacyActiveWorkerNames().length, 0);
  assert.equal(stable.find(active.id)?.workerName, claimed[0]?.workerName);

  rmSync(home, { recursive: true, force: true });
});

test("event data rides the ledger verbatim and reaches subscribers", () => {
  const { store: tasks, home } = store();
  const task = tasks.create({ title: "gated ship", project: "/tmp/repo", mode: "no-mistakes" });
  const noMistakes = {
    step: "review",
    findings: [{ id: "r1", severity: "error", file: "src/db.ts", line: 8, action: "ask-user", description: "index drop" }]
  };

  let observed: Record<string, unknown> | undefined;
  tasks.subscribe((_task, event) => {
    if (event.kind === "needs_decision") {
      observed = event.data;
    }
  });
  tasks.recordEvent(task.id, {
    kind: "needs_decision",
    source: "worker",
    message: "review gate: 1 finding needs you",
    data: { noMistakes }
  });

  assert.deepEqual(observed, { noMistakes });
  const persisted = tasks.events(task.id).find((event) => event.kind === "needs_decision");
  assert.deepEqual(persisted?.data, { noMistakes });
  // Events without data keep the field absent entirely (append-only wire).
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  const working = tasks.events(task.id).find((event) => event.kind === "working");
  assert.ok(working && !("data" in working));

  rmSync(home, { recursive: true, force: true });
});

test("planId is stamped, persisted, and looked up by plan", () => {
  const { store: tasks, home } = store();

  const a = tasks.create({ title: "build the hub", project: "/tmp/repo", planId: "docs/plans/2026-07-08-hub.md" });
  const b = tasks.create({ title: "hub follow-up", project: "/tmp/repo", planId: "docs/plans/2026-07-08-hub.md" });
  tasks.create({ title: "unrelated", project: "/tmp/repo" });
  tasks.create({ title: "other plan", project: "/tmp/repo", planId: "docs/plans/2026-07-08-other.md" });

  // Stamped and durable across a fresh read.
  assert.equal(tasks.find(a.id)?.planId, "docs/plans/2026-07-08-hub.md");
  // A task with no planId keeps the field absent entirely (append-only wire).
  const plain = tasks.list().find((task) => task.title === "unrelated");
  assert.ok(plain && !("planId" in plain));

  // Lookup finds exactly the two stamped with this plan, recency-sorted.
  const affected = tasks.listByPlan("docs/plans/2026-07-08-hub.md");
  assert.deepEqual(
    affected.map((task) => task.id).sort(),
    [a.id, b.id].sort()
  );
  assert.equal(tasks.listByPlan("docs/plans/2026-07-08-other.md").length, 1);
  // An unknown or empty planId matches nothing.
  assert.equal(tasks.listByPlan("docs/plans/nope.md").length, 0);
  assert.equal(tasks.listByPlan("").length, 0);

  rmSync(home, { recursive: true, force: true });
});

test("stagePlanEdit writes the revised markdown centrally, never in a repo", () => {
  const { store: tasks, home } = store();
  const task = tasks.create({ title: "revise the plan", project: "/tmp/repo" });

  const staged = tasks.stagePlanEdit(task.id, "# New plan\n\nbody\n");
  // Staged under the task's own dir in PERCH_HOME, not the project repo.
  assert.ok(staged.startsWith(join(home, "tasks", task.id)));
  assert.equal(readFileSync(staged, "utf8"), "# New plan\n\nbody\n");

  rmSync(home, { recursive: true, force: true });
});

test("capacity counts only open tasks, so closing frees a slot", () => {
  const { store: tasks, home } = store();
  for (let index = 0; index < 500; index += 1) {
    tasks.create({ title: `job ${index}`, project: "/tmp/repo" });
  }

  assert.throws(() => tasks.create({ title: "one too many", project: "/tmp/repo" }), /500 open tasks/);

  const victim = tasks.list()[0]!;
  tasks.recordEvent(victim.id, { kind: "failed", source: "worker" });
  tasks.recordEvent(victim.id, { kind: "closed", source: "system" });

  const fresh = tasks.create({ title: "after closing", project: "/tmp/repo" });
  assert.equal(fresh.state, "queued");
  assert.equal(tasks.list().length, 501, "closed history is retained, not deleted");

  rmSync(home, { recursive: true, force: true });
});

test("a corrupted persisted timestamp never bricks later updates", () => {
  const home = mkdtempSync(join(tmpdir(), "perch-tasks-"));
  const corrupted = {
    id: "corrupted-task-abcd",
    title: "Corrupted timestamp",
    project: "/tmp/repo",
    kind: "ship",
    mode: "direct-PR",
    state: "working",
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "not-a-date"
  };
  const dir = join(home, "tasks", corrupted.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "task.json"), JSON.stringify(corrupted));

  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const updated = tasks.update(corrupted.id, { branch: "perch/corrupted-task" });
  assert.ok(!Number.isNaN(Date.parse(updated.updatedAt)));

  const evented = tasks.recordEvent(corrupted.id, { kind: "done", source: "worker" });
  assert.equal(evented.state, "done");
  assert.ok(!Number.isNaN(Date.parse(evented.updatedAt)));

  rmSync(home, { recursive: true, force: true });
});

test("list sorts by recency and ids reject path traversal", () => {
  const { store: tasks, home } = store();
  tasks.create({ title: "first", project: "/tmp/a" });
  const second = tasks.create({ title: "second", project: "/tmp/b" });
  tasks.recordEvent(second.id, { kind: "working", source: "worker" });

  assert.equal(tasks.list()[0]?.title, "second");
  assert.equal(tasks.list().length, 2);
  assert.equal(tasks.find("../escape"), undefined);
  assert.throws(() => tasks.recordEvent("../escape", { kind: "note", source: "system" }), /Unknown task|Invalid/);

  rmSync(home, { recursive: true, force: true });
});

test("workerParkedAt speaks only for the latest state-moving event", () => {
  const { store: tasks, home } = store();
  const task = tasks.create({ title: "park attribution", project: "/tmp/repo" });
  tasks.recordEvent(task.id, { kind: "working", source: "system" });

  // A worker park is authoritative, and a trailing state-preserving note
  // neither confirms nor surrenders it.
  const parked = tasks.recordEvent(task.id, { kind: "blocked", source: "worker", message: "need the boss" });
  tasks.recordEvent(task.id, { kind: "note", source: "worker", message: "attached logs" });
  assert.equal(tasks.workerParkedAt(tasks.find(task.id)!), Date.parse(tasks.events(task.id)[2]!.at));
  assert.equal(parked.state, "blocked");

  // A resume followed by a system re-park supersedes the old worker park:
  // the current blocked state is system-authored, not the worker's.
  tasks.recordEvent(task.id, { kind: "working", source: "system", message: "resumed" });
  tasks.recordEvent(task.id, { kind: "blocked", source: "system", message: "session gone" });
  assert.equal(tasks.workerParkedAt(tasks.find(task.id)!), undefined);

  // A fresh worker park after the system detour is authoritative again.
  tasks.recordEvent(task.id, { kind: "needs_decision", source: "worker", message: "which target?" });
  assert.equal(
    tasks.workerParkedAt(tasks.find(task.id)!),
    Date.parse(tasks.events(task.id).at(-1)!.at)
  );

  // A park verb that does not match the current state never speaks for it.
  tasks.recordEvent(task.id, { kind: "blocked", source: "worker", message: "now blocked" });
  const mismatched = { ...tasks.find(task.id)!, state: "needs_you" as const };
  assert.equal(tasks.workerParkedAt(mismatched), undefined);

  rmSync(home, { recursive: true, force: true });
});

test("derived readiness follows verification and PR facts, and never persists", () => {
  const { store: tasks, home } = store();
  const task = tasks.create({ title: "ship truthful badges", project: "/tmp/repo" });
  tasks.update(task.id, {
    pr: { url: "https://github.com/o/r/pull/12", headOid: "head-a", checks: "passing", mergeable: "MERGEABLE", mergeReady: true }
  });

  const requested = tasks.recordEvent(task.id, {
    kind: "completion_requested",
    source: "worker",
    data: { deliverable: { kind: "pr", headOid: "head-a" } }
  });
  assert.equal(requested.presentation?.state, "awaiting_verification");

  const requestSeq = tasks.events(task.id).at(-1)!.seq;
  const accepted = tasks.recordEvent(task.id, {
    kind: "completion_accepted",
    source: "system",
    data: { completionDecision: { requestSeq } }
  });
  assert.equal(accepted.presentation?.state, "ready_to_merge");
  assert.equal(tasks.list().find((candidate) => candidate.id === task.id)?.presentation?.state, "ready_to_merge");

  // A new observed head invalidates readiness; the accepted head restores it.
  const moved = tasks.update(task.id, { pr: { ...accepted.pr!, headOid: "head-b" } });
  assert.equal(moved.presentation?.state, "working");
  const restored = tasks.update(task.id, { pr: { ...accepted.pr!, headOid: "head-a" } });
  assert.equal(restored.presentation?.state, "ready_to_merge");

  // Resumed work surrenders readiness even though the acceptance still stands.
  tasks.recordEvent(task.id, { kind: "failed", source: "worker" });
  const resumed = tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  assert.equal(resumed.presentation?.state, "working");

  // The durable projection stores facts only, never the derived presentation.
  const raw = tasks.stateDb.tasks.find(task.id);
  assert.ok(raw);
  assert.equal("presentation" in raw, false);

  tasks.close();
  rmSync(home, { recursive: true, force: true });
});

test("no-mistakes Reviewing follows durable review facts, not project mode", () => {
  const { store: tasks, home } = store();
  const task = tasks.create({ title: "gated work", project: "/tmp/repo", mode: "no-mistakes" });

  // Scouting and implementation stay Working from launch.
  const working = tasks.recordEvent(task.id, { kind: "working", source: "worker", message: "implementing" });
  assert.equal(working.presentation?.state, "working");

  // A denied authorization never marks review.
  const denied = tasks.recordEvent(task.id, {
    kind: "note",
    source: "system",
    data: { noMistakesAuthorization: { allowed: false, reason: "runtime_not_live" } }
  });
  assert.equal(denied.presentation?.state, "working");

  // Only the system-recorded authorize decision counts; a worker-sourced note
  // claiming allowed never creates the review fact.
  const forged = tasks.recordEvent(task.id, {
    kind: "note",
    source: "worker",
    data: { noMistakesAuthorization: { allowed: true, operation: "run", reason: "authorized" } }
  });
  assert.equal(forged.presentation?.state, "working");

  // The allowed authorization is the durable proof the pipeline engaged.
  const reviewing = tasks.recordEvent(task.id, {
    kind: "note",
    source: "system",
    data: { noMistakesAuthorization: { allowed: true, operation: "run", reason: "authorized" } }
  });
  assert.equal(reviewing.presentation?.state, "reviewing");
  assert.equal(tasks.list().find((candidate) => candidate.id === task.id)?.presentation?.state, "reviewing");

  // A parked gate takes its primary state; resumed work surrenders review.
  const parked = tasks.recordEvent(task.id, { kind: "needs_decision", source: "worker", message: "gate findings" });
  assert.equal(parked.presentation?.state, "needs_you");
  const resumed = tasks.recordEvent(task.id, { kind: "working", source: "worker", message: "addressing findings" });
  assert.equal(resumed.presentation?.state, "working");

  // Re-entering the pipeline restores Reviewing; a mate reject surrenders it.
  tasks.recordEvent(task.id, {
    kind: "note",
    source: "system",
    data: { noMistakesAuthorization: { allowed: true, operation: "gate-push", reason: "authorized" } }
  });
  assert.equal(tasks.find(task.id)?.presentation?.state, "reviewing");
  tasks.recordEvent(task.id, {
    kind: "completion_requested",
    source: "worker",
    data: { deliverable: { kind: "pr", headOid: "head-a" } }
  });
  const requestSeq = tasks.events(task.id).at(-1)!.seq;
  assert.equal(tasks.find(task.id)?.presentation?.state, "awaiting_verification");
  const rejected = tasks.recordEvent(task.id, {
    kind: "completion_rejected",
    source: "system",
    data: { completionDecision: { requestSeq } }
  });
  assert.equal(rejected.presentation?.state, "working");

  tasks.close();
  rmSync(home, { recursive: true, force: true });
});
