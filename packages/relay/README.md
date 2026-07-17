# @perch/relay

A standalone, stateless, content-blind WebSocket relay.
It lets a paired phone reach its home perch server off-LAN (cellular, foreign Wi-Fi) with no VPN, no port-forward, and no new user step.
Both the phone and the server dial the relay outbound, so NAT traversal is solved by construction: the Mac is never a listener the phone must reach.

This package is the relay that the current Perch server and iPhone client use for off-LAN fallback.
It is deliberately isolated from application crypto and shared message types, and it treats every data frame as opaque bytes.
End-to-end encryption terminates only on the phone and Mac.
The relay depends on IP, server identity, room and connection routing, timing, and opaque payload boundaries, never application plaintext.
It can observe those values plus connection duration and traffic volume.

## What it does

- Terminates `wss://` (or `ws://` behind a TLS-terminating proxy) WebSocket connections.
- Authenticates each **socket** only by its room (`serverId`) and role.
- Pairs the server's sockets with the phone's sockets in that room and forwards opaque frames between them.
- Holds **no database and no durable state**.
  On restart every socket drops and both sides reconnect and re-form their rooms.

What it deliberately does **not** do: read, decode, parse, or persist any data frame; hold any key; run any account/billing/discovery system.
It is a dumb byte router keyed by `serverId`.

## Topology

Each room (`serverId`) contains three kinds of socket:

| Socket | Query | Cardinality | Purpose |
| --- | --- | --- | --- |
| control | `role=server` (no `connectionId`) | one per room | the server's coordination socket; learns which phone connections exist |
| data | `role=server&connectionId=X` | one per `connectionId` | the server's encrypted channel for one phone connection |
| client | `role=client&connectionId=X` | one+ per `connectionId` | the phone |

Each phone connection maps 1:1 to a data socket, so each maps 1:1 to a `FleetMonitor` client on the server with its own E2E channel and its own device token.
A client that omits `connectionId` is assigned one by the relay.

## Wire protocol

Connect to `/ws` with query params:

```
wss://<relay-host>/ws?serverId=<room>&role=server|client[&connectionId=<id>]
```

- Missing/invalid `role` or missing `serverId` is rejected with HTTP `400` during the upgrade.
- `GET /health` returns `200 {"status":"ok"}`.

### Data plane (opaque)

Frames between a client socket and its matching data socket are forwarded **verbatim** and are never inspected.
Text frames stay text, and binary frames stay binary.
The relay works on arbitrary bytes.

If a client sends frames before its data socket has attached, the relay buffers them (bounded, most-recent 200 frames and 1 MiB per connection) and flushes them in order when the data socket attaches.

### Abuse limits

Basic single-process protections, enforced before the WS handshake completes:

- A single WebSocket message is capped at 1 MiB (`RELAY_MAX_PAYLOAD_BYTES`); an offender is closed with `1009` (Message Too Big).
- Per client IP: at most 32 concurrent sockets, 60 new connections per minute, and 60 new-room creations per minute in fixed one-minute windows.
  Over-limit upgrades are refused with HTTP `429` and one log line.
- Behind a reverse proxy (Railway, Caddy) set `RELAY_TRUST_PROXY=1` so the client IP comes from `X-Forwarded-For`; without it every client shares the proxy's IP and the per-IP limits bite everyone at once.

All limits are in-memory counters (this is a single-process service) and tunable via the env vars below.

### Control plane (routing metadata only)

The relay generates JSON notices **to the control socket** so the server can open a data socket per phone connection.
These carry connection IDs only, never application payloads:

- `{ "type": "sync", "connectionIds": [...] }` - sent when the control socket joins (current connections, so the server can re-open data sockets after a reconnect).
- `{ "type": "connected", "connectionId": "..." }` - a phone connected.
- `{ "type": "disconnected", "connectionId": "..." }` - a phone's last socket left.

### Close-code discipline

So each side knows whether to re-handshake:

- `1008` - a duplicate control or data socket replaced an existing one.
- `1001` - the last client for a connection left; its data socket is closed.
- `1012` - a data socket dropped; its client sockets are closed so they reconnect and re-handshake.

## Running

```
PORT=8080 HOST=0.0.0.0 npx perch-relay
```

Env vars (one opinionated stateless relay, no config matrix):

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | port to listen on |
| `HOST` | `0.0.0.0` | interface to bind |
| `RELAY_TLS_CERT` | - | path to a TLS certificate (PEM); enables `wss://` directly |
| `RELAY_TLS_KEY` | - | path to the matching private key (PEM) |
| `RELAY_TRUST_PROXY` | `0` | `1`/`true`: take client IPs from `X-Forwarded-For` (set behind Railway/Caddy) |
| `RELAY_MAX_PAYLOAD_BYTES` | `1048576` | max WebSocket message size; offenders are closed with `1009` |
| `RELAY_MAX_CONNS_PER_IP` | `32` | concurrent sockets per client IP |
| `RELAY_CONNS_PER_IP_PER_MIN` | `60` | new connections per IP per minute |
| `RELAY_ROOMS_PER_IP_PER_MIN` | `60` | new-room creations per IP per minute |
| `RELAY_MAX_ROOMS` | `4096` | live-room cap across the process |
| `RELAY_MAX_SOCKETS_PER_ROOM` | `128` | socket cap within one room |

Omit the TLS vars to run plain `ws://` behind a TLS-terminating reverse proxy.

## Deploying

A container image and a one-command TLS deployment live alongside this package:

- `Dockerfile` - minimal multi-stage build (`docker build -t perch-relay .`).
- `deploy/docker-compose.yml` - the relay behind Caddy with automatic Let's Encrypt, so the phone reaches it as `wss://`.
  Set a domain and email in `deploy/.env`, then run `docker compose up -d --build`.

Current deployment and off-LAN guidance is in [Perch operations](../../docs/operations.md#pairing-and-remote-access).
Point the home Perch server at a deployed relay with `PERCH_RELAY_URL=wss://relay.example.com`.

## Tests

```
npm test -w @perch/relay
```

Covers socket auth (right vs wrong room/role), fan-out both directions, room isolation (two rooms never cross), stateless reconnect after a relay restart, buffered-frame flush, and opaque-frame passthrough (the relay forwards arbitrary non-UTF-8 / non-JSON bytes unchanged, proving it never decodes a payload).
