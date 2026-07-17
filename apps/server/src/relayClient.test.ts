import assert from "node:assert/strict";
import { after, test } from "node:test";
import nacl from "tweetnacl";
import { WebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { startRelayServer, type RelayServer } from "@perch/relay";
import type { ClientAuth, ClientSocket } from "./fleetMonitor.js";
import { deriveSharedKey, openFrame, sealFrame } from "./e2ee/crypto.js";
import { RelayClient } from "./relayClient.js";

// One shared server box keypair for the whole file; the phone simulator derives
// the same shared key from the public half exactly as the real iOS client does.
const serverKeys = nacl.box.keyPair();
const serverPublicB64 = Buffer.from(serverKeys.publicKey).toString("base64");

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// A recorded FleetMonitor client: the RelayClient hands us the plaintext-facing
// EncryptedServerChannel once auth resolves, exactly as monitor.addClient would.
type Registered = {
  socket: ClientSocket;
  auth: ClientAuth;
  received: string[];
  closed: boolean;
};

function recorder() {
  const clients: Registered[] = [];
  const addClient = (socket: ClientSocket, _sessionId: string | undefined, auth: ClientAuth): void => {
    const entry: Registered = { socket, auth, received: [], closed: false };
    socket.on("message", (raw) => entry.received.push(raw.toString()));
    socket.on("close", () => {
      entry.closed = true;
    });
    clients.push(entry);
  };
  return { clients, addClient };
}

// Simulates the phone: dials the relay as a client, runs the e2ee handshake with
// a fresh ephemeral keypair, authorizes with a device token, then exposes send /
// receive of encrypted app frames.
function makePhone(relayUrl: string, serverId: string, token: string) {
  const ephemeral = nacl.box.keyPair();
  const shared = deriveSharedKey(ephemeral.secretKey, serverKeys.publicKey);
  const ws = new WebSocket(`${relayUrl}/ws?serverId=${serverId}&role=client&v=2`);
  const received: string[] = [];
  let ready = false;
  let closed = false;
  let closeCode: number | undefined;

  const helloJson = JSON.stringify({
    type: "e2ee_hello",
    key: Buffer.from(ephemeral.publicKey).toString("base64")
  });

  ws.on("open", () => {
    ws.send(helloJson);
  });
  ws.on("message", (raw: Buffer) => {
    const text = raw.toString();
    if (text.includes("e2ee_ready")) {
      if (!ready) {
        ready = true;
        // First encrypted frame after the handshake authorizes the device.
        ws.send(sealFrame(shared, new TextEncoder().encode(JSON.stringify({ type: "e2ee_auth", token }))));
      }
      return;
    }
    received.push(new TextDecoder().decode(openFrame(shared, text)));
  });
  ws.on("close", (code: number) => {
    closed = true;
    closeCode = code;
  });

  return {
    isReady: () => ready,
    isClosed: () => closed,
    closeCode: () => closeCode,
    received,
    sendApp(plaintext: string): void {
      ws.send(sealFrame(shared, new TextEncoder().encode(plaintext)));
    },
    close(): void {
      ws.close();
    }
  };
}

test("relay client attaches an authorized phone as a fleet client and bridges frames", async () => {
  const relay = await startRelayServer({ port: 0, host: "127.0.0.1" });
  const serverId = "room-attach";
  const { clients, addClient } = recorder();
  const client = new RelayClient({
    url: relay.url,
    serverId,
    secretKey: serverKeys.secretKey,
    verifyToken: (token) => (token === "good-token" ? { kind: "device", deviceId: "dev-1" } : undefined),
    addClient
  });
  client.start();

  const phone = makePhone(relay.url, serverId, "good-token");
  await waitFor(() => clients.length === 1);
  assert.deepEqual(clients[0].auth, { kind: "device", deviceId: "dev-1" });
  await waitFor(() => phone.isReady());

  // Server -> phone: the channel encrypts, the relay forwards opaque bytes.
  clients[0].socket.send(JSON.stringify({ type: "hello", at: "now" }));
  await waitFor(() => phone.received.some((frame) => frame.includes("hello")));

  // Phone -> server: the channel decrypts to plaintext for the monitor.
  phone.sendApp(JSON.stringify({ type: "subscribe", sessionId: "s1" }));
  await waitFor(() => clients[0].received.some((frame) => frame.includes("subscribe")));

  client.stop();
  await relay.close();
});

test("a phone with a revoked token never becomes a client and is cut", async () => {
  const relay = await startRelayServer({ port: 0, host: "127.0.0.1" });
  const serverId = "room-revoked";
  const { clients, addClient } = recorder();
  const client = new RelayClient({
    url: relay.url,
    serverId,
    secretKey: serverKeys.secretKey,
    // Every token is rejected: models a device that has been revoked.
    verifyToken: () => undefined,
    addClient
  });
  client.start();

  const phone = makePhone(relay.url, serverId, "revoked-token");
  // The channel refuses the auth frame and closes the data socket; the relay
  // then closes the phone's client socket. It never becomes a fleet client.
  await waitFor(() => phone.isClosed());
  assert.equal(clients.length, 0);

  client.stop();
  await relay.close();
});

test("a disconnected phone drops its server-side channel", async () => {
  const relay = await startRelayServer({ port: 0, host: "127.0.0.1" });
  const serverId = "room-disconnect";
  const { clients, addClient } = recorder();
  const client = new RelayClient({
    url: relay.url,
    serverId,
    secretKey: serverKeys.secretKey,
    verifyToken: () => ({ kind: "device", deviceId: "dev-1" }),
    addClient
  });
  client.start();

  const phone = makePhone(relay.url, serverId, "good");
  await waitFor(() => clients.length === 1);

  phone.close();
  await waitFor(() => clients[0].closed);

  client.stop();
  await relay.close();
});

test("revoking a live device cuts its relay socket end-to-end", async () => {
  const relay = await startRelayServer({ port: 0, host: "127.0.0.1" });
  const serverId = "room-revoke-live";
  const { clients, addClient } = recorder();
  const revoked = new Set<string>();
  const client = new RelayClient({
    url: relay.url,
    serverId,
    secretKey: serverKeys.secretKey,
    verifyToken: (token) => (revoked.has(token) ? undefined : { kind: "device", deviceId: "dev-1" }),
    addClient
  });
  client.start();

  const phone = makePhone(relay.url, serverId, "live-token");
  await waitFor(() => clients.length === 1);

  // Revoke mid-session, then terminate the live socket the way FleetMonitor's
  // disconnectDevice does. The phone's relay socket must drop.
  revoked.add("live-token");
  clients[0].socket.terminate();
  await waitFor(() => phone.isClosed());
  assert.equal(clients[0].closed, true);

  // A revoked device re-dialing is refused: the new auth fails verify.
  const before = clients.length;
  const retry = makePhone(relay.url, serverId, "live-token");
  await waitFor(() => retry.isClosed());
  assert.equal(clients.length, before, "revoked re-dial never becomes a client");

  client.stop();
  await relay.close();
});

test("disconnectDevice severs an authorized device's relay data socket and spares others", async () => {
  const relay = await startRelayServer({ port: 0, host: "127.0.0.1" });
  const serverId = "room-disconnect-device";
  const { clients, addClient } = recorder();
  const client = new RelayClient({
    url: relay.url,
    serverId,
    secretKey: serverKeys.secretKey,
    verifyToken: (token) => ({ kind: "device", deviceId: token === "b-token" ? "dev-b" : "dev-a" }),
    addClient
  });
  client.start();

  const phoneA = makePhone(relay.url, serverId, "a-token");
  const phoneB = makePhone(relay.url, serverId, "b-token");
  await waitFor(() => clients.length === 2);
  const clientA = clients.find((c) => c.auth.kind === "device" && c.auth.deviceId === "dev-a");
  const clientB = clients.find((c) => c.auth.kind === "device" && c.auth.deviceId === "dev-b");
  assert.ok(clientA && clientB);

  // Revoking an unknown device is a no-op.
  client.disconnectDevice("dev-unknown");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(clientA.closed, false);
  assert.equal(clientB.closed, false);

  // Severing dev-a cuts its relay data socket (its phone drops) without touching dev-b.
  client.disconnectDevice("dev-a");
  await waitFor(() => phoneA.isClosed());
  assert.equal(clientA.closed, true, "the revoked device's channel closed");
  assert.equal(clientB.closed, false, "a different device stays connected");
  assert.equal(phoneB.isClosed(), false);

  client.stop();
  await relay.close();
});

test("app-level heartbeat detects a dead origin an edge keeps protocol-ping-alive", async () => {
  // Reproduce the silent-stale failure: the origin relay has lost the room (a
  // Railway redeploy / crash wiped its in-memory rooms), but the edge proxy in
  // front of it keeps the control socket up and AUTO-ANSWERS WebSocket protocol
  // pings without ever reaching the origin. The `ws` server here plays that edge:
  // it accepts the control socket, sends the initial `sync`, auto-answers protocol
  // pings (ws does this per RFC6455), but NEVER answers the application-level
  // {type:"ping"} heartbeat - exactly what a dead origin behind a live edge looks
  // like. The fix must notice the missing app-level pong and reconnect.
  const controlSockets: WebSocket[] = [];
  const appPingsSeen: number[] = [];
  const edge = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => edge.once("listening", () => resolve()));
  const port = (edge.address() as AddressInfo).port;

  edge.on("connection", (ws, req) => {
    const params = new URL(req.url ?? "/", "http://x").searchParams;
    // Only the control socket (role=server, no connectionId) matters here.
    if (params.get("role") !== "server" || params.get("connectionId")) return;
    const index = controlSockets.push(ws) - 1;
    // Behave like the real relay on join, then go silent: send sync once.
    ws.send(JSON.stringify({ type: "sync", connectionIds: [] }));
    ws.on("message", (raw: Buffer) => {
      // The edge forwards app-level messages to the origin - but the origin is
      // dead, so nothing ever replies. Record the ping to prove it was sent (and
      // deliberately DROP it: no {type:"pong"} goes back).
      try {
        if ((JSON.parse(raw.toString()) as { type?: string }).type === "ping") {
          appPingsSeen.push(index);
        }
      } catch {
        // ignore
      }
    });
    // `ws` auto-answers protocol pings (ws.ping() from the client) with a pong,
    // just like the edge - so the OLD, protocol-pong-based liveness would stay
    // fresh forever and never reconnect.
  });

  const client = new RelayClient({
    url: `ws://127.0.0.1:${port}`,
    serverId: "room-dead-origin",
    secretKey: serverKeys.secretKey,
    verifyToken: () => ({ kind: "device", deviceId: "dev-1" }),
    addClient: () => {},
    backoffBaseMs: 20,
    backoffMaxMs: 40,
    pingMs: 30,
    staleMs: 150
  });
  client.start();

  // Staleness trips within staleMs and forces a reconnect: a SECOND control
  // socket appears even though the edge kept answering protocol pings the whole
  // time. (On the pre-fix code this stays at 1 forever and the test times out.)
  await waitFor(() => controlSockets.length >= 2, 3000);
  assert.ok(appPingsSeen.length > 0, "the server sent an application-level heartbeat");
  await waitFor(() => controlSockets[0].readyState === WebSocket.CLOSED, 1000);

  client.stop();
  await new Promise<void>((resolve) => edge.close(() => resolve()));
});

test("a live origin answering app-level pings is never falsely reconnected", async () => {
  // The mirror image of the dead-origin test: an origin that DOES answer the
  // application-level {type:"ping"} with {type:"pong"} (as the real relay now
  // does) must keep a quiet control socket alive across many stale windows, with
  // no reconnect churn. Guards against a false-positive that would break the
  // healthy LAN/relay path.
  const controlSockets: WebSocket[] = [];
  const edge = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => edge.once("listening", () => resolve()));
  const port = (edge.address() as AddressInfo).port;

  edge.on("connection", (ws, req) => {
    const params = new URL(req.url ?? "/", "http://x").searchParams;
    if (params.get("role") !== "server" || params.get("connectionId")) return;
    controlSockets.push(ws);
    ws.send(JSON.stringify({ type: "sync", connectionIds: [] }));
    ws.on("message", (raw: Buffer) => {
      try {
        if ((JSON.parse(raw.toString()) as { type?: string }).type === "ping") {
          ws.send(JSON.stringify({ type: "pong" })); // a live origin answers
        }
      } catch {
        // ignore
      }
    });
  });

  const client = new RelayClient({
    url: `ws://127.0.0.1:${port}`,
    serverId: "room-live-origin",
    secretKey: serverKeys.secretKey,
    verifyToken: () => ({ kind: "device", deviceId: "dev-1" }),
    addClient: () => {},
    backoffBaseMs: 20,
    backoffMaxMs: 40,
    pingMs: 30,
    staleMs: 150
  });
  client.start();

  await waitFor(() => controlSockets.length === 1);
  // Span several stale windows; the answered heartbeat must keep the one socket
  // alive with zero reconnects.
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(controlSockets.length, 1, "no reconnect churn on a healthy origin");
  assert.equal(controlSockets[0].readyState, WebSocket.OPEN, "the control socket stays open");

  client.stop();
  await new Promise<void>((resolve) => edge.close(() => resolve()));
});

test("against the real relay, an answered heartbeat keeps a quiet control socket registered", async () => {
  // Full-stack guard: the heartbeat travels client -> real relay transport
  // (`server.ts` normalizes every text frame to a Buffer) -> room router, which
  // must recognize the {type:"ping"} bytes and answer {type:"pong"}. If the pong
  // did not round-trip, a QUIET room (no phone traffic to refresh liveness) would
  // false-trip staleness every staleMs and re-dial the control socket. So a stable
  // control-dial count across several stale windows proves the pong round-trips.
  const relay = await startRelayServer({ port: 0, host: "127.0.0.1" });
  let controlDials = 0;
  const client = new RelayClient({
    url: relay.url,
    serverId: "room-quiet",
    secretKey: serverKeys.secretKey,
    verifyToken: () => ({ kind: "device", deviceId: "dev-1" }),
    addClient: () => {},
    connect: (url) => {
      if (url.includes("role=server") && !url.includes("connectionId")) controlDials++;
      return new WebSocket(url);
    },
    backoffBaseMs: 20,
    backoffMaxMs: 40,
    pingMs: 30,
    staleMs: 150
  });
  client.start();

  await waitFor(() => controlDials === 1);
  // Span several stale windows with no phone activity.
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(controlDials, 1, "the answered heartbeat prevents false-stale reconnects");

  client.stop();
  await relay.close();
});

test("the control socket reconnects and re-forms the room after a relay restart", async () => {
  let relay: RelayServer = await startRelayServer({ port: 3971, host: "127.0.0.1" });
  const serverId = "room-restart";
  const { clients, addClient } = recorder();
  const client = new RelayClient({
    url: "ws://127.0.0.1:3971",
    serverId,
    secretKey: serverKeys.secretKey,
    verifyToken: () => ({ kind: "device", deviceId: "dev-1" }),
    addClient,
    backoffBaseMs: 50,
    backoffMaxMs: 200
  });
  client.start();

  const phone1 = makePhone("ws://127.0.0.1:3971", serverId, "t");
  await waitFor(() => clients.length === 1);

  // Relay restarts on the same port: every socket drops.
  await relay.close();
  phone1.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  relay = await startRelayServer({ port: 3971, host: "127.0.0.1" });

  // The reconnect loop re-dials control; a fresh phone re-forms the room.
  const phone2 = makePhone("ws://127.0.0.1:3971", serverId, "t");
  await waitFor(() => clients.length === 2, 5000);
  await waitFor(() => phone2.isReady());

  client.stop();
  await relay.close();
});
