import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Claude Code's startup folder-trust dialog renders before any hooks load, so
// a dispatched worker in a fresh pool worktree stalls on a prompt the durable
// interaction bridge cannot carry to a device. Claude Code records the answer
// per directory in its state file under projects.<absolute path>, and writes
// exactly this entry itself for worktrees it creates from a trusted repo.
// Perch mirrors that seeding for pool worktrees it creates from a registered
// project - registration is the human trust decision the entry inherits.

// Claude Code keeps its state file at $CLAUDE_CONFIG_DIR/.claude.json when the
// override is set (the PTY adapter passes it through as user intent), else
// ~/.claude.json.
export function claudeStateFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json");
}

// The entry Claude Code itself seeds for a worktree spawned from a trusted
// repo. hasTrustDialogAccepted answers the dialog; the rest matches Claude's
// own seed so the entry is indistinguishable from a native one.
const SEEDED_PROJECT_ENTRY = {
  allowedTools: [],
  mcpContextUris: [],
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: true,
  projectOnboardingSeenCount: 0,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false
};

// Claude keys project entries by the process's fully resolved cwd, so the
// seeded key must match what getcwd() reports inside the spawned PTY.
function canonicalWorktreePath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Read-modify-write of Claude's state file: preserve every unknown field,
// tolerate the file or the projects key being absent, and refuse to touch a
// file that does not parse - a running Claude owns it, and corrupting it
// breaks every session. The tmp+rename write is atomic, so a concurrent
// Claude rewrite loses one update at worst; it never sees a torn file.
export function seedClaudeWorktreeTrust(stateFile: string, worktreePath: string): boolean {
  const path = canonicalWorktreePath(worktreePath);
  let state: Record<string, unknown> = {};
  try {
    const parsed = asRecord(JSON.parse(readFileSync(stateFile, "utf8")));
    if (!parsed) {
      console.warn(`claude trust: ${stateFile} is not a JSON object; skipped seeding ${path}`);
      return false;
    }
    state = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`claude trust: cannot parse ${stateFile}; skipped seeding ${path}: ${message}`);
      return false;
    }
  }

  const projects = asRecord(state.projects ?? {});
  if (!projects) {
    console.warn(`claude trust: ${stateFile} has a non-object projects key; skipped seeding ${path}`);
    return false;
  }
  const existing = asRecord(projects[path]);
  if (existing?.hasTrustDialogAccepted === true) {
    return true;
  }
  projects[path] = existing ? { ...existing, hasTrustDialogAccepted: true } : { ...SEEDED_PROJECT_ENTRY };
  state.projects = projects;

  try {
    const tmp = `${stateFile}.perch-tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, stateFile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`claude trust: failed writing ${stateFile}; ${path} stays unseeded: ${message}`);
    return false;
  }
  console.log(`claude trust seeded for ${path}`);
  return true;
}
