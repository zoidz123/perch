#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.on("uncaughtException", () => {
  console.error("Public seed validation failed: internal validation error");
  process.exit(1);
});
process.on("unhandledRejection", () => {
  console.error("Public seed validation failed: internal validation error");
  process.exit(1);
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "public-seed.json"), "utf8"));
const expectedManifestKeys = ["include", "publicMarkdown", "runtimeMarkdown"];

function fail(message) {
  console.error(`Public seed validation failed: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  let mode;
  let list = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--list") {
      list = true;
    } else if (arg === "--mode") {
      mode = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length);
    } else {
      fail("unsupported command-line argument");
    }
  }
  if (mode !== "source-preflight" && mode !== "exported-repo") {
    fail("--mode must be source-preflight or exported-repo");
  }
  if (list && mode !== "source-preflight") {
    fail("--list is available only in source-preflight mode");
  }
  return { mode, list };
}

function validateSafePath(value, label, allowGlob = false) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must contain non-empty strings`);
  }
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value) || path.posix.isAbsolute(value)) {
    fail(`${label} contains an unsafe path`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(`${label} contains an unsafe path`);
  }
  if (!allowGlob && value.includes("*")) {
    fail(`${label} must not contain glob patterns`);
  }
  if (allowGlob && segments.some((segment) => segment.includes("*") && segment !== "*" && segment !== "**")) {
    fail(`${label} contains an unsupported glob pattern`);
  }
}

function isMarkdown(file) {
  return /\.(md|markdown)$/i.test(file);
}

function validateManifest() {
  const keys = Object.keys(manifest).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...expectedManifestKeys].sort())) {
    fail("manifest keys do not match the public schema");
  }
  for (const key of expectedManifestKeys) {
    if (!Array.isArray(manifest[key]) || manifest[key].length === 0) {
      fail(`manifest ${key} must be a non-empty array`);
    }
    if (new Set(manifest[key]).size !== manifest[key].length) {
      fail(`manifest ${key} contains duplicate entries`);
    }
    for (const value of manifest[key]) {
      validateSafePath(value, `manifest ${key}`, key === "include");
    }
  }
  const markdown = [...manifest.publicMarkdown, ...manifest.runtimeMarkdown];
  if (new Set(markdown).size !== markdown.length || markdown.some((file) => !isMarkdown(file))) {
    fail("approved Markdown entries must be unique Markdown paths");
  }
}

function matcher(pattern) {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesAny(file, patterns) {
  return patterns.some((pattern) => matcher(pattern).test(file));
}

function trackedEntries() {
  const output = execFileSync("git", ["-C", root, "ls-files", "--stage", "-z"], { encoding: "utf8" });
  return output
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d{6}) ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(record);
      if (!match || match[3] !== "0" || !["100644", "100755", "120000"].includes(match[1])) {
        fail("tracked index contains an unsupported entry");
      }
      const file = match[4];
      validateSafePath(file, "tracked files");
      if (path.posix.normalize(file) !== file) {
        fail("tracked files contain a non-canonical path");
      }
      return { mode: match[1], hash: match[2], file };
    })
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

function validateSymlinks(entries, approvedFiles) {
  const approved = new Set(approvedFiles);
  for (const entry of entries) {
    if (entry.mode !== "120000") continue;
    const target = execFileSync("git", ["-C", root, "cat-file", "blob", entry.hash], { encoding: "utf8" });
    if (target.includes("\\") || /[\u0000-\u001f\u007f]/.test(target) || path.posix.isAbsolute(target)) {
      fail("selected tree contains an unsafe symlink target");
    }
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry.file), target));
    if (resolved === ".." || resolved.startsWith("../") || !approved.has(resolved)) {
      fail("selected tree contains an unsafe symlink target");
    }
  }
}

const { mode, list } = parseArgs(process.argv.slice(2));
validateManifest();

const entries = trackedEntries();
const tracked = entries.map((entry) => entry.file);
const includeMatchers = manifest.include.map(matcher);
const unmatchedIncludes = manifest.include.filter(
  (pattern, index) => !tracked.some((file) => includeMatchers[index].test(file))
);
if (unmatchedIncludes.length > 0) {
  fail(`${unmatchedIncludes.length} include pattern(s) match no tracked files`);
}

// The private source keeps unresolved third-party icon sets for provenance
// review. The future clean snapshot omits every provider icon set as a class,
// without publishing provider-specific filenames in the manifest or output.
const sourceOnlyOmissions = ["apps/ios/Perch/Assets.xcassets/*-icon.imageset/**"];
const included = tracked.filter((file) => matchesAny(file, manifest.include));
const selected = included.filter((file) => !matchesAny(file, sourceOnlyOmissions));

if (mode === "exported-repo") {
  const outsideBoundary = tracked.filter((file) => !matchesAny(file, manifest.include));
  const omittedSourceMaterial = tracked.filter((file) => matchesAny(file, sourceOnlyOmissions));
  if (outsideBoundary.length > 0 || omittedSourceMaterial.length > 0) {
    fail(`${outsideBoundary.length + omittedSourceMaterial.length} tracked file(s) are outside the exported boundary`);
  }
}

const approvedMarkdown = [...manifest.publicMarkdown, ...manifest.runtimeMarkdown].sort();
const selectedMarkdown = selected.filter((file) => isMarkdown(file)).sort();
if (JSON.stringify(selectedMarkdown) !== JSON.stringify(approvedMarkdown)) {
  fail("selected Markdown does not match the exact approved set");
}

validateSymlinks(
  entries.filter((entry) => selected.includes(entry.file)),
  selected
);

if (list) {
  process.stdout.write(`${selected.join("\n")}\n`);
} else if (mode === "source-preflight") {
  console.log(
    `Public seed source preflight passed: ${selected.length} selected files, ${approvedMarkdown.length} approved Markdown files.`
  );
} else {
  console.log(
    `Public seed exported repository passed: ${tracked.length} tracked files, ${approvedMarkdown.length} approved Markdown files.`
  );
}
