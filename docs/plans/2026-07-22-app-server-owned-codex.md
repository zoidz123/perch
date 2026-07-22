# App-server-owned Codex sessions

Converted from the approved chart `da162b34cb9dcb9b` (scout task `design-app-server-owned-4a3b`, drawn 2026-07-22).
Verified against codex-cli 0.144.6 (source tag rust-v0.144.6) with live two-client probes on `codex app-server --listen unix://`.

## Decision

Perch owns every Codex session through a session-isolated `codex app-server` daemon on a private unix socket, and remains the sole standing authoritative client.
The daemon key includes the workdir, launch overrides, session-scoped hook identity, and Codex runtime fingerprint, so managed workers normally have one daemon and one thread each.
Perch creates or resumes threads, captures thread IDs from protocol responses, serializes all programmatic input, and persists authoritative thread and turn IDs.
Protocol notifications own timeline, status, approvals, and catch-up.
The phone transport is unchanged: LAN, Tailscale, or E2EE relay to Perch, never to the app-server.
Desktop humans attach the real native TUI with `codex resume <threadId> --remote unix://<socket>` as an additional same-user client.
Claude stays byte-for-byte on the existing PTY-backed provider path.

## Verified protocol facts (0.144.6)

- The unix-socket listener accepts unlimited concurrent clients, each with its own `initialize`; stdio is single-client.
- Turn and item events go only to thread subscribers; `thread/resume` subscribes and replays turn history in its response.
- Approvals fan out to all thread subscribers with one request id; first answer wins; the rest receive `serverRequest/resolved`; pending approvals replay to rejoining clients; zero subscribers waits forever.
- A second `turn/start` on an active thread never errors: it steers into the active turn; `turn/steer` carries a real `expectedTurnId` CAS guard; requests serialize per thread across clients.
- `turn/start` accepts `clientUserMessageId`; it persists into the rollout and surfaces as `clientId` on `userMessage` items via `thread/read {includeTurns: true}`; codex does not deduplicate on it, so resends must be history-verified.
- SIGKILL mid-turn: history survives, the in-flight turn becomes `interrupted`, and the thread resumes cleanly; turns are not resumable, threads are.

## Delivery boundary

The complete migration, stages 1 through 5, lands in this refactor.
App-server ownership is the default and only Codex session driver; there is no runtime fallback to PTY injection.
Rollback is a release or commit rollback, not a runtime switch.
Every Codex PTY prompt-injection path, kickoff watchdog, and PTY-based Codex recovery is removed.
The generic PTY adapter and every Claude behavior are preserved byte-for-byte.

## Stage 1: owning adapter

- New `CodexAppServerAdapter` implements the existing `AgentAdapter` seam using `CodexAppServerClient`, `CodexDaemonManager`, and the ws-unix transport.
- A routing adapter delegates per agent: Codex sessions to the owning adapter, everything else to the PTY adapter.
- App-server ownership persists on the runtime record (driver, socket path, thread id).

## Stage 2: protocol-native behavior

- The initial kickoff is the first acknowledged `turn/start` after `thread/start` returns; never a PTY write.
- A fresh Codex Mate submits one visible readiness turn, preserves the same lost-response history reconciliation as other programmatic input, and withholds attach metadata until the readiness turn completes successfully.
- Kickoff intent is journaled durably before send with a stable `clientUserMessageId`, and the returned `turn.id` is journaled on acceptance.
- Idle input uses `turn/start`; input during an active turn uses `turn/steer` with `expectedTurnId`.
- Every programmatic input carries a `clientUserMessageId`; ambiguous response loss reconciles against `thread/read` history before any resend; never a blind resend.
- Timeline items, truthful working/idle state, and assistant streaming come from thread, turn, and item notifications; timeline items carry protocol item ids for dedupe.
- Server requests route into the existing durable pending-approval system; `serverRequest/resolved` dismisses an approval answered by any client on every other client.
- Perch stays subscribed for the life of the session so pending approvals never hang without a client.

## Stage 3: recovery

- On Perch restart with a healthy daemon: reconnect to the recorded socket, `thread/resume` the recorded thread, replay history into the timeline deduped by protocol item id, and rebind the runtime generation without killing the daemon.
- The boot orphan-daemon sweep skips sockets recorded on recoverable app-server-owned runtimes.
- If the daemon died: respawn it, resume the rollout-backed thread, represent the stale in-flight turn as interrupted, and use the existing continuation-turn recovery behavior.
- The merged missing-rollout classifier (`-32600` + exact message) and stale-mate retirement semantics from PR #36 are preserved under the app-server driver.
- A turn whose acceptance is unknown is never blindly repeated; reconciliation reads thread history first.

## Stage 4: native desktop attachment

- Each attachable Codex session surfaces its exact attach command, `codex resume <threadId> --remote unix://<socketPath>`, on the session record.
- A fresh Codex Mate does not surface that command while its readiness turn is pending, preventing the native TUI from attempting `thread/resume` before rollout history exists.
- The attached native TUI replays history, receives live events and approvals, and can steer or interrupt under same-user trust.
- Perch remains the single programmatic writer; the attached human TUI is controller-capable by design.

## Stage 5: remove the legacy Codex PTY path

- App-server ownership is the default and only Codex driver.
- Remove `prepareCodexRemote` TUI-origin launch and thread-discovery behavior.
- Remove the Codex kickoff watchdog, restart rearming, and `kickoff_retried` journaling.
- Remove Codex-specific PTY submit confirmation, kitty-keyboard mode replay, prompt typing, Enter-key submission, and fallback branches.
- Remove Codex PTY recovery through terminal-owned `codex resume` launches.
- Remove rollout scanning as the normal identity mechanism.
- Collapse the `codexControl` side-channel into the owning app-server adapter.
- Preserve the generic PTY adapter and every Claude behavior.
- Recorded legacy Codex runtimes upgrade safely: migrate by authoritative thread ID when provably possible, otherwise end truthfully with an actionable upgrade message; never resume through PTY injection.
- A regression assertion proves no Codex launch, kickoff, follow-up input, retry, or recovery path calls PTY prompt submission.

## Tests

- Two-client unix-socket harness: initialize, resume, history replay, shared live events, approval first-answer-wins and resolved fanout.
- Per-thread serialization, correct `expectedTurnId` steering, duplicate-input idempotency via history reconciliation.
- Perch restart rebind without daemon restart.
- Daemon death, interrupted-turn history, resume, and continuation recovery.
- Fresh-thread missing-rollout race and permanently-missing-rollout classification.
- Fresh Codex Mate readiness completion, attach-command withholding during the turn, and lost-response reconciliation before the command is revealed.
- Slow-consumer/reconnect behavior and schema shapes against installed codex 0.144.6.
- Desktop native-TUI attachment smoke coverage without simulators or physical devices.
- Legacy Codex runtime upgrade: provable thread migration and the truthful-end path.
- Full Claude regression proving the PTY path is unchanged.
- Regression assertion that no Codex path reaches PTY prompt submission.

## Risks and open questions

- The app-server protocol is officially experimental and drifts across codex releases; the daemon key already folds in the codex runtime fingerprint, and the schema bundle must be regenerated on upgrade.
- Approvals never time out server-side; Perch must stay subscribed, persist pending requests, and rely on resume replay after crashes.
- In-flight turns die with the daemon; recovery is resume plus a continuation turn, never fake turn resumption.
- With no runtime fallback, a broken codex install or daemon spawn failure fails Codex launches loudly; rollback is by release or commit.
- Open: an attached TUI can always steer or interrupt (same-user trust); true observer-only desktop viewing would need a Perch-rendered view later; v1 accepts controller-capable attach.
