import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import nacl from "tweetnacl";
import { E2EE_VERSION } from "@perch/shared";
import {
  E2eeError,
  deriveSharedKey,
  openFrame,
  sealFrame,
  sealFrameWithNonce
} from "./crypto.js";

const here = dirname(fileURLToPath(import.meta.url));

// A matched server/phone pair with their precomputed shared keys. NaCl box is
// symmetric across the pair, so both derive the same key.
function pair() {
  const server = nacl.box.keyPair();
  const phone = nacl.box.keyPair();
  return {
    server,
    phone,
    serverShared: deriveSharedKey(server.secretKey, phone.publicKey),
    phoneShared: deriveSharedKey(phone.secretKey, server.publicKey)
  };
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);

test("shared key derivation is symmetric across the pair", () => {
  const { serverShared, phoneShared } = pair();
  deepStrictEqual([...serverShared], [...phoneShared]);
  strictEqual(serverShared.length, 32);
});

test("round-trips a payload sealed on one end and opened on the other", () => {
  const { serverShared, phoneShared } = pair();
  const frame = sealFrame(phoneShared, utf8("hello perch"));
  strictEqual(str(openFrame(serverShared, frame)), "hello perch");
});

test("a wrong key fails to open (bad MAC)", () => {
  const { phoneShared } = pair();
  const other = pair();
  const frame = sealFrame(phoneShared, utf8("secret"));
  throws(() => openFrame(other.serverShared, frame), (err: E2eeError) => err.code === "bad_mac");
});

test("tampered ciphertext fails to open (bad MAC)", () => {
  const { serverShared, phoneShared } = pair();
  const frame = sealFrame(phoneShared, utf8("integrity"));
  const bytes = Buffer.from(frame, "base64");
  bytes[bytes.length - 1] ^= 0x01; // flip a ciphertext bit
  const tampered = bytes.toString("base64");
  throws(() => openFrame(serverShared, tampered), (err: E2eeError) => err.code === "bad_mac");
});

test("a truncated frame is rejected", () => {
  const { serverShared, phoneShared } = pair();
  const frame = sealFrame(phoneShared, utf8("x"));
  const short = Buffer.from(frame, "base64").subarray(0, 10).toString("base64");
  throws(() => openFrame(serverShared, short), (err: E2eeError) => err.code === "truncated");
});

test("an unknown version byte is rejected", () => {
  const { serverShared, phoneShared } = pair();
  const bytes = Buffer.from(sealFrame(phoneShared, utf8("v")), "base64");
  bytes[0] = 0x02; // bump the version
  throws(
    () => openFrame(serverShared, bytes.toString("base64")),
    (err: E2eeError) => err.code === "bad_version"
  );
});

test("the version byte in a sealed frame is E2EE_VERSION", () => {
  const { phoneShared } = pair();
  const bytes = Buffer.from(sealFrame(phoneShared, utf8("v")), "base64");
  strictEqual(bytes[0], E2EE_VERSION);
});

test("the nonce is 24 bytes and differs across two seals of the same plaintext", () => {
  const { phoneShared } = pair();
  const a = Buffer.from(sealFrame(phoneShared, utf8("same")), "base64");
  const b = Buffer.from(sealFrame(phoneShared, utf8("same")), "base64");
  const nonceA = a.subarray(1, 25);
  const nonceB = b.subarray(1, 25);
  strictEqual(nonceA.length, 24);
  ok(!nonceA.equals(nonceB), "nonces are fresh per seal");
});

test("round-trips an empty payload", () => {
  const { serverShared, phoneShared } = pair();
  strictEqual(str(openFrame(serverShared, sealFrame(phoneShared, utf8("")))), "");
});

test("round-trips a large (>64 KiB) payload", () => {
  const { serverShared, phoneShared } = pair();
  const big = "A".repeat(70_000);
  strictEqual(str(openFrame(serverShared, sealFrame(phoneShared, utf8(big)))), big);
});

// The golden-vector gate: fixed keys + fixed nonce + fixed plaintext reproduce
// the exact committed frame, and every committed frame decrypts to its
// plaintext. These same vectors are the cross-language contract with Swift.
type Vector = {
  label: string;
  serverPub: string;
  serverSec: string;
  phonePub: string;
  phoneSec: string;
  nonce: string;
  plaintext: string;
  frame: string;
};

const vectors = JSON.parse(readFileSync(join(here, "vectors.json"), "utf8")) as Vector[];
const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

// The iOS parity harness ships its own copy of these vectors (SwiftPM cannot
// bundle a symlinked resource). This guard fails if the two ever drift, so the
// Swift parity test always runs the exact contract the TS side committed.
test("the iOS parity vectors match the server vectors byte-for-byte", () => {
  const iosVectors = join(here, "../../../ios/PerchParity/Tests/PerchE2EETests/vectors.json");
  strictEqual(readFileSync(iosVectors, "utf8"), readFileSync(join(here, "vectors.json"), "utf8"));
});

for (const v of vectors) {
  test(`golden vector [${v.label}] re-seals to the exact committed frame`, () => {
    const shared = deriveSharedKey(b64(v.serverSec), b64(v.phonePub));
    const reSealed = sealFrameWithNonce(shared, utf8(v.plaintext), b64(v.nonce));
    strictEqual(reSealed, v.frame);
  });

  test(`golden vector [${v.label}] decrypts to the expected plaintext (both directions)`, () => {
    const serverShared = deriveSharedKey(b64(v.serverSec), b64(v.phonePub));
    const phoneShared = deriveSharedKey(b64(v.phoneSec), b64(v.serverPub));
    deepStrictEqual([...serverShared], [...phoneShared]);
    strictEqual(str(openFrame(serverShared, v.frame)), v.plaintext);
    strictEqual(str(openFrame(phoneShared, v.frame)), v.plaintext);
  });
}
