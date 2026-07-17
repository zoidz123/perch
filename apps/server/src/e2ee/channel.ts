import type { RawData } from "ws";
import type { E2eeAuth, E2eeHandshake } from "@perch/shared";
import type { ClientAuth, ClientSocket } from "../fleetMonitor.js";
import { E2eeError, deriveSharedKey, openFrame, sealFrame } from "./crypto.js";

// The raw transport the channel wraps. A ws.WebSocket satisfies this; the tests
// supply an in-memory pair. The channel never assumes anything else about it.
export interface RawSocket {
  readonly OPEN: number;
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "message", listener: (data: RawData) => void): unknown;
  on(event: "close", listener: () => void): unknown;
}

// Resolves a presented device token to how the channel is authorized, or
// undefined to reject. Kept as a function so the channel does not depend on
// DeviceRegistry directly (and tests can inject a fake).
export type VerifyToken = (token: string) => ClientAuth | undefined;

// WebSocket close codes. 1008 (policy violation) for auth/protocol refusal,
// 1002 (protocol error) for a malformed or unreadable frame. Either way the
// peer reconnects and re-handshakes.
const CLOSE_POLICY = 1008;
const CLOSE_PROTOCOL = 1002;

type State = "awaiting_hello" | "awaiting_auth" | "open" | "closed";

// Wraps a raw socket in the NaCl box E2E channel and presents the plaintext
// ClientSocket surface FleetMonitor expects. The handshake and device-token
// auth all happen here, at the transport boundary, so the monitor, timeline,
// and HTTP layers stay plaintext-only. The per-device token is carried as the
// first encrypted frame.
export class EncryptedServerChannel implements ClientSocket {
  readonly OPEN: number;

  private state: State = "awaiting_hello";
  private sharedKey?: Uint8Array;
  private phonePublicB64?: string;

  private authResolve?: (auth: ClientAuth) => void;
  private authReject?: (error: Error) => void;
  private authSettled = false;

  // Consumer (FleetMonitor) callbacks and a small buffer for any decrypted
  // frames that land between auth resolving and the consumer attaching its
  // message listener.
  private messageListener?: (data: RawData) => void;
  private closeListener?: () => void;
  private readonly pending: Buffer[] = [];

  constructor(
    private readonly raw: RawSocket,
    private readonly serverSecretKey: Uint8Array,
    private readonly verifyToken: VerifyToken
  ) {
    this.OPEN = raw.OPEN;
    raw.on("message", (data) => this.onRawMessage(data));
    raw.on("close", () => this.onRawClose());
  }

  // Resolves once the phone's e2ee_auth frame verifies; rejects (and closes) on
  // any auth or protocol failure. http awaits this before handing the channel to
  // the monitor, so an unauthorized socket never becomes a client.
  awaitAuth(): Promise<ClientAuth> {
    return new Promise<ClientAuth>((resolve, reject) => {
      this.authResolve = resolve;
      this.authReject = reject;
    });
  }

  get readyState(): number {
    return this.raw.readyState;
  }

  // ClientSocket.send: encrypt plaintext into a frame. Called by the monitor
  // only after auth, so the shared key is always set here.
  send(data: string): void {
    if (this.state !== "open" || !this.sharedKey) {
      return;
    }
    if (this.raw.readyState !== this.raw.OPEN) {
      return;
    }
    this.raw.send(sealFrame(this.sharedKey, new TextEncoder().encode(data)));
  }

  terminate(): void {
    this.raw.terminate();
  }

  on(event: "message", listener: (data: RawData) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "message" | "close", listener: ((data: RawData) => void) & (() => void)): this {
    if (event === "message") {
      this.messageListener = listener;
      // Flush anything buffered before the consumer subscribed.
      for (const buffered of this.pending.splice(0)) {
        listener(buffered);
      }
    } else {
      this.closeListener = listener;
    }
    return this;
  }

  private onRawMessage(data: RawData): void {
    if (this.state === "closed") {
      return;
    }
    const text = data.toString();
    const handshake = parseHandshake(text);

    try {
      if (handshake?.type === "e2ee_hello") {
        this.onHello(handshake.key);
        return;
      }
      if (this.state === "awaiting_hello") {
        // Anything before the hello is a protocol violation.
        throw new E2eeError("bad_mac", "expected e2ee_hello before any frame");
      }
      // Otherwise it is an encrypted frame.
      const plaintext = openFrame(this.sharedKey as Uint8Array, text);
      if (this.state === "awaiting_auth") {
        this.onAuthFrame(plaintext);
        return;
      }
      // Open channel: hand the decrypted plaintext to the consumer.
      const buffer = Buffer.from(plaintext);
      if (this.messageListener) {
        this.messageListener(buffer);
      } else {
        this.pending.push(buffer);
      }
    } catch (error) {
      // Any decrypt/protocol error (bad MAC, unknown version, truncation) is
      // fatal: close so the peer reconnects and renegotiates.
      this.fail(CLOSE_PROTOCOL, error instanceof Error ? error.message : "frame error");
    }
  }

  private onHello(keyB64: string): void {
    if (this.phonePublicB64 && this.phonePublicB64 !== keyB64) {
      // A re-hello with a different key is a fresh peer on the same socket:
      // refuse it rather than silently rekeying the live socket.
      this.fail(CLOSE_POLICY, "re-hello with a mismatched key");
      return;
    }

    if (!this.sharedKey) {
      const phonePublic = decodeKey(keyB64);
      if (!phonePublic) {
        this.fail(CLOSE_PROTOCOL, "malformed e2ee_hello key");
        return;
      }
      this.sharedKey = deriveSharedKey(this.serverSecretKey, phonePublic);
      this.phonePublicB64 = keyB64;
      if (this.state === "awaiting_hello") {
        this.state = "awaiting_auth";
      }
    }
    // Ack (or re-ack a same-key retry) so the phone stops retrying its hello.
    this.raw.send(JSON.stringify({ type: "e2ee_ready" } satisfies E2eeHandshake));
  }

  private onAuthFrame(plaintext: Uint8Array): void {
    let message: E2eeAuth;
    try {
      message = JSON.parse(new TextDecoder().decode(plaintext)) as E2eeAuth;
    } catch {
      this.fail(CLOSE_PROTOCOL, "malformed first frame");
      return;
    }
    if (message.type !== "e2ee_auth" || typeof message.token !== "string") {
      this.fail(CLOSE_POLICY, "first encrypted frame must be e2ee_auth");
      return;
    }
    const auth = this.verifyToken(message.token);
    if (!auth) {
      this.fail(CLOSE_POLICY, "device token rejected");
      return;
    }
    this.state = "open";
    this.authSettled = true;
    this.authResolve?.(auth);
  }

  private onRawClose(): void {
    if (this.state !== "closed") {
      this.state = "closed";
    }
    if (!this.authSettled) {
      this.authSettled = true;
      this.authReject?.(new Error("channel closed before authentication"));
    }
    this.closeListener?.();
  }

  private fail(code: number, reason: string): void {
    if (this.state === "closed") {
      return;
    }
    this.state = "closed";
    if (!this.authSettled) {
      this.authSettled = true;
      this.authReject?.(new E2eeError("bad_mac", reason));
    }
    try {
      this.raw.close(code, reason);
    } catch {
      this.raw.terminate();
    }
  }
}

// Recognizes a plaintext handshake frame. Returns undefined for encrypted
// frames (base64 ciphertext never parses to a handshake object), so the same
// socket carries both without ambiguity.
function parseHandshake(text: string): E2eeHandshake | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const type = (parsed as { type?: unknown }).type;
  if (type === "e2ee_hello" || type === "e2ee_ready") {
    return parsed as E2eeHandshake;
  }
  return undefined;
}

function decodeKey(b64: string): Uint8Array | undefined {
  const bytes = Buffer.from(b64, "base64");
  return bytes.length === 32 ? new Uint8Array(bytes) : undefined;
}
