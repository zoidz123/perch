import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  CodexAppServerAdapter,
  CodexHistoryCatchUpRequest
} from "./adapters/codexAppServerAdapter.js";
import { CodexHistorySyncCoordinator } from "./codexHistorySync.js";
import { StateDb, type RuntimeRecord } from "./stateDb.js";

class HistoryAdapter {
  requests: Array<{ sessionId: string; request: CodexHistoryCatchUpRequest }> = [];
  requester?: (sessionId: string) => void;

  setHistoryCatchUpRequester(requester: (sessionId: string) => void): void {
    this.requester = requester;
  }

  startHistoryCatchUp(sessionId: string, request: CodexHistoryCatchUpRequest): boolean {
    this.requests.push({ sessionId, request });
    return true;
  }
}

test("a server restart preserves the failed receipt and safely rebuilds history from its head", () => {
  const home = mkdtempSync(join(tmpdir(), "perch-history-sync-"));
  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  const firstDb = new StateDb(env);
  const firstAdapter = new HistoryAdapter();
  const firstCoordinator = new CodexHistorySyncCoordinator(
    firstDb,
    firstAdapter as unknown as CodexAppServerAdapter,
    { retryDelaysMs: [] }
  );
  const runtime: RuntimeRecord = {
    id: "runtime-live",
    taskId: "task-live",
    generation: 4,
    state: "live",
    agent: "codex",
    provider: "codex",
    providerSessionId: "thread-live",
    ptySessionId: "pty:live",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z"
  };

  const receipt = firstCoordinator.startForTaskRuntime(runtime)!;
  const firstRequest = firstAdapter.requests[0]!.request;
  firstRequest.onPage({ cursor: "20", accepted: 20 });
  firstRequest.onTerminal({ state: "failed", error: "temporary page failure" });
  assert.deepEqual(firstDb.codexHistorySyncs.find(receipt.id), {
    ...receipt,
    state: "failed",
    cursor: "20",
    pages: 1,
    items: 20,
    lastError: "temporary page failure",
    updatedAt: firstDb.codexHistorySyncs.find(receipt.id)!.updatedAt,
    finishedAt: firstDb.codexHistorySyncs.find(receipt.id)!.finishedAt
  });
  firstCoordinator.stop();
  firstDb.close();

  const secondDb = new StateDb(env);
  const secondAdapter = new HistoryAdapter();
  const secondCoordinator = new CodexHistorySyncCoordinator(
    secondDb,
    secondAdapter as unknown as CodexAppServerAdapter,
    { retryDelaysMs: [] }
  );
  const resumed = secondCoordinator.startForTaskRuntime({ ...runtime, generation: 5 })!;
  assert.notEqual(resumed.id, receipt.id);
  assert.equal(secondDb.codexHistorySyncs.find(receipt.id)?.state, "failed");
  assert.equal(secondAdapter.requests[0]?.request.syncId, resumed.id);
  assert.equal(secondAdapter.requests[0]?.request.cursor, null);
  secondAdapter.requests[0]!.request.onTerminal({ state: "succeeded" });
  assert.equal(secondDb.codexHistorySyncs.find(resumed.id)?.state, "succeeded");

  secondCoordinator.stop();
  secondDb.close();
  rmSync(home, { recursive: true, force: true });
});

test("failed Codex history retries the same durable cursor without a reconnect", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-history-retry-"));
  const db = new StateDb({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const adapter = new HistoryAdapter();
  const coordinator = new CodexHistorySyncCoordinator(
    db,
    adapter as unknown as CodexAppServerAdapter,
    { retryDelaysMs: [1] }
  );
  const runtime = liveRuntime();

  const receipt = coordinator.startForTaskRuntime(runtime)!;
  adapter.requests[0]!.request.onPage({ cursor: "20", accepted: 20 });
  adapter.requests[0]!.request.onTerminal({ state: "failed", error: "temporary page failure" });

  assert.ok(await until(500, () => adapter.requests.length === 2));
  assert.equal(adapter.requests[1]!.request.syncId, receipt.id);
  assert.equal(adapter.requests[1]!.request.cursor, "20");
  adapter.requests[1]!.request.onTerminal({ state: "succeeded" });
  assert.equal(db.codexHistorySyncs.find(receipt.id)?.state, "succeeded");

  coordinator.stop();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

test("a completed sync starts an anchored gap receipt on control reconnect", () => {
  const home = mkdtempSync(join(tmpdir(), "perch-history-complete-"));
  const db = new StateDb({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const adapter = new HistoryAdapter();
  const coordinator = new CodexHistorySyncCoordinator(
    db,
    adapter as unknown as CodexAppServerAdapter,
    { retryDelaysMs: [] }
  );
  const receipt = coordinator.startForTaskRuntime(liveRuntime())!;
  adapter.requests[0]!.request.onTerminal({ state: "succeeded" });

  const gap = coordinator.resumeForSession("pty:live")!;
  assert.notEqual(gap.id, receipt.id);
  assert.equal(adapter.requests[1]!.request.syncId, gap.id);
  assert.equal(adapter.requests[1]!.request.cursor, null);
  assert.equal(adapter.requests[1]!.request.stopAtAnchor, true);
  adapter.requests[1]!.request.onTerminal({ state: "succeeded" });
  assert.equal(
    coordinator.startForTaskRuntime({ ...liveRuntime(), generation: 5 })?.id,
    adapter.requests[2]!.request.syncId
  );
  assert.equal(adapter.requests.length, 3);
  assert.equal(adapter.requests[2]!.request.stopAtAnchor, true);
  adapter.requests[2]!.request.onTerminal({ state: "succeeded" });

  coordinator.stop();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

function liveRuntime(): RuntimeRecord {
  return {
    id: "runtime-live",
    taskId: "task-live",
    generation: 4,
    state: "live",
    agent: "codex",
    provider: "codex",
    providerSessionId: "thread-live",
    ptySessionId: "pty:live",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z"
  };
}

async function until(timeoutMs: number, predicate: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}
