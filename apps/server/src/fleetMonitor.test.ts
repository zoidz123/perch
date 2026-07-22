import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, test } from "node:test";
import type {
  AgentSession,
  FleetEvent,
  RecentEventsResult,
  StartAgentRequest,
  SurfaceKind
} from "@perch/shared";
import type { WebSocket } from "ws";
import type { AgentAdapter } from "./adapters/types.js";
import { FleetMonitor } from "./fleetMonitor.js";
import type { PromptDeliveryTracker } from "./promptDeliveries.js";

function session(id: string, kind: SurfaceKind, workspaceId: string): AgentSession {
  return {
    id,
    title: id,
    agent: "shell",
    workspaceId,
    kind,
    status: "idle",
    lastActivityAt: ""
  };
}

class FakeAdapter implements AgentAdapter {
  readonly name = "fake";
  listSessionsCalls = 0;
  readCalls: Array<{ id: string; lines: number }> = [];
  subscribeCalls = 0;
  unsubscribeCalls = 0;
  private handler?: (event: FleetEvent) => void;

  constructor(private sessions: AgentSession[]) {}

  async getTopology() {
    return { windows: [], generatedAt: "" };
  }

  async listSessions(): Promise<AgentSession[]> {
    this.listSessionsCalls += 1;
    return this.sessions;
  }

  async readRecentEvents(sessionId: string, lines: number): Promise<RecentEventsResult> {
    this.readCalls.push({ id: sessionId, lines });
    const isBrowser = this.sessions.find((s) => s.id === sessionId)?.kind === "browser";
    if (isBrowser) {
      return { events: [], terminal: false, note: "not a terminal" };
    }
    return {
      events: [{ type: "terminal_output", sessionId, text: `out-${sessionId}`, at: "" }],
      terminal: true
    };
  }

  inputs: string[] = [];

  async sendInput(_sessionId: string, text: string): Promise<void> {
    this.inputs.push(text);
  }
  async sendEnter(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async startAgent(request: StartAgentRequest): Promise<AgentSession> {
    const next = {
      ...session("P", "terminal", "perch-pty"),
      agent: request.agent ?? "codex",
      title: request.title ?? request.command,
      cwd: request.cwd
    };
    this.sessions.push(next);
    return next;
  }

  subscribeFleetEvents(handler: (event: FleetEvent) => void): () => void {
    this.subscribeCalls += 1;
    this.handler = handler;
    return () => {
      this.unsubscribeCalls += 1;
      this.handler = undefined;
    };
  }

  emit(event: FleetEvent): void {
    this.handler?.(event);
  }
}

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  fleets(): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m.type === "fleet");
  }

  events(): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m.type === "event");
  }
}

function asWebSocket(socket: FakeSocket): WebSocket {
  return socket as unknown as WebSocket;
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function monitor(adapter: AgentAdapter): FleetMonitor {
  return new FleetMonitor(adapter, {
    reconcileMs: 10_000,
    broadcastMs: 5,
    tailThrottleMs: 1,
    detailThrottleMs: 1
  });
}

test("durable prompt delivery warnings replay on every fleet snapshot", async () => {
  const adapter = new FakeAdapter([session("A", "terminal", "wsA")]);
  let warning: AgentSession["promptDeliveryWarning"] = {
    deliveryId: "delivery-1",
    message: "Delivery unknown",
    at: "2026-07-22T00:00:00.000Z"
  };
  const hub = new FleetMonitor(adapter, { promptDeliveryWarning: () => warning });
  after(() => hub.stop());

  assert.deepEqual(hub.withLiveState(await adapter.listSessions())[0]?.promptDeliveryWarning, warning);
  warning = undefined;
  assert.equal(hub.withLiveState(await adapter.listSessions())[0]?.promptDeliveryWarning, undefined);
});

test("an adapter-reported session exit closes outstanding prompt deliveries", async () => {
  const adapter = new FakeAdapter([session("A", "terminal", "wsA")]);
  const ended: string[] = [];
  const promptDeliveries = {
    markSessionEnded: (sessionId: string) => ended.push(sessionId),
    reconcileActiveSessions: () => {}
  } as unknown as PromptDeliveryTracker;
  const hub = new FleetMonitor(adapter, {
    reconcileMs: 10_000,
    broadcastMs: 5,
    promptDeliveries
  });
  after(() => hub.stop());
  hub.addClient(asWebSocket(new FakeSocket()));
  await tick(20);

  adapter.emit({
    kind: "status",
    sessionId: "A",
    status: "done",
    at: new Date().toISOString()
  });
  assert.deepEqual(ended, ["A"]);
});

test("does no adapter work until a client connects, and stops after the last disconnects", async () => {
  const adapter = new FakeAdapter([session("A", "terminal", "wsA")]);
  const hub = monitor(adapter);
  after(() => hub.stop());

  await tick(20);
  assert.equal(adapter.listSessionsCalls, 0, "no clients means no adapter work");
  assert.equal(adapter.subscribeCalls, 0, "no event subscription without clients");

  const socket = new FakeSocket();
  hub.addClient(asWebSocket(socket));
  await tick(20);
  assert.equal(adapter.subscribeCalls, 1, "first client starts the event subscription");
  assert.ok(adapter.listSessionsCalls >= 1, "first client triggers a reconcile");

  socket.emit("close");
  await tick(20);
  assert.equal(adapter.unsubscribeCalls, 1, "last client disconnect stops the subscription");
});

test("the fleet overview always covers every session and connects fan out one reconcile", async () => {
  const sessions = [
    session("A", "terminal", "wsA"),
    session("B", "browser", "wsB"),
    session("C", "terminal", "wsC")
  ];
  const adapter = new FakeAdapter(sessions);
  const hub = monitor(adapter);
  after(() => hub.stop());

  const first = new FakeSocket();
  hub.addClient(asWebSocket(first));
  await tick(20);
  const reconcilesAfterFirst = adapter.listSessionsCalls;

  const second = new FakeSocket();
  hub.addClient(asWebSocket(second));
  await tick(20);

  assert.equal(
    adapter.listSessionsCalls,
    reconcilesAfterFirst,
    "a second client does not trigger another reconcile (one shared monitor)"
  );

  for (const socket of [first, second]) {
    const fleet = socket.fleets().at(-1);
    const ids = (fleet?.sessions as AgentSession[]).map((s) => s.id).sort();
    assert.deepEqual(ids, ["A", "B", "C"], "every client sees all sessions");
  }
});

test("subscribing to a pane adds focused detail without narrowing fleet coverage", async () => {
  const sessions = [session("A", "terminal", "wsA"), session("B", "terminal", "wsB")];
  const adapter = new FakeAdapter(sessions);
  const hub = monitor(adapter);
  after(() => hub.stop());

  const socket = new FakeSocket();
  hub.addClient(asWebSocket(socket));
  await tick(20);

  socket.emit("message", Buffer.from(JSON.stringify({ type: "subscribe", sessionId: "A" })));
  await tick(20);

  // Fleet still lists every session.
  const fleet = socket.fleets().at(-1);
  assert.equal((fleet?.sessions as AgentSession[]).length, 2, "subscription did not narrow the fleet");

  // Detail output for A was captured at the rich line count and delivered.
  const detailRead = adapter.readCalls.find((c) => c.id === "A");
  assert.ok(detailRead && detailRead.lines >= 100, "focused detail captures a rich line count");
  const output = socket
    .events()
    .map((m) => m.event as { type: string; sessionId: string })
    .find((event) => event.type === "terminal_output" && event.sessionId === "A");
  assert.ok(output, "focused detail output was delivered to the subscriber");
});

test("focused detail reaches only the subscribed client", async () => {
  const adapter = new FakeAdapter([session("A", "terminal", "wsA")]);
  const hub = monitor(adapter);
  after(() => hub.stop());

  const subscribed = new FakeSocket();
  const other = new FakeSocket();
  hub.addClient(asWebSocket(subscribed));
  hub.addClient(asWebSocket(other));
  await tick(20);

  subscribed.emit("message", Buffer.from(JSON.stringify({ type: "subscribe", sessionId: "A" })));
  await tick(20);

  assert.ok(subscribed.events().some((m) => (m.event as { sessionId: string }).sessionId === "A"));
  assert.ok(
    !other.events().some((m) => (m.event as { sessionId: string }).sessionId === "A"),
    "an unsubscribed client never receives another pane's detail output"
  );
});

test("codex assistant_stream frames reach the subscribed client's live channel", async () => {
  const adapter = new FakeAdapter([session("A", "terminal", "wsA")]);
  const hub = monitor(adapter);
  after(() => hub.stop());

  const subscribed = new FakeSocket();
  const other = new FakeSocket();
  hub.addClient(asWebSocket(subscribed));
  hub.addClient(asWebSocket(other));
  await tick(20);

  subscribed.emit("message", Buffer.from(JSON.stringify({ type: "subscribe", sessionId: "A" })));
  await tick(20);

  // The http layer publishes these as codex deltas arrive on the control client.
  hub.publish({ type: "assistant_stream", sessionId: "A", itemId: "m1", text: "Hel", at: "t0" });
  hub.publish({ type: "assistant_stream", sessionId: "A", itemId: "m1", text: "Hello", done: true, at: "t1" });
  await tick(10);

  const streams = subscribed
    .events()
    .map((m) => m.event as { type: string; itemId?: string; text?: string; done?: boolean })
    .filter((e) => e.type === "assistant_stream");
  assert.deepEqual(
    streams.map((e) => e.text),
    ["Hel", "Hello"],
    "the subscriber sees the reply grow incrementally"
  );
  assert.equal(streams.at(-1)?.done, true);
  assert.ok(
    !other.events().some((m) => (m.event as { type: string }).type === "assistant_stream"),
    "an unsubscribed client never receives another session's stream"
  );
});

test("an agent-status event updates the workspace's terminal session status and agent for all clients", async () => {
  const adapter = new FakeAdapter([session("A", "terminal", "wsA")]);
  const hub = monitor(adapter);
  after(() => hub.stop());

  const socket = new FakeSocket();
  hub.addClient(asWebSocket(socket));
  await tick(20);

  adapter.emit({
    kind: "status",
    workspaceId: "wsA",
    status: "needs_approval",
    agent: "codex",
    at: "2030-01-01T00:00:00.000Z"
  });
  await tick(20);

  const fleet = socket.fleets().at(-1);
  const a = (fleet?.sessions as AgentSession[]).find((s) => s.id === "A");
  assert.equal(a?.status, "needs_approval", "status from the event stream is reflected in the overview");
  assert.equal(a?.agent, "codex", "agent source from the event stream is reflected in the overview");
});

test("session-scoped activity does not mark every session in the workspace as running", async () => {
  const adapter = new FakeAdapter([session("A", "terminal", "wsA"), session("B", "terminal", "wsA")]);
  const hub = monitor(adapter);
  after(() => hub.stop());

  const socket = new FakeSocket();
  hub.addClient(asWebSocket(socket));
  await tick(20);

  adapter.emit({
    kind: "activity",
    workspaceId: "wsA",
    sessionId: "A",
    status: "running",
    agent: "codex",
    at: "2030-01-01T00:00:00.000Z"
  });
  await tick(20);

  const fleet = socket.fleets().at(-1);
  const sessions = fleet?.sessions as AgentSession[];
  assert.equal(sessions.find((s) => s.id === "A")?.status, "running");
  assert.equal(sessions.find((s) => s.id === "B")?.status, "idle");
});

test("a running status claim never clears an open approval or flushes queued input", async () => {
  const adapter = new FakeAdapter([session("A", "terminal", "wsA")]);
  const hub = monitor(adapter);
  after(() => hub.stop());

  hub.addClient(asWebSocket(new FakeSocket()));
  await tick(20);

  hub.setPendingApproval("A", { id: "ap1", summary: "Bash wants to run", command: "npm test", at: "" });
  const result = await hub.queueOrSubmit("A", "queued message");
  assert.equal(result.queued, true, "composer input queues while the prompt is open");

  // A parallel, already-approved tool reports PreToolUse -> running while the
  // dialog for another tool is still on screen.
  hub.applyExternalStatus("A", "running");
  await tick(20);
  assert.ok(hub.pendingApproval("A"), "running does not clear the open approval");
  assert.deepEqual(adapter.inputs, [], "queued input never flushes into the open prompt");

  hub.applyExternalStatus("A", "idle");
  await tick(20);
  assert.equal(hub.pendingApproval("A"), undefined, "idle (Stop) resolves the approval");
  assert.deepEqual(adapter.inputs, ["queued message"], "queued input flushes once the prompt is gone");
});

test("input submission signals lifecycle only after a queued message actually flushes", async () => {
  const adapter = new FakeAdapter([session("A", "terminal", "wsA")]);
  const submitted: string[] = [];
  const hub = new FleetMonitor(adapter, {
    broadcastMs: 5,
    onInputSubmitted: (sessionId) => submitted.push(sessionId)
  });
  after(() => hub.stop());

  hub.setPendingApproval("A", { id: "ap1", summary: "Bash wants to run", at: "" });
  const result = await hub.queueOrSubmit("A", "resume the task");
  assert.equal(result.queued, true);
  assert.deepEqual(submitted, [], "accepting text into the queue is not a submitted turn");

  hub.resolveApproval("A");
  hub.applyExternalStatus("A", "idle");
  await tick(20);
  assert.deepEqual(adapter.inputs, ["resume the task"]);
  assert.deepEqual(submitted, ["A"], "the successful adapter submission emits exactly once");
});

test("accepted queued follow-up gets an explicit rejection receipt if the terminal ends", async () => {
  const adapter = new FakeAdapter([session("A", "terminal", "wsA")]);
  const rejected: Array<{ sessionId: string; count: number; reason: string }> = [];
  const hub = new FleetMonitor(adapter, {
    broadcastMs: 5,
    onQueuedInputRejected: (sessionId, count, reason) => rejected.push({ sessionId, count, reason })
  });
  after(() => hub.stop());

  hub.setPendingApproval("A", { id: "ap1", summary: "Bash wants to run", at: "" });
  const accepted = await hub.queueOrSubmit("A", "follow up after this turn");
  assert.equal(accepted.queued, true);

  hub.applyExternalStatus("A", "done");
  assert.deepEqual(adapter.inputs, []);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.sessionId, "A");
  assert.equal(rejected[0]?.count, 1);
  assert.match(rejected[0]?.reason ?? "", /ended with status done/);

  await assert.rejects(
    hub.queueOrSubmit("A", "too late"),
    /session has ended; follow-up input was not accepted/
  );
});

test("an open question suppresses the generic approval AskUserQuestion also emits", async () => {
  const adapter = new FakeAdapter([session("A", "terminal", "wsA")]);
  const hub = monitor(adapter);
  after(() => hub.stop());

  hub.addClient(asWebSocket(new FakeSocket()));
  await tick(20);

  const question = {
    id: "askq-1",
    questions: [{ header: "Deploy", question: "Where to?", multiSelect: false, options: [{ label: "Staging" }] }],
    at: ""
  };
  // Question first, then the prompt's own "needs your permission" Notification.
  hub.setPendingQuestion("A", question);
  hub.setPendingApproval("A", { id: "n1", summary: "Claude needs your permission", at: "" });
  let live = hub.withLiveState(await adapter.listSessions()).find((s) => s.id === "A");
  assert.equal(hub.pendingApproval("A"), undefined, "the generic approval is refused while a question is open");
  assert.ok(live?.pendingQuestion, "the question surfaces");
  assert.equal(live?.pendingApproval, undefined, "no approval card stacks on the question");

  // Reverse order: a stale approval already set, then the question arrives.
  hub.resolveQuestion("A");
  hub.setPendingApproval("A", { id: "n2", summary: "Claude needs your permission", at: "" });
  hub.setPendingQuestion("A", question);
  live = hub.withLiveState(await adapter.listSessions()).find((s) => s.id === "A");
  assert.equal(hub.pendingApproval("A"), undefined, "the question clears the stale approval");
  assert.ok(live?.pendingQuestion, "the question wins");
  assert.equal(live?.pendingApproval, undefined, "still no stacked approval");

  // Answering (any move off needs_approval) clears the question.
  hub.applyExternalStatus("A", "running");
  await tick(20);
  assert.equal(hub.pendingQuestion("A"), undefined, "the question resolves when the agent moves on");
});

test("setSessionModel overlays the live model + effort and merges partial updates", async () => {
  const adapter = new FakeAdapter([session("A", "terminal", "wsA")]);
  const hub = monitor(adapter);
  after(() => hub.stop());

  // Launch value: full model + effort surfaces on the overview / GET /sessions.
  hub.setSessionModel("A", { model: "gpt-5.5", modelLabel: "GPT-5.5", effort: "xhigh" });
  let live = hub.withLiveState(await adapter.listSessions()).find((s) => s.id === "A");
  assert.equal(live?.model, "gpt-5.5");
  assert.equal(live?.modelLabel, "GPT-5.5");
  assert.equal(live?.effort, "xhigh");

  // A model-only switch keeps the prior effort tier (merge, never reset).
  hub.setSessionModel("A", { model: "gpt-5.4", modelLabel: "GPT-5.4" });
  live = hub.withLiveState(await adapter.listSessions()).find((s) => s.id === "A");
  assert.equal(live?.model, "gpt-5.4");
  assert.equal(live?.modelLabel, "GPT-5.4");
  assert.equal(live?.effort, "xhigh", "effort is preserved across a model-only switch");

  // An effort-only switch moves just the tier.
  hub.setSessionModel("A", { effort: "low" });
  live = hub.withLiveState(await adapter.listSessions()).find((s) => s.id === "A");
  assert.equal(live?.model, "gpt-5.4");
  assert.equal(live?.effort, "low");
});

test("setSessionModel pushes a fresh fleet frame to connected clients", async () => {
  const adapter = new FakeAdapter([session("A", "terminal", "wsA")]);
  const hub = monitor(adapter);
  after(() => hub.stop());

  const socket = new FakeSocket();
  hub.addClient(asWebSocket(socket));
  await tick(20);
  const before = socket.fleets().length;

  hub.setSessionModel("A", { model: "opus", modelLabel: "Opus 4.8" });
  await tick(20);
  const fleets = socket.fleets();
  assert.ok(fleets.length > before, "a model change broadcasts a new fleet frame");
  const sessions = fleets.at(-1)?.sessions as AgentSession[];
  assert.equal(sessions.find((s) => s.id === "A")?.modelLabel, "Opus 4.8");
});

test("authoritative codex effort converges HTTP/session detail, fleet updates, and reconnect snapshots", async () => {
  const codex = { ...session("A", "terminal", "wsA"), agent: "codex" as const };
  const adapter = new FakeAdapter([codex]);
  const hub = monitor(adapter);
  after(() => hub.stop());

  hub.setSessionModel("A", { model: "gpt-5.6-sol", modelLabel: "GPT-5.6 Sol", effort: "low" });
  const first = new FakeSocket();
  hub.addClient(asWebSocket(first));
  await tick(20);
  assert.equal((first.fleets().at(-1)?.sessions as AgentSession[])[0]?.effort, "low");

  // A rollout thread_settings_applied row changes effort without changing the
  // model. withLiveState is the canonical projection used by GET /sessions and
  // session detail; the same projection feeds every fleet frame.
  hub.setSessionModel("A", { effort: "medium" });
  await tick(20);
  const httpSessions = hub.withLiveState(await adapter.listSessions());
  assert.equal(httpSessions[0]?.model, "gpt-5.6-sol");
  assert.equal(httpSessions[0]?.effort, "medium");
  assert.equal((first.fleets().at(-1)?.sessions as AgentSession[])[0]?.effort, "medium");

  const frameCount = first.fleets().length;
  hub.setSessionModel("A", { model: "gpt-5.6-sol", effort: "medium" });
  await tick(20);
  assert.equal(first.fleets().length, frameCount, "a duplicate settings row emits no redundant fleet update");

  const reconnected = new FakeSocket();
  hub.addClient(asWebSocket(reconnected));
  await tick(20);
  const refreshed = reconnected.fleets().at(-1)?.sessions as AgentSession[];
  assert.equal(refreshed[0]?.model, "gpt-5.6-sol");
  assert.equal(refreshed[0]?.effort, "medium", "refresh keeps observed runtime settings, not launch defaults");
});

test("session model fallback fills missing fields without overwriting tracked launch values", async () => {
  const adapter = new FakeAdapter([session("A", "terminal", "wsA")]);
  const hub = new FleetMonitor(adapter, {
    broadcastMs: 5,
    sessionModelFallback: () => ({ model: "gpt-5.5", modelLabel: "GPT-5.5", effort: "xhigh" })
  });
  after(() => hub.stop());

  let live = hub.withLiveState(await adapter.listSessions()).find((s) => s.id === "A");
  assert.equal(live?.model, "gpt-5.5");
  assert.equal(live?.modelLabel, "GPT-5.5");
  assert.equal(live?.effort, "xhigh");

  hub.setSessionModel("A", { model: "gpt-5.4", modelLabel: "GPT-5.4", effort: "low" });
  live = hub.withLiveState(await adapter.listSessions()).find((s) => s.id === "A");
  assert.equal(live?.model, "gpt-5.4");
  assert.equal(live?.modelLabel, "GPT-5.4");
  assert.equal(live?.effort, "low");
});

test("PTY activity does not replay focused detail when direct output is already streamed", async () => {
  const adapter = new FakeAdapter([session("A", "terminal", "perch-pty")]);
  const hub = monitor(adapter);
  after(() => hub.stop());

  const socket = new FakeSocket();
  hub.addClient(asWebSocket(socket));
  await tick(20);

  socket.emit("message", Buffer.from(JSON.stringify({ type: "subscribe", sessionId: "A" })));
  await tick(20);
  adapter.readCalls.length = 0;

  adapter.emit({
    kind: "activity",
    workspaceId: "perch-pty",
    sessionId: "A",
    status: "running",
    agent: "codex",
    at: "2030-01-01T00:00:00.000Z",
    name: "pty.session.activity"
  });
  await tick(20);

  assert.ok(
    adapter.readCalls.some((call) => call.id === "A" && call.lines < 100),
    "PTY activity still refreshes the fleet tail"
  );
  assert.ok(
    !adapter.readCalls.some((call) => call.id === "A" && call.lines >= 100),
    "PTY activity does not replay focused detail over direct output"
  );
});

test("activity never triggers a capture on a browser surface", async () => {
  const sessions = [session("A", "terminal", "wsX"), session("B", "browser", "wsX")];
  const adapter = new FakeAdapter(sessions);
  const hub = monitor(adapter);
  after(() => hub.stop());

  hub.addClient(asWebSocket(new FakeSocket()));
  await tick(20);

  adapter.emit({ kind: "activity", workspaceId: "wsX", at: "2030-01-01T00:00:00.000Z" });
  await tick(20);

  assert.ok(adapter.readCalls.some((c) => c.id === "A"), "terminal surface gets a tail capture");
  assert.ok(
    !adapter.readCalls.some((c) => c.id === "B"),
    "browser surface is never captured for the overview tail"
  );
});

test("publish delivers per-session events to subscribers and system events to everyone", async () => {
  const adapter = new FakeAdapter([session("A", "terminal", "wsA")]);
  const hub = monitor(adapter);
  after(() => hub.stop());

  const subscribed = new FakeSocket();
  const other = new FakeSocket();
  hub.addClient(asWebSocket(subscribed));
  hub.addClient(asWebSocket(other));
  await tick(20);
  subscribed.emit("message", Buffer.from(JSON.stringify({ type: "subscribe", sessionId: "A" })));
  await tick(20);

  subscribed.sent.length = 0;
  other.sent.length = 0;

  hub.publish({ type: "message", sessionId: "A", role: "user", text: "hi", at: "" });
  assert.equal(subscribed.events().length, 1, "subscriber gets the per-session event");
  assert.equal(other.events().length, 0, "non-subscriber does not");

  hub.publish({ type: "message", sessionId: "system", role: "system", text: "x", at: "" });
  assert.ok(other.events().some((m) => (m.event as { sessionId: string }).sessionId === "system"));
});

test("start_agent creates and subscribes a PTY-backed session", async () => {
  const adapter = new FakeAdapter([]);
  const hub = monitor(adapter);
  hub.setStartAgentLauncher(async ({ request }) => ({ session: await adapter.startAgent!(request) }));
  after(() => hub.stop());

  const socket = new FakeSocket();
  hub.addClient(asWebSocket(socket));
  await tick(20);

  socket.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "start_agent",
        request: {
          command: "codex",
          cwd: "/tmp/perch"
        }
      })
    )
  );
  await tick(20);

  const fleet = socket.fleets().at(-1);
  const sessions = fleet?.sessions as AgentSession[];
  assert.ok(sessions.some((candidate) => candidate.id === "P"), "new session appears in the fleet");

  hub.publish({ type: "terminal_output", sessionId: "P", text: "streamed", at: "" });
  assert.ok(
    socket.events().some((message) => {
      const event = message.event as { sessionId: string; text?: string };
      return event.sessionId === "P" && event.text === "streamed";
    }),
    "client is subscribed to the newly started session"
  );
});

// A ClientSocket stand-in that records terminate() and emits close on it. A
// relayed device wraps its data socket in exactly this ClientSocket surface (the
// EncryptedServerChannel), so terminating it here severs the relay data socket.
class CuttableSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  terminated = false;
  send(_data: string): void {}
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.emit("close");
  }
}

test("disconnectDevice cuts only the revoked device and severs its relay data socket", async () => {
  const adapter = new FakeAdapter([session("A", "terminal", "wsA")]);
  const severed: string[] = [];
  const hub = new FleetMonitor(adapter, {
    reconcileMs: 10_000,
    broadcastMs: 5,
    tailThrottleMs: 1,
    detailThrottleMs: 1,
    // The relay path wires this to RelayClient.disconnectDevice so a revoked
    // device's underlying relay data socket is severed even when it is not a
    // current FleetMonitor client (e.g. a second connection mid-handshake).
    onDisconnectDevice: (deviceId) => severed.push(deviceId)
  });
  after(() => hub.stop());

  const revoked = new CuttableSocket();
  hub.addClient(revoked as unknown as WebSocket, undefined, { kind: "device", deviceId: "dev-1" });
  const serverClient = new CuttableSocket();
  hub.addClient(serverClient as unknown as WebSocket, undefined, { kind: "server" });
  const otherDevice = new CuttableSocket();
  hub.addClient(otherDevice as unknown as WebSocket, undefined, { kind: "device", deviceId: "dev-2" });
  assert.equal(hub.clientCount(), 3);

  hub.disconnectDevice("dev-1");

  assert.equal(revoked.terminated, true, "the revoked device's live socket is cut");
  assert.equal(serverClient.terminated, false, "the server (CLI) client is untouched");
  assert.equal(otherDevice.terminated, false, "a different device is untouched");
  assert.deepEqual(severed, ["dev-1"], "the relay transport is told to sever the device's data socket");
  assert.equal(hub.clientCount(), 2);
});

// --- Screen-state prompt detection (the general net for unhooked prompts) ---

const CONFIRM_SCREEN = [
  "   Switch model?",
  "   Your next response will be slower and use more tokens",
  "",
  "   ❯ 1. Yes, switch to Sonnet 5",
  "     2. No, go back",
  "",
  "",
  "╭────────────────────────────╮",
  "│ > Try \"fix the build\"      │",
  "╰────────────────────────────╯"
].join("\n");

const QUIET_SCREEN = ["The plan:", "  1. install deps", "  2. run tests", "> "].join("\n");

// A PTY-shaped adapter whose rendered screen the test drives directly.
class ScreenAdapter implements AgentAdapter {
  readonly name = "screen";
  screen = QUIET_SCREEN;
  answering = false;
  inputs: string[] = [];
  private handler?: (event: FleetEvent) => void;
  private readonly sessions: AgentSession[] = [
    { ...session("A", "terminal", "wsA"), agent: "claude" }
  ];

  async getTopology() {
    return { windows: [], generatedAt: "" };
  }
  async listSessions(): Promise<AgentSession[]> {
    return this.sessions;
  }
  async readRecentEvents(sessionId: string): Promise<RecentEventsResult> {
    return {
      events: [{ type: "terminal_output", sessionId, text: this.screen, at: "" }],
      terminal: true
    };
  }
  async sendInput(_sessionId: string, text: string): Promise<void> {
    this.inputs.push(text);
  }
  async sendEnter(): Promise<void> {}
  async interrupt(): Promise<void> {}
  promptAnswerInFlight(): boolean {
    return this.answering;
  }
  subscribeFleetEvents(handler: (event: FleetEvent) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = undefined;
    };
  }
  emit(event: FleetEvent): void {
    this.handler?.(event);
  }
}

// Any activity re-renders the screen, which is what the detector reads.
async function stir(adapter: ScreenAdapter): Promise<void> {
  adapter.emit({ kind: "activity", sessionId: "A", workspaceId: "wsA", at: new Date().toISOString() });
  await tick(30);
}

test("a confirm frame on screen raises needs_approval and gates the composer", async () => {
  const adapter = new ScreenAdapter();
  const hub = monitor(adapter);
  after(() => hub.stop());
  hub.addClient(asWebSocket(new FakeSocket()));
  await tick(20);

  await stir(adapter);
  assert.equal(hub.pendingApproval("A"), undefined, "ordinary output with numbered lines is not a prompt");

  adapter.screen = CONFIRM_SCREEN;
  await stir(adapter);

  const approval = hub.pendingApproval("A");
  assert.ok(approval, "the confirm dialog surfaces as an approval");
  assert.equal(approval.summary, "Switch model?");
  assert.match(approval.command ?? "", /1\. Yes, switch to Sonnet 5/);

  const live = hub.withLiveState(await adapter.listSessions()).find((s) => s.id === "A");
  assert.equal(live?.status, "needs_approval", "the phone sees a session waiting on a decision");

  // The whole point: the next message queues rather than answering the dialog.
  const result = await hub.queueOrSubmit("A", "ok cool");
  assert.equal(result.queued, true, "composer text queues behind the open confirm");
  assert.deepEqual(adapter.inputs, [], "nothing was typed into the dialog");

  // Answered on the desktop: the card is retracted, and the queue drains.
  hub.resolveApproval("A");
  adapter.screen = QUIET_SCREEN;
  await stir(adapter);
  hub.applyExternalStatus("A", "idle");
  await tick(20);
  assert.deepEqual(adapter.inputs, ["ok cool"], "the queued message lands once the dialog is gone");
});

test("a dialog perch is already answering itself never becomes a card", async () => {
  const adapter = new ScreenAdapter();
  const hub = monitor(adapter);
  after(() => hub.stop());
  hub.addClient(asWebSocket(new FakeSocket()));
  await tick(20);

  // A perch-initiated model switch is mid-barrier: it will answer this dialog.
  adapter.answering = true;
  adapter.screen = CONFIRM_SCREEN;
  await stir(adapter);
  assert.equal(hub.pendingApproval("A"), undefined, "perch does not surface the dialog it is answering");

  // The barrier gave up with the dialog still open: the net catches it.
  adapter.answering = false;
  await stir(adapter);
  assert.ok(hub.pendingApproval("A"), "a dialog perch failed to answer still reaches the phone");
});

test("a screen-raised card is retracted when the dialog leaves the screen", async () => {
  const adapter = new ScreenAdapter();
  const hub = monitor(adapter);
  after(() => hub.stop());
  hub.addClient(asWebSocket(new FakeSocket()));
  await tick(20);

  adapter.screen = CONFIRM_SCREEN;
  await stir(adapter);
  const raised = hub.pendingApproval("A");
  assert.ok(raised);

  // Still on screen (a redraw): the same dialog is never raised twice.
  await stir(adapter);
  assert.equal(hub.pendingApproval("A")?.id, raised.id);

  adapter.screen = QUIET_SCREEN;
  await stir(adapter);
  assert.equal(hub.pendingApproval("A"), undefined, "no hook resolves it, so the detector does");
});
