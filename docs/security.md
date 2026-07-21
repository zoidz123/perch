# Perch security

Perch keeps execution and durable state on the user's Mac.
This document describes what pairing authorizes, how local and remote connections differ, and which actions fail closed.

## Trust boundary

The Mac stores repositories, provider credentials, provider processes, PTYs, task records, worktrees, attachments, charts, device records, and audit logs.
The iPhone is an authenticated control surface for that local server.

Perch does not provide a hosted user account or hosted code-execution environment.
The optional hosted relay is stateless and content-blind: it carries encrypted application frames between paired devices but does not hold the content keys.
It still observes routing and connection metadata.

## Pairing

`perch pair` creates a device record with a revocable token and prints a QR code plus a `perch://pair#offer=...` URL.
The offer contains the server identity, endpoint list, device token, and Mac public key.

Treat an unused pairing offer as a live credential:

- Do not paste it into issues, logs, screenshots, or chat.
- Pair only on devices you control.
- Revoke a lost or retired device with `perch devices revoke <id>`.

Each device has its own token.
Revoking one device does not rotate every other paired device.

## Local network connections

The server listens on Mac network interfaces so the phone can connect directly on a LAN.
Local HTTP and WebSocket requests require a bearer token, but that direct transport is not encrypted.

Use direct mode only on a trusted network.
Never port-forward or publicly expose the Perch server port.

The CLI defaults to `http://127.0.0.1:8787` for local control.
The phone receives reachable LAN endpoints through the pairing offer.

## Encrypted relay connections

When a relay is configured, the Mac and phone each open outbound connections.
The paired endpoints perform an encrypted channel handshake, and application messages are encrypted end to end between the phone and Mac.

The relay routes rooms and connection IDs and forwards opaque frames.
It cannot read application content or device tokens sent inside the encrypted channel.
It can observe metadata such as IP addresses, server identity, timing, connection duration, and traffic volume.

The hosted relay is the default when `PERCH_RELAY_URL` is unset.
Set `PERCH_RELAY_URL=off` before starting the server for LAN-only operation, or point it at a relay you control.

## Provider credentials

Perch launches the installed Claude Code or Codex CLI and inherits its existing authentication.
Perch does not ask for provider API keys or proxy provider sign-in.

Provider configuration remains subject to the provider CLI's own storage and security model.
Do not copy provider configuration into `$PERCH_HOME` or bug reports.

## Remote actions and approvals

Phone actions use the same authenticated control surface whether they arrive directly or through the encrypted relay.
Perch makes a best-effort append to the Mac-local audit log for each mutating action.
An audit append failure is reported to server logs but does not reverse or fail an otherwise successful mutation.

Remote approval is state-bound:

- Claude PermissionRequest, AskUserQuestion, ExitPlanMode, and MCP elicitation use versioned structured requests with exact request identity and compare-and-set responses.
- PermissionRequest is the sole permission authority.
  Perch correlates it to a matching PreToolUse tool-use ID when available, otherwise it records a nonce, runtime generation, and durable occurrence number.
- Hook credentials survive a server restart in a mode-0600 local file and stale session credentials are pruned.
- The Claude inbox API returns a redacted full snapshot plus ordered durable deltas.
- Always-allow suggestions stay ephemeral unless the boss selects the exact validated suggestion, at which point only that selected rule is persisted and returned to Claude.
- Claude PermissionDenied is visible failure evidence, not an approval request.
- Claude startup, authentication, and directory-trust prompts happen before hooks are available.
  Perch surfaces those detected PTY gates as desktop-only manual actions and never treats a keystroke or notification as proof of remote approval.
- Codex approvals use the structured app-server request and are answered by exact JSON-RPC request ID.
  Several requests can be open at once; each stays answerable only until that exact ID resolves.
- Codex attention without an authoritative structured request remains desktop-only.
- Stale, missing, changed, or ambiguous prompts return a conflict instead of sending guessed input.

Composer text queues while a permission prompt is open.
An attention notification alone is not treated as an approval gate.

## Recovery safety

Recovery is limited to managed workers and Mate when Perch persisted a verified provider conversation identity.
Perch separates task state from runtime state, so losing a process does not rewrite the meaning of the task.

Before launching a replacement, Perch proves the old process is gone.
Crash orphans are reaped only when the persisted process birth marker and provider executable match.
The replacement conversation identity and live PTY are verified before the next runtime generation is committed.

Solo provider sessions and arbitrary `perch run` commands do not receive managed task recovery.

## Managed no-mistakes boundary

Perch-managed no-mistakes uses only the signed runtime inside the installed package.
The runtime is selected by host architecture and verified against the pinned SHA-256 manifest before use.
PATH binaries, absolute alternate paths, repository setup, skill visibility, and prompts are not authorization.

The runtime requests one-use authorization before run creation, gate push acceptance, and every external-agent launch.
The verifier binds each decision to protocol, operation, durable task, live runtime generation and session, canonical project, credential-free repository identity, worktree, branch, and durable mode.
Protocol mismatch, replay, stale context, missing verifier, timeout, malformed response, and any scope mismatch fail closed.

Authorization evidence is append-only and secret-free.
Hook tokens remain in request headers and transient local IPC only, and are removed from external-agent child environments.
See [No-mistakes authorization](no-mistakes-authorization.md) for the exact contract.

## Local secrets and records

Sensitive `$PERCH_HOME` files include:

- `token`, the local server bearer token.
- `devices.json`, paired-device tokens and state.
- `box-keypair.json`, the relay channel keypair.
- `server.json`, the persistent server identity.
- `apns.json`, optional push credentials.

File modes protect locally created secret files where supported, but the Mac account remains inside the trust boundary.
Protect the user account, disk, backups, and shell environment accordingly.

Successful audit appends record metadata about mutating mobile actions, not provider transcript contents.
Provider transcripts, Codex rollouts, attachments, and charts can still contain sensitive project material and should be protected as local project data.

## Push notifications

Push is optional and disabled when APNs is not configured.
Self-managed push configuration requires Apple signing material and device tokens.
Do not commit `.p8`, `.p12`, certificate, provisioning, or APNs configuration files.

## Reporting and pre-public checks

Do not disclose pairing offers, access tokens, provider credentials, signing material, private repository content, or unredacted vulnerability details in a public issue.

Repository checks and normal test suites are not a dedicated secret scan.
A separate pre-public secret scan remains a required release gate before creating any clean public seed or changing repository visibility.
