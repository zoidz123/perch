// Native-TUI attach routing, for `perch attach` and launch-time attach alike:
// an app-server-owned Codex session (record carries attachCommand) execs the
// native Codex TUI - from the record's structured fields when present, else
// exactly the display command's whitespace tokens - and never opens the PTY
// WebSocket path. `perch codex` and a Codex `perch mate` launch route the
// same way from the started record; a Claude session/launch still PTY-attaches
// over the WebSocket; a Codex session without attachCommand fails (or, at
// launch, prints the record plus a retry hint) instead of rendering nothing.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";

const execFileAsync = promisify(execFile);
const PERCH_BIN = fileURLToPath(new URL("../../../bin/perch.mjs", import.meta.url));

type Harness = {
  run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
  upgrades: number;
  wsMessages: unknown[];
  fakeCodexLog: string;
  close(): Promise<void>;
};

// Stub perch server (GET /sessions, POST /agents/pty, POST /mate/start, GET
// /config and /models for the mate launch path) plus a fake `codex` binary on
// PATH that records its argv; the WebSocket side answers a subscribe with a
// terminal status event, and a start_agent by announcing a session then
// ending it, so PTY attaches terminate deterministically.
async function startHarness(
  sessions: unknown[],
  opts: { startSession?: unknown; mateSession?: unknown } = {}
): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), "perch-attach-cli-"));
  const fakeBinDir = join(home, "fakebin");
  const fakeCodexLog = join(home, "codex-argv.log");
  const codexPath = join(fakeBinDir, "codex");
  mkdirSync(fakeBinDir, { recursive: true });
  writeFileSync(codexPath, `#!/bin/sh\nprintf '%s\\n' "$@" > "${fakeCodexLog}"\nprintf '%s\\n' "$@"\n`);
  chmodSync(codexPath, 0o755);

  const harness: Harness = {
    upgrades: 0,
    wsMessages: [],
    fakeCodexLog,
    run: async () => {
      throw new Error("not started");
    },
    close: async () => {}
  };

  const server = createServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") return response.end(JSON.stringify({ ok: true, adapter: "stub" }));
    if (request.url === "/sessions" && request.method === "GET") {
      return response.end(JSON.stringify({ sessions }));
    }
    // /config and /models carry query strings; match on the prefix.
    if (request.url?.startsWith("/config") && request.method === "GET") {
      return response.end(JSON.stringify({ entries: {}, mateDefaults: {} }));
    }
    if (request.url?.startsWith("/models") && request.method === "GET") {
      return response.end(JSON.stringify({ providers: [] }));
    }
    if (request.url === "/agents/pty" && request.method === "POST" && opts.startSession) {
      return response.end(JSON.stringify({ session: opts.startSession }));
    }
    if (request.url === "/mate/start" && request.method === "POST" && opts.mateSession) {
      return response.end(JSON.stringify({ session: opts.mateSession }));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    harness.upgrades += 1;
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type?: string; sessionId?: string };
        harness.wsMessages.push(message);
        if (message.type === "subscribe") {
          // End the attach deterministically: the CLI exits 0 on status done.
          ws.send(
            JSON.stringify({
              type: "event",
              event: { type: "status", sessionId: message.sessionId, status: "done", at: new Date().toISOString() }
            })
          );
        }
        if (message.type === "start_agent") {
          // Announce the launched session (the CLI attaches on the first
          // session-scoped event), then end it so the run terminates.
          const sessionId = "pty:ws-launched-1";
          ws.send(
            JSON.stringify({
              type: "event",
              event: { type: "status", sessionId, status: "running", at: new Date().toISOString() }
            })
          );
          ws.send(
            JSON.stringify({
              type: "event",
              event: { type: "status", sessionId, status: "done", at: new Date().toISOString() }
            })
          );
        }
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  harness.run = async (args: string[]) => {
    try {
      const result = await execFileAsync(process.execPath, [PERCH_BIN, ...args], {
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
          PERCH_HOME: home,
          PERCH_SERVER_URL: `http://127.0.0.1:${port}`,
          PERCH_TOKEN: "test"
        }
      });
      return { ...result, code: 0 };
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string; code?: number };
      return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", code: failed.code ?? 1 };
    }
  };
  harness.close = async () => {
    rmSync(home, { recursive: true, force: true });
    wss.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return harness;
}

test("attach execs the native Codex TUI with exactly the record's attachCommand tokens", async () => {
  const harness = await startHarness([
    {
      id: "pty:codex-owned-1",
      agent: "codex",
      status: "working",
      title: "codex worker",
      attachCommand: "codex resume thr-777 --remote unix:///tmp/perch-test/codex.sock",
      lastActivityAt: new Date().toISOString()
    }
  ]);
  try {
    const result = await harness.run(["attach", "codex-ow"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout.trim().split("\n"), [
      "resume",
      "thr-777",
      "--remote",
      "unix:///tmp/perch-test/codex.sock"
    ]);
    assert.match(result.stderr, /native Codex TUI/);
    // Never the PTY thin-client path: no WebSocket attach was attempted.
    assert.equal(harness.upgrades, 0);
  } finally {
    await harness.close();
  }
});

test("attach keeps the PTY WebSocket path for a Claude session and never spawns codex", async () => {
  const harness = await startHarness([
    {
      id: "pty:claude-1",
      agent: "claude",
      status: "working",
      title: "claude worker",
      lastActivityAt: new Date().toISOString()
    }
  ]);
  try {
    const result = await harness.run(["attach", "claude-1"]);
    assert.equal(result.code, 0);
    assert.equal(harness.upgrades, 1);
    assert.deepEqual(
      harness.wsMessages.filter((message) => (message as { type?: string }).type === "subscribe"),
      [{ type: "subscribe", sessionId: "pty:claude-1" }]
    );
    assert.equal(existsSync(harness.fakeCodexLog), false);
  } finally {
    await harness.close();
  }
});

test("perch codex launch-attaches the native TUI from the started record and never opens the WebSocket", async () => {
  const harness = await startHarness([], {
    startSession: {
      id: "pty:codex-new-1",
      agent: "codex",
      status: "idle",
      title: "codex worker",
      // A socket path with whitespace: the structured fields must win over
      // splitting the display command, which would break this argv.
      attachCommand: "codex resume thr-9 --remote unix:///tmp/perch codex/codex.sock",
      attachThreadId: "thr-9",
      attachSocketPath: "/tmp/perch codex/codex.sock",
      lastActivityAt: new Date().toISOString()
    }
  });
  try {
    const result = await harness.run(["codex"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout.trim().split("\n"), [
      "resume",
      "thr-9",
      "--remote",
      "unix:///tmp/perch codex/codex.sock"
    ]);
    assert.match(result.stderr, /native Codex TUI/);
    assert.equal(harness.upgrades, 0);
  } finally {
    await harness.close();
  }
});

test("perch codex launch without an attach command prints the record and a truthful retry hint", async () => {
  const harness = await startHarness([], {
    startSession: {
      id: "pty:codex-new-2",
      agent: "codex",
      status: "idle",
      title: "codex worker",
      lastActivityAt: new Date().toISOString()
    }
  });
  try {
    const result = await harness.run(["codex"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Started codex worker/);
    assert.match(result.stdout, /Session: pty:codex-new-2/);
    assert.match(result.stderr, /no attach command yet/);
    assert.match(result.stderr, /perch attach codex-ne/);
    assert.equal(harness.upgrades, 0);
    assert.equal(existsSync(harness.fakeCodexLog), false);
  } finally {
    await harness.close();
  }
});

test("perch claude launch keeps the WebSocket start_agent path and never spawns codex", async () => {
  const harness = await startHarness([]);
  try {
    const result = await harness.run(["claude"]);
    assert.equal(result.code, 0);
    assert.equal(harness.upgrades, 1);
    assert.equal(
      harness.wsMessages.filter((message) => (message as { type?: string }).type === "start_agent").length,
      1
    );
    assert.equal(existsSync(harness.fakeCodexLog), false);
  } finally {
    await harness.close();
  }
});

test("perch mate codex launch-attaches the native TUI instead of the terminal mirror", async () => {
  const harness = await startHarness([], {
    mateSession: {
      id: "pty:mate-codex-1",
      agent: "codex",
      status: "idle",
      title: "mate",
      labels: { role: "mate" },
      attachCommand: "codex resume thr-mate --remote unix:///tmp/perch-test/mate.sock",
      attachThreadId: "thr-mate",
      attachSocketPath: "/tmp/perch-test/mate.sock",
      lastActivityAt: new Date().toISOString()
    }
  });
  try {
    const result = await harness.run(["mate", "codex"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout.trim().split("\n"), [
      "resume",
      "thr-mate",
      "--remote",
      "unix:///tmp/perch-test/mate.sock"
    ]);
    assert.match(result.stderr, /native Codex TUI/);
    assert.equal(harness.upgrades, 0);
  } finally {
    await harness.close();
  }
});

test("attach fails clearly for a Codex session with no attachCommand", async () => {
  const harness = await startHarness([
    {
      id: "pty:codex-owned-2",
      agent: "codex",
      status: "working",
      title: "codex worker",
      lastActivityAt: new Date().toISOString()
    }
  ]);
  try {
    const result = await harness.run(["attach", "codex-ow"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no attach command yet/);
    assert.equal(harness.upgrades, 0);
    assert.equal(existsSync(harness.fakeCodexLog), false);
  } finally {
    await harness.close();
  }
});
