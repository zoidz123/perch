import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task, TaskEvent } from "@perch/shared";
import { deriveTaskPresentation } from "./taskPresentation.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "truthful-state-a1b2",
    title: "truthful state",
    project: "/repo",
    kind: "ship",
    mode: "direct-PR",
    state: "done",
    pr: { url: "https://github.com/o/r/pull/1", headOid: "head-a", checks: "passing", mergeable: "MERGEABLE", mergeReady: true },
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...overrides
  };
}

function events(decision: "completion_accepted" | "completion_rejected" = "completion_accepted"): TaskEvent[] {
  return [
    { seq: 1, at: "", kind: "completion_requested", source: "worker", data: { deliverable: { kind: "pr", headOid: "head-a" } } },
    { seq: 2, at: "", kind: decision, source: "system", data: { completionDecision: { requestSeq: 1 } } }
  ];
}

test("green and mergeable PR needs mate acceptance for Ready to Merge", () => {
  assert.equal(deriveTaskPresentation(task({ state: "working" }), []).state, "working");
  assert.equal(deriveTaskPresentation(task({ state: "completion_requested" }), events()).state, "awaiting_verification");
  assert.equal(deriveTaskPresentation(task(), events()).state, "ready_to_merge");
});

test("rejection, resumption, new head, and changed checks invalidate readiness", () => {
  assert.equal(deriveTaskPresentation(task({ state: "working" }), events("completion_rejected")).state, "working");
  assert.equal(deriveTaskPresentation(task({ pr: { ...task().pr!, headOid: "head-b" } }), events()).state, "working");
  assert.equal(deriveTaskPresentation(task({ pr: { ...task().pr!, checks: "failing" } }), events()).state, "working");
});

test("local-only acceptance derives Ready to Apply without PR language", () => {
  const local = task({ mode: "local-only", pr: undefined });
  const localEvents: TaskEvent[] = [
    { seq: 1, at: "", kind: "completion_requested", source: "worker", data: { deliverable: { kind: "local", revision: "abc" } } },
    { seq: 2, at: "", kind: "completion_accepted", source: "system", data: { completionDecision: { requestSeq: 1 } } }
  ];
  assert.equal(deriveTaskPresentation(local, localEvents).state, "ready_to_apply");
});

test("ordinary lifecycle states and closed tasks retain truthful presentation", () => {
  assert.equal(deriveTaskPresentation(task({ state: "needs_you" }), []).state, "needs_you");
  assert.equal(deriveTaskPresentation(task({ state: "blocked" }), []).state, "blocked");
  assert.equal(deriveTaskPresentation(task({ state: "failed" }), []).state, "failed");
  assert.equal(deriveTaskPresentation(task({ state: "closed" }), []).state, "closed");
});
