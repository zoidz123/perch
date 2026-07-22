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
Perch creates or resumes the thread itself, captures the thread id from the protocol response, serializes all programmatic input (`turn/start` when idle, `turn/steer` with `expectedTurnId` while a turn is active), and stamps every input with a `clientUserMessageId` so a lost response reconciles against `thread/read` history instead of resending blind.
There is no Codex PTY and no keystroke injection; a desktop human attaches the real native TUI as an additional same-user client with the session's surfaced `attachCommand` (`codex resume <threadId> --remote unix://<socket>`), which `perch attach` execs directly (argv, no shell) when the session record carries it.

`perch claude` and `perch codex` launch real provider sessions.
`perch run` can host another command, but arbitrary processes do not gain provider timelines or managed recovery.

Repositories, provider processes, credentials, task state, worktrees, attachments, charts, and successfully appended audit records stay on the Mac.
Perch has no hosted repository runtime or user account.

## Mate and workers

Mate is one durable fleet owner, not another task row.
`perch mate` starts it in a dedicated home with a Perch-managed role, or reconnects to its existing runtime.

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

SQLite stores the current task projection, immutable task events, separately persisted PR, completion-verification, and review facts, runtime generations, Mate ownership, leased operations, and notification outbox.
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

Worktree leases remain bound to managed tasks until the landed gate authorizes teardown.
Perch refuses ordinary release of dirty trees, unlanded commits, and live holders.

## Recovery

Recovery is explicit and provider-aware.
It is available only when the durable runtime record contains a verified, provider-matching conversation identity.

Before recovery launches a replacement process, Perch proves the previous one is gone; rebinding to a surviving Codex daemon launches nothing.
It only reaps a crash orphan when the executable, PID birth time, and expected provider match the persisted runtime record.

Claude recovery resumes the exact conversation and requires a matching authenticated session-start event.
Codex recovery `thread/resume`s the exact recorded thread through the owning adapter: a daemon that survived the restart is rebound over its recorded socket without a respawn, a dead daemon is respawned to resume the rollout-backed thread with the stale in-flight turn represented as interrupted, and the resumed thread id from the protocol response is the identity proof.
Legacy Codex runtimes recorded before app-server ownership migrate through the same thread/resume path when their rollout exists; a thread whose rollout was never written fails with the permanent missing-rollout condition and ends truthfully.
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
