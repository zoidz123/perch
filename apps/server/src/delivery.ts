import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Task, TaskPr } from "@perch/shared";
import { freezeReviewTarget } from "./autoreview.js";
import type { AutoReviewAttemptRecord, RuntimeRecord, StateDb } from "./stateDb.js";

const execFileAsync = promisify(execFile);

export type DeliveryCreatePrInput = {
  task: Task;
  runtime: RuntimeRecord;
  worktreePath: string;
  idempotencyKey: string;
};

export type DeliveryCreatePrResult = {
  pr: TaskPr;
  receipt: AutoReviewAttemptRecord;
  duplicate: boolean;
};

export type DeliveryRunner = (input: {
  cwd: string;
  branch: string;
  baseRef: string;
  title: string;
}) => Promise<{ url: string; number?: number }>;

// The only code path that pushes a current ship task and creates its PR.  The
// worker is authenticated separately by the HTTP/dynamic-tool boundary; this
// service binds that authorization to a still-identical clean receipt.
export class DeliveryService {
  constructor(private readonly state: StateDb, private readonly runner: DeliveryRunner = pushAndCreatePr) {}

  async createPr(input: DeliveryCreatePrInput): Promise<DeliveryCreatePrResult> {
    if (input.task.kind !== "ship") throw new Error("code PR delivery is available only for ship tasks");
    if (input.runtime.state !== "live") throw new Error("delivery requires the task's current live root runtime");
    const existing = this.state.delivery.find(input.task.id);
    if (existing?.state === "created" && existing.prUrl) {
      const receipt = this.state.autoreview.find(existing.receiptId);
      if (!receipt) throw new Error("delivery record is missing its AutoReview receipt");
      return { pr: { url: existing.prUrl, ...(existing.prNumber ? { number: existing.prNumber } : {}), headOid: existing.headOid }, receipt, duplicate: true };
    }
    if (existing && existing.idempotencyKey !== input.idempotencyKey) {
      throw new Error("a delivery attempt already exists for this task; retry with its original idempotency key");
    }
    const receipt = this.state.autoreview.latest(input.task.id);
    if (!receipt || receipt.state !== "clean" || receipt.findings.length > 0) {
      throw new Error("delivery requires a clean AutoReview receipt with no actionable findings");
    }
    if (!receipt.worktreeClean || !hasPassingFinalTestEvidence(receipt)) {
      throw new Error("delivery requires passing focused test evidence for the reviewed final tree");
    }
    const current = await freezeReviewTarget(input.worktreePath, receipt.baseRef);
    if (!current.worktreeClean || !sameTarget(current, receipt)) {
      throw new Error("AutoReview receipt is stale: the current base, HEAD, tree, diff, or worktree snapshot changed");
    }
    const now = new Date().toISOString();
    const target = {
      receiptId: receipt.id, baseOid: current.baseOid, headOid: current.headOid,
      treeOid: current.treeOid, diffSha256: current.diffSha256
    };
    // A reused row is retried against the receipt and target validated just
    // now, never the ones its earlier failed attempt recorded.
    if (existing) this.state.delivery.rebind(input.task.id, target);
    else this.state.delivery.create({
      taskId: input.task.id, idempotencyKey: input.idempotencyKey, state: "creating",
      ...target, createdAt: now, updatedAt: now
    });
    try {
      const created = await this.runner({ cwd: input.worktreePath, branch: current.branch, baseRef: receipt.baseRef, title: input.task.title });
      const completed = this.state.delivery.complete(input.task.id, created.url, created.number);
      return {
        pr: { url: completed.prUrl ?? created.url, ...(completed.prNumber ? { number: completed.prNumber } : {}), head: current.branch, headOid: completed.headOid },
        receipt,
        duplicate: false
      };
    } catch (error) {
      this.state.delivery.fail(input.task.id, error instanceof Error ? error.message.slice(0, 240) : "delivery_failed");
      throw error;
    }
  }
}

export function receiptMatchesCurrentTarget(receipt: AutoReviewAttemptRecord, current: Awaited<ReturnType<typeof freezeReviewTarget>>): boolean {
  return current.worktreeClean && sameTarget(current, receipt) && receipt.state === "clean" && receipt.findings.length === 0 && hasPassingFinalTestEvidence(receipt);
}

function sameTarget(current: Awaited<ReturnType<typeof freezeReviewTarget>>, receipt: AutoReviewAttemptRecord): boolean {
  return current.baseOid === receipt.baseOid && current.headOid === receipt.headOid && current.treeOid === receipt.treeOid &&
    current.diffSha256 === receipt.diffSha256 && current.statusPorcelainSha256 === receipt.statusPorcelainSha256;
}

function hasPassingFinalTestEvidence(receipt: AutoReviewAttemptRecord): boolean {
  const evidence = receipt.testEvidence;
  return Array.isArray(evidence.argv) && evidence.argv.length > 0 && evidence.exitCode === 0 &&
    evidence.headOid === receipt.headOid && evidence.treeOid === receipt.treeOid;
}

async function pushAndCreatePr(input: Parameters<DeliveryRunner>[0]): Promise<{ url: string; number?: number }> {
  const alreadyCreated = await discoverExistingPr(input);
  if (alreadyCreated) return alreadyCreated;
  await execFileAsync("git", ["-C", input.cwd, "push", "--set-upstream", "origin", input.branch], { timeout: 2 * 60_000, maxBuffer: 2 * 1024 * 1024 });
  // A server crash after GitHub accepted creation but before SQLite recorded
  // it is reconciled before a second create call. GitHub is the source of
  // truth for this narrow restart window.
  const afterPush = await discoverExistingPr(input);
  if (afterPush) return afterPush;
  const base = input.baseRef.replace(/^origin\//, "");
  const result = await execFileAsync("gh", ["pr", "create", "--base", base, "--head", input.branch, "--title", input.title, "--body", "Created by Perch server-owned delivery after a clean AutoReview receipt."], { cwd: input.cwd, timeout: 2 * 60_000, maxBuffer: 2 * 1024 * 1024 });
  const url = result.stdout.trim().split(/\s+/).find((value) => /^https:\/\/github\.com\/.+\/pull\/\d+$/.test(value));
  if (!url) throw new Error("GitHub did not confirm a created pull request URL");
  const number = Number(url.match(/\/pull\/(\d+)$/)?.[1]);
  return { url, ...(Number.isSafeInteger(number) ? { number } : {}) };
}

async function discoverExistingPr(input: Parameters<DeliveryRunner>[0]): Promise<{ url: string; number?: number } | undefined> {
  const base = input.baseRef.replace(/^origin\//, "");
  try {
    const result = await execFileAsync(
      "gh",
      ["pr", "list", "--head", input.branch, "--base", base, "--state", "open", "--json", "url,number", "--limit", "2"],
      { cwd: input.cwd, timeout: 30_000, maxBuffer: 512 * 1024 }
    );
    const rows = JSON.parse(result.stdout) as Array<{ url?: unknown; number?: unknown }>;
    if (!Array.isArray(rows) || rows.length === 0) return undefined;
    if (rows.length > 1) throw new Error("multiple open pull requests match the delivery branch");
    const row = rows[0]!;
    if (typeof row.url !== "string" || !/^https:\/\/github\.com\/.+\/pull\/\d+$/.test(row.url)) {
      throw new Error("GitHub returned an invalid pull request identity");
    }
    return { url: row.url, ...(typeof row.number === "number" ? { number: row.number } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // gh returns a normal empty array for no match. Network/auth failures
    // must fail closed rather than risk an unbounded duplicate create.
    if (/multiple open pull requests|invalid pull request identity/.test(message)) throw error;
    if (/failed|not logged|authentication|network|timed out/i.test(message)) throw error;
    return undefined;
  }
}
