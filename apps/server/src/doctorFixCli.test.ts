import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { DoctorResponse } from "@perch/shared";

const execFileAsync = promisify(execFile);

// `perch doctor --fix` consent gate, exercised through the real CLI against a
// stub control server - no network, no real installer. The fix plan's install
// command writes a marker file, so "did --fix run it" is a filesystem check.

const PERCH_BIN = fileURLToPath(new URL("../../../bin/perch.mjs", import.meta.url));

function stubReport(installCommand: string, env: Record<string, string>, found: boolean): DoctorResponse {
  return {
    at: "2026-07-07T00:00:00.000Z",
    ok: true,
    tools: [
      {
        name: "claude",
        required: true,
        found: true,
        path: "/stub/claude",
        version: "2.1.19",
        installHint: "npm install -g @anthropic-ai/claude-code"
      },
      {
        name: "no-mistakes",
        required: false,
        found,
        ...(found ? { path: "/stub/no-mistakes", version: "v1.31.2" } : {}),
        installHint: installCommand,
        installer: true
      }
    ],
    noMistakes: { binaryFound: found, projects: [] },
    fix: found
      ? []
      : [{ name: "no-mistakes", kind: "install", command: installCommand, env, note: "stub note" }]
  };
}

// Serves `reports` to successive GET /doctor calls (the last one repeats), so
// a test can present "missing" before the install and "found" on re-check.
async function withStubServer(
  reports: DoctorResponse[],
  run: (serverUrl: string) => Promise<void>
): Promise<void> {
  let served = 0;
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/health")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, adapter: "stub" }));
      return;
    }
    if (request.url?.startsWith("/doctor")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(reports[Math.min(served++, reports.length - 1)]));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

type CliResult = { code: number; stdout: string; stderr: string };

async function runDoctorFix(
  serverUrl: string,
  home: string,
  args: string[],
  extraEnv: Record<string, string> = {}
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [PERCH_BIN, "doctor", "--fix", ...args],
      {
        timeout: 15000,
        env: { ...process.env, PERCH_HOME: home, PERCH_SERVER_URL: serverUrl, ...extraEnv }
      }
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

test("doctor --fix refuses to install without consent (no TTY, no --yes)", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-fix-home-"));
  const marker = join(home, "installed.marker");
  const report = stubReport(`echo ran > "${marker}"`, {}, false);
  try {
    await withStubServer([report], async (serverUrl) => {
      const result = await runDoctorFix(serverUrl, home, []);
      assert.equal(result.code, 1, "an unconsented install skips and exits nonzero");
      assert.equal(existsSync(marker), false, "the installer command must not have run");
      assert.match(result.stdout, /rerun with --yes/, "the way to consent non-interactively is named");
      assert.ok(result.stdout.includes(`echo ran > "${marker}"`), "the exact command is still shown");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor --fix --yes prints the exact command, applies env defaults, and runs it", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-fix-home-"));
  const marker = join(home, "installed.marker");
  const command = `printenv PERCH_FIX_PROBE > "${marker}"`;
  const env = { PERCH_FIX_PROBE: "default-value" };
  try {
    await withStubServer([stubReport(command, env, false), stubReport(command, env, true)], async (serverUrl) => {
      const result = await runDoctorFix(serverUrl, home, ["--yes"]);
      assert.equal(result.code, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.equal(readFileSync(marker, "utf8").trim(), "default-value", "plan env default was applied");
      const printedAt = result.stdout.indexOf(`PERCH_FIX_PROBE="default-value" printenv PERCH_FIX_PROBE`);
      assert.ok(printedAt >= 0, "the full command, env prefix included, is printed before running");
      assert.match(result.stdout, /stub note/, "the plan's note (telemetry opt-out) is shown");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor --fix flags an install that exited 0 but produced no binary", async () => {
  // `curl | sh` reports the pipe tail's status, so a failed download can
  // still exit 0; --fix must judge by re-detection, not the exit code.
  const home = mkdtempSync(join(tmpdir(), "perch-fix-home-"));
  const command = "true";
  const env = { NO_MISTAKES_LINK_DIR: join(home, "link") };
  const report = stubReport(command, env, false);
  try {
    await withStubServer([report, report], async (serverUrl) => {
      const result = await runDoctorFix(serverUrl, home, ["--yes"]);
      assert.equal(result.code, 1, "still missing after the installer ran reads as a failure");
      assert.match(result.stdout, /did not leave a binary/);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor --fix never overrides an env variable the user exported", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-fix-home-"));
  const marker = join(home, "installed.marker");
  const command = `printenv PERCH_FIX_PROBE > "${marker}"`;
  const env = { PERCH_FIX_PROBE: "default-value" };
  try {
    await withStubServer([stubReport(command, env, false), stubReport(command, env, true)], async (serverUrl) => {
      const result = await runDoctorFix(serverUrl, home, ["--yes"], { PERCH_FIX_PROBE: "user-set" });
      assert.equal(result.code, 0);
      assert.equal(readFileSync(marker, "utf8").trim(), "user-set", "the exported value wins");
      assert.match(result.stdout, /keeping your PERCH_FIX_PROBE=user-set/);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
