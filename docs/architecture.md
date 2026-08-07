# Perch architecture

Perch is a local-first orchestration and durability layer for terminal coding agents.
The Mac owns execution and durable state; the terminal and iPhone are clients of the same server.

```text
terminal attachment                  native iPhone app
         |                                  |
         | local HTTP and WebSocket         | direct or E2E relay
         +----------- Perch server ---------+
                            |
               +------------+------------+
               |                         |
       provider runtimes          durable local state
   Claude Code PTYs, Codex        tasks, runtimes, worktrees
   app-server daemons
```

## Local execution

Claude Code launches under a server-owned PTY.
The desktop terminal attaches as a thin client, so `Ctrl+]` can detach without killing the provider process, and the phone never mirrors or resizes the terminal.
Claude's initial worker brief rides the spawn argv as the CLI's positional query, so nothing is ever typed into a fresh PTY to start work.

Codex sessions are app-server-owned: Perch spawns one `codex app-server` daemon per session workdir on a private unix socket and remains its sole standing authoritative client.
The daemon key also includes launch overrides, the session-scoped hook identity, and the Codex runtime fingerprint, so managed workers normally have one isolated daemon and one thread each; the thread ID identifies the conversation, while the daemon boundary isolates process state and credentials.
The daemon inherits the server's ordinary `CODEX_HOME`, so nonsecret user Codex capability settings remain available without Perch copying configuration or credentials.
Perch creates or resumes the thread itself, captures the thread id from the protocol response, serializes all programmatic input (`turn/start` when idle, `turn/steer` with `expectedTurnId` while a turn is active), and stamps every input with a `clientUserMessageId` so a lost response reconciles against `thread/read` history instead of resending blind.
There is no Codex PTY and no keystroke injection; a desktop human attaches the real native TUI as an additional same-user client with the session's surfaced `attachCommand` (`codex resume <threadId> --remote unix://<socket>`), which `perch attach` execs directly (argv, no shell) when the session record carries it.

## Native Codex multi-agent observation

When a managed Codex root turn exposes native multi-agent V2, Codex itself invokes its model-side collaboration tools and owns child creation, follow-up, waiting, closure, and recovery.
Perch never sends `spawnAgent`, `sendInput`, `wait`, `resumeAgent`, or `closeAgent` as a collaboration RPC.
Perch feature-detects known root-thread `subAgentActivity` and `collabAgentToolCall` item shapes instead of guessing from a Codex version string.
Unsupported, disabled, unknown, and optional-method-error cases preserve the prior root-only behavior.
Set `PERCH_CODEX_NATIVE_MULTI_AGENT=disabled` before server start to disable observation without changing the user's Codex configuration.
Perch stores only a durable content-free child observation keyed to the outer runtime generation, with child and parent thread IDs, path or depth, role when supplied, observed state, timestamps, and protocol metadata.
Child observations are not Tasks, Runtimes, AgentSessions, fleet rows, worktrees, attach targets, chat timelines, or task-completion authorities.
Root lifecycle and completion callbacks reject child-thread notifications before they can alter root state, prompt delivery, or task lifecycle, and child-thread server requests are answered with a safe denial instead of being surfaced as root requests.
Perch intentionally offers no direct child interruption because the verified Codex 0.146.0 probe interrupted the root workflow too.
Native children share the root worktree, so work is decomposed read-only where possible and concurrent writes are unsafe.
The real native-collaboration contract test remains opt-in (`PERCH_CODEX_NATIVE_MULTI_AGENT_E2E=1` plus an explicitly dedicated `PERCH_CODEX_NATIVE_MULTI_AGENT_E2E_HOME`) because it performs model work and writes only to that supplied test home.

`perch claude` and `perch codex` launch real provider sessions.
`perch run` can host another command, but arbitrary processes do not gain provider timelines or managed recovery.

Repositories, provider processes, credentials, task state, worktrees, attachments, charts, and successfully appended audit records stay on the Mac.
Perch has no hosted repository runtime or user account.

## Mate and workers

Mate is one durable fleet owner, not another task row.
`perch mate` starts it in a dedicated home with a Perch-managed role, or reconnects to its existing runtime.
Before exposing a fresh Codex Mate's native attach command, Perch submits and awaits one visible readiness turn so the new thread has rollout-backed history and can be resumed immediately.

Mate dispatches tasks into registered projects and isolated worktrees.
Worker events wake Mate through a queued server path, so it does not poll and the user can steer the fleet from one conversation.

One shared fleet monitor derives lightweight state for every session and fans it out to connected clients.
Opening one session adds detailed events without narrowing fleet coverage.

## Provider integrations

Perch keeps provider-specific mechanics behind a normalized fleet boundary.

- Claude Code reports lifecycle and permission events through Perch-scoped hooks, while the server tails the provider transcript for the durable timeline.
- Codex protocol notifications own the timeline, truthful working/idle state, assistant streaming, and structured approvals; `serverRequest/resolved` dismisses an approval answered by any client on every other client, and Perch stays subscribed so a pending approval never hangs without a client.
- There is no runtime switch back to a Codex PTY driver; rollback is a release or commit rollback.

Phone messages enter the same provider session visible in the desktop TUI.
Composer messages queue while a permission prompt is open so ordinary text cannot accidentally answer that prompt.

## Durable task state

SQLite stores the current task projection, immutable task events, separately persisted PR, completion-verification, and review facts, runtime generations, Mate ownership, leased operations, Codex history-sync receipts, content-free native Codex child observations, and notification outbox.
The task lifecycle describes work meaning, while runtime state describes the replaceable process executing it.

```text
task:     queued -> working -> needs_you or blocked -> completion_requested -> done -> landed -> closed
runtime:  starting -> live -> recoverable -> recovering -> live generation + 1
```

A provider turn ending does not complete a task.
Each worker turn must append a task outcome, and worker `done` is translated to `completion_requested` until Mate verifies the deliverable.
The server also derives a non-persisted per-task presentation state from the lifecycle plus the persisted PR, verification, and review facts, and clients render the primary task badge from it instead of inferring readiness from raw PR checks.
See [Worker task API and turn lifecycle](worker-task-api.md) for the endpoint contracts, the presentation states, and the exact completion flow.

Losing a runtime records `runtime_interrupted` without changing the task's semantic state.
Dispatch and recovery operations use durable leases and idempotency keys so a server restart can resume work without intentionally launching duplicates.

Worktree leases remain bound to launched managed tasks until the landed gate authorizes teardown.
Dispatch preparation failures release their lease only under the resource-free predicate documented in [Worker task API and turn lifecycle](worker-task-api.md#post-tasks).
Perch refuses ordinary release of dirty trees, unlanded commits, and live holders.

## Recovery

Recovery is explicit and provider-aware.
It is available only when the durable runtime record contains a verified, provider-matching conversation identity.

Before recovery launches a replacement process, Perch proves the previous one is gone; rebinding to a surviving Codex daemon launches nothing.
It only reaps a crash orphan when the executable, PID birth time, and expected provider match the persisted runtime record.

Claude recovery resumes the exact conversation and requires a matching authenticated session-start event.
Codex recovery resumes the exact recorded thread when durable metadata proves its root-only task-reporting authority.
A runtime without either the current root dynamic-tool marker or durable proof that native children were disabled migrates to a fresh root thread, records the replacement identity, and submits an idempotent handoff from the task brief or durable Mate state before recovery completes.
For an authorized same-thread recovery, a daemon that survived the restart is rebound over its recorded socket without a respawn, while a dead daemon is respawned to resume the rollout-backed thread with the stale in-flight turn represented as interrupted.
The resumed or replacement thread id from the protocol response is the identity proof, so Perch can publish the live session and commit the next runtime generation without waiting for rollout history.
After the live bind, a separate durable receipt drives newest-first `thread/turns/list` catch-up through bounded pages.
Catch-up inserts older rows before live recovery output, records cursor progress, retries bounded failures independently, and notifies timeline clients to refetch when a backfill changes their view.
Older Codex runtimes without a verified provider identity remain unrecoverable; an authorized same-thread resume whose rollout was never written fails with the permanent missing-rollout condition and ends truthfully.
The replacement session must still be alive before Perch commits the next runtime generation.

## iPhone control surface

The native iPhone app shows fleet state, structured timelines, attachments, model controls, usage, plans, charts, and supported approval or question cards.
It is chat-first rather than a miniature terminal.

Mutating actions from the phone are authenticated and authorized against current state.
The server then attempts a best-effort append to the local audit log; append failure does not fail an otherwise successful mutation.
Stale or ambiguous prompts fail closed instead of receiving blind keystrokes.

## Network paths

On a trusted LAN, the iPhone connects directly to the bearer-authenticated Mac server.
Direct local traffic is not transport-encrypted, so the server port must never be exposed directly to the internet.

For off-LAN access, the Mac and phone both dial the relay outbound.
End-to-end encryption terminates on the paired phone and Mac.
The stateless, content-blind relay forwards opaque application frames and has no content keys.
It can observe IP addresses, server identity and room routing, timing, connection duration, and traffic volume.

Pairing offers list direct endpoints before the relay endpoint.
The app can therefore use the local path when available and fall back to the relay without a VPN or inbound port.

See [Security](security.md) for the complete trust and transport boundaries and [Operations](operations.md) for configuration and recovery commands.
