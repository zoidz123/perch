# Worker task API and turn lifecycle

Perch separates provider turns, worker-reported task outcomes, and verified task completion.
A Claude or Codex turn ending is runtime evidence only.
A worker must report an outcome for the turn, and a worker's `done` report becomes a completion request that Mate must verify before the task enters `done`.

This guide documents the HTTP surface used to dispatch and supervise workers, the event endpoint workers call, and the hooks that enforce the per-turn reporting contract.
It does not catalog unrelated device, configuration, or usage routes.

## Actors and credentials

The local server normally listens at `http://127.0.0.1:8787`.
Workers receive these values in their process environment (the PTY for Claude, the app-server daemon for Codex):

| Variable | Purpose |
| --- | --- |
| `PERCH_SESSION_ID` | Identifies the Perch-owned provider session. |
| `PERCH_HOOK_URL` | Points to the server's `POST /hooks` endpoint. |
| `PERCH_HOOK_TOKEN` | Authenticates only that session's hook and worker requests. |

Native Codex children can inherit the root daemon's hook credential, so that credential alone does not mechanically prove root-thread authority.
The standard worker brief therefore tells native children to report only through their native parent result path and never call Perch task outcome hooks.
This is defense in depth, not the task-completion security boundary: Mate verification remains authoritative.

Fresh managed Codex threads receive `perch.report_task_event` as a root-thread dynamic tool.
The owning app-server adapter binds that call to the root session and relays it through the authenticated event endpoint; child-thread tool requests are denied.
Direct hook-token task reports remain accepted only for Claude workers and proven legacy Codex runtimes whose native children were disabled.

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
| Session headers `x-perch-session` and `x-perch-token` | Provider hooks, Claude workers, and proven legacy Codex workers | `POST /hooks` and the compatible worker form of `POST /tasks/:id/events` |
| Owned Codex root-thread identity | Fresh managed Codex worker root | The `perch.report_task_event` dynamic tool, which the app-server adapter relays to `POST /tasks/:id/events` |
| `Authorization: Bearer <server-token>` | Mate and local CLI tools | Authenticated task and session routes |
| Paired device bearer token | iPhone | Most authenticated read and control routes, but not completion verification |

For `POST /tasks/:id/events`, the session in `x-perch-session` must be the session currently linked to that task.
Hook-token events are persisted with `source: "worker"`.
Ordinary bearer-authenticated events are persisted with `source: "system"` and do not satisfy the worker's per-turn outcome requirement.
The internal Codex root-tool relay also presents the server bearer, but its separately verified root session makes the event `source: "worker"`.

## Endpoint map

| Method and path | Caller | Purpose |
| --- | --- | --- |
| `POST /tasks` | Mate | Create a task and, with `dispatch: true`, acquire a worktree, start a worker, and link the runtime. |
| `GET /tasks` | Mate, CLI, phone | List durable task projections. |
| `GET /tasks/:id` | Mate, CLI, phone | Read one task and its immutable ordered event log. |
| `POST /tasks/:id/events` | Worker or owned Codex root-tool relay | Report lifecycle progress. New ship tasks cannot attach a PR through this route. |
| `POST /tasks/:id/reports` | Worker or owned Codex root-tool relay | Durably submit the complete worker report and evidence to the mate mailbox. |
| `POST /tasks/:id/autoreview` | Managed ship root worker | Freeze the target, run focused tests and the bundled helper, and persist a durable receipt. |
| `POST /tasks/:id/delivery/pr` | Managed ship root worker | Revalidate a clean receipt and create/link the one server-owned PR. |
| `GET /mate/mailbox`, `POST /mate/mailbox/read`, `GET /mate/mailbox/message/:id`, `POST /mate/mailbox/ack`, `GET /mate/mailbox/wait` | Mate (hook credential); list and read also accept bearer auth | The mate's durable worker-to-mate mailbox: list, claim, read full content, acknowledge, bounded wait. |
| `POST /hooks` | Installed provider hook | Report provider lifecycle signals such as turn start and turn completion. |
| `POST /tasks/:id/completion` | Mate with the server token | Accept or reject the latest worker completion request. |
| `POST /tasks/:id/decision` | Mate or phone | Answer a retained structured legacy gate during the migration window. |
| `GET /sessions` | Mate, CLI, phone | Read live fleet and provider-session status. |
| `POST /sessions/:sessionId/input` | Mate, CLI, phone | Send or queue follow-up text to the worker session. |
| `POST /sessions/:sessionId/submit` | Boss phone or terminal client | Submit boss text, with durable turn-boundary serialization when the target is the mate. |
| `POST /tasks/:id/recover` | Mate, CLI, phone | Recover managed provider work in a new runtime generation. |
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

`kind` is `ship`, `scout`, or `operate`.
New creation rejects the optional legacy `mode` field with a compatibility error rather than remapping it.
Optional `agent`, `model`, and `effort` values override dispatch defaults for this task only.
Reusing an `idempotencyKey` returns the original durable dispatch instead of launching another worker.

With `dispatch: true`, the server appends the standard worker brief to `prompt`.
That brief contains typed worker operations, worktree and branch rules, and the task-kind definition of done.

If dispatch fails before launch, Perch preserves the failed operation and failed task event before deciding whether to close the task automatically.
Auto-close requires the latest durable dispatch payload to show that launch never started and requires the task to have no session, runtime, worktree linkage, or task-owned lease.
Perch releases a pre-launch lease before evaluating that predicate.
Failures that launched or still own worker resources remain `failed` and visible.
At startup, Perch applies the same predicate once to repair matching historical failed rows; the append-only `closed` event makes the repair idempotent.

### `GET /tasks` and `GET /tasks/:id`

`GET /tasks` returns `{ "tasks": [...] }` for non-closed tasks and omits their stored prompts.
CLI history consumers may explicitly request `GET /tasks?includeClosed=1` to receive the full ledger with prompts intact.
Historic task records may still decode an optional `planId`, but no current endpoint creates or queries that linkage.

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
`working`, `reviewing`, `needs_you`, `blocked`, `awaiting_verification`, `ready_to_merge`, `ready_to_apply`, `verified_done`, `failed`, or `closed`.
It is derived from the durable lifecycle, PR, verification, and review facts, never persisted as task state, and clients render the primary task status from it instead of inferring readiness from PR checks or mergeability.
A `landed` task presents as `closed`, so merged work leaves the active task list immediately instead of wearing a badge until teardown closes the record.
A working `ship` task presents as `reviewing` only while its latest durable AutoReview attempt is running.
`scout` and `operate` present `verified_done` only after report evidence is accepted.

Mate uses this detail endpoint before acting on a wake notification.
The event `seq` is the stable identifier used for completion decisions and turn-boundary evidence.

## Worker event endpoint

### `POST /tasks/:id/events`

A Claude worker reports an outcome with `perch task event`; compatible legacy Codex workers may use their retained hook path.

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
Fresh managed Codex workers call `perch.report_task_event` with the same request body fields and must require `success: true` from the tool result.

| Worker wire verb | Durable event | Resulting task state | Meaning |
| --- | --- | --- | --- |
| `working` | `working` | `working` | The worker started or resumed meaningful work. |
| `pr_linked` | `pr_linked` | unchanged | Legacy remote records only: the server validates and records a recovered historical PR identity. New ship tasks are rejected and must use server delivery. |
| `needs_decision` | `needs_decision` | `needs_you` | Work is parked on a human or Mate decision. |
| `blocked` | `blocked` | `blocked` | Work is parked on an external dependency. |
| `done` | `completion_requested` | `completion_requested` | The worker claims the definition of done is met and asks Mate to verify it. |
| `failed` | `failed` | `failed` | The worker cannot complete the task. |
| `note` | `note` | unchanged | Supplemental durable evidence that is not the turn's outcome. |

The `done` name is retained as the worker wire verb for compatibility.
It never directly creates trusted `done` state.

For a new `ship` task, run focused tests and `perch.autoreview_run` or `perch autoreview run` for the intended final tree.
Verify findings against source, fix accepted actionable findings, then rerun focused tests and review with the prior attempt's supersession identity.
Only after a clean receipt may the root worker call `perch.delivery_create_pr` or `perch delivery create-pr`.
The server recomputes base, HEAD, tree, diff, and clean-worktree identity immediately before delivery.
Any source change after review mechanically makes the receipt stale.
Direct `pr_linked`, worker-authored `git push`, and worker-authored `gh pr create` cannot satisfy new ship delivery or completion.
`scout` and `operate` must not invoke AutoReview or code delivery.

## Worker reports and the mate mailbox

Worker-authored boss-relevant events and full worker reports fan in to the mate through one durable SQLite mailbox instead of injected chat text.
A worker message never becomes a user message in the mate's boss-facing conversation.

### `POST /tasks/:id/reports`

The lossless deliverable channel.
A worker submits a concise routing `summary`, the complete worker-authored `report`, and optional structured `evidence`, plus a required sender-provided `idempotencyKey` (the `perch report send` CLI and the `perch.send_report` Codex root tool default it to a content hash).

```sh
perch report send --task <task-id> \
  --summary "one-paragraph routing summary" \
  --report-file ./report.md --evidence-file ./evidence.json
```

Fresh managed Codex workers call the `perch.send_report` root-thread dynamic tool instead; the app-server adapter relays it with the verified root session exactly like `perch.report_task_event`, so native children gain no reporting authority from inherited environment credentials.
The endpoint accepts only worker identities (the task session's hook credential, or the Codex root-tool relay); plain bearer and device tokens are rejected.
The same `root_thread_required` gate as the events route applies.

Perch stores the report byte-for-byte in an immutable, trigger-protected `worker_reports` row (id, provenance, size, sha256, accepted timestamp) and commits, in the same SQLite transaction, a pointer task event (kind `note`, `data.reason: "worker_report"`, carrying the summary and stable report id - never the body) and a pending mate mailbox delivery.
Tool success therefore means the full report is durable with a standing delivery obligation - not that the mate processed it.

Explicit bounds, enforced with `413` and never silent truncation: summary 4 KiB, report 256 KiB, evidence JSON 256 KiB.
Larger artifacts belong in committed files referenced from the report by path or content hash.
Replaying the same `(task, sender session, idempotencyKey)` with identical content returns the original report with `duplicate: true`; the same key with different content is `409`.

### Mailbox semantics

Each mailbox delivery references its immutable source (the task event, plus the worker report when one exists) and moves `pending -> claimed -> acknowledged`.
The order key is the global task-event id: FIFO within each task conversation and a deterministic commit order across tasks.
An expired claim (10 minutes) returns to pending automatically; claiming re-mints the opaque claim token, so stale tokens can never acknowledge.
Acknowledgment requires the live mate generation's own hook credential, the exact claim token, an unexpired lease, and an idempotency key: replaying the committed key returns the original receipt, a different key after acknowledgment is refused, and a stale mate generation cannot acknowledge at all.
Unacknowledged messages survive server, daemon, provider-turn, and mate-generation restarts.
Acknowledgment records mailbox processing only; trusted task completion still requires `POST /tasks/:id/completion` with the server token.

Mailbox tools for the mate (`perch mailbox read | message <id> | ack <id> --token <t> | wait [--timeout <s>]`):

- `read` (read_messages) claims the oldest unacknowledged messages and returns stable pointers plus safe routing metadata and a bounded summary - never the report body.
- `message` (read_message) returns the original full report, evidence, and event content.
- `ack` (ack_message) records the semantic acknowledgment after the mate actually processed the message.
- `wait` (wait_for_messages) is a bounded wait capped at 30 seconds over the same durable mailbox: it returns immediately when messages are pending and empty on timeout. It is a latency optimization, never the correctness layer, and a lost wait or wake loses no message.

### Attention and presentation

A wake is disposable attention transport only.
When a mailbox delivery commits, the server nudges an idle mate with a single content-free `[perch mailbox] N unread ...` control line; a mate that is mid-turn is never interrupted or steered, and the nudge repeats at the next idle transition only when newer messages arrived.
The boss-facing timeline renders only the mate's synthesis: mailbox control prompts are filtered from the timeline projection and the live stream, and raw worker reports never enter any timeline.
Provider-native transcripts (attach views) still contain the mate's mailbox tool calls and the nudge line; privacy from native transcripts is out of scope.

System-sourced notifications (`checks_green`, `merge_ready`, `merged`, `stalled`, `runtime_interrupted`) remain on the legacy injected wake-line path.
That legacy path, and the worker `curl` event verbs, are the explicit compatibility boundary: they remain until the mailbox subsumes system notifications, while the new report path is CLI/tool-only from day one.

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

Every new `ship` completion request is bound to the server-created PR and the exact base, HEAD, tree, diff, and focused-test evidence recorded by its clean receipt.
Every new `scout` or `operate` completion request is bound to an accepted report deliverable.
The derived `ready_to_merge` presentation holds only while the mate's acceptance of the latest completion request still matches the current PR head and GitHub currently reports an open, non-draft PR with `MERGEABLE` mergeability, `CLEAN` merge state, no blocking review decision, and either passing checks or an explicit empty check rollup.
An absent check rollup or unavailable PR observation is unknown, clears any previously derived readiness, and never counts as a zero-check repository.
`ready_to_apply` requires the acceptance to have recorded the same checkout HEAD commit the completion request pinned; if either revision cannot be read or they differ, readiness stays absent.
The local checkout is not re-observed after acceptance, so `ready_to_apply` reflects the accept-time observation rather than live checkout state.
A rejection, resumed work, or a changed PR head therefore withdraws readiness instead of leaving a stale ready badge.

Reject requires non-empty `feedback`, records `completion_rejected`, and moves the task back to `working`.
The server best-effort delivers `[perch] Completion rejected: <feedback>` to a live worker session.
The rejection and feedback remain durable even if immediate delivery fails, so Mate can recover or steer the worker later.

Only the local server token may call this endpoint.
A worker hook token cannot accept its own work, and a paired device token receives `403` rather than silently acting as Mate.
Mate should re-read the task after any `409` response.

## Structured legacy decisions

`POST /tasks/:id/decision` is narrower than ordinary worker steering.
It answers the latest structured gate that a persisted legacy task previously recorded with a `needs_decision` event.

```json
{
  "action": "fix",
  "findingIds": ["r1"],
  "instructions": "Keep the existing public API shape."
}
```

`action` is `approve`, `fix`, or `skip`.
`findingIds` and `instructions` are used only with `fix`.
No new task dispatch initializes this retained runtime or depends on this endpoint.
Worker hook credentials are not accepted because a worker cannot answer its own review gate.

## Steering, recovery, and teardown

`GET /sessions` returns the live fleet view, including the worker session ID needed by the input endpoint and provider statuses such as running, waiting, or needing approval.
Each session's optional `queuedCount` reports how many accepted inputs are still held server-side.

### `POST /sessions/:sessionId/input`

Mate sends a concise follow-up with:

```json
{ "text": "Please add the missing end-to-end assertion.\n" }
```

The server either submits the text or queues it behind a provider interaction that must be resolved first.
For Claude, a successful HTTP response means Perch accepted the text into this durable delivery path; provider acceptance is confirmed separately by the receipt rules above.
Accepted follow-up input starts a new turn and can return a rejected or parked task to `working` only through the normal activity path.

When this endpoint or `POST /sessions/:sessionId/submit` targets the live mate, boss input is serialized at turn boundaries.
Input sent while the mate is idle is submitted immediately.
Input sent while a mate turn is active is stored durably, returns `"queued": true`, and releases one message after each completed turn in FIFO order.
This behavior is provider-neutral and applies to both Claude PTY mates and Codex app-server mates.
Worker-session steering remains immediate and can still interrupt a worker turn.

An intentional boss override can bypass the mate turn-boundary queue with:

```json
{ "text": "Stop and address this now.\n", "interrupt": true }
```

The interrupt flag restores immediate mid-turn submission.
It does not bypass an open provider permission or question gate because typing into that focused widget would be unsafe.

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
For a linked PR, reachability from its own remote feature branch is not landing proof: normal teardown requires either an authoritative merged-PR observation or exact `HEAD` ancestry in the default branch.
Non-PR and local work may still use reachability from another remote ref as external preservation proof.
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
