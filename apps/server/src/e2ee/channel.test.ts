import { ok, rejects, strictEqual } from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import nacl from "tweetnacl";
import type { ClientAuth } from "../fleetMonitor.js";
import { deriveSharedKey, openFrame, sealFrame } from "./crypto.js";
import { EncryptedServerChannel } from "./channel.js";

// A minimal in-memory socket pair standing in for a ws.WebSocket. `send` on one
// end fires `message` on the other; either side can close. This lets the channel
// be exercised with no real network.
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  peer?: FakeSocket;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
    this.peer?.emit("message", Buffer.from(data));
  }
  close(): void {
    this.terminate();
  }
  terminate(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
    if (this.peer && this.peer.readyState !== 3) this.peer.terminate();
  }
}

function socketPair(): [FakeSocket, FakeSocket] {
  const a = new FakeSocket();
  const b = new FakeSocket();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

// Drives the phone side of the handshake against a server FakeSocket, mirroring
// what the real iOS EncryptedChannel does.
function phoneDriver(phoneEnd: FakeSocket, serverPubB64: string) {
  const ephemeral = nacl.box.keyPair();
  const shared = deriveSharedKey(
    ephemeral.secretKey,
    new Uint8Array(Buffer.from(serverPubB64, "base64"))
  );
  const decrypted: string[] = [];
  let ready = false;
  phoneEnd.on("message", (raw: Buffer) => {
    const text = raw.toString();
    // Recognize the plaintext handshake ack (possibly duplicated by a retry)
    // before treating anything as an encrypted frame, exactly as the real
    // client does.
    if (isReadyFrame(text)) {
      ready = true;
      return;
    }
    decrypted.push(new TextDecoder().decode(openFrame(shared, text)));
  });
  return {
    shared,
    decrypted,
    isReady: () => ready,
    hello() {
      phoneEnd.send(
        JSON.stringify({ type: "e2ee_hello", key: Buffer.from(ephemeral.publicKey).toString("base64") })
      );
    },
    sendPlaintext(plaintext: string) {
      phoneEnd.send(sealFrame(shared, new TextEncoder().encode(plaintext)));
    }
  };
}

const serverKeys = nacl.box.keyPair();
const serverPubB64 = Buffer.from(serverKeys.publicKey).toString("base64");
const goodToken = "valid-device-token";
const verify = (token: string): ClientAuth | undefined =>
  token === goodToken ? { kind: "device", deviceId: "dev-1" } : undefined;

test("handshake completes and a valid e2ee_auth resolves awaitAuth", async () => {
  const [serverEnd, phoneEnd] = socketPair();
  const channel = new EncryptedServerChannel(serverEnd, serverKeys.secretKey, verify);
  const phone = phoneDriver(phoneEnd, serverPubB64);

  const authPromise = channel.awaitAuth();
  phone.hello();
  // The channel must reply e2ee_ready.
  await tick();
  ok(phone.isReady(), "server replied e2ee_ready");

  phone.sendPlaintext(JSON.stringify({ type: "e2ee_auth", token: goodToken }));
  const auth = await authPromise;
  strictEqual(auth.kind, "device");
  strictEqual((auth as { deviceId: string }).deviceId, "dev-1");
});

test("an invalid device token rejects and closes the socket", async () => {
  const [serverEnd, phoneEnd] = socketPair();
  const channel = new EncryptedServerChannel(serverEnd, serverKeys.secretKey, verify);
  const phone = phoneDriver(phoneEnd, serverPubB64);

  const authPromise = channel.awaitAuth();
  phone.hello();
  await tick();
  phone.sendPlaintext(JSON.stringify({ type: "e2ee_auth", token: "wrong" }));

  await rejects(authPromise);
  strictEqual(serverEnd.readyState, 3, "server socket closed");
});

test("an app frame before e2ee_auth is refused and closes fatally", async () => {
  const [serverEnd, phoneEnd] = socketPair();
  const channel = new EncryptedServerChannel(serverEnd, serverKeys.secretKey, verify);
  const phone = phoneDriver(phoneEnd, serverPubB64);

  const authPromise = channel.awaitAuth();
  phone.hello();
  await tick();
  // A non-auth app frame arrives first.
  phone.sendPlaintext(JSON.stringify({ type: "subscribe", sessionId: "s1" }));

  await rejects(authPromise);
  strictEqual(serverEnd.readyState, 3);
});

test("after auth, app frames decrypt to plaintext for the consumer and sends encrypt", async () => {
  const [serverEnd, phoneEnd] = socketPair();
  const channel = new EncryptedServerChannel(serverEnd, serverKeys.secretKey, verify);
  const phone = phoneDriver(phoneEnd, serverPubB64);

  const authPromise = channel.awaitAuth();
  phone.hello();
  await tick();
  phone.sendPlaintext(JSON.stringify({ type: "e2ee_auth", token: goodToken }));
  await authPromise;

  // Consumer (FleetMonitor stand-in) attaches its plaintext message handler.
  const received: string[] = [];
  channel.on("message", (raw) => received.push(raw.toString()));

  phone.sendPlaintext(JSON.stringify({ type: "input", sessionId: "s1", data: "ls\n" }));
  await tick();
  strictEqual(received.length, 1);
  strictEqual(JSON.parse(received[0]).data, "ls\n");

  // Consumer sends plaintext; the phone must be able to decrypt it.
  channel.send(JSON.stringify({ type: "hello", at: "now" }));
  await tick();
  strictEqual(phone.decrypted.length, 1);
  strictEqual(JSON.parse(phone.decrypted[0]).type, "hello");
});

test("a re-hello with the SAME key is re-acked (phone retry), not fatal", async () => {
  const [serverEnd, phoneEnd] = socketPair();
  const channel = new EncryptedServerChannel(serverEnd, serverKeys.secretKey, verify);
  const phone = phoneDriver(phoneEnd, serverPubB64);

  channel.awaitAuth().catch(() => {});
  phone.hello();
  await tick();
  const readyCount = serverEnd.sent.filter((m) => m.includes("e2ee_ready")).length;
  strictEqual(readyCount, 1);

  phone.hello(); // duplicate hello, same ephemeral key
  await tick();
  const readyCount2 = serverEnd.sent.filter((m) => m.includes("e2ee_ready")).length;
  strictEqual(readyCount2, 2, "same-key re-hello is re-acked");
  strictEqual(serverEnd.readyState, 1, "socket stays open");
});

test("a re-hello with a DIFFERENT key closes fatally", async () => {
  const [serverEnd, phoneEnd] = socketPair();
  const channel = new EncryptedServerChannel(serverEnd, serverKeys.secretKey, verify);
  const authPromise = channel.awaitAuth();
  const phone = phoneDriver(phoneEnd, serverPubB64);

  phone.hello();
  await tick();
  // A second hello with a fresh, different key.
  const other = nacl.box.keyPair();
  phoneEnd.send(
    JSON.stringify({ type: "e2ee_hello", key: Buffer.from(other.publicKey).toString("base64") })
  );

  await rejects(authPromise);
  strictEqual(serverEnd.readyState, 3);
});

function isReadyFrame(text: string): boolean {
  try {
    return (JSON.parse(text) as { type?: string }).type === "e2ee_ready";
  } catch {
    return false;
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
