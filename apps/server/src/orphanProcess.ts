import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export type PersistedProcessIdentity = {
  processId?: number;
  processStartedAt?: string;
  provider?: string;
};

// A server crash can leave the PTY child alive after its master disappears.
// Reap only when both durable birth time and provider executable still match;
// a recycled PID or unrelated process is never signaled.
export function terminateMatchingOrphan(identity: PersistedProcessIdentity): boolean {
  if (!identity.processId || !identity.processStartedAt || !identity.provider) return false;
  let output: string;
  try {
    output = execFileSync(
      "ps",
      ["-o", "lstart=", "-o", "command=", "-p", String(identity.processId)],
      { encoding: "utf8", timeout: 2_000 }
    ).trim();
  } catch {
    return false;
  }
  if (!matchesPersistedProcess(identity, output)) return false;
  try {
    process.kill(identity.processId, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

export function matchesPersistedProcess(identity: PersistedProcessIdentity, psOutput: string): boolean {
  if (!identity.processStartedAt || !identity.provider) return false;
  const match = psOutput.match(/^(.{24})\s+(.+)$/s);
  if (!match) return false;
  const startedAt = Date.parse(match[1]!);
  const persistedAt = Date.parse(identity.processStartedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(persistedAt)) return false;
  // `ps lstart` has one-second precision while the persisted spawn stamp has
  // milliseconds and is written immediately after spawn.
  if (Math.abs(startedAt - persistedAt) > 5_000) return false;
  const executable = basename(match[2]!.trim().split(/\s+/, 1)[0] ?? "").toLowerCase();
  const provider = identity.provider.toLowerCase();
  return executable === provider || executable.startsWith(`${provider}-`);
}
