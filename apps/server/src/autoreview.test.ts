import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AutoReviewService,
  createFocusedTestEnvironment,
  sanitizeFocusedTestArgv,
  validateFocusedTestArgv,
  type AutoReviewRunner
} from "./autoreview.js";
import { autoReviewAssetRoot, resolveBundledAutoReview } from "./autoreviewRuntime.js";
import { DeliveryService } from "./delivery.js";
import { TaskStore } from "./tasks.js";

type Fixture = ReturnType<typeof fixture>;

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "perch-autoreview-home-"));
  const repo = mkdtempSync(join(tmpdir(), "perch-autoreview-repo-"));
  const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.email", "review@example.test"]);
  git(["config", "user.name", "AutoReview test"]);
  writeFileSync(join(repo, "app.txt"), "base\n");
  writeFileSync(join(repo, "focused-test.mjs"), [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    `test("focused test has an isolated home", () => assert.notEqual(process.env.HOME, ${JSON.stringify(process.env.HOME ?? "")}));`,
    ""
  ].join("\n"));
  git(["add", "app.txt", "focused-test.mjs"]);
  git(["commit", "-qm", "base"]);
  writeFileSync(join(repo, "app.txt"), "review target\n");
  git(["commit", "-am", "review target", "-q"]);

  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const task = tasks.create({ title: "review a branch", project: repo, kind: "ship" });
  const runtime = tasks.stateDb.runtimes.create({
    id: "runtime-autoreview",
    taskId: task.id,
    generation: 2,
    state: "live",
    agent: "codex",
    provider: "codex",
    ptySessionId: "pty:root",
    worktreePath: repo
  });
  return { home, repo, tasks, task, runtime };
}

function input(value: Fixture, idempotencyKey: string, supersedesAttemptId?: string, baseRef = "HEAD~1") {
  return {
    task: value.task,
    runtime: value.runtime,
    sessionId: "pty:root",
    worktreePath: value.repo,
    baseRef,
    idempotencyKey,
    testArgv: ["node", "--test", "focused-test.mjs"],
    ...(supersedesAttemptId ? { supersedesAttemptId } : {})
  };
}

function cleanup(value: Fixture): void {
  value.tasks.close();
  rmSync(value.home, { recursive: true, force: true });
  rmSync(value.repo, { recursive: true, force: true });
}

const HELPER_DRIVER = [
  "import importlib.machinery",
  "import importlib.util",
  "import pathlib",
  "import subprocess",
  "import sys",
  "sys.dont_write_bytecode = True",
  "loader = importlib.machinery.SourceFileLoader('perch_autoreview_helper', sys.argv[1])",
  "spec = importlib.util.spec_from_loader(loader.name, loader)",
  "helper = importlib.util.module_from_spec(spec)",
  "loader.exec_module(helper)",
  "repo = pathlib.Path(sys.argv[2])",
  "if sys.argv[3] == 'bundle':",
  "    bundle, _truncated = helper.branch_bundle(repo, 'HEAD~1')",
  "    sys.stdout.write(bundle)",
  "elif sys.argv[3] == 'detected-secret':",
  "    needle = 'gh' + 'p_'",
  "    real_find_command = helper.find_command",
  "    helper.find_command = lambda name, target: '/fixture/trufflehog' if name == 'trufflehog' else real_find_command(name, target)",
  "    real_run = helper.run",
  "    def detected(command, *_args, **_kwargs):",
  "        if command[0] != '/fixture/trufflehog':",
  "            return real_run(command, *_args, **_kwargs)",
  "        scan_repo = pathlib.Path(command[2].removeprefix('file://'))",
  "        history = helper.git(scan_repo, 'log', '-p', '--all')",
  "        if needle not in history:",
  "            raise AssertionError('fixture secret was not materialized for scanning')",
  "        return subprocess.CompletedProcess(command, helper.TRUFFLEHOG_FINDINGS_EXIT_CODE, '', '')",
  "    helper.run = detected",
  "    helper.run_trufflehog_preflight(repo, 'branch', 'HEAD~1', 'HEAD')",
  "else:",
  "    raise AssertionError('unknown driver mode')"
].join("\n");

function helperReviewFixture(base: string | Buffer | undefined, reviewed: string | Buffer | undefined): string {
  const repo = mkdtempSync(join(tmpdir(), "perch-autoreview-helper-"));
  const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.email", "review@example.test"]);
  git(["config", "user.name", "AutoReview test"]);
  writeFileSync(join(repo, "baseline.txt"), "base\n");
  if (base !== undefined) writeFileSync(join(repo, "fixture.ts"), base);
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  if (reviewed === undefined) {
    git(["rm", "-q", "fixture.ts"]);
  } else {
    writeFileSync(join(repo, "fixture.ts"), reviewed);
    git(["add", "fixture.ts"]);
  }
  git(["commit", "-qm", "reviewed"]);
  return repo;
}

function runHelperDriver(repo: string, mode: "bundle" | "detected-secret") {
  return spawnSync("python3", [
    "-c",
    HELPER_DRIVER,
    join(autoReviewAssetRoot(), "skill", "scripts", "autoreview"),
    repo,
    mode
  ], { encoding: "utf8" });
}

test("bundled AutoReview verifies package-owned bytes and rejects tampering", () => {
  const bundled = resolveBundledAutoReview();
  assert.match(bundled.root, /assets[\\/]autoreview$/);
  assert.doesNotMatch(bundled.root, /[\\/]\.agents[\\/]|[\\/]\.codex[\\/]|[\\/]\.claude[\\/]/);
  assert.equal(bundled.manifest.source.commit, "2a409d348a4bcf6f15e41e9a20efd0b298a32528");
  assert.deepEqual(bundled.manifest.excludedFiles.map((entry) => entry.path), [
    "skill/scripts/autoreview_test.py",
    "skill/tests/fixtures/typescript-benign-config-path-references.ts",
    "skill/tests/fixtures/typescript-benign-references.ts",
    "skill/tests/fixtures/typescript-sensitive-literals.ts",
    "skill/tests/test_autoreview_hardening.py"
  ]);
  for (const excluded of bundled.manifest.excludedFiles) {
    assert.equal(existsSync(join(bundled.root, excluded.path)), false, `${excluded.path} must never ship`);
  }

  const manifest = JSON.parse(readFileSync(join(bundled.root, "manifest.json"), "utf8")) as {
    version: string;
    deviations: Array<{
      baseUpstreamCommit: string;
      baseSha256: string;
      patchedSha256: string;
      patchPath: string;
      patchSha256: string;
      patched: string[];
      reason: string;
    }>;
  };
  assert.equal(manifest.version, "2a409d348a4bcf6f15e41e9a20efd0b298a32528+perch-deletion-handling.1");
  assert.equal(manifest.deviations.length, 1);
  const deviation = manifest.deviations[0];
  assert.equal(deviation.baseUpstreamCommit, bundled.manifest.source.commit);
  assert.equal(deviation.patchedSha256, bundled.helperSha256);
  assert.equal(deviation.patched.length, 2);
  assert.match(deviation.reason, /without weakening review of any added or modified content/);

  const patchPath = join(bundled.root, deviation.patchPath);
  const patch = readFileSync(patchPath, "utf8");
  assert.equal(createHash("sha256").update(patch).digest("hex"), deviation.patchSha256);
  assert.deepEqual(patch.match(/^diff --git .+$/gm), [
    "diff --git a/skills/autoreview/scripts/autoreview b/skills/autoreview/scripts/autoreview"
  ]);

  const patchScratch = mkdtempSync(join(tmpdir(), "perch-autoreview-patch-"));
  try {
    const canonicalHelper = join(patchScratch, "skills", "autoreview", "scripts", "autoreview");
    mkdirSync(join(patchScratch, "skills", "autoreview", "scripts"), { recursive: true });
    writeFileSync(canonicalHelper, readFileSync(bundled.helperPath));
    execFileSync("git", ["apply", "--reverse", patchPath], { cwd: patchScratch, stdio: "pipe" });
    assert.equal(createHash("sha256").update(readFileSync(canonicalHelper)).digest("hex"), deviation.baseSha256);
    execFileSync("git", ["apply", patchPath], { cwd: patchScratch, stdio: "pipe" });
    assert.equal(createHash("sha256").update(readFileSync(canonicalHelper)).digest("hex"), deviation.patchedSha256);
  } finally {
    rmSync(patchScratch, { recursive: true, force: true });
  }

  const scratch = mkdtempSync(join(tmpdir(), "perch-autoreview-assets-"));
  try {
    const copy = join(scratch, "autoreview");
    cpSync(autoReviewAssetRoot(), copy, { recursive: true, dereference: false });
    const link = join(copy, "skill", "CLAUDE.md");
    unlinkSync(link);
    writeFileSync(link, readFileSync(join(copy, "skill", "AGENTS.md")));
    assert.doesNotThrow(() => resolveBundledAutoReview(copy), "npm link materialization must retain the pinned target bytes");
    writeFileSync(join(copy, "skill", "SKILL.md"), "tampered\n");
    assert.throws(() => resolveBundledAutoReview(copy), /integrity mismatch/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("bundled helper allows deletion-only risks without loosening additions", () => {
  const placeholder = ["test", "token"].join("-");
  const placeholderOnlyRisk = [
    `    assert.ok(!html.includes("token=${placeholder}"));`,
    'test("chartReviewHtml escapes chart names and the session JSON", () => {',
    `    name: 'road<map> "v1"',`,
    ""
  ].join("\n");
  const binaryMarker = "DELETED_BINARY_CONTENT_MUST_NOT_ENTER_THE_BUNDLE";
  const binary = Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from(binaryMarker)]);
  const liveLookingSecret = ["gh", "p_", "A".repeat(32)].join("");
  const repos = [
    helperReviewFixture(placeholderOnlyRisk, undefined),
    helperReviewFixture(binary, undefined),
    helperReviewFixture(undefined, binary),
    helperReviewFixture(undefined, `export const token = "${liveLookingSecret}";\n`)
  ];
  try {
    const secretDeletion = runHelperDriver(repos[0], "bundle");
    assert.equal(secretDeletion.status, 0, secretDeletion.stderr);
    assert.doesNotMatch(secretDeletion.stdout, new RegExp(placeholder));

    const binaryDeletion = runHelperDriver(repos[1], "bundle");
    assert.equal(binaryDeletion.status, 0, binaryDeletion.stderr);
    assert.doesNotMatch(binaryDeletion.stdout, new RegExp(binaryMarker));

    const binaryAddition = runHelperDriver(repos[2], "bundle");
    assert.notEqual(binaryAddition.status, 0, "binary additions must remain refused");
    assert.match(binaryAddition.stderr, /refusing binary changes in branch diff/);

    const secretAddition = runHelperDriver(repos[3], "detected-secret");
    assert.notEqual(secretAddition.status, 0, "detected added secrets must remain refused");
    assert.match(secretAddition.stderr, /TruffleHog found verified or unknown credentials/);
  } finally {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true });
  }
});

test("AutoReview freezes an exact clean target, runs focused tests first, and persists a Sol-high clean receipt", async () => {
  const value = fixture();
  let invocation: Parameters<AutoReviewRunner>[0] | undefined;
  const review = new AutoReviewService(value.tasks.stateDb, async (received) => {
    invocation = received;
    return { exitCode: 0, stdout: "clean", stderr: "", report: { engine: "codex", model: "gpt-5.6-sol", thinking: "high", findings: [] } };
  });
  try {
    const result = await review.run(input(value, "review-1"));
    assert.equal(result.duplicate, false);
    assert.equal(result.attempt.state, "clean");
    assert.equal(result.attempt.requestedModel, "gpt-5.6-sol");
    assert.equal(result.attempt.requestedReasoning, "high");
    assert.equal(result.attempt.actualModel, "gpt-5.6-sol");
    assert.equal(result.attempt.testEvidence.exitCode, 0);
    assert.deepEqual(result.attempt.testEvidence.argv, ["node", "<redacted>", "<redacted>"]);
    assert.match(result.attempt.testEvidence.argvSha256, /^[a-f0-9]{64}$/);
    assert.equal(result.attempt.testEvidence.headOid, result.attempt.headOid);
    assert.equal(result.attempt.testEvidence.treeOid, result.attempt.treeOid);
    assert.equal(result.attempt.upstreamCommit, "2a409d348a4bcf6f15e41e9a20efd0b298a32528");
    assert.equal(result.attempt.helperSha256, resolveBundledAutoReview().helperSha256);
    assert.deepEqual(invocation?.args.slice(0, 10), [
      "--mode", "branch", "--base", result.attempt.baseOid,
      "--engine", "codex", "--model", "gpt-5.6-sol", "--thinking", "high"
    ]);
    assert.equal(invocation?.helperPath, resolveBundledAutoReview().helperPath);

    const duplicate = await review.run(input(value, "review-1"));
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.attempt.id, result.attempt.id);
  } finally {
    cleanup(value);
  }
});

test("focused test execution rejects arbitrary commands, isolates its environment, and never persists raw argv", async () => {
  const value = fixture();
  try {
    const review = new AutoReviewService(value.tasks.stateDb, async () => ({
      exitCode: 0, stdout: "", stderr: "", report: { findings: [] }
    }));
    await assert.rejects(
      review.run({ ...input(value, "shell-rejected"), testArgv: ["sh", "-c", "npm test"] }),
      /supported test launcher/
    );
    assert.equal(value.tasks.stateDb.autoreview.latest(value.task.id), undefined);
  } finally {
    cleanup(value);
  }
  assert.throws(() => validateFocusedTestArgv(["node", "-e", "process.exit(0)"]), /supported test command/);
  const isolated = createFocusedTestEnvironment({ HOME: "/host/home", PERCH_HOOK_TOKEN: "must-not-leak" });
  try {
    assert.notEqual(isolated.env.HOME, "/host/home");
    assert.equal(isolated.env.PERCH_HOOK_TOKEN, undefined);
    assert.equal(isolated.env.PATH?.includes("/host/home"), false);
  } finally {
    rmSync(isolated.root, { recursive: true, force: true });
  }
  const receiptArgv = sanitizeFocusedTestArgv(["node", "--test", "sensitive-argument"]);
  assert.deepEqual(receiptArgv.argv, ["node", "<redacted>", "<redacted>"]);
  assert.ok(!JSON.stringify(receiptArgv).includes("sensitive-argument"));
});

test("helper failures and actionable findings never produce a clean receipt", async () => {
  const failure = fixture();
  try {
    const review = new AutoReviewService(failure.tasks.stateDb, async () => ({
      exitCode: 1, stdout: "", stderr: "TruffleHog scan failed", report: { findings: [] }
    }));
    const result = await review.run(input(failure, "trufflehog"));
    assert.equal(result.attempt.state, "failed");
    assert.equal(result.attempt.failureCode, "trufflehog_failed");
  } finally {
    cleanup(failure);
  }

  const finding = fixture();
  try {
    const review = new AutoReviewService(finding.tasks.stateDb, async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      report: { findings: [{ id: "ar-1", priority: "P1", description: "verify the boundary", location: { file: "app.txt", line: 1 } }] }
    }));
    const result = await review.run(input(finding, "finding"));
    assert.equal(result.attempt.state, "findings");
    assert.equal(result.attempt.findings[0]?.id, "ar-1");
    const delivery = new DeliveryService(finding.tasks.stateDb, async () => ({ url: "https://github.com/o/r/pull/1" }));
    await assert.rejects(
      delivery.createPr({ task: finding.task, runtime: finding.runtime, worktreePath: finding.repo, idempotencyKey: "delivery-finding" }),
      /clean AutoReview receipt/
    );
  } finally {
    cleanup(finding);
  }

  // A missing or unreadable structured report parses to zero findings, which
  // must never be mistaken for a reviewed-and-clean result.
  const silent = fixture();
  try {
    const review = new AutoReviewService(silent.tasks.stateDb, async () => ({
      exitCode: 0, stdout: "", stderr: "", report: undefined
    }));
    const result = await review.run(input(silent, "no-structured-report"));
    assert.equal(result.attempt.state, "failed");
    assert.equal(result.attempt.failureCode, "structured_report_missing");
    const delivery = new DeliveryService(silent.tasks.stateDb, async () => ({ url: "https://github.com/o/r/pull/2" }));
    await assert.rejects(
      delivery.createPr({ task: silent.task, runtime: silent.runtime, worktreePath: silent.repo, idempotencyKey: "delivery-silent" }),
      /clean AutoReview receipt/
    );
  } finally {
    cleanup(silent);
  }
});

test("Terra is recorded only for the documented Sol access fallback and delivery stays exact-tree idempotent", async () => {
  const value = fixture();
  let deliveryCalls = 0;
  try {
    const review = new AutoReviewService(value.tasks.stateDb, async () => ({
      exitCode: 0,
      stdout: "gpt-5.6-sol is unavailable for this account; retrying with gpt-5.6-terra",
      stderr: "",
      report: { engine: "codex", model: "gpt-5.6-terra", thinking: "high", findings: [] }
    }));
    const receipt = (await review.run(input(value, "terra"))).attempt;
    assert.equal(receipt.state, "clean");
    assert.equal(receipt.actualModel, "gpt-5.6-terra");
    assert.equal(receipt.fallbackReason, "sol_access_unavailable");

    const delivery = new DeliveryService(value.tasks.stateDb, async () => {
      deliveryCalls += 1;
      return { url: "https://github.com/o/r/pull/71", number: 71 };
    });
    const first = await delivery.createPr({ task: value.task, runtime: value.runtime, worktreePath: value.repo, idempotencyKey: "deliver-once" });
    const duplicate = await delivery.createPr({ task: value.task, runtime: value.runtime, worktreePath: value.repo, idempotencyKey: "deliver-once" });
    assert.equal(first.pr.number, 71);
    assert.equal(duplicate.duplicate, true);
    assert.equal(deliveryCalls, 1, "server delivery creates exactly one PR across retries");

    writeFileSync(join(value.repo, "app.txt"), "changed after review\n");
    const secondTask = value.tasks.create({ title: "stale receipt", project: value.repo, kind: "ship" });
    const staleRuntime = value.tasks.stateDb.runtimes.create({
      id: "runtime-stale", taskId: secondTask.id, generation: 3, state: "live", agent: "codex", provider: "codex", ptySessionId: "pty:stale", worktreePath: value.repo
    });
    // The receipt belongs to a different task and is also mechanically stale.
    await assert.rejects(
      delivery.createPr({ task: secondTask, runtime: staleRuntime, worktreePath: value.repo, idempotencyKey: "stale" }),
      /clean AutoReview receipt/
    );
  } finally {
    cleanup(value);
  }
});

test("delivery refuses a clean receipt as soon as any source change alters its reviewed target", async () => {
  const value = fixture();
  let deliveryCalls = 0;
  try {
    const review = new AutoReviewService(value.tasks.stateDb, async () => ({
      exitCode: 0, stdout: "", stderr: "", report: { findings: [] }
    }));
    const receipt = (await review.run(input(value, "exact-tree"))).attempt;
    assert.equal(receipt.state, "clean");
    writeFileSync(join(value.repo, "app.txt"), "unreviewed source change\n");
    const delivery = new DeliveryService(value.tasks.stateDb, async () => {
      deliveryCalls += 1;
      return { url: "https://github.com/o/r/pull/72" };
    });
    await assert.rejects(
      delivery.createPr({ task: value.task, runtime: value.runtime, worktreePath: value.repo, idempotencyKey: "stale-tree" }),
      /receipt is stale/
    );
    assert.equal(deliveryCalls, 0);
  } finally {
    cleanup(value);
  }
});

test("a delivery retry after a failed attempt binds the PR to the receipt it actually delivered", async () => {
  const value = fixture();
  const git = (args: string[]) => execFileSync("git", ["-C", value.repo, ...args], { stdio: "pipe" });
  try {
    const review = new AutoReviewService(value.tasks.stateDb, async () => ({
      exitCode: 0, stdout: "", stderr: "", report: { findings: [] }
    }));
    const first = (await review.run(input(value, "retry-1"))).attempt;
    assert.equal(first.state, "clean");

    let attempts = 0;
    const delivery = new DeliveryService(value.tasks.stateDb, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("push rejected by remote");
      return { url: "https://github.com/o/r/pull/73", number: 73 };
    });
    await assert.rejects(
      delivery.createPr({ task: value.task, runtime: value.runtime, worktreePath: value.repo, idempotencyKey: "retry" }),
      /push rejected/
    );
    assert.equal(value.tasks.stateDb.delivery.find(value.task.id)?.state, "failed");

    // The worker keeps working, so the retry delivers a different tree that
    // only the newer receipt covers.
    writeFileSync(join(value.repo, "app.txt"), "second review target\n");
    git(["commit", "-am", "second review target", "-q"]);
    const second = (await review.run(input(value, "retry-2"))).attempt;
    assert.equal(second.state, "clean");
    assert.notEqual(second.id, first.id);

    const retried = await delivery.createPr({ task: value.task, runtime: value.runtime, worktreePath: value.repo, idempotencyKey: "retry" });
    assert.equal(attempts, 2);
    assert.equal(retried.pr.number, 73);

    const record = value.tasks.stateDb.delivery.find(value.task.id);
    assert.equal(record?.state, "created");
    assert.equal(record?.receiptId, second.id, "the durable row names the receipt that was actually delivered");
    assert.equal(record?.headOid, second.headOid, "the durable row names the head that was actually pushed");
    assert.equal(retried.pr.headOid, second.headOid, "the linked PR identity matches the delivered head");
  } finally {
    cleanup(value);
  }
});

test("a created delivery redelivers a rebased clean receipt to its existing PR after a force-with-lease refusal", async () => {
  const value = fixture();
  const git = (args: string[]) => execFileSync("git", ["-C", value.repo, ...args], { stdio: "pipe", encoding: "utf8" }).trim();
  let deliveryCalls = 0;
  let refuseFirstRedelivery = true;
  const deliveryInputs: Array<{ headOid: string; existingPr?: { url: string; number?: number }; forceWithLeaseHeadOid?: string }> = [];
  try {
    const review = new AutoReviewService(value.tasks.stateDb, async () => ({
      exitCode: 0, stdout: "", stderr: "", report: { findings: [] }
    }));
    git(["update-ref", "refs/remotes/origin/main", "HEAD~1"]);
    const firstReceipt = (await review.run(input(value, "first-review", undefined, "origin/main"))).attempt;
    const delivery = new DeliveryService(value.tasks.stateDb, async (received) => {
      deliveryCalls += 1;
      deliveryInputs.push(received);
      if (received.forceWithLeaseHeadOid && refuseFirstRedelivery) {
        refuseFirstRedelivery = false;
        throw new Error("remote rejected force-with-lease");
      }
      return { url: "https://github.com/o/r/pull/74", number: 74 };
    });
    const first = await delivery.createPr({ task: value.task, runtime: value.runtime, worktreePath: value.repo, idempotencyKey: "redeliver" });

    const featureBranch = firstReceipt.branch;
    git(["checkout", "-qb", "moved-main", "origin/main"]);
    writeFileSync(join(value.repo, "main-only.txt"), "unrelated base advance\n");
    git(["add", "main-only.txt"]);
    git(["commit", "-qm", "unrelated base advance"]);
    const movedBase = git(["rev-parse", "HEAD"]);
    git(["update-ref", "refs/remotes/origin/main", movedBase]);
    git(["checkout", "-q", featureBranch]);
    git(["rebase", "origin/main"]);

    const rebasedReceipt = (await review.run(input(value, "rebased-review", undefined, "origin/main"))).attempt;
    assert.equal(rebasedReceipt.state, "clean");
    assert.notEqual(rebasedReceipt.headOid, firstReceipt.headOid);

    // Before the redelivery fix this returned the first PR identity as a
    // duplicate, leaving the created delivery row and PR head on the first
    // receipt while the only current clean receipt named this rebased head.
    await assert.rejects(
      delivery.createPr({ task: value.task, runtime: value.runtime, worktreePath: value.repo, idempotencyKey: "redeliver" }),
      /force-with-lease/
    );
    assert.equal(value.tasks.stateDb.delivery.find(value.task.id)?.state, "failed");
    assert.equal(value.tasks.stateDb.delivery.find(value.task.id)?.leaseHeadOid, firstReceipt.headOid);
    assert.equal(deliveryInputs[1]?.headOid, rebasedReceipt.headOid);
    assert.deepEqual(deliveryInputs[1]?.existingPr, { url: first.pr.url, number: first.pr.number });
    assert.equal(deliveryInputs[1]?.forceWithLeaseHeadOid, firstReceipt.headOid);

    const redelivered = await delivery.createPr({ task: value.task, runtime: value.runtime, worktreePath: value.repo, idempotencyKey: "redeliver" });
    assert.equal(redelivered.duplicate, false);
    assert.equal(redelivered.pr.url, first.pr.url);
    assert.equal(redelivered.pr.number, first.pr.number);
    assert.equal(redelivered.pr.headOid, rebasedReceipt.headOid);
    assert.equal(value.tasks.stateDb.delivery.find(value.task.id)?.receiptId, rebasedReceipt.id);
    assert.equal(deliveryCalls, 3);

    const duplicate = await delivery.createPr({ task: value.task, runtime: value.runtime, worktreePath: value.repo, idempotencyKey: "redeliver" });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.pr.headOid, rebasedReceipt.headOid);
    assert.equal(deliveryCalls, 3, "retrying after redelivery must not push or create another PR");
  } finally {
    cleanup(value);
  }
});

test("server redelivery force-pushes only the recorded PR head and refuses a moved remote", async () => {
  const value = fixture();
  const git = (args: string[], cwd = value.repo) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", encoding: "utf8" }).trim();
  const remote = mkdtempSync(join(tmpdir(), "perch-delivery-remote-"));
  const rival = mkdtempSync(join(tmpdir(), "perch-delivery-rival-"));
  try {
    execFileSync("git", ["init", "--bare", "-q", remote], { stdio: "pipe" });
    const review = new AutoReviewService(value.tasks.stateDb, async () => ({
      exitCode: 0, stdout: "", stderr: "", report: { findings: [] }
    }));
    git(["update-ref", "refs/remotes/origin/main", "HEAD~1"]);
    const firstReceipt = (await review.run(input(value, "lease-first", undefined, "origin/main"))).attempt;
    git(["remote", "add", "origin", remote]);
    git(["push", "--set-upstream", "origin", firstReceipt.branch]);
    const now = new Date().toISOString();
    value.tasks.stateDb.delivery.create({
      taskId: value.task.id, receiptId: firstReceipt.id, idempotencyKey: "lease-delivery", state: "created",
      baseOid: firstReceipt.baseOid, headOid: firstReceipt.headOid, treeOid: firstReceipt.treeOid, diffSha256: firstReceipt.diffSha256,
      prUrl: "https://github.com/o/r/pull/76", prNumber: 76, createdAt: now, updatedAt: now
    });

    git(["checkout", "-qb", "moved-main", "origin/main"]);
    writeFileSync(join(value.repo, "main-only.txt"), "unrelated base advance\n");
    git(["add", "main-only.txt"]);
    git(["commit", "-qm", "unrelated base advance"]);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(["checkout", "-q", firstReceipt.branch]);
    git(["rebase", "origin/main"]);
    const rebasedReceipt = (await review.run(input(value, "lease-rebased", undefined, "origin/main"))).attempt;

    const delivery = new DeliveryService(value.tasks.stateDb);
    const redelivered = await delivery.createPr({
      task: value.task, runtime: value.runtime, worktreePath: value.repo, idempotencyKey: "lease-delivery"
    });
    assert.equal(redelivered.pr.url, "https://github.com/o/r/pull/76");
    assert.equal(git(["rev-parse", `refs/heads/${firstReceipt.branch}`], remote), rebasedReceipt.headOid);

    writeFileSync(join(value.repo, "app.txt"), "third reviewed delivery\n");
    git(["commit", "-am", "third reviewed delivery", "-q"]);
    const thirdReceipt = (await review.run(input(value, "lease-third", undefined, "origin/main"))).attempt;
    execFileSync("git", ["clone", "-q", remote, rival], { stdio: "pipe" });
    git(["config", "user.email", "rival@example.test"], rival);
    git(["config", "user.name", "Rival"], rival);
    git(["checkout", "-q", firstReceipt.branch], rival);
    writeFileSync(join(rival, "remote-only.txt"), "concurrent remote advance\n");
    git(["add", "remote-only.txt"], rival);
    git(["commit", "-qm", "concurrent remote advance"], rival);
    git(["push", "origin", firstReceipt.branch], rival);

    await assert.rejects(
      delivery.createPr({ task: value.task, runtime: value.runtime, worktreePath: value.repo, idempotencyKey: "lease-delivery" }),
      /remote delivery branch no longer matches/
    );
    assert.equal(git(["rev-parse", `refs/heads/${firstReceipt.branch}`], remote), git(["rev-parse", "HEAD"], rival));
    assert.equal(value.tasks.stateDb.delivery.find(value.task.id)?.receiptId, thirdReceipt.id);
  } finally {
    cleanup(value);
    rmSync(remote, { recursive: true, force: true });
    rmSync(rival, { recursive: true, force: true });
  }
});

test("two accepted review-fix cycles pause before a third fix cycle", async () => {
  const value = fixture();
  let runs = 0;
  const review = new AutoReviewService(value.tasks.stateDb, async () => {
    runs += 1;
    return { exitCode: 0, stdout: "", stderr: "", report: { findings: [{ id: `f-${runs}`, description: "fix it" }] } };
  });
  try {
    const first = (await review.run(input(value, "cycle-1"))).attempt;
    const second = (await review.run(input(value, "cycle-2", first.id))).attempt;
    const third = (await review.run(input(value, "cycle-3", second.id))).attempt;
    const paused = (await review.run(input(value, "cycle-4", third.id))).attempt;
    assert.equal(value.tasks.stateDb.autoreview.find(first.id)?.state, "superseded");
    assert.equal(value.tasks.stateDb.autoreview.find(second.id)?.state, "superseded");
    assert.equal(value.tasks.stateDb.autoreview.find(third.id)?.state, "superseded");
    assert.equal(paused.state, "scope_paused");
    assert.equal(runs, 3, "the helper is not rerun for a third non-converging fix cycle");
  } finally {
    cleanup(value);
  }
});
