#!/usr/bin/env node
/**
 * Off-LAN relay recovery check (WAN Phase 2, Task 2.4).
 *
 * Simulates the phone's FIRST reach into a room and asserts the perch SERVER is
 * registered on the other side: it dials the relay as a `role=client` socket,
 * sends the plaintext `e2ee_hello` handshake frame, and waits for the server's
 * `e2ee_ready` reply. That reply can only come from a live server data socket in
 * the room - so a PASS means the server holds the room, a timeout (FAIL) means
 * dead air (the exact off-LAN outage this guards against).
 *
 * Use it to verify the control-socket staleness fix end-to-end against the REAL
 * hosted relay, WITHOUT restarting the perch server:
 *
 *   1. Baseline:  node scripts/relay-recovery-check.mjs --server <serverId>
 *                 -> PASS (the server is registered).
 *   2. Kill / redeploy the relay (Railway redeploy, or `docker compose restart
 *      relay`), which wipes its in-memory rooms.
 *   3. Recovery:  node scripts/relay-recovery-check.mjs --server <serverId> --loop
 *                 -> flips back to PASS within seconds as the server's control
 *                    socket detects app-level staleness, reconnects, and
 *                    re-registers the room. No `perch server` restart needed.
 *
 * The <serverId> is the room key from the pairing offer / `perch server logs`
 * (the `serverId` field). No device token or server key is needed: `e2ee_ready`
 * comes back before auth, so this probe is a pure liveness check and never
 * attaches as a real client.
 */

import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";

const DEFAULT_RELAY_URL = "wss://perchserver-production.up.railway.app";

function parseArgs(argv) {
  const args = { url: DEFAULT_RELAY_URL, server: "", timeoutMs: 8000, loop: false, intervalMs: 3000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--url") args.url = argv[++i];
    else if (arg === "--server") args.server = argv[++i];
    else if (arg === "--timeout") args.timeoutMs = Number(argv[++i]);
    else if (arg === "--interval") args.intervalMs = Number(argv[++i]);
    else if (arg === "--loop") args.loop = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

/** Turn a ws(s)/http(s) relay origin into the phone's `role=client` WS URL. */
function clientUrl(origin, serverId) {
  const m = origin.trim().match(/^(https?|wss?):\/\/(.+)$/i);
  if (!m) throw new Error(`invalid relay url: ${origin}`);
  const secure = m[1].toLowerCase() === "https" || m[1].toLowerCase() === "wss";
  const host = m[2].replace(/\/+$/, "");
  const query = new URLSearchParams({ serverId, role: "client", v: "2" }).toString();
  return `${secure ? "wss" : "ws"}://${host}/ws?${query}`;
}

/** One probe: dial as a phone, send e2ee_hello, resolve on e2ee_ready. */
function probe(url, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      resolve({ ...result, ms: Date.now() - started });
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout waiting for e2ee_ready" }), timeoutMs);
    timer.unref?.();

    ws.on("open", () => {
      // A fresh ephemeral public key; any valid 32-byte curve point-shaped blob
      // is accepted for the hello (the server only validates length/decoding).
      const key = randomBytes(32).toString("base64");
      ws.send(JSON.stringify({ type: "e2ee_hello", key }));
    });
    ws.on("message", (raw) => {
      if (raw.toString().includes("e2ee_ready")) finish({ ok: true });
    });
    ws.on("error", (err) => finish({ ok: false, reason: `socket error: ${err?.message ?? err}` }));
    ws.on("close", () => finish({ ok: false, reason: "closed before e2ee_ready" }));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.server) {
    console.log(
      "Usage: node scripts/relay-recovery-check.mjs --server <serverId> [--url <wss://relay>] [--timeout <ms>] [--loop] [--interval <ms>]"
    );
    process.exit(args.server ? 0 : 2);
  }

  const url = clientUrl(args.url, args.server);
  const runOnce = async () => {
    const result = await probe(url, args.timeoutMs);
    const stamp = new Date().toISOString();
    if (result.ok) {
      console.log(`${stamp}  PASS  server registered - e2ee_ready in ${result.ms}ms  (${args.url} / ${args.server})`);
    } else {
      console.log(`${stamp}  FAIL  ${result.reason} after ${result.ms}ms  (${args.url} / ${args.server})`);
    }
    return result.ok;
  };

  if (!args.loop) {
    const ok = await runOnce();
    process.exit(ok ? 0 : 1);
  }

  console.log(`Looping every ${args.intervalMs}ms; Ctrl+C to stop.`);
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    await runOnce();
    await new Promise((r) => setTimeout(r, args.intervalMs));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
