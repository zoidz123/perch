# Bundled AutoReview delivery

New Perch tasks use one of three kinds: `ship`, `scout`, or `operate`.

`ship` tasks must run focused tests and receive a clean AutoReview receipt for the exact final worktree tree and diff before Perch can create a pull request.

`scout` tasks are read-only investigations with durable reports.

`operate` tasks are verified runtime or external actions with gate-by-gate evidence.

Project records do not set a delivery policy.

Historic `direct-PR`, `no-mistakes`, and `local-only` task records remain readable and recoverable during the migration window.

New task creation rejects those legacy modes with a compatibility error.

## Immutable package provenance

The bundled AutoReview tree comes from `openclaw/agent-skills` commit `2a409d348a4bcf6f15e41e9a20efd0b298a32528`, canonical path `skills/autoreview`.

The manifest records the exact runtime bytes, source blobs, modes, and SHA-256 hashes in `apps/server/assets/autoreview/manifest.json`.

The pinned upstream test suite and fixture files are not packaged.

Bootstrap TruffleHog found four VERIFIED live Lob API credentials in two upstream test sources, `skills/autoreview/tests/test_autoreview_hardening.py` (three) and `skills/autoreview/scripts/autoreview_test.py` (one).

The pinned helper is itself the bootstrap gate, it fails closed on verified secrets, and it cannot exclude paths, so vendoring those bytes would make a clean receipt structurally impossible.

The manifest therefore records all five excluded test-only paths, their exact upstream blob ids and SHA-256 hashes, and the reason, without copying any credential bytes into Perch.

The source tree retains upstream's `CLAUDE.md -> AGENTS.md` symlink.

Because npm omits symlinks from tarballs, packaging materializes that one link as the target's exact hash-verified bytes and restores the source symlink after packing.

The package never fetches `latest` content and never resolves a helper from `~/.agents`, `~/.codex`, or `~/.claude`.

The bundled skill's Codex Sol high-reasoning default and access-only Terra fallback remain inside the upstream helper contract.

## Worker operations

Codex root workers use `perch.autoreview_run` and `perch.delivery_create_pr` dynamic tools.

Claude and other managed workers use `perch autoreview run` and `perch delivery create-pr` with the same task-session authentication and request shape.

The server freezes the target and invokes the bundled helper with an argument array.

Focused-test argv must use a supported test launcher such as `npm test`, `node --test`, `pytest`, `cargo test`, or `xcodebuild test`.

The server rejects shells and arbitrary executables, runs the selected test with an isolated home, temp, and configuration environment that omits Perch, provider, GitHub, SSH, and user-configuration variables, and records only the command shape plus an argv SHA-256.

It stores hashes and structured findings but never secrets, raw focused-test arguments, or raw credential-bearing process output.

The server recomputes base, HEAD, tree, diff, and clean-worktree facts immediately before creating a PR.

Changing source after review invalidates the receipt mechanically.

Only the server push-and-create path can link a new ship PR.

## Remaining capability boundary

Perch rejects worker `pr_linked` and completion requests for new ship tasks unless a matching server-created delivery record and current clean receipt exist.

Inherited GitHub credentials can still permit an out-of-band `git push` or `gh pr create` in a worker shell on installations where removing them would be unsafe.

That bypass cannot be accepted by Perch completion or PR-linking state, but it is not yet prevented at the process boundary.

Follow-up: isolate managed worker GitHub credentials after auditing provider launch environments and recovery behavior.
