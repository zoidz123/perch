import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DeviceInfo, PairingOffer } from "@perch/shared";
import { ensurePerchHome, perchHome } from "./home.js";
import { readOrCreateBoxKeyPair } from "./e2ee/keys.js";
import { relayClientEndpoint } from "./relayEndpoints.js";

// Pairing model (offer v1): the QR encodes a versioned offer blob carrying a
// fresh per-device token plus every endpoint the phone might reach. The `pk`
// field is reserved for the v2 E2E channel so the format never has to break.
//   perch://pair#offer=<base64url(JSON PairingOffer)>

type StoredDevice = DeviceInfo & { token: string; pushToken?: string };

type DevicesFile = {
  devices: StoredDevice[];
};

type ServerIdentity = {
  serverId: string;
  name: string;
};

export class DeviceRegistry {
  private readonly path: string;
  private devices: StoredDevice[] | undefined;
  private mtimeMs: number | undefined;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.path = join(perchHome(env), "devices.json");
  }

  list(): DeviceInfo[] {
    return this.load().map(publicDevice);
  }

  create(name?: string): { device: DeviceInfo; token: string } {
    const devices = this.load();
    const device: StoredDevice = {
      id: randomUUID(),
      name: name?.trim() || `device-${devices.length + 1}`,
      token: randomBytes(32).toString("hex"),
      createdAt: new Date().toISOString()
    };
    devices.push(device);
    this.persist(devices);
    return { device: publicDevice(device), token: device.token };
  }

  // Resolves an id or id prefix to a device. Ambiguous prefixes resolve to
  // nothing rather than silently matching several devices.
  find(id: string): DeviceInfo | undefined {
    const matched = this.match(id);
    return matched ? publicDevice(matched) : undefined;
  }

  revoke(id: string): boolean {
    const matched = this.match(id);
    if (!matched) {
      return false;
    }
    this.persist(this.load().filter((device) => device.id !== matched.id));
    return true;
  }

  private match(id: string): StoredDevice | undefined {
    if (!id) {
      return undefined;
    }
    const devices = this.load();
    const exact = devices.find((device) => device.id === id);
    if (exact) {
      return exact;
    }
    const matches = devices.filter((device) => device.id.startsWith(id));
    return matches.length === 1 ? matches[0] : undefined;
  }

  // Records the device's APNs token (called by the phone after registering
  // with the push service). Returns false for unknown devices. An APNs token
  // identifies the physical phone, so the registering device row claims it:
  // stale rows left by re-pairing the same phone lose the token, otherwise
  // one logical push would deliver once per row.
  setPushToken(deviceId: string, pushToken: string): boolean {
    const devices = this.load();
    const device = devices.find((candidate) => candidate.id === deviceId);
    if (!device) {
      return false;
    }
    let changed = false;
    for (const other of devices) {
      if (other.id !== deviceId && other.pushToken === pushToken) {
        delete other.pushToken;
        changed = true;
      }
    }
    if (device.pushToken !== pushToken) {
      device.pushToken = pushToken;
      changed = true;
    }
    if (changed) {
      this.persist(devices);
    }
    return true;
  }

  // APNs tokens of every paired device, for the push sender. Deduped so
  // registries written before setPushToken claimed tokens still push once
  // per physical device.
  pushTokens(): string[] {
    const tokens = this.load()
      .map((device) => device.pushToken)
      .filter((token): token is string => typeof token === "string" && token.length > 0);
    return [...new Set(tokens)];
  }

  // Returns the matching device for a presented token, updating lastSeenAt at
  // most once a minute so auth checks stay cheap.
  verify(token: string): DeviceInfo | undefined {
    if (!token) {
      return undefined;
    }
    const devices = this.load();
    const device = devices.find((candidate) => tokensEqual(candidate.token, token));
    if (!device) {
      return undefined;
    }

    const now = Date.now();
    const last = device.lastSeenAt ? Date.parse(device.lastSeenAt) : 0;
    if (now - last > 60_000) {
      device.lastSeenAt = new Date(now).toISOString();
      this.persist(devices);
    }
    return publicDevice(device);
  }

  private load(): StoredDevice[] {
    const mtime = this.fileMtime();
    if (this.devices && mtime === this.mtimeMs) {
      return this.devices;
    }
    this.mtimeMs = mtime;
    try {
      if (mtime !== undefined) {
        const parsed = JSON.parse(readFileSync(this.path, "utf8")) as DevicesFile;
        this.devices = Array.isArray(parsed.devices) ? parsed.devices : [];
        return this.devices;
      }
    } catch {
      // Corrupt registry falls through to empty; pairing again recreates it.
    }
    this.devices = [];
    return this.devices;
  }

  private fileMtime(): number | undefined {
    try {
      return statSync(this.path).mtimeMs;
    } catch {
      return undefined;
    }
  }

  private persist(devices: StoredDevice[]): void {
    this.devices = devices;
    ensurePerchHome();
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ devices } satisfies DevicesFile, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    this.mtimeMs = this.fileMtime();
  }
}

function publicDevice(device: StoredDevice): DeviceInfo {
  const { token: _token, ...info } = device;
  return info;
}

// Constant-time token comparison (hashing first equalizes lengths).
export function tokensEqual(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

// The name the phone shows for this Mac. os.hostname() is often a terse,
// dash-mangled value ("Mac"); the user-facing computer name (Settings >
// General > About, i.e. `scutil --get ComputerName`) is what people actually
// recognize, so prefer it on macOS and fall back to the network hostname.
function hostDisplayName(): string {
  if (process.platform === "darwin") {
    try {
      const name = execFileSync("scutil", ["--get", "ComputerName"], {
        encoding: "utf8",
        timeout: 1000
      }).trim();
      if (name) {
        return name;
      }
    } catch {
      // Fall back to the network hostname below.
    }
  }
  return hostname().replace(/\.local$/, "");
}

// Stable server identity, created on first boot. The serverId lets the app
// recognize a re-paired Mac as the same host; the name is what the app shows.
// The name is refreshed from the current computer name each call (cheap, only
// hit at pairing time) so renaming the Mac shows up without losing the id.
export function serverIdentity(env: NodeJS.ProcessEnv = process.env): ServerIdentity {
  const path = join(ensurePerchHome(env), "server.json");
  const name = hostDisplayName();

  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ServerIdentity>;
      if (parsed.serverId) {
        if (parsed.name !== name) {
          writeFileSync(path, JSON.stringify({ serverId: parsed.serverId, name }, null, 2), { mode: 0o600 });
        }
        return { serverId: parsed.serverId, name };
      }
    } catch {
      // Rewrite below.
    }
  }

  const identity: ServerIdentity = {
    serverId: randomUUID(),
    name
  };
  writeFileSync(path, JSON.stringify(identity, null, 2), { mode: 0o600 });
  return identity;
}

// Every direct route the phone might reach, most-likely-first: private LAN
// ranges, then CGNAT 100.64/10, then anything else routable.
export function enumerateEndpoints(port: number): string[] {
  const addresses: { address: string; rank: number }[] = [];

  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) {
        continue;
      }
      addresses.push({ address: entry.address, rank: rankAddress(entry.address) });
    }
  }

  addresses.sort((a, b) => a.rank - b.rank);
  const endpoints = addresses.map(({ address }) => `http://${address}:${port}`);

  const local = `${hostname().replace(/\.local$/, "")}.local`;
  endpoints.push(`http://${local}:${port}`);

  return [...new Set(endpoints)];
}

function rankAddress(address: string): number {
  const [a, b] = address.split(".").map(Number);
  if (a === 192 && b === 168) return 0;
  if (a === 10) return 0;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return 0;
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return 1; // CGNAT
  return 2;
}

export function buildOffer(options: {
  registry: DeviceRegistry;
  port: number;
  deviceName?: string;
  env?: NodeJS.ProcessEnv;
  // Resolved relay origin (config.relayUrl). Undefined = LAN-only: the offer
  // advertises no relay endpoint. Threaded in so the offer advertises the same
  // relay the server dials - including the baked default - rather than reading
  // PERCH_RELAY_URL directly and missing the default.
  relayUrl?: string;
}): { offer: PairingOffer; url: string; device: DeviceInfo } {
  const identity = serverIdentity(options.env);
  const keys = readOrCreateBoxKeyPair(options.env);
  const { device, token } = options.registry.create(options.deviceName);
  const offer: PairingOffer = {
    v: 1,
    serverId: identity.serverId,
    name: identity.name,
    endpoints: relayEndpoints(enumerateEndpoints(options.port), identity.serverId, options.relayUrl),
    token,
    pk: keys.publicKeyB64
  };
  return { offer, url: offerUrl(offer), device };
}

// Appends the relay reach URL (when a relay is configured) after direct
// endpoints, so it is the lowest-ranked entry the phone's prober tries:
// at home a direct endpoint answers and wins; away, only the relay answers. The
// relay is just another endpoint, not a mode switch. A malformed relay URL is
// dropped rather than breaking pairing.
function relayEndpoints(
  base: string[],
  serverId: string,
  relayUrl: string | undefined
): string[] {
  if (!relayUrl) {
    return base;
  }
  try {
    return [...base, relayClientEndpoint(relayUrl, serverId)];
  } catch {
    return base;
  }
}

export function offerUrl(offer: PairingOffer): string {
  const encoded = Buffer.from(JSON.stringify(offer), "utf8").toString("base64url");
  return `perch://pair#offer=${encoded}`;
}
