import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "@perch/shared";
import { CODEX_NATIVE_CHILD_GUIDANCE, dispatchBrief } from "./brief.js";
import { CHART_CAPABILITY_NOTE } from "./hooks.js";

function task(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: "ship-the-thing-a1b2", title: "ship the thing", project: "/Users/dev/projects/perch", kind: "ship",
    state: "queued", createdAt: now, updatedAt: now, ...overrides
  };
}

test("ship brief exposes server-owned AutoReview and delivery operations without direct delivery instructions", () => {
  const brief = dispatchBrief(task(), "/tmp/wt", {}, "codex");
  assert.match(brief, /perch\.autoreview\.run/);
  assert.match(brief, /perch\.delivery\.create_pr/);
  assert.match(brief, /Do not run git push, gh pr create, curl, or any independent delivery command/);
  assert.ok(!brief.includes("no-mistakes"));
  assert.ok(!brief.includes('"kind":"pr_linked"'));
});

test("Claude ship brief has typed CLI parity and no worker-authored HTTP operation", () => {
  const brief = dispatchBrief(task(), "/tmp/wt", {}, "claude");
  assert.match(brief, /perch autoreview run --task ship-the-thing-a1b2/);
  assert.match(brief, /perch delivery create-pr --task ship-the-thing-a1b2/);
  assert.ok(!brief.includes("/autoreview"));
  assert.ok(!brief.includes("/delivery/pr"));
});

test("scout and operate briefs prohibit source delivery", () => {
  const scout = dispatchBrief(task({ kind: "scout" }), "/tmp/wt");
  assert.match(scout, /investigate read-only/);
  assert.match(scout, /Do not change repository files, run AutoReview, push, or create a PR/);
  const operate = dispatchBrief(task({ kind: "operate" }), "/tmp/wt");
  assert.match(operate, /verified runtime or external operation/);
  assert.match(operate, /Do not change repository files, run AutoReview, push, or create a code PR/);
});

test("a planId stamps the brief with the first-commit convention", () => {
  const brief = dispatchBrief(task({ planId: "docs/plans/2026-08-07-hub.md" }), "/tmp/wt");
  assert.match(brief, /builds from finalized plan `docs\/plans\/2026-08-07-hub\.md`/);
  assert.match(brief, /Commit it first/);
});

test("Codex briefs preserve root-only native child guidance and chart capability", () => {
  const brief = dispatchBrief(task(), "/tmp/wt", {}, "codex");
  assert.ok(brief.endsWith(`${CODEX_NATIVE_CHILD_GUIDANCE}\n\n${CHART_CAPABILITY_NOTE}`));
  assert.match(brief, /root thread's perch\.report_task_event tool/);
});
