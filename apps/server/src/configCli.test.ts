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
  project: { mode?: string };
  projects: Array<{ rootPath: string; name: string; mode?: string; addedAt: string; lastUsedAt: string }>;
  patches: unknown[];
  registry: Record<string, unknown>;
};

async function withStubServer(run: (serverUrl: string, state: StubState) => Promise<void>): Promise<void> {
  const state: StubState = {
    defaults: {},
    mateDefaults: {},
    project: {},
    projects: [],
    patches: [],
    registry: stubRegistry()
  };
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/health")) {
      response.end(JSON.stringify({ ok: true, adapter: "stub" }));
      return;
    }
    if (request.url?.startsWith("/config") && request.method === "GET") {
      response.end(JSON.stringify(stubConfig(state)));
      return;
    }
    if (request.url?.startsWith("/models") && request.method === "GET") {
      response.end(JSON.stringify(state.registry));
      return;
    }
    if (request.url?.startsWith("/projects") && request.method === "GET") {
      response.end(JSON.stringify({ projects: state.projects }));
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
        response.end(JSON.stringify(stubConfig(state)));
      });
      return;
    }
    if (request.url?.startsWith("/projects") && request.method === "PATCH") {
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => {
        const body = JSON.parse(raw) as { rootPath?: string; mode?: string | null };
        state.patches.push(body);
        if (body.mode === null) delete state.project.mode;
        else if (body.mode !== undefined) state.project.mode = body.mode;
        response.end(JSON.stringify({ project: state.project }));
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

function stubRegistry() {
  return {
    at: "2026-07-20T00:00:00.000Z",
    sources: [
      { name: "claude-bundled", role: "runtime", ok: true, status: "ok" },
      { name: "codex-app-server", role: "runtime", ok: false, status: "fallback", reason: "codex binary not found" }
    ],
    providers: [
      {
        provider: "claude",
        options: [
          { id: "fable", runtimeId: "fable", nativeProviderId: "claude-fable-5", runtimeSource: "bundled" },
          { id: "shared", runtimeId: "shared", runtimeSource: "bundled" },
          { id: "best", runtimeId: "best", runtimeSource: "bundled", hidden: true }
        ]
      },
      {
        provider: "codex",
        options: [
          {
            id: "gpt-5.6-sol",
            runtimeId: "gpt-5.6-sol",
            supportedReasoningEfforts: ["low", "medium", "high"],
            defaultReasoningEffort: "low",
            runtimeSource: "static-fallback"
          },
          {
            id: "shared",
            runtimeId: "shared",
            supportedReasoningEfforts: ["medium"],
            defaultReasoningEffort: "medium",
            runtimeSource: "static-fallback"
          }
        ]
      }
    ]
  };
}

function stubConfig(state: StubState) {
  const entries: Record<string, object> = {};
  for (const [prefix, values] of [["dispatch", state.defaults], ["mate", state.mateDefaults]] as const) {
    for (const field of ["agent", "model", "effort"] as const) {
      const value = values[field] ?? null;
      entries[`${prefix}.${field}`] = {
        effectiveValue: value,
        source: value === null ? "built-in" : "global",
        scope: "global",
        storedValue: value,
        defaultValue: null,
        overriddenBy: null
      };
    }
  }
  for (const [key, effectiveValue] of Object.entries({
    version: "1.39.0-perch.1",
    protocol: "1",
    source: "bundled",
    path: "/package/vendor/no-mistakes/darwin-arm64/no-mistakes",
    "SHA-256": "abc123",
    architecture: "arm64"
  })) {
    entries[`runtime.no-mistakes.${key}`] = {
      effectiveValue,
      source: "bundled",
      scope: "runtime",
      storedValue: null,
      defaultValue: null,
      overriddenBy: null,
      readOnly: true
    };
  }
  entries["task.mode"] = {
    effectiveValue: state.project.mode ?? "direct-PR",
    source: state.project.mode ? "project" : "built-in",
    scope: "project",
    storedValue: state.project.mode ?? null,
    defaultValue: "direct-PR",
    overriddenBy: null
  };
  entries["provider.token"] = {
    effectiveValue: "server-secret",
    source: "environment",
    scope: "global",
    storedValue: "stored-secret",
    defaultValue: null,
    overriddenBy: "PERCH_PROVIDER_TOKEN"
  };
  return { dispatchDefaults: state.defaults, mateDefaults: state.mateDefaults, entries };
}

type CliResult = { code: number; stdout: string; stderr: string };

async function runConfig(serverUrl: string, home: string, args: string[]): Promise<CliResult> {
  return runCli(serverUrl, home, ["config", ...args]);
}

async function runCli(serverUrl: string, home: string, args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [PERCH_BIN, ...args], {
      timeout: 15000,
      env: { ...process.env, PERCH_HOME: home, PERCH_SERVER_URL: serverUrl, PERCH_TOKEN: "stub-token" }
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

test("wrapper help covers top-level and nested commands without starting the server or a provider", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-config-home-"));
  try {
    const unreachable = "http://127.0.0.1:1";
    const cases: Array<[string[], RegExp]> = [
      [["claude", "--help"], /Starts and attaches a Perch-managed claude session/],
      [["codex", "--help"], /To forward provider help/],
      [["run", "--help"], /perch run \[options\] -- <command>/],
      [["mate", "--help"], /durable Mate orchestrator/],
      [["recover", "task", "--help"], /perch recover task <task-id>/],
      [["attach", "--help"], /Attaches this terminal/],
      [["stop", "--help"], /Stops a live Perch session/],
      [["ls", "--help"], /Lists Perch sessions/],
      [["tasks", "--help"], /same task state, runtime, and PR facts shown in the mobile app/],
      [["pair", "--help"], /Creates a device pairing offer/],
      [["devices", "revoke", "--help"], /perch devices revoke <id>/],
      [["project", "add", "--help"], /project remove\|rm <path>/],
      [["models", "--help"], /selectable Mate and dispatch models/],
      [["config", "set", "--help"], /Global defaults: dispatch\.\* for workers and mate\.\* for Mate/],
      [["worktrees", "release", "--help"], /worktrees release <id> \[--force\]/],
      [["doctor", "--help"], /immutable bundled no-mistakes runtime/],
      [["uninstall", "--help"], /Removes Perch-managed agent configuration/],
      [["server", "logs", "--help"], /Controls the local Perch server/]
    ];
    for (const [args, expected] of cases) {
      const result = await runCli(unreachable, home, args);
      assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
      assert.match(result.stdout, expected);
      assert.equal(result.stderr, "");
    }

    const alias = await runCli(unreachable, home, ["help", "config"]);
    assert.equal(alias.code, 0, alias.stderr);
    assert.match(alias.stdout, /Runtime keys are read-only provenance/);
    assert.doesNotMatch(alias.stdout, /yolo/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("config set PATCHes the mapped field and get reads it back", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-config-home-"));
  try {
    await withStubServer(async (serverUrl, state) => {
      const set = await runConfig(serverUrl, home, ["set", "--global", "dispatch.agent", "codex"]);
      assert.equal(set.code, 0, set.stderr);
      assert.match(set.stdout, /dispatch\.agent = codex/);
      assert.match(set.stderr, /Deprecated: use `perch config set dispatch <model>/);
      assert.deepEqual(state.patches, [{ dispatchDefaults: { agent: "codex" } }]);

      const getOne = await runConfig(serverUrl, home, ["get", "--global", "dispatch.agent"]);
      assert.equal(getOne.stdout.trim(), "codex");

      const getAll = await runConfig(serverUrl, home, ["show", "--global"]);
      assert.match(getAll.stdout, /dispatch\.agent\s+codex/);
      assert.match(getAll.stdout, /dispatch\.model\s+\(unset\)/);
      assert.match(getAll.stdout, /dispatch\.effort\s+\(unset\)/);

      const unset = await runConfig(serverUrl, home, ["unset", "--global", "dispatch.agent"]);
      assert.equal(unset.code, 0, unset.stderr);
      assert.match(unset.stdout, /dispatch\.agent = \(unset\)/);
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
      const set = await runConfig(serverUrl, home, ["set", "--global", "mate.agent", "codex"]);
      assert.equal(set.code, 0, set.stderr);
      assert.match(set.stdout, /mate\.agent = codex/);
      assert.deepEqual(state.patches, [{ mateDefaults: { agent: "codex" } }]);

      const setModel = await runConfig(serverUrl, home, ["set", "--global", "mate.model", "opus"]);
      assert.equal(setModel.code, 0, setModel.stderr);
      assert.match(setModel.stdout, /mate\.model = opus/);
      assert.match(setModel.stderr, /Deprecated: use `perch config set mate <model>/);

      const getOne = await runConfig(serverUrl, home, ["get", "--global", "mate.agent"]);
      assert.equal(getOne.stdout.trim(), "codex");

      const getAll = await runConfig(serverUrl, home, ["show", "--global"]);
      assert.match(getAll.stdout, /mate\.agent\s+codex/);
      assert.match(getAll.stdout, /mate\.model\s+opus/);
      assert.match(getAll.stdout, /mate\.effort\s+\(unset\)/);
      // The worker defaults are untouched by mate-* sets.
      assert.match(getAll.stdout, /dispatch\.agent\s+\(unset\)/);

      const unset = await runConfig(serverUrl, home, ["unset", "--global", "mate.agent"]);
      assert.equal(unset.code, 0, unset.stderr);
      assert.match(unset.stdout, /mate\.agent = \(unset\)/);
      assert.deepEqual(state.patches.at(-1), { mateDefaults: { agent: null } });

      const badAgent = await runConfig(serverUrl, home, ["set", "--global", "mate.agent", "gemini"]);
      assert.equal(badAgent.code, 1);
      assert.match(badAgent.stderr, /invalid mate\.agent: gemini \(expected claude\|codex\)/);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("atomic role selection resolves aliases and writes one complete tuple", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-config-home-"));
  try {
    await withStubServer(async (serverUrl, state) => {
      const alias = await runConfig(serverUrl, home, ["set", "mate", "claude-fable-5"]);
      assert.equal(alias.code, 0, alias.stderr);
      assert.match(alias.stdout, /mate = claude\/fable/);
      assert.deepEqual(state.patches, [{ mateDefaults: { agent: "claude", model: "fable", effort: null } }]);

      state.patches.length = 0;
      const codex = await runConfig(serverUrl, home, ["set", "dispatch", "gpt-5.6-sol"]);
      assert.equal(codex.code, 0, codex.stderr);
      assert.match(codex.stdout, /dispatch = codex\/gpt-5\.6-sol \(low\)/);
      assert.deepEqual(state.patches, [{
        dispatchDefaults: { agent: "codex", model: "gpt-5.6-sol", effort: "low" }
      }]);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("atomic role selection rejects unknown models, invalid efforts, and non-TTY ambiguity before PATCH", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-config-home-"));
  try {
    await withStubServer(async (serverUrl, state) => {
      const unknown = await runConfig(serverUrl, home, ["set", "mate", "fabl"]);
      assert.equal(unknown.code, 1);
      assert.match(unknown.stderr, /Closest matches: fable \(claude\)/);
      assert.match(unknown.stderr, /perch models/);

      const effort = await runConfig(serverUrl, home, ["set", "dispatch", "gpt-5.6-sol", "--effort", "ultra"]);
      assert.equal(effort.code, 1);
      assert.match(effort.stderr, /Valid efforts: low, medium, high/);

      const ambiguous = await runConfig(serverUrl, home, ["set", "mate", "shared"]);
      assert.equal(ambiguous.code, 1);
      assert.match(ambiguous.stderr, /available for multiple agents.*--agent/);
      assert.deepEqual(state.patches, []);

      const disambiguated = await runConfig(serverUrl, home, ["set", "mate", "shared", "--agent", "claude"]);
      assert.equal(disambiguated.code, 0, disambiguated.stderr);
      assert.deepEqual(state.patches, [{ mateDefaults: { agent: "claude", model: "shared", effort: null } }]);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("models lists both agents, marks selected roles, emits JSON, and notes an absent provider", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-config-home-"));
  try {
    await withStubServer(async (serverUrl, state) => {
      state.mateDefaults = { agent: "claude", model: "fable" };
      state.defaults = { agent: "codex", model: "gpt-5.6-sol", effort: "low" };

      const table = await runCli(serverUrl, home, ["models"]);
      assert.equal(table.code, 0, table.stderr);
      assert.match(table.stdout, /MODEL\s+AGENT\s+EFFORTS\s+ALIASES\s+SOURCE\s+SELECTED/);
      assert.match(table.stdout, /fable\s+claude\s+-\s+claude-fable-5\s+bundled\s+mate/);
      assert.match(table.stdout, /gpt-5\.6-sol\s+codex\s+low,medium,high\s+-\s+bundled\s+dispatch/);
      // Hidden catalog entries are not offered in the listing.
      assert.doesNotMatch(table.stdout, /^best\s/m);
      assert.match(table.stderr, /Note: codex-app-server: codex binary not found/);

      // ...unless actively selected: a mate configured to a hidden model must
      // not vanish from the inventory.
      state.mateDefaults = { agent: "claude", model: "best" };
      const selectedHidden = await runCli(serverUrl, home, ["models"]);
      assert.equal(selectedHidden.code, 0, selectedHidden.stderr);
      assert.match(selectedHidden.stdout, /^best\s+claude\s+.*mate/m);
      state.mateDefaults = { agent: "claude", model: "fable" };

      const json = await runCli(serverUrl, home, ["models", "--json"]);
      assert.equal(json.code, 0, json.stderr);
      const body = JSON.parse(json.stdout) as {
        models: Array<{ model: string; source: string; selected: string[] }>;
        notes: string[];
      };
      assert.deepEqual(body.models.find((model) => model.model === "fable")?.selected, ["mate"]);
      assert.equal(body.models.find((model) => model.model === "fable")?.source, "bundled");
      assert.deepEqual(body.notes, ["codex-app-server: codex binary not found"]);

      const codexProvider = (state.registry.providers as Array<{
        provider: string;
        options: Array<{ runtimeSource?: string }>;
      }>).find((provider) => provider.provider === "codex");
      assert.ok(codexProvider);
      for (const option of codexProvider.options) option.runtimeSource = "codex-app-server";
      const liveJson = await runCli(serverUrl, home, ["models", "--json"]);
      assert.equal(liveJson.code, 0, liveJson.stderr);
      const liveBody = JSON.parse(liveJson.stdout) as { models: Array<{ agent: string; source: string }> };
      assert.ok(liveBody.models.filter((model) => model.agent === "codex").every((model) => model.source === "live"));
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("config show warns about invalid tuples without synthetic resolved-agent rows", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-config-home-"));
  try {
    await withStubServer(async (serverUrl, state) => {
      state.mateDefaults = { agent: "codex", model: "fable", effort: "medium" };
      const show = await runConfig(serverUrl, home, ["show", "--global"]);
      assert.equal(show.code, 0, show.stderr);
      assert.doesNotMatch(show.stdout, /resolved-agent/);
      assert.match(show.stdout, /mate\.warning\s+invalid codex\/fable tuple; model resolves to claude/);
      assert.deepEqual(state.patches, []);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("config set validates client-side: bad agent and unknown key never reach the server", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-config-home-"));
  try {
    await withStubServer(async (serverUrl, state) => {
      const badAgent = await runConfig(serverUrl, home, ["set", "--global", "dispatch.agent", "gemini"]);
      assert.equal(badAgent.code, 1);
      assert.match(badAgent.stderr, /invalid dispatch\.agent: gemini \(expected claude\|codex\)/);

      const badKey = await runConfig(serverUrl, home, ["set", "--global", "dispatch.provider", "codex"]);
      assert.equal(badKey.code, 1);
      assert.match(badKey.stderr, /unknown config key: dispatch\.provider/);

      const noValue = await runConfig(serverUrl, home, ["set", "--global", "dispatch.model"]);
      assert.equal(noValue.code, 1);
      assert.match(noValue.stderr, /requires a value/);

      // A free-string model is fine - only the agent is whitelisted client-side.
      const model = await runConfig(serverUrl, home, ["set", "--global", "dispatch.model", "some-future-model"]);
      assert.equal(model.code, 0, model.stderr);

      // Efforts are per-model, so the CLI forwards ANY effort (including the
      // high tiers a stale local enum used to reject) to the server, which
      // validates it against the selected model.
      const ultra = await runConfig(serverUrl, home, ["set", "--global", "dispatch.effort", "ultra"]);
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

test("config moves only task.mode to perch project and rejects the removed key", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-config-home-"));
  try {
    await withStubServer(async (serverUrl, state) => {
      const moved = await runConfig(serverUrl, home, ["set", "--project", "/repo", "task.mode", "no-mistakes"]);
      assert.equal(moved.code, 1);
      assert.match(moved.stderr, /task\.mode moved to the project registry; use `perch project set \/repo --mode no-mistakes`/);

      const removed = await runConfig(serverUrl, home, ["set", "--project", "/repo", "task.yolo", "true"]);
      assert.equal(removed.code, 1);
      assert.match(removed.stderr, /unknown config key: task\.yolo/);
      assert.deepEqual(state.patches, []);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("config validate passes on the global view and runtime owns bundled provenance", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-config-home-"));
  try {
    await withStubServer(async (serverUrl) => {
      const validate = await runConfig(serverUrl, home, ["validate"]);
      assert.equal(validate.code, 0, validate.stderr);
      assert.match(validate.stdout, /configuration valid/);

      const show = await runConfig(serverUrl, home, ["show"]);
      assert.equal(show.code, 0, show.stderr);
      assert.doesNotMatch(show.stdout, /runtime\.no-mistakes|task\.mode|yolo/i);

      const runtime = await runCli(serverUrl, home, ["runtime", "validate"]);
      assert.equal(runtime.code, 0, runtime.stderr);
      assert.match(runtime.stdout, /bundled no-mistakes runtime valid/);

      const runtimeJson = await runCli(serverUrl, home, ["runtime", "--json"]);
      assert.equal(runtimeJson.code, 0, runtimeJson.stderr);
      const body = JSON.parse(runtimeJson.stdout) as Record<string, { effectiveValue: unknown }>;
      assert.equal(body["runtime.no-mistakes.source"]?.effectiveValue, "bundled");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("project CLI lists only delivery mode, accepts every supported mode, and rejects removed flags", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-config-home-"));
  try {
    await withStubServer(async (serverUrl, state) => {
      state.projects.push({
        rootPath: "/repo",
        name: "repo",
        mode: "direct-PR",
        addedAt: "2026-07-20T00:00:00.000Z",
        lastUsedAt: "2026-07-20T00:00:00.000Z"
      });
      const list = await runCli(serverUrl, home, ["project", "list"]);
      assert.equal(list.code, 0, list.stderr);
      assert.match(list.stdout, /NAME\s+MODE\s+LAST USED\s+PATH/);
      assert.doesNotMatch(list.stdout, /yolo/i);

      const show = await runCli(serverUrl, home, ["project", "show", "/repo"]);
      assert.equal(show.code, 0, show.stderr);
      assert.match(show.stdout, /MODE     direct-PR/);
      assert.doesNotMatch(show.stdout, /yolo/i);

      for (const mode of ["direct-PR", "local-only", "no-mistakes"]) {
        const set = await runCli(serverUrl, home, ["project", "set", "/repo", "--mode", mode, "--yes"]);
        assert.equal(set.code, 0, set.stderr);
      }
      assert.deepEqual(state.patches.slice(-3), [
        { rootPath: "/repo", mode: "direct-PR" },
        { rootPath: "/repo", mode: "local-only" },
        { rootPath: "/repo", mode: "no-mistakes" }
      ]);

      for (const [action, flag] of [["add", "--yolo"], ["set", "--no-yolo"]] as const) {
        const removed = await runCli(serverUrl, home, ["project", action, "/repo", flag]);
        assert.equal(removed.code, 1);
        assert.match(removed.stderr, new RegExp(`unknown option for project ${action}: ${flag}`));
      }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("text and JSON config views redact secret-shaped keys identically", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-config-home-"));
  try {
    await withStubServer(async (serverUrl) => {
      const text = await runConfig(serverUrl, home, ["show", "--effective"]);
      const json = await runConfig(serverUrl, home, ["show", "--effective", "--json"]);
      assert.equal(text.code, 0, text.stderr);
      assert.equal(json.code, 0, json.stderr);
      assert.match(text.stdout, /provider\.token\s+<redacted>/);
      assert.doesNotMatch(text.stdout, /server-secret|stored-secret/);
      assert.match(json.stdout, /<redacted>/);
      assert.doesNotMatch(json.stdout, /server-secret|stored-secret/);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
