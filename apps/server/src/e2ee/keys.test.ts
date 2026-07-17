import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import nacl from "tweetnacl";
import { keyPath } from "../home.js";
import { readOrCreateBoxKeyPair } from "./keys.js";

function tmpEnv(): NodeJS.ProcessEnv {
  return { PERCH_HOME: mkdtempSync(join(tmpdir(), "perch-keys-")) };
}

test("readOrCreateBoxKeyPair creates a persisted 32-byte keypair on first boot", () => {
  const env = tmpEnv();
  const keys = readOrCreateBoxKeyPair(env);

  ok(existsSync(keyPath(env)), "keypair file exists");
  strictEqual(keys.secretKey.length, 32, "secret key is 32 bytes");
  strictEqual(Buffer.from(keys.publicKeyB64, "base64").length, 32, "public key is 32 bytes");
});

test("readOrCreateBoxKeyPair is stable across calls (same trust anchor)", () => {
  const env = tmpEnv();
  const first = readOrCreateBoxKeyPair(env);
  const second = readOrCreateBoxKeyPair(env);

  strictEqual(first.publicKeyB64, second.publicKeyB64, "public key is stable");
  deepStrictEqual([...first.secretKey], [...second.secretKey], "secret key is stable");
});

test("readOrCreateBoxKeyPair writes the keypair file 0600", () => {
  const env = tmpEnv();
  readOrCreateBoxKeyPair(env);
  const mode = statSync(keyPath(env)).mode & 0o777;
  strictEqual(mode, 0o600, "keypair file is owner-only");
});

test("the persisted public key matches the derived box public key", () => {
  const env = tmpEnv();
  const keys = readOrCreateBoxKeyPair(env);
  // A valid box secret key derives a public key deterministically; deriving it
  // again from the stored secret must reproduce the published public half.
  const derived = Buffer.from(nacl.box.keyPair.fromSecretKey(keys.secretKey).publicKey).toString(
    "base64"
  );
  strictEqual(derived, keys.publicKeyB64, "published pk matches the secret key");
});
