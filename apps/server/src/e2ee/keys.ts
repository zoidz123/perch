import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import nacl from "tweetnacl";
import { ensurePerchHome, keyPath } from "../home.js";

// The server's long-term NaCl box keypair. The public half is published in the
// pairing offer's `pk` (the trust anchor the QR carries); the secret half never
// leaves the Mac, so all confidentiality derives from it. The keypair is
// persistent so re-pairing and reconnects reuse the same anchor.
export type BoxKeyPair = {
  // base64, 32 bytes. Published as PairingOffer.pk.
  publicKeyB64: string;
  // raw 32-byte secret key, used to derive per-connection shared keys.
  secretKey: Uint8Array;
};

type StoredKeyPair = {
  publicKey: string;
  secretKey: string;
};

// Reads the persisted box keypair, deriving and storing one on first boot. The
// file is written 0600 with the atomic tmp+rename pattern used by
// DeviceRegistry.persist so a crash never leaves a half-written key.
export function readOrCreateBoxKeyPair(env: NodeJS.ProcessEnv = process.env): BoxKeyPair {
  ensurePerchHome(env);
  const path = keyPath(env);

  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredKeyPair>;
      const secretKey = decodeKey(parsed.secretKey, 32);
      const publicKey = decodeKey(parsed.publicKey, 32);
      if (secretKey && publicKey) {
        return { publicKeyB64: Buffer.from(publicKey).toString("base64"), secretKey };
      }
    } catch {
      // Corrupt keypair falls through to a fresh one. This rotates the trust
      // anchor, so paired devices must re-pair; a corrupt key is unrecoverable.
    }
  }

  const pair = nacl.box.keyPair();
  const stored: StoredKeyPair = {
    publicKey: Buffer.from(pair.publicKey).toString("base64"),
    secretKey: Buffer.from(pair.secretKey).toString("base64")
  };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(stored, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return { publicKeyB64: stored.publicKey, secretKey: pair.secretKey };
}

function decodeKey(value: unknown, length: number): Uint8Array | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const bytes = Buffer.from(value, "base64");
  return bytes.length === length ? new Uint8Array(bytes) : undefined;
}
