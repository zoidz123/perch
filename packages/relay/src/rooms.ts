/**
 * Stateless, content-blind room router.
 *
 * The relay pairs two kinds of sockets by room (`serverId`) and forwards
 * OPAQUE frames between them. It never inspects, decodes, or parses a data
 * frame - the only JSON it touches is on the CONTROL socket: the routing notices
 * it generates itself (`sync` / `connected` / `disconnected`), plus a `pong`
 * reply to the server's application-level `ping` liveness heartbeat. All of these
 * carry connection ids only, never payload.
 *
 * Stateless room topology:
 * - one CONTROL socket per room (`role=server`, no connectionId): the perch
 *   server's outbound coordination socket. It learns which phone connections
 *   exist so it can open a matching data socket for each.
 * - per-connection DATA socket (`role=server&connectionId=X`): the server's
 *   encrypted channel for one phone connection.
 * - per-connection CLIENT socket(s) (`role=client&connectionId=X`): the phone.
 *
 * Nothing is persisted. On process restart every socket drops and both sides
 * reconnect and re-form the room from scratch.
 */

/** A frame is opaque bytes (or an opaque text payload); the relay never reads it. */
export type FrameData = string | Uint8Array;

/** Transport-agnostic socket the router drives (a `ws` WebSocket in production). */
export interface RelaySocket {
  send(data: FrameData, isBinary: boolean): void;
  close(code: number, reason?: string): void;
}

/** A joined socket. The transport wires its inbound frames and close into these. */
export interface RelayMember {
  /** An opaque frame arrived from this socket; the router forwards it to the peer. */
  receive(data: FrameData, isBinary: boolean): void;
  /** This socket closed; the router tears down its role and notifies peers. */
  disconnect(code: number, reason: string): void;
}

/** Routing notices the relay generates on the control socket (routing ids only). */
export type ControlNotice =
  | { type: "sync"; connectionIds: string[] }
  | { type: "connected"; connectionId: string }
  | { type: "disconnected"; connectionId: string }
  // Answer to the server's application-level {type:"ping"} liveness heartbeat.
  // Only a live origin relay emits this; an edge proxy answers protocol pings
  // but never synthesizes a JSON control message, so the server can tell a wiped
  // origin apart from a healthy one. Carries no application payload.
  | { type: "pong" };

export type JoinRequest =
  | { serverId: string; kind: "control"; socket: RelaySocket }
  | { serverId: string; kind: "data"; connectionId: string; socket: RelaySocket }
  | { serverId: string; kind: "client"; connectionId: string; socket: RelaySocket };

/** Bound on buffered client frames awaiting a data socket, per connection. */
const MAX_PENDING_FRAMES = 200;
/**
 * Bound on buffered client BYTES awaiting a data socket, per connection. The
 * frame count alone is not enough: with large frames, 200 of them could pin
 * hundreds of MiB. Oldest frames drop first, same as the count bound.
 */
const MAX_PENDING_BYTES = 1024 * 1024;
const DATA_ATTACH_GRACE_MS = 1500;

interface PendingFrame {
  data: FrameData;
  isBinary: boolean;
}

interface PendingBuffer {
  frames: PendingFrame[];
  bytes: number;
}

function frameBytes(data: FrameData): number {
  return typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
}

class Room {
  private control: RelaySocket | null = null;
  private readonly dataSockets = new Map<string, RelaySocket>();
  private readonly clientSockets = new Map<string, Set<RelaySocket>>();
  private readonly pending = new Map<string, PendingBuffer>();
  private readonly dataAttachTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly onEmpty: () => void) {}

  join(req: JoinRequest): RelayMember {
    if (req.kind === "control") return this.joinControl(req.socket);
    if (req.kind === "data") return this.joinData(req.connectionId, req.socket);
    return this.joinClient(req.connectionId, req.socket);
  }

  private notifyControl(notice: ControlNotice): void {
    if (!this.control) return;
    try {
      this.control.send(JSON.stringify(notice), false);
    } catch {
      // A dead control socket will surface via its own close; drop the notice.
    }
  }

  private connectedConnectionIds(): string[] {
    return [...this.clientSockets.keys()];
  }

  private joinControl(socket: RelaySocket): RelayMember {
    const previous = this.control;
    if (previous && previous !== socket) {
      previous.close(1008, "Replaced by new connection");
    }
    this.control = socket;
    // Hand the server the current connection list so it can (re)open data sockets.
    this.notifyControl({ type: "sync", connectionIds: this.connectedConnectionIds() });
    for (const connectionId of this.connectedConnectionIds()) {
      if (!this.dataSockets.has(connectionId)) this.armDataAttachWatchdog(connectionId);
    }

    return {
      receive: (data, isBinary) => {
        // The control socket carries no data-plane frames. Its only inbound
        // traffic is the server's application-level liveness heartbeat: answer
        // {type:"ping"} with {type:"pong"} so the server has an end-to-end signal
        // that this ORIGIN relay (not just an edge proxy) is alive and still
        // holds the room. Any other payload is ignored.
        if (this.isControlPing(data, isBinary)) {
          try {
            socket.send(JSON.stringify({ type: "pong" }), false);
          } catch {
            // A dead control socket surfaces via its own close; drop the reply.
          }
        }
      },
      disconnect: () => {
        if (this.control === socket) this.control = null;
        this.gcIfEmpty();
      },
    };
  }

  /**
   * True only for a text {type:"ping"} heartbeat frame; never parses binary
   * frames. The transport hands text frames through as bytes (see server.ts
   * `normalize`), so a non-binary Uint8Array is decoded as UTF-8 here. Safe on
   * the control socket, which carries no opaque data-plane payload.
   */
  private isControlPing(data: FrameData, isBinary: boolean): boolean {
    if (isBinary) return false;
    const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    try {
      return (JSON.parse(text) as { type?: unknown }).type === "ping";
    } catch {
      return false;
    }
  }

  private joinData(connectionId: string, socket: RelaySocket): RelayMember {
    const previous = this.dataSockets.get(connectionId);
    if (previous && previous !== socket) {
      previous.close(1008, "Replaced by new connection");
    }
    this.dataSockets.set(connectionId, socket);
    this.clearDataAttachWatchdog(connectionId);
    this.flushPending(connectionId, socket);

    return {
      receive: (data, isBinary) => {
        const clients = this.clientSockets.get(connectionId);
        if (!clients) return;
        for (const client of clients) this.forward(client, data, isBinary);
      },
      disconnect: () => {
        if (this.dataSockets.get(connectionId) !== socket) return;
        this.dataSockets.delete(connectionId);
        // Force the phone to reconnect and re-handshake against a fresh data socket.
        for (const client of this.clientSockets.get(connectionId) ?? []) {
          client.close(1012, "Server disconnected");
        }
        this.gcIfEmpty();
      },
    };
  }

  private joinClient(connectionId: string, socket: RelaySocket): RelayMember {
    let clients = this.clientSockets.get(connectionId);
    if (!clients) {
      clients = new Set();
      this.clientSockets.set(connectionId, clients);
    }
    clients.add(socket);
    this.notifyControl({ type: "connected", connectionId });
    if (!this.dataSockets.has(connectionId)) this.armDataAttachWatchdog(connectionId);

    return {
      receive: (data, isBinary) => {
        const dataSocket = this.dataSockets.get(connectionId);
        if (dataSocket) {
          this.forward(dataSocket, data, isBinary);
        } else {
          this.buffer(connectionId, { data, isBinary });
        }
      },
      disconnect: () => {
        const set = this.clientSockets.get(connectionId);
        if (!set || !set.delete(socket)) return;
        if (set.size > 0) return;
        // Last client for this connection is gone: tear the connection down.
        this.clientSockets.delete(connectionId);
        this.pending.delete(connectionId);
        this.clearDataAttachWatchdog(connectionId);
        const dataSocket = this.dataSockets.get(connectionId);
        if (dataSocket) dataSocket.close(1001, "Client disconnected");
        this.notifyControl({ type: "disconnected", connectionId });
        this.gcIfEmpty();
      },
    };
  }

  private forward(target: RelaySocket, data: FrameData, isBinary: boolean): void {
    try {
      target.send(data, isBinary);
    } catch {
      // A dead peer surfaces via its own close event; drop this frame.
    }
  }

  private buffer(connectionId: string, frame: PendingFrame): void {
    const buf = this.pending.get(connectionId) ?? { frames: [], bytes: 0 };
    buf.frames.push(frame);
    buf.bytes += frameBytes(frame.data);
    // Drop oldest first, bounded by count AND bytes. A single frame over the
    // byte cap is kept alone - the transport's maxPayload already bounds it.
    while (buf.frames.length > MAX_PENDING_FRAMES || (buf.bytes > MAX_PENDING_BYTES && buf.frames.length > 1)) {
      const dropped = buf.frames.shift() as PendingFrame;
      buf.bytes -= frameBytes(dropped.data);
    }
    this.pending.set(connectionId, buf);
  }

  private armDataAttachWatchdog(connectionId: string): void {
    if (this.dataAttachTimers.has(connectionId) || this.dataSockets.has(connectionId)) return;
    const timer = setTimeout(() => {
      this.dataAttachTimers.delete(connectionId);
      if (this.dataSockets.has(connectionId) || !this.clientSockets.has(connectionId)) return;
      this.notifyControl({ type: "sync", connectionIds: this.connectedConnectionIds() });
      const control = this.control;
      if (control) {
        this.control = null;
        control.close(1012, "Data socket did not attach");
      }
    }, DATA_ATTACH_GRACE_MS);
    timer.unref?.();
    this.dataAttachTimers.set(connectionId, timer);
  }

  private clearDataAttachWatchdog(connectionId: string): void {
    const timer = this.dataAttachTimers.get(connectionId);
    if (!timer) return;
    clearTimeout(timer);
    this.dataAttachTimers.delete(connectionId);
  }

  private flushPending(connectionId: string, socket: RelaySocket): void {
    const buf = this.pending.get(connectionId);
    if (!buf || buf.frames.length === 0) return;
    this.pending.delete(connectionId);
    for (const frame of buf.frames) this.forward(socket, frame.data, frame.isBinary);
  }

  private isEmpty(): boolean {
    return (
      this.control === null &&
      this.dataSockets.size === 0 &&
      this.clientSockets.size === 0 &&
      this.pending.size === 0 &&
      this.dataAttachTimers.size === 0
    );
  }

  private gcIfEmpty(): void {
    if (this.isEmpty()) this.onEmpty();
  }
}

/** In-memory registry of rooms keyed by `serverId`. Holds no durable state. */
export class RelayRegistry {
  private readonly rooms = new Map<string, Room>();

  join(req: JoinRequest): RelayMember {
    let room = this.rooms.get(req.serverId);
    if (!room) {
      const serverId = req.serverId;
      room = new Room(() => this.rooms.delete(serverId));
      this.rooms.set(serverId, room);
    }
    return room.join(req);
  }

  /** Number of live rooms. Zero when idle - the relay keeps nothing around. */
  roomCount(): number {
    return this.rooms.size;
  }
}
