#!/usr/bin/env node

import { lstatSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const link = join(root, "apps/server/assets/autoreview/skill/CLAUDE.md");
const target = join(root, "apps/server/assets/autoreview/skill/AGENTS.md");

if (!lstatSync(link).isSymbolicLink() || readlinkSync(link) !== "AGENTS.md") {
  throw new Error("refusing to materialize an unexpected AutoReview CLAUDE.md source entry");
}

// npm pack ignores symlinks. Materialize the already-vendored target without
// fetching anything so installed packages retain the required runtime file.
unlinkSync(link);
writeFileSync(link, readFileSync(target), { mode: 0o644 });
