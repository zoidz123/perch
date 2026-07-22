#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateAggregate } from "./ci-aggregate.mjs";
import { classifyAffectedPaths } from "./ci-affected.mjs";

test("main pushes and uncertain diffs run every optional job", () => {
  assert.deepEqual(classifyAffectedPaths(["docs/operations.md"], "push"), { javascript: true, package: true, ios: true });
  assert.deepEqual(classifyAffectedPaths([], "pull_request"), { javascript: true, package: true, ios: true });
  assert.deepEqual(classifyAffectedPaths(["new-area/file.txt"]), { javascript: true, package: true, ios: true });
});

test("root, lockfile, workflow, script, and shared changes fail open", () => {
  for (const file of ["package.json", "package-lock.json", ".github/workflows/ci.yml", "scripts/check-public-seed.mjs", "docs/generate.sh", "design/app-icon/generate.sh", "packages/shared/src/index.ts"]) {
    assert.deepEqual(classifyAffectedPaths([file]), { javascript: true, package: true, ios: true }, file);
  }
});

test("known paths select only their substantive lanes", () => {
  assert.deepEqual(classifyAffectedPaths(["apps/server/src/index.ts"]), { javascript: true, package: true, ios: false });
  assert.deepEqual(classifyAffectedPaths(["packages/relay/src/client.ts"]), { javascript: true, package: true, ios: false });
  assert.deepEqual(classifyAffectedPaths(["apps/ios/Perch/PerchApp.swift"]), { javascript: false, package: false, ios: true });
  assert.deepEqual(classifyAffectedPaths(["vendor/no-mistakes/manifest.json"]), { javascript: false, package: true, ios: false });
  assert.deepEqual(classifyAffectedPaths(["docs/operations.md", "design/mock.png", "public-seed.json"]), { javascript: false, package: false, ios: false });
});

test("documentation is exempt while support logic fails open", () => {
  assert.deepEqual(classifyAffectedPaths(["docs/operations.md"]), { javascript: false, package: false, ios: false });
  assert.deepEqual(classifyAffectedPaths(["design/app-icon/icon-light.svg"]), { javascript: false, package: false, ios: false });
  assert.deepEqual(classifyAffectedPaths(["docs/generate.sh"]), { javascript: true, package: true, ios: true });
  assert.deepEqual(classifyAffectedPaths(["design/app-icon/generate.sh"]), { javascript: true, package: true, ios: true });
});

test("workflow preserves rename source and destination paths", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /git diff --no-renames --name-only -z/);
  assert.deepEqual(classifyAffectedPaths(["apps/server/src/index.ts", "docs/operations.md"]), { javascript: true, package: true, ios: false });
});

test("mixed paths union lanes and any unknown path fails open", () => {
  assert.deepEqual(classifyAffectedPaths(["apps/server/src/index.ts", "apps/ios/Perch/PerchApp.swift"]), { javascript: true, package: true, ios: true });
  assert.deepEqual(classifyAffectedPaths(["apps/ios/Perch/PerchApp.swift", "unexpected.txt"]), { javascript: true, package: true, ios: true });
});

test("aggregate accepts successful selected jobs and skipped optional jobs", () => {
  assert.deepEqual(validateAggregate([
    { name: "public-seed", required: true, selected: false, status: "success" },
    { name: "javascript", required: false, selected: true, status: "success" },
    { name: "package", required: false, selected: false, status: "skipped" },
    { name: "ios", required: false, selected: false, status: "skipped" }
  ]), []);
});

test("aggregate rejects failed, skipped, or cancelled required selections", () => {
  assert.deepEqual(validateAggregate([
    { name: "public-seed", required: true, selected: false, status: "success" },
    { name: "javascript", required: false, selected: true, status: "failure" },
    { name: "package", required: false, selected: true, status: "skipped" },
    { name: "ios", required: false, selected: true, status: "cancelled" }
  ]), ["javascript was selected but failure", "package was selected but skipped", "ios was selected but cancelled"]);
  assert.deepEqual(validateAggregate([
    { name: "public-seed", required: true, selected: false, status: "failure" }
  ]), ["public-seed was failure"]);
});
