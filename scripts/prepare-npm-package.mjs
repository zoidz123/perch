#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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

const vendorSource = join(root, "apps/server/src/charts/vendor");
const vendorDestination = join(root, "apps/server/dist/charts/vendor");
mkdirSync(vendorDestination, { recursive: true });
cpSync(vendorSource, vendorDestination, { recursive: true });

const required = [
  "bin/perch.mjs",
  "apps/server/dist/index.js",
  "apps/server/dist/charts/vendor/LICENSE",
  "apps/server/dist/charts/vendor/artifact-sdk.js",
  "apps/server/assets/mate/AGENTS.md",
  "apps/server/assets/charts/chart.css",
  "apps/server/assets/charts/AUTHORING.md",
  "packages/shared/dist/index.js",
  "packages/relay/dist/cli.js",
  "LICENSE"
];

for (const file of required) {
  if (!existsSync(join(root, file))) {
    throw new Error(`release build is missing ${file}`);
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
