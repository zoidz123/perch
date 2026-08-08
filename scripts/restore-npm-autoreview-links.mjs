#!/usr/bin/env node

import { lstatSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const link = join(root, "apps/server/assets/autoreview/skill/CLAUDE.md");
const target = join(root, "apps/server/assets/autoreview/skill/AGENTS.md");

if (lstatSync(link).isSymbolicLink()) {
  if (readlinkSync(link) !== "AGENTS.md") throw new Error("unexpected AutoReview CLAUDE.md symlink target");
  process.exit(0);
}

if (!lstatSync(link).isFile() || !readFileSync(link).equals(readFileSync(target))) {
  throw new Error("refusing to restore an unexpected AutoReview CLAUDE.md package materialization");
}

unlinkSync(link);
symlinkSync("AGENTS.md", link);
