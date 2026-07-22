import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PromptDeliveryTracker, promptDeliverySurface } from "./promptDeliveries.js";
import { StateDb } from "./stateDb.js";
import { TimelineStore, TIMELINE_TEXT_MAX_LENGTH } from "./timeline.js";

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("condition was not met before timeout");
}

function fixture(receiptTimeoutMs = 25) {
  const home = mkdtempSync(join(tmpdir(), "perch-prompt-delivery-"));
  const stateDb = new StateDb({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const accepted: string[] = [];
  const unknown: string[] = [];
  const tracker = new PromptDeliveryTracker(stateDb, {
    receiptTimeoutMs,
    onAccepted: (delivery) => accepted.push(delivery.id),
    onUnknown: (delivery) => unknown.push(delivery.id)
  });
  return {
    home,
    stateDb,
    tracker,
    accepted,
    unknown,
    close() {
      tracker.stop();
      stateDb.close();
      rmSync(home, { recursive: true, force: true });
    }
  };
}

test("a submitted prompt becomes accepted only after its matching UserPromptSubmit receipt", () => {
  const f = fixture();
  try {
    const delivery = f.tracker.create("pty:worker", "Please verify the tests", "agent");
    f.tracker.markTyping(delivery.id);
    f.tracker.markSubmitted(delivery.id);

    assert.equal(f.stateDb.promptDeliveries.find(delivery.id)?.state, "submitted");
    assert.equal(f.tracker.acknowledgeHook("pty:worker", "different prompt"), undefined);
    const accepted = f.tracker.acknowledgeHook("pty:worker", "Please verify the tests", "claude-session");

    assert.equal(accepted?.state, "accepted");
    assert.equal(accepted?.receiptKind, "user_prompt_submit");
    assert.equal(accepted?.receiptId, "claude-session");
    assert.deepEqual(f.accepted, [delivery.id]);
  } finally {
    f.close();
  }
});

test("a matching transcript user row is an alternate acceptance receipt", () => {
  const f = fixture();
  try {
    const prefix = "x".repeat(TIMELINE_TEXT_MAX_LENGTH);
    const delivery = f.tracker.create("pty:worker", `${prefix} full ending`, "human");
    f.tracker.markTyping(delivery.id);
    f.tracker.markSubmitted(delivery.id);

    const accepted = f.tracker.acknowledgeTimeline({
      seq: 4,
      id: "user-row-4",
      sessionId: "pty:worker",
      kind: "user",
      text: `${prefix}…`,
      at: new Date().toISOString()
    });

    assert.equal(accepted?.state, "accepted");
    assert.equal(accepted?.receiptKind, "transcript");
    assert.equal(accepted?.receiptId, "user-row-4");
  } finally {
    f.close();
  }
});

test("shorter manual text and a literal ellipsis cannot impersonate Timeline truncation", () => {
  const f = fixture();
  try {
    const delivery = f.tracker.create("pty:worker", "run tests and deploy", "agent");
    f.tracker.markTyping(delivery.id);
    f.tracker.markSubmitted(delivery.id);

    const manual = f.tracker.acknowledgeTimeline({
      seq: 5,
      id: "manual-shorter-row",
      sessionId: "pty:worker",
      kind: "user",
      text: "run tests",
      at: new Date().toISOString()
    });
    assert.equal(manual, undefined);
    assert.equal(f.stateDb.promptDeliveries.find(delivery.id)?.state, "submitted");

    const literalEllipsis = f.tracker.acknowledgeTimeline({
      seq: 6,
      id: "truncated-row",
      sessionId: "pty:worker",
      kind: "user",
      text: "run tests…",
      at: new Date().toISOString()
    });
    assert.equal(literalEllipsis, undefined);
    assert.equal(f.stateDb.promptDeliveries.find(delivery.id)?.state, "submitted");
  } finally {
    f.close();
  }
});

test("literal trailing ellipses remain part of exact hook matching", () => {
  const f = fixture();
  try {
    const delivery = f.tracker.create("pty:worker", "run tests…", "agent");
    f.tracker.markTyping(delivery.id);
    f.tracker.markSubmitted(delivery.id);
    assert.equal(f.tracker.acknowledgeHook("pty:worker", "run tests"), undefined);
    assert.equal(f.stateDb.promptDeliveries.find(delivery.id)?.state, "submitted");
    assert.equal(f.tracker.acknowledgeHook("pty:worker", "run tests…")?.id, delivery.id);
  } finally {
    f.close();
  }
});

test("historical transcript replay cannot acknowledge a newer delivery with identical text", () => {
  const f = fixture();
  try {
    const delivery = f.tracker.create("pty:worker", "continue", "agent");
    f.tracker.markTyping(delivery.id);
    f.tracker.markSubmitted(delivery.id);
    const historical = new Date(Date.parse(delivery.createdAt) - 60_000).toISOString();

    assert.equal(
      f.tracker.acknowledgeTimeline({
        seq: 1,
        id: "historical-row",
        sessionId: "pty:worker",
        kind: "user",
        text: "continue",
        at: historical
      }),
      undefined
    );
    assert.equal(f.stateDb.promptDeliveries.find(delivery.id)?.state, "submitted");
  } finally {
    f.close();
  }
});

test("a truncated transcript row cannot choose between multiple matching active deliveries", () => {
  const f = fixture();
  try {
    const prefix = "p".repeat(TIMELINE_TEXT_MAX_LENGTH);
    const first = f.tracker.create("pty:worker", `${prefix} first ending`, "agent");
    const second = f.tracker.create("pty:worker", `${prefix} second ending`, "agent");
    for (const delivery of [first, second]) {
      f.tracker.markTyping(delivery.id);
      f.tracker.markSubmitted(delivery.id);
    }

    assert.equal(
      f.tracker.acknowledgeTimeline({
        seq: 2,
        id: "ambiguous-truncated-row",
        sessionId: "pty:worker",
        kind: "user",
        text: `${prefix}…`,
        at: new Date().toISOString()
      }),
      undefined
    );
    assert.equal(f.stateDb.promptDeliveries.find(first.id)?.state, "submitted");
    assert.equal(f.stateDb.promptDeliveries.find(second.id)?.state, "submitted");
  } finally {
    f.close();
  }
});

test("a missing receipt becomes delivery_unknown and is never resent", async () => {
  const f = fixture(10);
  try {
    const delivery = f.tracker.create("pty:worker", "Do not duplicate this", "agent");
    f.tracker.markTyping(delivery.id);
    f.tracker.markSubmitted(delivery.id);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const unknown = f.stateDb.promptDeliveries.find(delivery.id);
    assert.equal(unknown?.state, "delivery_unknown");
    assert.match(unknown?.failureReason ?? "", /not resent/);
    assert.deepEqual(f.unknown, [delivery.id]);
  } finally {
    f.close();
  }
});

test("a transcript observed after timeout resolves only when its authentic timestamp predates unknown", async () => {
  const f = fixture(10);
  try {
    const delivery = f.tracker.create("pty:worker", "slow kickoff", "agent", { allowLateReceipt: true });
    f.tracker.markTyping(delivery.id);
    f.tracker.markSubmitted(delivery.id);
    const submittedAt = f.stateDb.promptDeliveries.find(delivery.id)?.submittedAt;
    assert.ok(submittedAt);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.stateDb.promptDeliveries.find(delivery.id)?.state, "delivery_unknown");
    assert.equal(
      f.tracker.acknowledgeTimeline({
        seq: 6,
        id: "delayed-authentic-row",
        sessionId: "pty:worker",
        kind: "user",
        text: "slow kickoff",
        at: submittedAt!
      })?.state,
      "accepted"
    );
  } finally {
    f.close();
  }
});

test("a no-timeout kickoff becomes unknown when its Claude session ends", () => {
  const f = fixture(10);
  try {
    const delivery = f.tracker.create("pty:worker", "ended kickoff", "agent");
    f.tracker.markTyping(delivery.id);
    f.tracker.markSubmitted(delivery.id, null);
    f.tracker.markSessionEnded("pty:worker");
    assert.equal(f.stateDb.promptDeliveries.find(delivery.id)?.state, "delivery_unknown");
    assert.deepEqual(f.unknown, [delivery.id]);
  } finally {
    f.close();
  }
});

test("disappearance reconciliation ignores a launch not previously observed in the fleet", () => {
  const f = fixture();
  try {
    const delivery = f.tracker.create("pty:launching", "launch race", "agent");
    f.tracker.markTyping(delivery.id);
    f.tracker.markSubmitted(delivery.id, null);
    f.tracker.reconcileActiveSessions(new Set(), new Set());
    assert.equal(f.stateDb.promptDeliveries.find(delivery.id)?.state, "submitted");

    f.tracker.reconcileActiveSessions(new Set(["pty:launching"]), new Set());
    assert.equal(f.stateDb.promptDeliveries.find(delivery.id)?.state, "delivery_unknown");
  } finally {
    f.close();
  }
});

test("same-text evidence at the unknown boundary cannot accept a kickoff", async () => {
  const f = fixture(10);
  try {
    const delivery = f.tracker.create("pty:worker", "bounded kickoff", "agent", { allowLateReceipt: true });
    f.tracker.markTyping(delivery.id);
    f.tracker.markSubmitted(delivery.id);
    await waitFor(() => f.stateDb.promptDeliveries.find(delivery.id)?.state === "delivery_unknown");
    const unknownAt = f.stateDb.promptDeliveries.find(delivery.id)?.unknownAt;
    assert.ok(unknownAt);

    assert.equal(f.tracker.acknowledgeHook("pty:worker", "bounded kickoff"), undefined);
    assert.equal(
      f.stateDb.promptDeliveries.acceptMatch({
        perchSessionId: "pty:worker",
        promptText: "bounded kickoff",
        receiptKind: "transcript",
        receiptId: "later-identical-row",
        observedAt: unknownAt
      }),
      undefined
    );
    assert.equal(f.stateDb.promptDeliveries.find(delivery.id)?.state, "delivery_unknown");
  } finally {
    f.close();
  }
});

test("hook and transcript evidence for one prompt cannot accept an older same-text unknown delivery", async () => {
  const f = fixture(10);
  try {
    const older = f.tracker.create("pty:worker", "repeat this prompt", "agent");
    f.tracker.markTyping(older.id);
    f.tracker.markSubmitted(older.id);
    await waitFor(() => f.stateDb.promptDeliveries.find(older.id)?.state === "delivery_unknown");

    const current = f.tracker.create("pty:worker", "repeat this prompt", "agent");
    f.tracker.markTyping(current.id);
    f.tracker.markSubmitted(current.id);
    assert.equal(f.tracker.acknowledgeHook("pty:worker", "repeat this prompt")?.id, current.id);
    assert.equal(
      f.tracker.acknowledgeTimeline({
        seq: 7,
        id: "same-turn-transcript",
        sessionId: "pty:worker",
        kind: "user",
        text: "repeat this prompt",
        at: new Date().toISOString()
      })?.id,
      current.id
    );

    assert.equal(f.stateDb.promptDeliveries.find(older.id)?.state, "delivery_unknown");
    assert.equal(f.stateDb.promptDeliveries.find(current.id)?.state, "accepted");
    assert.deepEqual(f.accepted, [current.id]);
  } finally {
    f.close();
  }
});

test("hook and transcript receipts for one turn cannot accept two identical active deliveries", () => {
  const f = fixture();
  try {
    const first = f.tracker.create("pty:worker", "same active prompt", "agent");
    const second = f.tracker.create("pty:worker", "same active prompt", "agent");
    for (const delivery of [first, second]) {
      f.tracker.markTyping(delivery.id);
      f.tracker.markSubmitted(delivery.id);
    }

    assert.equal(f.tracker.acknowledgeHook("pty:worker", "same active prompt")?.id, first.id);
    assert.equal(
      f.tracker.acknowledgeTimeline({
        seq: 10,
        id: "first-turn-transcript",
        sessionId: "pty:worker",
        kind: "user",
        text: "same active prompt",
        at: new Date().toISOString()
      })?.id,
      first.id
    );
    assert.equal(f.stateDb.promptDeliveries.find(first.id)?.state, "accepted");
    assert.equal(f.stateDb.promptDeliveries.find(second.id)?.state, "submitted");
    assert.deepEqual(f.accepted, [first.id]);
  } finally {
    f.close();
  }
});

test("replayed hook and transcript receipts cannot accept a second identical active delivery", () => {
  const f = fixture();
  try {
    const first = f.tracker.create("pty:worker", "same replayed prompt", "agent");
    const second = f.tracker.create("pty:worker", "same replayed prompt", "agent");
    for (const delivery of [first, second]) {
      f.tracker.markTyping(delivery.id);
      f.tracker.markSubmitted(delivery.id);
    }

    assert.equal(f.tracker.acknowledgeHook("pty:worker", "same replayed prompt", "claude-session")?.id, first.id);
    assert.equal(f.tracker.acknowledgeHook("pty:worker", "same replayed prompt", "claude-session")?.id, first.id);
    const transcript = {
      seq: 13,
      id: "stable-transcript-receipt",
      sessionId: "pty:worker",
      kind: "user" as const,
      text: "same replayed prompt",
      at: new Date().toISOString()
    };
    assert.equal(f.tracker.acknowledgeTimeline(transcript)?.id, first.id);
    assert.equal(f.tracker.acknowledgeTimeline(transcript)?.id, first.id);
    assert.equal(f.stateDb.promptDeliveries.find(second.id)?.state, "submitted");
  } finally {
    f.close();
  }
});

test("a distinct transcript receipt advances the next identical active delivery", () => {
  const f = fixture();
  try {
    const first = f.tracker.create("pty:worker", "same distinct prompt", "agent");
    const second = f.tracker.create("pty:worker", "same distinct prompt", "agent");
    for (const delivery of [first, second]) {
      f.tracker.markTyping(delivery.id);
      f.tracker.markSubmitted(delivery.id);
    }
    assert.equal(f.tracker.acknowledgeHook("pty:worker", "same distinct prompt")?.id, first.id);
    assert.equal(
      f.tracker.acknowledgeTimeline({
        seq: 14,
        id: "first-distinct-row",
        sessionId: "pty:worker",
        kind: "user",
        text: "same distinct prompt",
        at: new Date().toISOString()
      })?.id,
      first.id
    );
    assert.equal(
      f.tracker.acknowledgeTimeline({
        seq: 15,
        id: "second-distinct-row",
        sessionId: "pty:worker",
        kind: "user",
        text: "same distinct prompt",
        at: new Date().toISOString()
      })?.id,
      second.id
    );
  } finally {
    f.close();
  }
});

test("a delayed first transcript receipt cannot accept a newer identical delivery", async () => {
  const f = fixture();
  try {
    const first = f.tracker.create("pty:worker", "same delayed prompt", "agent");
    f.tracker.markTyping(first.id);
    f.tracker.markSubmitted(first.id);
    f.tracker.acknowledgeHook("pty:worker", "same delayed prompt");
    const firstAccepted = f.stateDb.promptDeliveries.find(first.id);
    assert.ok(firstAccepted?.acceptedAt);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = f.tracker.create("pty:worker", "same delayed prompt", "agent");
    f.tracker.markTyping(second.id);
    f.tracker.markSubmitted(second.id);
    assert.equal(
      f.tracker.acknowledgeTimeline({
        seq: 16,
        id: "delayed-first-row",
        sessionId: "pty:worker",
        kind: "user",
        text: "same delayed prompt",
        at: firstAccepted.acceptedAt
      })?.id,
      first.id
    );
    assert.equal(f.stateDb.promptDeliveries.find(second.id)?.state, "submitted");
  } finally {
    f.close();
  }
});

test("a delayed hook cannot accept a newer identical delivery", async () => {
  const f = fixture();
  try {
    const first = f.tracker.create("pty:worker", "same delayed hook", "agent");
    f.tracker.markTyping(first.id);
    f.tracker.markSubmitted(first.id);
    assert.equal(
      f.tracker.acknowledgeTimeline({
        seq: 17,
        id: "first-hook-delay-row",
        sessionId: "pty:worker",
        kind: "user",
        text: "same delayed hook",
        at: new Date().toISOString()
      })?.id,
      first.id
    );
    const second = f.tracker.create("pty:worker", "same delayed hook", "agent");
    f.tracker.markTyping(second.id);
    f.tracker.markSubmitted(second.id);
    assert.equal(f.tracker.acknowledgeHook("pty:worker", "same delayed hook"), undefined);
    assert.equal(f.stateDb.promptDeliveries.find(second.id)?.state, "submitted");
  } finally {
    f.close();
  }
});

test("a duplicate accepted hook cannot accept a newer identical delivery before transcript pairing", () => {
  const f = fixture();
  try {
    const first = f.tracker.create("pty:worker", "same hook retry", "agent");
    f.tracker.markTyping(first.id);
    f.tracker.markSubmitted(first.id);
    assert.equal(f.tracker.acknowledgeHook("pty:worker", "same hook retry")?.id, first.id);

    const second = f.tracker.create("pty:worker", "same hook retry", "agent");
    f.tracker.markTyping(second.id);
    f.tracker.markSubmitted(second.id);
    assert.equal(f.tracker.acknowledgeHook("pty:worker", "same hook retry")?.id, first.id);
    assert.equal(f.stateDb.promptDeliveries.find(second.id)?.state, "submitted");
  } finally {
    f.close();
  }
});

test("an ambiguous hook cannot steal evidence from either one-sided identical delivery", () => {
  const f = fixture();
  try {
    const first = f.tracker.create("pty:worker", "repeat exactly", "agent");
    f.tracker.markTyping(first.id);
    f.tracker.markSubmitted(first.id);
    assert.equal(
      f.tracker.acknowledgeTimeline({
        seq: 12,
        id: "first-transcript-only",
        sessionId: "pty:worker",
        kind: "user",
        text: "repeat exactly",
        at: new Date().toISOString()
      })?.id,
      first.id
    );

    const second = f.tracker.create("pty:worker", "repeat exactly", "agent");
    f.tracker.markTyping(second.id);
    f.tracker.markSubmitted(second.id);
    assert.equal(f.tracker.acknowledgeHook("pty:worker", "repeat exactly"), undefined);
    assert.equal(f.stateDb.promptDeliveries.find(second.id)?.state, "submitted");
    assert.equal(f.stateDb.promptDeliveries.find(first.id)?.hookReceiptAt, undefined);
  } finally {
    f.close();
  }
});

test("a queued restart delivery is durably reported as not submitted", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-prompt-restart-warning-"));
  const firstDb = new StateDb({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const delivery = firstDb.promptDeliveries.create({
    perchSessionId: "pty:worker",
    promptText: "This prompt has no receipt",
    source: "agent"
  });
  firstDb.close();

  const secondDb = new StateDb({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const warnings: string[] = [];
  const tracker = new PromptDeliveryTracker(secondDb, {
    receiptTimeoutMs: 10,
    onUnknown: (unknown) => warnings.push(unknown.id)
  });
  try {
    assert.equal(
      tracker.acknowledgeTimeline({
        seq: 8,
        id: "later-manual-copy",
        sessionId: "pty:worker",
        kind: "user",
        text: "This prompt has no receipt",
        at: new Date().toISOString()
      }),
      undefined,
      "a queued prompt was never typed and cannot be reconciled from later evidence"
    );
    assert.deepEqual(warnings, [delivery.id]);
    const notSubmitted = secondDb.promptDeliveries.find(delivery.id);
    assert.equal(notSubmitted?.state, "not_submitted");
    assert.match(notSubmitted?.failureReason ?? "", /not submitted/);
  } finally {
    tracker.stop();
    secondDb.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("late acceptance retains durable evidence that an earlier unknown warning needs resolution", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-prompt-late-resolution-"));
  const stateDb = new StateDb({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const accepted: Array<{ id: string; unknownNotifiedAt?: string }> = [];
  const tracker = new PromptDeliveryTracker(stateDb, {
    receiptTimeoutMs: 10,
    onAccepted: (delivery) => accepted.push({ id: delivery.id, unknownNotifiedAt: delivery.unknownNotifiedAt }),
    onUnknown: () => {}
  });
  try {
    const delivery = tracker.create("pty:worker", "late but real", "agent");
    tracker.markTyping(delivery.id);
    tracker.markSubmitted(delivery.id);
    const submittedAt = stateDb.promptDeliveries.find(delivery.id)?.submittedAt;
    assert.ok(submittedAt);
    await waitFor(() => Boolean(stateDb.promptDeliveries.find(delivery.id)?.unknownNotifiedAt));

    tracker.acknowledgeTimeline({
      seq: 9,
      id: "late-real-transcript",
      sessionId: "pty:worker",
      kind: "user",
      text: "late but real",
      at: submittedAt!
    });
    assert.equal(stateDb.promptDeliveries.find(delivery.id)?.state, "accepted");
    assert.equal(accepted.length, 1);
    assert.ok(accepted[0]?.unknownNotifiedAt);
  } finally {
    tracker.stop();
    stateDb.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a newer accepted delivery cannot hide an older unresolved warning", async () => {
  const f = fixture();
  try {
    const unresolved = f.tracker.create("pty:worker", "older uncertain prompt", "agent");
    f.tracker.markTyping(unresolved.id);
    f.tracker.markSubmitted(unresolved.id, null);
    const unresolvedSubmittedAt = f.stateDb.promptDeliveries.find(unresolved.id)?.submittedAt;
    assert.ok(unresolvedSubmittedAt);
    await new Promise((resolve) => setTimeout(resolve, 2));
    f.tracker.markUnknown(unresolved.id, "acceptance was not confirmed; not resent");

    const newer = f.tracker.create("pty:worker", "newer confirmed prompt", "agent");
    f.tracker.markTyping(newer.id);
    f.tracker.markSubmitted(newer.id, null);
    f.tracker.acknowledgeHook("pty:worker", "newer confirmed prompt");

    const unresolvedSurface = promptDeliverySurface(f.stateDb.promptDeliveries.list("pty:worker"));
    assert.equal(unresolvedSurface.promptDeliveryWarning?.deliveryId, unresolved.id);
    assert.equal(unresolvedSurface.promptDeliveryResolution, undefined);

    f.tracker.acknowledgeTimeline({
      seq: 18,
      id: "older-authentic-row",
      sessionId: "pty:worker",
      kind: "user",
      text: "older uncertain prompt",
      at: unresolvedSubmittedAt!
    });
    const resolvedSurface = promptDeliverySurface(f.stateDb.promptDeliveries.list("pty:worker"));
    assert.equal(resolvedSurface.promptDeliveryWarning, undefined);
    assert.equal(resolvedSurface.promptDeliveryResolution?.deliveryId, unresolved.id);
  } finally {
    f.close();
  }
});

test("a recovered mate inherits the prior generation's bounded delivery surface", async () => {
  const f = fixture();
  try {
    f.stateDb.owners.ensure("owner:mate", "mate");
    f.stateDb.ownerRuntimes.create({
      ownerId: "owner:mate",
      generation: 0,
      state: "live",
      agent: "claude",
      provider: "claude",
      ptySessionId: "pty:old-mate",
      cwd: "/tmp"
    });
    const delivery = f.tracker.create("pty:old-mate", "mate prompt", "human");
    f.tracker.markTyping(delivery.id);
    f.tracker.markSubmitted(delivery.id, null);
    const submittedAt = f.stateDb.promptDeliveries.find(delivery.id)?.submittedAt;
    assert.ok(submittedAt);
    await new Promise((resolve) => setTimeout(resolve, 2));
    f.tracker.markUnknown(delivery.id, "acceptance was not confirmed; not resent");

    assert.ok(f.stateDb.ownerRuntimes.compareAndSwap(
      "owner:mate",
      0,
      "live",
      "recovering",
      { metadata: { recoverySessionId: "pty:new-mate" } }
    ));

    const warning = promptDeliverySurface(
      f.stateDb.promptDeliveries.surfaceCandidates("pty:new-mate")
    );
    assert.equal(warning.promptDeliveryWarning?.deliveryId, delivery.id);
    assert.equal(warning.promptDeliveryResolution, undefined);

    f.tracker.acknowledgeTimeline({
      seq: 19,
      id: "recovered-mate-authentic-row",
      sessionId: "pty:new-mate",
      kind: "user",
      text: "mate prompt",
      at: submittedAt!
    });
    assert.ok(f.stateDb.ownerRuntimes.compareAndSwap("owner:mate", 0, "recovering", "ended"));
    f.stateDb.ownerRuntimes.create({
      ownerId: "owner:mate",
      generation: 1,
      state: "live",
      agent: "claude",
      provider: "claude",
      ptySessionId: "pty:new-mate",
      cwd: "/tmp"
    });
    const resolution = promptDeliverySurface(
      f.stateDb.promptDeliveries.surfaceCandidates("pty:new-mate")
    );
    assert.equal(resolution.promptDeliveryWarning, undefined);
    assert.equal(resolution.promptDeliveryResolution?.deliveryId, delivery.id);
    assert.equal(f.stateDb.promptDeliveries.surfaceCandidates("pty:new-mate").length, 1);
  } finally {
    f.close();
  }
});

test("a much later manual duplicate cannot retroactively accept an unknown delivery", async () => {
  const f = fixture(10);
  try {
    const delivery = f.tracker.create("pty:worker", "manual duplicate", "agent");
    f.tracker.markTyping(delivery.id);
    f.tracker.markSubmitted(delivery.id);
    await waitFor(() => f.stateDb.promptDeliveries.find(delivery.id)?.state === "delivery_unknown");
    const unknownAt = f.stateDb.promptDeliveries.find(delivery.id)?.unknownAt;
    assert.ok(unknownAt);

    assert.equal(
      f.tracker.acknowledgeTimeline({
        seq: 11,
        id: "manual-duplicate-later",
        sessionId: "pty:worker",
        kind: "user",
        text: "manual duplicate",
        at: new Date(Date.parse(unknownAt!) + 60_000).toISOString()
      }),
      undefined
    );
    assert.equal(f.stateDb.promptDeliveries.find(delivery.id)?.state, "delivery_unknown");
  } finally {
    f.close();
  }
});

test("an unnotified unknown is rescheduled after another restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-prompt-repeat-restart-"));
  const firstDb = new StateDb({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const delivery = firstDb.promptDeliveries.create({
    perchSessionId: "pty:worker",
    promptText: "survive another restart",
    source: "agent"
  });
  firstDb.promptDeliveries.markTyping(delivery.id);
  firstDb.promptDeliveries.markSubmitted(delivery.id);
  firstDb.promptDeliveries.markUnknown(delivery.id, "first process stopped before notification");
  firstDb.close();

  const secondDb = new StateDb({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const warnings: string[] = [];
  const tracker = new PromptDeliveryTracker(secondDb, {
    receiptTimeoutMs: 10,
    onUnknown: (unknown) => warnings.push(unknown.id)
  });
  try {
    assert.deepEqual(warnings, [], "restart waits for transcript catch-up");
    tracker.finishRestartCatchUp("pty:worker");
    await waitFor(() => warnings.length === 1);
    assert.deepEqual(warnings, [delivery.id]);
    assert.ok(secondDb.promptDeliveries.find(delivery.id)?.unknownNotifiedAt);
  } finally {
    tracker.stop();
    secondDb.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("restart warning waits for transcript catch-up instead of a fixed timer", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-prompt-catch-up-gate-"));
  const firstDb = new StateDb({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const delivery = firstDb.promptDeliveries.create({
    perchSessionId: "pty:worker",
    promptText: "missing after catch-up",
    source: "agent"
  });
  firstDb.promptDeliveries.markTyping(delivery.id);
  firstDb.promptDeliveries.markSubmitted(delivery.id);
  firstDb.close();

  const transcript = join(home, "session.jsonl");
  writeFileSync(transcript, "");
  const secondDb = new StateDb({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const warnings: string[] = [];
  const tracker = new PromptDeliveryTracker(secondDb, {
    receiptTimeoutMs: 5,
    onUnknown: (unknown) => warnings.push(unknown.id)
  });
  const timeline = new TimelineStore();
  timeline.observe((item) => tracker.acknowledgeTimeline(item));
  timeline.observeCatchUp((sessionId) => tracker.finishRestartCatchUp(sessionId));
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(warnings, []);
    timeline.attach("pty:worker", transcript);
    await waitFor(() => warnings.length === 1);
    assert.deepEqual(warnings, [delivery.id]);
  } finally {
    timeline.stop();
    tracker.stop();
    secondDb.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("restart warning falls back when no transcript can catch up", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-prompt-no-transcript-"));
  const firstDb = new StateDb({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const delivery = firstDb.promptDeliveries.create({
    perchSessionId: "pty:missing",
    promptText: "no transcript exists",
    source: "agent"
  });
  firstDb.promptDeliveries.markTyping(delivery.id);
  firstDb.promptDeliveries.markSubmitted(delivery.id);
  firstDb.close();

  const secondDb = new StateDb({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const warnings: string[] = [];
  const tracker = new PromptDeliveryTracker(secondDb, {
    restartRecoveryTimeoutMs: 10,
    onUnknown: (unknown) => warnings.push(unknown.id)
  });
  try {
    await waitFor(() => warnings.length === 1);
    assert.deepEqual(warnings, [delivery.id]);
  } finally {
    tracker.stop();
    secondDb.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("accepted projection retries after a callback failure and restart", () => {
  const home = mkdtempSync(join(tmpdir(), "perch-prompt-accepted-retry-"));
  const firstDb = new StateDb({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const firstTracker = new PromptDeliveryTracker(firstDb, {
    onAccepted: () => {
      throw new Error("projection interrupted");
    }
  });
  const delivery = firstTracker.create("pty:worker", "retry projection", "agent");
  firstTracker.markTyping(delivery.id);
  firstTracker.markSubmitted(delivery.id);
  firstTracker.acknowledgeHook("pty:worker", "retry projection");
  assert.equal(firstDb.promptDeliveries.find(delivery.id)?.state, "accepted");
  assert.equal(firstDb.promptDeliveries.find(delivery.id)?.acceptedNotifiedAt, undefined);
  firstTracker.stop();
  firstDb.close();

  const projected: string[] = [];
  const secondDb = new StateDb({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const secondTracker = new PromptDeliveryTracker(secondDb, {
    onAccepted: (accepted) => projected.push(accepted.id)
  });
  try {
    assert.deepEqual(projected, [delivery.id]);
    assert.ok(secondDb.promptDeliveries.find(delivery.id)?.acceptedNotifiedAt);
  } finally {
    secondTracker.stop();
    secondDb.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a retried accepted projection can dedupe a side effect committed before interruption", () => {
  const home = mkdtempSync(join(tmpdir(), "perch-prompt-side-effect-dedupe-"));
  const projected = new Set<string>();
  let firstAttempt = true;
  const project = (id: string) => {
    projected.add(id);
    if (firstAttempt) {
      firstAttempt = false;
      throw new Error("interrupted after durable side effect");
    }
  };
  const firstDb = new StateDb({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const firstTracker = new PromptDeliveryTracker(firstDb, { onAccepted: (accepted) => project(accepted.id) });
  const delivery = firstTracker.create("pty:worker", "dedupe projection", "agent");
  firstTracker.markTyping(delivery.id);
  firstTracker.markSubmitted(delivery.id);
  firstTracker.acknowledgeHook("pty:worker", "dedupe projection");
  firstTracker.stop();
  firstDb.close();

  const secondDb = new StateDb({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const secondTracker = new PromptDeliveryTracker(secondDb, { onAccepted: (accepted) => project(accepted.id) });
  try {
    assert.deepEqual([...projected], [delivery.id]);
    assert.ok(secondDb.promptDeliveries.find(delivery.id)?.acceptedNotifiedAt);
  } finally {
    secondTracker.stop();
    secondDb.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("restart reconciles a backfilled transcript receipt without emitting a stale warning", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-prompt-restart-"));
  const firstDb = new StateDb({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const delivery = firstDb.promptDeliveries.create({
    perchSessionId: "pty:worker",
    promptText: "Recover this receipt",
    source: "agent"
  });
  firstDb.promptDeliveries.markTyping(delivery.id);
  firstDb.promptDeliveries.markSubmitted(delivery.id);
  firstDb.close();

  const transcript = join(home, "session.jsonl");
  writeFileSync(
    transcript,
    `${JSON.stringify({
      type: "user",
      uuid: "late-user-row",
      timestamp: new Date().toISOString(),
      message: { content: "Recover this receipt" }
    })}\n`
  );

  const secondDb = new StateDb({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const restartWarnings: string[] = [];
  const tracker = new PromptDeliveryTracker(secondDb, {
    onUnknown: (unknown) => restartWarnings.push(unknown.id)
  });
  const timeline = new TimelineStore();
  timeline.observe((item) => tracker.acknowledgeTimeline(item));
  timeline.observeCatchUp((sessionId) => tracker.finishRestartCatchUp(sessionId));
  try {
    assert.equal(secondDb.promptDeliveries.find(delivery.id)?.state, "delivery_unknown");
    assert.deepEqual(restartWarnings, [], "startup waits for transcript reconciliation before warning");
    timeline.attach("pty:worker", transcript);
    await waitFor(() => secondDb.promptDeliveries.find(delivery.id)?.state === "accepted");
    assert.equal(secondDb.promptDeliveries.find(delivery.id)?.receiptKind, "transcript");
    assert.deepEqual(restartWarnings, []);
  } finally {
    timeline.stop();
    tracker.stop();
    secondDb.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a timestamp-less historical transcript row cannot acknowledge a newer delivery", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-prompt-missing-timestamp-"));
  const stateDb = new StateDb({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const tracker = new PromptDeliveryTracker(stateDb);
  const delivery = tracker.create("pty:worker", "repeat without timestamp", "agent");
  tracker.markTyping(delivery.id);
  tracker.markSubmitted(delivery.id);
  const transcript = join(home, "session.jsonl");
  writeFileSync(
    transcript,
    `${JSON.stringify({
      type: "user",
      uuid: "timestamp-less-row",
      message: { content: "repeat without timestamp" }
    })}\n`
  );
  const timeline = new TimelineStore();
  timeline.observe((item) =>
    tracker.acknowledgeTimeline(item, timeline.hasAuthenticTranscriptTimestamp(item))
  );
  try {
    timeline.attach("pty:worker", transcript);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stateDb.promptDeliveries.find(delivery.id)?.state, "submitted");
  } finally {
    timeline.stop();
    tracker.stop();
    stateDb.close();
    rmSync(home, { recursive: true, force: true });
  }
});
