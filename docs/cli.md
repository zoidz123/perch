# Perch CLI

This guide describes the command surface implemented by `bin/perch.mjs` in `perchctl@0.1.0`.
`perch --help` prints the canonical command list.
The current CLI has one root help screen, no per-command help pages, and no `--version` flag.

## Provider and Mate launch options

| Option | Default or effect |
| --- | --- |
| `--server <url>` | `PERCH_SERVER_URL` or `http://127.0.0.1:8787` |
| `--token <token>` | `PERCH_TOKEN` or `$PERCH_HOME/token` |
| `--cwd <path>` | Current directory |
| `--title <title>` | App session title |
| `--no-attach` | Start without attaching this terminal |
| `--new` | With `perch mate`, start an intentionally fresh conversation |

The first command that needs the Mac server starts it automatically.

## Mate and multi-agent controls

```text
perch mate [options] [claude|codex]
perch project [list]
perch project add <path> [--mode direct-PR|no-mistakes|local-only] [--yolo] [--yes]
perch project remove <path>
perch config [get [<key>]]
perch config set <key> <value>
perch config unset <key>
```

Re-running `perch mate` attaches to a live Mate or recovers its verified conversation and reconciles workers.
Mate uses Claude by default; the positional provider or the `mate-agent` setting can select Codex.
`perch mate --new` requests a fresh conversation and is refused while Mate is live.

Project removal never deletes files.
Config keys are `default-agent`, `default-model`, `default-effort`, `mate-agent`, `mate-model`, and `mate-effort`.
Agent values are `claude` or `codex`.

## Solo agent commands

```text
perch claude [options] [claude args...]
perch codex [options] [codex args...]
```

These commands start one real provider session without Mate task orchestration.
Provider arguments pass through after the first positional argument or `--`.
Press `Ctrl+]` to detach without stopping the provider process.

## Session control

```text
perch ls
perch attach [options] <session-id>
perch stop <session-id>
```

`attach` and `stop` accept an unambiguous session ID prefix.

## Pairing and devices

```text
perch pair
perch devices [ls]
perch devices revoke <id>
```

Pairing creates a revocable device slot and prints its QR code and URL.
Treat that offer as a live credential.

## Server, configuration, and diagnostics

```text
perch server [status|start|stop|logs]
perch doctor [--json] [--fix [--yes]]
```

The server uses `$PERCH_HOME`, defaulting to `~/.perch`.
`server logs` prints its last 100 lines.
`doctor` checks required tools and GitHub CLI authentication.
`doctor --fix` shows each supported unattended fix before asking; provider sign-in remains manual.

## Advanced controls

```text
perch run [options] -- <command> [args...]
perch worktrees
perch worktrees release <id> [--force]
perch recover task <task-id>
```

`run` hosts an arbitrary command under a Perch-owned PTY but has no provider-specific timeline or managed recovery.
Worktree release refuses live holders.
`--force` only overrides dirty or unlanded protection, not live-session or active-task protection.
`recover task` applies only to a managed task with a recoverable verified provider identity.

Charts are created and registered through Mate and task workflows, not a public CLI command.
The HTTP Task API is an implementation surface, not normal-user CLI.

## Contributor-only checks

These commands validate the source repository; they are not installed CLI commands:

```sh
npm ci
npm run check:public-seed
npm run build
npm run typecheck
npm test -w @perch/server
npm test -w @perch/relay
npm run test:package
```

The iPhone app requires Xcode 26 with the iOS 26 SDK.
