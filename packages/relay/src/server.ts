/**
 * Standalone stateless relay service.
 *
 * A thin `ws` transport wrapper around the opaque-frame room router
 * (`rooms.ts`). It terminates WebSocket connections, authenticates each SOCKET
 * only by its room (`serverId`) and role, joins it, and lets the router forward
 * opaque frames between the perch server's sockets and the phone's sockets.
 *
 * It holds no database and no durable state: every room lives in memory only,
 * so a restart drops all sockets and both sides reconnect and re-form the room.
 *
 * TLS is the transport's concern, not the router's: pass `tls: { cert, key }`
 * to listen `wss://` directly, or run plain and terminate TLS at a reverse
 * proxy. Either way the router never sees anything but opaque bytes.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { RelayRegistry, type JoinRequest, type RelayMember } from "./rooms.js";

export interface RelayServerOptions {
  /** Port to listen on. Defaults to `PORT` env or an ephemeral port (0). */
  port?: number;
  /** Host/interface to bind. Defaults to all interfaces. */
  host?: string;
  /** When present the relay listens `wss://` directly; otherwise `ws://`. */
  tls?: { cert: string | Buffer; key: string | Buffer };
  /** Ping interval for RFC6455 keepalive. Defaults to 30s. */
  heartbeatMs?: number;
  /**
   * Hard cap on the number of live rooms. A new room past the cap is refused
   * (503) so a flood of distinct serverIds cannot exhaust memory. Default 4096.
   */
  maxRooms?: number;
  /**
   * Cap on the number of live sockets in a single room, so one room cannot
   * exhaust the relay. A socket past the cap is refused (503). Default 128.
   */
  maxSocketsPerRoom?: number;
  /**
   * A socket that stops answering keepalive pings for this long is terminated,
   * so a dead or half-open peer cannot wedge a room. A live peer refreshes it on
   * every pong/frame, so quiet-but-healthy viewers are never cut. Default 120s.
   */
  idleTimeoutMs?: number;
  /**
   * A socket whose outbound buffer backs up past this many bytes is terminated
   * as a slow consumer, so a slow peer cannot wedge a room with backpressure.
   * Default 8 MiB.
   */
  maxBufferedBytes?: number;
  /**
   * Max size of a single WebSocket message. `ws` closes an offender with 1009
   * (Message Too Big), so one anonymous client cannot pin relay memory with
   * huge frames. Default 1 MiB - far above any real E2EE frame.
   */
  maxPayloadBytes?: number;
  /** Concurrent sockets allowed per client IP. Default 32. */
  maxConnectionsPerIp?: number;
  /** New connections admitted per IP per minute (fixed window). Default 60. */
  connectionsPerIpPerMinute?: number;
  /** New-room creations per IP per minute (fixed window). Default 60. */
  roomsPerIpPerMinute?: number;
  /**
   * Take the client IP from the first `X-Forwarded-For` hop instead of the
   * socket peer. Set this when the relay runs behind a proxy (Railway, Caddy);
   * without it every client shares the proxy's IP and the per-IP limits bite
   * everyone at once. Default false.
   */
  trustProxy?: boolean;
}

export interface RelayServer {
  readonly port: number;
  /** Base URL (`ws://host:port` or `wss://host:port`). */
  readonly url: string;
  readonly registry: RelayRegistry;
  close(): Promise<void>;
}

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_MAX_ROOMS = 4096;
const DEFAULT_MAX_SOCKETS_PER_ROOM = 128;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_MAX_CONNECTIONS_PER_IP = 32;
const DEFAULT_CONNECTIONS_PER_IP_PER_MINUTE = 60;
const DEFAULT_ROOMS_PER_IP_PER_MINUTE = 60;
const RATE_WINDOW_MS = 60_000;
/** Reject serverId / connectionId longer than this: room keys and routing ids are short. */
const MAX_ID_LENGTH = 256;

/** Per-IP abuse counters: live sockets plus a fixed one-minute rate window. */
interface IpState {
  live: number;
  windowStart: number;
  connections: number;
  rooms: number;
}

interface Liveness extends WebSocket {
  // Last time this socket answered a ping (pong) or delivered a frame. The idle
  // reaper terminates a socket that has gone quiet past idleTimeoutMs.
  lastSeen?: number;
}

function parseJoin(req: IncomingMessage): JoinRequest | { error: string } {
  const url = new URL(req.url ?? "/", "http://relay.invalid");
  if (url.pathname !== "/ws") return { error: "not found" };

  const role = url.searchParams.get("role");
  const serverId = url.searchParams.get("serverId")?.trim();
  const connectionId = url.searchParams.get("connectionId")?.trim() ?? "";

  if (role !== "server" && role !== "client") return { error: "missing or invalid role" };
  if (!serverId) return { error: "missing serverId" };
  // Bound the opaque query ids so a malformed/hostile URL cannot balloon a room
  // key or routing id in memory.
  if (serverId.length > MAX_ID_LENGTH) return { error: "serverId too long" };
  if (connectionId.length > MAX_ID_LENGTH) return { error: "connectionId too long" };

  if (role === "client") {
    // The relay assigns a routing id when the phone omits one.
    return { serverId, kind: "client", connectionId: connectionId || `conn_${randomUUID().replace(/-/g, "")}`, socket: undefined as never };
  }
  // role === "server": a control socket has no connectionId, a data socket does.
  if (!connectionId) return { serverId, kind: "control", socket: undefined as never };
  return { serverId, kind: "data", connectionId, socket: undefined as never };
}

export function startRelayServer(options: RelayServerOptions = {}): Promise<RelayServer> {
  const registry = new RelayRegistry();
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const maxRooms = options.maxRooms ?? DEFAULT_MAX_ROOMS;
  const maxSocketsPerRoom = options.maxSocketsPerRoom ?? DEFAULT_MAX_SOCKETS_PER_ROOM;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const maxConnectionsPerIp = options.maxConnectionsPerIp ?? DEFAULT_MAX_CONNECTIONS_PER_IP;
  const connectionsPerIpPerMinute = options.connectionsPerIpPerMinute ?? DEFAULT_CONNECTIONS_PER_IP_PER_MINUTE;
  const roomsPerIpPerMinute = options.roomsPerIpPerMinute ?? DEFAULT_ROOMS_PER_IP_PER_MINUTE;
  const trustProxy = options.trustProxy ?? false;

  // Live socket count per room, mirrored here so capacity is enforced at the WS
  // upgrade (before the handshake completes) without the router having to know
  // about limits. A room drops out when its last socket closes.
  const roomSockets = new Map<string, number>();
  const roomSize = (serverId: string): number => roomSockets.get(serverId) ?? 0;
  const capacityError = (serverId: string): string | null => {
    const size = roomSize(serverId);
    if (size === 0 && roomSockets.size >= maxRooms) return "too many rooms";
    if (size >= maxSocketsPerRoom) return "room is full";
    return null;
  };

  // Per-IP abuse counters, enforced at the WS upgrade (before the handshake
  // completes). In-memory only: this is a single-process service, and every
  // window resets after a minute, so the map stays tiny and self-prunes.
  const ipStates = new Map<string, IpState>();
  const clientIp = (req: IncomingMessage): string => {
    if (trustProxy) {
      const forwarded = req.headers["x-forwarded-for"];
      const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? "unknown";
  };
  /** Admit or refuse one upgrade for this IP; on admit the counters are charged. */
  const admitIp = (ip: string, serverId: string): string | null => {
    const now = Date.now();
    let state = ipStates.get(ip);
    if (!state) {
      state = { live: 0, windowStart: now, connections: 0, rooms: 0 };
      ipStates.set(ip, state);
    }
    if (now - state.windowStart >= RATE_WINDOW_MS) {
      state.windowStart = now;
      state.connections = 0;
      state.rooms = 0;
    }
    if (state.live >= maxConnectionsPerIp) return "too many concurrent connections";
    if (state.connections >= connectionsPerIpPerMinute) return "connection rate limit exceeded";
    const isNewRoom = roomSize(serverId) === 0;
    if (isNewRoom && state.rooms >= roomsPerIpPerMinute) return "room creation rate limit exceeded";
    state.connections += 1;
    if (isNewRoom) state.rooms += 1;
    state.live += 1;
    return null;
  };
  const releaseIp = (ip: string): void => {
    const state = ipStates.get(ip);
    if (!state) return;
    state.live = Math.max(0, state.live - 1);
    if (state.live === 0 && Date.now() - state.windowStart >= RATE_WINDOW_MS) ipStates.delete(ip);
  };

  const httpServer: Server = options.tls
    ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key })
    : createHttpServer();

  httpServer.on("request", (req, res) => {
    if (req.method === "GET" && (req.url === "/health" || req.url?.startsWith("/health?"))) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes });

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const parsed = parseJoin(req);
    if ("error" in parsed) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // Per-IP limits first: an abusive source is refused regardless of room state.
    const ip = clientIp(req);
    const overIpLimit = admitIp(ip, parsed.serverId);
    if (overIpLimit) {
      console.log(`[relay] refused ${ip}: ${overIpLimit}`);
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // The raw TCP socket outlives the handshake (ws reuses it), so one close
    // listener releases the per-IP slot for every path from here on.
    socket.once("close", () => releaseIp(ip));
    // Enforce the room / per-room socket caps before completing the handshake so
    // a flood cannot exhaust the relay.
    const overCapacity = capacityError(parsed.serverId);
    if (overCapacity) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      admit(ws as Liveness, parsed);
    });
  });

  function admit(ws: Liveness, req: JoinRequest): void {
    const { serverId } = req;
    roomSockets.set(serverId, roomSize(serverId) + 1);
    const member: RelayMember = registry.join({ ...req, socket: wsSocket(ws) } as JoinRequest);
    ws.lastSeen = Date.now();
    ws.on("pong", () => {
      ws.lastSeen = Date.now();
    });
    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      ws.lastSeen = Date.now();
      member.receive(normalize(data), isBinary);
    });
    ws.on("close", (code: number, reason: Buffer) => {
      const remaining = roomSize(serverId) - 1;
      if (remaining <= 0) roomSockets.delete(serverId);
      else roomSockets.set(serverId, remaining);
      member.disconnect(code, reason.toString("utf8"));
    });
    ws.on("error", () => {
      // The subsequent `close` event drives teardown; swallow the error here.
    });
  }

  const heartbeat = setInterval(() => {
    const now = Date.now();
    // Drop per-IP entries with no live sockets and an expired rate window.
    for (const [ip, state] of ipStates) {
      if (state.live <= 0 && now - state.windowStart >= RATE_WINDOW_MS) ipStates.delete(ip);
    }
    for (const ws of wss.clients as Set<Liveness>) {
      // A peer that stopped answering pings (dead / half-open) is reaped once it
      // passes the idle timeout, so it cannot wedge a room. A live peer keeps
      // lastSeen fresh via pong, so it is never cut.
      if (now - (ws.lastSeen ?? 0) > idleTimeoutMs) {
        ws.terminate();
        continue;
      }
      // A slow consumer whose send buffer backs up is cut so it cannot wedge a
      // room with backpressure.
      if (ws.bufferedAmount > maxBufferedBytes) {
        ws.terminate();
        continue;
      }
      try {
        ws.ping();
      } catch {
        // ignore
      }
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  const scheme = options.tls ? "wss" : "ws";
  const host = options.host ?? "0.0.0.0";
  const listenPort = options.port ?? (process.env.PORT ? Number(process.env.PORT) : 0);

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(listenPort, options.host, () => {
      httpServer.removeListener("error", reject);
      const addr = httpServer.address() as AddressInfo;
      const urlHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
      resolve({
        port: addr.port,
        url: `${scheme}://${urlHost}:${addr.port}`,
        registry,
        close: () =>
          new Promise<void>((res) => {
            clearInterval(heartbeat);
            for (const ws of wss.clients) ws.terminate();
            wss.close();
            httpServer.close(() => res());
          }),
      });
    });
  });
}

/** Adapt a `ws` socket to the router's transport-agnostic `RelaySocket`. */
function wsSocket(ws: WebSocket) {
  return {
    send(data: string | Uint8Array, isBinary: boolean): void {
      ws.send(data, { binary: isBinary });
    },
    close(code: number, reason?: string): void {
      ws.close(code, reason);
    },
  };
}

/** Collapse `ws`'s possible message shapes into a single opaque payload. */
function normalize(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
