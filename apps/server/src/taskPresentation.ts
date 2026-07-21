import type { Task, TaskEvent, TaskPresentation } from "@perch/shared";

type Deliverable = { kind: "pr"; headOid?: string } | { kind: "local"; revision?: string };

// GitHub facts only satisfy the PR half of readiness. A mate decision bound to
// the immutable completion request is always required as well.
export function deriveTaskPresentation(task: Task, events: TaskEvent[]): TaskPresentation {
  if (task.state === "closed") return { state: "closed" };
  if (task.state === "failed") return { state: "failed" };
  if (task.state === "needs_you") return { state: "needs_you" };
  if (task.state === "blocked") return { state: "blocked" };
  if (task.state === "completion_requested") return { state: "awaiting_verification" };
  const request = [...events].reverse().find((event) => event.kind === "completion_requested");
  const accepted = request && events.some((event) =>
    event.kind === "completion_accepted" &&
    (event.data as { completionDecision?: { requestSeq?: number } } | undefined)?.completionDecision?.requestSeq === request.seq
  );
  const deliverable = request?.data?.deliverable as Deliverable | undefined;
  if (accepted && task.mode === "local-only" && deliverable?.kind === "local") return { state: "ready_to_apply" };
  if (
    accepted && deliverable?.kind === "pr" && task.mode !== "local-only" &&
    Boolean(deliverable.headOid) && task.pr?.headOid === deliverable.headOid &&
    task.pr?.checks === "passing" && task.pr?.mergeable?.toUpperCase() === "MERGEABLE" && task.pr?.mergeReady === true
  ) return { state: "ready_to_merge" };
  return { state: "working" };
}
