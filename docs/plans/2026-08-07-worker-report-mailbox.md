# Lossless worker-to-Mate mailbox

## Goal

Complete worker-authored deliverables cross the worker-to-Mate boundary losslessly, while worker reports never interrupt or steer Mate and never appear as synthetic user messages in Mate's boss-facing chat.
Privacy from native provider transcripts is explicitly out of scope.

## Architecture

Worker-to-Mate is fan-in through one durable SQLite mailbox.
Mate-to-worker remains the existing direct, journaled prompt path; workers gain no inbox and never poll.
Codex native `spawn_agent` / follow-up / `wait_agent` remain a separate provider-native child-runtime layer, with no supervisor agent and no private provider thread.
A wake is disposable attention transport only; correctness comes from durable SQLite state.
A bounded wait of at most 30 seconds exists only as a latency optimization.

## Durable model (migration 16)

- `worker_reports` - immutable, trigger-protected: full report body, evidence JSON, stable id, worker/task/session/runtime provenance, accepted timestamp, byte size, sha256, format, and `UNIQUE(task_id, session_id, idempotency_key)` as the mechanical idempotency boundary.
- `mate_mailbox_deliveries` - mutable projection referencing the immutable task event (and report when one exists): recipient, `pending -> claimed -> acknowledged` state, opaque claim token, lease expiry, claiming/acknowledging generation, semantic acknowledgment identity and disposition, idempotency key, timestamps.
  The global `task_events.id` is the order key: FIFO within a task, deterministic commit order across tasks.
  The report body is never copied into the delivery row.

Worker-sourced boss-relevant events (`pr_linked`, `needs_decision`, `blocked`, `completion_requested`, `failed`) and report submissions create their delivery in the same transaction as the event.
Report submission additionally appends a pointer `note` event (`data.reason: "worker_report"`) carrying the safe summary and stable report id, never the body.

## Tools

- Worker: `POST /tasks/:id/reports` behind `perch report send` (Claude/legacy) and the `perch.send_report` Codex root dynamic tool (relayed with the verified root session; the `root_thread_required` gate keeps inherited child credentials powerless).
  Success means the report plus delivery obligation are durable, not that Mate processed them.
  Bounds are explicit (4 KiB summary, 256 KiB report, 256 KiB evidence) with 413 rejection and no silent truncation.
- Mate: `perch mailbox read | message <id> | ack <id> --token <t> | wait [--timeout <=30]` over `/mate/mailbox/*`, fenced to the live mate generation's own hook credential.
  Listing returns pointers plus bounded routing summaries; `message` returns the original content byte-for-byte; `ack` is idempotent, token- and generation-fenced, and never grants completion authority.

## Attention and presentation

The outbox `mate` channel no longer injects worker wake lines: mailbox-routed events produce at most one content-free `[perch mailbox] N unread ...` nudge, submitted only to an idle Mate, re-armed on the idle transition only when newer messages arrived.
The nudge is filtered from the boss-facing timeline projection and the live timeline stream (and skips the live user-message fan-out), while provider-native transcripts keep it.
System-sourced notifications (`chart_ready`, `checks_green`, `merge_ready`, `merged`, `stalled`, `runtime_interrupted`) stay on the legacy wake-line path as the explicit compatibility boundary.

## Verification

Migration/backward-compatible decode, byte-for-byte round-trip, explicit oversize rejection, idempotent retry, transactional commit, FIFO and cross-task ordering, claim exclusivity and lease expiry, ack replay/conflict, stale generation and stale token refusal, worker/device/child/unrelated-session refusal, restart drain without acknowledged redelivery, ack-cannot-complete, bounded wait behavior, no Mate interruption or synthetic user message, unchanged Mate-to-worker prompting, and the isolated end-to-end flow.
