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

test("a working no-mistakes task presents Reviewing only with durable review facts", () => {
  const review = { enteredSeq: 3 };
  // Mode alone never promotes Working: scouting and implementation stay
  // Working until the gate's allowed authorization is on the ledger.
  assert.equal(deriveTaskPresentation(task({ mode: "no-mistakes", state: "working" })).state, "working");
  assert.equal(deriveTaskPresentation(task({ mode: "no-mistakes", state: "working" }), { review }).state, "reviewing");
  // Review facts only ever promote a working no-mistakes task.
  assert.equal(deriveTaskPresentation(task({ mode: "no-mistakes", state: "queued" }), { review }).state, "working");
  assert.equal(deriveTaskPresentation(task({ mode: "no-mistakes", state: "needs_you" }), { review }).state, "needs_you");
  assert.equal(deriveTaskPresentation(task({ mode: "no-mistakes", state: "blocked" }), { review }).state, "blocked");
  assert.equal(
    deriveTaskPresentation(task({ mode: "no-mistakes", state: "completion_requested" }), { review }).state,
    "awaiting_verification"
  );
  assert.equal(deriveTaskPresentation(task({ mode: "direct-PR", state: "working" }), { review }).state, "working");
  assert.equal(deriveTaskPresentation(task({ mode: "local-only", state: "working" }), { review }).state, "working");
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
  assert.equal(deriveTaskPresentation(local, { verification: { ...facts, acceptedRevision: "abc123" } }).state, "ready_to_apply");
  assert.equal(deriveTaskPresentation(local, { verification: { ...facts, acceptedRevision: "def456" } }).state, "working");
  assert.equal(deriveTaskPresentation(local, { verification: { ...facts, accepted: false } }).state, "working");
});

test("local-only readiness stays absent without an exact commit SHA on both sides", () => {
  const local = task({ mode: "local-only", pr: undefined });
  const requested: TaskVerificationFacts = {
    requestSeq: 1,
    deliverable: { kind: "local", revision: "abc123" },
    accepted: true
  };
  // The request pinned no revision (checkout HEAD was unreadable).
  assert.equal(
    deriveTaskPresentation(local, { verification: { ...requested, deliverable: { kind: "local" }, acceptedRevision: "abc123" } }).state,
    "working"
  );
  // The acceptance recorded no revision (checkout HEAD was unreadable).
  assert.equal(deriveTaskPresentation(local, { verification: requested }).state, "working");
});

test("landed tasks leave the active presentation without a merged badge", () => {
  assert.equal(deriveTaskPresentation(task({ state: "landed" })).state, "closed");
  assert.equal(deriveTaskPresentation(task({ mode: "local-only", state: "landed", pr: undefined })).state, "closed");
  assert.equal(deriveTaskPresentation(task({ mode: "no-mistakes", state: "landed" })).state, "closed");
});

test("ordinary lifecycle states and closed tasks retain truthful presentation", () => {
  assert.equal(deriveTaskPresentation(task({ state: "needs_you" })).state, "needs_you");
  assert.equal(deriveTaskPresentation(task({ state: "blocked" })).state, "blocked");
  assert.equal(deriveTaskPresentation(task({ state: "failed" })).state, "failed");
  assert.equal(deriveTaskPresentation(task({ state: "closed" })).state, "closed");
  assert.equal(deriveTaskPresentation(task({ state: "queued" })).state, "working");
});
