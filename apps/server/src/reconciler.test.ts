import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession, AgentSessionStatus } from "@perch/shared";
import { deriveStatusCorrection, StatusReconciler } from "./reconciler.js";
import { StateMetrics } from "./stateMetrics.js";

const STALE_MS = 120_000;

function session(id: string, status: AgentSessionStatus): AgentSession {
  return {
    id,
    title: id,
    agent: "claude",
    kind: "terminal",
    status,
    lastActivityAt: new Date().toISOString()
  };
}

test("deriveStatusCorrection: conservative rules on both sides", () => {
  // Zombie running (lost Stop): idle screen + stale transcript flips idle.
  assert.equal(
    deriveStatusCorrection({ status: "running", screen: "❯ ", transcriptAgeMs: 600_000, staleMs: STALE_MS })?.to,
    "idle"
  );
  // A turn visibly in flight vetoes the flip even with a quiet transcript
  // (a long tool call writes nothing for minutes).
  assert.equal(
    deriveStatusCorrection({
      status: "running",
      screen: "✻ Compacting… (esc to interrupt)",
      transcriptAgeMs: 600_000,
      staleMs: STALE_MS
    }),
    undefined
  );
  // Fresh transcript writes also veto - the turn is demonstrably alive.
  assert.equal(
    deriveStatusCorrection({ status: "running", screen: "❯ ", transcriptAgeMs: 5_000, staleMs: STALE_MS }),
    undefined
  );
  // An unreadable screen is not proof either way.
  assert.equal(
    deriveStatusCorrection({ status: "running", screen: undefined, transcriptAgeMs: 600_000, staleMs: STALE_MS }),
    undefined
  );
  // Lost UserPromptSubmit: idle claim, but a turn on screen with a transcript
  // being written right now flips running.
  assert.equal(
    deriveStatusCorrection({
      status: "idle",
      screen: "✻ Thinking… (esc to interrupt)",
      transcriptAgeMs: 3_000,
      staleMs: STALE_MS
    })?.to,
    "running"
  );
  // Marker without fresh transcript (stale scrollback) does not correct.
  assert.equal(
    deriveStatusCorrection({
      status: "idle",
      screen: "esc to interrupt",
      transcriptAgeMs: 600_000,
      staleMs: STALE_MS
    }),
    undefined
  );
});

test("sweep corrects a seeded zombie through the external-status path and meters it", async () => {
  const applied: Array<{ sessionId: string; status: AgentSessionStatus }> = [];
  const metrics = new StateMetrics();
  const reconciler = new StatusReconciler(
    {
      listSessions: async () => [
        session("pty:zombie", "running"), // stale transcript, idle screen -> corrected
        session("pty:busy", "running"), // fresh transcript -> untouched, screen never read
        session("pty:quiet", "idle") // stale transcript -> untouched
      ],
      screenTail: async (sessionId) => (sessionId === "pty:busy" ? assert.fail("busy session was captured") : "❯ "),
      transcriptAgeMs: (sessionId) => (sessionId === "pty:busy" ? 1_000 : 900_000),
      applyStatus: (sessionId, status) => applied.push({ sessionId, status }),
      metrics
    },
    { staleMs: STALE_MS }
  );

  const corrections = await reconciler.sweep();
  assert.deepEqual(applied, [{ sessionId: "pty:zombie", status: "idle" }]);
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0]?.from, "running");
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters["reconciler.corrections"], 1);
  assert.equal(snapshot.latenciesMs["reconciler.correctionLagMs"]?.count, 1);
});

test("sweep never touches sessions without a correlated transcript or outside hook-driven states", async () => {
  const applied: string[] = [];
  const reconciler = new StatusReconciler(
    {
      listSessions: async () => [
        // No hooks (plain shell): status is not hook-driven, never corrected.
        session("pty:htop", "running"),
        // Approval prompts have their own resolution path.
        session("pty:prompt", "needs_approval")
      ],
      screenTail: async () => "❯ ",
      transcriptAgeMs: (sessionId) => (sessionId === "pty:htop" ? undefined : 900_000),
      applyStatus: (sessionId) => applied.push(sessionId)
    },
    { staleMs: STALE_MS }
  );

  assert.deepEqual(await reconciler.sweep(), []);
  assert.deepEqual(applied, []);
});
