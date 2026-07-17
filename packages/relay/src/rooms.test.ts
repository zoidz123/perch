import assert from "node:assert/strict";
import { test } from "node:test";
import { RelayRegistry, type FrameData, type RelaySocket } from "./rooms.js";

interface SentFrame {
  data: FrameData;
  isBinary: boolean;
}

class FakeSocket implements RelaySocket {
  sent: SentFrame[] = [];
  closed: { code: number; reason: string } | null = null;

  send(data: FrameData, isBinary: boolean): void {
    if (this.closed) throw new Error("send after close");
    this.sent.push({ data, isBinary });
  }

  close(code: number, reason = ""): void {
    if (!this.closed) this.closed = { code, reason };
  }

  /** JSON control notices are the only frames the relay itself generates. */
  notices(): unknown[] {
    return this.sent
      .filter((f) => typeof f.data === "string")
      .map((f) => JSON.parse(f.data as string));
  }
}

test("forwards a client frame to the matching data socket, verbatim", () => {
  const reg = new RelayRegistry();
  const control = new FakeSocket();
  const data = new FakeSocket();
  const client = new FakeSocket();

  reg.join({ serverId: "srvA", kind: "control", socket: control });
  reg.join({ serverId: "srvA", kind: "data", connectionId: "c1", socket: data });
  const clientMember = reg.join({ serverId: "srvA", kind: "client", connectionId: "c1", socket: client });

  clientMember.receive("hello-from-phone", false);

  assert.deepEqual(data.sent, [{ data: "hello-from-phone", isBinary: false }]);
});

test("forwards a data frame to every client socket on that connection", () => {
  const reg = new RelayRegistry();
  const clientA = new FakeSocket();
  const clientB = new FakeSocket();

  const dataMember = reg.join({ serverId: "srvA", kind: "data", connectionId: "c1", socket: new FakeSocket() });
  reg.join({ serverId: "srvA", kind: "client", connectionId: "c1", socket: clientA });
  reg.join({ serverId: "srvA", kind: "client", connectionId: "c1", socket: clientB });

  dataMember.receive("fleet-update", false);

  assert.deepEqual(clientA.sent, [{ data: "fleet-update", isBinary: false }]);
  assert.deepEqual(clientB.sent, [{ data: "fleet-update", isBinary: false }]);
});

test("relays arbitrary opaque bytes without inspecting them", () => {
  const reg = new RelayRegistry();
  const data = new FakeSocket();
  const client = new FakeSocket();

  reg.join({ serverId: "srvA", kind: "data", connectionId: "c1", socket: data });
  const clientMember = reg.join({ serverId: "srvA", kind: "client", connectionId: "c1", socket: client });

  // Bytes that are NOT valid UTF-8 and are NOT valid JSON: if the relay tried to
  // decode/parse the payload it would throw or mangle it. It must pass through untouched.
  const opaque = new Uint8Array([0x00, 0xff, 0xfe, 0x01, 0x80, 0x7f, 0x00]);
  clientMember.receive(opaque, true);

  assert.equal(data.sent.length, 1);
  assert.equal(data.sent[0].isBinary, true);
  assert.deepEqual(new Uint8Array(data.sent[0].data as Uint8Array), opaque);
});

test("two rooms are fully isolated - no cross-talk between serverIds", () => {
  const reg = new RelayRegistry();
  const dataA = new FakeSocket();
  const clientA = new FakeSocket();
  const dataB = new FakeSocket();
  const clientB = new FakeSocket();

  reg.join({ serverId: "srvA", kind: "data", connectionId: "c1", socket: dataA });
  const clientMemberA = reg.join({ serverId: "srvA", kind: "client", connectionId: "c1", socket: clientA });
  reg.join({ serverId: "srvB", kind: "data", connectionId: "c1", socket: dataB });
  const clientMemberB = reg.join({ serverId: "srvB", kind: "client", connectionId: "c1", socket: clientB });

  clientMemberA.receive("for-A", false);
  clientMemberB.receive("for-B", false);

  assert.deepEqual(dataA.sent, [{ data: "for-A", isBinary: false }]);
  assert.deepEqual(dataB.sent, [{ data: "for-B", isBinary: false }]);
});

test("buffers client frames until the data socket attaches, then flushes in order", () => {
  const reg = new RelayRegistry();
  const client = new FakeSocket();

  const clientMember = reg.join({ serverId: "srvA", kind: "client", connectionId: "c1", socket: client });
  clientMember.receive("f1", false);
  clientMember.receive("f2", false);

  const data = new FakeSocket();
  reg.join({ serverId: "srvA", kind: "data", connectionId: "c1", socket: data });

  assert.deepEqual(data.sent, [
    { data: "f1", isBinary: false },
    { data: "f2", isBinary: false },
  ]);
});

test("bounds the pending buffer so a never-attaching data socket cannot grow memory unbounded", () => {
  const reg = new RelayRegistry();
  const client = new FakeSocket();
  const clientMember = reg.join({ serverId: "srvA", kind: "client", connectionId: "c1", socket: client });

  for (let i = 0; i < 500; i++) clientMember.receive(`f${i}`, false);

  const data = new FakeSocket();
  reg.join({ serverId: "srvA", kind: "data", connectionId: "c1", socket: data });

  // Only the most recent 200 frames survive; oldest are dropped.
  assert.equal(data.sent.length, 200);
  assert.deepEqual(data.sent[0], { data: "f300", isBinary: false });
  assert.deepEqual(data.sent[199], { data: "f499", isBinary: false });
});

test("bounds the pending buffer by bytes so a few large frames cannot pin memory", () => {
  const reg = new RelayRegistry();
  const clientMember = reg.join({ serverId: "srvA", kind: "client", connectionId: "c1", socket: new FakeSocket() });

  // Two 600 KiB frames exceed the 1 MiB byte cap long before the 200-frame cap.
  const big = "x".repeat(600 * 1024);
  clientMember.receive(big, false);
  clientMember.receive(big, false);
  clientMember.receive("tail", false);

  const data = new FakeSocket();
  reg.join({ serverId: "srvA", kind: "data", connectionId: "c1", socket: data });

  // The oldest big frame was dropped; the newest big frame and the tail survive.
  assert.equal(data.sent.length, 2);
  assert.equal((data.sent[0].data as string).length, big.length);
  assert.deepEqual(data.sent[1], { data: "tail", isBinary: false });
});

test("control receives a sync of connected connectionIds when it joins", () => {
  const reg = new RelayRegistry();
  reg.join({ serverId: "srvA", kind: "client", connectionId: "c1", socket: new FakeSocket() });
  reg.join({ serverId: "srvA", kind: "client", connectionId: "c2", socket: new FakeSocket() });

  const control = new FakeSocket();
  reg.join({ serverId: "srvA", kind: "control", socket: control });

  const sync = control.notices()[0] as { type: string; connectionIds: string[] };
  assert.equal(sync.type, "sync");
  assert.deepEqual([...sync.connectionIds].sort(), ["c1", "c2"]);
});

test("control is notified when a client connects and disconnects", () => {
  const reg = new RelayRegistry();
  const control = new FakeSocket();
  reg.join({ serverId: "srvA", kind: "control", socket: control });

  const clientMember = reg.join({ serverId: "srvA", kind: "client", connectionId: "c1", socket: new FakeSocket() });
  clientMember.disconnect(1000, "gone");

  const notices = control.notices();
  assert.deepEqual(notices[0], { type: "sync", connectionIds: [] });
  assert.deepEqual(notices[1], { type: "connected", connectionId: "c1" });
  assert.deepEqual(notices[2], { type: "disconnected", connectionId: "c1" });
});

test("a new control socket replaces the old one with close code 1008", () => {
  const reg = new RelayRegistry();
  const oldControl = new FakeSocket();
  const newControl = new FakeSocket();

  reg.join({ serverId: "srvA", kind: "control", socket: oldControl });
  reg.join({ serverId: "srvA", kind: "control", socket: newControl });

  assert.deepEqual(oldControl.closed, { code: 1008, reason: "Replaced by new connection" });
  assert.equal(newControl.closed, null);
});

test("a new data socket for a connection replaces the old one with close code 1008", () => {
  const reg = new RelayRegistry();
  const oldData = new FakeSocket();
  const newData = new FakeSocket();

  reg.join({ serverId: "srvA", kind: "data", connectionId: "c1", socket: oldData });
  reg.join({ serverId: "srvA", kind: "data", connectionId: "c1", socket: newData });

  assert.deepEqual(oldData.closed, { code: 1008, reason: "Replaced by new connection" });
  assert.equal(newData.closed, null);
});

test("when the data socket drops, its client sockets are closed with 1012 so they re-handshake", () => {
  const reg = new RelayRegistry();
  const client = new FakeSocket();
  reg.join({ serverId: "srvA", kind: "client", connectionId: "c1", socket: client });
  const dataMember = reg.join({ serverId: "srvA", kind: "data", connectionId: "c1", socket: new FakeSocket() });

  dataMember.disconnect(1006, "server dropped");

  assert.deepEqual(client.closed, { code: 1012, reason: "Server disconnected" });
});

test("when the last client for a connection drops, the data socket is closed with 1001", () => {
  const reg = new RelayRegistry();
  const data = new FakeSocket();
  reg.join({ serverId: "srvA", kind: "data", connectionId: "c1", socket: data });
  const clientMember = reg.join({ serverId: "srvA", kind: "client", connectionId: "c1", socket: new FakeSocket() });

  clientMember.disconnect(1000, "phone gone");

  assert.deepEqual(data.closed, { code: 1001, reason: "Client disconnected" });
});

test("the control socket answers an application-level ping with a pong", () => {
  const reg = new RelayRegistry();
  const control = new FakeSocket();
  const controlMember = reg.join({ serverId: "srvA", kind: "control", socket: control });

  // The `sync` sent on join is the first notice; the server's liveness heartbeat
  // then arrives as an inbound control frame.
  controlMember.receive(JSON.stringify({ type: "ping" }), false);

  const notices = control.notices();
  assert.deepEqual(notices[0], { type: "sync", connectionIds: [] });
  assert.deepEqual(notices[1], { type: "pong" });
});

test("the control socket answers a ping delivered as bytes (as the transport normalizes it)", () => {
  const reg = new RelayRegistry();
  const control = new FakeSocket();
  const controlMember = reg.join({ serverId: "srvA", kind: "control", socket: control });

  // The real transport (`server.ts`) hands text frames to the router as a Buffer,
  // not a string. The heartbeat must still be recognized.
  controlMember.receive(new TextEncoder().encode(JSON.stringify({ type: "ping" })), false);

  assert.deepEqual(control.notices()[1], { type: "pong" });
});

test("a client waiting without data triggers a full sync and resets control", async () => {
  const reg = new RelayRegistry();
  const control = new FakeSocket();
  reg.join({ serverId: "srvA", kind: "control", socket: control });
  reg.join({ serverId: "srvA", kind: "client", connectionId: "c1", socket: new FakeSocket() });

  await new Promise((resolve) => setTimeout(resolve, 1600));

  const notices = control.notices();
  assert.deepEqual(notices[0], { type: "sync", connectionIds: [] });
  assert.deepEqual(notices[1], { type: "connected", connectionId: "c1" });
  assert.deepEqual(notices[2], { type: "sync", connectionIds: ["c1"] });
  assert.deepEqual(control.closed, { code: 1012, reason: "Data socket did not attach" });
});

test("the client-waiting watchdog clears once data attaches", async () => {
  const reg = new RelayRegistry();
  const control = new FakeSocket();
  reg.join({ serverId: "srvA", kind: "control", socket: control });
  reg.join({ serverId: "srvA", kind: "client", connectionId: "c1", socket: new FakeSocket() });
  reg.join({ serverId: "srvA", kind: "data", connectionId: "c1", socket: new FakeSocket() });

  await new Promise((resolve) => setTimeout(resolve, 1600));

  assert.equal(control.closed, null);
  assert.deepEqual(control.notices(), [
    { type: "sync", connectionIds: [] },
    { type: "connected", connectionId: "c1" }
  ]);
});

test("the control socket ignores non-ping payloads and never echoes opaque bytes", () => {
  const reg = new RelayRegistry();
  const control = new FakeSocket();
  const controlMember = reg.join({ serverId: "srvA", kind: "control", socket: control });

  controlMember.receive(JSON.stringify({ type: "sync" }), false); // not a ping
  controlMember.receive("not json at all", false);
  controlMember.receive(new Uint8Array([0x00, 0xff, 0x01]), true); // binary is never parsed

  // Only the join `sync` was ever sent; no pong, no echo.
  assert.deepEqual(control.notices(), [{ type: "sync", connectionIds: [] }]);
});

test("a room is discarded once every socket has left (nothing persists)", () => {
  const reg = new RelayRegistry();
  const control = new FakeSocket();
  const controlMember = reg.join({ serverId: "srvA", kind: "control", socket: control });
  const clientMember = reg.join({ serverId: "srvA", kind: "client", connectionId: "c1", socket: new FakeSocket() });
  const dataMember = reg.join({ serverId: "srvA", kind: "data", connectionId: "c1", socket: new FakeSocket() });

  assert.equal(reg.roomCount(), 1);
  clientMember.disconnect(1000, "x");
  dataMember.disconnect(1000, "x");
  controlMember.disconnect(1000, "x");
  assert.equal(reg.roomCount(), 0);
});
