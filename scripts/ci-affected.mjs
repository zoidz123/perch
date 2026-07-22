#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ALL = Object.freeze({ javascript: true, package: true, ios: true });
const NONE = Object.freeze({ javascript: false, package: false, ios: false });

const documentationPath = /^docs\//;
const designDocumentationPath = /^design\/.*\.(?:gif|jpe?g|md|mdx|pdf|png|svg|txt|webp)$/i;
const javascriptPath = /^(apps\/server|packages\/(relay|shared))\//;
const iosPath = /^apps\/ios\//;
const packagePath = /^(bin|vendor)\//;
const packageRootFile = /^(README\.md|LICENSE|THIRD_PARTY_NOTICES\.md)$/;

export function classifyAffectedPaths(paths, eventName = "pull_request") {
  if (eventName === "push" || paths.length === 0) {
    return { ...ALL };
  }

  const affected = { ...NONE };
  for (const file of paths) {
    if (file === "package-lock.json" || file === "package.json" || file === "tsconfig.base.json" || file === ".gitignore" || file.startsWith(".github/")) {
      return { ...ALL };
    }
    if (file === "public-seed.json" || documentationPath.test(file) || designDocumentationPath.test(file)) {
      continue;
    }
    if (file.startsWith("scripts/")) {
      return { ...ALL };
    }
    if (file.startsWith("packages/shared/")) {
      return { ...ALL };
    }
    if (javascriptPath.test(file)) {
      affected.javascript = true;
      affected.package = true;
      continue;
    }
    if (iosPath.test(file)) {
      affected.ios = true;
      continue;
    }
    if (packagePath.test(file) || packageRootFile.test(file)) {
      affected.package = true;
      continue;
    }

    // New or unfamiliar paths are safer to validate than silently ignore.
    return { ...ALL };
  }
  return affected;
}

function run() {
  const eventIndex = process.argv.indexOf("--event");
  const eventName = eventIndex === -1 ? "pull_request" : process.argv[eventIndex + 1];
  let input = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    input = Buffer.concat([input, chunk]);
  });
  process.stdin.on("end", () => {
    const files = input.toString("utf8").split("\0").filter(Boolean);
    const affected = classifyAffectedPaths(files, eventName);
    const output = Object.entries(affected).map(([key, value]) => `${key}=${value}\n`).join("");
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, output);
    }
    process.stdout.write(JSON.stringify({ event: eventName, files, affected }, null, 2) + "\n");
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
