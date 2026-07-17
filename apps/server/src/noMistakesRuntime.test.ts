import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  noMistakesVendorRoot,
  readNoMistakesRuntimeManifest,
  resolveBundledNoMistakes,
  validateBundledNoMistakes
} from "./noMistakesRuntime.js";

test("bundled runtime resolves exact arm64 and x64 bytes without PATH", () => {
  const root = noMistakesVendorRoot();
  for (const arch of ["arm64", "x64"] as const) {
    const resolved = resolveBundledNoMistakes({ vendorRoot: root, platform: "darwin", arch });
    assert.equal(resolved.ok, true, resolved.error);
    assert.equal(resolved.facts?.protocol, "1");
    assert.equal(resolved.facts?.version, "1.39.0-perch.1");
    assert.equal(resolved.facts?.source, "bundled");
  }
});

test("bundled runtime validates the embedded version and authorization protocol", async () => {
  const resolved = await validateBundledNoMistakes({ platform: "darwin", arch: process.arch });
  assert.equal(resolved.ok, true, resolved.error);
});

test("missing and corrupt runtime fail closed without falling back to PATH", () => {
  const source = noMistakesVendorRoot();
  const root = mkdtempSync(join(tmpdir(), "perch-runtime-missing-"));
  try {
    cpSync(join(source, "manifest.json"), join(root, "manifest.json"));
    const missing = resolveBundledNoMistakes({ vendorRoot: root, platform: "darwin", arch: "arm64" });
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? "", /ENOENT|unavailable|access/i);

    mkdirSync(join(root, "darwin-arm64"));
    writeFileSync(join(root, "darwin-arm64/no-mistakes"), "fake PATH binary", { mode: 0o755 });
    const corrupt = resolveBundledNoMistakes({ vendorRoot: root, platform: "darwin", arch: "arm64" });
    assert.equal(corrupt.ok, false);
    assert.match(corrupt.error ?? "", /byte length|SHA-256/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wrong architecture fails even when its bytes and SHA-256 match the manifest", () => {
  const source = noMistakesVendorRoot();
  const root = mkdtempSync(join(tmpdir(), "perch-runtime-arch-"));
  try {
    const manifest = readNoMistakesRuntimeManifest(source);
    const x64 = readFileSync(join(source, manifest.platforms["darwin-x64"]!.path));
    mkdirSync(join(root, "darwin-arm64"));
    writeFileSync(join(root, "darwin-arm64/no-mistakes"), x64, { mode: 0o755 });
    manifest.platforms["darwin-arm64"] = {
      ...manifest.platforms["darwin-arm64"]!,
      binaryBytes: x64.length,
      binarySha256: createHash("sha256").update(x64).digest("hex")
    };
    writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    const resolved = resolveBundledNoMistakes({ vendorRoot: root, platform: "darwin", arch: "arm64" });
    assert.equal(resolved.ok, false);
    assert.match(resolved.error ?? "", /architecture mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsupported platforms and architectures fail closed", () => {
  assert.equal(resolveBundledNoMistakes({ platform: "linux", arch: "arm64" }).ok, false);
  assert.equal(resolveBundledNoMistakes({ platform: "darwin", arch: "riscv64" }).ok, false);
});
