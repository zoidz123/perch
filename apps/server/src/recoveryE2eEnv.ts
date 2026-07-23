import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function recoveryE2eEnv(
  home: string,
  inherited: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const claudeConfigDir = join(home, "provider-config", "claude");
  const codexHome = join(home, "provider-config", "codex");
  mkdirSync(claudeConfigDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  // The real Codex E2Es still need the user's login, but no mutable provider
  // config may escape the sandbox. Copy only the credential file; hooks,
  // trust, sessions, and every write stay under the temporary CODEX_HOME.
  const sourceCodexHome = inherited.CODEX_HOME ?? join(homedir(), ".codex");
  const sourceAuth = join(sourceCodexHome, "auth.json");
  const sandboxAuth = join(codexHome, "auth.json");
  if (existsSync(sourceAuth) && !existsSync(sandboxAuth)) {
    copyFileSync(sourceAuth, sandboxAuth);
    chmodSync(sandboxAuth, 0o600);
  }
  return {
    ...inherited,
    PERCH_HOME: home,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    CODEX_HOME: codexHome
  };
}
