import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { startRelayServer, type RelayServer } from "./server.js";

/** A ws client with an async message queue, so tests can await frames in order. */
class TestClient {
  readonly ws: WebSocket;
  private readonly queue: Array<{ data: Buffer; isBinary: boolean }> = [];
  private waiter: ((v: { data: Buffer; isBinary: boolean }) => void) | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url, { rejectUnauthorized: false });
    this.ws.on("message", (data: Buffer, isBinary: boolean) => {
      const frame = { data: Buffer.isBuffer(data) ? data : Buffer.from(data), isBinary };
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(frame);
      } else {
        this.queue.push(frame);
      }
    });
  }

  open(): Promise<unknown> {
    return once(this.ws, "open");
  }

  next(): Promise<{ data: Buffer; isBinary: boolean }> {
    const buffered = this.queue.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  async nextJson<T = unknown>(): Promise<T> {
    const frame = await this.next();
    return JSON.parse(frame.data.toString("utf8")) as T;
  }

  send(data: string | Buffer): void {
    this.ws.send(data);
  }

  close(): void {
    this.ws.close();
  }
}

const servers: RelayServer[] = [];
async function relay(): Promise<RelayServer> {
  const server = await startRelayServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  return server;
}

function httpUrl(server: RelayServer, path: string): string {
  return new URL(path, server.url.replace(/^ws/, "http")).toString();
}

after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

function wsUrl(server: RelayServer, params: Record<string, string>): string {
  const u = new URL(server.url);
  u.pathname = "/ws";
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

test("GET /health returns ok", async () => {
  const server = await relay();
  const res = await fetch(httpUrl(server, "/health"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("rejects a WS upgrade with a missing serverId", async () => {
  const server = await relay();
  const ws = new WebSocket(wsUrl(server, { role: "client" }));
  const [err] = (await once(ws, "error")) as [Error];
  assert.match(err.message, /400/);
});

test("rejects a WS upgrade with an invalid role", async () => {
  const server = await relay();
  const ws = new WebSocket(wsUrl(server, { serverId: "s1", role: "bogus" }));
  const [err] = (await once(ws, "error")) as [Error];
  assert.match(err.message, /400/);
});

test("forwards frames both directions between paired sockets in the same room", async () => {
  const server = await relay();
  const control = new TestClient(wsUrl(server, { serverId: "s1", role: "server" }));
  await control.open();

  const client = new TestClient(wsUrl(server, { serverId: "s1", role: "client", connectionId: "c1" }));
  await client.open();

  // control receives a sync (on join) then a connected notice for the client.
  const sync = await control.nextJson<{ type: string }>();
  assert.equal(sync.type, "sync");
  const connected = await control.nextJson<{ type: string; connectionId: string }>();
  assert.deepEqual(connected, { type: "connected", connectionId: "c1" });

  // The server opens the matching data socket.
  const data = new TestClient(wsUrl(server, { serverId: "s1", role: "server", connectionId: "c1" }));
  await data.open();

  // client -> data
  client.send("phone->server");
  const gotByData = await data.next();
  assert.equal(gotByData.data.toString("utf8"), "phone->server");

  // data -> client
  data.send("server->phone");
  const gotByClient = await client.next();
  assert.equal(gotByClient.data.toString("utf8"), "server->phone");
});

test("keeps two rooms isolated - a client never sees another room's traffic", async () => {
  const server = await relay();
  const dataA = new TestClient(wsUrl(server, { serverId: "roomA", role: "server", connectionId: "c1" }));
  const clientA = new TestClient(wsUrl(server, { serverId: "roomA", role: "client", connectionId: "c1" }));
  const dataB = new TestClient(wsUrl(server, { serverId: "roomB", role: "server", connectionId: "c1" }));
  const clientB = new TestClient(wsUrl(server, { serverId: "roomB", role: "client", connectionId: "c1" }));
  await Promise.all([dataA.open(), clientA.open(), dataB.open(), clientB.open()]);

  dataA.send("only-for-A");
  dataB.send("only-for-B");

  assert.equal((await clientA.next()).data.toString("utf8"), "only-for-A");
  assert.equal((await clientB.next()).data.toString("utf8"), "only-for-B");
});

test("forwards arbitrary opaque bytes end-to-end without inspecting them", async () => {
  const server = await relay();
  const data = new TestClient(wsUrl(server, { serverId: "s1", role: "server", connectionId: "c1" }));
  const client = new TestClient(wsUrl(server, { serverId: "s1", role: "client", connectionId: "c1" }));
  await Promise.all([data.open(), client.open()]);

  const opaque = Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x80, 0x7f, 0x2a]);
  client.send(opaque);

  const got = await data.next();
  assert.equal(got.isBinary, true);
  assert.deepEqual(got.data, opaque);
});

test("the relay assigns a connectionId to a client that omits one and syncs it to control", async () => {
  const server = await relay();
  const control = new TestClient(wsUrl(server, { serverId: "s1", role: "server" }));
  await control.open();
  await control.nextJson(); // initial empty sync

  const client = new TestClient(wsUrl(server, { serverId: "s1", role: "client" }));
  await client.open();

  const connected = await control.nextJson<{ type: string; connectionId: string }>();
  assert.equal(connected.type, "connected");
  assert.ok(connected.connectionId.length > 0);
});

test("rejects an oversized serverId query param (malformed input)", async () => {
  const server = await relay();
  const ws = new WebSocket(wsUrl(server, { serverId: "x".repeat(500), role: "client" }));
  const [err] = (await once(ws, "error")) as [Error];
  assert.match(err.message, /400/);
});

test("rejects an oversized connectionId query param (malformed input)", async () => {
  const server = await relay();
  const ws = new WebSocket(wsUrl(server, { serverId: "s1", role: "client", connectionId: "y".repeat(500) }));
  const [err] = (await once(ws, "error")) as [Error];
  assert.match(err.message, /400/);
});

test("caps the number of sockets in a single room so one room cannot exhaust the relay", async () => {
  const server = await startRelayServer({ host: "127.0.0.1", port: 0, maxSocketsPerRoom: 2 });
  servers.push(server);
  const a = new TestClient(wsUrl(server, { serverId: "s1", role: "server", connectionId: "c1" }));
  const b = new TestClient(wsUrl(server, { serverId: "s1", role: "client", connectionId: "c1" }));
  await Promise.all([a.open(), b.open()]);

  // The third socket for this room is refused.
  const over = new WebSocket(wsUrl(server, { serverId: "s1", role: "client", connectionId: "c2" }));
  const [err] = (await once(over, "error")) as [Error];
  assert.match(err.message, /503/);

  // A socket closing frees a slot again.
  b.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const rejoin = new TestClient(wsUrl(server, { serverId: "s1", role: "client", connectionId: "c3" }));
  await rejoin.open();
});

test("caps the total number of rooms so unbounded rooms cannot be created", async () => {
  const server = await startRelayServer({ host: "127.0.0.1", port: 0, maxRooms: 1 });
  servers.push(server);
  const a = new TestClient(wsUrl(server, { serverId: "roomA", role: "server" }));
  await a.open();

  const b = new WebSocket(wsUrl(server, { serverId: "roomB", role: "server" }));
  const [err] = (await once(b, "error")) as [Error];
  assert.match(err.message, /503/);
});

test("closes a connection that sends a frame larger than maxPayload (1009 Message Too Big)", async () => {
  const server = await startRelayServer({ host: "127.0.0.1", port: 0, maxPayloadBytes: 1024 });
  servers.push(server);
  const client = new TestClient(wsUrl(server, { serverId: "s1", role: "client", connectionId: "c1" }));
  await client.open();

  client.send(Buffer.alloc(4096));

  const [code] = (await once(client.ws, "close")) as [number];
  assert.equal(code, 1009);
});

test("caps concurrent connections from a single IP with 429", async () => {
  const server = await startRelayServer({ host: "127.0.0.1", port: 0, maxConnectionsPerIp: 2 });
  servers.push(server);
  const a = new TestClient(wsUrl(server, { serverId: "s1", role: "client", connectionId: "c1" }));
  const b = new TestClient(wsUrl(server, { serverId: "s1", role: "client", connectionId: "c2" }));
  await Promise.all([a.open(), b.open()]);

  // The third concurrent socket from 127.0.0.1 is refused.
  const over = new WebSocket(wsUrl(server, { serverId: "s1", role: "client", connectionId: "c3" }));
  const [err] = (await once(over, "error")) as [Error];
  assert.match(err.message, /429/);

  // Closing a socket frees the per-IP slot again.
  b.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const rejoin = new TestClient(wsUrl(server, { serverId: "s1", role: "client", connectionId: "c4" }));
  await rejoin.open();
});

test("rate-limits new connections per IP per minute with 429", async () => {
  const server = await startRelayServer({ host: "127.0.0.1", port: 0, connectionsPerIpPerMinute: 3 });
  servers.push(server);
  // Three connections fit the window; closing them does NOT refund the rate budget.
  for (let i = 0; i < 3; i++) {
    const c = new TestClient(wsUrl(server, { serverId: "s1", role: "client", connectionId: `c${i}` }));
    await c.open();
    c.close();
  }

  const over = new WebSocket(wsUrl(server, { serverId: "s1", role: "client", connectionId: "c9" }));
  const [err] = (await once(over, "error")) as [Error];
  assert.match(err.message, /429/);
});

test("rate-limits new-room creation per IP but keeps existing rooms joinable", async () => {
  const server = await startRelayServer({ host: "127.0.0.1", port: 0, roomsPerIpPerMinute: 2 });
  servers.push(server);
  const roomA = new TestClient(wsUrl(server, { serverId: "roomA", role: "server" }));
  const roomB = new TestClient(wsUrl(server, { serverId: "roomB", role: "server" }));
  await Promise.all([roomA.open(), roomB.open()]);

  // A third NEW room from the same IP is refused...
  const over = new WebSocket(wsUrl(server, { serverId: "roomC", role: "server" }));
  const [err] = (await once(over, "error")) as [Error];
  assert.match(err.message, /429/);

  // ...but joining an already-live room is not room creation and still works.
  const joinExisting = new TestClient(wsUrl(server, { serverId: "roomA", role: "client", connectionId: "c1" }));
  await joinExisting.open();
});

test("trustProxy keys the per-IP limits by X-Forwarded-For, not the proxy socket", async () => {
  const server = await startRelayServer({ host: "127.0.0.1", port: 0, maxConnectionsPerIp: 1, trustProxy: true });
  servers.push(server);

  // Two clients behind the same proxy socket but with different forwarded IPs both fit.
  const first = new WebSocket(wsUrl(server, { serverId: "s1", role: "client", connectionId: "c1" }), {
    headers: { "x-forwarded-for": "203.0.113.1" },
  });
  await once(first, "open");
  const second = new WebSocket(wsUrl(server, { serverId: "s1", role: "client", connectionId: "c2" }), {
    headers: { "x-forwarded-for": "203.0.113.2" },
  });
  await once(second, "open");

  // A second concurrent socket from the SAME forwarded IP is over the cap.
  const over = new WebSocket(wsUrl(server, { serverId: "s1", role: "client", connectionId: "c3" }), {
    headers: { "x-forwarded-for": "203.0.113.1" },
  });
  const [err] = (await once(over, "error")) as [Error];
  assert.match(err.message, /429/);
  first.close();
  second.close();
});

test("a healthy peer survives repeated heartbeat cycles (idle reaper never cuts a live socket)", async () => {
  const server = await startRelayServer({
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 20,
    idleTimeoutMs: 1000
  });
  servers.push(server);
  const data = new TestClient(wsUrl(server, { serverId: "s1", role: "server", connectionId: "c1" }));
  const client = new TestClient(wsUrl(server, { serverId: "s1", role: "client", connectionId: "c1" }));
  await Promise.all([data.open(), client.open()]);

  // Several heartbeat ticks pass; a ponging (live) socket keeps its slot.
  await new Promise((resolve) => setTimeout(resolve, 150));
  client.send("still-here");
  assert.equal((await data.next()).data.toString("utf8"), "still-here");
});

/** Generate a throwaway self-signed cert for the TLS smoke test, or null if openssl is missing. */
function ephemeralCert(): { cert: Buffer; key: Buffer; dir: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "perch-relay-tls-"));
  try {
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", join(dir, "key.pem"),
        "-out", join(dir, "cert.pem"),
        "-days", "1", "-subj", "/CN=localhost",
      ],
      { stdio: "ignore" },
    );
    return { cert: readFileSync(join(dir, "cert.pem")), key: readFileSync(join(dir, "key.pem")), dir };
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

test("accepts TLS (wss) WebSocket connections and relays over them", async (t) => {
  const material = ephemeralCert();
  if (!material) return t.skip("openssl unavailable");
  t.after(() => rmSync(material.dir, { recursive: true, force: true }));

  const server = await startRelayServer({
    host: "127.0.0.1",
    port: 0,
    tls: { cert: material.cert, key: material.key },
  });
  servers.push(server);
  assert.match(server.url, /^wss:\/\//);

  const data = new TestClient(wsUrl(server, { serverId: "s1", role: "server", connectionId: "c1" }));
  const client = new TestClient(wsUrl(server, { serverId: "s1", role: "client", connectionId: "c1" }));
  await Promise.all([data.open(), client.open()]);

  client.send("over-tls");
  assert.equal((await data.next()).data.toString("utf8"), "over-tls");
});

test("survives a relay restart: nothing persists and both sides re-form the room", async () => {
  const first = await relay();
  const port = first.port;

  const data1 = new TestClient(wsUrl(first, { serverId: "s1", role: "server", connectionId: "c1" }));
  const client1 = new TestClient(wsUrl(first, { serverId: "s1", role: "client", connectionId: "c1" }));
  await Promise.all([data1.open(), client1.open()]);
  data1.send("before-restart");
  assert.equal((await client1.next()).data.toString("utf8"), "before-restart");

  // Kill the relay. Both sockets drop; the relay keeps nothing.
  await first.close();

  // A brand-new relay process on the same port has an empty registry.
  const second = await startRelayServer({ host: "127.0.0.1", port });
  servers.push(second);
  assert.equal(second.registry.roomCount(), 0);

  const data2 = new TestClient(wsUrl(second, { serverId: "s1", role: "server", connectionId: "c1" }));
  const client2 = new TestClient(wsUrl(second, { serverId: "s1", role: "client", connectionId: "c1" }));
  await Promise.all([data2.open(), client2.open()]);
  data2.send("after-restart");
  assert.equal((await client2.next()).data.toString("utf8"), "after-restart");
});
