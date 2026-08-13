#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDirectories = [
  "apps/server/dist",
  "packages/shared/dist",
  "packages/relay/dist"
];

for (const directory of distDirectories) {
  rmSync(join(root, directory), { recursive: true, force: true });
}

const npm = process.env.npm_execpath;
if (!npm) {
  throw new Error("npm_execpath is required; run this through `npm run build:package`");
}

execFileSync(process.execPath, [npm, "run", "build", "--ignore-scripts"], {
  cwd: root,
  env: process.env,
  stdio: "inherit"
});

const required = [
  "bin/perch.mjs",
  "apps/server/dist/index.js",
  "apps/server/assets/mate/AGENTS.md",
  "apps/server/assets/autoreview/manifest.json",
  "apps/server/assets/autoreview/LICENSE.upstream",
  "apps/server/assets/autoreview/skill/CLAUDE.md",
  "apps/server/assets/autoreview/skill/SKILL.md",
  "apps/server/assets/autoreview/skill/scripts/autoreview",
  "apps/server/assets/autoreview/skill/scripts/test-review-harness",
  "packages/shared/dist/index.js",
  "packages/relay/dist/cli.js",
  "THIRD_PARTY_NOTICES.md",
  "LICENSE"
];

for (const file of required) {
  if (!existsSync(join(root, file))) {
    throw new Error(`release build is missing ${file}`);
  }
}

const autoreviewClaudeLink = join(root, "apps/server/assets/autoreview/skill/CLAUDE.md");
if (!lstatSync(autoreviewClaudeLink).isSymbolicLink() || readlinkSync(autoreviewClaudeLink) !== "AGENTS.md") {
  throw new Error("source AutoReview bundle must retain the upstream CLAUDE.md symlink");
}

for (const excluded of [
  "apps/server/assets/autoreview/skill/scripts/autoreview_test.py",
  "apps/server/assets/autoreview/skill/tests"
]) {
  if (existsSync(join(root, excluded))) {
    throw new Error(`source AutoReview bundle contains excluded upstream test bytes: ${excluded}`);
  }
}

const emittedTests = walk(join(root, "apps/server/dist"))
  .filter((file) => file.endsWith(".test.js"));
if (emittedTests.length > 0) {
  throw new Error(`release build contains test output: ${emittedTests.join(", ")}`);
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
