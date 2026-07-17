import { join } from "node:path";
import { perchHome, readOrCreateToken } from "./home.js";

// The default hosted relay. It is stateless and content-blind: application
// traffic is E2E encrypted and the relay forwards opaque ciphertext while
// observing connection and routing metadata. The shared public default gives
// every server off-LAN reach out of the box. This endpoint is not a secret.
// Users can point at their own relay with `PERCH_RELAY_URL=wss://my-own`, or opt
// out entirely with `PERCH_RELAY_URL=off` (also `none`, `0`, or empty).
// See resolveRelayUrl.
export const DEFAULT_RELAY_URL = "wss://perchserver-production.up.railway.app";

// Values that explicitly disable the relay (LAN-only opt-out). Compared
// case-insensitively after trimming.
const RELAY_OFF_VALUES = new Set(["", "off", "none", "0"]);

// Resolve the relay origin with this precedence:
//   - PERCH_RELAY_URL set to a non-empty ws:// or wss:// URL -> use it.
//   - PERCH_RELAY_URL set to "", "off", "none", or "0"       -> disabled.
//   - PERCH_RELAY_URL unset                                  -> DEFAULT_RELAY_URL.
// Returns undefined when the relay is disabled: the server never dials and the
// pairing offer advertises no relay endpoint (matching pre-default behavior).
export function resolveRelayUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.PERCH_RELAY_URL;
  if (raw === undefined) {
    return DEFAULT_RELAY_URL;
  }
  const trimmed = raw.trim();
  if (RELAY_OFF_VALUES.has(trimmed.toLowerCase())) {
    return undefined;
  }
  return trimmed;
}

export type ServerConfig = {
  port: number;
  authToken: string;
  auditLogPath: string;
  reconcileMs: number;
  // Reliability hardening knobs (G1/G3): the status reconciliation sweep
  // cadence + staleness threshold and per-kind silence watchdog thresholds.
  statusSweepMs: number;
  statusStaleMs: number;
  stallScoutMs: number;
  stallShipMs: number;
  // A working task that never received a worker/hook signal and whose live
  // session has been idle since launch is dead on arrival (e.g. a provider
  // usage limit the terminal detector did not recognize). This is the short
  // grace before that is surfaced, far below the mid-work silence thresholds.
  launchStallMs: number;
  // The mate's window to relay a crew needs_decision/blocked before the raw
  // event pushes directly (the escalation fallback).
  escalationFallbackMs: number;
  // Resolved relay origin for off-LAN reach (see resolveRelayUrl). Defaults to
  // the hosted content-blind relay; undefined means LAN-only (opt-out): the
  // server never dials a relay and the offer advertises no relay endpoint.
  relayUrl?: string;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  // PERCH_TOKEN wins for tests and ad-hoc runs; otherwise the persisted token
  // in $PERCH_HOME/token is the shared secret, created on first boot.
  const authToken = env.PERCH_TOKEN ?? readOrCreateToken(env);

  return {
    port: Number(env.PORT ?? 8787),
    authToken,
    auditLogPath: env.PERCH_AUDIT_LOG ?? join(perchHome(env), "audit.jsonl"),
    // Slow safety-net resync. The monitor is event-driven; this only recovers
    // from missed events or resume gaps, so it is deliberately infrequent.
    reconcileMs: Number(env.PERCH_RECONCILE_MS ?? 30000),
    statusSweepMs: Number(env.PERCH_STATUS_SWEEP_MS ?? 60_000),
    statusStaleMs: Number(env.PERCH_STATUS_STALE_MS ?? 120_000),
    stallScoutMs: Number(env.PERCH_STALL_SCOUT_MS ?? 15 * 60_000),
    stallShipMs: Number(env.PERCH_STALL_SHIP_MS ?? 45 * 60_000),
    launchStallMs: Number(env.PERCH_LAUNCH_STALL_MS ?? 3 * 60_000),
    escalationFallbackMs: Number(env.PERCH_ESCALATION_FALLBACK_MS ?? 3 * 60_000),
    relayUrl: resolveRelayUrl(env)
  };
}
