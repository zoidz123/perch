import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MATE_OWNER_ID, OwnerManager } from "./ownerManager.js";
import { TaskStore } from "./tasks.js";

test("effective mate model writes require the current provider, thread, session, and generation", () => {
  const home = mkdtempSync(join(tmpdir(), "perch-owner-model-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  try {
    const owners = new OwnerManager(tasks);
    const providerThread = "12345678-1234-4234-9234-123456789abc";
    const starting = owners.beginMateLaunch({
      command: "codex",
      agent: "codex",
      sessionId: "pty:mate-g0",
      model: "opus"
    });
    owners.recordProviderSession("pty:mate-g0", "codex", providerThread);
    const live = owners.markLive(starting, "pty:mate-g0");

    const recorded = owners.recordEffectiveModel({
      ownerId: MATE_OWNER_ID,
      generation: live.generation,
      provider: "codex",
      providerSessionId: providerThread,
      sessionId: "pty:mate-g0",
      model: "gpt-5.6-sol"
    });
    assert.equal(recorded?.model, "gpt-5.6-sol");

    const staleInputs = [
      { provider: "claude", providerSessionId: providerThread, sessionId: "pty:mate-g0", generation: 0 },
      { provider: "codex", providerSessionId: "thread:other", sessionId: "pty:mate-g0", generation: 0 },
      { provider: "codex", providerSessionId: providerThread, sessionId: "pty:other", generation: 0 },
      { provider: "codex", providerSessionId: providerThread, sessionId: "pty:mate-g0", generation: 99 }
    ] as const;
    for (const stale of staleInputs) {
      assert.equal(
        owners.recordEffectiveModel({
          ownerId: MATE_OWNER_ID,
          ...stale,
          model: "opus"
        }),
        undefined
      );
    }
    assert.equal(owners.snapshot()?.model, "gpt-5.6-sol");

    owners.interruptSession("pty:mate-g0");
    const claimed = owners.claimMateRecovery(0);
    assert.ok(claimed);
    const recovered = owners.bindRecoveredMate(claimed, {
      sessionId: "pty:mate-g1",
      provider: "codex",
      providerSessionId: providerThread,
      model: "gpt-5.6-terra"
    });
    assert.equal(recovered.generation, 1);
    assert.equal(recovered.model, "gpt-5.6-terra");
    assert.equal(tasks.stateDb.ownerRuntimes.findBySession("pty:mate-g0")?.model, "gpt-5.6-sol");
    assert.equal(
      owners.recordEffectiveModel({
        ownerId: MATE_OWNER_ID,
        generation: 0,
        provider: "codex",
        providerSessionId: providerThread,
        sessionId: "pty:mate-g0",
        model: "opus"
      }),
      undefined
    );
    assert.equal(owners.snapshot()?.model, "gpt-5.6-terra");
  } finally {
    tasks.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a clean Mate exit ends its generation while a provider failure stays recoverable", () => {
  const home = mkdtempSync(join(tmpdir(), "perch-owner-exit-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  try {
    const owners = new OwnerManager(tasks);
    const clean = owners.beginMateLaunch({
      command: "claude",
      agent: "claude",
      sessionId: "pty:clean"
    });
    owners.markLive(clean, "pty:clean");
    assert.equal(owners.recordSessionExit("pty:clean", "done")?.state, "ended");
    assert.equal(owners.latestMate()?.metadata?.endedReason, "provider-session-exited");

    const failed = owners.beginMateLaunch({
      command: "claude",
      agent: "claude",
      sessionId: "pty:failed"
    });
    owners.markLive(failed, "pty:failed");
    assert.equal(owners.recordSessionExit("pty:failed", "error")?.state, "recoverable");
  } finally {
    tasks.close();
    rmSync(home, { recursive: true, force: true });
  }
});
