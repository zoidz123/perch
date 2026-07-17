/**
 * Relay reach URLs, derived from one configured relay origin.
 *
 * The perch server dials the relay outbound over `ws(s)://`; the pairing offer
 * must advertise the phone's reach URL over `http(s)://` (so it survives the
 * iOS `isHTTPEndpoint` validation), and the phone upgrades it to `wss://` at
 * connect time exactly as it already does for LAN endpoints. All three URLs are
 * the same origin plus the relay's `/ws` path and a room-scoped query:
 *
 *   control (server): wss://<origin>/ws?serverId=<id>&role=server&v=2
 *   data (server):    wss://<origin>/ws?serverId=<id>&role=server&connectionId=<cid>&v=2
 *   client (phone):   https://<origin>/ws?serverId=<id>&role=client&v=2
 *
 * The room key is `serverId`; the relay pairs each phone `client` socket with
 * the matching server `data` socket and forwards opaque frames between them.
 */

type Family = "ws" | "http";

function splitOrigin(origin: string): { secure: boolean; rest: string } {
  const match = origin.trim().match(/^(https?|wss?):\/\/(.+)$/i);
  if (!match) {
    throw new Error(`invalid relay url: ${origin}`);
  }
  const scheme = match[1].toLowerCase();
  const secure = scheme === "https" || scheme === "wss";
  // Strip any trailing slashes so we can append the `/ws` path cleanly.
  const rest = match[2].replace(/\/+$/, "");
  return { secure, rest };
}

function build(origin: string, family: Family, params: Record<string, string>): string {
  const { secure, rest } = splitOrigin(origin);
  const scheme =
    family === "ws" ? (secure ? "wss" : "ws") : secure ? "https" : "http";
  const query = new URLSearchParams(params).toString();
  return `${scheme}://${rest}/ws?${query}`;
}

/** The server's single control socket for a room (no connectionId). */
export function relayControlUrl(origin: string, serverId: string): string {
  return build(origin, "ws", { serverId, role: "server", v: "2" });
}

/** The server's per-phone data socket, paired to one client connection. */
export function relayDataUrl(origin: string, serverId: string, connectionId: string): string {
  return build(origin, "ws", { serverId, role: "server", connectionId, v: "2" });
}

/** The phone's reach URL, advertised in the pairing offer (http(s)). */
export function relayClientEndpoint(origin: string, serverId: string): string {
  return build(origin, "http", { serverId, role: "client", v: "2" });
}
