# Perch CLI

This guide describes `perchctl@0.1.2`.
`perch --help` prints the canonical command list, and `perch --version` prints the version from the root package manifest.

## Launch and control

```text
perch mate [options] [claude|codex]
perch claude [options] [claude args...]
perch codex [options] [codex args...]
perch run [options] -- <command> [args...]
perch ls
perch attach [options] <session-id>
perch stop <session-id>
perch recover task <task-id>
```

Common launch options are `--server`, `--token`, `--cwd`, `--title`, and `--no-attach`.
`perch mate --new` requests an intentionally fresh Mate conversation and is refused while Mate is live.
Press `Ctrl+]` to detach from an attached terminal without stopping its process.

## Projects

```text
perch project [list]
perch project add <path> [--mode direct-PR|no-mistakes|local-only] [--yolo] [--yes]
perch project remove <path>
```

Project removal changes only the registry.
Setting a project to `no-mistakes` validates the bundled runtime and protocol, asks once unless `--yes` is present, initializes and verifies the repository, and only then persists the new mode.
Any failure preserves the previous mode.

## Configuration

```text
perch config show [--global|--project PATH] [--effective] [--json]
perch config get <key> [--global|--project PATH] [--effective] [--json]
perch config set --global <key> <value>
perch config set --project PATH <key> <value> [--yes]
perch config unset --global <key>
perch config unset --project PATH <key>
perch config validate [--global|--project PATH] [--effective] [--json]
```

Mutations always require an explicit scope.
Global keys are `dispatch.agent`, `dispatch.model`, `dispatch.effort`, `mate.agent`, `mate.model`, and `mate.effort`.
Project-only keys are `task.mode` and `task.yolo`.
Agent values are `claude` or `codex`, task mode is `direct-PR`, `no-mistakes`, or `local-only`, and yolo is a strict boolean.

Effective output includes `effectiveValue`, `source`, `scope`, `storedValue`, `defaultValue`, and `overriddenBy` for every key.
Text and JSON redact secret-shaped keys identically.
Environment overrides have higher precedence than stored global launch defaults.
Task mode precedence is explicit task, project, then built-in `direct-PR`.

Read-only runtime keys are:

- `runtime.no-mistakes.version`
- `runtime.no-mistakes.path`
- `runtime.no-mistakes.SHA-256`
- `runtime.no-mistakes.source`
- `runtime.no-mistakes.architecture`
- `runtime.no-mistakes.protocol`

Updating Perch is the only supported way to replace the bundled runtime.

## Pairing, server, and diagnostics

```text
perch pair
perch devices [ls|revoke <id>]
perch server [status|start|stop|logs]
perch doctor [--json] [--fix [--yes]]
perch worktrees
perch worktrees release <id> [--force]
```

`doctor` reports the bundled no-mistakes version, path, SHA-256, source, architecture, and protocol.
It never downloads or PATH-repairs the managed runtime.
Provider installation and sign-in remain separate user actions.

## Contributor checks

```sh
npm ci
npm run check:version
npm run check:public-seed
npm run build
npm run typecheck
npm test -w @perch/server
npm test -w @perch/relay
npm run test:package
```

The iPhone app requires Xcode 26 with the iOS 26 SDK.
