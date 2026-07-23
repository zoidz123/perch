# Durable Mate inbox acknowledgments

## Decision

Add a server-owned, durable Mate inbox that is separate from `notification_outbox`.
Every boss-relevant worker task event will create one immutable inbox item for the logical Mate owner in the same SQLite transaction as the task event.
The item is explicitly unassigned when no Mate generation exists, otherwise it is assigned to the current registered generation.
It remains until that generation, or a generation that OwnerManager has explicitly recovered or adopted it into, claims and acknowledges it.
Provider wakeups, WebSocket updates, APNs, and desktop cards are attention signals only.
They do not make an inbox item processed.

Do not use a provider's normal user-input path as the default wake mechanism.
Codex `turn/start` and `turn/steer` create visible user messages, and the current Claude path types text into the interactive composer.
Neither is a verified silent, durable processing-receipt API.
Until a provider proves a non-user-message inbox signal with an item-specific receipt, the safe fallback is the persistent Perch inbox plus WebSocket and APNs attention, with no literal wake text injected into a human composer.

## Problem statement

Worker outcomes are already recorded as durable task events.
The same SQLite transaction currently creates per-event `notification_outbox` rows for the `mate` and, when appropriate, `push` channels.
`OutboxWorker` atomically leases an intent, retries it with backoff, and sets its state to `delivered` after the delivery callback returns successfully.
The server wires the `mate` callback to `deliverMateWake`, which picks a live Mate and calls `FleetMonitor.queueOrSubmit` with a rendered one-line wake.

That is a durable intent to submit a wake, not a durable record that a Mate processed the worker event.
The current `delivered` state means that Perch handed the wake to, or successfully queued it at, the selected Mate provider boundary.
It does not mean the Mate saw it, understood it, acted on it, presented it to the boss, or received a boss decision.
Codex queued input is process-memory state after the outbox row is delivered, so a restart can lose it.
Claude has prompt-delivery tracking for some inputs, but no durable Mate processing receipt.
Both existing wake paths can create provider user input, pollute the transcript, and race with a human composing text.

## Current guarantees and non-guarantees

| Area | Guaranteed today | Not guaranteed today |
| --- | --- | --- |
| Worker facts | `task_events` is durable and ordered per task. | A fact has reached, or been processed by, the Mate. |
| Delivery intent | A boss-relevant event atomically gets a `mate` outbox intent, plus its applicable `push` intent. | The intent identifies a durable recipient owner generation or has a processing receipt. |
| Retry | `notification_outbox` claims atomically, retries leased or failed submissions, and keeps per-task channel order while work is live. | A successful provider submission is processed exactly once by a Mate. |
| Crash recovery | Expired outbox leases can be reclaimed after a server restart. | Provider-held or in-memory Codex gated input survives after the outbox marks it delivered. |
| Burst safety | The current three-concurrent-Claude-worker regression creates all three launches and preserves all three provider-session bindings. | Five simultaneous boss events create five durable Mate processing obligations. |
| Presentation | Task events, task decision cards, fleet snapshots, and push routes have durable or live surfaces. | A persistent cross-task Mate inbox, unread count, or a clear pending versus processed status. |

## Target invariant

For every boss-relevant worker task event committed after this feature is enabled, exactly one durable inbox item exists for the logical Mate owner.
The item has either an explicit unassigned state with no recipient generation or an assignment to a real generation registered by OwnerManager.
That item remains present and actionable until a generation authorized by OwnerManager claims it and commits an idempotent processing acknowledgment.
No concurrent burst, server restart, provider restart, duplicate provider submission, duplicate Mate request, or Mate recovery may delete or silently mark the item processed.

The invariant is about durable work, not immediate agent attention.
When no safe provider wake capability exists, an item may remain pending while Perch raises durable desktop and iOS attention.
The system must surface that condition honestly instead of pretending the Mate received a silent wake.

## State machines and ownership

Keep delivery and processing as two independent state machines.
An outbox row is a delivery attempt for an inbox item.
An inbox item is the processing obligation.

### Notification delivery state

`notification_outbox` keeps its existing states: `pending`, `claimed`, `delivered`, and `failed`.

| Transition | Writer | Preconditions and meaning |
| --- | --- | --- |
| `pending` | Task event transaction | Creates an outbox intent whose payload references the new inbox item id and target generation. |
| `claimed` | `OutboxWorker` through the existing claim-token compare-and-swap | A worker has an expiring lease to submit one attention signal. |
| `delivered` | `OutboxWorker` after the notifier returns an item-specific provider acceptance receipt | The selected provider accepted or durably queued the attention signal for this inbox item. It never means Mate processing, boss visibility, or human observation. |
| `pending` with a later `available_at` | `OutboxWorker` retry path | A transient notifier failure released the claim and scheduled retry. |
| `failed` | `OutboxWorker` after the retry budget | The attention signal needs operator attention. The inbox item remains pending and is never failed or removed because this row failed. |

The UI must call this state `wake submitted`, `wake retrying`, or `wake failed`.
It must not label it `delivered` without the qualifying provider wording.

### Mate inbox processing state

`mate_inbox_items.state` will be `unassigned`, `pending`, `claimed`, `processing`, `processed`, or `reassignment_required`.
`processing` is optional in the first implementation if a claim lease is sufficient, but the storage shape reserves it so a Mate can explicitly start long work without extending an opaque claim forever.

| Transition | Writer | Preconditions and meaning |
| --- | --- | --- |
| `unassigned` | Task-event transaction | The logical Mate owner exists, but OwnerManager has no registered runtime generation. The item is durable and visible but cannot be claimed or receive provider-specific attention. |
| `pending` | Task-event transaction, lease expiry, or recovered assignment | The item is durable and awaiting the authorized Mate generation. |
| `claimed` | Mate inbox claim endpoint | Owner id, generation, runtime identity, and compare-and-swap all match. The endpoint returns an opaque lease token. |
| `processing` | Mate inbox start endpoint | The same unexpired lease token states that the Mate has begun triage. |
| `processed` | Mate inbox acknowledgment endpoint | The same current generation and lease token commit an idempotency key, processing summary, and acknowledgment timestamp in one transaction. |
| `pending` | Lease reaper | A claim or processing lease expired without acknowledgment. The item is eligible for the same generation to reclaim. |
| `reassignment_required` | Owner lifecycle transaction | The original generation ended without a verified recovery successor. The item is retained, visibly unacknowledged, and cannot be silently acknowledged by a fresh Mate. |

There is no terminal processing failure that deletes an unacknowledged boss-relevant item.
Provider terminal failure is an outbox fact only.
An operator may explicitly resolve an irrecoverable inbox item with a durable `failed` receipt in a later product decision, but that action must be privileged, visible to the boss, and never be the automatic retry-budget outcome.

## SQLite design and transaction boundaries

Add a dedicated inbox instead of extending `notification_outbox` into a second lifecycle.
The outbox has one short-lived delivery purpose, a fixed channel uniqueness rule, and 24-hour-style settled-row pruning.
The inbox needs owner-generation authorization, processing leases, independent retention, and a durable acknowledgment journal.

### `mate_inbox_items`

Create one row per `(task_event_id, owner_id)`.

| Column | Purpose |
| --- | --- |
| `id TEXT PRIMARY KEY` | Stable UUID used by API, WebSocket, UI, and notifier payloads. |
| `task_event_id INTEGER NOT NULL REFERENCES task_events(id) ON DELETE RESTRICT` | Canonical immutable source fact. |
| `owner_id TEXT NOT NULL REFERENCES durable_owners(id) ON DELETE RESTRICT` | Initially the existing logical Mate owner id. |
| `recipient_generation INTEGER` | Current real OwnerManager generation, or `NULL` only while `state = 'unassigned'`. Never fabricate a generation to populate this field. |
| `assignment_epoch INTEGER NOT NULL` | Starts at `0` for an unassigned item or `1` for an initially assigned item and increments on every atomic assignment, recovery reassignment, or audited adoption. |
| `global_order INTEGER NOT NULL` | The immutable `task_events.id` value, used for total cross-task FIFO ordering. |
| `task_id TEXT NOT NULL`, `task_seq INTEGER NOT NULL` | Indexed copies for task filtering and per-task display order. |
| `kind TEXT NOT NULL`, `payload_version INTEGER NOT NULL`, `payload_json TEXT NOT NULL` | Versioned, rendered-independent event snapshot. Payload contains no provider-specific wake text. |
| `state TEXT NOT NULL` | `unassigned`, `pending`, `claimed`, `processing`, `processed`, or `reassignment_required`, with a check constraint that only `unassigned` may have a null recipient generation. |
| `claim_token TEXT`, `claimed_at TEXT`, `claim_expires_at TEXT` | Opaque lease state, copied from the established executor-claim pattern. |
| `attempts INTEGER NOT NULL`, `last_error TEXT` | Claim and processing attempt observability, not a reason to drop the item. |
| `processed_at TEXT`, `processed_by_generation INTEGER`, `processing_summary TEXT` | Durable processing receipt. |
| `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`, `retained_until TEXT` | Audit, retention, and pruning boundaries. |

Use `UNIQUE(task_event_id, owner_id)` for duplicate-safe creation independent of assignment.
Use an index on `(owner_id, recipient_generation, state, global_order)` for claims and presentation.
Use an index on `(state, claim_expires_at)` for lease recovery.
Store the source event's primary key, task id, task sequence, and event kind in the payload so presentation can survive normal task projection changes without duplicating the entire task record.

### `mate_inbox_receipts`

Add an append-only receipt table rather than overwriting the only evidence of a claim, recovery, or acknowledgment.
Each row has `id`, `inbox_item_id`, `receipt_kind`, `actor_owner_id`, `actor_generation`, `idempotency_key`, `payload_json`, and `created_at`.
Use `UNIQUE(inbox_item_id, idempotency_key)`.
Receipt kinds are `created`, `assigned`, `claimed`, `processing_started`, `lease_expired`, `acknowledged`, `reassigned`, and `provider_attention_failed`.
The item row is the fast projection, and the receipt table is the audit trail.

### Reuse of `notification_outbox`

Treat each linked `notification_outbox` row as one immutable provider-attention attempt for one inbox assignment epoch.
Add nullable `inbox_item_id` and `assignment_epoch` columns, and change linked intent payloads to `{ version, inboxItemId, ownerId, recipientGeneration, assignmentEpoch, notificationKind }`.
Preserve legacy rows during migration, replace the table-level `(task_event_id, channel)` constraint with a partial unique index on `(task_event_id, channel)` for legacy and push rows that have no inbox item, and add a partial unique index on `(inbox_item_id, assignment_epoch, channel)` for linked Mate attempts.
The attempt identity, inbox item, assignment epoch, generation, and channel are immutable after insertion, while the existing delivery state and lease columns advance normally.
Initial assignment and every recovery reassignment or audited adoption insert a new Mate attempt for the new epoch.
Never reset, retarget, or overwrite an earlier attempt to trigger another wake.
Use the existing claim token, claim expiry, attempts, backoff, and delivery timestamp instead of duplicating provider-delivery records in the inbox.

### Atomic writes

For a boss-relevant event, use one SQLite immediate transaction to:

1. Append the immutable `task_events` row and its current task projection update.
2. Insert the `mate_inbox_items` row with source-derived ordering fields and either `pending` plus the current registered generation or `unassigned` plus a null generation.
3. Insert its `created` receipt.
4. If the item was assigned, insert its epoch-specific `notification_outbox` `mate` intent.
5. Insert the existing eligible `push` intent.

If the transaction fails, none of the event, inbox item, or delivery intent becomes visible.
If it commits, all durable work exists before listeners, WebSocket snapshots, or provider calls run.

Claim, lease renewal, transition to `processing`, and acknowledgment each use a token-guarded compare-and-swap in their own immediate transaction.
The acknowledgment transaction updates the item projection and inserts the unique `acknowledged` receipt together.
A repeated request with the same idempotency key returns the committed receipt.

### Ordering and recovery assignment

The server assigns `global_order = task_events.id` and claims the smallest unprocessed item first for a recipient generation.
This gives a deterministic total order across multiple tasks while preserving each task's `task_seq` order.
Attention priority may affect APNs and card styling, but it must not silently reorder the Mate claim queue in the first release.

At Mate launch, the OwnerManager transaction that creates the runtime generation must also assign every `unassigned` item to that real generation, increment its assignment epoch, change it to `pending`, insert an `assigned` receipt, and insert the epoch-specific Mate attention attempt.
The assignment commits as one unit with generation creation, and no placeholder generation is created when Mate is absent.

When OwnerManager verifies provider identity during recovery, its generation handoff transaction must atomically create the successor runtime and move each unprocessed item from the recovering generation to the successor generation.
Each move clears any old lease, increments the assignment epoch, inserts a new epoch-specific Mate attention attempt, and leaves every earlier attempt unchanged.
Each move inserts a `reassigned` receipt that names both generations.
An intentional fresh Mate that is not a verified recovery leaves older items in `reassignment_required` until an explicit server-owned adoption action records why the new generation may take them.
This prevents a stale or unrelated Mate from acknowledging another generation's work.

## End-to-end flows

### Idle Mate

1. A worker records a boss-relevant event.
2. The commit creates the task event, inbox item, Mate attention intent, and any push intent together.
3. The inbox item appears as `pending` on desktop and iOS immediately from the server snapshot.
4. A capability-enabled notifier may submit an item-specific provider attention signal and mark only the outbox row `delivered`.
5. The Mate claims the oldest pending item through the generation-bound API, processes it, and acknowledges it.
6. The item becomes `processed`, while any underlying boss decision remains open until the separate decision workflow resolves it.

### Busy or gated Mate

The item is still created and visible immediately.
No code writes wake text into a focused permission dialog or a human composer.
If a verified silent notifier can safely queue an item-specific signal, it may submit it while the Mate is busy.
Otherwise the item stays pending, the inbox count remains visible, and APNs uses the normal attention policy.
Processing begins only after the Mate claims it.

### Five simultaneous worker events

Five concurrent task-event commits create five different source event ids and five inbox item ids.
Each transaction has its own outbox and push intents.
The inbox claim query orders the five items by `global_order`, so one Mate processes a stable sequence across their tasks.
Duplicate callbacks or outbox retries can create duplicate attention signals, but the unique inbox key and acknowledgment idempotency key prevent duplicate processing receipts.

### Server crash boundaries

| Crash point | Durable result after restart |
| --- | --- |
| Before the creation transaction commits | No event, inbox item, or intent exists. The worker must retry its task event normally. |
| After creation commits, before an outbox claim | The pending inbox and outbox rows are drained after restart. |
| After outbox claim, before provider submission | The claim lease expires and the outbox retries. The inbox remains pending. |
| After provider acceptance, before outbox `delivered` commit | The outbox retries with the same stable notifier idempotency key when the provider supports one. Duplicate attention is allowed and does not duplicate inbox processing. |
| After outbox `delivered`, before Mate claim | The inbox remains pending and appears after restart. |
| After Mate claim, before processing acknowledgment | The processing lease expires and the item returns to pending for the authorized generation. |
| After acknowledgment commit, before the HTTP response | A retry with the same acknowledgment key returns success and leaves one processed receipt. |

### Provider rejection and terminal attention failure

The notifier records the rejection in `notification_outbox.last_error`, retries with the existing policy, and eventually marks only that attention intent `failed`.
The inbox item remains pending.
Desktop and iOS show a clear `wake failed, inbox retained` state and continue normal APNs or connected-client attention without exposing provider error text in a push payload.

### Mate restart and recovery

If the current generation is recoverable, OwnerManager verifies the provider identity before recovery.
The server atomically reassigns unprocessed items to the verified successor generation, increments each assignment epoch, and inserts a fresh attention attempt for that epoch.
Earlier attention-attempt rows remain immutable delivery history.
The recovered Mate resumes by claiming the oldest unacknowledged item.
An expired claim from the old runtime cannot acknowledge because its token and generation no longer match.

### Duplicate provider submission and duplicate Mate request

Provider submission is at-least-once.
Every provider request carries the stable inbox item id and a notifier idempotency key when the provider supports one.
The Mate API does not infer processing from a provider submission.
Repeated claims return no second active lease.
Repeated acknowledgments with the same idempotency key return the original durable receipt.
Different acknowledgment keys after processing receive a conflict containing the existing receipt.

### Separate user-facing boundaries

| Boundary | Meaning |
| --- | --- |
| Backend receipt | SQLite committed the task event and inbox item. |
| Provider submission | A provider accepted an optional attention signal. |
| Mate processing | The authorized Mate generation claimed and acknowledged the inbox item. |
| Boss decision | The boss used a dedicated approval or no-mistakes decision action, which writes its own durable task event. |
| Push delivery | APNs accepted a notification request or Perch updated a live client. |
| Human observation | A person opened or read a card. This is not inferred in the first release. |

## Provider integration strategy

Introduce a `MateAttentionNotifier` capability interface whose result is explicitly one of `submitted`, `unsupported`, `retryable_failure`, or `terminal_failure`.
It receives only the inbox reference and a short, non-sensitive summary.
It never gets permission to acknowledge or process an item.

### Codex

The owned Codex app-server adapter has acknowledged `turn/start` and `turn/steer` submission with a stable `clientUserMessageId` and history reconciliation.
Those APIs still create visible user-message content in the thread.
They are not a verified silent inbox-notification or processing-receipt API.
Do not use them for default worker-to-Mate wakeups.

Keep a Codex notifier disabled until a live, version-pinned protocol probe proves all of the following:

- The notification does not create or alter a user-message transcript item.
- The provider returns an item-specific, durable acceptance receipt.
- The receipt can be reconciled after a daemon or server restart.
- A busy turn and a human-attached TUI cannot have their input or approval focus changed.

### Claude

The current Claude follow-up path submits to the interactive session through the normal adapter or PTY input and then shows a user message in the FleetMonitor timeline.
Queue gating protects an open permission prompt, but it is not a silent inbox channel and its queue is not the Mate processing receipt.
Do not type a literal wake into the Claude composer by default.

Only enable a Claude notifier after the provider offers and Perch verifies a session-scoped notification API that does not type, submit, or persist a user prompt and that returns an item-specific receipt.

### Safe fallback

When the provider capability is unsupported, `notification_outbox` records the unsupported attention attempt truthfully and the inbox remains pending.
`OutboxWorker` maps `unsupported` directly to terminal `failed` without retry and stores a structured `unsupported_provider_capability` reason in the attempt error payload.
It also appends a `provider_attention_failed` receipt with that reason.
Perch surfaces `Manual attention required` through desktop and iOS persistent inbox cards, unread counts, connected-client updates, and APNs attention without retrying the unsupported provider path.
The Mate's durable operating instructions and recovery path must poll the inbox API before declaring itself idle and after reconnecting.
This is a latency fallback, not a false claim of automatic provider wakeup.

The legacy visible-composer wake may remain behind an explicit, temporary compatibility switch during rollout.
It must be labeled transcript-visible, disabled by default, never used while a human editor is active, and removed after the safe notifier or inbox-first operating model is proven.

## Mate consumption and acknowledgment protocol

Expose generation-bound internal endpoints and matching relay RPC methods.
The REST and relay handlers must share one service implementation and one authorization check.

| Contract | Request | Result |
| --- | --- | --- |
| List | `GET /mate/inbox?limit=&after=` | Ordered inbox projection and unread counts. Listing never claims or acknowledges. |
| Claim | `POST /mate/inbox/claim` with `ownerId`, `generation`, and `limit` | Atomically leases the oldest pending item or returns empty. Includes opaque `claimToken` and expiry. |
| Start | `POST /mate/inbox/:id/processing` with `claimToken` | Marks a current lease as processing and extends it within the configured cap. |
| Renew | `POST /mate/inbox/:id/renew` with `claimToken` | Extends a valid lease without changing its processing result. |
| Acknowledge | `POST /mate/inbox/:id/ack` with `claimToken`, `idempotencyKey`, `outcome`, and bounded summary | Commits `processed` plus the idempotent receipt. |
| Adoption | Server-owned OwnerManager operation only | Reassigns unprocessed work after verified recovery or an explicitly audited fresh-Mate adoption. |

The service authenticates the caller with the active per-session hook credential, not ordinary bearer authentication.
OwnerManager binds that credential's canonical session id to the exact live `owner:mate` runtime generation and trusted provider identity.
Launch and recovery mint a fresh credential with `HookRegistry.register`, revoke every token associated with the prior Mate session or generation, and persist only the new active binding.
A recovered Codex session id may resolve through `HookRegistry.resolveAlias` only when the alias is server-created during verified recovery, targets the canonical session bound to the current live Mate generation, and is presented with that generation's active credential.
An alias never makes a revoked pre-recovery token valid.
The handler first verifies the presented session and credential, resolves an allowed recovery alias, and then performs the owner role, live state, exact generation, canonical session, and trusted provider checks in the same transaction as the claim or acknowledgment compare-and-swap.
It rejects device bearer tokens, worker hook credentials, revoked Mate credentials, stale generations, ended sessions, unbound aliases, and a pty session that no longer matches the owner runtime.

One generation processes one claimed item at a time in the first release.
This preserves deterministic global ordering and keeps a Mate's narrative coherent.
The API may return a small read-only preview window, but it must not lease later items while an earlier item is processing.
Lease expiry is the only automatic release path.
The recovery coordinator invokes the same list and claim service after OwnerManager has completed its verified handoff.

An acknowledgment says only that the Mate processed the event.
It never represents a boss decision, a GitHub merge, an APNs receipt, or a human read receipt.

## Desktop and iOS behavior

Add a persistent `Mate inbox` surface to both products.
It is server-backed, not a reconstructed chat message list.

- Show a badge with unassigned or pending unread count, processing count, and wake-failed count.
- Sort by the server's `global_order`, preserve task title, worker name, task state, source event kind, and creation time, and deduplicate by inbox item id.
- Use clear states: `Awaiting Mate launch`, `Awaiting Mate`, `Mate processing`, `Mate processed`, `Wake retrying`, `Manual attention required`, and `Needs reassignment`.
- Send APNs for new attention-worthy inbox items using an opaque inbox item id and compact title only. The app fetches full content after authenticated launch.
- Push and WebSocket are wakeup paths, while REST and relay RPC hydrate the authoritative list. LAN and relay must render the same records, counts, and action availability.
- Preserve a processed item in history for the retention period so a boss can audit the Mate's receipt.
- Keep merge and no-mistakes approval cards durable and visible until their separate decision action and subsequent resolution occur. A Mate acknowledgment may mark the inbox item processed but must never dismiss a pending approval card.

## Migration, compatibility, observability, rollback, retention, and security

### Migration and compatibility

Ship additive SQLite migrations first.
Do not reinterpret historical `notification_outbox.delivered` rows as Mate acknowledgments.
They only prove past provider submission and may already have been pruned.

At cutover, seed inbox items for every currently unresolved boss-facing task state and mark them `migration_backfill` in the receipt payload.
Do not manufacture a processed receipt for any historical event.
For newly committed events, create the inbox row and outbox intent atomically from day one.

During the short compatibility period, dual-publish the existing wake only when the temporary transcript-visible compatibility mode is deliberately enabled.
The inbox is the source of truth in both modes.
Do not dual-acknowledge or make inbox state depend on an old queue submission.

### Observability

Expose counts and structured logs for:

- Inbox items created, pending, claimed, processing, processed, reassignment-required, and oldest pending age.
- Outbox attention attempts, retries, terminal failures, and provider capability state.
- Event-to-inbox, inbox-to-provider-submission, claim-to-acknowledgment, and recovery-handoff latency.
- Duplicate claims, duplicate acknowledgments, stale-generation rejections, and lease expirations.
- Inbox versus task-event reconciliation mismatches, which page as a data-integrity alert.

Never log full payloads, provider prompts, device tokens, or claim tokens in metrics.

### Staged rollout and rollback

1. Add schema, repositories, deterministic inbox creation, receipts, and reconciliation in shadow mode with no provider behavior change.
2. Add read-only API, desktop and iOS list surfaces, counts, relay parity, and APNs metadata while retaining the current wake path behind telemetry.
3. Add claim, renew, acknowledgment, and OwnerManager recovery handoff with direct service and restart tests.
4. Enable inbox-first processing for one internal Mate, disable default composer wakes, and compare shadow and live counts until there are no reconciliation gaps.
5. Remove the visible-composer compatibility mode after a safe provider capability is proven or the polling fallback meets the agreed latency target.

Rollback disables new notifier behavior and UI actions, but never drops the migration or deletes unacknowledged rows.
The old wake path may be re-enabled only as explicitly labeled compatibility behavior.
The server keeps writing and serving inbox records so rollback cannot create an untracked processing gap.

### Retention and pruning

Never automatically prune `pending`, `claimed`, `processing`, or `reassignment_required` items.
Retain `processed` items and receipts for 90 days after acknowledgment, then prune them in a transaction that preserves the immutable task event and a compact audit aggregate.
Retain terminal provider-attention failures for at least 90 days and until the linked inbox item is processed.
The pruning job must verify no unprocessed item references the candidate rows and emit counts to observability.

### Security

Treat inbox payloads as task-event-derived sensitive content.
Reuse state database file protections, authenticated device transport, and relay encryption.
Do not place task findings, commands, or payload bodies in APNs text.
Bind every claim and acknowledgment to the active per-session hook credential and OwnerManager's current owner, generation, canonical session, and trusted provider identity.
Rotate the credential at launch and verified recovery, revoke prior-generation tokens, reject device bearer authentication, and allow a recovery alias only when the server binds it to that exact current generation.
Use opaque random claim tokens, bounded summaries, payload-size limits, rate limits, and audit records for claim, acknowledgment, reassignment, and privileged resolution.

## Verification matrix and acceptance criteria

| Scenario | Verification | Acceptance criterion |
| --- | --- | --- |
| Creation transaction | Inject failure after each write in task event, inbox, receipt, and outbox creation. | After restart, all four records exist together or none exist. |
| Five-worker burst | Concurrently append five boss-relevant events from different tasks. | Five source events, five unique inbox ids, five outbox intents, stable global ordering, and no missing item. |
| Per-task ordering | Append multiple eligible events from one task with another task interleaved. | Each task's sequence and global event-id order are preserved by claims. |
| Duplicate inbox creation and submission | Replay inbox creation and outbox delivery for the same already-committed `task_event_id`, then replay claim and acknowledgment. | One inbox row for that source event, one attention attempt per assignment epoch and channel, and one processed receipt per acknowledgment idempotency key. A separate ledger event remains a separate inbox item. |
| Outbox crash windows | Crash before submit, after submit before `delivered`, and after `delivered` before claim. | Retry or duplicate attention is possible, but the inbox remains once and pending until acknowledgement. |
| Mate crash windows | Crash after claim, after processing start, and after acknowledgment commit before response. | Expired leases reappear, processed receipt remains idempotent, and no stale token can acknowledge. |
| Server and provider restart | Restart SQLite server, Codex daemon, and Claude process at every handoff. | Unacknowledged items resume from durable state with no in-memory queue dependency. |
| Recovery generation | Recover a Mate with verified provider identity and attempt old-generation calls afterward. | Unprocessed items move with an audit receipt; stale generation is rejected. |
| Fresh Mate | Start a non-recovery Mate while old work is unacknowledged. | Items remain visible as reassignment-required until an explicit audited adoption. |
| Provider rejection | Return retryable, terminal, and unsupported notifier results. | Retryable failures back off, terminal failures settle, unsupported settles immediately with `unsupported_provider_capability` and no retry, the inbox stays pending, and desktop, iOS, and APNs say manual attention is required. |
| Composer safety | Attach a human desktop client and exercise busy, idle, and permission-gated Mate states. | Default inbox delivery creates no provider user message and changes no composer or approval focus. |
| Codex capability probe | Run the version-pinned app-server probe for any future silent notifier. | Capability remains disabled unless it proves non-user-message, item receipt, restart reconciliation, and busy-turn safety. |
| Claude capability probe | Run an equivalent interactive-provider probe. | Capability remains disabled unless it proves the same safety properties. |
| LAN and relay parity | Run the same list, claim, ack, unread count, and card tests over direct HTTP and relay RPC. | Identical server state and client presentation. |
| Desktop and iOS visibility | Verify new card, count, dedupe, APNs deep link, processed history, and approval-card coexistence. | An unacknowledged item is always discoverable and an approval is not hidden by a Mate ack. |
| Reconciliation and prune | Age processed and unprocessed fixtures past retention. | Only eligible processed rows prune, and reconciliation finds no orphan source event or inbox item. |

The feature is accepted only when the five-event burst and every crash boundary preserve an unacknowledged inbox item until a generation-authorized idempotent acknowledgment commits.
It is also accepted only when a default Codex or Claude wake cannot write literal text into a human composer.
Source-event idempotency is future scope because separate `recordEvent` calls intentionally append separate immutable ledger events.

## Implementation sequence

### PR 1 - durable model and shadow write

Add the additive schema migration, repositories, task-event transaction hook, receipt journal, claim primitives, and reconciliation tests.
Create inbox rows for new boss-relevant events but do not change provider wake behavior.
Add cutover backfill for unresolved tasks and explicit migration receipts.

### PR 2 - attention routing and observability

Change the Mate outbox intent payload to reference inbox ids.
Add the notifier capability interface, default unsupported behavior, provider-safe probe harnesses, metrics, and wake status projections.
Keep any legacy visible wake behind an explicit compatibility mode only.

### PR 3 - Mate protocol and recovery

Add generation-bound list, claim, renew, processing, acknowledgment, and adoption endpoints plus matching relay RPC.
Wire OwnerManager recovery handoff and add stale-generation, duplicate, lease-expiry, and server-restart coverage.

### PR 4 - desktop and iOS inbox

Add server-backed inbox cards, counts, dedupe, APNs metadata, LAN and relay hydration, and persistent processed history.
Keep no-mistakes and merge decision cards authoritative until their own workflows resolve.

### PR 5 - staged enablement and removal

Run shadow reconciliation in production-like internal use.
Enable inbox-first behavior, disable default composer wakes, verify observability and recovery targets, and remove the compatibility path only after the safe fallback is accepted.

## Source anchors

- `apps/server/src/tasks.ts` - `recordEvent` and `recordEvents` derive notification intents and persist task events before observer callbacks.
- `apps/server/src/stateDb.ts` - `task_events`, `notification_outbox`, `appendEvent`, immediate claim ordering, delivered transition, retry, and current pruning semantics.
- `apps/server/src/outboxWorker.ts` - lease, retry, backoff, terminal failure, and delivered-after-callback behavior.
- `apps/server/src/outboxWorker.test.ts` - durable event plus mate and push intents survive retry, and expired claims resume after restart.
- `apps/server/src/index.ts` - current `OutboxWorker` maps `mate` delivery to `deliverMateWake` and `push` delivery to `PushRouter`.
- `apps/server/src/mateWake.ts` - boss event filter and the current one-line Mate wake construction.
- `apps/server/src/fleetMonitor.ts` - `queueOrSubmit`, in-memory gated queue, adapter submission, and user-message publication.
- `apps/server/src/adapters/codexAppServerAdapter.ts` - serialized Codex `turn/start` and `turn/steer`, client user message ids, and history reconciliation.
- `apps/server/src/ownerManager.ts` and `apps/server/src/stateDb.ts` - durable Mate owner generations, compare-and-swap recovery, and trusted provider identity fields.
- `apps/server/src/agentLauncher.test.ts` - the three-concurrent-Claude-worker dispatch regression that preserves all three launches and provider-session bindings.
- `apps/server/src/http.ts` - existing durable task-decision event recording and best-effort Mate FYI behavior.
- `apps/server/src/pushRouter.ts` - existing task-event and attention push routing.
- `apps/ios/Perch/PerchClient.swift`, `apps/ios/Perch/ContentView.swift`, and `apps/ios/Perch/DecisionCard.swift` - current task-event retrieval, decision cards, APNs registration, and relay-aware client surfaces.

## Unresolved decisions

1. Should an intentionally fresh Mate automatically adopt old unacknowledged items after an explicit boss confirmation, or always leave them for a separate reassignment action?
2. What maximum pending-item age should trigger escalation when no provider-safe wake capability exists?
3. Is strict global FIFO acceptable for urgent approvals, or should a later revision introduce a clearly visible priority lane with its own ordering contract?
4. What retention period is required for processed inbox receipts in installations with regulated audit needs beyond the proposed 90 days?
5. Which provider versions and exact protocol evidence are sufficient to enable a silent notifier, if either provider adds one?
