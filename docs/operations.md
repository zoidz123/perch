# Perch operations

This guide covers normal installation, configuration, local state, recovery, updates, and relay operation.
The [CLI guide](cli.md) is the complete user-facing command reference.

## Install and authenticate

Perch requires macOS, Node.js 20 or newer, and npm 10 or newer.
Install the pinned release:

```sh
npm install --global perchctl@0.1.9
```

Install at least one supported provider CLI, then complete its own sign-in flow:

```sh
claude
# or
codex
```

Perch reuses that provider authentication.
It does not collect or host provider credentials.

Run the environment check:

```sh
perch doctor
```

`doctor` checks whether provider binaries are installed, but it does not verify Claude Code or Codex sign-in.
It also reports GitHub CLI authentication because direct-PR task delivery and PR polling use `gh`.
The compatible no-mistakes runtime is already inside the npm package and needs no separate install, PATH entry, or lifecycle download.

## Uninstall

Stop the local server, remove Perch-managed agent configuration, and then remove the global npm package:

```sh
perch server stop
perch uninstall
npm rm --global perchctl
```

`perch uninstall --dry-run` prints the exact changes without writing them.
The command preserves user hooks and `~/.perch` state by default.
Use `perch uninstall --purge-data` to remove the local ledger, worktrees, pairing data, tokens, and charts too.
The command refuses to run while the server is live unless `--force` is supplied.

## Projects and task defaults

Mate dispatches work into registered projects.
Sessions register their own project automatically, or you can add one explicitly:

```sh
perch project add /path/to/project
perch project list
```

Optional project modes control how managed code tasks are delivered:

- `direct-PR` expects a pushed branch and pull request.
- `local-only` keeps delivery on the local task branch.
- `no-mistakes` uses the signed no-mistakes runtime bundled with Perch.

Task mode is also the authorization boundary for the expensive no-mistakes pipeline.
Only a durably persisted `no-mistakes` task may receive authorization.
`direct-PR` and `local-only` tasks remain denied regardless of prompt language, diff size, repository initialization, or an existing gate remote.
Perch cannot filter a globally installed Codex or Claude skill catalog per task, so mode-specific dispatch text is defense in depth rather than the security boundary.
The packaged runtime consumes the fail-closed verifier documented in [No-mistakes authorization](no-mistakes-authorization.md).

Set a mode when registering a project:

```sh
perch project add /path/to/project --mode direct-PR
```

Removing a project only changes the registry:

```sh
perch project remove /path/to/project
```

It does not delete the repository or its worktrees.

Fleet defaults are split between workers and Mate:

```sh
perch config show --effective
perch models
perch config set dispatch <model-id> --agent codex --effort high
perch config set mate <model-id> --agent claude
perch project set /path/to/project --mode no-mistakes --yolo --yes
```

The role commands set a complete global agent, model, and effort tuple atomically.
The server validates model and effort combinations against its current provider catalog.
An explicit task or launch agent, model, or effort value wins over the matching persisted default.
Environment variables win over persisted settings.
Use `perch project show` for delivery mode and yolo, and `perch runtime` for bundled-runtime provenance.

| Setting | Environment override |
| --- | --- |
| Worker agent | `PERCH_DEFAULT_AGENT` |
| Worker model | `PERCH_DEFAULT_MODEL` |
| Worker effort | `PERCH_DEFAULT_EFFORT` |
| Mate agent | `PERCH_MATE_AGENT` |
| Mate model | `PERCH_MATE_MODEL` |
| Mate effort | `PERCH_MATE_EFFORT` |

## Pairing and remote access

Create a device slot and pairing offer:

```sh
perch pair
```

Scan the QR code, paste the URL in the app, or open it as a `perch://` deep link.
The offer contains a live device token and the Mac's public trust key.
Treat it as a secret until it is used.

List and revoke devices with:

```sh
perch devices
perch devices revoke <device-id>
```

The pairing offer includes direct local endpoints first and the configured relay endpoint last.
The hosted relay is enabled when `PERCH_RELAY_URL` is unset.
Disable it before starting the server with:

```sh
export PERCH_RELAY_URL=off
perch server stop
perch server start
perch pair
```

Re-pair after changing relay configuration so the phone receives the new endpoint set.
To run a relay you control, set `PERCH_RELAY_URL` to its `wss://` origin.
Deployment instructions live in [`packages/relay/deploy/README.md`](../packages/relay/deploy/README.md).

## Server lifecycle

Commands that need the server start it automatically.
Explicit controls are:

```sh
perch server status
perch server logs
perch server stop
perch server start
```

The default server URL is `http://127.0.0.1:8787` from the CLI, while the server itself listens on all Mac interfaces for direct phone access.
Use `PERCH_SERVER_URL` to select another loopback port for development or isolated checks.
Never expose the server port directly to the public internet.

Stopping the server interrupts its owned PTYs.
Managed workers and Mate are recoverable only when Perch has persisted a verified provider conversation identity and can prove the old process is gone.
Solo sessions and arbitrary `perch run` commands do not have managed task recovery.

## Recovery and worktrees

Task state and runtime state are independent.
A worker process interruption records durable evidence without pretending that the task itself changed meaning.

When recovery is available, use:

```sh
perch recover task <task-id>
```

Re-running `perch mate` attaches to a live Mate or attempts provider-aware recovery of its persisted conversation and then reconciles recoverable child workers.
Use `perch mate --new` only when you intentionally want a fresh Mate conversation.

Inspect isolated task worktrees with:

```sh
perch worktrees
```

Ordinary release refuses live holders, dirty trees, and unlanded commits.
`--force` only overrides dirty or unlanded protection; it does not override a live session or active task lease.

## Local state

`$PERCH_HOME` defaults to `~/.perch`.
Important paths are:

| Path | Purpose |
| --- | --- |
| `token` | Local server bearer token |
| `perch.pid` | Detached server PID |
| `server.log` | Detached server log |
| `server.json` | Stable server identity and display name |
| `box-keypair.json` | Relay channel keypair |
| `devices.json` | Paired devices and revocable tokens |
| `settings.json` | Worker and Mate defaults |
| `projects.json` | Project registry and delivery modes |
| `state.sqlite` | Tasks, events, PR and completion-verification facts, runtimes, owners, operations, and notification outbox |
| `worktrees/` | Isolated git worktree pool |
| `mate/` | Mate home and managed instructions |
| `charts/` | Canonical registered charts |
| `attachments/` | Session attachment scratch space |
| `audit.jsonl` | Best-effort metadata-only mobile mutation audit; append failure does not fail the mutation |

Do not attach tokens, pairing offers, device records, keypairs, or provider configuration to bug reports.

## Updating

The pinned package for this source is `perchctl@0.1.9` and installs the `perch` executable plus both Darwin no-mistakes architectures.
Update to another explicit published version with npm, then restart the local server so it runs the new build:

```sh
npm install --global perchctl@<version>
perch server stop
perch server start
```

Finish or detach work intentionally before restarting.
An interrupted runtime is not automatically recoverable unless it meets the managed recovery requirements above.

## Source checks

Contributors can verify the compiled packages and focused test suites with:

```sh
npm install
npm run build
npm run typecheck
npm test -w @perch/server
npm test -w @perch/relay
npm run test:package
```

The iPhone app requires Xcode 26 with the iOS 26 SDK:

```sh
xcodebuild \
  -project apps/ios/Perch.xcodeproj \
  -scheme Perch \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  build
```

## TestFlight release

To upload a TestFlight build, Xcode must be signed in with an Apple ID that belongs to your Apple Developer team.
Set `PERCH_IOS_TEAM_ID` to your Apple Developer team ID and run the release pipeline from the repository root:

```sh
PERCH_IOS_TEAM_ID=<your-team-id> npm run ios:testflight
```

The pipeline archives with automatic signing and passes `DEVELOPMENT_TEAM` from `PERCH_IOS_TEAM_ID` because the Xcode project intentionally leaves its development team unset.
`-allowProvisioningUpdates` lets Xcode create or refresh the required signing assets using the signed-in Apple ID session.
The upload export options let App Store Connect manage the app version and build number automatically.

After upload, wait for App Store Connect to finish processing the build before it appears in TestFlight.
Answer the export-compliance prompt in App Store Connect when it appears.
