/**
 * @perch/relay - a standalone, stateless, content-blind WebSocket relay.
 *
 * It pairs the perch server's outbound sockets with a paired phone's sockets by
 * room (`serverId`) and forwards OPAQUE end-to-end-encrypted frames it cannot
 * read. It holds no database and no durable state; on restart both sides
 * reconnect and re-form their rooms.
 */

export { startRelayServer } from "./server.js";
export type { RelayServer, RelayServerOptions } from "./server.js";
export { RelayRegistry } from "./rooms.js";
export type {
  ControlNotice,
  FrameData,
  JoinRequest,
  RelayMember,
  RelaySocket,
} from "./rooms.js";
