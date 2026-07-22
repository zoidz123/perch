import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PrPoller, extractPrUrl, type GhPrView } from "./prPoller.js";
import { TaskStore } from "./tasks.js";

function makeProject(home: string, remote = "https://github.com/o/r.git"): string {
  const project = mkdtempSync(join(home, "repo-"));
  execFileSync("git", ["init", "-q", project], { stdio: "pipe" });
  execFileSync("git", ["-C", project, "remote", "add", "origin", remote], { stdio: "pipe" });
  return project;
}

function view(overrides: Partial<GhPrView> = {}): GhPrView {
  return {
    state: "OPEN",
    headRefName: "perch/x",
    headRepository: { nameWithOwner: "o/r" },
    ...overrides
  };
}

test("poller flips checks then merged, exactly once each", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-poller-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const project = makeProject(home);
  const task = tasks.create({ title: "add version flag", project });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  tasks.recordEvent(task.id, { kind: "done", source: "worker" });
  tasks.update(task.id, { pr: { url: "https://github.com/o/r/pull/7" } });

  // Phase 1: checks pending -> no events. Phase 2: green. Phase 3: merged.
  const phases: GhPrView[] = [
    view({ statusCheckRollup: [{ name: "docs-gate", conclusion: "" }] }),
    view({ statusCheckRollup: [{ name: "docs-gate", conclusion: "SUCCESS" }] }),
    view({
      state: "MERGED",
      mergedAt: "2026-07-02T00:00:00Z",
      statusCheckRollup: [{ name: "docs-gate", conclusion: "SUCCESS" }]
    })
  ];
  let call = 0;
  const poller = new PrPoller(tasks, async () => phases[Math.min(call++, phases.length - 1)]);

  await poller.tick();
  assert.equal(tasks.find(task.id)?.pr?.checks, "pending");
  assert.deepEqual(tasks.find(task.id)?.pr?.checkDetails, [{ name: "docs-gate", state: "pending" }]);
  assert.equal(tasks.find(task.id)?.pr?.head, "perch/x");

  await poller.tick();
  assert.equal(tasks.find(task.id)?.pr?.checks, "passing");
  assert.deepEqual(tasks.find(task.id)?.pr?.checkDetails, [{ name: "docs-gate", state: "passing" }]);
  assert.equal(tasks.find(task.id)?.state, "done");

  await poller.tick();
  const landed = tasks.find(task.id);
  assert.equal(landed?.pr?.merged, true);
  assert.equal(landed?.state, "landed");

  // Landed tasks stop polling entirely; a fourth tick emits nothing new.
  const eventsBefore = tasks.events(task.id).length;
  await poller.tick();
  assert.equal(tasks.events(task.id).length, eventsBefore);
  const kinds = tasks.events(task.id).map((event) => event.kind);
  assert.equal(kinds.filter((kind) => kind === "checks_green").length, 1);
  assert.equal(kinds.filter((kind) => kind === "merged").length, 1);

  rmSync(home, { recursive: true, force: true });
});

test("merge readiness stays false for draft PRs even when checks pass", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-poller-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const task = tasks.create({ title: "draft pr", project: "/tmp/repo" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  tasks.recordEvent(task.id, { kind: "done", source: "worker" });
  tasks.update(task.id, {
    branch: "perch/draft-pr",
    pr: { url: "https://github.com/o/r/pull/20" }
  });

  const poller = new PrPoller(
    tasks,
    async () =>
      ({
        state: "OPEN",
        headRefName: "perch/draft-pr",
        statusCheckRollup: [{ conclusion: "SUCCESS" }],
        isDraft: true,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED"
      }) as never,
    { resolveLocalRepo: async () => "o/r" }
  );

  await poller.tick();
  assert.equal(tasks.find(task.id)?.pr?.checks, "passing");
  assert.equal(tasks.find(task.id)?.pr?.mergeReady, false);
  const kinds = tasks.events(task.id).map((event) => event.kind);
  assert.equal(kinds.filter((kind) => kind === "checks_green").length, 1);
  assert.equal(kinds.filter((kind) => kind === "merge_ready").length, 0);

  rmSync(home, { recursive: true, force: true });
});

test("merge readiness stays false for changes-requested or review-required PRs", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-poller-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const makeTask = (title: string, url: string) => {
    const task = tasks.create({ title, project: "/tmp/repo" });
    tasks.recordEvent(task.id, { kind: "working", source: "worker" });
    tasks.recordEvent(task.id, { kind: "done", source: "worker" });
    return tasks.update(task.id, { branch: `perch/${title}`, pr: { url } });
  };
  const changesRequested = makeTask("changes-requested", "https://github.com/o/r/pull/21");
  const reviewRequired = makeTask("review-required", "https://github.com/o/r/pull/22");

  const poller = new PrPoller(
    tasks,
    async (url) =>
      ({
        state: "OPEN",
        headRefName: url.endsWith("/21") ? "perch/changes-requested" : "perch/review-required",
        statusCheckRollup: [{ conclusion: "SUCCESS" }],
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: url.endsWith("/21") ? "CHANGES_REQUESTED" : "REVIEW_REQUIRED"
      }) as never,
    { resolveLocalRepo: async () => "o/r" }
  );

  await poller.tick();
  assert.equal(tasks.find(changesRequested.id)?.pr?.mergeReady, false);
  assert.equal(tasks.find(reviewRequired.id)?.pr?.mergeReady, false);
  const kinds = [...tasks.events(changesRequested.id), ...tasks.events(reviewRequired.id)].map((event) => event.kind);
  assert.equal(kinds.filter((kind) => kind === "merge_ready").length, 0);

  rmSync(home, { recursive: true, force: true });
});

test("merge readiness stays false for blocked or dirty merge state", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-poller-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const makeTask = (title: string, url: string) => {
    const task = tasks.create({ title, project: "/tmp/repo" });
    tasks.recordEvent(task.id, { kind: "working", source: "worker" });
    tasks.recordEvent(task.id, { kind: "done", source: "worker" });
    return tasks.update(task.id, { branch: `perch/${title}`, pr: { url } });
  };
  const blocked = makeTask("blocked", "https://github.com/o/r/pull/23");
  const dirty = makeTask("dirty", "https://github.com/o/r/pull/24");

  const poller = new PrPoller(
    tasks,
    async (url) =>
      ({
        state: "OPEN",
        headRefName: url.endsWith("/23") ? "perch/blocked" : "perch/dirty",
        statusCheckRollup: [{ conclusion: "SUCCESS" }],
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: url.endsWith("/23") ? "BLOCKED" : "DIRTY",
        reviewDecision: "APPROVED"
      }) as never,
    { resolveLocalRepo: async () => "o/r" }
  );

  await poller.tick();
  assert.equal(tasks.find(blocked.id)?.pr?.mergeReady, false);
  assert.equal(tasks.find(dirty.id)?.pr?.mergeReady, false);
  const kinds = [...tasks.events(blocked.id), ...tasks.events(dirty.id)].map((event) => event.kind);
  assert.equal(kinds.filter((kind) => kind === "merge_ready").length, 0);

  rmSync(home, { recursive: true, force: true });
});

test("merge readiness requires the expected repo and branch", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-poller-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const wrongRepo = tasks.create({ title: "wrong repo", project: "/tmp/repo" });
  tasks.recordEvent(wrongRepo.id, { kind: "working", source: "worker" });
  tasks.recordEvent(wrongRepo.id, { kind: "done", source: "worker" });
  tasks.update(wrongRepo.id, { branch: "perch/right-branch", pr: { url: "https://github.com/o/other/pull/25" } });
  const wrongBranch = tasks.create({ title: "wrong branch", project: "/tmp/repo" });
  tasks.recordEvent(wrongBranch.id, { kind: "working", source: "worker" });
  tasks.recordEvent(wrongBranch.id, { kind: "done", source: "worker" });
  tasks.update(wrongBranch.id, { branch: "perch/right-branch", pr: { url: "https://github.com/o/r/pull/26" } });

  const poller = new PrPoller(
    tasks,
    async (url) =>
      ({
        state: "OPEN",
        headRefName: url.endsWith("/25") ? "perch/right-branch" : "perch/other-branch",
        statusCheckRollup: [{ conclusion: "SUCCESS" }],
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED"
      }) as never,
    { resolveLocalRepo: async () => "o/r" }
  );

  await poller.tick();
  assert.equal(tasks.find(wrongRepo.id)?.pr?.mergeReady, false);
  assert.equal(tasks.find(wrongBranch.id)?.pr?.mergeReady, false);
  const kinds = [...tasks.events(wrongRepo.id), ...tasks.events(wrongBranch.id)].map((event) => event.kind);
  assert.equal(kinds.filter((kind) => kind === "merge_ready").length, 0);

  rmSync(home, { recursive: true, force: true });
});

test("merge readiness turns true and emits merge_ready for a green ready PR", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-poller-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const task = tasks.create({ title: "ready pr", project: "/tmp/repo" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  tasks.recordEvent(task.id, { kind: "done", source: "worker" });
  tasks.update(task.id, {
    branch: "perch/ready-pr",
    pr: { url: "https://github.com/o/r/pull/27" }
  });

  const poller = new PrPoller(
    tasks,
    async () =>
      ({
        state: "OPEN",
        headRefName: "perch/ready-pr",
        statusCheckRollup: [{ conclusion: "SUCCESS" }],
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED"
      }) as never,
    { resolveLocalRepo: async () => "o/r" }
  );

  await poller.tick();
  const updated = tasks.find(task.id);
  assert.equal(updated?.state, "done");
  assert.equal(updated?.pr?.checks, "passing");
  assert.equal(updated?.pr?.mergeReady, true);
  assert.equal(updated?.pr?.isDraft, false);
  assert.equal(updated?.pr?.mergeable, "MERGEABLE");
  assert.equal(updated?.pr?.mergeStateStatus, "CLEAN");
  assert.equal(updated?.pr?.reviewDecision, "APPROVED");
  const kinds = tasks.events(task.id).map((event) => event.kind);
  assert.equal(kinds.filter((kind) => kind === "checks_green").length, 1);
  assert.equal(kinds.filter((kind) => kind === "merge_ready").length, 1);

  const eventsBefore = tasks.events(task.id).length;
  await poller.tick();
  assert.equal(tasks.events(task.id).length, eventsBefore);

  rmSync(home, { recursive: true, force: true });
});

test("gh failures are silent and non-fatal", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-poller-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const project = makeProject(home);
  const task = tasks.create({ title: "x", project });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  tasks.recordEvent(task.id, { kind: "done", source: "worker" });
  tasks.update(task.id, { pr: { url: "https://github.com/o/r/pull/8" } });

  const poller = new PrPoller(tasks, async () => undefined);
  await poller.tick();
  assert.equal(tasks.find(task.id)?.state, "done");

  rmSync(home, { recursive: true, force: true });
});

test("poller refuses to merge a PR whose repo or head branch does not match the task", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-poller-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const project = makeProject(home);

  const wrongBranch = tasks.create({ title: "wrong branch", project });
  tasks.recordEvent(wrongBranch.id, { kind: "working", source: "worker" });
  tasks.recordEvent(wrongBranch.id, { kind: "done", source: "worker" });
  tasks.update(wrongBranch.id, {
    branch: "perch/expected",
    pr: { url: "https://github.com/o/r/pull/20" }
  });

  const wrongRepo = tasks.create({ title: "wrong repo", project });
  tasks.recordEvent(wrongRepo.id, { kind: "working", source: "worker" });
  tasks.recordEvent(wrongRepo.id, { kind: "done", source: "worker" });
  tasks.update(wrongRepo.id, {
    branch: "perch/expected",
    pr: { url: "https://github.com/o/other/pull/21" }
  });

  const poller = new PrPoller(tasks, async (url) => {
    if (url.endsWith("/pull/20")) {
      return view({ state: "MERGED", mergedAt: "2026-07-02T00:00:00Z", headRefName: "perch/other" });
    }
    return view({
      state: "MERGED",
      mergedAt: "2026-07-02T00:00:00Z",
      headRefName: "perch/expected",
      headRepository: { nameWithOwner: "o/other" }
    });
  });

  await poller.tick();

  assert.equal(tasks.find(wrongBranch.id)?.state, "done");
  assert.equal(tasks.find(wrongBranch.id)?.pr?.merged, undefined);
  assert.equal(tasks.find(wrongRepo.id)?.state, "done");
  assert.equal(tasks.find(wrongRepo.id)?.pr?.merged, undefined);

  rmSync(home, { recursive: true, force: true });
});

test("adaptive cadence: fast window polls armed PRs, decays when stable, re-arms on pending", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-poller-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const project = makeProject(home);
  const task = tasks.create({ title: "fast lane", project });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  tasks.recordEvent(task.id, { kind: "done", source: "worker" });
  tasks.update(task.id, { pr: { url: "https://github.com/o/r/pull/9" } });
  const idle = tasks.create({ title: "not armed", project });
  tasks.recordEvent(idle.id, { kind: "working", source: "worker" });
  tasks.recordEvent(idle.id, { kind: "done", source: "worker" });
  tasks.update(idle.id, { pr: { url: "https://github.com/o/r/pull/10" } });

  let clock = 1_000_000;
  const polled: string[] = [];
  let rollup = { conclusion: "" }; // pending
  const poller = new PrPoller(
    tasks,
    async (url) => {
      polled.push(url);
      return view({ statusCheckRollup: [rollup] });
    },
    { now: () => clock, fastWindowMs: 60_000 }
  );

  // Nothing armed: the fast lane makes zero gh calls.
  await poller.fastTick();
  assert.equal(polled.length, 0);

  // Armed (PR just attached): only the armed PR is polled; pending checks
  // slide the window forward.
  poller.armFast(task.id);
  await poller.fastTick();
  assert.deepEqual(polled, ["https://github.com/o/r/pull/9"]);

  // Past the ORIGINAL window (armed at t0, now t0+50s+50s), but each pending
  // pass re-armed it: still fast.
  clock += 50_000;
  await poller.fastTick();
  clock += 50_000;
  rollup = { conclusion: "SUCCESS" };
  await poller.fastTick();
  assert.equal(polled.length, 3);
  assert.equal(tasks.find(task.id)?.pr?.checks, "passing");

  // Settled checks stop re-arming: after the window lapses, the fast lane
  // goes quiet again (the 5 min baseline still covers the PR).
  clock += 90_000;
  await poller.fastTick();
  assert.equal(polled.length, 3);

  rmSync(home, { recursive: true, force: true });
});

test("a merge arms the fast window for sibling PRs in the same repo (merge-train)", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-poller-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const project = makeProject(home);
  const otherProject = makeProject(home, "https://github.com/o/z.git");
  const makeDone = (title: string, url: string, taskProject = project) => {
    const task = tasks.create({ title, project: taskProject });
    tasks.recordEvent(task.id, { kind: "working", source: "worker" });
    tasks.recordEvent(task.id, { kind: "done", source: "worker" });
    return tasks.update(task.id, { pr: { url } });
  };
  const merging = makeDone("first in train", "https://github.com/o/r/pull/11");
  makeDone("second in train", "https://github.com/o/r/pull/12");
  makeDone("other repo", "https://github.com/o/z/pull/1", otherProject);

  const clock = 1_000_000;
  const polled: string[] = [];
  const poller = new PrPoller(
    tasks,
    async (url) => {
      polled.push(url);
      if (url.endsWith("/pull/11")) {
        return view({ state: "MERGED", mergedAt: "2026-07-06T00:00:00Z" });
      }
      if (url.includes("/o/z/")) {
        return view({ headRepository: { nameWithOwner: "o/z" }, statusCheckRollup: [{ conclusion: "SUCCESS" }] });
      }
      return view({ statusCheckRollup: [{ conclusion: "SUCCESS" }] });
    },
    { now: () => clock, fastWindowMs: 60_000 }
  );

  // Baseline pass observes the merge; the same-repo sibling gets the fast
  // lane, the other repo's PR does not.
  await poller.tick();
  assert.equal(tasks.find(merging.id)?.state, "landed");

  polled.length = 0;
  await poller.fastTick();
  assert.deepEqual(polled, ["https://github.com/o/r/pull/12"]);

  rmSync(home, { recursive: true, force: true });
});

test("awaiting-merge fast cadence survives restart after readiness regresses", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-poller-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const task = tasks.create({ title: "restart latch", project: "/tmp/repo" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  tasks.recordEvent(task.id, { kind: "done", source: "worker" });
  tasks.update(task.id, {
    branch: "perch/restart-latch",
    pr: { url: "https://github.com/o/r/pull/31" }
  });

  let clock = 1_000_000;
  let phase: "ready" | "regressed" | "merged" = "ready";
  let polls = 0;
  const runGh = async (): Promise<GhPrView> => {
    polls += 1;
    return view({
      state: phase === "merged" ? "MERGED" : "OPEN",
      mergedAt: phase === "merged" ? "2026-07-22T00:00:00Z" : null,
      headRefName: "perch/restart-latch",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
      isDraft: false,
      mergeable: phase === "regressed" ? "UNKNOWN" : "MERGEABLE",
      mergeStateStatus: phase === "regressed" ? "UNKNOWN" : "CLEAN",
      reviewDecision: "APPROVED"
    });
  };
  const options = {
    now: () => clock,
    fastWindowMs: 60_000,
    resolveLocalRepo: async () => "o/r"
  };

  const poller = new PrPoller(tasks, runGh, options);
  poller.armFast(task.id);
  await poller.fastTick();
  clock += 60_001;
  phase = "regressed";
  await poller.fastTick();
  assert.equal(tasks.find(task.id)?.pr?.mergeReady, false);
  assert.equal(tasks.find(task.id)?.pr?.awaitingMerge, true);

  phase = "merged";
  const restarted = new PrPoller(tasks, runGh, options);
  await restarted.fastTick();

  assert.equal(polls, 3);
  assert.equal(tasks.find(task.id)?.state, "landed");
  assert.equal(tasks.find(task.id)?.pr?.awaitingMerge, false);

  rmSync(home, { recursive: true, force: true });
});

test("identity-incomplete terminal response clears awaiting-merge cadence only", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-poller-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const task = tasks.create({ title: "terminal latch", project: "/tmp/repo" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  tasks.recordEvent(task.id, { kind: "done", source: "worker" });
  tasks.update(task.id, {
    branch: "perch/terminal-latch",
    pr: { url: "https://github.com/o/r/pull/32" }
  });

  let clock = 1_000_000;
  let terminal = false;
  let polls = 0;
  const poller = new PrPoller(
    tasks,
    async () => {
      polls += 1;
      if (terminal) {
        return { state: "CLOSED" };
      }
      return view({
        headRefName: "perch/terminal-latch",
        statusCheckRollup: [{ conclusion: "SUCCESS" }],
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED"
      });
    },
    { now: () => clock, fastWindowMs: 60_000, resolveLocalRepo: async () => "o/r" }
  );

  poller.armFast(task.id);
  await poller.fastTick();
  clock += 60_001;
  terminal = true;
  await poller.fastTick();

  assert.equal(tasks.find(task.id)?.pr?.awaitingMerge, false);
  assert.equal(tasks.find(task.id)?.pr?.merged, undefined);
  assert.equal(tasks.find(task.id)?.state, "done");
  assert.equal(tasks.events(task.id).filter((event) => event.kind === "merged").length, 0);

  await poller.fastTick();
  assert.equal(polls, 2);

  rmSync(home, { recursive: true, force: true });
});

test("resolveTaskPr binds a reused branch when the PR head commit is the checkout HEAD", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-poller-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const created = tasks.create({ title: "reuse", project: "/tmp/repo" });
  const task = tasks.update(created.id, { branch: "perch/reuse" });

  // The worker delivered on a pre-existing branch (head != the task branch),
  // but the PR head commit equals the worker's checkout HEAD - proof it carries
  // the worker's commits, so the branch-name difference must not 409.
  const poller = new PrPoller(
    tasks,
    async () =>
      ({
        state: "OPEN",
        headRefName: "feature/pre-existing",
        headRefOid: "deadbeef",
        headRepository: { nameWithOwner: "o/r" }
      }) as never,
    { resolveLocalRepo: async () => "o/r", resolveHead: async () => "deadbeef" }
  );

  const attachment = await poller.resolveTaskPr(task, "https://github.com/o/r/pull/50", "/tmp/checkout");
  assert.equal(attachment.ok, true);
  assert.equal(attachment.ok && attachment.pr.head, "feature/pre-existing");
  assert.equal(attachment.ok && attachment.pr.headOid, "deadbeef");
  assert.equal(attachment.ok && attachment.pr.repo, "o/r");

  rmSync(home, { recursive: true, force: true });
});

test("resolveTaskPr refuses a same-repo PR whose head commit is not the checkout HEAD", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-poller-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const created = tasks.create({ title: "arbitrary", project: "/tmp/repo" });
  const task = tasks.update(created.id, { branch: "perch/arbitrary" });

  // A resolvable checkout HEAD but a PR pointing elsewhere: the gate must not
  // weaken into accepting an arbitrary same-repo URL.
  const poller = new PrPoller(
    tasks,
    async () =>
      ({
        state: "OPEN",
        headRefName: "someone/else",
        headRefOid: "cafef00d",
        headRepository: { nameWithOwner: "o/r" }
      }) as never,
    { resolveLocalRepo: async () => "o/r", resolveHead: async () => "deadbeef" }
  );

  const attachment = await poller.resolveTaskPr(task, "https://github.com/o/r/pull/51", "/tmp/checkout");
  assert.equal(attachment.ok, false);
  assert.match(attachment.ok ? "" : attachment.reason, /does not match checkout HEAD/);

  rmSync(home, { recursive: true, force: true });
});

test("resolveTaskPr falls back to task-branch binding when the checkout HEAD is unreadable", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-poller-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const created = tasks.create({ title: "fallback", project: "/tmp/repo" });
  const task = tasks.update(created.id, { branch: "perch/fallback" });

  // No readable checkout HEAD (git failed): a reused-branch PR can no longer be
  // proven to carry the worker's commits, so it falls back to the deterministic
  // task-branch binding and refuses a mismatched head.
  const mismatched = new PrPoller(
    tasks,
    async () =>
      ({ state: "OPEN", headRefName: "feature/other", headRepository: { nameWithOwner: "o/r" } }) as never,
    { resolveLocalRepo: async () => "o/r", resolveHead: async () => undefined }
  );
  const refused = await mismatched.resolveTaskPr(task, "https://github.com/o/r/pull/52", "/tmp/checkout");
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.reason, /head branch/);

  // The task branch itself still binds without a readable HEAD (unchanged path).
  const onBranch = new PrPoller(
    tasks,
    async () =>
      ({ state: "OPEN", headRefName: "perch/fallback", headRepository: { nameWithOwner: "o/r" } }) as never,
    { resolveLocalRepo: async () => "o/r", resolveHead: async () => undefined }
  );
  const accepted = await onBranch.resolveTaskPr(task, "https://github.com/o/r/pull/53", "/tmp/checkout");
  assert.equal(accepted.ok, true);
  assert.equal(accepted.ok && accepted.pr.head, "perch/fallback");

  rmSync(home, { recursive: true, force: true });
});

test("poller tracks a reused-branch PR through checks_green and merged", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-poller-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const project = makeProject(home);
  const task = tasks.create({ title: "reused poll", project });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  tasks.recordEvent(task.id, { kind: "done", source: "worker" });
  // Accepted on a reused branch: task branch differs from the recorded pr.head.
  tasks.update(task.id, {
    branch: "perch/reused-poll",
    pr: { url: "https://github.com/o/r/pull/60", repo: "o/r", headRepo: "o/r", head: "feature/reused" }
  });

  const phases: GhPrView[] = [
    view({ headRefName: "feature/reused", statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }] }),
    view({
      headRefName: "feature/reused",
      state: "MERGED",
      mergedAt: "2026-07-10T00:00:00Z",
      statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }]
    })
  ];
  let call = 0;
  const poller = new PrPoller(tasks, async () => phases[Math.min(call++, phases.length - 1)]);

  await poller.tick();
  assert.equal(tasks.find(task.id)?.pr?.checks, "passing");
  await poller.tick();
  const landed = tasks.find(task.id);
  assert.equal(landed?.pr?.merged, true);
  assert.equal(landed?.state, "landed");
  const kinds = tasks.events(task.id).map((event) => event.kind);
  assert.equal(kinds.filter((kind) => kind === "checks_green").length, 1);
  assert.equal(kinds.filter((kind) => kind === "merged").length, 1);

  rmSync(home, { recursive: true, force: true });
});

test("poller independently discovers and finishes a PR from a needs_you task exactly once", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-poller-discovery-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const task = tasks.create({ title: "live PR without report", project: "/repo" });
  tasks.update(task.id, {
    sessionId: "pty:worker",
    branch: "perch/live-pr",
    worktreeId: "slot-4"
  });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  tasks.recordEvent(task.id, {
    kind: "needs_decision",
    source: "worker",
    message: "hook report later failed"
  });
  const checkoutPaths: string[] = [];
  const poller = new PrPoller(
    tasks,
    async () =>
      view({
        headRefName: "perch/live-pr",
        headRefOid: "deadbeef",
        createdAt: "2099-01-01T00:00:00.000Z",
        statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }],
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN"
      }),
    {
      resolveLocalRepo: async () => "o/r",
      findPr: async () => ["https://github.com/o/r/pull/147"],
      resolveHead: async (path) => {
        checkoutPaths.push(path);
        return "deadbeef";
      },
      resolveCheckout: () => "/worktrees/slot-4"
    }
  );

  await poller.tick();
  assert.equal(tasks.find(task.id)?.state, "completion_requested");
  assert.equal(tasks.find(task.id)?.pr?.url, "https://github.com/o/r/pull/147");
  assert.deepEqual(checkoutPaths, ["/worktrees/slot-4"]);
  assert.equal(
    tasks.events(task.id).filter((event) => event.kind === "completion_requested").length,
    1,
    "the independent PR attachment produces one mate-waking completion request"
  );
  assert.equal(tasks.events(task.id).filter((event) => event.kind === "merge_ready").length, 1);

  await poller.tick();
  assert.equal(tasks.events(task.id).filter((event) => event.kind === "completion_requested").length, 1);
  assert.equal(tasks.events(task.id).filter((event) => event.kind === "merge_ready").length, 1);
  rmSync(home, { recursive: true, force: true });
});

test("poller does not overwrite a worker park with a PR that already existed", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-poller-discovery-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const task = tasks.create({ title: "deliberately blocked", project: "/repo" });
  tasks.update(task.id, { branch: "perch/blocked" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  tasks.recordEvent(task.id, {
    kind: "blocked",
    source: "worker",
    message: "need the boss to unlock CI"
  });
  const poller = new PrPoller(
    tasks,
    async () =>
      view({
        headRefName: "perch/blocked",
        headRefOid: "deadbeef",
        createdAt: "2000-01-01T00:00:00.000Z"
      }),
    {
      resolveLocalRepo: async () => "o/r",
      findPr: async () => ["https://github.com/o/r/pull/1"],
      resolveHead: async () => "deadbeef"
    }
  );

  await poller.tick();
  assert.equal(tasks.find(task.id)?.state, "blocked");
  assert.equal(tasks.find(task.id)?.pr, undefined);
  assert.equal(tasks.events(task.id).filter((event) => event.kind === "done").length, 0);
  rmSync(home, { recursive: true, force: true });
});

test("a trailing worker note does not surrender the park to the discovery sweep", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-poller-discovery-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const task = tasks.create({ title: "deliberately blocked", project: "/repo" });
  tasks.update(task.id, { branch: "perch/blocked" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  tasks.recordEvent(task.id, {
    kind: "blocked",
    source: "worker",
    message: "need the boss to unlock CI"
  });
  tasks.recordEvent(task.id, {
    kind: "note",
    source: "worker",
    message: "attached the failing CI log"
  });
  const poller = new PrPoller(
    tasks,
    async () =>
      view({
        headRefName: "perch/blocked",
        headRefOid: "deadbeef",
        createdAt: "2000-01-01T00:00:00.000Z"
      }),
    {
      resolveLocalRepo: async () => "o/r",
      findPr: async () => ["https://github.com/o/r/pull/1"],
      resolveHead: async () => "deadbeef"
    }
  );

  await poller.tick();
  assert.equal(tasks.find(task.id)?.state, "blocked");
  assert.equal(tasks.find(task.id)?.pr, undefined);
  assert.equal(tasks.events(task.id).filter((event) => event.kind === "done").length, 0);
  rmSync(home, { recursive: true, force: true });
});

test("a worker park landing during discovery verification wins over the sweep's done", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-poller-discovery-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const task = tasks.create({ title: "parks mid-discovery", project: "/repo" });
  tasks.update(task.id, { branch: "perch/racing" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  const poller = new PrPoller(
    tasks,
    async () =>
      view({
        headRefName: "perch/racing",
        headRefOid: "deadbeef",
        createdAt: "2000-01-01T00:00:00.000Z"
      }),
    {
      resolveLocalRepo: async () => "o/r",
      findPr: async () => ["https://github.com/o/r/pull/2"],
      // The park verb races the sweep's awaited gh/git verification calls.
      resolveHead: async () => {
        tasks.recordEvent(task.id, {
          kind: "blocked",
          source: "worker",
          message: "hit a decision point"
        });
        return "deadbeef";
      }
    }
  );

  await poller.tick();
  assert.equal(tasks.find(task.id)?.state, "blocked");
  assert.equal(tasks.find(task.id)?.pr, undefined);
  assert.equal(tasks.events(task.id).filter((event) => event.kind === "done").length, 0);
  rmSync(home, { recursive: true, force: true });
});

test("a worker done binding a different PR during discovery verification is never overwritten", async () => {
  // resolveTaskPr explicitly admits reused branches, so the worker's done may
  // name a different PR than the branch-discovered one. The sweep must reload
  // and stand down instead of clobbering the worker's attachment.
  const home = mkdtempSync(join(tmpdir(), "perch-poller-discovery-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const task = tasks.create({ title: "worker reports mid-discovery", project: "/repo" });
  tasks.update(task.id, { branch: "perch/racing" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  const poller = new PrPoller(
    tasks,
    async () =>
      view({
        headRefName: "perch/racing",
        headRefOid: "deadbeef",
        createdAt: "2000-01-01T00:00:00.000Z"
      }),
    {
      resolveLocalRepo: async () => "o/r",
      findPr: async () => ["https://github.com/o/r/pull/2"],
      // The worker's done verb (with its own PR attachment) races the sweep's
      // awaited verification calls.
      resolveHead: async () => {
        tasks.update(task.id, {
          pr: { url: "https://github.com/o/r/pull/3", repo: "o/r", headRepo: "o/r" }
        });
        tasks.recordEvent(task.id, {
          kind: "done",
          source: "worker",
          message: "PR https://github.com/o/r/pull/3"
        });
        return "deadbeef";
      }
    }
  );

  await poller.tick();
  const current = tasks.find(task.id);
  assert.equal(current?.state, "done");
  assert.equal(current?.pr?.url, "https://github.com/o/r/pull/3");
  assert.equal(tasks.events(task.id).filter((event) => event.kind === "done").length, 1);
  rmSync(home, { recursive: true, force: true });
});

test("a worker failed verb during discovery verification takes no attachment or done", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-poller-discovery-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const task = tasks.create({ title: "fails mid-discovery", project: "/repo" });
  tasks.update(task.id, { branch: "perch/racing" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });
  const poller = new PrPoller(
    tasks,
    async () =>
      view({
        headRefName: "perch/racing",
        headRefOid: "deadbeef",
        createdAt: "2000-01-01T00:00:00.000Z"
      }),
    {
      resolveLocalRepo: async () => "o/r",
      findPr: async () => ["https://github.com/o/r/pull/2"],
      resolveHead: async () => {
        tasks.recordEvent(task.id, {
          kind: "failed",
          source: "worker",
          message: "cannot reproduce"
        });
        return "deadbeef";
      }
    }
  );

  await poller.tick();
  const current = tasks.find(task.id);
  assert.equal(current?.state, "failed");
  assert.equal(current?.pr, undefined);
  assert.equal(tasks.events(task.id).filter((event) => event.kind === "done").length, 0);
  rmSync(home, { recursive: true, force: true });
});

test("resolveTaskPr refuses a PR closed without merging but binds a merged one", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-poller-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const created = tasks.create({ title: "closed pr", project: "/tmp/repo" });
  const task = tasks.update(created.id, { branch: "perch/closed" });

  const closed = new PrPoller(
    tasks,
    async () => view({ state: "CLOSED", headRefName: "perch/closed", headRefOid: "deadbeef" }),
    { resolveLocalRepo: async () => "o/r", resolveHead: async () => "deadbeef" }
  );
  const refused = await closed.resolveTaskPr(task, "https://github.com/o/r/pull/70", "/tmp/checkout");
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.reason, /closed without merging/);

  // The fast-merge race: a PR that merged before the done verb still binds.
  const merged = new PrPoller(
    tasks,
    async () =>
      view({
        state: "MERGED",
        mergedAt: "2026-07-10T00:00:00Z",
        headRefName: "perch/closed",
        headRefOid: "deadbeef"
      }),
    { resolveLocalRepo: async () => "o/r", resolveHead: async () => "deadbeef" }
  );
  const accepted = await merged.resolveTaskPr(task, "https://github.com/o/r/pull/71", "/tmp/checkout");
  assert.equal(accepted.ok, true);
  rmSync(home, { recursive: true, force: true });
});

test("extractPrUrl finds the first PR link in a done message", () => {
  assert.equal(
    extractPrUrl("shipped: https://github.com/example/perch/pull/13 (second https://github.com/x/y/pull/1)"),
    "https://github.com/example/perch/pull/13"
  );
  assert.equal(extractPrUrl("no url here"), undefined);
  assert.equal(extractPrUrl(undefined), undefined);
});
