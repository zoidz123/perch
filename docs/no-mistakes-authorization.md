# No-mistakes authorization

Perch treats task mode as negative capability policy for the expensive no-mistakes pipeline.
Only a worker linked to a durable task whose mode is exactly `no-mistakes` may start that pipeline.
An explicit per-task mode persisted before dispatch takes precedence over the project default in either direction.
Prompt words, size heuristics, repository initialization, an existing gate remote, and global skill visibility never grant authorization.

## Perch-owned verifier

Perch workers receive non-secret `PERCH_TASK_ID`, `PERCH_TASK_MODE`, `PERCH_TASK_PROJECT`, `PERCH_TASK_WORKTREE`, and `PERCH_TASK_BRANCH` context.
These values are claims, not authority.
The existing `PERCH_SESSION_ID`, `PERCH_HOOK_URL`, and `PERCH_HOOK_TOKEN` values provide a short-lived, per-session credential that the server verifies against the durable task and current runtime.

The pipeline must send this request immediately before each protected operation:

```http
POST ${PERCH_HOOK_URL%/hooks}/hooks/no-mistakes/authorize
x-perch-session: $PERCH_SESSION_ID
x-perch-token: $PERCH_HOOK_TOKEN
content-type: application/json

{
  "taskId": "$PERCH_TASK_ID",
  "projectPath": "$PERCH_TASK_PROJECT",
  "worktreePath": "$PERCH_TASK_WORKTREE",
  "branch": "$PERCH_TASK_BRANCH",
  "operation": "run"
}
```

`operation` is one of `run`, `gate-push`, or `agent-launch`.
The server derives durable mode and runtime generation from its ledger.
It verifies task, project, worktree, branch, session, current runtime, and live generation before checking mode.
The response includes `allowed`, `taskId`, `runtimeGeneration`, `durableMode`, and `reason`.
Every validly authenticated attempt appends the same decision data to the immutable task event ledger and writes a secret-free operational audit record.
If durable evidence cannot be appended, the verifier fails closed.

## CLI and daemon contract

The no-mistakes CLI and daemon are a separate component and are not implemented in this repository.
Their integration must satisfy all of these rules before end-to-end enforcement is complete:

1. Treat the presence of any `PERCH_` task or hook variable as Perch-managed execution.
2. Reject incomplete Perch context instead of falling back to standalone behavior.
3. Call the verifier before creating a run record.
4. Call it again immediately before pushing to the gate remote.
5. Call it again immediately before launching any Claude or other review, test, document, or lint agent.
6. Continue only after an HTTP 200 response whose JSON has `allowed: true` and exactly matches the requested task scope.
7. Treat network errors, timeouts, malformed responses, non-200 responses, `allowed: false`, and scope mismatches as terminal policy denials.
8. Never cache an authorization across operations, sessions, tasks, repositories, worktrees, branches, or runtime generations.
9. Never accept prompt text, repository state, a gate remote, file counts, line counts, budgets, skill metadata, PATH selection, or an absolute executable path as authorization.
10. Preserve standalone no-mistakes behavior only when execution is genuinely outside a Perch worker context.

The gate must live inside the CLI, daemon, gate receiver, or credential broker required for all protected operations.
A PATH wrapper is insufficient because an absolute executable path bypasses it.
Perch recovery creates a fresh worker session and runtime generation, so credentials from the interrupted generation must be rejected and the replacement must authorize again.

## Current boundary

This repository owns mode persistence, dispatch policy text, scoped worker context, live server verification, and durable authorization evidence.
It does not own the installed no-mistakes CLI, daemon, run database, gate receiver, or Claude launch code.
Until that separate component implements the fail-closed calls above, Perch can issue and audit correct decisions but cannot prevent the external binary from ignoring them.
