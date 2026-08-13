# Perch CLI

This guide describes `perchctl@0.1.18`.
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
perch tasks [--json]
perch attach [options] <session-id>
perch stop <session-id>
perch recover task <task-id>
```

Common launch options are `--server`, `--token`, `--cwd`, `--title`, and `--no-attach`.
`perch mate --new` requests an intentionally fresh Mate conversation and is refused while Mate is live.
Press `Ctrl+]` to detach from an attached terminal without stopping its process.

`perch attach` routes by how the session is owned.
Claude and `perch run` sessions mirror the Perch-owned terminal as a thin client; `Ctrl+]` detaches.
Codex sessions are app-server-owned with no mirrored terminal: `perch attach` launches the native Codex TUI using the session record's attach command (`codex resume <threadId> --remote unix://<socket>`), and exiting the TUI detaches while the session keeps running.
Attaching that TUI suspends the session's custom tool calls (reporting, review, delivery) until you detach, so the CLI prints a warning first.
Codex delivers each dynamic tool call to every client attached to the thread and keeps the first answer, and its TUI answers with "Dynamic tool calls are not available in TUI yet" (codex-cli 0.146.0); detaching restores the tools.
Claude sessions mirror the Perch-owned terminal and are unaffected.
The same routing applies at launch time: `perch codex` starts the session over HTTP and immediately opens the native Codex TUI from the started record's attach command.
A fresh Codex `perch mate` is different: Perch withholds its attach command, submits the visible readiness turn, waits for that turn to complete and materialize rollout history, and only then opens the TUI.
`perch claude` and Claude mate launches keep the WebSocket terminal mirror.
If any Codex launch unexpectedly returns without attach metadata, the CLI prints the started session record plus a hint to retry with `perch attach <session-id>` instead of showing an empty terminal.
`perch codex --no-attach` starts the session and exits without attaching anything.

## Task status

```text
perch tasks [--json]
```

`perch tasks` reads the server's default durable task snapshot, the same non-closed task source used by the mobile app.
Its compact table shows the task and project, server-derived lifecycle state, worker or runtime state, update age, and PR identity or check readiness.
`--json` prints the unmodified task snapshot for scripts.

## Projects

```text
perch project [list|ls]
perch project ls
perch project add <path>
perch project show <path>
perch project remove <path>
perch project rm <path>
```

Project removal changes only the registry.
`project ls` is an alias for `project list`, and `project rm` is an alias for `project remove`.
Projects do not choose delivery behavior.
New tasks choose `ship`, `scout`, or `operate` at creation time.
Legacy project mode fields are ignored when a registry file is decoded and cannot be set again.

## Configuration

```text
perch config show [--global] [--effective] [--json]
perch config get <key> [--global] [--effective] [--json]
perch config set mate <model> [--effort <level>] [--agent claude|codex]
perch config set dispatch <model> [--effort <level>] [--agent claude|codex]
perch config set --global <key> <value>
perch config unset --global <key>
perch config validate [--global] [--effective] [--json]
```

Dotted-key mutations require explicit `--global`.
Task delivery is not a configuration field.
The mate and dispatch model commands are global by definition and resolve the model to one agent before writing the complete agent, model, and effort tuple atomically.
An omitted effort uses the selected model's registry default.
Unknown models report closest matches, unsupported efforts report the valid levels, and ambiguous cross-agent ids require an interactive choice or `--agent`.
Global keys are `dispatch.agent`, `dispatch.model`, `dispatch.effort`, `mate.agent`, `mate.model`, and `mate.effort`.
Setting those dotted global keys remains supported for compatibility and prints a deprecation notice recommending the atomic role command.
Agent values are `claude` or `codex`.

### Configuration layers

`perch config` is a view of global Mate and dispatch defaults only.
It never presents project registry or bundled-runtime state.

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

New task kinds are explicit:

```sh
perch autoreview run --task <task-id> --idempotency-key <key> --test-argv-json '["npm","test"]'
perch delivery create-pr --task <task-id> --idempotency-key <key>
```

`--test-argv-json` must name a supported test launcher, such as `npm test` or `node --test`.

Perch rejects shells and arbitrary executables, executes the test in a stripped environment, and stores only redacted argv shape plus a hash in the receipt.

Only a `ship` task may use those operations.
The first creates a durable exact-tree AutoReview receipt, and the second creates the server-owned PR only after it validates that receipt.
`scout` and `operate` tasks instead complete with accepted report evidence.

Effective output includes `effectiveValue`, `source`, `scope`, `storedValue`, `defaultValue`, and `overriddenBy` for every key.
Configuration listings warn about a saved agent and model tuple that the current registry cannot validate.
Warnings never rewrite saved configuration.
Text and JSON redact secret-shaped keys identically.
Environment overrides have higher precedence than stored global launch defaults.
The AutoReview bundle provenance is recorded in each receipt and in `apps/server/assets/autoreview/manifest.json` for source installations.
It is package-owned and never resolves worker skills from user-global directories.

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
perch pair [--title <device-name>]
perch devices [ls|revoke <id>]
perch server [status|start|stop|logs]
perch doctor [--json] [--fix [--yes]]
perch worktrees
perch worktrees release <id> [--force]
```

`doctor` checks the local provider and GitHub prerequisites.
The bundled AutoReview helper is verified by package smoke tests and durable receipt provenance.
Provider installation and sign-in remain separate user actions.

## Complete command index

`perch --help` prints the canonical, complete command list, and `perch <command> --help` prints each command's usage.
The sections above cover the same commands with their behavior notes.

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
