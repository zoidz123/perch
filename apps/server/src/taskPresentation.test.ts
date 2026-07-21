import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "@perch/shared";
import { deriveTaskPresentation, type TaskVerificationFacts } from "./taskPresentation.js";

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

function verification(overrides: Partial<TaskVerificationFacts> = {}): TaskVerificationFacts {
  return { requestSeq: 1, deliverable: { kind: "pr", headOid: "head-a" }, accepted: true, ...overrides };
}

test("green and mergeable PR needs mate acceptance for Ready to Merge", () => {
  assert.equal(deriveTaskPresentation(task({ state: "working" })).state, "working");
  assert.equal(
    deriveTaskPresentation(task({ state: "completion_requested" }), { verification: verification({ accepted: false }) }).state,
    "awaiting_verification"
  );
  assert.equal(deriveTaskPresentation(task(), { verification: verification({ accepted: false }) }).state, "working");
  assert.equal(deriveTaskPresentation(task(), { verification: verification() }).state, "ready_to_merge");
});

test("only a durably working no-mistakes task presents Reviewing", () => {
  assert.equal(deriveTaskPresentation(task({ mode: "no-mistakes", state: "working" })).state, "reviewing");
  assert.equal(deriveTaskPresentation(task({ mode: "no-mistakes", state: "queued" })).state, "working");
  assert.equal(deriveTaskPresentation(task({ mode: "no-mistakes", state: "completion_requested" })).state, "awaiting_verification");
  assert.equal(deriveTaskPresentation(task({ mode: "direct-PR", state: "working" })).state, "working");
  assert.equal(deriveTaskPresentation(task({ mode: "local-only", state: "working" })).state, "working");
});

test("rejection, resumption, new head, and changed checks invalidate readiness", () => {
  assert.equal(deriveTaskPresentation(task({ state: "working" }), { verification: verification({ accepted: false }) }).state, "working");
  assert.equal(deriveTaskPresentation(task({ state: "working" }), { verification: verification() }).state, "working");
  assert.equal(deriveTaskPresentation(task({ state: "failed" }), { verification: verification() }).state, "failed");
  assert.equal(
    deriveTaskPresentation(task({ pr: { ...task().pr!, headOid: "head-b" } }), { verification: verification() }).state,
    "working"
  );
  assert.equal(
    deriveTaskPresentation(task(), { pr: { ...task().pr!, headOid: "head-b" }, verification: verification() }).state,
    "working"
  );
  assert.equal(
    deriveTaskPresentation(task({ pr: { ...task().pr!, checks: "failing" } }), { verification: verification() }).state,
    "working"
  );
});

test("local-only acceptance binds to the exact accepted checkout revision", () => {
  const local = task({ mode: "local-only", pr: undefined });
  const facts: TaskVerificationFacts = {
    requestSeq: 1,
    deliverable: { kind: "local", revision: "abc123" },
    accepted: true
  };
  assert.equal(deriveTaskPresentation(local, { verification: facts }).state, "ready_to_apply");
  assert.equal(deriveTaskPresentation(local, { verification: { ...facts, acceptedRevision: "abc123" } }).state, "ready_to_apply");
  assert.equal(deriveTaskPresentation(local, { verification: { ...facts, acceptedRevision: "def456" } }).state, "working");
  assert.equal(deriveTaskPresentation(local, { verification: { ...facts, deliverable: { kind: "local" } } }).state, "working");
  assert.equal(deriveTaskPresentation(local, { verification: { ...facts, accepted: false } }).state, "working");
});

test("ordinary lifecycle states and closed tasks retain truthful presentation", () => {
  assert.equal(deriveTaskPresentation(task({ state: "needs_you" })).state, "needs_you");
  assert.equal(deriveTaskPresentation(task({ state: "blocked" })).state, "blocked");
  assert.equal(deriveTaskPresentation(task({ state: "failed" })).state, "failed");
  assert.equal(deriveTaskPresentation(task({ state: "closed" })).state, "closed");
  assert.equal(deriveTaskPresentation(task({ state: "queued" })).state, "working");
});
