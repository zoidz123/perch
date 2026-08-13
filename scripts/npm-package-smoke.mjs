#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryRoot = mkdtempSync(join(tmpdir(), "perch-package-smoke-"));
const packs = join(temporaryRoot, "packs");
const localPrefix = join(temporaryRoot, "local");
const functionalPrefix = join(temporaryRoot, "functional");
const globalPrefix = join(temporaryRoot, "global");
const fakeHome = join(temporaryRoot, "home");
const perchHome = join(fakeHome, ".perch");
const npmCache = join(temporaryRoot, "npm-cache");
const temporaryFiles = join(temporaryRoot, "tmp");
const xdgConfig = join(temporaryRoot, "xdg-config");
const xdgCache = join(temporaryRoot, "xdg-cache");
const xdgData = join(temporaryRoot, "xdg-data");
const port = randomInt(20000, 50000);
const serverUrl = `http://127.0.0.1:${port}`;
const npmPath = process.env.npm_execpath;

assert(npmPath, "npm_execpath is required; run this through `npm run test:package`");
for (const directory of [packs, localPrefix, functionalPrefix, globalPrefix, fakeHome, npmCache, temporaryFiles, xdgConfig, xdgCache, xdgData]) {
  mkdirSync(directory, { recursive: true });
}

const expectedMajor = process.env.SMOKE_EXPECT_NODE_MAJOR;
if (expectedMajor) {
  assert.equal(process.versions.node.split(".")[0], expectedMajor);
}

const isolatedEnvironment = {
  ...process.env,
  HOME: fakeHome,
  PERCH_HOME: perchHome,
  PERCH_SERVER_URL: serverUrl,
  PERCH_RELAY_URL: "off",
  TMPDIR: temporaryFiles,
  XDG_CONFIG_HOME: xdgConfig,
  XDG_CACHE_HOME: xdgCache,
  XDG_DATA_HOME: xdgData,
  npm_config_cache: npmCache,
  PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`
};

try {
  const packOutput = npm(["pack", "--json", "--pack-destination", packs], { cwd: root });
  const pack = JSON.parse(packOutput)[0];
  const tarball = join(packs, pack.filename);
  auditPack(pack);

  const checksum = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  console.log(`package=${pack.name}@${pack.version}`);
  console.log(`node=${process.version}`);
  console.log(`tarball=${tarball}`);
  console.log(`sha256=${checksum}`);
  console.log(`files=${pack.entryCount}`);
  console.log(`packedSize=${pack.size}`);
  console.log(`unpackedSize=${pack.unpackedSize}`);

  const outputDirectory = process.env.PACKAGE_SMOKE_OUTPUT;
  if (outputDirectory) {
    mkdirSync(outputDirectory, { recursive: true });
    copyFileSync(tarball, join(outputDirectory, pack.filename));
    writeFileSync(join(outputDirectory, "pack.json"), `${JSON.stringify(pack, null, 2)}\n`);
    writeFileSync(join(outputDirectory, "sha256.txt"), `${checksum}  ${pack.filename}\n`);
  }

  npm(["install", "--ignore-scripts", "--prefix", localPrefix, tarball]);
  const localBin = join(localPrefix, "node_modules/.bin/perch");
  chmodSync(localBin, 0o755);
  command(localBin, ["--help"]);
  const projectHelp = command(localBin, ["project", "--help"]);
  assert.match(projectHelp, /ship, scout, or operate/);
  assert.doesNotMatch(projectHelp, /direct-PR\|local-only/);
  assert.doesNotMatch(projectHelp, /yolo/i);
  assert.doesNotMatch(
    readFileSync(join(localPrefix, "node_modules/perchctl/apps/server/assets/mate/AGENTS.md"), "utf8"),
    /yolo/i
  );
  assert.equal(command(localBin, ["--version"]).trim(), pack.version);
  npm(["exec", "--prefix", localPrefix, "--", "perch", "--help"]);
  command(process.execPath, ["-e", `import(${JSON.stringify(pathToFileURL(join(localPrefix, "node_modules/perchctl/packages/shared/dist/index.js")).href)})`]);
  command(process.execPath, ["-e", `import(${JSON.stringify(pathToFileURL(join(localPrefix, "node_modules/perchctl/packages/relay/dist/index.js")).href)})`]);
  command(process.execPath, ["-e", `import(${JSON.stringify(pathToFileURL(join(localPrefix, "node_modules/perchctl/apps/server/dist/autoreviewRuntime.js")).href)}).then(({ resolveBundledAutoReview }) => resolveBundledAutoReview())`]);
  assertBundledAutoReview(join(localPrefix, "node_modules/perchctl"));

  // better-sqlite3 is an existing native dependency with its own install
  // script. The ignore-scripts lanes above and below prove the bundled
  // AutoReview helper itself needs no lifecycle hook or network download.
  // Use an ordinary isolated install for the full server smoke.
  npm(["install", "--prefix", functionalPrefix, tarball]);
  const functionalBin = join(functionalPrefix, "node_modules/.bin/perch");
  command(functionalBin, ["server", "start"]);
  waitForHealth();
  assertDoctorJson(functionalBin);
  command(functionalBin, ["config", "set", "--global", "dispatch.agent", "codex"]);
  const config = command(functionalBin, ["config", "get", "dispatch.agent", "--effective"]);
  assert.match(config, /codex/);
  command(functionalBin, ["pair"]);
  command(functionalBin, ["server", "stop"]);
  waitForStop();

  mkdirSync(perchHome, { recursive: true });
  const stateSentinel = join(perchHome, "release-smoke-state");
  writeFileSync(stateSentinel, "preserve me\n", { mode: 0o600 });

  npm(["install", "--ignore-scripts", "--global", "--prefix", globalPrefix, tarball]);
  const globalBin = join(globalPrefix, "bin/perch");
  command(globalBin, ["--help"]);
  assert.equal(command(globalBin, ["--version"]).trim(), pack.version);
  assertBundledAutoReview(join(globalPrefix, "lib/node_modules/perchctl"));
  waitForStop();
  npm(["uninstall", "--global", "--prefix", globalPrefix, pack.name]);
  assert(existsSync(stateSentinel), "global uninstall removed PERCH_HOME state");

  const homeEntries = readdirSync(fakeHome);
  assert(homeEntries.includes(".perch"));
  console.log(`isolatedHomeEntries=${homeEntries.sort().join(",")}`);
  console.log("package smoke passed");
} finally {
  try {
    const localBin = join(localPrefix, "node_modules/.bin/perch");
    if (existsSync(localBin)) {
      command(localBin, ["server", "stop"], { allowFailure: true });
    }
  } finally {
    if (process.env.KEEP_PACKAGE_SMOKE !== "1") {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

function auditPack(pack) {
  const paths = pack.files.map((file) => file.path);
  const required = [
    "LICENSE",
    "README.md",
    "bin/perch.mjs",
    "apps/server/dist/index.js",
    "apps/server/assets/mate/AGENTS.md",
    "apps/server/assets/autoreview/manifest.json",
    "apps/server/assets/autoreview/LICENSE.upstream",
    "apps/server/assets/autoreview/perch-deletion-handling.patch",
    "apps/server/assets/autoreview/skill/SKILL.md",
    "apps/server/assets/autoreview/skill/scripts/autoreview",
    "apps/server/assets/autoreview/skill/scripts/test-review-harness",
    "packages/shared/dist/index.js",
    "packages/relay/dist/cli.js",
    "THIRD_PARTY_NOTICES.md"
  ];
  for (const path of required) {
    assert(paths.includes(path), `tarball is missing ${path}`);
  }

  const allowed = [
    /^package\.json$/,
    /^LICENSE$/,
    /^README\.md$/,
    /^bin\/perch\.mjs$/,
    /^apps\/server\/dist\/.*\.js$/,
    /^apps\/server\/assets\//,
    /^packages\/(shared|relay)\/dist\/.*\.js$/,
    /^THIRD_PARTY_NOTICES\.md$/
  ];
  for (const path of paths) {
    assert(allowed.some((pattern) => pattern.test(path)), `unexpected tarball entry: ${path}`);
    assert(!path.endsWith(".test.js"), `test output leaked into tarball: ${path}`);
    assert(!/(^|\/)(\.env|\.git|\.charts|\.lavish|node_modules|state\.sqlite)(\/|$)/.test(path), `private path leaked into tarball: ${path}`);
  }

  const bin = pack.files.find((file) => file.path === "bin/perch.mjs");
  assert(bin && (bin.mode & 0o111) !== 0, "perch bin is not executable");
  for (const path of ["apps/server/assets/autoreview/skill/scripts/autoreview", "apps/server/assets/autoreview/skill/scripts/test-review-harness"]) {
    const helper = pack.files.find((file) => file.path === path);
    assert(helper && (helper.mode & 0o111) !== 0, `${path} is not executable`);
  }
}

function assertBundledAutoReview(packageRoot) {
  const root = join(packageRoot, "apps/server/assets/autoreview");
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.source.repository, "openclaw/agent-skills");
  assert.equal(manifest.source.commit, "2a409d348a4bcf6f15e41e9a20efd0b298a32528");
  assert.equal(manifest.deviations.length, 1, "AutoReview deviation manifest must be complete");
  const deviation = manifest.deviations[0];
  assert.equal(deviation.baseUpstreamCommit, manifest.source.commit);
  assert.equal(
    createHash("sha256").update(readFileSync(join(root, deviation.patchPath))).digest("hex"),
    deviation.patchSha256,
    "AutoReview deviation patch hash mismatch"
  );
  assert.equal(manifest.excludedFiles.length, 5, "AutoReview exclusion manifest must be complete");
  for (const entry of manifest.excludedFiles) {
    assert(!existsSync(join(root, entry.path)), `${entry.path} must not enter the npm package`);
  }
  for (const entry of manifest.files) {
    const file = join(root, entry.path);
    const stat = lstatSync(file);
    if (entry.mode === "120000") {
      assert(stat.isFile(), `${entry.path} must be an npm materialized link file`);
      assert(entry.npmMaterialization, `${entry.path} must declare npm materialization`);
      assert.equal(stat.size, entry.npmMaterialization.bytes, `${entry.path} materialized byte count mismatch`);
      assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), entry.npmMaterialization.sha256, `${entry.path} materialized hash mismatch`);
      continue;
    }
    assert(stat.isFile(), `${entry.path} must be a file`);
    assert.equal(stat.size, entry.bytes, `${entry.path} byte count mismatch`);
    assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), entry.sha256, `${entry.path} hash mismatch`);
    assert.equal(Boolean(stat.mode & 0o111), entry.mode === "100755", `${entry.path} executable mode mismatch`);
  }
  command(join(root, "skill/scripts/autoreview"), ["--help"]);
  command(join(root, "skill/scripts/test-review-harness"), ["--help"]);
}

function npm(args, options = {}) {
  return execFileSync(process.execPath, [npmPath, ...args], {
    cwd: options.cwd ?? temporaryRoot,
    env: isolatedEnvironment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  });
}

function command(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: temporaryRoot,
    env: isolatedEnvironment,
    encoding: "utf8",
    timeout: 20000
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${file} ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function assertDoctorJson(file) {
  const result = spawnSync(file, ["doctor", "--json"], {
    cwd: temporaryRoot,
    env: isolatedEnvironment,
    encoding: "utf8",
    timeout: 20000
  });
  assert([0, 1].includes(result.status), `doctor exited unexpectedly (${result.status}):\n${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(typeof report.ok, "boolean");
  assert(Array.isArray(report.tools));
  assert.equal(result.status, report.ok ? 0 : 1, "doctor exit status disagrees with its JSON report");
}

function waitForHealth() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = spawnSync(process.execPath, ["-e", `fetch(${JSON.stringify(`${serverUrl}/health`)}).then(async r => { if (!r.ok || !(await r.json()).ok) process.exit(1) }).catch(() => process.exit(1))`], {
      env: isolatedEnvironment,
      timeout: 1000
    });
    if (result.status === 0) {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error(`server did not become healthy at ${serverUrl}`);
}

function waitForStop() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = spawnSync(process.execPath, ["-e", `fetch(${JSON.stringify(`${serverUrl}/health`)}).then(() => process.exit(1)).catch(() => process.exit(0))`], {
      env: isolatedEnvironment,
      timeout: 1000
    });
    if (result.status === 0) {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error(`server did not stop at ${serverUrl}`);
}
