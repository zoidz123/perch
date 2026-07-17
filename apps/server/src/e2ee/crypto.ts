import nacl from "tweetnacl";
// The public root package ships the compiled workspaces together, without
// publishing the private @perch/shared workspace as a second registry package.
import { E2EE_VERSION } from "../../../../packages/shared/dist/index.js";

// NaCl box E2E crypto for the perch encrypted channel. Byte-identical to
// libsodium crypto_box (swift-sodium on the phone), which is what makes
// cross-language parity possible. The wire frame, before base64, is:
//   [ 1B version ][ 24B nonce ][ ciphertext incl. 16B Poly1305 tag ]
// The leading version byte supports the append-only wire guardrail.

const NONCE_BYTES = nacl.box.nonceLength; // 24
const TAG_BYTES = nacl.box.overheadLength; // 16 (Poly1305)
const NONCE_OFFSET = 1;
const CIPHERTEXT_OFFSET = NONCE_OFFSET + NONCE_BYTES; // 25
// Smallest valid frame: version + nonce + a bare tag (empty plaintext).
const MIN_FRAME_BYTES = CIPHERTEXT_OFFSET + TAG_BYTES;

// Why a frame could not be opened. `bad_version` is fatal-and-renegotiate (the
// peer speaks a frame layout we do not); `bad_mac` / `truncated` mean the frame
// is corrupt or forged. The channel closes on any of them.
export type E2eeErrorCode = "bad_version" | "truncated" | "bad_mac";

export class E2eeError extends Error {
  readonly code: E2eeErrorCode;
  constructor(code: E2eeErrorCode, message: string) {
    super(message);
    this.name = "E2eeError";
    this.code = code;
  }
}

// Curve25519 ECDH into a precomputed 32-byte shared key. Symmetric across the
// pair: deriveSharedKey(ourSecret, peerPublic) on both ends yields the same key.
export function deriveSharedKey(ourSecret: Uint8Array, peerPublic: Uint8Array): Uint8Array {
  return nacl.box.before(peerPublic, ourSecret);
}

// Seals plaintext into a base64 frame with a fresh random 24-byte nonce. There
// is no nonce counter and no reuse tracking; confidentiality rests on 24 random
// bytes being collision-free in practice (a documented protocol limitation).
export function sealFrame(sharedKey: Uint8Array, plaintext: Uint8Array): string {
  return sealFrameWithNonce(sharedKey, plaintext, nacl.randomBytes(NONCE_BYTES));
}

// Seals with a caller-supplied nonce. Exposed for the golden-vector tests so a
// fixed vector reproduces byte-identical output across languages; production
// code always uses sealFrame (fresh random nonce).
export function sealFrameWithNonce(
  sharedKey: Uint8Array,
  plaintext: Uint8Array,
  nonce: Uint8Array
): string {
  if (nonce.length !== NONCE_BYTES) {
    throw new E2eeError("truncated", `nonce must be ${NONCE_BYTES} bytes, got ${nonce.length}`);
  }
  const ciphertext = nacl.box.after(plaintext, nonce, sharedKey);
  const frame = new Uint8Array(CIPHERTEXT_OFFSET + ciphertext.length);
  frame[0] = E2EE_VERSION;
  frame.set(nonce, NONCE_OFFSET);
  frame.set(ciphertext, CIPHERTEXT_OFFSET);
  return Buffer.from(frame).toString("base64");
}

// Reverses sealFrame: rejects an unknown version byte, a truncated frame, or a
// bad Poly1305 tag (tampered ciphertext / wrong key). Never returns a partial
// or unauthenticated result.
export function openFrame(sharedKey: Uint8Array, frame: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(frame, "base64"));
  if (bytes.length < MIN_FRAME_BYTES) {
    throw new E2eeError("truncated", `frame shorter than the ${MIN_FRAME_BYTES}-byte minimum`);
  }
  const version = bytes[0];
  if (version !== E2EE_VERSION) {
    throw new E2eeError(
      "bad_version",
      `unsupported E2E frame version 0x${version.toString(16)}`
    );
  }
  const nonce = bytes.subarray(NONCE_OFFSET, CIPHERTEXT_OFFSET);
  const ciphertext = bytes.subarray(CIPHERTEXT_OFFSET);
  const plaintext = nacl.box.open.after(ciphertext, nonce, sharedKey);
  if (!plaintext) {
    throw new E2eeError("bad_mac", "E2E frame failed authentication");
  }
  return plaintext;
}
