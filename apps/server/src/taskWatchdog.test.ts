import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { StateMetrics } from "./stateMetrics.js";
import { reportSessionExitToTask, TaskWatchdog } from "./taskWatchdog.js";
import { TaskStore } from "./tasks.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freshStore(): { tasks: TaskStore; home: string } {
  const home = mkdtempSync(join(tmpdir(), "perch-watchdog-"));
  return { tasks: new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv), home };
}

test("silence watchdog fires once per quiet spell and re-arms on activity", async () => {
  const { tasks, home } = freshStore();
  const task = tasks.create({ title: "long survey", project: "/tmp/repo", kind: "scout" });
  tasks.update(task.id, { sessionId: "pty:w" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });

  const watchdog = new TaskWatchdog({ tasks }, { scoutSilenceMs: 80, shipSilenceMs: 10_000 });

  // Quiet past the scout threshold: exactly one stall, repeated checks stay quiet.
  await sleep(120);
  watchdog.checkSilence();
  watchdog.checkSilence();
  assert.equal(tasks.events(task.id).filter((event) => event.kind === "stalled").length, 1);
  assert.equal(tasks.find(task.id)?.state, "working");

  // Fresh worker activity re-arms; the next quiet spell fires again. (The
  // small sleep keeps the activity a strictly later millisecond than the
  // stall stamp - in production these are minutes apart.)
  await sleep(5);
  tasks.recordEvent(task.id, { kind: "working", source: "worker", message: "still digging" });
  watchdog.checkSilence();
  assert.equal(tasks.events(task.id).filter((event) => event.kind === "stalled").length, 1);
  await sleep(120);
  watchdog.checkSilence();
  assert.equal(tasks.events(task.id).filter((event) => event.kind === "stalled").length, 2);

  watchdog.stop();
  rmSync(home, { recursive: true, force: true });
});

test("silence watchdog counts recent session activity as liveness", async () => {
  const { tasks, home } = freshStore();
  const task = tasks.create({ title: "big refactor", project: "/tmp/repo", kind: "scout" });
  tasks.update(task.id, { sessionId: "pty:w" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });

  // The transcript is being written right now even though no verbs arrive.
  const watchdog = new TaskWatchdog(
    { tasks, sessionActivityAt: () => Date.now() - 10 },
    { scoutSilenceMs: 50 }
  );
  await sleep(90);
  watchdog.checkSilence();
  assert.equal(tasks.events(task.id).filter((event) => event.kind === "stalled").length, 0);

  watchdog.stop();
  rmSync(home, { recursive: true, force: true });
});

test("session death reports runtime interruption without changing task state", () => {
  const { tasks, home } = freshStore();
  const task = tasks.create({ title: "crashy work", project: "/tmp/repo" });
  tasks.update(task.id, { sessionId: "pty:w" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });

  const metrics = new StateMetrics();
  let interruption: { sessionId: string; message: string; intentional: boolean } | undefined;
  reportSessionExitToTask(
    tasks,
    "pty:w",
    { status: "error", exitCode: 137, tail: "FATAL: out of memory\nkilled" },
    metrics,
    (sessionId, message, intentional) => {
      interruption = { sessionId, message, intentional };
    }
  );

  const updated = tasks.find(task.id);
  assert.equal(updated?.state, "working");
  assert.equal(interruption?.sessionId, "pty:w");
  assert.match(interruption?.message ?? "", /exit 137/);
  assert.match(interruption?.message ?? "", /out of memory/);
  assert.equal(interruption?.intentional, false);
  assert.equal(metrics.snapshot().counters["watchdog.sessionDeaths"], 1);
  rmSync(home, { recursive: true, force: true });
});

test("reconcile: a vanished session reports runtime interruption without changing task state", async () => {
  const { tasks, home } = freshStore();
  const task = tasks.create({ title: "orphaned by restart", project: "/tmp/repo", kind: "scout" });
  tasks.update(task.id, { sessionId: "pty:gone" });
  tasks.recordEvent(task.id, { kind: "working", source: "system", message: "worker session active" });

  const metrics = new StateMetrics();
  // The adapter no longer lists this session (server restart killed the PTY).
  const interruptions: string[] = [];
  const watchdog = new TaskWatchdog({
    tasks,
    liveSessionIds: () => new Set<string>(),
    // Mirrors the runtime manager's CAS: only the first report transitions.
    runtimeInterrupted: (sessionId) => {
      interruptions.push(sessionId);
      return interruptions.length === 1;
    },
    metrics
  });

  await watchdog.sweep();

  const updated = tasks.find(task.id);
  assert.equal(updated?.state, "working");
  assert.deepEqual(interruptions, ["pty:gone"]);
  assert.equal(metrics.snapshot().counters["watchdog.sessionReconciled"], 1);

  // The runtime manager's generation CAS makes repeated reports idempotent;
  // the metric counts only reports that actually transitioned the runtime.
  await watchdog.sweep();
  assert.deepEqual(interruptions, ["pty:gone", "pty:gone"]);
  assert.equal(metrics.snapshot().counters["watchdog.sessionReconciled"], 1);

  watchdog.stop();
  rmSync(home, { recursive: true, force: true });
});

test("reconcile: a working task whose session is still live is left alone", async () => {
  const { tasks, home } = freshStore();
  const task = tasks.create({ title: "healthy work", project: "/tmp/repo" });
  tasks.update(task.id, { sessionId: "pty:live" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });

  const watchdog = new TaskWatchdog({ tasks, liveSessionIds: () => new Set(["pty:live"]) });
  await watchdog.sweep();

  assert.equal(tasks.find(task.id)?.state, "working");
  assert.equal(tasks.events(task.id).filter((event) => event.kind === "blocked").length, 0);

  watchdog.stop();
  rmSync(home, { recursive: true, force: true });
});

test("reconcile: a parked (needs_you) task whose session ended is not flipped", async () => {
  const { tasks, home } = freshStore();
  const task = tasks.create({ title: "waiting on boss", project: "/tmp/repo" });
  tasks.update(task.id, { sessionId: "pty:gone" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  tasks.recordEvent(task.id, { kind: "needs_decision", source: "worker", message: "A or B?" });

  const watchdog = new TaskWatchdog({ tasks, liveSessionIds: () => new Set<string>() });
  await watchdog.sweep();

  // Only `working` is reconciled; a parked task legitimately outlives its turn.
  assert.equal(tasks.find(task.id)?.state, "needs_you");
  assert.equal(tasks.events(task.id).filter((event) => event.kind === "blocked").length, 0);

  watchdog.stop();
  rmSync(home, { recursive: true, force: true });
});

test("launch-stall: a working task idle since launch with a live session blocks with a reason", async () => {
  const { tasks, home } = freshStore();
  // The live codex-out-of-credits signature: flipped to working by the activity
  // helper (system source), then nothing - no worker verb, no hook, no output.
  const task = tasks.create({ title: "stuck at launch", project: "/tmp/repo" });
  tasks.update(task.id, { sessionId: "pty:live" });
  tasks.recordEvent(task.id, { kind: "working", source: "system", message: "worker session active" });

  const metrics = new StateMetrics();
  const watchdog = new TaskWatchdog(
    { tasks, liveSessionIds: () => new Set(["pty:live"]), metrics },
    { launchStallMs: 40, scoutSilenceMs: 10_000, shipSilenceMs: 10_000 }
  );
  await sleep(70);
  await watchdog.sweep();

  const updated = tasks.find(task.id);
  assert.equal(updated?.state, "blocked");
  const blocked = tasks.events(task.id).find((event) => event.kind === "blocked");
  assert.equal(blocked?.source, "system");
  assert.match(blocked?.message ?? "", /no activity since launch/);
  assert.equal(blocked?.data?.reason, "no_launch_activity");
  assert.equal(metrics.snapshot().counters["watchdog.launchStalls"], 1);

  watchdog.stop();
  rmSync(home, { recursive: true, force: true });
});

test("launch-stall does not fire once the worker has actually reported", async () => {
  const { tasks, home } = freshStore();
  const task = tasks.create({ title: "started fine", project: "/tmp/repo" });
  tasks.update(task.id, { sessionId: "pty:live" });
  // A real worker verb means the worker got off the ground; idle after that is
  // ordinary mid-work quiet, not a dead launch.
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });

  const watchdog = new TaskWatchdog(
    { tasks, liveSessionIds: () => new Set(["pty:live"]) },
    { launchStallMs: 40, scoutSilenceMs: 10_000, shipSilenceMs: 10_000 }
  );
  await sleep(70);
  await watchdog.sweep();

  assert.equal(tasks.find(task.id)?.state, "working");
  assert.equal(tasks.events(task.id).filter((event) => event.kind === "blocked").length, 0);

  watchdog.stop();
  rmSync(home, { recursive: true, force: true });
});

test("launch-stall does not fire after post-launch transcript activity", async () => {
  const { tasks, home } = freshStore();
  const task = tasks.create({ title: "completed but unreported", project: "/tmp/repo" });
  tasks.update(task.id, { sessionId: "pty:live" });
  tasks.recordEvent(task.id, { kind: "working", source: "system", message: "worker session active" });
  const postLaunchActivity = Date.parse(tasks.find(task.id)!.updatedAt) + 1;
  let now = postLaunchActivity + 100;

  const watchdog = new TaskWatchdog(
    {
      tasks,
      sessionActivityAt: () => postLaunchActivity,
      liveSessionIds: () => new Set(["pty:live"])
    },
    { now: () => now, launchStallMs: 40, scoutSilenceMs: 10_000, shipSilenceMs: 10_000 }
  );
  await watchdog.sweep();

  assert.equal(tasks.find(task.id)?.state, "working");
  assert.equal(
    tasks.events(task.id).filter((event) => event.data?.reason === "no_launch_activity").length,
    0
  );

  watchdog.stop();
  rmSync(home, { recursive: true, force: true });
});

test("stalled message is honest about whether the session still exists", async () => {
  const { tasks, home } = freshStore();
  const task = tasks.create({ title: "quiet but alive", project: "/tmp/repo", kind: "scout" });
  tasks.update(task.id, { sessionId: "pty:live" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });

  const watchdog = new TaskWatchdog(
    { tasks, liveSessionIds: () => new Set(["pty:live"]) },
    { scoutSilenceMs: 40 }
  );
  await sleep(70);
  await watchdog.sweep();

  const stall = tasks.events(task.id).find((event) => event.kind === "stalled");
  assert.match(stall?.message ?? "", /alive but idle/);
  assert.doesNotMatch(stall?.message ?? "", /no longer exists/);

  watchdog.stop();
  rmSync(home, { recursive: true, force: true });
});

test("session death on a settled task stays a bookkeeping note", () => {
  const { tasks, home } = freshStore();
  const task = tasks.create({ title: "finished work", project: "/tmp/repo" });
  tasks.update(task.id, { sessionId: "pty:w" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  tasks.recordEvent(task.id, { kind: "done", source: "worker" });

  reportSessionExitToTask(tasks, "pty:w", { status: "done", exitCode: 0 });

  assert.equal(tasks.find(task.id)?.state, "done");
  const events = tasks.events(task.id);
  assert.equal(events.filter((event) => event.kind === "blocked").length, 0);
  assert.equal(events[events.length - 1]?.kind, "note");
  rmSync(home, { recursive: true, force: true });
});

test("sweep drives the self-heal callback for every blocked task", async () => {
  const { tasks, home } = freshStore();
  const blocked = tasks.create({ title: "pushed no pr", project: "/tmp/repo" });
  tasks.update(blocked.id, { sessionId: "pty:b" });
  tasks.recordEvent(blocked.id, { kind: "working", source: "worker" });
  tasks.recordEvent(blocked.id, { kind: "blocked", source: "system", message: "pushed but has no PR", data: { reason: "pr_binding_pending" } });
  const working = tasks.create({ title: "still going", project: "/tmp/repo" });
  tasks.update(working.id, { sessionId: "pty:w" });
  tasks.recordEvent(working.id, { kind: "working", source: "worker" });

  const healed: string[] = [];
  const watchdog = new TaskWatchdog(
    { tasks, healBlocked: (task) => { healed.push(task.id); } },
    { shipSilenceMs: 10 * 60_000 }
  );
  await watchdog.sweep();

  // Only the blocked task is offered to the self-heal handler; working tasks are not.
  assert.deepEqual(healed, [blocked.id]);

  watchdog.stop();
  rmSync(home, { recursive: true, force: true });
});
