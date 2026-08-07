import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Task } from "@perch/shared";
import {
  type AutoReviewAttemptRecord,
  type AutoReviewFindingRecord,
  type AutoReviewTestEvidence,
  type RuntimeRecord
} from "./stateDb.js";
import { resolveBundledAutoReview } from "./autoreviewRuntime.js";

const execFileAsync = promisify(execFile);
const REVIEW_TIMEOUT_MS = 31 * 60_000;
const TEST_TIMEOUT_MS = 15 * 60_000;
const SUPPORTED_FOCUSED_TEST_COMMANDS = new Set([
  "npm", "pnpm", "yarn", "bun", "node", "nodejs", "pytest", "python", "python3",
  "cargo", "go", "swift", "xcodebuild", "gradle", "gradlew", "mvn", "mvnw", "make", "just"
]);

export type FrozenReviewTarget = {
  repository: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
  baseOid: string;
  headOid: string;
  treeOid: string;
  diffManifest: Record<string, unknown>;
  diffSha256: string;
  statusPorcelainSha256: string;
  worktreeClean: boolean;
};

export type AutoReviewRunInput = {
  task: Task;
  runtime: RuntimeRecord;
  sessionId: string;
  worktreePath: string;
  baseRef: string;
  idempotencyKey: string;
  testArgv: string[];
  authorDispositions?: Array<Record<string, unknown>>;
  supersedesAttemptId?: string;
};

export type AutoReviewRunResult = {
  attempt: AutoReviewAttemptRecord;
  duplicate: boolean;
};

export type AutoReviewRunner = (input: {
  helperPath: string;
  cwd: string;
  args: string[];
  jsonOutputPath: string;
}) => Promise<{ exitCode: number; stdout: string; stderr: string; report?: Record<string, unknown> }>;

export class AutoReviewService {
  constructor(private readonly state: import("./stateDb.js").StateDb, private readonly runner: AutoReviewRunner = runHelper) {}

  async run(input: AutoReviewRunInput): Promise<AutoReviewRunResult> {
    if (input.task.kind !== "ship") throw new Error("AutoReview is available only for ship tasks");
    if (input.runtime.state !== "live" || input.runtime.id === "" || input.runtime.generation < 0) {
      throw new Error("AutoReview requires the task's current live root runtime");
    }
    const existing = this.state.autoreview.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      if (existing.taskId !== input.task.id || existing.runtimeId !== input.runtime.id) {
        throw new Error("AutoReview idempotency key belongs to a different task runtime");
      }
      return { attempt: existing, duplicate: true };
    }
    if (input.testArgv.length === 0 || input.testArgv.some((part) => !part || part.length > 4_096)) {
      throw new Error("AutoReview requires a non-empty focused test argv array");
    }
    validateFocusedTestArgv(input.testArgv);
    const target = await freezeReviewTarget(input.worktreePath, input.baseRef);
    if (!target.worktreeClean) throw new Error("AutoReview requires a clean worktree; commit or discard all changes before review");
    const bundled = resolveBundledAutoReview();
    const prior = input.supersedesAttemptId ? this.state.autoreview.find(input.supersedesAttemptId) : undefined;
    if (input.supersedesAttemptId && (!prior || prior.taskId !== input.task.id || prior.state !== "findings")) {
      throw new Error("superseded AutoReview attempt must be a finding-bearing receipt for this task");
    }
    if (prior && this.countAcceptedFixCycles(input.task.id) >= 2) {
      const paused = this.createAttempt(input, target, bundled, "scope_paused");
      this.state.autoreview.create(paused);
      this.state.autoreview.supersede(prior.id, paused.id);
      return { attempt: paused, duplicate: false };
    }
    const attempt = this.createAttempt(input, target, bundled, "running");
    this.state.autoreview.create(attempt);
    if (prior) this.state.autoreview.supersede(prior.id, attempt.id);

    const test = await runFocusedTest(input.testArgv, input.worktreePath, target);
    if (test.exitCode !== 0) {
      return {
        attempt: this.state.autoreview.complete({
          ...attempt,
          state: "failed",
          exitCode: test.exitCode,
          findings: [],
          authorDispositions: input.authorDispositions ?? [],
          testEvidence: test,
          actualEngine: "codex",
          actualModel: "gpt-5.6-sol",
          actualReasoning: "high",
          failureCode: "focused_test_failed",
          stdoutSha256: test.stdoutSha256,
          stderrSha256: test.stderrSha256
        }),
        duplicate: false
      };
    }
    const receiptDir = mkdtempSync(join(tmpdir(), "perch-autoreview-receipt-"));
    const jsonOutputPath = join(receiptDir, "receipt.json");
    try {
      const result = await this.runner({
        helperPath: bundled.helperPath,
        cwd: input.worktreePath,
        args: [
          "--mode", "branch", "--base", target.baseOid,
          "--engine", "codex", "--model", "gpt-5.6-sol", "--thinking", "high",
          "--json-output", jsonOutputPath
        ],
        jsonOutputPath
      });
      const findings = parseFindings(result.report);
      const finalTarget = await freezeReviewTarget(input.worktreePath, input.baseRef);
      const targetUnchanged = finalTarget.worktreeClean && sameFrozenTarget(target, finalTarget);
      const fallbackReason = codexAccessFallback(result.stdout, result.stderr)
        ? "sol_access_unavailable"
        : undefined;
      const state = targetUnchanged && result.exitCode === 0 && findings.length === 0
        ? "clean"
        : targetUnchanged && findings.length > 0
          ? "findings"
          : "failed";
      return {
        attempt: this.state.autoreview.complete({
          ...attempt,
          state,
          exitCode: result.exitCode,
          findings,
          authorDispositions: input.authorDispositions ?? [],
          testEvidence: test,
          actualEngine: String(result.report?.engine ?? "codex"),
          actualModel: String(result.report?.model ?? (fallbackReason ? "gpt-5.6-terra" : "gpt-5.6-sol")),
          actualReasoning: String(result.report?.thinking ?? "high"),
          ...(fallbackReason ? { fallbackReason } : {}),
          stdoutSha256: sha256(result.stdout),
          stderrSha256: sha256(result.stderr),
          ...(state === "failed" ? {
            failureCode: targetUnchanged ? helperFailureCode(`${result.stdout}\n${result.stderr}`) : "review_target_changed"
          } : {})
        }),
        duplicate: false
      };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return {
        attempt: this.state.autoreview.complete({
          ...attempt,
          state: "failed",
          exitCode: 1,
          findings: [],
          authorDispositions: input.authorDispositions ?? [],
          testEvidence: test,
          actualEngine: "codex",
          actualModel: "gpt-5.6-sol",
          actualReasoning: "high",
          failureCode: helperFailureCode(text),
          stderrSha256: sha256(text)
        }),
        duplicate: false
      };
    } finally {
      rmSync(receiptDir, { recursive: true, force: true });
    }
  }

  private createAttempt(
    input: AutoReviewRunInput,
    target: FrozenReviewTarget,
    bundled: ReturnType<typeof resolveBundledAutoReview>,
    state: AutoReviewAttemptRecord["state"]
  ): AutoReviewAttemptRecord {
    return {
      id: randomUUID(), taskId: input.task.id, runtimeId: input.runtime.id, runtimeGeneration: input.runtime.generation,
      sessionId: input.sessionId, idempotencyKey: input.idempotencyKey, repository: target.repository,
      worktreePath: target.worktreePath, branch: target.branch, baseRef: target.baseRef, baseOid: target.baseOid,
      headOid: target.headOid, treeOid: target.treeOid, diffManifest: target.diffManifest, diffSha256: target.diffSha256,
      statusPorcelainSha256: target.statusPorcelainSha256, worktreeClean: target.worktreeClean,
      bundleVersion: bundled.manifest.version, upstreamCommit: bundled.manifest.source.commit, helperSha256: bundled.helperSha256,
      requestedEngine: "codex", requestedModel: "gpt-5.6-sol", requestedReasoning: "high", state,
      findings: [], authorDispositions: input.authorDispositions ?? [], testEvidence: {}, startedAt: new Date().toISOString(),
      ...(input.supersedesAttemptId ? { supersedesAttemptId: input.supersedesAttemptId } : {})
    };
  }

  private countAcceptedFixCycles(taskId: string): number {
    // A supersession starts a review-triggered fix cycle.  The durable ledger
    // keeps previous receipts, so a restarted server cannot forget the pause.
    let count = 0;
    let current = this.state.autoreview.latest(taskId);
    const seen = new Set<string>();
    while (current?.supersedesAttemptId && !seen.has(current.id)) {
      seen.add(current.id);
      count += 1;
      current = this.state.autoreview.find(current.supersedesAttemptId);
    }
    return count;
  }
}

export async function freezeReviewTarget(worktreePath: string, baseRef: string): Promise<FrozenReviewTarget> {
  const [repository, branch, baseOid, headOid, treeOid, status] = await Promise.all([
    git(worktreePath, ["rev-parse", "--show-toplevel"]),
    git(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(worktreePath, ["rev-parse", "--verify", `${baseRef}^{commit}`]),
    git(worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]),
    git(worktreePath, ["rev-parse", "--verify", "HEAD^{tree}"]),
    git(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"])
  ]);
  const [diff, names] = await Promise.all([
    gitBuffer(worktreePath, ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", `${baseOid.trim()}...${headOid.trim()}`]),
    git(worktreePath, ["diff", "--name-status", "--no-renames", `${baseOid.trim()}...${headOid.trim()}`])
  ]);
  const normalizedNames = names.trim().split("\n").filter(Boolean);
  return {
    repository: repository.trim(), worktreePath, branch: branch.trim(), baseRef, baseOid: baseOid.trim(), headOid: headOid.trim(), treeOid: treeOid.trim(),
    diffManifest: { algorithm: "git-diff-binary-full-index-v1", files: normalizedNames, fileCount: normalizedNames.length },
    diffSha256: sha256(diff), statusPorcelainSha256: sha256(status), worktreeClean: status.length === 0
  };
}

function sameFrozenTarget(left: FrozenReviewTarget, right: FrozenReviewTarget): boolean {
  return left.baseOid === right.baseOid && left.headOid === right.headOid && left.treeOid === right.treeOid &&
    left.diffSha256 === right.diffSha256 && left.statusPorcelainSha256 === right.statusPorcelainSha256;
}

export function validateFocusedTestArgv(argv: string[]): void {
  const command = argv[0];
  if (!command || command.includes("/") || command.includes("\\") || !SUPPORTED_FOCUSED_TEST_COMMANDS.has(command)) {
    throw new Error("AutoReview focused tests must use a supported test launcher, not a shell or an arbitrary executable");
  }
  const args = argv.slice(1);
  const hasTestArgument = args.some((arg) => arg === "test" || arg.startsWith("test:"));
  const npmStyle = command === "npm" || command === "pnpm" || command === "yarn";
  if (npmStyle && (args[0] === "test" || (args[0] === "run" && hasTestArgument))) return;
  if (command === "bun" && args[0] === "test") return;
  if ((command === "node" || command === "nodejs") && args.includes("--test") && !args.some((arg) => arg === "-e" || arg === "--eval" || arg === "-p" || arg === "--print")) return;
  if (command === "pytest" || ((command === "python" || command === "python3") && args[0] === "-m" && args[1] === "pytest")) return;
  if ((command === "cargo" || command === "go" || command === "swift" || command === "mvn" || command === "mvnw") && args[0] === "test") return;
  if ((command === "xcodebuild" || command === "gradle" || command === "gradlew" || command === "make" || command === "just") && hasTestArgument) return;
  throw new Error("AutoReview focused tests must invoke a supported test command");
}

export function createFocusedTestEnvironment(sourceEnv: NodeJS.ProcessEnv = process.env): { root: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "perch-autoreview-test-"));
  const home = join(root, "home");
  const temporary = join(root, "tmp");
  const config = join(root, "config");
  const cache = join(root, "cache");
  const data = join(root, "data");
  const state = join(root, "state");
  for (const path of [home, temporary, config, cache, data, state]) mkdirSync(path, { recursive: true });
  const windows = process.platform === "win32";
  const systemRoot = sourceEnv.SYSTEMROOT ?? sourceEnv.SystemRoot ?? "C:\\Windows";
  const trustedExecutablePaths = windows
    ? [dirname(process.execPath), `${systemRoot}\\System32`, systemRoot]
    : [dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const env: NodeJS.ProcessEnv = {
    PATH: [...new Set(trustedExecutablePaths)].join(delimiter),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: cache,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: state,
    CI: "1",
    LANG: "C.UTF-8",
    ...(windows ? { SYSTEMROOT: systemRoot, ComSpec: `${systemRoot}\\System32\\cmd.exe` } : {})
  };
  return { root, env };
}

export function sanitizeFocusedTestArgv(argv: string[]): Pick<AutoReviewTestEvidence, "argv" | "argvSha256"> {
  return { argv: [argv[0]!, ...argv.slice(1).map(() => "<redacted>")], argvSha256: sha256(JSON.stringify(argv)) };
}

async function runFocusedTest(argv: string[], cwd: string, target: FrozenReviewTarget): Promise<AutoReviewTestEvidence> {
  const isolated = createFocusedTestEnvironment();
  const receiptArgv = sanitizeFocusedTestArgv(argv);
  try {
    const result = await execFileAsync(argv[0]!, argv.slice(1), {
      cwd, env: isolated.env, timeout: TEST_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024
    });
    return { ...receiptArgv, exitCode: 0, stdoutSha256: sha256(result.stdout), stderrSha256: sha256(result.stderr), headOid: target.headOid, treeOid: target.treeOid, completedAt: new Date().toISOString() };
  } catch (error) {
    const result = error as { code?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return { ...receiptArgv, exitCode: typeof result.code === "number" ? result.code : 1, stdoutSha256: sha256(result.stdout ?? ""), stderrSha256: sha256(result.stderr ?? ""), headOid: target.headOid, treeOid: target.treeOid, completedAt: new Date().toISOString() };
  } finally {
    rmSync(isolated.root, { recursive: true, force: true });
  }
}

async function runHelper(input: Parameters<AutoReviewRunner>[0]): Promise<{ exitCode: number; stdout: string; stderr: string; report?: Record<string, unknown> }> {
  try {
    const result = await execFileAsync(input.helperPath, input.args, { cwd: input.cwd, timeout: REVIEW_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr, report: readStructuredReceipt(input.jsonOutputPath) };
  } catch (error) {
    const result = error as { code?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      exitCode: typeof result.code === "number" ? result.code : 1,
      stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? ""), report: readStructuredReceipt(input.jsonOutputPath)
    };
  }
}

function readStructuredReceipt(path: string): Record<string, unknown> | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function parseFindings(report: Record<string, unknown> | undefined): AutoReviewFindingRecord[] {
  const entries = Array.isArray(report?.findings) ? report!.findings : [];
  return entries.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const finding = entry as Record<string, unknown>;
    const description = typeof finding.description === "string" ? finding.description : typeof finding.title === "string" ? finding.title : undefined;
    if (!description) return [];
    const location = finding.location && typeof finding.location === "object" && !Array.isArray(finding.location) ? finding.location as Record<string, unknown> : {};
    return [{
      id: typeof finding.id === "string" ? finding.id : `finding-${index + 1}`,
      priority: typeof finding.priority === "string" ? finding.priority : typeof finding.severity === "string" ? finding.severity : "P0",
      description,
      location: {
        ...(typeof location.file === "string" ? { file: location.file } : typeof finding.file === "string" ? { file: finding.file } : {}),
        ...(typeof location.line === "number" ? { line: location.line } : typeof finding.line === "number" ? { line: finding.line } : {})
      }
    }];
  });
}

function helperFailureCode(message: string): string {
  if (/trufflehog/i.test(message)) return "trufflehog_failed";
  if (/access|not available|unsupported model/i.test(message)) return "reviewer_access_failed";
  if (/timed out/i.test(message)) return "helper_timed_out";
  return "helper_failed";
}

function codexAccessFallback(stdout: string, stderr: string): boolean {
  return /gpt-5\.6-sol is unavailable for this account; retrying with gpt-5\.6-terra/i.test(`${stdout}\n${stderr}`);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, "-c", "core.fsmonitor=false", "-c", "core.pager=cat", ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return result.stdout;
}

async function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  const result = await execFileAsync("git", ["-C", cwd, "-c", "core.fsmonitor=false", "-c", "core.pager=cat", ...args], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
  return Buffer.from(result.stdout);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
