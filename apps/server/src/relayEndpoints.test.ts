import assert from "node:assert/strict";
import { test } from "node:test";
import { relayClientEndpoint, relayControlUrl, relayDataUrl } from "./relayEndpoints.js";

test("control URL joins the room as the server control socket", () => {
  assert.equal(
    relayControlUrl("wss://relay.example", "SID"),
    "wss://relay.example/ws?serverId=SID&role=server&v=2"
  );
});

test("data URL carries the per-connection routing id", () => {
  assert.equal(
    relayDataUrl("wss://relay.example", "SID", "conn_abc"),
    "wss://relay.example/ws?serverId=SID&role=server&connectionId=conn_abc&v=2"
  );
});

test("client reach endpoint is http(s) so it survives the phone's isHTTPEndpoint check", () => {
  // The server dials wss:// but the OFFER must advertise http(s):// (the phone
  // upgrades it to wss:// at connect time exactly as it does for LAN endpoints).
  assert.equal(
    relayClientEndpoint("wss://relay.example", "SID"),
    "https://relay.example/ws?serverId=SID&role=client&v=2"
  );
  assert.equal(
    relayClientEndpoint("https://relay.example", "SID"),
    "https://relay.example/ws?serverId=SID&role=client&v=2"
  );
});

test("plain (non-TLS) relay origins coerce to ws / http", () => {
  assert.equal(
    relayControlUrl("http://localhost:8080", "SID"),
    "ws://localhost:8080/ws?serverId=SID&role=server&v=2"
  );
  assert.equal(
    relayClientEndpoint("ws://localhost:8080", "SID"),
    "http://localhost:8080/ws?serverId=SID&role=client&v=2"
  );
});

test("a trailing slash and a port are preserved on the origin", () => {
  assert.equal(
    relayControlUrl("wss://relay.example:9443/", "SID"),
    "wss://relay.example:9443/ws?serverId=SID&role=server&v=2"
  );
});

test("routing ids are query-encoded", () => {
  assert.equal(
    relayClientEndpoint("wss://relay.example", "a b/c"),
    "https://relay.example/ws?serverId=a+b%2Fc&role=client&v=2"
  );
});

test("a malformed relay origin is rejected", () => {
  assert.throws(() => relayControlUrl("relay.example", "SID"), /invalid relay url/i);
  assert.throws(() => relayControlUrl("ftp://relay.example", "SID"), /invalid relay url/i);
});
