import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "@perch/shared";
import { wakeLine } from "./mateWake.js";

function task(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: "fix-the-auth-a1b2",
    title: "fix the auth flow",
    project: "/Users/dev/projects/perch",
    kind: "ship",
    mode: "no-mistakes",
    state: "needs_you",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

test("wakeLine keeps the plain one-line format for events without findings", () => {
  assert.equal(
    wakeLine(task(), { kind: "blocked", message: "npm registry is down" }),
    "[perch] fix-the-auth-a1b2 · blocked: npm registry is down"
  );
  assert.equal(wakeLine(task(), { kind: "done" }), "[perch] fix-the-auth-a1b2 · done: fix the auth flow");
});

test("wakeLine leads with the worker name while keeping the task id machine-resolvable", () => {
  assert.equal(
    wakeLine(task({ workerName: "Wren" }), { kind: "done" }),
    "[perch] Wren (fix-the-auth-a1b2) · done: fix the auth flow"
  );
  assert.equal(
    wakeLine(task({ workerName: "Wren" }), { kind: "blocked", message: "waiting for Apple" }),
    "[perch] Wren (fix-the-auth-a1b2) · blocked: waiting for Apple"
  );
});

test("wakeLine separates green checks from true merge readiness", () => {
  assert.equal(
    wakeLine(task(), { kind: "checks_green", message: "https://github.com/o/r/pull/7" }),
    "[perch] fix-the-auth-a1b2 · checks_green: https://github.com/o/r/pull/7 - CI checks green; merge readiness not confirmed"
  );
  assert.equal(
    wakeLine(task(), { kind: "merge_ready", message: "https://github.com/o/r/pull/7" }),
    "[perch] fix-the-auth-a1b2 · merge_ready: https://github.com/o/r/pull/7 - GitHub reports this PR is ready to merge"
  );
});

test("wakeLine renders a needs_decision gate as the full findings table, single-line", () => {
  const line = wakeLine(task(), {
    kind: "needs_decision",
    message: "review gate: 2 findings need you",
    data: {
      noMistakes: {
        step: "review",
        findings: [
          { id: "r1", severity: "error", file: "src/db.ts", line: 8, action: "ask-user", description: "index drop\nchanges plans" },
          { id: "r2", severity: "warning", description: "prefer the shared helper" }
        ]
      }
    }
  });
  assert.equal(
    line,
    "[perch] fix-the-auth-a1b2 · needs_decision: review gate: 2 findings need you - " +
      "review gate parked with 2 findings: " +
      "r1 (error) src/db.ts:8 [ask-user]: index drop changes plans | " +
      "r2 (warning): prefer the shared helper"
  );
  assert.ok(!line.includes("\n"));
});

test("wakeLine with unparseable gate data falls back to the message", () => {
  const line = wakeLine(task(), {
    kind: "needs_decision",
    message: "which branch?",
    data: { noMistakes: "not a table" }
  });
  assert.equal(line, "[perch] fix-the-auth-a1b2 · needs_decision: which branch?");
});
