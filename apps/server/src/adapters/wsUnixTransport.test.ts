import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { CodexAppServerClient } from "./codexAppServer.js";
import { websocketUnixTransport } from "./wsUnixTransport.js";

test("ws-unix transport carries the protocol engine's initialize handshake", async () => {
  const dir = mkdtempSync(join(tmpdir(), "px"));
  const socketPath = join(dir, "s");
  const frames: string[] = [];
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    if (req.url !== "/rpc") return void socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (data) => {
        const text = data.toString("utf8");
        frames.push(text);
        const msg = JSON.parse(text) as { id?: number; method?: string };
        if (msg.id != null && msg.method === "initialize") {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }));
        }
      });
    });
  });
  await new Promise<void>((resolve) => http.listen(socketPath, resolve));

  try {
    const client = new CodexAppServerClient({
      sessionId: "cx-test",
      spawn: websocketUnixTransport({ socketPath })
    });
    await client.connect();
    assert.equal(client.isConnected(), true);

    // Exactly one frame per JSON-RPC message (no newline framing leaked), and
    // it parses as the initialize request the engine sent.
    assert.equal(frames.length >= 1, true);
    const initialize = JSON.parse(frames[0] ?? "{}") as { method?: string };
    assert.equal(initialize.method, "initialize");
    assert.equal(frames[0]?.includes("\n"), false);

    await client.disconnect();
  } finally {
    wss.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ws-unix transport reports exit when the daemon socket closes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "px"));
  const socketPath = join(dir, "s");
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const serverSockets: WsSocket[] = [];
  http.on("upgrade", (req, socket, head) => {
    if (req.url !== "/rpc") return void socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      serverSockets.push(ws);
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString("utf8")) as { id?: number; method?: string };
        if (msg.id != null) ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
      });
    });
  });
  await new Promise<void>((resolve) => http.listen(socketPath, resolve));

  try {
    const transport = websocketUnixTransport({ socketPath })();
    const exit = new Promise<void>((resolve) => transport.onExit(() => resolve()));
    // Force a write so the connection opens, then drop the server side.
    transport.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n");
    await new Promise((resolve) => setTimeout(resolve, 50));
    serverSockets[0]?.close();
    await exit; // resolves only if onExit fired
  } finally {
    wss.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
