import type { Task, TaskPr, TaskPresentation } from "@perch/shared";

export type TaskDeliverable =
  | { kind: "pr"; headOid?: string }
  | { kind: "local"; revision?: string }
  | { kind: "report" };

// The durable verification facts for a task's latest completion request:
// which deliverable it named, whether the mate accepted it, and (local-only)
// the checkout HEAD the mate observed at accept time.
export type TaskVerificationFacts = {
  requestSeq: number;
  deliverable?: TaskDeliverable;
  accepted: boolean;
  acceptedRevision?: string;
};

// The durable review receipt state for the task's latest bundled AutoReview
// attempt. A presentation never infers this state from task mode or prompt
// wording.
export type TaskReviewFacts = {
  state: "running" | "findings" | "clean" | "failed" | "superseded" | "scope_paused";
  attemptId: string;
};

export type TaskPresentationFacts = {
  pr?: TaskPr;
  verification?: TaskVerificationFacts;
  review?: TaskReviewFacts;
};

// GitHub facts only satisfy the PR half of readiness. A mate decision bound to
// the immutable completion request is always required as well, and readiness
// exists only while the acceptance's `done` state stands - resumed work
// (done -> failed -> working) surrenders it.
export function deriveTaskPresentation(task: Task, facts: TaskPresentationFacts = {}): TaskPresentation {
  if (task.state === "closed") return { state: "closed" };
  // Merged work is finished work: it leaves the active list immediately
  // instead of wearing a badge until teardown closes the record.
  if (task.state === "landed") return { state: "closed" };
  if (task.state === "failed") return { state: "failed" };
  if (task.state === "needs_you") return { state: "needs_you" };
  if (task.state === "blocked") return { state: "blocked" };
  if (task.state === "completion_requested") return { state: "awaiting_verification" };
  // Review state belongs to the durable AutoReview receipt.  Legacy delivery
  // modes cannot promote a task into Reviewing.
  if (task.kind === "ship" && task.state === "working" && facts.review?.state === "running") return { state: "reviewing" };
  if (task.state !== "done") return { state: "working" };
  const verification = facts.verification;
  const deliverable = verification?.accepted ? verification.deliverable : undefined;
  // Kept solely so persisted local-only records retain their historic
  // recovery/presentation semantics during the migration window. New task
  // creation cannot produce this mode.
  if (task.mode === "local-only") {
    if (
      deliverable?.kind === "local" &&
      Boolean(deliverable.revision) &&
      verification?.acceptedRevision === deliverable.revision
    ) return { state: "ready_to_apply" };
    return { state: "working" };
  }
  if ((task.kind === "operate" || task.kind === "scout") && verification?.accepted && deliverable?.kind === "report") {
    return { state: "verified_done" };
  }
  if (task.kind === "operate" || task.kind === "scout") return { state: "working" };
  const pr = facts.pr ?? task.pr;
  if (
    deliverable?.kind === "pr" &&
    Boolean(deliverable.headOid) && pr?.headOid === deliverable.headOid &&
    pr?.checks === "passing" && pr?.mergeable?.toUpperCase() === "MERGEABLE" && pr?.mergeReady === true
  ) return { state: "ready_to_merge" };
  return { state: "working" };
}
