import { ok, rejects, strictEqual } from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import nacl from "tweetnacl";
import type { AgentSession, RecentEventsResult } from "@perch/shared";
import type { AgentAdapter } from "../adapters/types.js";
import { FleetMonitor, type ClientAuth } from "../fleetMonitor.js";
import { deriveSharedKey, openFrame, sealFrame } from "./crypto.js";
import { EncryptedServerChannel } from "./channel.js";

// End-to-end over a REAL WebSocket (the existing LAN transport), fully
// encrypted, no relay. This is the in-process analogue of Task 0.7's manual
// phone test: it proves ws.WebSocket drives the EncryptedServerChannel, that
// FleetMonitor's plaintext frames arrive as ciphertext on the wire, and that
// the device token never appears in cleartext.

// Minimal adapter: enough for FleetMonitor.addClient to build an overview.
class MiniAdapter implements AgentAdapter {
  readonly name = "mini";
  constructor(private readonly sessions: AgentSession[]) {}
  async getTopology() {
    return { windows: [], generatedAt: "" };
  }
  async listSessions(): Promise<AgentSession[]> {
    return this.sessions;
  }
  async readRecentEvents(sessionId: string): Promise<RecentEventsResult> {
    return { events: [], terminal: true };
  }
  async sendInput(): Promise<void> {}
  async sendEnter(): Promise<void> {}
  async interrupt(): Promise<void> {}
}

const GOOD_TOKEN = "good-device-token";

type Harness = {
  url: string;
  serverPubB64: string;
  monitor: FleetMonitor;
  close: () => Promise<void>;
};

async function startServer(): Promise<Harness> {
  const keys = nacl.box.keyPair();
  const monitor = new FleetMonitor(
    new MiniAdapter([
      {
        id: "s1",
        title: "s1",
        agent: "claude",
        workspaceId: "w1",
        kind: "terminal",
        status: "idle",
        lastActivityAt: ""
      }
    ]),
    { reconcileMs: 1_000_000 }
  );

  const httpServer = createServer();
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.searchParams.get("e2ee") !== "1") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      const channel = new EncryptedServerChannel(webSocket, keys.secretKey, (token) =>
        token === GOOD_TOKEN ? ({ kind: "device", deviceId: "d1" } satisfies ClientAuth) : undefined
      );
      channel
        .awaitAuth()
        .then((auth) => monitor.addClient(channel, undefined, auth))
        .catch(() => {});
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}/?e2ee=1`,
    serverPubB64: Buffer.from(keys.publicKey).toString("base64"),
    monitor,
    close: () =>
      new Promise<void>((resolve) => {
        monitor.closeAllClients();
        wss.close();
        httpServer.close(() => resolve());
      })
  };
}

// The phone side over a real socket: run the handshake, auth with `token`, then
// collect decrypted app frames and every raw text frame seen on the wire.
function connectPhone(url: string, serverPubB64: string, token: string) {
  const ws = new WebSocket(url);
  const ephemeral = nacl.box.keyPair();
  const shared = deriveSharedKey(
    ephemeral.secretKey,
    new Uint8Array(Buffer.from(serverPubB64, "base64"))
  );
  const decrypted: unknown[] = [];
  const rawWire: string[] = [];
  let ready = false;

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "e2ee_hello", key: Buffer.from(ephemeral.publicKey).toString("base64") }));
  });
  ws.on("message", (data: Buffer) => {
    const text = data.toString();
    rawWire.push(text);
    if (isHandshake(text)) {
      if (!ready && JSON.parse(text).type === "e2ee_ready") {
        ready = true;
        ws.send(sealFrame(shared, new TextEncoder().encode(JSON.stringify({ type: "e2ee_auth", token }))));
      }
      return;
    }
    decrypted.push(JSON.parse(new TextDecoder().decode(openFrame(shared, text))));
  });

  return {
    ws,
    decrypted,
    rawWire,
    waitForClose: () => new Promise<void>((resolve) => ws.on("close", () => resolve()))
  };
}

test("a phone drives a full encrypted session over a real WebSocket", async () => {
  const server = await startServer();
  after(() => server.close());

  const phone = connectPhone(server.url, server.serverPubB64, GOOD_TOKEN);
  // The first fleet is sent synchronously (empty) before the async reconcile;
  // wait for the populated broadcast that carries our seeded session.
  await waitUntil(() =>
    phone.decrypted.some(
      (m) => (m as { type?: string; sessions?: AgentSession[] }).type === "fleet" &&
        ((m as { sessions?: AgentSession[] }).sessions?.length ?? 0) > 0
    )
  );

  // The overview arrived, decrypted, with our seeded session.
  const fleet = [...phone.decrypted]
    .reverse()
    .find(
      (m) =>
        (m as { type?: string }).type === "fleet" &&
        ((m as { sessions?: AgentSession[] }).sessions?.length ?? 0) > 0
    ) as { sessions: AgentSession[] };
  ok(fleet, "received a populated fleet overview");
  strictEqual(fleet.sessions[0]?.id, "s1");

  // Everything after the handshake on the wire is ciphertext: no raw frame
  // parses to an app event, and the device token never appears in cleartext.
  const appWire = phone.rawWire.filter((t) => !isHandshake(t));
  ok(appWire.length > 0, "app frames were exchanged");
  for (const frame of appWire) {
    ok(!frame.includes("fleet"), "app frame is not plaintext JSON");
  }
  ok(!phone.rawWire.some((t) => t.includes(GOOD_TOKEN)), "device token never in cleartext");

  phone.ws.close();
});

test("a phone presenting an invalid token is closed and never becomes a client", async () => {
  const server = await startServer();
  after(() => server.close());

  const phone = connectPhone(server.url, server.serverPubB64, "wrong-token");
  await phone.waitForClose();
  strictEqual(server.monitor.clientCount(), 0);
});

function isHandshake(text: string): boolean {
  try {
    const type = (JSON.parse(text) as { type?: string }).type;
    return type === "e2ee_hello" || type === "e2ee_ready";
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
