import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// `perch config get/set/unset`, exercised through the real CLI against a stub
// control server. Structural failures (unknown key, agent outside the
// whitelist) fail fast client-side - before any PATCH reaches the server - with
// a message naming the accepted values. Reasoning efforts are PER-MODEL, so the
// CLI no longer keeps a local effort enum: any effort string is forwarded and
// the server validates it against the selected model's catalog.

const PERCH_BIN = fileURLToPath(new URL("../../../bin/perch.mjs", import.meta.url));

type StubState = {
  defaults: Record<string, string>;
  mateDefaults: Record<string, string>;
  patches: unknown[];
};

async function withStubServer(run: (serverUrl: string, state: StubState) => Promise<void>): Promise<void> {
  const state: StubState = { defaults: {}, mateDefaults: {}, patches: [] };
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/health")) {
      response.end(JSON.stringify({ ok: true, adapter: "stub" }));
      return;
    }
    if (request.url?.startsWith("/config") && request.method === "GET") {
      response.end(JSON.stringify({ dispatchDefaults: state.defaults, mateDefaults: state.mateDefaults }));
      return;
    }
    if (request.url?.startsWith("/config") && request.method === "PATCH") {
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => {
        const body = JSON.parse(raw) as {
          dispatchDefaults?: Record<string, string | null>;
          mateDefaults?: Record<string, string | null>;
        };
        state.patches.push(body);
        for (const [key, value] of Object.entries(body.dispatchDefaults ?? {})) {
          if (value === null) delete state.defaults[key];
          else state.defaults[key] = value;
        }
        for (const [key, value] of Object.entries(body.mateDefaults ?? {})) {
          if (value === null) delete state.mateDefaults[key];
          else state.mateDefaults[key] = value;
        }
        response.end(JSON.stringify({ dispatchDefaults: state.defaults, mateDefaults: state.mateDefaults }));
      });
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}`, state);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

type CliResult = { code: number; stdout: string; stderr: string };

async function runConfig(serverUrl: string, home: string, args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [PERCH_BIN, "config", ...args], {
      timeout: 15000,
      env: { ...process.env, PERCH_HOME: home, PERCH_SERVER_URL: serverUrl, PERCH_TOKEN: "stub-token" }
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

test("config set PATCHes the mapped field and get reads it back", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-config-home-"));
  try {
    await withStubServer(async (serverUrl, state) => {
      const set = await runConfig(serverUrl, home, ["set", "default-agent", "codex"]);
      assert.equal(set.code, 0, set.stderr);
      assert.match(set.stdout, /default-agent = codex/);
      assert.deepEqual(state.patches, [{ dispatchDefaults: { agent: "codex" } }]);

      const getOne = await runConfig(serverUrl, home, ["get", "default-agent"]);
      assert.equal(getOne.stdout.trim(), "codex");

      const getAll = await runConfig(serverUrl, home, ["get"]);
      assert.match(getAll.stdout, /default-agent\s+codex/);
      assert.match(getAll.stdout, /default-model\s+\(unset\)/);
      assert.match(getAll.stdout, /default-effort\s+\(unset\)/);

      const unset = await runConfig(serverUrl, home, ["unset", "default-agent"]);
      assert.equal(unset.code, 0, unset.stderr);
      assert.match(unset.stdout, /default-agent = \(unset\)/);
      assert.deepEqual(state.patches.at(-1), { dispatchDefaults: { agent: null } });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("config set/get/unset works the same for the mate-* keys, independent of default-*", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-config-home-"));
  try {
    await withStubServer(async (serverUrl, state) => {
      const set = await runConfig(serverUrl, home, ["set", "mate-agent", "codex"]);
      assert.equal(set.code, 0, set.stderr);
      assert.match(set.stdout, /mate-agent = codex/);
      assert.deepEqual(state.patches, [{ mateDefaults: { agent: "codex" } }]);

      const setModel = await runConfig(serverUrl, home, ["set", "mate-model", "opus"]);
      assert.equal(setModel.code, 0, setModel.stderr);
      assert.match(setModel.stdout, /mate-model = opus/);

      const getOne = await runConfig(serverUrl, home, ["get", "mate-agent"]);
      assert.equal(getOne.stdout.trim(), "codex");

      const getAll = await runConfig(serverUrl, home, ["get"]);
      assert.match(getAll.stdout, /mate-agent\s+codex/);
      assert.match(getAll.stdout, /mate-model\s+opus/);
      assert.match(getAll.stdout, /mate-effort\s+\(unset\)/);
      // The worker defaults are untouched by mate-* sets.
      assert.match(getAll.stdout, /default-agent\s+\(unset\)/);

      const unset = await runConfig(serverUrl, home, ["unset", "mate-agent"]);
      assert.equal(unset.code, 0, unset.stderr);
      assert.match(unset.stdout, /mate-agent = \(unset\)/);
      assert.deepEqual(state.patches.at(-1), { mateDefaults: { agent: null } });

      const badAgent = await runConfig(serverUrl, home, ["set", "mate-agent", "gemini"]);
      assert.equal(badAgent.code, 1);
      assert.match(badAgent.stderr, /invalid mate-agent: gemini \(expected claude\|codex\)/);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("config set validates client-side: bad agent and unknown key never reach the server", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-config-home-"));
  try {
    await withStubServer(async (serverUrl, state) => {
      const badAgent = await runConfig(serverUrl, home, ["set", "default-agent", "gemini"]);
      assert.equal(badAgent.code, 1);
      assert.match(badAgent.stderr, /invalid default-agent: gemini \(expected claude\|codex\)/);

      const badKey = await runConfig(serverUrl, home, ["set", "default-provider", "codex"]);
      assert.equal(badKey.code, 1);
      assert.match(badKey.stderr, /unknown config key: default-provider/);

      const noValue = await runConfig(serverUrl, home, ["set", "default-model"]);
      assert.equal(noValue.code, 1);
      assert.match(noValue.stderr, /requires a value/);

      // A free-string model is fine - only the agent is whitelisted client-side.
      const model = await runConfig(serverUrl, home, ["set", "default-model", "some-future-model"]);
      assert.equal(model.code, 0, model.stderr);

      // Efforts are per-model, so the CLI forwards ANY effort (including the
      // high tiers a stale local enum used to reject) to the server, which
      // validates it against the selected model.
      const ultra = await runConfig(serverUrl, home, ["set", "default-effort", "ultra"]);
      assert.equal(ultra.code, 0, ultra.stderr);

      assert.deepEqual(state.patches, [
        { dispatchDefaults: { model: "some-future-model" } },
        { dispatchDefaults: { effort: "ultra" } }
      ]);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
