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

export type TaskPresentationFacts = {
  pr?: TaskPr;
  verification?: TaskVerificationFacts;
};

// GitHub facts only satisfy the PR half of readiness. A mate decision bound to
// the immutable completion request is always required as well, and readiness
// exists only while the acceptance's `done` state stands - resumed work
// (done -> failed -> working) surrenders it.
export function deriveTaskPresentation(task: Task, facts: TaskPresentationFacts = {}): TaskPresentation {
  if (task.state === "closed") return { state: "closed" };
  if (task.state === "failed") return { state: "failed" };
  if (task.state === "needs_you") return { state: "needs_you" };
  if (task.state === "blocked") return { state: "blocked" };
  if (task.state === "completion_requested") return { state: "awaiting_verification" };
  if (task.state !== "done") return { state: "working" };
  const verification = facts.verification;
  const deliverable = verification?.accepted ? verification.deliverable : undefined;
  if (task.mode === "local-only") {
    if (
      deliverable?.kind === "local" &&
      Boolean(deliverable.revision) &&
      (verification?.acceptedRevision === undefined || verification.acceptedRevision === deliverable.revision)
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
