# Deploying the Perch relay

This directory contains a TLS-terminating deployment for `@perch/relay`.
The relay sits behind Caddy, which obtains a Let's Encrypt certificate so phones connect over `wss://`.

## Raw VM with Docker Compose

On a VM with a public domain pointing at it, run:

```sh
cp .env.example .env
$EDITOR .env
docker compose up -d --build
```

Set `RELAY_DOMAIN` and `LETSENCRYPT_EMAIL` in `.env` before starting the stack.

Point the home Mac at the new relay and restart Perch:

```sh
export PERCH_RELAY_URL=wss://relay.example.com
perch server stop
perch server start
perch pair
```

Re-pairing gives the phone a fresh offer containing the new relay endpoint.

## Railway

Railway is the managed alternative to a raw VM.
Set the service root directory to `packages/relay`.
The adjacent `railway.json` selects the package Dockerfile, starts `node dist/cli.js`, and configures the `/health` check.
Railway supplies TLS and a public `*.up.railway.app` domain, so the Caddy and Compose files are not used there.

After deployment, configure the Mac:

```sh
export PERCH_RELAY_URL=wss://<name>.up.railway.app
perch server stop
perch server start
perch pair
```

## Files

| File | Purpose |
| --- | --- |
| `docker-compose.yml` | Relay and Caddy on one internal network |
| `Caddyfile` | TLS termination and WebSocket reverse proxy |
| `.env.example` | Domain and Let's Encrypt email template |
| `../Dockerfile` | Multi-stage relay image |
| `../railway.json` | Railway build, start, and health-check configuration |

## Verify

Check basic process readiness:

```sh
curl -fsS https://relay.example.com/health
```

The expected body is `{"status":"ok"}`.
This only proves that the relay process answers HTTP.

After the home server has registered its room, check that a client can reach the encrypted-channel handshake:

```sh
node scripts/relay-recovery-check.mjs --server <server-id> --url wss://relay.example.com
```

Run the probe from the repository root.
A successful probe does not prove pairing, device-token authentication, application RPC, background delivery, or a complete iPhone cellular flow.

See [Perch operations](../../../docs/operations.md#pairing-and-remote-access) and [the security model](../../../docs/security.md#encrypted-relay-connections) for the maintained operator guidance and trust boundaries.
