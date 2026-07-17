// WebSocket-over-unix-socket transport for the Codex app-server control client.
//
// The shared-daemon `--remote` topology (option b) exposes its control channel
// as a WebSocket on a unix socket: perch spawns `codex app-server --listen
// unix://<sock>`, and a control client connects with a `GET /rpc` HTTP upgrade,
// exchanging one JSON-RPC message per text frame. This is the primary control
// transport; the stdio NDJSON factory in codexAppServer.ts is only the opt-in
// per-session fallback (option a).
//
// The transport bridges a `ws` WebSocket onto the line-oriented `CodexTransport`
// interface the protocol engine already speaks (readline over stdout, one
// `JSON.stringify(msg) + "\n"` write per request over stdin) so the entire
// engine is reused unchanged - only the factory differs.
//
// Two hard-won handshake facts, verified live against the Homebrew codex-cli
// 0.142.5 daemon, are baked in here (getting either wrong yields a silent
// "socket hang up"):
//   1. `perMessageDeflate` MUST be disabled - the daemon rejects the
//      `Sec-WebSocket-Extensions: permessage-deflate` offer `ws` sends by
//      default and drops the connection mid-handshake.
//   2. A `Host` header MUST be present - `ws` omits it for `ws+unix:` URLs
//      (empty hostname), and the daemon closes the connection without one.
// The loopback unix listener needs no auth token; `authToken` is wired through
// for the ws://IP:PORT / non-loopback case only.

import { PassThrough, Writable } from "node:stream";
import WebSocket from "ws";
import type { CodexTransport, SpawnTransport } from "./codexAppServer.js";

export type WsUnixConnect = (url: string, options: WebSocket.ClientOptions) => WebSocket;

export type WsUnixTransportOptions = {
  // Absolute path to the daemon's unix socket. Its PARENT directory must be a
  // real (non-symlink) directory - macOS `/tmp` is a symlink and codex rejects
  // it; $PERCH_HOME is a real directory.
  socketPath: string;
  // Request path for the upgrade; the daemon serves the control channel at /rpc.
  requestPath?: string;
  // Bearer token for non-loopback listeners; omitted for the unix socket.
  authToken?: string;
  // Injectable connector for tests (defaults to constructing a real WebSocket).
  connect?: WsUnixConnect;
};

// Factory suitable for CodexAppServerOptions.spawn: each call opens a fresh
// control connection to the daemon socket.
export function websocketUnixTransport(options: WsUnixTransportOptions): SpawnTransport {
  return () => createWsUnixTransport(options);
}

function createWsUnixTransport(options: WsUnixTransportOptions): CodexTransport {
  const requestPath = options.requestPath ?? "/rpc";
  const url = `ws+unix://${options.socketPath}:${requestPath}`;
  const headers: Record<string, string> = { Host: "localhost" };
  if (options.authToken) headers.Authorization = `Bearer ${options.authToken}`;

  const connect = options.connect ?? ((u, o) => new WebSocket(u, o));
  const ws = connect(url, { perMessageDeflate: false, headers });

  const stdout = new PassThrough();
  // A late inbound frame after the socket closes must not crash the process
  // with an unhandled ERR_STREAM_WRITE_AFTER_END; swallow post-end stream errors.
  stdout.on("error", () => {});
  const exitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  let exited = false;
  let open = false;
  const outbox: string[] = [];
  let lineBuffer = "";

  const fireExit = (code: number | null): void => {
    if (exited) return;
    exited = true;
    open = false;
    for (const handler of exitHandlers) handler(code, null);
    if (!stdout.writableEnded) stdout.end();
  };

  const flushFrame = (frame: string): void => {
    if (open && ws.readyState === WebSocket.OPEN) ws.send(frame);
    else outbox.push(frame);
  };

  ws.on("open", () => {
    open = true;
    for (const frame of outbox.splice(0)) ws.send(frame);
  });
  // One text frame == one complete JSON-RPC message; the engine's readline
  // splits on newlines, so re-append the delimiter it expects.
  ws.on("message", (data: WebSocket.RawData) => {
    if (exited || stdout.writableEnded) return;
    const text = typeof data === "string" ? data : data.toString("utf8");
    if (text.length === 0) return;
    stdout.write(text.endsWith("\n") ? text : text + "\n");
  });
  ws.on("close", (code: number) => fireExit(code ?? null));
  ws.on("error", () => fireExit(null));

  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      lineBuffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = lineBuffer.indexOf("\n")) >= 0) {
        const line = lineBuffer.slice(0, newline).trim();
        lineBuffer = lineBuffer.slice(newline + 1);
        if (line.length > 0) flushFrame(line);
      }
      callback();
    },
    final(callback) {
      callback();
    }
  });

  return {
    stdin,
    stdout,
    stderr: null,
    // No child pid: the daemon lifecycle owns the codex process, not this
    // control connection, so disconnect closes the socket without killing it.
    pid: undefined,
    onExit(callback) {
      exitHandlers.push(callback);
    },
    kill() {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      fireExit(null);
    }
  };
}
