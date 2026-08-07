import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ASSET_ROOT = fileURLToPath(new URL("../assets/autoreview", import.meta.url));

export type AutoReviewManifestFile = {
  path: string;
  sourcePath: string;
  sourceBlob: string;
  mode: "100644" | "100755" | "120000";
  bytes: number;
  sha256: string;
  linkTarget?: string;
  // npm omits symlinks from tarballs. The packaging lifecycle materializes
  // this exact target content only for installation, while source installs
  // retain the upstream symlink and both representations are verified here.
  npmMaterialization?: {
    bytes: number;
    sha256: string;
  };
};

export type AutoReviewExcludedFile = {
  path: string;
  sourcePath: string;
  sourceBlob: string;
  mode: "100644" | "100755" | "120000";
  bytes: number;
  sha256: string;
  reason: string;
};

export type AutoReviewManifest = {
  schemaVersion: 1;
  source: {
    repository: "openclaw/agent-skills";
    commit: string;
    canonicalPath: "skills/autoreview";
    licensePath: "LICENSE";
  };
  version: string;
  files: AutoReviewManifestFile[];
  excludedFiles: AutoReviewExcludedFile[];
};

const EXPECTED_EXCLUDED_FILES = new Map([
  ["skill/scripts/autoreview_test.py", "98cb20357ef2ebab54437d5f9354509dd442798815143ce930060f1d4e642c2e"],
  ["skill/tests/fixtures/typescript-benign-config-path-references.ts", "986799d4f26a94be975974bdd5b1d98b93b447cd7e97ff7b0a68d5332d148a1d"],
  ["skill/tests/fixtures/typescript-benign-references.ts", "bd26fbc92535b06e4ec82445d05c72ee910798f1e1cead3de63e7107fc2b5408"],
  ["skill/tests/fixtures/typescript-sensitive-literals.ts", "7637763036781849cbc9f3950eb2783f87c0b0451f8fed5aa3782b483e01c76e"],
  ["skill/tests/test_autoreview_hardening.py", "d566ba8fbe55527a137244ed18f12bc5236b04f2228abaaeb7621e336fe14d2d"]
]);

export type BundledAutoReview = {
  root: string;
  helperPath: string;
  harnessPath: string;
  manifest: AutoReviewManifest;
  helperSha256: string;
};

export function autoReviewAssetRoot(): string {
  return DEFAULT_ASSET_ROOT;
}

export function readAutoReviewManifest(root = DEFAULT_ASSET_ROOT): AutoReviewManifest {
  return JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as AutoReviewManifest;
}

// The package owns these bytes.  No global skills directory, PATH lookup, or
// mutable upstream URL is part of resolution.
export function resolveBundledAutoReview(root = DEFAULT_ASSET_ROOT): BundledAutoReview {
  const manifest = readAutoReviewManifest(root);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.source.repository !== "openclaw/agent-skills" ||
    manifest.source.commit !== "2a409d348a4bcf6f15e41e9a20efd0b298a32528" ||
    manifest.source.canonicalPath !== "skills/autoreview" ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    !Array.isArray(manifest.excludedFiles)
  ) {
    throw new Error("bundled AutoReview manifest has unsupported provenance");
  }
  for (const file of manifest.files) {
    verifyFile(root, file);
  }
  verifyExcludedFiles(root, manifest);
  const helper = manifest.files.find((file) => file.path === "skill/scripts/autoreview");
  const harness = manifest.files.find((file) => file.path === "skill/scripts/test-review-harness");
  if (!helper || !harness) throw new Error("bundled AutoReview manifest is missing required executables");
  const helperPath = join(root, helper.path);
  const harnessPath = join(root, harness.path);
  accessSync(helperPath, constants.X_OK);
  accessSync(harnessPath, constants.X_OK);
  return { root, helperPath, harnessPath, manifest, helperSha256: helper.sha256 };
}

function verifyExcludedFiles(root: string, manifest: AutoReviewManifest): void {
  if (manifest.excludedFiles.length !== EXPECTED_EXCLUDED_FILES.size) {
    throw new Error("bundled AutoReview manifest has an unexpected exclusion set");
  }
  const included = new Set(manifest.files.map((file) => file.path));
  for (const excluded of manifest.excludedFiles) {
    if (!isSafeRelativePath(excluded.path) || !isSafeRelativePath(excluded.sourcePath)) {
      throw new Error(`unsafe AutoReview exclusion path: ${excluded.path}`);
    }
    if (
      included.has(excluded.path) ||
      EXPECTED_EXCLUDED_FILES.get(excluded.path) !== excluded.sha256 ||
      excluded.reason !== "four TruffleHog-verified live Lob API credentials in the upstream test bytes" &&
        excluded.reason !== "upstream test fixture excluded with the test suite carrying the four TruffleHog-verified live Lob API credentials" ||
      existsSync(join(root, excluded.path))
    ) {
      throw new Error(`bundled AutoReview exclusion integrity mismatch: ${excluded.path}`);
    }
  }
}

export function validateBundledAutoReview(root = DEFAULT_ASSET_ROOT): BundledAutoReview {
  return resolveBundledAutoReview(root);
}

function verifyFile(root: string, file: AutoReviewManifestFile): void {
  if (!isSafeRelativePath(file.path)) throw new Error(`unsafe AutoReview manifest path: ${file.path}`);
  const path = join(root, file.path);
  const stat = lstatSync(path);
  if (file.mode === "120000") {
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      if (target !== file.linkTarget || Buffer.byteLength(target) !== file.bytes || sha256(target) !== file.sha256) {
        throw new Error(`bundled AutoReview symlink integrity mismatch: ${file.path}`);
      }
      return;
    }
    const materialized = file.npmMaterialization;
    if (
      !materialized ||
      !stat.isFile() ||
      stat.size !== materialized.bytes ||
      sha256(readFileSync(path)) !== materialized.sha256
    ) {
      throw new Error(`bundled AutoReview link materialization integrity mismatch: ${file.path}`);
    }
    return;
  }
  if (!stat.isFile() || stat.size !== file.bytes || sha256(readFileSync(path)) !== file.sha256) {
    throw new Error(`bundled AutoReview integrity mismatch: ${file.path}`);
  }
  const executable = (stat.mode & 0o111) !== 0;
  if ((file.mode === "100755") !== executable) {
    throw new Error(`bundled AutoReview executable mode mismatch: ${file.path}`);
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSafeRelativePath(value: string): boolean {
  return value.length > 0 && !value.startsWith("/") && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}
