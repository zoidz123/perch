# Worker task API and turn lifecycle

Perch separates provider turns, worker-reported task outcomes, and verified task completion.
A Claude or Codex turn ending is runtime evidence only.
A worker must report an outcome for the turn, and a worker's `done` report becomes a completion request that Mate must verify before the task enters `done`.

This guide documents the HTTP surface used to dispatch and supervise workers, the event endpoint workers call, and the hooks that enforce the per-turn reporting contract.
It does not catalog unrelated device, configuration, usage, or chart-review routes.

## Actors and credentials

The local server normally listens at `http://127.0.0.1:8787`.
Workers receive these values in their process environment (the PTY for Claude, the app-server daemon for Codex):

| Variable | Purpose |
| --- | --- |
| `PERCH_SESSION_ID` | Identifies the Perch-owned provider session. |
| `PERCH_HOOK_URL` | Points to the server's `POST /hooks` endpoint. |
| `PERCH_HOOK_TOKEN` | Authenticates only that session's hook and worker requests. |

Workers derive the server base URL with `${PERCH_HOOK_URL%/hooks}`.
They never receive the server bearer token.

Mate reads the local server token and uses bearer authentication:

```sh
TOKEN=$(cat "${PERCH_HOME:-$HOME/.perch}/token")
BASE=${PERCH_HOOK_URL%/hooks}
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/tasks"
```

| Credential | Intended caller | Accepted by |
| --- | --- | --- |
| Session headers `x-perch-session` and `x-perch-token` | Provider hooks and the worker | `POST /hooks`, the worker form of `POST /tasks/:id/events`, and adjacent worker capabilities such as chart registration |
| `Authorization: Bearer <server-token>` | Mate and local CLI tools | Authenticated task and session routes |
| Paired device bearer token | iPhone | Most authenticated read and control routes, but not completion verification |

For `POST /tasks/:id/events`, the session in `x-perch-session` must be the session currently linked to that task.
Hook-token events are persisted with `source: "worker"`.
Bearer-authenticated events are persisted with `source: "system"` and do not satisfy the worker's per-turn outcome requirement.

## Endpoint map

| Method and path | Caller | Purpose |
| --- | --- | --- |
| `POST /tasks` | Mate | Create a task and, with `dispatch: true`, acquire a worktree, start a worker, and link the runtime. |
| `GET /tasks` | Mate, CLI, phone | List durable task projections. |
| `GET /tasks/:id` | Mate, CLI, phone | Read one task and its immutable ordered event log. |
| `POST /tasks/:id/events` | Worker | Report `working`, `pr_linked`, `needs_decision`, `blocked`, `done`, `failed`, or `note`. |
| `POST /hooks` | Installed provider hook | Report provider lifecycle signals such as turn start and turn completion. |
| `POST /tasks/:id/completion` | Mate with the server token | Accept or reject the latest worker completion request. |
| `POST /tasks/:id/decision` | Mate or phone | Answer a structured no-mistakes review gate reported through `needs_decision`. |
| `GET /sessions` | Mate, CLI, phone | Read live fleet and provider-session status. |
| `POST /sessions/:sessionId/input` | Mate, CLI, phone | Send or queue follow-up text to the worker session. |
| `POST /tasks/:id/recover` | Mate, CLI, phone | Resume the same verified provider conversation in a new runtime generation. |
| `POST /tasks/:id/teardown` | Mate, CLI, phone | Stop the worker, release its worktree, and close the task when the landed gate permits it. |

The authenticated routes use JSON request and response bodies.
Errors use an HTTP status plus an `{ "error": "..." }` body.
Authenticated WebSocket RPC exposes the same `GET /tasks` and `GET /tasks/:id` projections, including the linked PR fact.

## Dispatch and read endpoints

### `POST /tasks`

Mate normally sends:

```json
{
  "title": "Fix the upload retry",
  "project": "/absolute/path/to/project",
  "kind": "ship",
  "prompt": "Reproduce the failed retry, fix it, and add the focused regression test.",
  "dispatch": true,
  "parent": "<mate-session-id>",
  "idempotencyKey": "dispatch-upload-retry-v1"
}
```

`kind` is `ship` or `scout`.
The optional `mode` is `direct-PR`, `no-mistakes`, or `local-only`; otherwise the project setting and then the built-in default decide it.
Optional `agent`, `model`, and `effort` values override dispatch defaults for this task only.
Reusing an `idempotencyKey` returns the original durable dispatch instead of launching another worker.

With `dispatch: true`, the server appends the standard worker brief to `prompt`.
That brief contains the exact event commands, worktree and branch rules, and the mode-specific definition of done.

If dispatch fails before launch, Perch preserves the failed operation and failed task event before deciding whether to close the task automatically.
Auto-close requires the latest durable dispatch payload to show that launch never started and requires the task to have no session, runtime, worktree linkage, or task-owned lease.
Perch releases a pre-launch lease before evaluating that predicate.
Failures that launched or still own worker resources remain `failed` and visible.
At startup, Perch applies the same predicate once to repair matching historical failed rows; the append-only `closed` event makes the repair idempotent.

### `GET /tasks` and `GET /tasks/:id`

`GET /tasks` returns `{ "tasks": [...] }` for non-closed tasks and omits their stored prompts.
CLI history consumers may explicitly request `GET /tasks?includeClosed=1` to receive the full ledger with prompts intact.
An optional `planId` query filters tasks linked to one finalized plan.

`GET /tasks/:id` returns:

```json
{
  "task": { "id": "...", "state": "completion_requested" },
  "events": [
    { "seq": 1, "kind": "created", "source": "system", "at": "..." },
    { "seq": 8, "kind": "completion_requested", "source": "worker", "at": "..." }
  ]
}
```

Each returned task also carries a server-derived `presentation` with a single `state`:
`working`, `reviewing`, `needs_you`, `blocked`, `awaiting_verification`, `ready_to_merge`, `ready_to_apply`, `failed`, or `closed`.
It is derived from the durable lifecycle, PR, verification, and review facts, never persisted as task state, and clients render the primary task status from it instead of inferring readiness from PR checks or mergeability.
A `landed` task presents as `closed`, so merged work leaves the active task list immediately instead of wearing a badge until teardown closes the record.
A `working` `no-mistakes` task presents as `reviewing` only while durable review facts prove the pipeline is engaged: the latest allowed runtime authorization (`run`, `gate-push`, or `agent-launch`) recorded on the ledger, surrendered by any event that returns the state to `working`.
Mode alone never promotes the badge, so scouting and implementation stay `working` until the gate truly starts; other modes stay `working` until `awaiting_verification`.

Mate uses this detail endpoint before acting on a wake notification.
The event `seq` is the stable identifier used for completion decisions and turn-boundary evidence.

## Worker event endpoint

### `POST /tasks/:id/events`

A worker reports an outcome with its session credentials:

```sh
curl -sf -X POST "${PERCH_HOOK_URL%/hooks}/tasks/<task-id>/events" \
  -H "x-perch-session: $PERCH_SESSION_ID" \
  -H "x-perch-token: $PERCH_HOOK_TOKEN" \
  -H "content-type: application/json" \
  -d '{"kind":"blocked","message":"Waiting for the signing credential"}'
```

The request body is:

```json
{
  "kind": "working | pr_linked | needs_decision | blocked | done | failed | note",
  "message": "optional human-readable evidence",
  "pr": "optional pull request URL",
  "data": { "optional": "structured evidence" }
}
```

`message` and serialized `data` are each limited to 32 KiB.
`data` must be a JSON object.
The successful response is `{ "task": <updated-task> }`.

| Worker wire verb | Durable event | Resulting task state | Meaning |
| --- | --- | --- | --- |
| `working` | `working` | `working` | The worker started or resumed meaningful work. |
| `pr_linked` | `pr_linked` | unchanged | A remote ship task authenticated its canonical PR identity. The server validates and records the URL, repo, number, head branch, and head commit, then begins polling it without requesting completion. |
| `needs_decision` | `needs_decision` | `needs_you` | Work is parked on a human or Mate decision. |
| `blocked` | `blocked` | `blocked` | Work is parked on an external dependency. |
| `done` | `completion_requested` | `completion_requested` | The worker claims the definition of done is met and asks Mate to verify it. |
| `failed` | `failed` | `failed` | The worker cannot complete the task. |
| `note` | `note` | unchanged | Supplemental durable evidence that is not the turn's outcome. |

The `done` name is retained as the worker wire verb for compatibility.
It never directly creates trusted `done` state.

For remote ship tasks, report `pr_linked` as soon as the worker or no-mistakes pipeline creates or discovers the PR.
Its body must contain an explicit `pr` URL, never a URL scraped from ordinary working text.
The server verifies it against the task identity, persists the PR fact and `pr_linked` event atomically, and immediately exposes it through task snapshots while lifecycle state remains unchanged.
Repeating the same identity is harmless; a different PR is rejected.

For a non-scout, non-`local-only` task, every `done` request must re-resolve a valid pull request and validate its head commit against the task checkout `HEAD`, including when the task already has an attached merged PR.
The worker may send `pr`, include the URL in `message`, or let the server discover the unique PR for the server-minted branch.
The server attaches the validated PR before recording the completion request.
For `no-mistakes` tasks, the standard worker brief therefore requires inspecting `branch_sync`, running exactly `no-mistakes axi sync` when `next_action.code` is `sync`, and confirming the event response reached `task.state == completion_requested`.

## What happens when a provider turn completes

Every managed worker turn has two independent channels:

1. The provider lifecycle channel says a turn started or ended.
2. The worker event channel says what the turn accomplished for the durable task.

The server records the lifecycle channel as `turn_started` and `turn_completed` events with `source: "hook"`.
These events never change task state.

```text
provider turn starts
        |
        | record turn_started and taskEventSeqAtStart
        v
worker performs the turn
        |
        +---- POST one outcome: needs_decision, blocked, done, or failed
        |
        v
provider turn completes
        |
        +---- outcome exists after baseline -> record turn_completed
        |
        `---- no outcome after baseline -> record turn_completed + stalled
                                           and wake Mate
```

At turn start, Perch snapshots the latest immutable task-event sequence in `taskEventSeqAtStart`.
At turn completion, it looks only for a later event whose source is `worker` and whose kind is `needs_decision`, `blocked`, `completion_requested`, or `failed`.
An old report from a previous turn cannot satisfy the new turn.
A `working` heartbeat or `note` also cannot satisfy it because neither explains the turn's parked or finished outcome.

If the outcome exists, `turn_completed.data` includes `outcomeEventSeq` and `outcomeKind`.
If it does not, `turn_completed.data.retryNeeded` is `true`, and the server atomically records a `stalled` event with `data.reason: "turn_outcome_missing"`.
The task's semantic state is otherwise unchanged.

Claude and Codex provide the boundaries differently:

- Claude uses verified `UserPromptSubmit` and `Stop` hook reports sent to `POST /hooks`.
- Codex is app-server-owned and uses protocol turn-started and turn-completed notifications, avoiding duplicate evidence from compatibility hooks.
- On Claude's first `Stop` without an outcome, Perch returns additional hook context asking the worker to report one accurate outcome before stopping.
  Claude's `stop_hook_active` loop guard permits only this one continuation.
- A Codex turn-completed notification is settled and cannot be continued in the same way, so the durable `stalled` event wakes Mate to retry or steer the worker.

A dispatched Codex worker's kickoff is the first acknowledged `turn/start` against the thread the launch established, never a typed prompt.
The ledger carries the durable contract: a `note` with `data.reason: "kickoff_submitted"` (including the stable `clientUserMessageId`) lands before the send, and `data.reason: "kickoff_accepted"` with the provider `turnId` lands only after a successful response or history reconciliation.
A rejected `turn/start` parks the task `blocked` with `data.reason: "kickoff_rejected"` and the provider's real error; an outcome that stays unknown after `thread/read` reconciliation parks it `blocked` with `data.reason: "kickoff_unknown"` and is never blindly resent.
After a restart, a kickoff journaled as submitted but never acknowledged reconciles against authoritative thread history by its `clientUserMessageId`: found means accepted is recorded, verifiably absent means the exact kickoff is resubmitted once with the same id.
Claude's kickoff rides the spawn argv as the CLI's positional query; launches whose brief exceeds the spawn-argument limit are refused rather than truncated.
Process argv is readable across users for the life of the session (world-readable `/proc/<pid>/cmdline` on default Linux, `ps aux` on macOS), unlike the 0600 same-user transcript files, so on shared machines a sensitive brief is more exposed than it was on the typed-prompt path.

Every server-originated Claude text prompt is journaled in SQLite before submission, including the positional kickoff and later composer or Mate follow-ups.
Follow-ups still use Claude's native PTY TUI: Perch types the prompt, verifies that distinctive text reached the input line when possible, and sends exactly one Enter.
The delivery becomes accepted only from a matching verified `UserPromptSubmit` hook or a matching transcript user row with an authentic provider timestamp.
Receipt IDs, durable ordering, timestamp boundaries, and conservative same-text matching prevent transcript replay or an older identical prompt from accepting a newer delivery.
A receipt timeout, process loss, or server restart records either `prompt_not_submitted` or `prompt_delivery_unknown`; Perch never blindly resends uncertain input.
The worker task ledger records the warning and any later authentic resolution, while `GET /sessions` and fleet snapshots expose `promptDeliveryWarning` or `promptDeliveryResolution` so Mate and reconnecting clients see the durable result.

Provider prose is never treated as the outcome.
Even if the final assistant message says the work is finished, Mate must rely on the durable worker event and verify the deliverable.

## Completion verification

When the worker posts `done`, the lifecycle is:

```text
working -> completion_requested -> done -> landed -> closed
                    |                ^
                    | reject         | accept
                    v                |
                  working -----------+
```

`completion_requested` wakes Mate.
Mate reads `GET /tasks/:id`, checks the original `task.prompt`, the worker's claim, worktree or repository evidence, the attached PR, and relevant tests or checks.

Mate then calls `POST /tasks/:id/completion` with the local server bearer token:

```json
{
  "action": "accept",
  "requestSeq": 8,
  "idempotencyKey": "accept-task-123-request-8"
}
```

To reject:

```json
{
  "action": "reject",
  "requestSeq": 8,
  "feedback": "The regression test does not cover the user-visible retry path.",
  "idempotencyKey": "reject-task-123-request-8-v1"
}
```

`requestSeq` must identify the latest `completion_requested` event.
This prevents a delayed decision from accepting a newer claim after the worker has retried.
An idempotency key may be retried with the same decision, but reusing it for different decision data returns `409`.

Accept records `completion_accepted` and moves the task to `done`.
If the attached PR merged during review, the server then records the merge and advances the task to `landed`.
After a trusted `done` PR is first observed as merge-ready, the server keeps it on the fast polling cadence until GitHub reports it merged or closed.
A temporary readiness regression or server restart does not return that PR to the baseline cadence.

Every completion request is bound to the exact deliverable it claims: the current PR head SHA for PR modes, or the exact checkout HEAD commit SHA for `local-only`.
The derived `ready_to_merge` presentation holds only while the mate's acceptance of the latest completion request still matches the current PR head and that head has passing checks and GitHub mergeability.
`ready_to_apply` requires the acceptance to have recorded the same checkout HEAD commit the completion request pinned; if either revision cannot be read or they differ, readiness stays absent.
The local checkout is not re-observed after acceptance, so `ready_to_apply` reflects the accept-time observation rather than live checkout state.
A rejection, resumed work, or a changed PR head therefore withdraws readiness instead of leaving a stale ready badge.

Reject requires non-empty `feedback`, records `completion_rejected`, and moves the task back to `working`.
The server best-effort delivers `[perch] Completion rejected: <feedback>` to a live worker session.
The rejection and feedback remain durable even if immediate delivery fails, so Mate can recover or steer the worker later.

Only the local server token may call this endpoint.
A worker hook token cannot accept its own work, and a paired device token receives `403` rather than silently acting as Mate.
Mate should re-read the task after any `409` response.

## Structured no-mistakes decisions

`POST /tasks/:id/decision` is narrower than ordinary worker steering.
It answers the latest structured no-mistakes gate that the worker previously persisted with a `needs_decision` event.

```json
{
  "action": "fix",
  "findingIds": ["r1"],
  "instructions": "Keep the existing public API shape."
}
```

`action` is `approve`, `fix`, or `skip`.
`findingIds` and `instructions` are used only with `fix`.
The server translates the decision into the no-mistakes response command and queue-gates delivery to the worker.
Worker hook credentials are not accepted because a worker cannot answer its own review gate.

## Steering, recovery, and teardown

`GET /sessions` returns the live fleet view, including the worker session ID needed by the input endpoint and provider statuses such as running, waiting, or needing approval.

### `POST /sessions/:sessionId/input`

Mate sends a concise follow-up with:

```json
{ "text": "Please add the missing end-to-end assertion.\n" }
```

The server either submits the text or queues it behind a provider interaction that must be resolved first.
For Claude, a successful HTTP response means Perch accepted the text into this durable delivery path; provider acceptance is confirmed separately by the receipt rules above.
Accepted follow-up input starts a new turn and can return a rejected or parked task to `working` only through the normal activity path.

### `POST /tasks/:id/recover`

Recovery accepts an optional stable key:

```json
{ "idempotencyKey": "recover-task-123-after-server-restart" }
```

The server resumes the exact verified provider conversation in a new runtime generation while preserving the task, event log, worktree, branch, and worker identity.
Recovery changes runtime state, not task meaning.
A `409` means recovery is already running or is unavailable for the current durable runtime.

### `POST /tasks/:id/teardown`

The normal body is `{}`.
`{ "force": true }` is reserved for an explicit discard decision.

Teardown stops the worker, releases its worktree, and records task closure only after the landed gate proves that work is safe to release.
Dirty or unlanded work and live holders cause refusal rather than silent data loss.
The verified pre-launch dispatch failures defined above may pass normal teardown because they prove that no worker resources exist.
Before using commit reachability as landing proof, the gate refreshes only the default remote-tracking branch and never moves a local branch.
If that fetch is unavailable, the gate falls back to the last-known remote-tracking ref.

## State and event rules to preserve

- Task state describes the meaning of the work; runtime state describes the replaceable provider process.
- Provider turn completion is evidence, not task completion.
- Each turn needs a new worker outcome after that turn's sequence baseline.
- Worker `done` is a completion claim, not trusted completion.
- Only Mate's server-token decision can create trusted `done` state.
- Rejection is the only valid path from `completion_requested` back to `working`.
- Event history is append-only, so decisions and recovery never rewrite the evidence that produced them.
- Workers report sparsely: one `working` event at the start, then only real state changes and one accurate outcome before ending each turn.
