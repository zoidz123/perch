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

test("durable Codex history progress resumes the same receipt after partial failure", () => {
  const home = mkdtempSync(join(tmpdir(), "perch-history-sync-"));
  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  const firstDb = new StateDb(env);
  const firstAdapter = new HistoryAdapter();
  const firstCoordinator = new CodexHistorySyncCoordinator(
    firstDb,
    firstAdapter as unknown as CodexAppServerAdapter
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
  firstDb.close();

  const secondDb = new StateDb(env);
  const secondAdapter = new HistoryAdapter();
  const secondCoordinator = new CodexHistorySyncCoordinator(
    secondDb,
    secondAdapter as unknown as CodexAppServerAdapter
  );
  const resumed = secondCoordinator.resumeForSession("pty:live");
  assert.equal(resumed?.id, receipt.id);
  assert.equal(secondAdapter.requests[0]?.request.syncId, receipt.id);
  assert.equal(secondAdapter.requests[0]?.request.cursor, "20");
  secondAdapter.requests[0]!.request.onTerminal({ state: "succeeded" });
  assert.equal(secondDb.codexHistorySyncs.find(receipt.id)?.state, "succeeded");

  secondDb.close();
  rmSync(home, { recursive: true, force: true });
});
