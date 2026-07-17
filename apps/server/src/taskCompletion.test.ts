import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TaskCompletionReconciler } from "./taskCompletion.js";
import { TaskStore } from "./tasks.js";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "perch-provider-completion-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const task = tasks.create({ title: "deliver artifact", project: "/tmp/repo", prompt: "Create audit.md" });
  tasks.update(task.id, { sessionId: "pty:worker" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  return {
    home,
    tasks,
    task,
    reconciler: new TaskCompletionReconciler({ tasks, lastAssistantText: () => "artifact is ready" }),
    close() {
      tasks.close();
      rmSync(home, { recursive: true, force: true });
    }
  };
}

for (const provider of ["codex", "claude"] as const) {
  test(`${provider} start/stop correlates the event sequence and working is not an outcome`, () => {
    const fx = fixture();
    try {
      const baseline = fx.tasks.events(fx.task.id).at(-1)?.seq;
      const started = fx.reconciler.onTurnStarted("pty:worker", provider);
      fx.tasks.recordEvent(fx.task.id, { kind: "working", source: "worker", message: "artifact written" });
      const result = fx.reconciler.onTurnCompleted("pty:worker", provider);

      assert.equal(result.retryNeeded, true);
      assert.equal(result.matchedStart, true);
      assert.equal(fx.tasks.find(fx.task.id)?.state, "working");
      const events = fx.tasks.events(fx.task.id);
      assert.equal(started?.data?.taskEventSeqAtStart, baseline);
      assert.deepEqual(events.slice(-2).map((event) => event.kind), ["turn_completed", "stalled"]);
      assert.deepEqual(events.at(-2)?.data, {
        provider,
        sessionId: "pty:worker",
        turnStartedSeq: started?.seq,
        taskEventSeqAtStart: baseline,
        attempt: 1,
        retryNeeded: true
      });
      assert.equal(events.at(-1)?.data?.reason, "turn_outcome_missing");
      assert.match(events.at(-1)?.message ?? "", /retry needed/);
      assert.match(events.at(-1)?.message ?? "", /artifact is ready/);
    } finally {
      fx.close();
    }
  });
}

for (const kind of ["needs_decision", "blocked", "completion_requested", "failed"] as const) {
  test(`${kind} accepted after turn start satisfies the outcome boundary`, () => {
    const fx = fixture();
    try {
      fx.reconciler.onTurnStarted("pty:worker", "codex");
      fx.tasks.recordEvent(fx.task.id, { kind, source: "worker", message: "accurate outcome" });
      const outcome = fx.tasks.events(fx.task.id).at(-1);
      const result = fx.reconciler.onTurnCompleted("pty:worker", "codex");

      assert.equal(result.retryNeeded, false);
      assert.equal(result.outcomeEvent?.seq, outcome?.seq);
      assert.equal(fx.tasks.events(fx.task.id).filter((event) => event.kind === "stalled").length, 0);
      const completed = fx.tasks.events(fx.task.id).at(-1);
      assert.equal(completed?.kind, "turn_completed");
      assert.equal(completed?.data?.outcomeKind, kind);
      assert.equal(completed?.data?.outcomeEventSeq, outcome?.seq);
    } finally {
      fx.close();
    }
  });
}

test("an outcome from before turn start cannot satisfy a later turn", () => {
  const fx = fixture();
  try {
    fx.tasks.recordEvent(fx.task.id, { kind: "blocked", source: "worker", message: "old park" });
    fx.reconciler.onTurnStarted("pty:worker", "claude");
    const result = fx.reconciler.onTurnCompleted("pty:worker", "claude");
    assert.equal(result.retryNeeded, true);
    assert.equal(result.outcomeEvent, undefined);
    assert.equal(fx.tasks.events(fx.task.id).at(-1)?.kind, "stalled");
  } finally {
    fx.close();
  }
});

test("duplicate completion is idempotent while one Claude continuation can satisfy the same turn", () => {
  const fx = fixture();
  try {
    fx.reconciler.onTurnStarted("pty:worker", "claude");
    const first = fx.reconciler.onTurnCompleted("pty:worker", "claude");
    const count = fx.tasks.events(fx.task.id).length;
    const duplicate = fx.reconciler.onTurnCompleted("pty:worker", "claude");
    assert.equal(first.retryNeeded, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(fx.tasks.events(fx.task.id).length, count);

    fx.tasks.recordEvent(fx.task.id, { kind: "completion_requested", source: "worker", message: "reported on retry" });
    const continued = fx.reconciler.onTurnCompleted("pty:worker", "claude", { continuation: true });
    assert.equal(continued.retryNeeded, false);
    assert.equal(continued.outcomeEvent?.kind, "completion_requested");
    assert.equal(fx.tasks.events(fx.task.id).filter((event) => event.kind === "stalled").length, 1);
    assert.equal(fx.tasks.events(fx.task.id).at(-1)?.data?.attempt, 2);
  } finally {
    fx.close();
  }
});

test("turn-start sequence survives restart and still enforces the Stop boundary", () => {
  const fx = fixture();
  try {
    const started = fx.reconciler.onTurnStarted("pty:worker", "codex");
    fx.tasks.close();

    const restarted = new TaskStore({ PERCH_HOME: fx.home } as NodeJS.ProcessEnv);
    const reconciler = new TaskCompletionReconciler({ tasks: restarted });
    const result = reconciler.onTurnCompleted("pty:worker", "codex");
    assert.equal(result.retryNeeded, true);
    assert.equal(result.matchedStart, true);
    assert.equal(restarted.events(fx.task.id).at(-2)?.data?.turnStartedSeq, started?.seq);
    assert.equal(restarted.events(fx.task.id).at(-1)?.kind, "stalled");
    restarted.close();
    rmSync(fx.home, { recursive: true, force: true });
  } catch (error) {
    rmSync(fx.home, { recursive: true, force: true });
    throw error;
  }
});

test("Alder regression: a late follow-up Stop records retry-needed without reopening verified done", () => {
  const fx = fixture();
  try {
    fx.tasks.recordEvent(fx.task.id, { kind: "completion_requested", source: "worker" });
    fx.tasks.recordEvent(fx.task.id, { kind: "completion_accepted", source: "system" });
    fx.reconciler.onTurnStarted("pty:worker", "codex");
    const result = fx.reconciler.onTurnCompleted("pty:worker", "codex");
    assert.equal(result.retryNeeded, true);
    assert.equal(fx.tasks.find(fx.task.id)?.state, "done");
    assert.equal(fx.tasks.events(fx.task.id).at(-1)?.kind, "stalled");
  } finally {
    fx.close();
  }
});

test("unknown session completion writes no task event", () => {
  const fx = fixture();
  try {
    const before = fx.tasks.events(fx.task.id).length;
    const result = fx.reconciler.onTurnCompleted("pty:other", "codex");
    assert.equal(result.taskId, undefined);
    assert.equal(fx.tasks.events(fx.task.id).length, before);
  } finally {
    fx.close();
  }
});
