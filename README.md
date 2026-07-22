# Perch

**One orchestrator for your entire coding fleet.**

Coordinating several coding agents makes you divide work, schedule workers, track progress, manage dependencies, and chase failures across terminals. You become the bottleneck.

Perch gives that job to one orchestrator, called Mate. Mate organizes real Claude Code and Codex workers on your Mac, dispatches them into isolated worktrees, tracks progress, and brings decisions back to you.

Perch keeps this delegation durable with explicit task lifecycles, immutable evidence, provider-aware recovery, and remote monitoring and control from iPhone.

**Get Perch:** [iPhone beta](https://testflight.apple.com/join/m2ApgjJF) · [npm package](https://www.npmjs.com/package/perchctl)

```
npm install --global perchctl
```

The `perchctl` package installs the `perch` command and its compatible signed no-mistakes runtime for Darwin arm64 and x64.
Installation performs no lifecycle download and works with `npm --ignore-scripts`.

## Getting started

You need macOS, Node.js 20 or newer, npm 10 or newer, and an installed [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex](https://github.com/openai/codex) CLI. Sign in through the provider's own CLI first; Perch reuses that authentication.

1. Install the CLI and the [iPhone beta](https://testflight.apple.com/join/m2ApgjJF), then check your local tools.

   ```
   npm install --global perchctl
   perch doctor
   ```

2. Pair the phone.

   ```
   perch pair
   ```

   Scan the QR code in the app. An unused pairing offer is a live credential, so do not save or share it.

3. Start Mate.

   ```
   perch mate
   ```

   Ask Mate to ship code, or ask it to explore and report back without changing a project. Mate uses Claude by default; choose Codex with `perch mate codex`.

For one provider session without Mate orchestration, run `perch claude` or `perch codex` from a project directory. See [Operations](docs/operations.md) for authentication, optional project registration, configuration, recovery, updates, pairing, and relay details.

## How Perch works

A local background server launches Claude Code under server-owned PTYs and Codex through app-server daemons while preserving each provider's native desktop interface.
SQLite records every task change and the state of each worker.
The Task API carries structured updates between Mate and workers, and a worker's completion request becomes done only after Mate verifies and accepts it.
Every task has an explicit owner, which makes coordination more predictable even though agent execution is not deterministic.

The server starts Mate in a dedicated home and dispatches project work to workers. A pool leases each parallel task an isolated Git worktree and returns it only after the report is delivered or the code is safely landed. This reduces overlapping edits and keeps the orchestrator coordinating instead of becoming another uncontrolled coding worker.

On a trusted LAN, the iPhone connects directly to the authenticated Mac server; off-LAN, the phone and Mac connect outbound through a stateless, content-blind relay with end-to-end encrypted application content, although the relay can observe connection metadata. See [Architecture](docs/architecture.md) and [Security](docs/security.md) for the exact system and trust boundaries.

## Command map

| Goal | Commands |
| --- | --- |
| Orchestrate | `perch mate`, `perch project`, `perch config` |
| Run one provider | `perch claude`, `perch codex` |
| Control and pair | `perch ls`, `perch attach`, `perch stop`, `perch pair`, `perch devices` |
| Operate and recover | `perch doctor`, `perch server`, `perch worktrees`, `perch recover task` |

See the [complete CLI guide](docs/cli.md) for verified arguments, options, defaults, and behavior.

## Docs

- [CLI](docs/cli.md)
- [Operations](docs/operations.md)
- [Architecture](docs/architecture.md)
- [Worker task API and turn lifecycle](docs/worker-task-api.md)
- [Security](docs/security.md)
- [No-mistakes authorization](docs/no-mistakes-authorization.md)
- [Release and version synchronization](docs/releasing.md)

Perch is available under the [MIT License](LICENSE).
