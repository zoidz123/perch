import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNativeChildRunObservations } from "./nativeChildRuns.js";

test("native child parser retains only safe collaboration observation fields", () => {
  const observations = parseNativeChildRunObservations({
    rootThreadId: "root",
    observedAt: "2026-08-06T12:00:00.000Z",
    item: {
      type: "collabAgentToolCall",
      id: "collab-1",
      senderThreadId: "root",
      receiverThreadIds: ["child-a", "child-b", 7],
      status: "completed",
      tool: "spawnAgent",
      prompt: "this must never persist",
      agentsStates: {
        "child-a": { status: "running", message: "also never persist" },
        "child-b": { status: "completed" }
      }
    }
  });

  assert.deepEqual(observations, [
    {
      childThreadId: "child-a",
      parentThreadId: "root",
      state: "running",
      observedAt: "2026-08-06T12:00:00.000Z",
      protocol: { itemType: "collabAgentToolCall", itemId: "collab-1", event: "completed" }
    },
    {
      childThreadId: "child-b",
      parentThreadId: "root",
      state: "completed",
      observedAt: "2026-08-06T12:00:00.000Z",
      protocol: { itemType: "collabAgentToolCall", itemId: "collab-1", event: "completed" }
    }
  ]);
  assert.equal(JSON.stringify(observations).includes("never persist"), false);
  assert.equal(JSON.stringify(observations).includes("spawnAgent"), false);
});

test("torn-down children observe as terminal, never staying durably live", () => {
  // "unknown" is held back by the durable store, so a shutdown child that mapped
  // to it would stay stored as running until the next server restart.
  const states = parseNativeChildRunObservations({
    rootThreadId: "root",
    observedAt: "2026-08-06T12:00:00.000Z",
    item: {
      type: "collabAgentToolCall",
      id: "collab-2",
      senderThreadId: "root",
      receiverThreadIds: ["child-shutdown", "child-missing"],
      status: "completed",
      agentsStates: {
        "child-shutdown": { status: "shutdown" },
        "child-missing": { status: "notFound" }
      }
    }
  }).map((child) => child.state);

  assert.deepEqual(states, ["interrupted", "interrupted"]);
});

test("native child parser is tolerant and defaults unknown shapes to no observation", () => {
  assert.deepEqual(
    parseNativeChildRunObservations({ rootThreadId: "root", item: { type: "subAgentActivity", agentPath: "0" } }),
    []
  );
  assert.deepEqual(
    parseNativeChildRunObservations({
      rootThreadId: "root",
      item: { type: "collabAgentToolCall", senderThreadId: "other", receiverThreadIds: ["child"] }
    }),
    []
  );
  assert.deepEqual(parseNativeChildRunObservations({ rootThreadId: "root", item: { type: "futureNativeThing" } }), []);
});

test("sub-agent activity captures path and interruption without a child transcript", () => {
  assert.deepEqual(
    parseNativeChildRunObservations({
      rootThreadId: "root",
      observedAt: "2026-08-06T12:00:00.000Z",
      item: {
        type: "subAgentActivity",
        id: "activity-1",
        agentThreadId: "child-a",
        agentPath: "0/1",
        agentRole: "researcher",
        depth: 2,
        kind: "interrupted",
        assistantText: "not retained"
      }
    }),
    [{
      childThreadId: "child-a",
      parentThreadId: "root",
      depth: 2,
      path: "0/1",
      role: "researcher",
      state: "interrupted",
      observedAt: "2026-08-06T12:00:00.000Z",
      protocol: { itemType: "subAgentActivity", itemId: "activity-1", event: "interrupted" }
    }]
  );
});
