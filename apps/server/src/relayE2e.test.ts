import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import nacl from "tweetnacl";
import { WebSocket } from "ws";
import type {
  AgentSession,
  FleetEvent,
  RecentEventsResult,
  StartAgentRequest,
  UsageResponse
} from "@perch/shared";
import { startRelayServer } from "@perch/relay";
import type { AgentAdapter } from "./adapters/types.js";
import { AuditLog } from "./audit.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { DeviceRegistry, tokensEqual } from "./pairing.js";
import { deriveSharedKey, openFrame, sealFrame } from "./e2ee/crypto.js";
import { RelayClient } from "./relayClient.js";
import { createControlServer, type HttpServerOptions } from "./http.js";
import { HookRegistry } from "./hooks.js";
import { TimelineStore } from "./timeline.js";
import { ProjectRegistry } from "./projects.js";
import { TaskStore } from "./tasks.js";
import { WorktreePool } from "./worktrees.js";
import { PrPoller } from "./prPoller.js";

// Phase 1 E2E: a phone reaches a real FleetMonitor purely through the relay,
// end-to-end encrypted. Proves the acceptance criteria that build/unit-level
// checks can carry: (1) the relay only ever forwards ciphertext (zero
// knowledge), and (2) a mutating action over the relay still lands in the audit
// log with the correct deviceId. The real-device off-LAN test is Phase 2.

const serverKeys = nacl.box.keyPair();

function readFileSyncSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class FakeAdapter implements AgentAdapter {
  readonly name = "fake";
  inputs: string[] = [];
  started: StartAgentRequest[] = [];
  constructor(private readonly sessions: AgentSession[]) {}
  async getTopology() {
    return { windows: [], generatedAt: "" };
  }
  async listSessions(): Promise<AgentSession[]> {
    return this.sessions;
  }
  async readRecentEvents(sessionId: string): Promise<RecentEventsResult> {
    return { events: [{ type: "terminal_output", sessionId, text: "", at: "" }], terminal: true };
  }
  async sendInput(_sessionId: string, text: string): Promise<void> {
    this.inputs.push(text);
  }
  async sendEnter(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async startAgent(request: StartAgentRequest): Promise<AgentSession> {
    this.started.push(request);
    return {
      id: "spawned-1",
      title: "spawned-1",
      agent: "claude",
      workspaceId: "perch-pty",
      kind: "terminal",
      status: "idle",
      lastActivityAt: ""
    };
  }
  subscribeFleetEvents(_handler: (event: FleetEvent) => void): () => void {
    return () => {};
  }
}

// The phone: dials the relay as a client, runs the e2ee handshake, authorizes,
// and records BOTH the raw inbound frames (to prove they are ciphertext) and the
// decrypted plaintext.
function makePhone(relayUrl: string, serverId: string, token: string) {
  const ephemeral = nacl.box.keyPair();
  const shared = deriveSharedKey(ephemeral.secretKey, serverKeys.publicKey);
  const ws = new WebSocket(`${relayUrl}/ws?serverId=${serverId}&role=client&v=2`);
  const rawInbound: string[] = [];
  const plaintext: string[] = [];
  const rawOutbound: string[] = [];
  let ready = false;

  const send = (frame: string): void => {
    rawOutbound.push(frame);
    ws.send(frame);
  };

  ws.on("open", () => {
    send(JSON.stringify({ type: "e2ee_hello", key: Buffer.from(ephemeral.publicKey).toString("base64") }));
  });
  ws.on("message", (raw: Buffer) => {
    const text = raw.toString();
    rawInbound.push(text);
    if (text.includes("e2ee_ready")) {
      if (!ready) {
        ready = true;
        send(sealFrame(shared, new TextEncoder().encode(JSON.stringify({ type: "e2ee_auth", token }))));
      }
      return;
    }
    plaintext.push(new TextDecoder().decode(openFrame(shared, text)));
  });

  return {
    isReady: () => ready,
    rawInbound,
    rawOutbound,
    plaintext,
    sendApp(message: unknown): void {
      send(sealFrame(shared, new TextEncoder().encode(JSON.stringify(message))));
    }
  };
}

test("phone drives a live session through the relay, encrypted end-to-end and audited", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-relay-e2e-"));
  const env: NodeJS.ProcessEnv = { PERCH_HOME: home };
  const auditPath = join(home, "audit.jsonl");

  const relay = await startRelayServer({ port: 0, host: "127.0.0.1" });
  const serverId = "e2e-room";

  const devices = new DeviceRegistry(env);
  const { device, token } = devices.create("kevins-phone");
  const authToken = "server-token";
  const auditLog = new AuditLog(auditPath);

  const adapter = new FakeAdapter([
    {
      id: "sess-1",
      title: "sess-1",
      agent: "claude",
      workspaceId: "perch-pty",
      kind: "terminal",
      status: "idle",
      lastActivityAt: ""
    }
  ]);
  const monitor = new FleetMonitor(adapter, { auditLog });
  const hooks = new HookRegistry();
  const timeline = new TimelineStore();
  const projects = new ProjectRegistry(env);
  const tasks = new TaskStore(env);
  const worktrees = new WorktreePool({ env });
  const prPoller = new PrPoller(tasks, async () => undefined);
  let usageCollections = 0;
  const usage: UsageResponse = {
    at: "2026-07-15T12:00:00.000Z",
    providers: [
      {
        provider: "codex",
        available: true,
        windows: [
          {
            kind: "week",
            percentUsed: 41,
            resetsAt: "2026-07-20T12:00:00.000Z",
            windowMinutes: 10_080
          }
        ]
      }
    ]
  };
  monitor.setStartAgentLauncher(async ({ request, auditMeta }) => {
    const session = await adapter.startAgent(request);
    await auditLog.write({
      action: "start_agent",
      sessionId: session.id,
      ...auditMeta,
      command: request.command,
      cwd: request.cwd
    });
    return { session };
  });
  const serverOptions: HttpServerOptions = {
    adapter,
    auditLog,
    authToken,
    boxSecretKey: serverKeys.secretKey,
    monitor,
    devices,
    port: 0,
    relayUrl: relay.url,
    hooks,
    timeline,
    projects,
    worktrees,
    tasks,
    prPoller,
    usageCollector: async () => {
      usageCollections += 1;
      return usage;
    }
  };
  const controlServer = createControlServer(serverOptions);
  await new Promise<void>((resolve) => controlServer.listen(0, "127.0.0.1", resolve));
  const controlAddress = controlServer.address();
  assert.ok(controlAddress && typeof controlAddress !== "string");

  const directUsageResponse = await fetch(`http://127.0.0.1:${controlAddress.port}/usage`, {
    headers: { Authorization: `Bearer ${authToken}` }
  });
  assert.equal(directUsageResponse.status, 200);
  assert.deepEqual(await directUsageResponse.json(), usage);

  const relayClient = new RelayClient({
    url: relay.url,
    serverId,
    secretKey: serverKeys.secretKey,
    verifyToken: (presented) => {
      if (tokensEqual(presented, authToken)) return { kind: "server" };
      const d = devices.verify(presented);
      return d ? { kind: "device", deviceId: d.id } : undefined;
    },
    addClient: (socket, sessionId, auth) => monitor.addClient(socket, sessionId, auth)
  });
  relayClient.start();

  const phone = makePhone(relay.url, serverId, token);

  // The monitor greets an authorized client with hello + fleet; both arrive
  // encrypted over the relay.
  await waitFor(() => phone.plaintext.some((f) => f.includes("\"fleet\"")));
  assert.ok(phone.plaintext.some((f) => f.includes("\"hello\"")));

  // A mutating action: the phone types into a live session.
  phone.sendApp({ type: "input", sessionId: "sess-1", data: "echo hi\n" });
  await waitFor(() => adapter.inputs.includes("echo hi\n"));

  // Audit lands with the correct deviceId, identical to the LAN path.
  await waitFor(() => {
    try {
      return readFileSync(auditPath, "utf8").includes("\"input\"");
    } catch {
      return false;
    }
  });
  const records = readFileSync(auditPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { action: string; deviceId?: string; sessionId?: string });
  const inputRecord = records.find((r) => r.action === "input");
  assert.ok(inputRecord, "input action is audited");
  assert.equal(inputRecord?.deviceId, device.id);
  assert.equal(inputRecord?.sessionId, "sess-1");

  // A second mutating WS action over the relay (start_agent) is audited with the
  // same deviceId: the audit layer keys off the E2E-verified device identity, not
  // the transport, so relay and LAN paths record identically.
  phone.sendApp({ type: "start_agent", request: { command: "claude", cwd: "/tmp/perch" } });
  await waitFor(() => adapter.started.length === 1);
  await waitFor(() => readFileSyncSafe(auditPath).includes("\"start_agent\""));
  const startRecord = readFileSyncSafe(auditPath)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { action: string; deviceId?: string })
    .find((r) => r.action === "start_agent");
  assert.ok(startRecord, "start_agent action is audited over the relay");
  assert.equal(startRecord?.deviceId, device.id);

  // The new relay path tunnels REST-equivalent phone commands as request/response
  // RPC over the same encrypted data socket. These frames must only appear after
  // E2EE auth, never as HTTP calls to the relay.
  phone.sendApp({ type: "rpc", id: "rpc-sessions", method: "GET", path: "/sessions" });
  await waitFor(() => phone.plaintext.some((f) => f.includes("\"id\":\"rpc-sessions\"")));
  const sessionsRpc = JSON.parse(
    phone.plaintext.find((f) => f.includes("\"id\":\"rpc-sessions\""))!
  ) as {
    type: string;
    ok: boolean;
    body?: { sessions?: AgentSession[] };
  };
  assert.equal(sessionsRpc.type, "rpc_response");
  assert.equal(sessionsRpc.ok, true);
  assert.equal(sessionsRpc.body?.sessions?.[0]?.id, "sess-1");

  phone.sendApp({ type: "rpc", id: "rpc-usage", method: "GET", path: "/usage" });
  await waitFor(() => phone.plaintext.some((f) => f.includes("\"id\":\"rpc-usage\"")));
  const usageRpc = JSON.parse(phone.plaintext.find((f) => f.includes("\"id\":\"rpc-usage\""))!) as {
    ok: boolean;
    body?: UsageResponse;
  };
  assert.equal(usageRpc.ok, true);
  assert.deepEqual(usageRpc.body, usage);
  assert.equal(usageCollections, 2, "direct HTTP and relay RPC each issue a usage collection");

  phone.sendApp({
    type: "rpc",
    id: "rpc-push",
    method: "POST",
    path: "/devices/push-token",
    body: { pushToken: "apns-token-test" }
  });
  await waitFor(() => phone.plaintext.some((f) => f.includes("\"id\":\"rpc-push\"")));
  const pushRpc = JSON.parse(phone.plaintext.find((f) => f.includes("\"id\":\"rpc-push\""))!) as {
    ok: boolean;
    status: number;
  };
  assert.equal(pushRpc.ok, true);
  assert.equal(pushRpc.status, 200);

  // Content-blind data plane: everything the relay carried is ciphertext, except the two
  // public-key handshake frames. No app-frame JSON ever crossed the relay in
  // cleartext, and the device token never appeared on the wire.
  const handshakeOnly = (frame: string): boolean =>
    frame.includes("e2ee_hello") || frame.includes("e2ee_ready");
  for (const frame of phone.rawInbound) {
    if (handshakeOnly(frame)) continue;
    assert.ok(!frame.includes("\"type\""), `inbound app frame must be ciphertext, saw plaintext: ${frame}`);
  }
  for (const frame of phone.rawOutbound) {
    if (handshakeOnly(frame)) continue;
    assert.ok(!frame.includes("\"type\""), `outbound app frame must be ciphertext, saw plaintext: ${frame}`);
    assert.ok(!frame.includes(token), "the device token never crosses the relay in cleartext");
  }

  relayClient.stop();
  await new Promise<void>((resolve, reject) => controlServer.close((error) => (error ? reject(error) : resolve())));
  await relay.close();
  rmSync(home, { recursive: true, force: true });
});
