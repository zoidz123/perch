import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession, RecentEventsResult } from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import { AuditLog } from "./audit.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { HookRegistry } from "./hooks.js";
import {
  createControlServer,
  MAX_WORKER_REPORT_BODY_BYTES,
  MAX_WORKER_REPORT_EVIDENCE_BYTES,
  MAX_WORKER_REPORT_SUMMARY_BYTES
} from "./http.js";
import { OwnerManager } from "./ownerManager.js";
import { DeviceRegistry } from "./pairing.js";
import { PrPoller } from "./prPoller.js";
import { ProjectRegistry } from "./projects.js";
import { TaskStore } from "./tasks.js";
import { TimelineStore } from "./timeline.js";
import { WorktreePool } from "./worktrees.js";

// HTTP contract for the lossless worker report channel and the mate mailbox
// tools: identity ladders, explicit bounds, claim/ack fencing, bounded wait,
// and the isolated end-to-end worker -> mailbox -> mate -> completion flow.

class NoopAdapter implements AgentAdapter {
  readonly name = "fake-pty";
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
}

type Fixture = {
  home: string;
  port: number;
  tasks: TaskStore;
  hooks: HookRegistry;
  ownerManager: OwnerManager;
};

async function withServer(run: (ctx: Fixture) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "perch-mailbox-http-"));
  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  const adapter = new NoopAdapter();
  const monitor = new FleetMonitor(adapter, { broadcastMs: 5 });
  const tasks = new TaskStore(env);
  const timeline = new TimelineStore();
  const hooks = new HookRegistry();
  const ownerManager = new OwnerManager(tasks);
  const options = {
    adapter,
    auditLog: new AuditLog(join(home, "audit.jsonl")),
    authToken: "test-token",
    boxSecretKey: new Uint8Array(32),
    monitor,
    devices: new DeviceRegistry(env),
    port: 0,
    hooks,
    timeline,
    projects: new ProjectRegistry(env),
    worktrees: new WorktreePool({ env }),
    tasks,
    ownerManager,
    prPoller: new PrPoller(tasks, async () => {
      throw new Error("gh disabled in tests");
    })
  };
  const server = createControlServer(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run({ home, port, tasks, hooks, ownerManager });
  } finally {
    timeline.stop();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}

function registerLiveMate(ownerManager: OwnerManager, hooks: HookRegistry, sessionId = "pty:mate") {
  const runtime = ownerManager.beginMateLaunch({ command: "claude", agent: "claude", cwd: "/tmp" });
  ownerManager.markLive(runtime, sessionId);
  const { token } = hooks.register(sessionId);
  return { sessionId, token, generation: runtime.generation };
}

function makeWorker(tasks: TaskStore, hooks: HookRegistry, title: string, sessionId: string) {
  const task = tasks.create({ title, project: "/tmp/repo", kind: "scout" });
  const { token } = hooks.register(sessionId);
  tasks.update(task.id, { sessionId });
  return { task, token };
}

function postReport(port: number, taskId: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/tasks/${taskId}/reports`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

function mailboxHeaders(sessionId: string, token: string): Record<string, string> {
  return { "x-perch-session": sessionId, "x-perch-token": token, "content-type": "application/json" };
}

test("worker hook credentials submit a report; bearer, device-style, and unrelated sessions are refused", async () => {
  await withServer(async ({ port, tasks, hooks }) => {
    const { task, token } = makeWorker(tasks, hooks, "report auth", "pty:worker");
    const { token: strangerToken } = hooks.register("pty:stranger");

    const ok = await postReport(
      port,
      task.id,
      { "x-perch-session": "pty:worker", "x-perch-token": token },
      { summary: "s", report: "full body", idempotencyKey: "k1" }
    );
    assert.equal(ok.status, 200);
    const accepted = (await ok.json()) as { reportId: string; duplicate: boolean; reportSha256: string };
    assert.equal(accepted.duplicate, false);
    assert.ok(accepted.reportId);

    // Success meant durability: the report and its pending delivery exist.
    assert.equal(tasks.stateDb.workerReports.find(accepted.reportId)?.report, "full body");
    assert.equal(tasks.stateDb.mateMailbox.list().length, 1);

    const bearer = await postReport(
      port,
      task.id,
      { authorization: "Bearer test-token" },
      { summary: "s", report: "r", idempotencyKey: "k2" }
    );
    assert.equal(bearer.status, 401);

    const unrelated = await postReport(
      port,
      task.id,
      { "x-perch-session": "pty:stranger", "x-perch-token": strangerToken },
      { summary: "s", report: "r", idempotencyKey: "k3" }
    );
    assert.equal(unrelated.status, 401);

    const missing = await postReport(port, task.id, {}, { summary: "s", report: "r", idempotencyKey: "k4" });
    assert.equal(missing.status, 401);
    assert.equal(tasks.stateDb.mateMailbox.list().length, 1, "refused submissions stored nothing");
  });
});

test("Codex reports require the verified root relay; inherited hook credentials stay powerless", async () => {
  await withServer(async ({ port, tasks, hooks }) => {
    const { task, token } = makeWorker(tasks, hooks, "codex report", "pty:codex-root");
    tasks.stateDb.runtimes.create({
      id: "codex-root-runtime",
      taskId: task.id,
      generation: 0,
      state: "live",
      agent: "codex",
      provider: "codex",
      ptySessionId: "pty:codex-root",
      metadata: { codexTaskReportingMode: "root_dynamic_tool" }
    });

    const inherited = await postReport(
      port,
      task.id,
      { "x-perch-session": "pty:codex-root", "x-perch-token": token },
      { summary: "s", report: "child exfil", idempotencyKey: "k1" }
    );
    assert.equal(inherited.status, 401, "root_thread_required applies to reports");

    const relay = await postReport(
      port,
      task.id,
      { authorization: "Bearer test-token", "x-perch-root-session": "pty:codex-root" },
      { summary: "s", report: "root report", idempotencyKey: "k1" }
    );
    assert.equal(relay.status, 200);

    const wrongRoot = await postReport(
      port,
      task.id,
      { authorization: "Bearer test-token", "x-perch-root-session": "pty:someone-else" },
      { summary: "s", report: "r", idempotencyKey: "k2" }
    );
    assert.equal(wrongRoot.status, 401);
  });
});

test("oversize submissions are rejected explicitly and nothing is truncated or stored", async () => {
  await withServer(async ({ port, tasks, hooks }) => {
    const { task, token } = makeWorker(tasks, hooks, "oversize", "pty:worker");
    const headers = { "x-perch-session": "pty:worker", "x-perch-token": token };

    const bigReport = await postReport(port, task.id, headers, {
      summary: "s",
      report: "x".repeat(MAX_WORKER_REPORT_BODY_BYTES + 1),
      idempotencyKey: "k1"
    });
    assert.equal(bigReport.status, 413);
    assert.match(((await bigReport.json()) as { error: string }).error, /report too large/);

    const bigSummary = await postReport(port, task.id, headers, {
      summary: "s".repeat(MAX_WORKER_REPORT_SUMMARY_BYTES + 1),
      report: "r",
      idempotencyKey: "k2"
    });
    assert.equal(bigSummary.status, 413);

    const bigEvidence = await postReport(port, task.id, headers, {
      summary: "s",
      report: "r",
      evidence: { blob: "e".repeat(MAX_WORKER_REPORT_EVIDENCE_BYTES) },
      idempotencyKey: "k3"
    });
    assert.equal(bigEvidence.status, 413);

    const noKey = await postReport(port, task.id, headers, { summary: "s", report: "r" });
    assert.equal(noKey.status, 400);

    assert.equal(tasks.stateDb.mateMailbox.list().length, 0);
    assert.equal(tasks.events(task.id).some((event) => event.data?.reason === "worker_report"), false);
  });
});

test("a sender retry with the same key is idempotent over HTTP; a different payload conflicts", async () => {
  await withServer(async ({ port, tasks, hooks }) => {
    const { task, token } = makeWorker(tasks, hooks, "retry", "pty:worker");
    const headers = { "x-perch-session": "pty:worker", "x-perch-token": token };
    const body = { summary: "s", report: "same body", idempotencyKey: "stable" };

    const first = (await (await postReport(port, task.id, headers, body)).json()) as { reportId: string };
    const retry = await postReport(port, task.id, headers, body);
    assert.equal(retry.status, 200);
    const replay = (await retry.json()) as { reportId: string; duplicate: boolean };
    assert.equal(replay.duplicate, true);
    assert.equal(replay.reportId, first.reportId);
    assert.equal(tasks.stateDb.mateMailbox.list().length, 1);

    const conflict = await postReport(port, task.id, headers, { ...body, report: "tampered" });
    assert.equal(conflict.status, 409);
  });
});

test("mailbox claim and acknowledgment are fenced to the live mate session; workers and bearers are refused", async () => {
  await withServer(async ({ port, tasks, hooks, ownerManager }) => {
    const { task, token: workerToken } = makeWorker(tasks, hooks, "mailbox auth", "pty:worker");
    const mate = registerLiveMate(ownerManager, hooks);
    tasks.recordEvent(task.id, { kind: "blocked", source: "worker", message: "hello mate" });

    // A worker's own hook credential cannot claim mate mail.
    const workerRead = await fetch(`http://127.0.0.1:${port}/mate/mailbox/read`, {
      method: "POST",
      headers: mailboxHeaders("pty:worker", workerToken),
      body: JSON.stringify({})
    });
    assert.equal(workerRead.status, 403);

    // Bearer tokens (server or paired device) carry no hook credential.
    const bearerRead = await fetch(`http://127.0.0.1:${port}/mate/mailbox/read`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(bearerRead.status, 401);

    // The live mate claims: pointers + summary + claim token, never the body.
    const read = await fetch(`http://127.0.0.1:${port}/mate/mailbox/read`, {
      method: "POST",
      headers: mailboxHeaders(mate.sessionId, mate.token),
      body: JSON.stringify({ limit: 5 })
    });
    assert.equal(read.status, 200);
    const claimed = (await read.json()) as { messages: Array<Record<string, unknown>> };
    assert.equal(claimed.messages.length, 1);
    const message = claimed.messages[0]!;
    assert.equal(message.kind, "blocked");
    assert.equal(message.summary, "hello mate");
    assert.equal(message.state, "claimed");
    assert.ok(message.claimToken);

    // Acknowledgment with the claimed token succeeds and replays idempotently.
    const ackBody = {
      id: message.id,
      claimToken: message.claimToken,
      idempotencyKey: "ack-1",
      disposition: "unblocked the worker"
    };
    const ack = await fetch(`http://127.0.0.1:${port}/mate/mailbox/ack`, {
      method: "POST",
      headers: mailboxHeaders(mate.sessionId, mate.token),
      body: JSON.stringify(ackBody)
    });
    assert.equal(ack.status, 200);
    const ackResult = (await ack.json()) as { results: Array<{ outcome: string; duplicate?: boolean }> };
    assert.equal(ackResult.results[0]!.outcome, "acknowledged");

    const replay = await fetch(`http://127.0.0.1:${port}/mate/mailbox/ack`, {
      method: "POST",
      headers: mailboxHeaders(mate.sessionId, mate.token),
      body: JSON.stringify(ackBody)
    });
    const replayResult = (await replay.json()) as { results: Array<{ outcome: string; duplicate?: boolean }> };
    assert.equal(replayResult.results[0]!.outcome, "acknowledged");
    assert.equal(replayResult.results[0]!.duplicate, true);

    // Observability list over bearer stays read-only and shows the receipt.
    const list = await fetch(`http://127.0.0.1:${port}/mate/mailbox?includeAcknowledged=1`, {
      headers: { authorization: "Bearer test-token" }
    });
    assert.equal(list.status, 200);
    const listed = (await list.json()) as { messages: Array<{ state: string }>; pending: number };
    assert.equal(listed.messages[0]!.state, "acknowledged");
    assert.equal(listed.pending, 0);
  });
});

test("wait_for_messages returns immediately when mail is pending and empty on timeout", async () => {
  await withServer(async ({ port, tasks, hooks, ownerManager }) => {
    const mate = registerLiveMate(ownerManager, hooks);
    const empty = await fetch(`http://127.0.0.1:${port}/mate/mailbox/wait?timeoutSeconds=0`, {
      headers: mailboxHeaders(mate.sessionId, mate.token)
    });
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { messages: [], timedOut: true });

    const { task } = makeWorker(tasks, hooks, "wait", "pty:worker");
    tasks.recordEvent(task.id, { kind: "blocked", source: "worker", message: "arrived" });
    const started = Date.now();
    const hit = await fetch(`http://127.0.0.1:${port}/mate/mailbox/wait?timeoutSeconds=30`, {
      headers: mailboxHeaders(mate.sessionId, mate.token)
    });
    const body = (await hit.json()) as { messages: Array<{ summary: string }>; timedOut: boolean };
    assert.equal(body.timedOut, false);
    assert.equal(body.messages[0]!.summary, "arrived");
    assert.ok(Date.now() - started < 5_000, "returned immediately, not at the timeout");

    // The wait itself claimed nothing.
    assert.equal(tasks.stateDb.mateMailbox.list()[0]!.state, "pending");
  });
});

test("end to end: report + completion fan in losslessly, acknowledgment never grants completion, restart never redelivers", async () => {
  await withServer(async ({ home, port, tasks, hooks, ownerManager }) => {
    const mate = registerLiveMate(ownerManager, hooks);
    const { task, token } = makeWorker(tasks, hooks, "full flow", "pty:worker");
    const workerHeaders = { "x-perch-session": "pty:worker", "x-perch-token": token };
    tasks.recordEvent(task.id, { kind: "working", source: "worker" });

    // Worker delivers the full report, then requests completion.
    const fullReport = `# Findings\n\n${"detail line\n".repeat(500)}`;
    const evidence = { files: ["a.ts", "b.ts"], verdict: "safe" };
    const submitted = (await (
      await postReport(port, task.id, workerHeaders, {
        summary: "scout complete: 2 findings",
        report: fullReport,
        evidence,
        idempotencyKey: "final-report"
      })
    ).json()) as { reportId: string };
    const done = await fetch(`http://127.0.0.1:${port}/tasks/${task.id}/events`, {
      method: "POST",
      headers: { ...workerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ kind: "done", message: "see full report" })
    });
    assert.equal(done.status, 200);
    assert.equal(tasks.find(task.id)?.state, "completion_requested");

    // Mate drains at its checkpoint: two messages, report first (FIFO).
    const read = (await (
      await fetch(`http://127.0.0.1:${port}/mate/mailbox/read`, {
        method: "POST",
        headers: mailboxHeaders(mate.sessionId, mate.token),
        body: JSON.stringify({ limit: 10 })
      })
    ).json()) as { messages: Array<{ id: string; kind: string; reportId?: string; claimToken: string }> };
    assert.deepEqual(
      read.messages.map((entry) => entry.kind),
      ["note", "completion_requested"]
    );
    assert.equal(read.messages[0]!.reportId, submitted.reportId);

    // read_message returns the original content byte-for-byte.
    const detail = (await (
      await fetch(`http://127.0.0.1:${port}/mate/mailbox/message/${read.messages[0]!.id}`, {
        headers: mailboxHeaders(mate.sessionId, mate.token)
      })
    ).json()) as { report?: { report: string; evidence?: unknown; reportSha256: string } };
    assert.equal(detail.report?.report, fullReport);
    assert.deepEqual(detail.report?.evidence, evidence);

    // Semantic acknowledgment of both messages does NOT complete the task.
    for (const message of read.messages) {
      const ack = (await (
        await fetch(`http://127.0.0.1:${port}/mate/mailbox/ack`, {
          method: "POST",
          headers: mailboxHeaders(mate.sessionId, mate.token),
          body: JSON.stringify({ id: message.id, claimToken: message.claimToken, idempotencyKey: `ack-${message.id}` })
        })
      ).json()) as { results: Array<{ outcome: string }> };
      assert.equal(ack.results[0]!.outcome, "acknowledged");
    }
    assert.equal(tasks.find(task.id)?.state, "completion_requested", "acknowledgment is not completion authority");

    // Trusted completion stays with the server-token verification endpoint.
    const requestSeq = tasks.events(task.id).find((event) => event.kind === "completion_requested")!.seq;
    const accept = await fetch(`http://127.0.0.1:${port}/tasks/${task.id}/completion`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ action: "accept", requestSeq, idempotencyKey: "accept-1" })
    });
    assert.equal(accept.status, 200);
    assert.equal(tasks.find(task.id)?.state, "done");

    // Restart: nothing acknowledged comes back.
    const reopened = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
    try {
      const drained = reopened.stateDb.mateMailbox.claim({
        generation: mate.generation + 1,
        limit: 10,
        ttlMs: 60_000,
        now: new Date().toISOString()
      });
      assert.equal(drained.length, 0, "no acknowledged redelivery after restart");
    } finally {
      reopened.close();
    }
  });
});
