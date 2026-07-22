import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { perchHome } from "./home.js";

export const CODEX_MATE_BOOTSTRAP_PROMPT =
  "Initialize this Perch mate session. Do not use tools or perform project work. Reply with exactly: Ready.";

// ~/.perch/mate: the mate's own home - neutral by design, never a project
// directory (the mate reads projects anywhere; it lives nowhere near them).
// The spec (AGENTS.md) is perch-managed and refreshed on every launch so mate
// improvements ship with perch itself; anything the mate keeps (notes.md) is
// never touched. The server is the only seeder; the CLI goes through
// POST /mate/start.
export function seedMateHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = join(perchHome(env), "mate");
  mkdirSync(home, { recursive: true });
  const spec = readFileSync(fileURLToPath(new URL("../assets/mate/AGENTS.md", import.meta.url)), "utf8");
  writeFileSync(join(home, "AGENTS.md"), spec);
  const claudeMd = join(home, "CLAUDE.md");
  if (!existsSync(claudeMd)) {
    symlinkSync("AGENTS.md", claudeMd);
  }
  return home;
}
