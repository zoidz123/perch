import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildOffer, DeviceRegistry, enumerateEndpoints, offerUrl, serverIdentity } from "./pairing.js";
import { DEFAULT_RELAY_URL, resolveRelayUrl } from "./config.js";
import { relayClientEndpoint } from "./relayEndpoints.js";

function makeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PERCH_HOME: mkdtempSync(join(tmpdir(), "perch-pair-")), ...extra };
}

test("device registry creates, verifies, and revokes device tokens", () => {
  const env = makeEnv();
  const registry = new DeviceRegistry(env);

  const { device, token } = registry.create("example-iphone");
  assert.equal(device.name, "example-iphone");
  assert.match(token, /^[0-9a-f]{64}$/);

  const verified = registry.verify(token);
  assert.equal(verified?.id, device.id);
  assert.equal(registry.verify("not-a-token"), undefined);

  assert.equal(registry.revoke(device.id), true);
  assert.equal(registry.verify(token), undefined);
  assert.equal(registry.revoke(device.id), false);
  rmSync(env.PERCH_HOME as string, { recursive: true, force: true });
});

test("re-registering a push token moves it to the claiming device", () => {
  const env = makeEnv();
  const registry = new DeviceRegistry(env);

  // The same phone paired twice (two rows) registers the same APNs token.
  const first = registry.create("boss-iphone");
  const second = registry.create("boss-iphone");
  assert.equal(registry.setPushToken(first.device.id, "apns-token-a"), true);
  assert.equal(registry.setPushToken(second.device.id, "apns-token-a"), true);

  assert.deepEqual(registry.pushTokens(), ["apns-token-a"], "one physical phone pushes once");

  // The claim survives reload: the stale row no longer holds the token.
  const reloaded = new DeviceRegistry(env);
  assert.deepEqual(reloaded.pushTokens(), ["apns-token-a"]);

  // A different phone's token coexists.
  const other = registry.create("other-phone");
  registry.setPushToken(other.device.id, "apns-token-b");
  assert.deepEqual(registry.pushTokens().sort(), ["apns-token-a", "apns-token-b"]);
  assert.equal(registry.setPushToken("unknown-device", "apns-token-c"), false);
  rmSync(env.PERCH_HOME as string, { recursive: true, force: true });
});

test("pushTokens dedupes duplicate rows already on disk", () => {
  const env = makeEnv();
  const registry = new DeviceRegistry(env);
  const first = registry.create("boss-iphone");
  const second = registry.create("boss-iphone");

  // A registry written before setPushToken claimed tokens: two rows, same token.
  const path = join(env.PERCH_HOME as string, "devices.json");
  const stored = JSON.parse(readFileSync(path, "utf8")) as {
    devices: Array<{ id: string; pushToken?: string }>;
  };
  for (const device of stored.devices) {
    if (device.id === first.device.id || device.id === second.device.id) {
      device.pushToken = "apns-token-dup";
    }
  }
  writeFileSync(path, JSON.stringify(stored, null, 2));
  utimesSync(path, new Date(), new Date(Date.now() + 5_000));

  assert.deepEqual(registry.pushTokens(), ["apns-token-dup"]);
  rmSync(env.PERCH_HOME as string, { recursive: true, force: true });
});

test("device registry survives reload from disk", () => {
  const env = makeEnv();
  const { token } = new DeviceRegistry(env).create("phone");

  const reloaded = new DeviceRegistry(env);
  assert.ok(reloaded.verify(token));
  assert.equal(reloaded.list().length, 1);
  rmSync(env.PERCH_HOME as string, { recursive: true, force: true });
});

test("device registry picks up external edits to devices.json", () => {
  const env = makeEnv();
  const registry = new DeviceRegistry(env);
  const { token } = registry.create("phone");
  assert.ok(registry.verify(token));

  // Simulate an out-of-band revocation (editing devices.json by hand).
  const path = join(env.PERCH_HOME as string, "devices.json");
  writeFileSync(path, JSON.stringify({ devices: [] }, null, 2));
  utimesSync(path, new Date(), new Date(Date.now() + 5_000));

  assert.equal(registry.verify(token), undefined, "an externally removed token stays revoked");
  assert.equal(registry.list().length, 0);
  rmSync(env.PERCH_HOME as string, { recursive: true, force: true });
});

test("server identity is stable across calls", () => {
  const env = makeEnv();
  const first = serverIdentity(env);
  const second = serverIdentity(env);

  assert.equal(first.serverId, second.serverId);
  assert.ok(first.name.length > 0);
  rmSync(env.PERCH_HOME as string, { recursive: true, force: true });
});

test("offer encodes a scannable perch://pair URL and round-trips", () => {
  const env = makeEnv();
  const registry = new DeviceRegistry(env);
  const { offer, url } = buildOffer({ registry, port: 8787, env });

  assert.equal(offer.v, 1);
  assert.ok(offer.endpoints.length > 0);
  assert.ok(offer.endpoints.every((endpoint) => endpoint.startsWith("http://")));
  assert.ok(url.startsWith("perch://pair#offer="));

  const encoded = url.slice("perch://pair#offer=".length);
  const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  assert.deepEqual(decoded, offer);
  assert.equal(offerUrl(offer), url);

  // The offer token authorizes the device that was just created.
  assert.ok(registry.verify(offer.token));

  // pk carries the server's long-term box public key: base64, 32 bytes. It is
  // the capability marker that gates the encrypted transport.
  assert.ok(offer.pk, "offer publishes the box public key");
  assert.equal(Buffer.from(offer.pk as string, "base64").length, 32);
  rmSync(env.PERCH_HOME as string, { recursive: true, force: true });
});

test("endpoint enumeration includes the .local hostname and ranks LAN first", () => {
  const endpoints = enumerateEndpoints(9999);
  assert.ok(endpoints.some((endpoint) => endpoint.includes(".local:9999")));
  assert.ok(endpoints.every((endpoint) => endpoint.endsWith(":9999")));
});

test("the offer advertises the resolved default relay when PERCH_RELAY_URL is unset", () => {
  const env = makeEnv();
  // The offer must reflect config.relayUrl (resolved), so the baked default -
  // not just an explicit env value - reaches the phone out of the box.
  const relayUrl = resolveRelayUrl(env);
  assert.equal(relayUrl, DEFAULT_RELAY_URL);
  const { offer } = buildOffer({ registry: new DeviceRegistry(env), port: 8787, env, relayUrl });

  const relayEndpoint = offer.endpoints.at(-1) as string;
  assert.equal(
    relayEndpoint,
    `${relayClientEndpoint(DEFAULT_RELAY_URL, offer.serverId)}`
  );
  assert.ok(relayEndpoint.includes("/ws?"));
  rmSync(env.PERCH_HOME as string, { recursive: true, force: true });
});

test("no relay endpoint is advertised when the relay is disabled (PERCH_RELAY_URL=off)", () => {
  const env = makeEnv({ PERCH_RELAY_URL: "off" });
  const relayUrl = resolveRelayUrl(env);
  assert.equal(relayUrl, undefined);
  const { offer } = buildOffer({ registry: new DeviceRegistry(env), port: 8787, env, relayUrl });
  assert.ok(!offer.endpoints.some((endpoint) => endpoint.includes("/ws?")));
  rmSync(env.PERCH_HOME as string, { recursive: true, force: true });
});

test("a configured relay is advertised as the lowest-ranked (last) endpoint", () => {
  const env = makeEnv({ PERCH_RELAY_URL: "wss://relay.perch.example" });
  const { offer } = buildOffer({
    registry: new DeviceRegistry(env),
    port: 8787,
    env,
    relayUrl: resolveRelayUrl(env)
  });

  // Ranked below direct endpoints: it is the final entry the prober tries.
  const relayEndpoint = offer.endpoints.at(-1) as string;
  assert.equal(
    relayEndpoint,
    `https://relay.perch.example/ws?serverId=${offer.serverId}&role=client&v=2`
  );
  // http(s) so the phone's isHTTPEndpoint validation accepts it.
  assert.ok(relayEndpoint.startsWith("https://"));
  // Additive: the LAN endpoints are untouched and still present.
  assert.ok(offer.endpoints.some((endpoint) => endpoint.startsWith("http://") && endpoint.includes(":8787")));
  rmSync(env.PERCH_HOME as string, { recursive: true, force: true });
});

test("a malformed relay URL is ignored rather than breaking the offer", () => {
  const env = makeEnv();
  const { offer } = buildOffer({
    registry: new DeviceRegistry(env),
    port: 8787,
    env,
    relayUrl: "not-a-url"
  });
  assert.ok(!offer.endpoints.some((endpoint) => endpoint.includes("/ws?")));
  assert.ok(offer.endpoints.length > 0);
  rmSync(env.PERCH_HOME as string, { recursive: true, force: true });
});
