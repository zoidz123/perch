# Herdr worker panes

Herdr support is opt-in and disabled by default.
When disabled, unavailable, or below the supported protocol, Perch keeps its existing launch behavior.

## Setup

Run the one explicit setup command from the Mac that runs Perch:

```sh
perch herdr setup --provider claude,codex
```

This command runs Herdr's public `integration install` command for each selected provider.
It is the only Perch command that modifies Herdr or provider configuration.
It then stores the Perch-local opt-in in `~/.perch/settings.json` with mode 0600.

Use `perch herdr status` to see the local opt-in state, Herdr protocol compatibility, and Herdr's provider-installation status.
Use `perch herdr disable` to stop creating new panes without deleting a provider integration or closing existing panes.
Use `perch herdr enable --provider claude,codex` only after setup if you want to re-enable the stored Perch behavior.
Enable does not install or mutate a provider integration.

## What Perch creates

Each dispatched Claude worker is started in a real Herdr-owned pane with `--no-focus`.
Perch still mints the worker session id, owns the task/worktree ledger, installs and correlates hooks, handles approvals and recovery, and applies the existing teardown gate.
The pane's exact Herdr session, workspace, tab, pane, and terminal identities are stored durably.
After a Perch restart, it reconnects only to the stored pane ids and never creates replacements during reconnect.
A missing pane becomes stale state instead of a duplicate pane.

Each dispatched Codex worker remains owned solely by Perch's `codex app-server` adapter.
Perch never starts a second Codex TUI or another app-server client.
Instead it creates a real Herdr pane running `perch herdr console --session <id>`.
The pane is explicitly reported as `Perch worker console` in Herdr.
It shows live state/output from Perch and routes typed lines through Perch's existing `POST /sessions/:id/submit` path to the authoritative adapter.

The task ledger remains the lifecycle authority for every worker.
Herdr status is presentation only.
On a landed or forced teardown, Perch closes only the stored pane id after its existing gate authorizes the cleanup.
Missing or already-closed panes are harmless best-effort cleanup outcomes.

## Compatibility and privacy

Perch uses only Herdr's public CLI commands: status, agent start, pane read/send/report/close, and integration install during explicit setup.
The minimum supported Herdr protocol is 16.
If the CLI is absent, the server is down, or the protocol is incompatible, Claude falls back to the existing Perch PTY path and Codex skips presentation rather than changing its app-server ownership.

Perch persists only opaque Herdr identities and presentation state.
It does not put worktree paths, prompts, terminal tails, provider thread ids, attach commands, approval payloads, or credentials into Herdr metadata or the status API.
The hook capability reaches a Claude pane only as its process environment because Perch hooks require it.

Cursor is represented in the provider-neutral configuration seam but has no implementation and cannot be enabled.

## Operational limits

The Codex console is line-oriented and is not a native Codex TUI.
It cannot replace provider-native terminal affordances such as local Codex attach.
Use `perch attach <session>` for the existing native attach behavior, with its existing app-server ownership warning.
Herdr's native provider integration is responsible for Claude's provider-side agent detection.
Perch reports a pane-scoped agent state only for the real Codex console, never to fabricate rows for daemon-backed Codex sessions.
