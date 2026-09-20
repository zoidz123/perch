import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession, FleetEvent, RecentEventsResult } from "@perch/shared";
import type { CodexAppServerAdapter } from "./codexAppServerAdapter.js";
import type { HerdrWorkerIntegration } from "../herdr.js";
import type { PtyAgentAdapter } from "./pty.js";
import { RoutingAgentAdapter } from "./routingAdapter.js";
import type { AgentAdapter } from "./types.js";

class EventAdapter implements AgentAdapter {
  readonly name = "event-adapter";
  private readonly handlers = new Set<(event: FleetEvent) => void>();
  readonly stopped: string[] = [];

  async getTopology() {
    return { windows: [], generatedAt: "" };
  }

  async listSessions(): Promise<AgentSession[]> {
    return [];
  }

  async readRecentEvents(): Promise<RecentEventsResult> {
    return { events: [], terminal: true };
  }

  async sendInput(): Promise<void> {}
  async sendEnter(): Promise<void> {}
  async interrupt(): Promise<void> {}

  async stopSession(sessionId: string): Promise<void> {
    this.stopped.push(sessionId);
  }

  subscribeFleetEvents(handler: (event: FleetEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event: FleetEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}

class OwnedEventAdapter extends EventAdapter {
  has(sessionId: string): boolean {
    return sessionId === "pty:codex";
  }
}

test("routing fans PTY and owned-Codex topology into one coalesced invalidation", async () => {
  const pty = new EventAdapter();
  const codex = new OwnedEventAdapter();
  const routing = new RoutingAgentAdapter(
    pty as unknown as PtyAgentAdapter,
    codex as unknown as CodexAppServerAdapter
  );
  const received: FleetEvent[] = [];
  const unsubscribe = routing.subscribeFleetEvents((event) => received.push(event));

  pty.emit({ kind: "topology", at: "t1", name: "pty.topology" });
  codex.emit({ kind: "topology", at: "t2", name: "codex.owned-session.added" });
  await Promise.resolve();
  assert.deepEqual(received, [{ kind: "topology", at: "t1", name: "pty.topology" }]);

  pty.emit({ kind: "activity", at: "t3", sessionId: "pty:worker" });
  assert.deepEqual(received.at(-1), { kind: "activity", at: "t3", sessionId: "pty:worker" });

  unsubscribe();
  codex.emit({ kind: "topology", at: "t4", name: "codex.owned-session.removed" });
  await Promise.resolve();
  assert.equal(received.length, 2, "unsubscribing detaches both fleet-event sources");
});

test("task teardown closes the durable Herdr surface after its owning Codex worker stops", async () => {
  const pty = new EventAdapter();
  const codex = new OwnedEventAdapter();
  const closed: string[] = [];
  const herdr = { close: async (sessionId: string) => { closed.push(sessionId); } };
  const routing = new RoutingAgentAdapter(
    pty as unknown as PtyAgentAdapter,
    codex as unknown as CodexAppServerAdapter,
    undefined,
    herdr as HerdrWorkerIntegration
  );

  await routing.stopSession("pty:codex");

  assert.deepEqual(codex.stopped, ["pty:codex"]);
  assert.deepEqual(closed, ["pty:codex"]);
});
