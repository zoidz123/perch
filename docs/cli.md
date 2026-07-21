# Perch CLI

This guide describes `perchctl@0.1.6`.
`perch --help` prints the canonical command list, and `perch --version` prints the version from the root package manifest.
Every command supports `--help` or `-h` without starting a server or provider session.
Use `perch help <command>` as an equivalent form.
For a provider's own help, put the separator before its flag: `perch codex -- --help` or `perch claude -- --help`.

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
perch project ls
perch project add <path> [--mode direct-PR|no-mistakes|local-only] [--yolo] [--yes]
perch project remove <path>
perch project rm <path>
```

Project removal changes only the registry.
`project ls` is an alias for `project list`, and `project rm` is an alias for `project remove`.
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

### Configuration layers

`perch config` is a view of local/global defaults, an optionally selected project's task settings, and immutable package runtime facts.
It is not a dump of the live project registry.
Use `perch project list` to inspect registered projects and their current `MODE` and `YOLO` values.
Pass `--project /path/to/project` to read or mutate the task settings for that registered project.
Without `--project`, `task.mode` and `task.yolo` show their built-in values because no project was selected.

Copy these commands to inspect and change the global Mate default:

```sh
perch config show --global --effective
perch config set mate <model-id> [--effort <level>] [--agent claude|codex]
```

Copy these commands to inspect and change the global dispatch-worker default:

```sh
perch config show --global --effective
perch config set dispatch <model-id> [--effort <level>] [--agent claude|codex]
```

Use `perch models` before choosing a model to see the accepted IDs, aliases, agents, and effort levels.
The role commands write agent, model, and effort together, so they are preferred over the deprecated individual dotted-key form.
For API-created tasks, explicit `agent`, `model`, and `effort` fields override the dispatch defaults for that task only.
Explicit launch fields similarly override the matching role default.
See the [worker task API](worker-task-api.md#post-tasks) for the exact task request fields.
Environment overrides also win over stored global defaults.

Copy these commands to inspect and change delivery settings for one project:

```sh
perch project list
perch config show --project /path/to/project --effective
perch config set --project /path/to/project task.mode no-mistakes --yes
perch config set --project /path/to/project task.yolo true
```

Task mode precedence is explicit task mode, then the project registry value, then built-in `direct-PR`.
`task.yolo` is a project registry value and defaults to `false` when it is unset.
Setting `task.mode` to `no-mistakes` is transactional: Perch validates the bundled runtime, initializes the repository gate, and preserves the prior mode if any step fails.

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

These fields identify the signed runtime shipped inside the installed `perchctl` package:

- `version` is the bundled no-mistakes release version.
- `path` is the selected executable inside the installed package.
- `SHA-256` is that executable's expected digest.
- `source` is `bundled`, meaning Perch owns the package provenance instead of resolving a binary from `PATH`.
- `architecture` is the platform slice selected for this Mac.
- `protocol` is the authorization protocol version Perch requires from the runtime.

An `(unset)` value with source `bundled` in a non-effective `perch config` listing means the field is not user-stored configuration.
It does not mean no runtime is installed or that a project is not configured for `no-mistakes`.
Run `perch config show --effective`, `perch config validate`, or `perch doctor` to inspect and validate the effective bundled runtime.

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

## Complete command index

```text
perch --help | perch help [command]
perch --version
perch claude [options] [claude args...]
perch codex [options] [codex args...]
perch run [options] -- <command> [args...]
perch mate [options] [claude|codex]
perch recover task <task-id>
perch attach [options] <session-id>
perch stop <session-id>
perch ls
perch pair
perch devices [ls|revoke <id>]
perch project [list|ls]
perch project add <path> [--mode direct-PR|no-mistakes|local-only] [--yolo] [--yes]
perch project remove|rm <path>
perch models [--json]
perch config <show|get|set|unset|validate> ...
perch worktrees [release <id> [--force]]
perch doctor [--json] [--fix [--yes]]
perch uninstall [--dry-run] [--purge-data] [--force]
perch server [status|start|stop|logs]
```

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
