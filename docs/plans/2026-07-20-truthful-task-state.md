# Truthful task-state model

Date: 2026-07-20
Reference: boss-approved task-state model

## Decision

The server owns one durable task-state projection derived from independently persisted lifecycle, pull-request, and verification facts.
Worker and FleetMonitor live status remain runtime evidence only and are not a second task-status authority.

The primary task badges are Working, Reviewing, Needs You, Blocked, Awaiting Verification, Ready to Merge, Ready to Apply, and Failed.
Reviewing appears only while a no-mistakes task is actively in its durable working lifecycle state.
Direct-PR and local-only tasks remain Working until they reach Awaiting Verification.
Starting remains only where the existing short runtime transient needs it.
Closed tasks are removed from active presentation immediately.
There are no persistent Completed or Merged badges.

## Durable facts and derivation

Lifecycle facts record work, blocking, failure, completion requests, acceptance, rejection, and closure.
PR facts record the attached PR, its current head SHA, required-check state, and GitHub mergeability.
Verification facts bind a mate acceptance or rejection to the immutable completion request and its exact deliverable identity.

For direct-PR and no-mistakes tasks, Ready to Merge is true only when the mate accepted the latest completion request for the current PR head SHA, that exact head has green required checks, and GitHub says it is mergeable.
Any later rejection, work-resumption event, or PR head change invalidates the earlier acceptance.
No-mistakes additionally cannot request completion until its pipeline has completed.

For local-only tasks, Ready to Apply is true only when the mate accepted the latest completion request for the current local deliverable.
Local-only never presents PR terminology.
Awaiting Verification means the latest completion request has not yet been decided, regardless of whether a PR already exists.

## Presentation

The API exposes the derived presentation state and the separate durable facts required to explain it.
iOS renders the primary badge from that derived state rather than inferring readiness from PR checks or mergeability.
A neutral, linkable PR #N chip sits beside the worker name whenever a PR exists and never changes the primary badge.
No secondary status detail is shown.

## Implementation and verification

Add SQLite migration and projection accessors for the separately durable lifecycle, PR, and verification facts.
Update completion decisions, work resumption, and PR polling to invalidate verification exactly when their causal facts change.
Keep the existing per-request Codex approval bookkeeping and Needs You behavior from PR #30 unchanged.

Reproduce the current stale Ready to Merge behavior before the change.
Add focused lifecycle and API tests for rejection after a green PR, new-head invalidation, checks changing, exact-head acceptance, local-only Ready to Apply, closed-task hiding, and ordinary Working, Needs You, Blocked, and Failed states.
Add iOS presentation tests for primary-badge derivation, Reviewing, and PR-chip separation.
Run E2E-style reproduction coverage, server and shared tests, Swift tests, typecheck, builds, the no-mistakes pipeline, and PR CI.

## Risks and open questions

GitHub snapshots are eventually consistent, so readiness stays absent until the poller has a current mergeability and checks observation for the accepted SHA.
Historical tasks must remain readable when the new facts are absent and must never gain readiness merely from old PR metadata.
The implementation must leave unrelated task detail and runtime surfaces unchanged.
