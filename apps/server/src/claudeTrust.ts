import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Claude Code's startup folder-trust dialog renders before any hooks load, so
// a dispatched worker in a fresh pool worktree stalls on a prompt the durable
// interaction bridge cannot carry to a device. Claude Code records the answer
// per directory in its state file under projects.<absolute path>.
//
// Claude Code 2.1.214's own headless startup error identifies
// hasTrustDialogAccepted: true as the supported state needed to pre-trust a
// workspace. Keep the seed minimal instead of copying unrelated internal
// onboarding fields whose shape can change between Claude releases.
const SEEDED_PROJECT_ENTRY = { hasTrustDialogAccepted: true };
const MAX_MERGE_ATTEMPTS = 5;

type FileVersion =
  | { exists: false }
  | {
      exists: true;
      dev: bigint;
      ino: bigint;
      size: bigint;
      mtimeNs: bigint;
      ctimeNs: bigint;
    };

/** Test-only interleaving and error seams for deterministic filesystem tests. */
export type ClaudeTrustTestHooks = {
  beforeReplace?: (attempt: number, target: string, temp: string) => void;
  afterVersionCheck?: (attempt: number, target: string, temp: string) => void;
  afterReplace?: (attempt: number, target: string) => void;
  fsync?: (fd: number) => void;
};

// Claude Code keeps its state file at $CLAUDE_CONFIG_DIR/.claude.json when the
// override is set (the PTY adapter passes it through as user intent), else
// ~/.claude.json.
export function claudeStateFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json");
}

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

function realStateFileTarget(stateFile: string): string {
  try {
    return realpathSync(stateFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return stateFile;
    throw error;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function fileVersion(path: string): FileVersion {
  try {
    const stat = statSync(path, { bigint: true });
    return {
      exists: true,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { exists: false };
    throw error;
  }
}

function sameFileVersion(left: FileVersion, right: FileVersion): boolean {
  if (!left.exists || !right.exists) return left.exists === right.exists;
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function parseState(stateFile: string, path: string, contents: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`claude trust: cannot parse ${stateFile}; skipped seeding ${path}: ${message}`);
    return undefined;
  }
  const state = asRecord(parsed);
  if (!state) {
    console.warn(`claude trust: ${stateFile} is not a JSON object; skipped seeding ${path}`);
    return undefined;
  }
  return state;
}

function removeTemp(temp: string | undefined): void {
  if (!temp) return;
  try {
    unlinkSync(temp);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}

// Claude does not cooperate with a Perch lock, so this is an optimistic merge:
// compare the file identity immediately before replacement, retry from newest
// bytes when it changed, and verify the trust entry after the atomic rename.
// Corrupt or structurally invalid state is always left untouched.
export function seedClaudeWorktreeTrust(
  stateFile: string,
  worktreePath: string,
  testHooks: ClaudeTrustTestHooks = {}
): boolean {
  const path = canonicalWorktreePath(worktreePath);
  let target: string;
  try {
    target = realStateFileTarget(stateFile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`claude trust: cannot resolve ${stateFile}; skipped seeding ${path}: ${message}`);
    return false;
  }

  for (let attempt = 1; attempt <= MAX_MERGE_ATTEMPTS; attempt += 1) {
    let temp: string | undefined;
    let fd: number | undefined;
    try {
      const beforeRead = fileVersion(target);
      let state: Record<string, unknown> = {};
      if (beforeRead.exists) {
        let contents: string;
        try {
          contents = readFileSync(target, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
          throw error;
        }
        const parsed = parseState(stateFile, path, contents);
        if (!parsed) return false;
        state = parsed;
      } else {
        try {
          readFileSync(target, "utf8");
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
        }
      }

      const projects = asRecord(state.projects ?? {});
      if (!projects) {
        console.warn(`claude trust: ${stateFile} has a non-object projects key; skipped seeding ${path}`);
        return false;
      }
      const existing = asRecord(projects[path]);
      if (existing?.hasTrustDialogAccepted === true) return true;
      if (existing?.hasTrustDialogAccepted === false) {
        console.warn(`claude trust: explicit trust decline for ${path} remains unchanged`);
        return false;
      }

      projects[path] = existing ? { ...existing, hasTrustDialogAccepted: true } : { ...SEEDED_PROJECT_ENTRY };
      state.projects = projects;

      temp = `${target}.perch-tmp-${process.pid}-${randomUUID()}`;
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(state, null, 2));
      (testHooks.fsync ?? fsyncSync)(fd);
      closeSync(fd);
      fd = undefined;

      testHooks.beforeReplace?.(attempt, target, temp);
      if (!sameFileVersion(beforeRead, fileVersion(target))) continue;
      testHooks.afterVersionCheck?.(attempt, target, temp);

      renameSync(temp, target);
      temp = undefined;
      testHooks.afterReplace?.(attempt, target);

      const verifiedState = parseState(stateFile, path, readFileSync(target, "utf8"));
      if (!verifiedState) return false;
      const verifiedProjects = asRecord(verifiedState.projects);
      const verifiedEntry = verifiedProjects ? asRecord(verifiedProjects[path]) : undefined;
      if (verifiedEntry?.hasTrustDialogAccepted === true) {
        console.log(`claude trust seeded for ${path}`);
        return true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`claude trust: failed writing ${stateFile}; ${path} stays unseeded: ${message}`);
      return false;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Preserve the original write error.
        }
      }
      try {
        removeTemp(temp);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`claude trust: failed cleaning temporary file for ${stateFile}: ${message}`);
      }
    }
  }

  console.warn(`claude trust: ${stateFile} kept changing; ${path} stays unseeded after ${MAX_MERGE_ATTEMPTS} attempts`);
  return false;
}
