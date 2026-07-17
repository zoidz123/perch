import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_RELAY_URL, readConfig, resolveRelayUrl } from "./config.js";

function makeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "perch-config-"));
  return { PERCH_HOME: home, PERCH_TOKEN: "test-token", ...extra };
}

test("PERCH_RELAY_URL unset resolves to the baked default relay", () => {
  assert.equal(resolveRelayUrl({}), DEFAULT_RELAY_URL);
  const env = makeEnv();
  assert.equal(readConfig(env).relayUrl, DEFAULT_RELAY_URL);
  rmSync(env.PERCH_HOME as string, { recursive: true, force: true });
});

test("PERCH_RELAY_URL set to a ws(s) URL overrides the default", () => {
  assert.equal(resolveRelayUrl({ PERCH_RELAY_URL: "wss://my-own" }), "wss://my-own");
  assert.equal(resolveRelayUrl({ PERCH_RELAY_URL: "  ws://box:9000  " }), "ws://box:9000");
  const env = makeEnv({ PERCH_RELAY_URL: "wss://my-own" });
  assert.equal(readConfig(env).relayUrl, "wss://my-own");
  rmSync(env.PERCH_HOME as string, { recursive: true, force: true });
});

test("PERCH_RELAY_URL off/none/0/empty disables the relay (LAN-only opt-out)", () => {
  for (const value of ["", "  ", "off", "OFF", "none", "None", "0"]) {
    assert.equal(resolveRelayUrl({ PERCH_RELAY_URL: value }), undefined, `value=${JSON.stringify(value)}`);
  }
  const env = makeEnv({ PERCH_RELAY_URL: "off" });
  assert.equal(readConfig(env).relayUrl, undefined);
  rmSync(env.PERCH_HOME as string, { recursive: true, force: true });
});
