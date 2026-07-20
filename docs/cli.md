# Perch CLI

This guide describes `perchctl@0.1.5`.
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
perch config set mate <model> [--effort <level>] [--agent claude|codex]
perch config set dispatch <model> [--effort <level>] [--agent claude|codex]
perch config set --global <key> <value>
perch config set --project PATH <key> <value> [--yes]
perch config unset --global <key>
perch config unset --project PATH <key>
perch config validate [--global|--project PATH] [--effective] [--json]
```

Mutations always require an explicit scope.
The mate and dispatch model commands are global by definition and resolve the model to one agent before writing the complete agent, model, and effort tuple atomically.
An omitted effort uses the selected model's registry default.
Unknown models report closest matches, unsupported efforts report the valid levels, and ambiguous cross-agent ids require an interactive choice or `--agent`.
Global keys are `dispatch.agent`, `dispatch.model`, `dispatch.effort`, `mate.agent`, `mate.model`, and `mate.effort`.
Setting those dotted global keys remains supported for compatibility and prints a deprecation notice recommending the atomic role command.
Project-only keys are `task.mode` and `task.yolo`.
Agent values are `claude` or `codex`, task mode is `direct-PR`, `no-mistakes`, or `local-only`, and yolo is a strict boolean.

Effective output includes `effectiveValue`, `source`, `scope`, `storedValue`, `defaultValue`, and `overriddenBy` for every key.
Configuration listings also report each role's resolved agent and warn about a saved agent and model tuple that the current registry cannot validate.
Warnings never rewrite saved configuration.
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

## Models

```text
perch models
perch models --json
```

`perch models` lists Claude models from Perch's bundled `CLAUDE_ALIAS_CATALOG` and Codex models from the live app-server catalog with its existing static fallback.
Claude listing does not invoke the Claude CLI, an external API, or a gateway.
The table shows model id, agent, supported effort levels, aliases, source, and whether the model is selected for mate or dispatch.
Every row identifies its source as live or bundled.
If Codex is missing or its listing mechanism is unavailable, the command retains the bundled fallback models, prints a source note, and still succeeds.
`--json` returns the model rows, source notes, and raw source statuses for scripts.

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
