import { WebSocket, type RawData } from "ws";
import type { ClientAuth, ClientSocket } from "./fleetMonitor.js";
import { EncryptedServerChannel, type VerifyToken } from "./e2ee/channel.js";
import { relayControlUrl, relayDataUrl } from "./relayEndpoints.js";

/**
 * Outbound relay client: the perch server's off-LAN reach path.
 *
 * The server dials the relay's CONTROL socket outbound and holds it open with a
 * reconnect loop, so a Mac behind NAT is never a listener the phone must reach.
 * The relay tells the control socket which phone connections exist (`sync` on
 * (re)connect, then `connected` / `disconnected`); for each the server opens a
 * per-connection DATA socket, wraps it in the Phase 0 EncryptedServerChannel,
 * awaits the phone's end-to-end device-token auth, and registers it as one
 * FleetMonitor client. Every data socket has its own fresh shared key, so one
 * phone's compromise or revocation never touches another.
 *
 * No plaintext ever leaves the Mac: the relay only ever forwards opaque frames
 * (the encrypted envelope plus the plaintext e2ee_hello / e2ee_ready handshake),
 * and no crypto state persists across reconnects - each data socket re-handshakes.
 *
 * Liveness is end-to-end. The control socket is fronted by proxies (Cloudflare /
 * the Railway edge) that auto-answer WebSocket PROTOCOL pings without ever waking
 * the origin relay, and the relay is STATELESS: a redeploy / crash / idle-drop
 * wipes its in-memory rooms. So a protocol pong proves only that the edge is up,
 * not that the origin still holds our room - if we trusted it, a wiped origin
 * would leave us "connected" to an empty room forever. Instead we send an
 * application-level {type:"ping"} the edge cannot synthesize and drive staleness
 * from the receipt of any control MESSAGE (the origin's {type:"pong"} / sync /
 * connected / disconnected). Protocol pings stay, but only as TCP keepalive.
 */

// Routing notices the relay emits on the control socket (routing ids only, never
// payload). Mirrors @perch/relay's ControlNotice; declared here so the server's
// runtime never imports the relay package (it speaks only the wire).
type ControlNotice =
  | { type: "sync"; connectionIds: string[] }
  | { type: "connected"; connectionId: string }
  | { type: "disconnected"; connectionId: string }
  // The origin relay's answer to our application-level {type:"ping"} heartbeat.
  | { type: "pong" };

// The raw socket the client dials. A `ws` WebSocket satisfies it; tests can
// inject a factory that returns the same shape.
type DialedSocket = WebSocket;

export interface RelayClientOptions {
  // The relay origin (ws(s)://... or http(s)://...); reach URLs derive from it.
  url: string;
  serverId: string;
  // The server's long-term box secret key; each data socket derives its own
  // per-connection shared key from it.
  secretKey: Uint8Array;
  // Resolves a device token presented over the channel to how it is authorized
  // (or undefined to reject). Wraps DeviceRegistry.verify in production.
  verifyToken: VerifyToken;
  // Registers an authorized channel as a FleetMonitor client. sessionId is
  // undefined: the phone opens the always-on overview and subscribes to focused
  // panes with messages, exactly like the LAN path.
  addClient: (socket: ClientSocket, sessionId: string | undefined, auth: ClientAuth) => void;
  // Socket factory, injectable for tests. Defaults to a real `ws` WebSocket.
  connect?: (url: string) => DialedSocket;
  // Linear reconnect backoff min(max, base * attempt).
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  // Give up on a control socket that has not opened within this window.
  controlReadyTimeoutMs?: number;
  // Application-level heartbeat on the control socket. Every pingMs the server
  // sends {type:"ping"}; a live origin relay answers {type:"pong"}. If no
  // application-level control MESSAGE arrives within staleMs the socket is
  // assumed dead - even while an edge proxy keeps answering protocol pings - and
  // is terminated so the reconnect loop re-registers the room.
  pingMs?: number;
  staleMs?: number;
  onLog?: (message: string) => void;
}

type DataEntry = {
  socket: DialedSocket;
  channel: EncryptedServerChannel;
  // Set once the channel's e2ee_auth resolves, so a revoked device's data
  // sockets can be found and severed by deviceId (see disconnectDevice).
  auth?: ClientAuth;
};

export class RelayClient {
  private control?: DialedSocket;
  private readonly dataSockets = new Map<string, DataEntry>();
  private attempt = 0;
  private stopped = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private readyTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  // Last time an application-level control MESSAGE arrived from the origin relay.
  // Drives staleness; protocol pongs (edge-answered) deliberately do not touch it.
  private lastControlMessageAt = 0;

  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly controlReadyTimeoutMs: number;
  private readonly pingMs: number;
  private readonly staleMs: number;

  constructor(private readonly opts: RelayClientOptions) {
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 30_000;
    this.controlReadyTimeoutMs = opts.controlReadyTimeoutMs ?? 8000;
    this.pingMs = opts.pingMs ?? 10_000;
    this.staleMs = opts.staleMs ?? 30_000;
  }

  start(): void {
    if (this.stopped || this.control) return;
    this.dialControl();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.readyTimer);
    clearInterval(this.pingTimer);
    for (const entry of this.dataSockets.values()) {
      entry.channel.terminate();
    }
    this.dataSockets.clear();
    this.control?.terminate();
    this.control = undefined;
  }

  private dial(url: string): DialedSocket {
    return (this.opts.connect ?? ((target: string) => new WebSocket(target)))(url);
  }

  private log(message: string): void {
    this.opts.onLog?.(message);
  }

  private dialControl(): void {
    if (this.stopped) return;
    const ws = this.dial(relayControlUrl(this.opts.url, this.opts.serverId));
    this.control = ws;

    this.readyTimer = setTimeout(() => {
      if (ws.readyState !== ws.OPEN) {
        // A control socket that never opened: terminate so `close` schedules a
        // retry with backoff.
        ws.terminate();
      }
    }, this.controlReadyTimeoutMs);
    this.readyTimer.unref?.();

    ws.on("open", () => {
      clearTimeout(this.readyTimer);
      this.attempt = 0;
      this.startKeepalive(ws);
      this.log("relay: control socket open");
    });
    ws.on("message", (data: RawData) => this.onControlMessage(data));
    // Note: no `pong` handler. An edge proxy answers protocol pings without the
    // origin relay, so a protocol pong is not proof the origin still holds our
    // room. Liveness comes from application-level control messages only.
    ws.on("close", () => this.onControlClosed(ws));
    ws.on("error", () => {
      // The `close` event that follows drives the retry; swallow here.
    });
  }

  private startKeepalive(ws: DialedSocket): void {
    clearInterval(this.pingTimer);
    // The open socket is live until proven otherwise; the relay also sends `sync`
    // immediately on connect, which refreshes this on the first message.
    this.lastControlMessageAt = Date.now();
    this.pingTimer = setInterval(() => {
      if (this.control !== ws || ws.readyState !== ws.OPEN) return;
      // Staleness is measured from the last application-level control message. A
      // dead origin behind a ping-answering edge produces none, so this trips and
      // forces a reconnect that re-registers the room.
      if (Date.now() - this.lastControlMessageAt > this.staleMs) {
        ws.terminate();
        return;
      }
      // Application-level heartbeat: only a live origin relay answers it with
      // {type:"pong"}. The edge cannot synthesize a JSON control message.
      try {
        ws.send(JSON.stringify({ type: "ping" }));
      } catch {
        // A failed send surfaces as a close; ignore here.
      }
      // Protocol ping: TCP keepalive only (keeps NAT/idle intermediaries open),
      // never proof of life.
      try {
        ws.ping();
      } catch {
        // A failed ping surfaces as a close; ignore here.
      }
    }, this.pingMs);
    this.pingTimer.unref?.();
  }

  private onControlClosed(ws: DialedSocket): void {
    if (this.control !== ws) return;
    this.control = undefined;
    clearTimeout(this.readyTimer);
    clearInterval(this.pingTimer);
    // Data sockets are independent connections. If the relay restarted they drop
    // on their own (their own `close` cleans them up); a fresh control `sync`
    // then reconciles. Do not tear them down here on a mere control blip.
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.attempt += 1;
    const delay = Math.min(this.backoffMaxMs, this.backoffBaseMs * this.attempt);
    this.reconnectTimer = setTimeout(() => this.dialControl(), delay);
    this.reconnectTimer.unref?.();
  }

  private onControlMessage(data: RawData): void {
    // Any control message is proof the origin relay is live (the edge forwards
    // JSON messages to the origin; it only synthesizes protocol pongs). Refresh
    // liveness before parsing so even an unrecognized future notice counts.
    this.lastControlMessageAt = Date.now();
    let notice: ControlNotice;
    try {
      notice = JSON.parse(data.toString()) as ControlNotice;
    } catch {
      return;
    }
    if (notice.type === "pong") {
      // Heartbeat acknowledged; liveness already refreshed above.
      return;
    }
    if (notice.type === "sync") {
      const present = new Set(notice.connectionIds);
      for (const connectionId of notice.connectionIds) this.ensureDataSocket(connectionId);
      // Drop any data socket for a connection the relay no longer knows about.
      for (const connectionId of [...this.dataSockets.keys()]) {
        if (!present.has(connectionId)) this.closeDataSocket(connectionId);
      }
    } else if (notice.type === "connected") {
      this.ensureDataSocket(notice.connectionId);
    } else if (notice.type === "disconnected") {
      this.closeDataSocket(notice.connectionId);
    }
  }

  private ensureDataSocket(connectionId: string): void {
    if (this.stopped || this.dataSockets.has(connectionId)) return;
    const ws = this.dial(relayDataUrl(this.opts.url, this.opts.serverId, connectionId));
    const channel = new EncryptedServerChannel(ws, this.opts.secretKey, this.opts.verifyToken);
    const entry: DataEntry = { socket: ws, channel };
    this.dataSockets.set(connectionId, entry);

    channel
      .awaitAuth()
      .then((auth) => {
        // A socket replaced (or torn down) before auth resolved must not become
        // a client; the newer entry, if any, owns this connection.
        if (this.dataSockets.get(connectionId) !== entry) {
          ws.terminate();
          return;
        }
        entry.auth = auth;
        this.opts.addClient(channel, undefined, auth);
        this.log(`relay: authorized ${connectionId} as ${auth.kind}`);
      })
      .catch(() => {
        // Auth failed or the socket closed mid-handshake; the channel already
        // closed the underlying socket. The `close` handler drops the entry.
      });

    ws.on("close", () => {
      if (this.dataSockets.get(connectionId) === entry) {
        this.dataSockets.delete(connectionId);
      }
    });
    ws.on("error", () => {
      // Teardown follows via `close`.
    });
  }

  // Sever every data socket authorized as this device. FleetMonitor calls this
  // (via its onDisconnectDevice hook) on revocation so the relay data socket is
  // cut even for a device connection that has not become a FleetMonitor client
  // yet. A reconnect afterwards re-handshakes and fails verify (the token is now
  // revoked), so a revoked device can never re-attach.
  disconnectDevice(deviceId: string): void {
    for (const [connectionId, entry] of [...this.dataSockets]) {
      if (entry.auth?.kind === "device" && entry.auth.deviceId === deviceId) {
        this.dataSockets.delete(connectionId);
        entry.channel.terminate();
      }
    }
  }

  private closeDataSocket(connectionId: string): void {
    const entry = this.dataSockets.get(connectionId);
    if (!entry) return;
    this.dataSockets.delete(connectionId);
    // Terminate the channel's underlying socket. If this device is still a
    // FleetMonitor client, the channel's close listener removes it there too.
    entry.channel.terminate();
  }
}
