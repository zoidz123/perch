/**
 * Relay service entry point.
 *
 * Configuration is a handful of env vars (optimization 3: one opinionated
 * stateless relay, no config matrix):
 * - PORT                        port to listen on (default 8080)
 * - HOST                        interface to bind (default 0.0.0.0)
 * - RELAY_TLS_CERT              path to a TLS certificate (PEM); enables wss:// directly
 * - RELAY_TLS_KEY               path to the matching private key (PEM)
 * - RELAY_TRUST_PROXY           1/true: take client IPs from X-Forwarded-For
 *                               (set behind Railway/Caddy so per-IP limits work)
 * - RELAY_MAX_PAYLOAD_BYTES     max WS message size (default 1 MiB)
 * - RELAY_MAX_CONNS_PER_IP      concurrent sockets per IP (default 32)
 * - RELAY_CONNS_PER_IP_PER_MIN  new connections per IP per minute (default 60)
 * - RELAY_ROOMS_PER_IP_PER_MIN  new rooms per IP per minute (default 60)
 * - RELAY_MAX_ROOMS             live-room cap (default 4096)
 * - RELAY_MAX_SOCKETS_PER_ROOM  per-room socket cap (default 128)
 *
 * Omit the TLS vars to run plain ws:// behind a TLS-terminating reverse proxy.
 * Either way the relay only ever forwards opaque frames.
 */

import { readFileSync } from "node:fs";
import { startRelayServer } from "./server.js";

/** A positive integer from the env, or undefined (fall back to the built-in default). */
function intEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

async function main(): Promise<void> {
  const port = process.env.PORT ? Number(process.env.PORT) : 8080;
  const host = process.env.HOST ?? "0.0.0.0";

  const certPath = process.env.RELAY_TLS_CERT;
  const keyPath = process.env.RELAY_TLS_KEY;
  const tls =
    certPath && keyPath
      ? { cert: readFileSync(certPath), key: readFileSync(keyPath) }
      : undefined;

  const server = await startRelayServer({
    port,
    host,
    tls,
    trustProxy: ["1", "true", "yes"].includes((process.env.RELAY_TRUST_PROXY ?? "").toLowerCase()),
    maxPayloadBytes: intEnv("RELAY_MAX_PAYLOAD_BYTES"),
    maxConnectionsPerIp: intEnv("RELAY_MAX_CONNS_PER_IP"),
    connectionsPerIpPerMinute: intEnv("RELAY_CONNS_PER_IP_PER_MIN"),
    roomsPerIpPerMinute: intEnv("RELAY_ROOMS_PER_IP_PER_MIN"),
    maxRooms: intEnv("RELAY_MAX_ROOMS"),
    maxSocketsPerRoom: intEnv("RELAY_MAX_SOCKETS_PER_ROOM"),
  });
  const scheme = tls ? "wss" : "ws";
  console.log(`[relay] listening on ${scheme}://${host}:${server.port} (stateless, content-blind)`);

  const shutdown = (signal: string): void => {
    console.log(`[relay] ${signal} received, shutting down`);
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[relay] failed to start:", err);
  process.exit(1);
});
