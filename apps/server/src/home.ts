import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// Single source of truth for the perch home directory and the files inside
// it. The CLI (bin/perch.mjs) mirrors these paths; keep them in sync.
export function perchHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.PERCH_HOME ?? join(homedir(), ".perch");
}

export function tokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(perchHome(env), "token");
}

// The long-term NaCl box keypair, derived on first boot and reused forever so
// re-pairing and reconnects share one trust anchor. bin/perch.mjs mirrors this
// path like the others.
export function keyPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(perchHome(env), "box-keypair.json");
}

export function pidPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(perchHome(env), "perch.pid");
}

export function logPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(perchHome(env), "server.log");
}

export function ensurePerchHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = perchHome(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

// Reads the persisted server token, creating one on first run. The token file
// is the shared secret between the server and every local client; 0600 so
// only the user can read it.
export function readOrCreateToken(env: NodeJS.ProcessEnv = process.env): string {
  ensurePerchHome(env);
  const path = tokenPath(env);

  if (existsSync(path)) {
    const token = readFileSync(path, "utf8").trim();
    if (token.length > 0) {
      return token;
    }
  }

  const token = randomBytes(32).toString("hex");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

export function writePidFile(env: NodeJS.ProcessEnv = process.env): void {
  ensurePerchHome(env);
  writeFileSync(pidPath(env), `${process.pid}\n`, { mode: 0o600 });
}

export function removePidFile(env: NodeJS.ProcessEnv = process.env): void {
  try {
    const path = pidPath(env);
    if (existsSync(path)) {
      const recorded = Number(readFileSync(path, "utf8").trim());
      if (recorded === process.pid) {
        rmSync(path);
      }
    }
  } catch {
    // Best effort; a stale pidfile is handled by readers checking liveness.
  }
}

// Uploaded images land in a scratch dir under $PERCH_HOME, never in the repo
// or worktree, so they never show up as untracked files in the agent's cwd.
export function attachmentsDir(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(perchHome(env), "attachments", sessionId);
}

export function removeAttachments(sessionId: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    rmSync(attachmentsDir(sessionId, env), { recursive: true, force: true });
  } catch {
    // Best effort: a leftover attachments dir is harmless.
  }
}
