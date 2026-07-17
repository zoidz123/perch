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
import { MATE_CLAUDE_FALLBACK_MODEL, MATE_CODEX_FALLBACK } from "./models.js";

const execFileAsync = promisify(execFile);
const PERCH_BIN = fileURLToPath(new URL("../../../bin/perch.mjs", import.meta.url));

type StubState = {
  mateDefaults: Record<string, string>;
  sessions: unknown[];
  startRequests: Array<Record<string, unknown>>;
  liveStartResponse?: { status: number; body: Record<string, unknown> };
};

async function withStubServer(run: (serverUrl: string, state: StubState) => Promise<void>): Promise<void> {
  const state: StubState = { mateDefaults: {}, sessions: [], startRequests: [] };
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/health")) {
      response.end(JSON.stringify({ ok: true, adapter: "stub" }));
      return;
    }
    if (request.url?.startsWith("/sessions") && request.method === "GET") {
      response.end(JSON.stringify({ sessions: state.sessions }));
      return;
    }
    if (request.url?.startsWith("/config") && request.method === "GET") {
      response.end(JSON.stringify({ dispatchDefaults: {}, mateDefaults: state.mateDefaults }));
      return;
    }
    if (request.url?.startsWith("/mate/start") && request.method === "POST") {
      const live = state.sessions.find((session) => {
        const candidate = session as { labels?: { role?: string }; status?: string };
        return candidate.labels?.role === "mate" && candidate.status !== "done" && candidate.status !== "error";
      }) as Record<string, unknown> | undefined;
      if (live) {
        response.statusCode = state.liveStartResponse?.status ?? 200;
        response.end(JSON.stringify(state.liveStartResponse?.body ?? { session: live, alreadyLive: true }));
        return;
      }
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        state.startRequests.push(body);
        response.statusCode = 201;
        response.end(JSON.stringify({ session: { id: "pty:stub-mate", title: "mate", agent: body.agent, status: "running" } }));
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

async function runMate(serverUrl: string, home: string, args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [PERCH_BIN, "mate", ...args], {
      timeout: 15000,
      env: { ...process.env, PERCH_HOME: home, PERCH_SERVER_URL: serverUrl, PERCH_TOKEN: "stub-token" }
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

test("perch mate uses configured mate-agent, else Claude with the pinned fallback", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-mate-cli-"));
  try {
    await withStubServer(async (serverUrl, state) => {
      const bare = await runMate(serverUrl, home, ["--no-attach"]);
      assert.equal(bare.code, 0, bare.stderr);
      const request = state.startRequests.at(-1);
      assert.equal(request?.agent, "claude");
      assert.equal(request?.model, MATE_CLAUDE_FALLBACK_MODEL);
      assert.equal(request?.effort, undefined);

      state.mateDefaults = { agent: "codex", model: "gpt-5.4", effort: "high" };
      const configured = await runMate(serverUrl, home, ["--no-attach"]);
      assert.equal(configured.code, 0, configured.stderr);
      const configuredRequest = state.startRequests.at(-1);
      assert.equal(configuredRequest?.agent, "codex");
      assert.equal(configuredRequest?.model, "gpt-5.4");
      assert.equal(configuredRequest?.effort, "high");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("perch mate codex and claude pick that agent regardless of config without model leaks", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-mate-cli-"));
  try {
    await withStubServer(async (serverUrl, state) => {
      const codex = await runMate(serverUrl, home, ["codex", "--no-attach"]);
      assert.equal(codex.code, 0, codex.stderr);
      const codexRequest = state.startRequests.at(-1);
      assert.equal(codexRequest?.agent, "codex");
      assert.equal(codexRequest?.model, MATE_CODEX_FALLBACK.model);
      assert.equal(codexRequest?.effort, MATE_CODEX_FALLBACK.effort);

      state.mateDefaults = { agent: "claude", model: "opus", effort: "high" };
      const crossed = await runMate(serverUrl, home, ["codex", "--no-attach"]);
      assert.equal(crossed.code, 0, crossed.stderr);
      const crossedRequest = state.startRequests.at(-1);
      assert.equal(crossedRequest?.agent, "codex");
      assert.equal(crossedRequest?.model, MATE_CODEX_FALLBACK.model);
      assert.equal(crossedRequest?.effort, MATE_CODEX_FALLBACK.effort);

      state.mateDefaults = { agent: "codex", model: "gpt-5.4", effort: "high" };
      const claude = await runMate(serverUrl, home, ["claude", "--no-attach"]);
      assert.equal(claude.code, 0, claude.stderr);
      const claudeRequest = state.startRequests.at(-1);
      assert.equal(claudeRequest?.agent, "claude");
      assert.equal(claudeRequest?.model, MATE_CLAUDE_FALLBACK_MODEL);
      assert.equal(claudeRequest?.effort, undefined);

      const matching = await runMate(serverUrl, home, ["codex", "--no-attach"]);
      assert.equal(matching.code, 0, matching.stderr);
      const matchingRequest = state.startRequests.at(-1);
      assert.equal(matchingRequest?.agent, "codex");
      assert.equal(matchingRequest?.model, "gpt-5.4");
      assert.equal(matchingRequest?.effort, "high");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("only a known leading agent token is consumed before passthrough args", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-mate-cli-"));
  try {
    await withStubServer(async (serverUrl, state) => {
      const passthrough = await runMate(serverUrl, home, ["resume", "--no-attach"]);
      assert.equal(passthrough.code, 0, passthrough.stderr);
      const request = state.startRequests.at(-1);
      assert.equal(request?.agent, "claude");
      assert.deepEqual(request?.args, ["resume"]);

      const trailing = await runMate(serverUrl, home, ["codex", "resume", "--no-attach"]);
      assert.equal(trailing.code, 0, trailing.stderr);
      const trailingRequest = state.startRequests.at(-1);
      assert.equal(trailingRequest?.agent, "codex");
      assert.deepEqual(trailingRequest?.args, ["resume"]);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a live mate is attached, never duplicated, even when a different agent is requested", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-mate-cli-"));
  try {
    await withStubServer(async (serverUrl, state) => {
      state.sessions = [{ id: "pty:live-mate", agent: "claude", status: "running", labels: { role: "mate" } }];
      const result = await runMate(serverUrl, home, ["codex", "--no-attach"]);
      assert.match(result.stdout, /note: the running mate is claude, not codex/);
      assert.match(result.stdout, /mate already on deck/);
      assert.equal(state.startRequests.length, 0);

      const same = await runMate(serverUrl, home, ["claude", "--no-attach"]);
      assert.doesNotMatch(same.stdout, /note:/);
      assert.match(same.stdout, /mate already on deck/);
      assert.equal(state.startRequests.length, 0);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a legacy 409 falls back to the listed mate but a reconcile failure surfaces", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-mate-cli-"));
  try {
    await withStubServer(async (serverUrl, state) => {
      state.sessions = [{ id: "pty:live-mate", agent: "claude", status: "running", labels: { role: "mate" } }];
      state.liveStartResponse = { status: 409, body: { error: "mate already running", sessionId: "pty:live-mate" } };
      const legacy = await runMate(serverUrl, home, ["--no-attach"]);
      assert.equal(legacy.code, 0, legacy.stderr);
      assert.match(legacy.stdout, /mate already on deck/);

      state.liveStartResponse = { status: 409, body: { error: "recovered claude mate exited before bind" } };
      const failure = await runMate(serverUrl, home, ["--no-attach"]);
      assert.notEqual(failure.code, 0);
      assert.match(failure.stderr, /recovered claude mate exited before bind/);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("perch mate --new requests an intentional fresh owner generation", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-mate-cli-"));
  try {
    await withStubServer(async (serverUrl, state) => {
      const result = await runMate(serverUrl, home, ["--new", "--no-attach"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(state.startRequests.length, 1);
      assert.equal(state.startRequests[0]?.new, true);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
