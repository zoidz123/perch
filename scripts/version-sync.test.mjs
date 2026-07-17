import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rootPackage = json("package.json");
const version = rootPackage.version;

test("package, CLI, documentation, tag, and release expectations share one version", () => {
  for (const path of [
    "package-lock.json",
    "apps/server/package.json",
    "packages/shared/package.json",
    "packages/relay/package.json"
  ]) {
    assert.equal(json(path).version, version, `${path} drifted from package.json`);
  }
  assert.equal(
    execFileSync(process.execPath, [join(root, "bin/perch.mjs"), "--version"], { encoding: "utf8" }).trim(),
    version
  );
  assert.doesNotMatch(text("apps/server/src/http.ts"), /version:\s*["']\d/);
  for (const path of ["docs/cli.md", "docs/operations.md", "docs/releasing.md"]) {
    assert.match(text(path), new RegExp(`perchctl@${escapeRegExp(version)}`), `${path} lacks the package version`);
  }
  assert.ok(text("docs/releasing.md").includes(`Release tag: \`v${version}\``));
});

function json(path) {
  return JSON.parse(text(path));
}

function text(path) {
  return readFileSync(join(root, path), "utf8");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
