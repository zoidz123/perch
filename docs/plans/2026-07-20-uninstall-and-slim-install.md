# Uninstall and slim hook install

Date: 2026-07-20
Reference: approved chart `perch-teardown-design`

## Decision

Ship an explicit `perch uninstall` command and replace the large inline Claude hook commands with one dependency-free shell shim.
The teardown command answers whether users can cleanly leave Perch, while the shim reduces the configuration footprint Perch creates during install.

## `perch uninstall`

The command removes every Perch-owned entry from user agent configuration while preserving all user-owned entries and state by default.

It removes Perch hook entries from `~/.claude/settings.json`, including both legacy inline commands containing `$PERCH_HOOK_URL` and new commands that reference `~/.perch/bin/perch-hook`.
It removes Perch entries from `~/.codex/hooks.json` and removes the Perch trust entry from `~/.codex/config.toml`.
It removes any legacy `<!-- perch begin -->` through `<!-- perch end -->` block from `~/.codex/AGENTS.md`.
It removes `~/.perch` state only when the user supplies `--purge-data`.

Uninstall must reverse only changes owned by Perch.
Unparseable JSON causes a loud refusal before any file is changed.
All writes are atomic.
`--dry-run` prints the exact per-file diff without writing.
The command refuses while the Perch server is running unless the user supplies `--force`.

Uninstall changes local configuration only for relay and pairing state.
Relay registration ends with the server, so there is no separate deregistration step.
Perch has no launchd entry, so uninstall has no launchd work.
The command is an explicit CLI verb and must not be wired to an npm `preuninstall` lifecycle hook.

The core guarantee is a round-trip test that starts with fixture configuration, installs Perch, uninstalls Perch, and asserts that the original files are byte-identical.
The fixtures cover Claude settings, Codex hooks, and Codex `AGENTS.md`, including pre-existing user hooks and both generations of Perch ownership marker.

## Slim hook install

Install one executable dependency-free shell shim at `~/.perch/bin/perch-hook`.
The shim owns all curl, timeout, fallback, and echo behavior currently embedded in Claude hook commands.
Claude settings entries become short commands that invoke the shim with an event argument such as `perch-hook session-start`.

The shim preserves the current event semantics exactly.
Telemetry events use a 3-second timeout.
Blocking permission, question, and elicitation round-trips use a 570-second timeout and preserve their current fallback messages.
`SessionStart` and `Stop` preserve stdout echo behavior.
The `PreToolUse` observer preserves the observe-only header.

The shim path becomes the ownership marker for new Claude settings entries.
Install and uninstall continue recognizing the legacy `$PERCH_HOOK_URL` marker forever because users may skip versions.
Install migrates legacy inline entries to slim entries while leaving user entries untouched.
An upgrade that changes only shim logic rewrites the shim but does not rewrite settings.

Tests cover migration from fat entries to slim entries, preservation of user entries, generated shim semantics, and uninstall round trips across both marker generations.

## Documentation and verification

Add a short uninstall section to the README or operations documentation.
Document the complete removal flow as `perch uninstall && npm rm -g perchctl`.
Run the focused hook and CLI tests, the full server suite, the relevant build and lint checks, the documentation gate, and `git diff --check`.

## Risks and open questions

The shim adds one executable file on disk, so install must create it atomically with executable permissions and uninstall must remove it without touching retained Perch state.
Marker matching must remain narrow enough to preserve user commands while accepting both historical and current Perch entries.
Dry-run output must be deterministic and sufficiently exact for a user to audit every planned file change.
