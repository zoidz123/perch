import type { Task, TaskPr, TaskPresentation } from "@perch/shared";

export type TaskDeliverable = { kind: "pr"; headOid?: string } | { kind: "local"; revision?: string };

// The durable verification facts for a task's latest completion request:
// which deliverable it named, whether the mate accepted it, and (local-only)
// the checkout HEAD the mate observed at accept time.
export type TaskVerificationFacts = {
  requestSeq: number;
  deliverable?: TaskDeliverable;
  accepted: boolean;
  acceptedRevision?: string;
};

// The durable proof that a task's work entered the no-mistakes review
// pipeline: the seq of the latest allowed runtime authorization (run,
// gate-push, or agent-launch) not yet superseded by a return to working.
export type TaskReviewFacts = {
  enteredSeq: number;
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
  // A no-mistakes task is Reviewing only while the durable review facts prove
  // the pipeline is actively engaged: an allowed runtime authorization not yet
  // superseded by a return to working. Mode alone never promotes Working -
  // scouting and implementation stay Working until the gate truly starts.
  if (task.mode === "no-mistakes" && task.state === "working" && facts.review) return { state: "reviewing" };
  if (task.state !== "done") return { state: "working" };
  const verification = facts.verification;
  const deliverable = verification?.accepted ? verification.deliverable : undefined;
  if (task.mode === "local-only") {
    if (
      deliverable?.kind === "local" &&
      Boolean(deliverable.revision) &&
      verification?.acceptedRevision === deliverable.revision
    ) return { state: "ready_to_apply" };
    return { state: "working" };
  }
  const pr = facts.pr ?? task.pr;
  if (
    deliverable?.kind === "pr" &&
    Boolean(deliverable.headOid) && pr?.headOid === deliverable.headOid &&
    pr?.checks === "passing" && pr?.mergeable?.toUpperCase() === "MERGEABLE" && pr?.mergeReady === true
  ) return { state: "ready_to_merge" };
  return { state: "working" };
}
