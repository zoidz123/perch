import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "@perch/shared";
import { dispatchBrief } from "./brief.js";

function task(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: "ship-the-thing-a1b2",
    title: "ship the thing",
    project: "/Users/dev/projects/perch",
    kind: "ship",
    mode: "direct-PR",
    state: "queued",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

test("no-mistakes mode brief carries the gate driving section and the structured findings contract", () => {
  const brief = dispatchBrief(task({ mode: "no-mistakes" }), "/tmp/wt");
  assert.match(brief, /Ship through the no-mistakes gate:/);
  assert.match(brief, /\/no-mistakes skill/);
  assert.match(brief, /--intent/);
  assert.match(brief, /unsandboxed: sandboxed Bash breaks the gate's post-receive hook/);
  assert.match(brief, /never answer or bypass them yourself/);
  assert.match(brief, /copied VERBATIM into data\.noMistakes/);
  // The example curl posts to this task's own events endpoint with the shape.
  assert.match(brief, /tasks\/ship-the-thing-a1b2\/events/);
  assert.match(brief, /"data":\{"noMistakes":\{"step":"review","findings":/);
  assert.match(brief, /no-mistakes axi respond/);
});

test("every brief carries the never-end-a-turn-silently reporting clause", () => {
  for (const t of [task(), task({ kind: "scout" }), task({ mode: "no-mistakes" }), task({ mode: "local-only" })]) {
    const brief = dispatchBrief(t, undefined);
    assert.match(brief, /Never end a turn without reporting your current state/, `missing clause for ${t.kind}/${t.mode}`);
    assert.match(brief, /report working: naming what you are waiting on first/);
  }
});

test("a planId stamps the brief with the plan it builds from and the first-commit convention", () => {
  const brief = dispatchBrief(task({ planId: "docs/plans/2026-07-08-hub.md" }), "/tmp/wt");
  assert.match(brief, /builds from the finalized plan `docs\/plans\/2026-07-08-hub\.md`/);
  assert.match(brief, /commit it to docs\/plans\/<date>-<name>\.md as the FIRST commit/);
  // No planId, no plan section.
  assert.ok(!dispatchBrief(task(), "/tmp/wt").includes("builds from the finalized plan"));
});

test("a plan-edit brief points the worker at the staged file and the commit-as-revision flow", () => {
  const brief = dispatchBrief(task({ planId: "docs/plans/2026-07-08-hub.md" }), "/tmp/wt", {
    edit: { relativePath: "docs/plans/2026-07-08-hub.md", stagedPath: "/home/.perch/tasks/t/plan-edit.md" }
  });
  assert.match(brief, /PLAN EDIT/);
  assert.match(brief, /staged at \/home\/\.perch\/tasks\/t\/plan-edit\.md/);
  assert.match(brief, /Copy its contents to docs\/plans\/2026-07-08-hub\.md/);
  assert.match(brief, /commit ONLY that file as the FIRST commit/);
  assert.match(brief, /Every revision is a git commit/);
  // The edit section replaces the plain plan-build line (no double-briefing).
  assert.ok(!brief.includes("builds from the finalized plan"));
});

test("direct-PR and local-only briefs prohibit no-mistakes while scouts omit gate policy", () => {
  for (const t of [task(), task({ kind: "scout", mode: "no-mistakes" }), task({ mode: "local-only" })]) {
    const brief = dispatchBrief(t, undefined);
    assert.ok(!brief.includes("Ship through the no-mistakes gate"), `unexpected gate section for ${t.kind}/${t.mode}`);
    assert.ok(!brief.includes("data.noMistakes"));
  }
  const direct = dispatchBrief(task(), undefined);
  assert.match(direct, /No-mistakes is prohibited for this direct-PR task/);
  assert.match(direct, /ordinary task-specific tests, builds, and lint/);
  assert.match(direct, /existing gate remote/);

  const local = dispatchBrief(task({ mode: "local-only" }), undefined);
  assert.match(local, /No-mistakes is prohibited for this local-only task/);
  assert.match(local, /keep the work on the local task branch/);

  const gated = dispatchBrief(task({ mode: "no-mistakes" }), undefined);
  assert.ok(!gated.includes("No-mistakes is prohibited"));

  const scout = dispatchBrief(task({ kind: "scout", mode: "direct-PR" }), undefined);
  assert.ok(!scout.includes("No-mistakes is prohibited"));
});

test("the brief points chart authoring at the served guide, never a repo path", () => {
  const brief = dispatchBrief(task(), "/tmp/wt");
  assert.match(brief, /\$\{PERCH_HOOK_URL%\/hooks\}\/charts\/authoring/);
  // External users have no perch checkout to read.
  assert.ok(!brief.includes("apps/server/assets/charts/AUTHORING.md"));
});
