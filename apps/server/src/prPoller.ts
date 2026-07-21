import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Task, TaskPr, TaskPrCheck } from "@perch/shared";
import type { StateMetrics } from "./stateMetrics.js";
import type { TaskStore } from "./tasks.js";

const execFileAsync = promisify(execFile);

// Reconcile completion-requested and done tasks against GitHub: any task with a PR
// URL gets `gh pr view` polled until it merges (or the task closes). Emits
// checks_green when the status rollup goes green, merge_ready when GitHub says
// the PR is policy-ready to merge, and merged when the PR lands. gh handles
// auth; failures are silent and retried next tick (offline is normal).
//
// Cadence is adaptive (G5): 5 min is the resting baseline, but a PR that is
// "expecting change" - just attached, checks unsettled, or a sibling PR in the
// same repo just merged (merge-train) - rides a fast window and is re-polled
// every ~25s until it stabilizes, then falls back to the baseline. All gh
// calls (both cadences) serialize through one single-flighted pass, so the
// fast lane can never stampede gh or stack onto a slow baseline pass.

export const POLL_INTERVAL_MS = 5 * 60_000;
export const FAST_POLL_MS = 25_000;
export const FAST_WINDOW_MS = 3 * 60_000;

export type GhPrView = {
  state?: string; // OPEN | MERGED | CLOSED
  mergedAt?: string | null;
  headRefName?: string;
  headRefOid?: string;
  headRepository?: GhRepository | null;
  statusCheckRollup?: Array<{
    name?: string;
    context?: string;
    workflowName?: string;
    status?: string;
    conclusion?: string;
    state?: string;
  }>;
  isDraft?: boolean;
  mergeable?: string | boolean | null;
  mergeStateStatus?: string | null;
  reviewDecision?: string | null;
  createdAt?: string | null;
};

export type GhRunner = (prUrl: string) => Promise<GhPrView | undefined>;
export type RepoResolver = (project: string) => Promise<string | undefined>;
export type PrFinder = (repo: string, branch: string) => Promise<string[] | undefined>;
export type HeadResolver = (project: string) => Promise<string | undefined>;
export type CheckoutResolver = (task: Task) => string;

type GhRepository = {
  name?: string;
  nameWithOwner?: string;
  url?: string;
  owner?: {
    login?: string;
  };
};

type PrIdentityVerdict =
  | {
      ok: true;
      expected: { repo: string; head?: string };
      actual: { repo: string; headRepo: string; head?: string };
    }
  | {
      ok: false;
      reason: string;
    };

export type TaskPrAttachment =
  | {
      ok: true;
      pr: TaskPr;
    }
  | {
      ok: false;
      reason: string;
    };

export type PrPollerOptions = {
  fastWindowMs?: number;
  now?: () => number;
  metrics?: StateMetrics;
  resolveLocalRepo?: RepoResolver;
  findPr?: PrFinder;
  resolveHead?: HeadResolver;
  resolveCheckout?: CheckoutResolver;
};

export class PrPoller {
  private readonly tasks: TaskStore;
  private readonly runGh: GhRunner;
  private readonly fastWindowMs: number;
  private readonly now: () => number;
  private readonly metrics?: StateMetrics;
  private readonly resolveLocalRepo: RepoResolver;
  private readonly findPr: PrFinder;
  private readonly resolveHead: HeadResolver;
  private readonly resolveCheckout: CheckoutResolver;
  // Task id -> epoch until which it rides the fast cadence.
  private readonly fastUntil = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private fastTimer?: NodeJS.Timeout;
  private inFlight = false;

  constructor(tasks: TaskStore, runGh: GhRunner = ghPrView, options: PrPollerOptions = {}) {
    this.tasks = tasks;
    this.runGh = runGh;
    this.fastWindowMs = options.fastWindowMs ?? FAST_WINDOW_MS;
    this.now = options.now ?? Date.now;
    this.metrics = options.metrics;
    this.resolveLocalRepo = options.resolveLocalRepo ?? resolveLocalGithubRepo;
    this.findPr = options.findPr ?? findGithubPrByBranch;
    this.resolveHead = options.resolveHead ?? resolveLocalHead;
    this.resolveCheckout = options.resolveCheckout ?? ((task) => task.project);
  }

  start(intervalMs = POLL_INTERVAL_MS, fastIntervalMs = FAST_POLL_MS): void {
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, intervalMs);
    this.timer.unref?.();
    this.fastTimer = setInterval(() => {
      void this.fastTick().catch(() => {});
    }, fastIntervalMs);
    this.fastTimer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.fastTimer) {
      clearInterval(this.fastTimer);
      this.fastTimer = undefined;
    }
  }

  // Put a task's PR on the fast cadence for one window - called when change is
  // expected soon (PR just attached, checks unsettled, sibling merge).
  armFast(taskId: string): void {
    this.fastUntil.set(taskId, this.now() + this.fastWindowMs);
  }

  // One reconcile pass over every poll-worthy task. Exposed for tests and for
  // an eager poll right after a PR is attached.
  async tick(): Promise<void> {
    await this.poll(() => true, "baseline");
  }

  // The fast lane: only tasks inside their fast window. A no-op (zero gh
  // calls) when nothing is expecting change.
  async fastTick(): Promise<void> {
    const now = this.now();
    for (const [taskId, until] of this.fastUntil) {
      if (until <= now) {
        this.fastUntil.delete(taskId);
      }
    }
    if (this.fastUntil.size === 0) {
      return;
    }
    await this.poll((task) => this.fastUntil.has(task.id), "fast");
  }

  // Bind a worker-named PR to a task at the done gate. Identity (repo + head
  // repo) must match the task's repo, and the PR must provably carry the
  // worker's delivered commits. That proof is the PR head commit equalling the
  // worker's checkout HEAD - branch-name equality is NOT required, so a worker
  // briefed to reuse an existing branch/PR (head != the auto-assigned task
  // branch) can still report done. Only when the checkout HEAD cannot be read
  // do we fall back to the deterministic task-branch binding, so an arbitrary
  // or foreign PR URL is never accepted blind.
  async resolveTaskPr(task: Task, prUrl: string, checkoutPath = task.project): Promise<TaskPrAttachment> {
    const view = await this.runGh(prUrl);
    if (!view) {
      return { ok: false, reason: `could not inspect PR: ${prUrl}` };
    }
    // A PR closed without merging is rejected work; it can never stand as a
    // task deliverable. OPEN and MERGED (the fast-merge race) both bind.
    if (view.state === "CLOSED" && !view.mergedAt) {
      return { ok: false, reason: `PR was closed without merging: ${prUrl}` };
    }
    let expectedRepo: string | undefined;
    try {
      expectedRepo = await this.resolveLocalRepo(task.project);
    } catch {
      expectedRepo = undefined;
    }
    const identity = validateTaskPrIdentity(task, prUrl, view, expectedRepo);
    if (!identity.ok) {
      return identity;
    }
    const expectedOid = await this.resolveHead(checkoutPath).catch(() => undefined);
    if (expectedOid) {
      // The PR head commit must be exactly the worker's checkout HEAD. This both
      // admits reused branches (whatever their name) and refuses a stale PR that
      // is missing the worker's latest commits.
      if (view.headRefOid !== expectedOid) {
        return {
          ok: false,
          reason: view.headRefOid
            ? `PR head commit ${view.headRefOid} does not match checkout HEAD ${expectedOid}`
            : `could not determine PR head commit; expected checkout HEAD ${expectedOid}`
        };
      }
    } else {
      // No readable checkout HEAD to prove the PR carries the worker's commits:
      // fall back to the deterministic task-branch binding.
      const branch = task.branch?.trim();
      if (!branch || identity.actual.head !== branch) {
        return {
          ok: false,
          reason: identity.actual.head
            ? `PR head branch ${identity.actual.head} does not match task branch ${branch ?? "missing"} and the checkout HEAD could not be read to verify its commits`
            : `could not verify PR ${prUrl}: no readable checkout HEAD and no PR head branch to bind to task branch ${branch ?? "missing"}`
        };
      }
    }
    return {
      ok: true,
      pr: {
        url: prUrl,
        repo: identity.expected.repo,
        headRepo: identity.actual.headRepo,
        ...(identity.actual.head ? { head: identity.actual.head } : {}),
        ...(view.headRefOid ? { headOid: view.headRefOid } : {})
      }
    };
  }

  // A dispatched task has a server-minted branch, so it never needs to rely
  // on an agent remembering to paste a URL. Refuse ambiguity rather than
  // binding an arbitrary PR with a matching title or recent timestamp.
  async discoverTaskPr(task: Task): Promise<{ ok: true; prUrl: string } | { ok: false; reason: string }> {
    const branch = task.branch?.trim();
    if (!branch) {
      return { ok: false, reason: "task has no deterministic branch to bind to a PR" };
    }
    let repo: string | undefined;
    try {
      repo = await this.resolveLocalRepo(task.project);
    } catch {
      repo = undefined;
    }
    if (!repo) {
      return { ok: false, reason: `could not determine GitHub repo for task project: ${task.project}` };
    }
    let urls: string[] | undefined;
    try {
      urls = await this.findPr(repo, branch);
    } catch {
      urls = undefined;
    }
    if (!urls || urls.length === 0) {
      return { ok: false, reason: `no pull request found for ${repo} branch ${branch}` };
    }
    if (urls.length !== 1) {
      return { ok: false, reason: `multiple pull requests found for ${repo} branch ${branch}` };
    }
    return { ok: true, prUrl: urls[0]! };
  }

  private async poll(include: (task: Task) => boolean, mode: "baseline" | "fast"): Promise<void> {
    // Single-flight across both cadences: gh calls run one at a time and a
    // fast tick never stacks onto a still-running baseline pass.
    if (this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      for (const listed of this.tasks.list()) {
        let task = listed;
        // GitHub is an independent completion signal. A worker report may be
        // missing because its hook credentials were stale, but a unique PR on
        // the server-minted branch can still be verified against checkout HEAD
        // and durably finish any live code task. Baseline-only keeps the fast
        // lane scoped to already attached PRs.
        if (mode === "baseline" && shouldDiscover(task)) {
          task = await this.discoverAndFinish(task);
        }
        if (!shouldPoll(task) || !include(task)) {
          continue;
        }
        this.metrics?.increment(`prPoller.${mode}Polls`);
        const view = await this.runGh(task.pr!.url);
        if (!view) {
          continue;
        }
        let expectedRepo: string | undefined;
        try {
          expectedRepo = await this.resolveLocalRepo(task.project);
        } catch {
          expectedRepo = undefined;
        }
        this.apply(task, view, expectedRepo);
      }
    } finally {
      this.inFlight = false;
    }
  }

  private async discoverAndFinish(task: Task): Promise<Task> {
    const discovered = await this.discoverTaskPr(task);
    if (!discovered.ok) {
      return task;
    }
    // A PR that predates the worker's current park does not answer that park:
    // trailing completion must preserve a deliberate needs_decision/blocked
    // report. A PR opened after the park is new external evidence, exactly the
    // live #147 shape, and may complete it independently of a failed hook.
    const view = await this.runGh(discovered.prUrl);
    const created = view?.createdAt ? Date.parse(view.createdAt) : Number.NaN;
    const openedAt = Number.isFinite(created) ? created : undefined;
    const parkWins = (candidate: Task): boolean => {
      const parkedAt = this.tasks.workerParkedAt(candidate);
      return parkedAt !== undefined && (openedAt === undefined || openedAt <= parkedAt);
    };
    if (parkWins(task)) {
      return task;
    }
    const attachment = await this.resolveTaskPr(task, discovered.prUrl, this.resolveCheckout(task));
    if (!attachment.ok) {
      return task;
    }
    // Re-read the ledger after the awaited gh/git calls: the task must still
    // be a discovery candidate (live state, no PR attached - a concurrent
    // worker done may have bound a different PR, and a failed task takes no
    // attachment), and a worker park that landed mid-flight wins with the
    // still-unattached PR staying discoverable for a later sweep should it
    // genuinely postdate that park.
    const current = this.tasks.find(task.id) ?? task;
    if (!shouldDiscover(current) || parkWins(current)) {
      return current;
    }
    const attached = this.tasks.update(current.id, { pr: attachment.pr });
    return this.finishAttached(attached);
  }

  private finishAttached(task: Task): Task {
    try {
      const updated = this.tasks.recordEvent(task.id, {
        kind: "completion_requested",
        source: "system",
        message: `pull request discovered independently for mate verification: ${task.pr!.url}`,
        data: { evidence: "independent_pr_discovery", head: task.pr?.headOid }
      });
      this.armFast(task.id);
      return updated;
    } catch {
      // A concurrent worker event may already have completed the task. Reload
      // so this pass can poll the attached PR without emitting a second done.
      return this.tasks.find(task.id) ?? task;
    }
  }

  private apply(task: Task, view: GhPrView, expectedRepo: string | undefined): void {
    // A bound PR is pinned to the head it was accepted on (the recorded
    // pr.head, which may differ from the auto-assigned task branch for a reused
    // branch), falling back to the task branch until the head is recorded. This
    // guards against the PR URL later resolving to a different branch.
    const expectedHead = task.pr?.head ?? task.branch;
    const identity = validateTaskPrIdentity(task, task.pr!.url, view, expectedRepo, expectedHead);
    const pr: TaskPr = { ...task.pr! };
    let changed = false;
    let checksTurnedGreen = false;
    let mergeReadyTurnedTrue = false;
    let justMerged = false;

    if (identity.ok && !pr.repo) {
      pr.repo = identity.expected.repo;
      changed = true;
    }
    if (identity.ok && !pr.headRepo) {
      pr.headRepo = identity.actual.headRepo;
      changed = true;
    }
    const checks = rollupState(view.statusCheckRollup);
    if (checks && checks !== pr.checks) {
      pr.checks = checks;
      changed = true;
      checksTurnedGreen = checks === "passing";
    }
    const checkDetails = rollupDetails(view.statusCheckRollup);
    if (checkDetails && !sameCheckDetails(checkDetails, pr.checkDetails)) {
      pr.checkDetails = checkDetails;
      changed = true;
    }
    // Record the head only once identity holds, so an unvalidated head can
    // never become the pinned `expectedHead` on the next pass.
    if (identity.ok && view.headRefName && !pr.head) {
      pr.head = view.headRefName;
      changed = true;
    }
    // `headOid` is the current observed head. Acceptance is bound to the
    // immutable completion request, so a head change invalidates readiness.
    if (identity.ok && view.headRefOid && pr.headOid !== view.headRefOid) {
      pr.headOid = view.headRefOid;
      changed = true;
    }
    const policyFields = prPolicyFields(view);
    for (const [key, value] of Object.entries(policyFields) as Array<[keyof TaskPr, TaskPr[keyof TaskPr]]>) {
      if (pr[key] !== value) {
        (pr as Record<string, unknown>)[key] = value;
        changed = true;
      }
    }
    const mergeReady = isMergeReady(task, view, checks, expectedRepo) && (identity.ok || !view.headRepository);
    if (pr.mergeReady !== mergeReady) {
      pr.mergeReady = mergeReady;
      changed = true;
      mergeReadyTurnedTrue = mergeReady;
    }
    if ((view.state === "MERGED" || view.mergedAt) && !pr.merged && identity.ok) {
      pr.merged = true;
      changed = true;
      justMerged = true;
    }

    // Persist the new PR state before emitting events, so a listener reacting to
    // `merged` (auto-return) already sees pr.merged set on the task it reads.
    if (changed) {
      this.tasks.update(task.id, { pr });
    }
    if (checksTurnedGreen) {
      this.tasks.recordEvent(task.id, { kind: "checks_green", source: "poller", message: pr.url });
    }
    if (mergeReadyTurnedTrue) {
      this.tasks.recordEvent(task.id, { kind: "merge_ready", source: "poller", message: pr.url });
    }
    if (justMerged && task.state === "done") {
      this.tasks.recordEvent(task.id, { kind: "merged", source: "poller", message: pr.url });
    }

    // Adaptive cadence: unsettled checks mean change is coming - keep the PR
    // in the fast window (sliding, re-armed each pass while pending). A merge
    // ends this PR's polling and often unblocks siblings in the same repo
    // (merge-train), so those get a fast window instead.
    if (justMerged) {
      this.fastUntil.delete(task.id);
      for (const other of this.tasks.list()) {
        if (other.id !== task.id && other.project === task.project && shouldPoll(other)) {
          this.armFast(other.id);
        }
      }
    } else if (checks === "pending") {
      this.armFast(task.id);
    }
  }
}

function shouldPoll(task: Task): boolean {
  return (
    (task.state === "completion_requested" || task.state === "done") &&
    !!task.pr?.url &&
    !task.pr.merged
  );
}

function shouldDiscover(task: Task): boolean {
  return (
    task.kind !== "scout" &&
    (task.state === "working" || task.state === "needs_you" || task.state === "blocked") &&
    !!task.branch?.trim() &&
    !task.pr?.url
  );
}

function rollupState(
  rollup: GhPrView["statusCheckRollup"]
): TaskPr["checks"] | undefined {
  if (!rollup || rollup.length === 0) {
    return undefined;
  }
  const states = rollup.map(checkState);
  if (states.some((state) => state === "failing")) {
    return "failing";
  }
  if (states.every((state) => state === "passing")) {
    return "passing";
  }
  return "pending";
}

function rollupDetails(rollup: GhPrView["statusCheckRollup"]): TaskPrCheck[] | undefined {
  if (!rollup) {
    return undefined;
  }
  return rollup.map((check, index) => ({
    name: checkName(check, index),
    state: checkState(check)
  }));
}

function checkName(check: NonNullable<GhPrView["statusCheckRollup"]>[number], index: number): string {
  return (check.name ?? check.context ?? check.workflowName ?? `check ${index + 1}`).trim();
}

function checkState(check: NonNullable<GhPrView["statusCheckRollup"]>[number]): TaskPrCheck["state"] {
  const value = check.conclusion ?? check.state ?? check.status ?? "";
  if (/FAILURE|ERROR|CANCELLED|TIMED_OUT|ACTION_REQUIRED/i.test(value)) {
    return "failing";
  }
  if (/SUCCESS|NEUTRAL|SKIPPED/i.test(value)) {
    return "passing";
  }
  if (/PENDING|QUEUED|IN_PROGRESS|REQUESTED|WAITING|EXPECTED/i.test(value)) {
    return "pending";
  }
  return value ? "unknown" : "pending";
}

function sameCheckDetails(a: TaskPrCheck[], b: TaskPrCheck[] | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b ?? []);
}

function prPolicyFields(view: GhPrView): Partial<TaskPr> {
  return {
    ...(typeof view.isDraft === "boolean" ? { isDraft: view.isDraft } : {}),
    ...(view.mergeable !== undefined && view.mergeable !== null ? { mergeable: String(view.mergeable) } : {}),
    ...(view.mergeStateStatus ? { mergeStateStatus: view.mergeStateStatus } : {}),
    ...(view.reviewDecision ? { reviewDecision: view.reviewDecision } : {})
  };
}

function isMergeReady(task: Task, view: GhPrView, checks: TaskPr["checks"] | undefined, expectedRepo: string | undefined): boolean {
  const prUrl = task.pr?.url;
  const prRepo = prUrl ? githubRepoFromUrl(prUrl) : undefined;
  // Track the head the PR was accepted on (recorded pr.head), falling back to
  // the task branch, so a reused-branch PR reaches merge_ready too.
  const expectedHead = task.pr?.head ?? task.branch;
  return (
    view.state === "OPEN" &&
    checks === "passing" &&
    !!expectedRepo &&
    !!prRepo &&
    expectedRepo === prRepo &&
    !!expectedHead &&
    view.headRefName === expectedHead &&
    view.isDraft === false &&
    isMergeable(view.mergeable) &&
    String(view.mergeStateStatus ?? "").toUpperCase() === "CLEAN" &&
    reviewDecisionAllowsMerge(view.reviewDecision)
  );
}

function isMergeable(value: GhPrView["mergeable"]): boolean {
  if (value === true) {
    return true;
  }
  return String(value ?? "").toUpperCase() === "MERGEABLE";
}

function reviewDecisionAllowsMerge(value: GhPrView["reviewDecision"]): boolean {
  if (value === undefined || value === null || value === "") {
    return true;
  }
  return String(value).toUpperCase() === "APPROVED";
}

async function resolveLocalGithubRepo(project: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", project, "remote", "get-url", "origin"], { timeout: 5_000 });
    return githubRepoFromUrl(stdout.trim());
  } catch {
    return undefined;
  }
}

function githubRepoFromUrl(value: string): string | undefined {
  const scp = value.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (scp) {
    return normalizeGithubRepo(scp[1], scp[2]);
  }
  try {
    const parsed = new URL(value);
    if (parsed.hostname.toLowerCase() !== "github.com") {
      return undefined;
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      return undefined;
    }
    return normalizeGithubRepo(parts[0], parts[1]);
  } catch {
    return undefined;
  }
}

function normalizeGithubRepo(owner: string | undefined, repo: string | undefined): string | undefined {
  if (!owner || !repo) {
    return undefined;
  }
  return `${owner}/${repo.replace(/\.git$/i, "")}`.toLowerCase();
}

async function ghPrView(prUrl: string): Promise<GhPrView | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "pr",
        "view",
        prUrl,
        "--json",
        "state,mergedAt,createdAt,headRefName,headRefOid,headRepository,statusCheckRollup,isDraft,mergeable,mergeStateStatus,reviewDecision"
      ],
      { timeout: 30_000 }
    );
    return JSON.parse(stdout) as GhPrView;
  } catch {
    return undefined;
  }
}

async function resolveLocalHead(project: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", project, "rev-parse", "HEAD"], { timeout: 5_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function findGithubPrByBranch(repo: string, branch: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "list", "--repo", repo, "--head", branch, "--state", "all", "--limit", "10", "--json", "url,state"],
      { timeout: 30_000 }
    );
    const rows = JSON.parse(stdout) as Array<{ url?: unknown; state?: unknown }>;
    // Closed-unmerged PRs are rejected work: never candidates, and never a
    // source of ambiguity against the branch's one live PR.
    return rows.flatMap((row) =>
      typeof row.url === "string" && row.url && String(row.state ?? "").toUpperCase() !== "CLOSED"
        ? [row.url]
        : []
    );
  } catch {
    return undefined;
  }
}

// The first https://github.com/.../pull/N URL in a worker's done message.
export function extractPrUrl(text: string | undefined): string | undefined {
  return text?.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/)?.[0];
}

// Repo/head-repo identity of a PR against the task's project repo, with an
// optional head-branch gate. `expectedHead` is supplied only by callers that
// have a branch the PR must still match (the poller pins a bound PR to the head
// it was accepted on); the done gate omits it and proves commit ownership by
// head-OID instead, so a reused branch whose name differs from the task branch
// is admitted, matching the branch-reuse identity rule.
export function validateTaskPrIdentity(
  task: Task,
  prUrl: string,
  view: GhPrView,
  expectedRepo: string | undefined,
  expectedHead?: string | undefined
): PrIdentityVerdict {
  if (!expectedRepo) {
    return { ok: false, reason: `could not determine GitHub repo for task project: ${task.project}` };
  }
  const prRepo = githubRepoFromUrl(prUrl);
  if (!prRepo) {
    return { ok: false, reason: `not a GitHub pull request URL: ${prUrl}` };
  }
  if (prRepo !== expectedRepo) {
    return { ok: false, reason: `PR repo ${prRepo} does not match task repo ${expectedRepo}` };
  }

  const headRepo = githubRepoFromGhRepository(view.headRepository);
  if (!headRepo) {
    return { ok: false, reason: "could not determine PR head repository" };
  }
  if (headRepo !== expectedRepo) {
    return { ok: false, reason: `PR head repo ${headRepo} does not match task repo ${expectedRepo}` };
  }

  const wantHead = expectedHead?.trim();
  const actualHead = view.headRefName?.trim();
  if (wantHead && !actualHead) {
    return { ok: false, reason: `could not determine PR head branch; expected ${wantHead}` };
  }
  if (wantHead && actualHead !== wantHead) {
    return { ok: false, reason: `PR head branch ${actualHead} does not match ${wantHead}` };
  }

  return {
    ok: true,
    expected: { repo: expectedRepo, ...(wantHead ? { head: wantHead } : {}) },
    actual: { repo: prRepo, headRepo, ...(actualHead ? { head: actualHead } : {}) }
  };
}

export async function validateRecordedTaskPrIdentity(task: Task): Promise<PrIdentityVerdict> {
  if (!task.pr) {
    return { ok: false, reason: "task has no PR" };
  }
  const expectedRepo = await resolveLocalGithubRepo(task.project);
  if (!expectedRepo) {
    return { ok: false, reason: `could not determine GitHub repo for task project: ${task.project}` };
  }
  const prRepo = githubRepoFromOwnerRepoString(task.pr.repo) ?? githubRepoFromUrl(task.pr.url);
  if (!prRepo) {
    return { ok: false, reason: `could not determine PR repo for ${task.pr.url}` };
  }
  if (prRepo !== expectedRepo) {
    return { ok: false, reason: `PR repo ${prRepo} does not match task repo ${expectedRepo}` };
  }

  const headRepo = githubRepoFromOwnerRepoString(task.pr.headRepo);
  if (task.pr.headRepo && !headRepo) {
    return { ok: false, reason: `could not determine PR head repo from ${task.pr.headRepo}` };
  }
  if (headRepo && headRepo !== expectedRepo) {
    return { ok: false, reason: `PR head repo ${headRepo} does not match task repo ${expectedRepo}` };
  }

  // The recorded head is the branch the done gate accepted (possibly a reused
  // branch differing from the auto-assigned task branch), so the landed gate
  // trusts it rather than re-requiring task-branch equality. Repo/head-repo
  // identity plus the authoritative merge flag are the guard here.
  const actualHead = task.pr.head?.trim();

  return {
    ok: true,
    expected: { repo: expectedRepo, ...(actualHead ? { head: actualHead } : {}) },
    actual: { repo: prRepo, headRepo: headRepo ?? expectedRepo, ...(actualHead ? { head: actualHead } : {}) }
  };
}

function githubRepoFromGhRepository(repository: GhRepository | null | undefined): string | undefined {
  if (!repository) {
    return undefined;
  }
  const named = githubRepoFromOwnerRepoString(repository.nameWithOwner);
  if (named) {
    return named;
  }
  if (repository.owner?.login && repository.name) {
    return normalizeGithubRepo(repository.owner.login, repository.name);
  }
  return repository.url ? githubRepoFromUrl(repository.url) : undefined;
}

function githubRepoFromOwnerRepoString(repo: string | undefined): string | undefined {
  const trimmed = repo?.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed || !/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
    return undefined;
  }
  const [owner, name] = trimmed.split("/");
  return normalizeGithubRepo(owner, name);
}
