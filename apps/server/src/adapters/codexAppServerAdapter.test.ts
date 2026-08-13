import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionStatus, FleetEvent, NativeChildRunSummary, PendingServerRequest, TimelineItem } from "@perch/shared";
import { TimelineStore } from "../timeline.js";
import { CodexAppServerAdapter, CodexDeliveryUnknownError } from "./codexAppServerAdapter.js";
import { CodexAppServerClient, isCodexRpcError } from "./codexAppServer.js";
import type { CodexDaemonManager } from "./codexDaemon.js";
import { FakeCodexAppServer, type FakeTurn } from "./fakeCodexAppServer.js";
import { websocketUnixTransport } from "./wsUnixTransport.js";
import type { NativeChildRunObservation } from "../nativeChildRuns.js";

// The adapter suite runs against the fake daemon over the REAL ws-unix
// transport and protocol engine, so what passes here is the wire behavior
// verified against codex 0.144.6 and 0.145.0, not a hand-rolled stub's opinion.

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(deadlineMs: number, check: () => boolean): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await tick(10);
  }
  return check();
}

type Fixture = {
  dir: string;
  socketPath: string;
  fake: FakeCodexAppServer;
  adapter: CodexAppServerAdapter;
  timeline: TimelineStore;
  daemons: {
    acquires: number;
    releases: string[];
    adopts: string[];
    retires: string[];
    configOverrides: string[][];
    operations: string[];
  };
  events: {
    timeline: Array<{ item: TimelineItem; live: boolean }>;
    statuses: Array<{ sessionId: string; status: AgentSessionStatus }>;
    serverRequests: PendingServerRequest[];
    serverRequestsResolved: PendingServerRequest[];
    turnStarts: string[];
    turnCompletes: Array<{ sessionId: string; message: string }>;
    nativeChildren: Array<{ sessionId: string; observation: NativeChildRunObservation }>;
    threads: Array<{ sessionId: string; threadId: string; socketPath: string }>;
    exits: Array<{ sessionId: string; status: string }>;
    fleet: FleetEvent[];
  };
  startHistoryCatchUp: (
    sessionId: string,
    cursor?: string | null,
    stopAtAnchor?: boolean
  ) => boolean;
  close: () => Promise<void>;
};

async function fixture(
  prefix: string,
  opts: {
    reconnectDelaysMs?: number[];
    historyReplayRetryDelaysMs?: number[];
    historyPageTimeoutMs?: number;
    nativeChildSummary?: (sessionId: string) => NativeChildRunSummary[];
  } = {}
): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const socketPath = join(dir, "s");
  const fake = new FakeCodexAppServer();
  await fake.start(socketPath);
  const daemons = {
    acquires: 0,
    releases: [] as string[],
    adopts: [] as string[],
    retires: [] as string[],
    configOverrides: [] as string[][],
    operations: [] as string[]
  };
  const fakeManager = {
    currentRuntimeFingerprint: () => "fp-live",
    acquire: async (_cwd: string, options: { configOverrides?: string[] } = {}) => {
      daemons.acquires += 1;
      daemons.operations.push("acquire");
      daemons.configOverrides.push(options.configOverrides ?? []);
      return { socketPath, cwd: dir };
    },
    release: (path: string) => {
      daemons.releases.push(path);
    },
    retireExisting: async (path: string) => {
      daemons.retires.push(path);
      daemons.operations.push("retire");
    },
    adoptExisting: async (
      path: string,
      cwd: string,
      opts: { expectedRuntimeFingerprint?: string } = {}
    ) => {
      // Fingerprint refusal mirrors the production manager: a recorded
      // fingerprint that no longer matches the current runtime never adopts.
      if (opts.expectedRuntimeFingerprint && opts.expectedRuntimeFingerprint !== "fp-live") {
        return null;
      }
      daemons.adopts.push(path);
      // Health probe against the real socket, like the production manager.
      const probe = new CodexAppServerClient({ sessionId: "probe", spawn: websocketUnixTransport({ socketPath: path }) });
      try {
        await probe.connect();
        await probe.disconnect();
        return { socketPath: path, cwd };
      } catch {
        await probe.disconnect().catch(() => {});
        return null;
      }
    }
  } as unknown as CodexDaemonManager;

  const events: Fixture["events"] = {
    timeline: [],
    statuses: [],
    serverRequests: [],
    serverRequestsResolved: [],
    turnStarts: [],
    turnCompletes: [],
    nativeChildren: [],
    threads: [],
    exits: [],
    fleet: []
  };
  const timeline = new TimelineStore();
  const adapter = new CodexAppServerAdapter({
    daemons: fakeManager,
    reconnectDelaysMs: opts.reconnectDelaysMs ?? [40, 80],
    ...(opts.historyReplayRetryDelaysMs
      ? { historyReplayRetryDelaysMs: opts.historyReplayRetryDelaysMs }
      : {}),
    ...(opts.historyPageTimeoutMs ? { historyPageTimeoutMs: opts.historyPageTimeoutMs } : {}),
    ...(opts.nativeChildSummary ? { nativeChildSummary: opts.nativeChildSummary } : {}),
    sessionEnv: () => ({ PERCH_SESSION_ID: "wired" })
  });
  adapter.wireEvents({
    onTimelineItem: (item, live) => {
      events.timeline.push({ item, live });
      timeline.ingest(item, { live });
    },
    onTimelineGapOpened: (sessionId) => timeline.openBackfillGap(sessionId),
    onTimelineBackfillStart: (sessionId, token, stopAtAnchor, restartsFromHead) =>
      timeline.beginBackfill(sessionId, token, stopAtAnchor, restartsFromHead),
    onTimelineBackfillPage: (sessionId, token, items) => {
      events.timeline.push(...items.map((item) => ({ item, live: false })));
      return timeline.ingestBackfill(sessionId, token, items);
    },
    onTimelineBackfillEnd: (sessionId, syncId, complete) =>
      timeline.endBackfill(sessionId, syncId, complete),
    onStatus: (sessionId, status) => events.statuses.push({ sessionId, status }),
    onServerRequest: (_sessionId, request) => events.serverRequests.push(request),
    onServerRequestResolved: (_sessionId, request) => events.serverRequestsResolved.push(request),
    onTurnStarted: (sessionId) => events.turnStarts.push(sessionId),
    onTurnComplete: (sessionId, ev) => events.turnCompletes.push({ sessionId, message: ev.message }),
    onNativeChildObservation: (sessionId, observation) => events.nativeChildren.push({ sessionId, observation }),
    onThreadStarted: (sessionId, threadId, socket) => events.threads.push({ sessionId, threadId, socketPath: socket }),
    onSessionExit: (sessionId, context) => events.exits.push({ sessionId, status: context.status })
  });
  adapter.subscribeFleetEvents((event) => events.fleet.push(event));
  let historySync = 0;
  const startHistoryCatchUp = (
    sessionId: string,
    cursor: string | null = null,
    stopAtAnchor = false
  ) =>
    adapter.startHistoryCatchUp(sessionId, {
      syncId: `sync-${++historySync}`,
      threadId: adapter.threadIdOf(sessionId)!,
      cursor,
      stopAtAnchor,
      restartsFromHead: !stopAtAnchor && cursor === null,
      onPage: () => {},
      onTerminal: () => {}
    });
  adapter.setHistoryCatchUpRequester((sessionId, hasUsableAnchor) => {
    startHistoryCatchUp(sessionId, null, hasUsableAnchor);
  });
  return {
    dir,
    socketPath,
    fake,
    adapter,
    timeline,
    daemons,
    events,
    startHistoryCatchUp,
    close: async () => {
      adapter.stop();
      timeline.stop();
      await fake.stop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function userClientIds(turns: FakeTurn[]): string[] {
  return turns.flatMap((turn) =>
    turn.items.filter((item) => item.type === "userMessage").map((item) => String(item.clientId))
  );
}

function timelineItems(store: TimelineStore, sessionId: string): TimelineItem[] {
  const items: TimelineItem[] = [];
  let after = 0;
  while (true) {
    const page = store.fetch(sessionId, after, 500);
    if (page.items.length === 0) return items;
    items.push(...page.items);
    after = page.items.at(-1)!.seq;
    if (after >= page.lastSeq) return items;
  }
}

test("startOwned captures the thread id from the thread/start response and surfaces the attach command", async () => {
  const f = await fixture("pxa-");
  try {
    const session = await f.adapter.startOwned({ command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:s1" });
    assert.equal(session.id, "pty:s1");
    assert.equal(session.agent, "codex");
    assert.equal(f.adapter.threadIdOf("pty:s1"), "thr_1");
    assert.equal(session.attachCommand, `codex resume thr_1 --remote unix://${f.socketPath}`);
    assert.equal(session.model, "gpt-5.5-codex");
    assert.equal(session.nativeMultiAgentMode, "enabled");
    assert.equal(f.adapter.taskReportingModeOf("pty:s1"), "root_dynamic_tool");
    assert.deepEqual(f.events.threads, [{ sessionId: "pty:s1", threadId: "thr_1", socketPath: f.socketPath }]);
    // The daemon env carried the per-session hook wiring request.
    assert.equal(f.daemons.acquires, 1);
  } finally {
    await f.close();
  }
});

test("native children stay inside the owned root session and never become fleet or attach targets", async () => {
  const f = await fixture("pxa-native-child-");
  try {
    await f.adapter.startOwned({ command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:root" });
    f.fake.emitNotification("thr_1", "item/completed", {
      threadId: "thr_1",
      item: {
        type: "collabAgentToolCall",
        id: "collab-1",
        senderThreadId: "thr_1",
        receiverThreadIds: ["child-1"],
        status: "inProgress",
        tool: "spawnAgent",
        prompt: "must not become a Perch task"
      }
    });
    f.fake.emitNotification("thr_1", "turn/started", { threadId: "child-1", turn: { id: "child-turn" } });
    await tick();

    assert.deepEqual(f.events.nativeChildren.map((event) => event.observation.childThreadId), ["child-1"]);
    const sessions = await f.adapter.listSessions();
    assert.deepEqual(sessions.map((session) => session.id), ["pty:root"]);
    assert.equal(f.adapter.has("child-1"), false);
    assert.equal(f.adapter.threadIdOf("child-1"), null);
    assert.equal(sessions[0]?.attachThreadId, "thr_1");
    assert.notEqual(sessions[0]?.attachThreadId, "child-1");
    assert.equal(f.events.turnStarts.includes("pty:root"), false, "child turn did not call root lifecycle");
    await assert.rejects(() => f.adapter.interrupt("child-1"), /unknown codex app-server session: child-1/);
  } finally {
    await f.close();
  }
});

test("native child summaries are optional and remain nested on the root session", async () => {
  const summary: NativeChildRunSummary = {
    childThreadId: "child-1",
    parentThreadId: "thr_1",
    state: "completed",
    observedAt: "2026-08-06T12:00:00.000Z",
    protocol: { itemType: "collabAgentToolCall", itemId: "collab-1", event: "completed" }
  };
  const f = await fixture("pxa-native-summary-", { nativeChildSummary: () => [summary] });
  try {
    const root = await f.adapter.startOwned({ command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:root" });
    assert.deepEqual(root.nativeChildren, [summary]);
    assert.deepEqual((await f.adapter.listSessions())[0]?.nativeChildren, [summary]);
    assert.equal(f.adapter.has("child-1"), false);
  } finally {
    await f.close();
  }
});

test("startAgent translates one positional kickoff and rejects unsupported codex flags", async () => {
  const f = await fixture("pxa-args-");
  try {
    await f.adapter.startAgent({
      command: "codex",
      agent: "codex",
      cwd: f.dir,
      sessionId: "pty:s1",
      args: ["Fix this"]
    });
    const clientIds = userClientIds(f.fake.thread("thr_1").turns);
    assert.equal(clientIds.length, 1);
    assert.match(clientIds[0]!, /^perch:/);
    const user = f.fake.thread("thr_1").turns[0]?.items[0];
    assert.deepEqual(user?.content, [{ type: "text", text: "Fix this" }]);
    await assert.rejects(
      f.adapter.startAgent({ command: "codex", agent: "codex", cwd: f.dir, args: ["--sandbox", "read-only"] }),
      /unsupported app-server-owned codex launch argument: --sandbox/
    );
  } finally {
    await f.close();
  }
});

test("the kickoff is one acknowledged turn/start: exactly one turn id, exactly one user message", async () => {
  const f = await fixture("pxa-kick-");
  try {
    await f.adapter.startOwned({ command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:s1" });
    const { turnId } = await f.adapter.submitAcknowledgedTurn("pty:s1", "do the task", {
      clientUserMessageId: "perch-kickoff:t1",
      source: "agent"
    });
    assert.equal(turnId, "turn_1");
    const turns = f.fake.thread("thr_1").turns;
    assert.deepEqual(userClientIds(turns), ["perch-kickoff:t1"]);
    // Exactly one turn/start reached the daemon - no retries, no PTY anywhere.
    assert.equal(f.fake.requestLog.filter((entry) => entry.method === "turn/start").length, 1);
    // The echoed user timeline item carries agent provenance and a stable id.
    const user = f.events.timeline.find((entry) => entry.item.kind === "user");
    assert.equal(user?.item.text, "do the task");
    assert.equal(user?.item.source, "agent");
    assert.equal(user?.item.id, "cx-item-perch-kickoff:t1");
  } finally {
    await f.close();
  }
});

test("idle input uses turn/start; input during an active turn uses turn/steer with the live expectedTurnId", async () => {
  const f = await fixture("pxa-steer-");
  try {
    await f.adapter.startOwned({ command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:s1" });
    await f.adapter.submitInput("pty:s1", "first message");
    assert.equal(f.fake.thread("thr_1").activeTurnId, "turn_1");
    await f.adapter.submitInput("pty:s1", "steer this in");
    const steer = f.fake.requestLog.find((entry) => entry.method === "turn/steer");
    assert.equal(steer?.params.expectedTurnId, "turn_1");
    const active = f.fake.thread("thr_1").turns[0]!;
    assert.equal(active.items.filter((item) => item.type === "userMessage").length, 2);
    // Turn completes -> the next input is a fresh turn/start again.
    f.fake.completeActiveTurn("thr_1", "done");
    await until(2_000, () => f.events.turnCompletes.length === 1);
    await f.adapter.submitInput("pty:s1", "next turn");
    assert.equal(f.fake.requestLog.filter((entry) => entry.method === "turn/start").length, 2);
  } finally {
    await f.close();
  }
});

test("programmatic inputs serialize per thread: concurrent submits land in order, never interleaved", async () => {
  const f = await fixture("pxa-serial-");
  try {
    await f.adapter.startOwned({ command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:s1" });
    await Promise.all([
      f.adapter.submitInput("pty:s1", "one"),
      f.adapter.submitInput("pty:s1", "two"),
      f.adapter.submitInput("pty:s1", "three")
    ]);
    const texts = f.fake
      .thread("thr_1")
      .turns.flatMap((turn) => turn.items)
      .filter((item) => item.type === "userMessage")
      .map((item) => (item.content as Array<{ text?: string }>)[0]?.text);
    assert.deepEqual(texts, ["one", "two", "three"]);
  } finally {
    await f.close();
  }
});

test("a rejected turn/start reports the provider's real error and is never retried", async () => {
  const f = await fixture("pxa-reject-");
  try {
    await f.adapter.startOwned({ command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:s1" });
    f.fake.nextTurnStartBehavior = "reject";
    await assert.rejects(
      f.adapter.submitAcknowledgedTurn("pty:s1", "kick", { clientUserMessageId: "k1" }),
      (error: unknown) => {
        assert.ok(isCodexRpcError(error));
        assert.match((error as Error).message, /turn refused by fake policy \(code=-32000\)/);
        return true;
      }
    );
    assert.equal(f.fake.requestLog.filter((entry) => entry.method === "turn/start").length, 1);
    assert.equal(userClientIds(f.fake.thread("thr_1").turns).length, 0);
    assert.equal(f.events.timeline.filter((entry) => entry.item.kind === "user").length, 0);
  } finally {
    await f.close();
  }
});

test("a lost turn/start response reconciles against thread history and never duplicates an accepted input", async () => {
  const f = await fixture("pxa-lost-");
  try {
    await f.adapter.startOwned({ command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:s1" });
    // The daemon applied the turn but the response never arrived.
    f.fake.nextTurnStartBehavior = "accept-no-response";
    const { turnId } = await f.adapter.submitAcknowledgedTurn("pty:s1", "kick", {
      clientUserMessageId: "k1",
      source: "agent"
    });
    // Reconciliation found the accepted turn in history - same turn id, no resend.
    assert.equal(turnId, "turn_1");
    assert.deepEqual(userClientIds(f.fake.thread("thr_1").turns), ["k1"]);
    assert.equal(f.fake.requestLog.filter((entry) => entry.method === "turn/start").length, 1);
    assert.equal(f.fake.requestLog.filter((entry) => entry.method === "thread/read").length, 1);
    assert.ok(
      f.events.timeline.some(
        (entry) => entry.item.id === "cx-item-k1" && entry.item.text === "kick" && entry.item.source === "agent"
      )
    );
  } finally {
    await f.close();
  }
});

test("a readiness turn with a lost response reconciles before awaiting its completion", async () => {
  const f = await fixture("pxa-wait-lost-");
  try {
    await f.adapter.startOwned({ command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:s1" });
    f.fake.nextTurnStartBehavior = "accept-no-response";
    const waiting = f.adapter.submitAcknowledgedTurnAndWait("pty:s1", "ready", {
      clientUserMessageId: "k1",
      source: "agent"
    });
    assert.equal(await until(2_000, () => f.fake.requestLog.some((entry) => entry.method === "thread/read")), true);
    f.fake.completeActiveTurn("thr_1", "Ready.");
    await Promise.race([
      waiting,
      tick(2_000).then(() => {
        throw new Error("timed out waiting for reconciled readiness completion");
      })
    ]);
    assert.equal(f.fake.requestLog.filter((entry) => entry.method === "turn/start").length, 1);
    assert.deepEqual(userClientIds(f.fake.thread("thr_1").turns), ["k1"]);
  } finally {
    await f.close();
  }
});

test("a connection lost before the daemon applied the input resends exactly once after history proves absence", async () => {
  const f = await fixture("pxa-absent-");
  try {
    await f.adapter.startOwned({ command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:s1" });
    f.fake.nextTurnStartBehavior = "lose-before-apply";
    const { turnId } = await f.adapter.submitAcknowledgedTurn("pty:s1", "kick", { clientUserMessageId: "k1" });
    assert.equal(turnId, "turn_1");
    // Two turn/start requests reached the daemon, but only one was applied,
    // and history-verified absence gated the second.
    assert.equal(f.fake.requestLog.filter((entry) => entry.method === "turn/start").length, 2);
    assert.deepEqual(userClientIds(f.fake.thread("thr_1").turns), ["k1"]);
  } finally {
    await f.close();
  }
});

test("daemon death after send surfaces unknown acceptance truthfully instead of guessing", async () => {
  const f = await fixture("pxa-unknown-", { reconnectDelaysMs: [20] });
  try {
    await f.adapter.startOwned({ command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:s1" });
    f.fake.nextTurnStartBehavior = "accept-no-response";
    const submit = f.adapter.submitAcknowledgedTurn("pty:s1", "kick", { clientUserMessageId: "k1" });
    // Kill the daemon entirely so reconnection cannot succeed.
    await f.fake.stop();
    await assert.rejects(submit, (error: unknown) => {
      assert.ok(error instanceof CodexDeliveryUnknownError);
      assert.match((error as Error).message, /not resent/);
      return true;
    });
  } finally {
    await f.close();
  }
});

test("protocol notifications drive status, streaming, turn lifecycle, and assistant timeline items", async () => {
  const f = await fixture("pxa-notif-");
  try {
    await f.adapter.startOwned({ command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:s1" });
    await f.adapter.submitInput("pty:s1", "go");
    await until(2_000, () => f.events.turnStarts.length === 1);
    f.fake.completeActiveTurn("thr_1", "all done");
    await until(2_000, () => f.events.turnCompletes.length === 1);
    assert.deepEqual(f.events.turnCompletes, [{ sessionId: "pty:s1", message: "all done" }]);
    const assistant = f.events.timeline.find((entry) => entry.item.kind === "assistant");
    assert.equal(assistant?.item.text, "all done");
    // Stable protocol item id -> replay-safe.
    assert.match(assistant?.item.id ?? "", /^cx-item-item_/);
    const sessions = await f.adapter.listSessions();
    assert.equal(sessions[0]?.status, "idle");
  } finally {
    await f.close();
  }
});

test("approvals fan out to the native TUI peer and a first answer dismisses the other client", async () => {
  const f = await fixture("pxa-approval-");
  const resolved: Array<string | number> = [];
  let peer: CodexAppServerClient | null = null;
  try {
    await f.adapter.startOwned({ command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:s1" });
    await f.adapter.submitInput("pty:s1", "run something");

    // A desktop human attaches the real TUI as a second same-user client.
    const peerRequests: PendingServerRequest[] = [];
    peer = new CodexAppServerClient({
      sessionId: "native-tui",
      spawn: websocketUnixTransport({ socketPath: f.socketPath }),
      onServerRequest: (request) => peerRequests.push(request),
      onServerRequestResolved: (request) => resolved.push(request.requestId)
    });
    await peer.connect();
    const replay = await peer.resumeThread({ threadId: "thr_1", cwd: f.dir });
    // History replay: the attached TUI sees the turn so far.
    assert.equal(replay.result.thread.turns?.length, 1);

    const { answer } = f.fake.requestApproval("thr_1", { command: "rm -rf ./scratch" });
    await until(2_000, () => f.events.serverRequests.length === 1 && peerRequests.length === 1);
    // Same request id on both subscribers.
    assert.equal(f.events.serverRequests[0]!.requestId, peerRequests[0]!.requestId);

    // Perch answers first (the phone tapped Allow): the peer TUI's copy resolves.
    assert.equal(
      f.adapter.respondToServerRequest("pty:s1", {
        requestId: f.events.serverRequests[0]!.requestId,
        decision: "accept"
      }),
      true
    );
    const first = await answer;
    assert.deepEqual(first.result, { decision: "accept" });
    await until(2_000, () => resolved.length === 1);
    assert.deepEqual(resolved, [peerRequests[0]!.requestId]);
  } finally {
    await peer?.disconnect().catch(() => {});
    await f.close();
  }
});

test("isolated app-server thread completes every command approval decision after serverRequest/resolved", async () => {
  const f = await fixture("pxa-all-approvals-");
  try {
    await f.adapter.startOwned({ command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:s1" });
    await f.adapter.submitInput("pty:s1", "run the approval matrix");
    const decisions = ["accept", "acceptForSession", "decline", "cancel", "acceptWithExecpolicyAmendment"];

    for (const [index, decision] of decisions.entries()) {
      const { requestId, answer } = f.fake.requestApproval("thr_1", {
        command: `echo ${index}`,
        cwd: f.dir,
        reason: `decision ${decision}`,
        proposedExecpolicyAmendment: ["echo"]
      });
      assert.ok(await until(2_000, () => f.events.serverRequests.some((request) => request.requestId === requestId)));
      const request = f.events.serverRequests.find((candidate) => candidate.requestId === requestId)!;
      assert.deepEqual(request.decisions.map((entry) => entry.id), decisions);
      assert.equal(
        f.adapter.respondToServerRequest("pty:s1", {
          requestId,
          threadId: "thr_1",
          decision
        }),
        true
      );
      const wire = await answer;
      assert.deepEqual(
        wire.result,
        decision === "acceptWithExecpolicyAmendment"
          ? { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["echo"] } } }
          : { decision }
      );
      assert.ok(await until(2_000, () => f.events.serverRequestsResolved.some((entry) => entry.requestId === requestId)));
      assert.deepEqual(f.fake.approvalCompletions.at(-1), {
        requestId,
        itemId: `item_${requestId}`,
        status: decision === "decline" || decision === "cancel" ? "declined" : "completed"
      });
      assert.equal((await f.adapter.listSessions())[0]?.status, "running");
    }
  } finally {
    await f.close();
  }
});

test("an approval answered on the attached TUI resolves Perch's pending copy (mobile dismissal)", async () => {
  const f = await fixture("pxa-approval-tui-");
  let peer: CodexAppServerClient | null = null;
  try {
    await f.adapter.startOwned({ command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:s1" });
    await f.adapter.submitInput("pty:s1", "run something");
    const peerRequests: PendingServerRequest[] = [];
    peer = new CodexAppServerClient({
      sessionId: "native-tui",
      spawn: websocketUnixTransport({ socketPath: f.socketPath }),
      onServerRequest: (request) => peerRequests.push(request)
    });
    await peer.connect();
    await peer.resumeThread({ threadId: "thr_1", cwd: f.dir });

    f.fake.requestApproval("thr_1", { command: "make deploy" });
    await until(2_000, () => f.events.serverRequests.length === 1 && peerRequests.length === 1);
    // The human answers in the native TUI; Perch's copy must resolve.
    peer.respondToServerRequest(peerRequests[0]!.requestId, "accept");
    await until(2_000, () => f.events.serverRequestsResolved.length === 1);
    assert.equal(f.events.serverRequestsResolved[0]!.requestId, f.events.serverRequests[0]!.requestId);
  } finally {
    await peer?.disconnect().catch(() => {});
    await f.close();
  }
});

test("a transient connection drop reconnects, resumes the thread, and replays history idempotently", async () => {
  const f = await fixture("pxa-reconnect-", { reconnectDelaysMs: [30, 120] });
  try {
    await f.adapter.startOwned({ command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:s1" });
    await f.adapter.submitAcknowledgedTurn("pty:s1", "kick", { clientUserMessageId: "k1" });
    f.fake.completeActiveTurn("thr_1", "first answer");
    await until(2_000, () => f.events.turnCompletes.length === 1);
    f.fake.thread("thr_1").turns[0]!.items.push(
      {
        id: "cmd_1",
        type: "commandExecution",
        command: ["npm", "test"],
        aggregatedOutput: "all passed",
        status: "completed"
      },
      { id: "patch_1", type: "fileChange", status: "completed" },
      {
        id: "cmd_live",
        type: "commandExecution",
        command: ["npm", "run", "build"],
        aggregatedOutput: "partial output"
      },
      { id: "patch_live", type: "fileChange", status: "inProgress" }
    );

    await f.fake.restart();
    // Bounded backoff reconnect + thread/resume, no session death.
    assert.ok(await until(3_000, () => f.fake.requestLog.some((entry) => entry.method === "thread/resume")));
    assert.ok(
      await until(3_000, () =>
        f.events.timeline.some(
          (entry) => entry.item.kind === "user" && entry.item.id === "cx-item-k1" && entry.live === false
        )
      )
    );
    assert.ok(f.adapter.has("pty:s1"));
    assert.deepEqual(f.events.exits, []);

    // Replayed history rows arrive as catch-up (live=false) with the same
    // stable ids the live path already emitted - downstream dedupe keeps one.
    const replayedUser = f.events.timeline.filter(
      (entry) => entry.item.kind === "user" && entry.item.id === "cx-item-k1"
    );
    assert.ok(replayedUser.some((entry) => entry.live === false));
    const replayedTools = f.events.timeline.filter((entry) => entry.live === false).map((entry) => entry.item);
    assert.deepEqual(
      replayedTools.filter((item) => item.id.startsWith("cx-item-cmd_1")).map((item) => [item.kind, item.text, item.tool]),
      [
        ["tool_call", undefined, { name: "shell", input: "npm test" }],
        ["tool_result", "all passed", undefined]
      ]
    );
    assert.deepEqual(
      replayedTools.filter((item) => item.id.startsWith("cx-item-patch_1")).map((item) => [item.kind, item.text, item.tool]),
      [
        ["tool_call", undefined, { name: "apply_patch" }],
        ["tool_result", "File change completed", undefined]
      ]
    );
    assert.deepEqual(
      replayedTools.filter((item) => item.id.startsWith("cx-item-cmd_live")).map((item) => item.kind),
      ["tool_call"]
    );
    assert.deepEqual(
      replayedTools.filter((item) => item.id.startsWith("cx-item-patch_live")).map((item) => item.kind),
      ["tool_call"]
    );

    // The session still works: submit another turn.
    const { turnId } = await f.adapter.submitAcknowledgedTurn("pty:s1", "again", { clientUserMessageId: "k2" });
    assert.equal(turnId, "turn_2");
  } finally {
    await f.close();
  }
});

test("exhausted reconnects end the session truthfully as an error exit", async () => {
  const f = await fixture("pxa-dead-", { reconnectDelaysMs: [20, 40] });
  try {
    await f.adapter.startOwned({ command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:s1" });
    await f.fake.stop();
    assert.ok(await until(3_000, () => f.events.exits.length === 1));
    assert.deepEqual(f.events.exits, [{ sessionId: "pty:s1", status: "error" }]);
    assert.equal(f.adapter.has("pty:s1"), false);
    // The dead daemon's socket was released.
    assert.deepEqual(f.daemons.releases, [f.socketPath]);
  } finally {
    await f.close();
  }
});

test("startOwned resume rebinds to a surviving daemon socket without a respawn and marks the interrupted turn", async () => {
  const f = await fixture("pxa-rebind-");
  try {
    // A previous life left a thread with an in-flight turn; the daemon
    // survived (restart() keeps thread state, drops connections).
    await f.adapter.startOwned({ command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:old" });
    await f.adapter.submitAcknowledgedTurn("pty:old", "kick", { clientUserMessageId: "k1" });
    f.adapter.stop({ keepDaemons: true });
    await f.fake.restart();

    const session = await f.adapter.startOwned(
      { command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:new", args: ["resume", "thr_1"] },
      { resume: { threadId: "thr_1", socketPath: f.socketPath, rootTaskReportingTool: true } }
    );
    assert.equal(session.id, "pty:new");
    assert.equal(f.adapter.threadIdOf("pty:new"), "thr_1");
    // Rebind adopted the recorded socket instead of acquiring a fresh daemon.
    assert.deepEqual(f.daemons.adopts, [f.socketPath]);
    assert.equal(f.daemons.acquires, 1); // only the original launch
    assert.equal(f.startHistoryCatchUp("pty:new"), true);
    // The stale in-flight turn is represented truthfully as interrupted.
    await until(2_000, () =>
      f.events.timeline.some(
        (entry) => entry.item.kind === "system" && /interrupted/.test(entry.item.text ?? "")
      )
    );
    const interrupted = f.events.timeline.find(
      (entry) => entry.item.kind === "system" && /interrupted/.test(entry.item.text ?? "")
    );
    assert.ok(interrupted, "interrupted turn marker replayed");
    assert.equal(interrupted?.live, false);
  } finally {
    await f.close();
  }
});

test("proven child-disabled legacy resumes retain compatibility reporting", async () => {
  const f = await fixture("pxa-legacy-resume-");
  try {
    f.fake.seedThread("thr_legacy", []);
    const session = await f.adapter.startOwned(
      {
        command: "codex",
        agent: "codex",
        cwd: f.dir,
        sessionId: "pty:legacy",
        args: ["resume", "thr_legacy"]
      },
      {
        resume: {
          threadId: "thr_legacy",
          socketPath: f.socketPath,
          legacyChildDisabled: true
        }
      }
    );

    assert.equal(session.nativeMultiAgentMode, "legacy_compatibility");
    assert.equal(f.adapter.taskReportingModeOf("pty:legacy"), "legacy_hook_compat");
    assert.deepEqual(f.daemons.adopts, [f.socketPath]);
    assert.deepEqual(f.daemons.retires, []);
    assert.deepEqual(f.daemons.configOverrides, []);
    const resume = f.fake.requestLog.findLast((entry) => entry.method === "thread/resume");
    assert.equal("dynamicTools" in (resume?.params ?? {}), false);
    f.fake.emitNotification("thr_legacy", "item/completed", {
      threadId: "thr_legacy",
      item: {
        type: "collabAgentToolCall",
        id: "legacy-child",
        senderThreadId: "thr_legacy",
        receiverThreadIds: ["child-legacy"],
        status: "inProgress",
        tool: "spawnAgent"
      }
    });
    await tick();
    assert.deepEqual(f.events.nativeChildren, []);
  } finally {
    await f.close();
  }
});

test("unproven legacy recovery retires the survivor before migrating to a fresh root", async () => {
  const f = await fixture("pxa-legacy-migrate-");
  try {
    f.fake.seedThread("thr_legacy", []);
    const session = await f.adapter.startOwned(
      {
        command: "codex",
        agent: "codex",
        cwd: f.dir,
        sessionId: "pty:migrated"
      },
      {
        resume: {
          threadId: "thr_legacy",
          socketPath: f.socketPath,
          migration: {
            reason: "unverified_native_multi_agent_capability",
            handoff: "task_brief"
          }
        }
      }
    );

    assert.deepEqual(f.daemons.operations, ["retire", "acquire"]);
    assert.deepEqual(f.daemons.retires, [f.socketPath]);
    assert.deepEqual(f.daemons.adopts, []);
    assert.equal(f.adapter.threadIdOf("pty:migrated"), "thr_1");
    assert.equal(session.nativeMultiAgentMode, "enabled");
    assert.equal(session.codexThreadMigration?.fromThreadId, "thr_legacy");
    assert.equal(f.fake.requestLog.some((entry) => entry.method === "thread/resume"), false);
    const start = f.fake.requestLog.find((entry) => entry.method === "thread/start");
    const dynamicTools = start?.params.dynamicTools as Array<{ tools?: Array<{ name?: string }> }> | undefined;
    assert.equal(dynamicTools?.[0]?.tools?.[0]?.name, "report_task_event");
  } finally {
    await f.close();
  }
});

test("startOwned recovery does not wait for full thread history before claiming ownership", async () => {
  const f = await fixture("pxa-metadata-resume-", {
    historyReplayRetryDelaysMs: [1, 1],
    historyPageTimeoutMs: 30
  });
  try {
    await f.adapter.startOwned({ command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:old" });
    await f.adapter.submitAcknowledgedTurn("pty:old", "kick", { clientUserMessageId: "k1" });
    f.adapter.stop({ keepDaemons: true });
    await f.fake.restart();
    f.fake.blockFullHistoryResume = true;
    f.fake.threadTurnsListFailuresRemaining = 1;
    f.fake.threadTurnsListTimeoutsRemaining = 1;

    const session = await Promise.race([
      f.adapter.startOwned(
        { command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:new", args: ["resume", "thr_1"] },
        { resume: { threadId: "thr_1", socketPath: f.socketPath, rootTaskReportingTool: true } }
      ),
      tick(500).then(() => {
        throw new Error("recovery waited for full thread history");
      })
    ]);

    assert.equal(session.id, "pty:new");
    const resume = f.fake.requestLog.findLast((entry) => entry.method === "thread/resume");
    assert.equal(resume?.params.excludeTurns, true);
    assert.equal(
      f.fake.requestLog.filter((entry) => entry.method === "thread/turns/list").length,
      0
    );
    assert.equal(f.startHistoryCatchUp("pty:new"), true);
    assert.ok(
      await until(2_000, () =>
        f.events.timeline.some(
          (entry) => entry.item.kind === "system" && /interrupted/.test(entry.item.text ?? "")
        )
      ),
      "interrupted turn marker replayed through paginated background history"
    );
    assert.equal(
      f.fake.requestLog.filter((entry) => entry.method === "thread/turns/list").length,
      3
    );
    assert.equal(
      f.events.fleet.filter((event) => event.name === "codex.history-catchup.retry").length,
      2
    );
    assert.ok(
      f.events.fleet.some((event) => event.name === "codex.history-catchup.completed")
    );
  } finally {
    await f.close();
  }
});

test("background history keeps provider order and cannot evict live recovery output", async () => {
  const f = await fixture("pxa-history-order-", {
    historyReplayRetryDelaysMs: [1],
    historyPageTimeoutMs: 30
  });
  try {
    const turns: FakeTurn[] = Array.from({ length: 2_105 }, (_, index) => ({
      id: `old-turn-${index}`,
      status: "completed",
      items: [{
        id: `old-item-${index}`,
        type: "agentMessage",
        text: `old-${index}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
      }]
    }));
    f.fake.seedThread("thr_big", turns);
    f.fake.threadTurnsListTimeoutsRemaining = 1;

    await f.adapter.startOwned(
      {
        command: "codex",
        agent: "codex",
        cwd: f.dir,
        sessionId: "pty:recovered",
        args: ["resume", "thr_big"]
      },
      { resume: { threadId: "thr_big", socketPath: f.socketPath, rootTaskReportingTool: true } }
    );
    assert.equal(f.startHistoryCatchUp("pty:recovered"), true);
    await f.adapter.submitAcknowledgedTurn("pty:recovered", "live recovery", {
      clientUserMessageId: "live-message"
    });
    f.fake.completeActiveTurn("thr_big", "live answer");

    assert.ok(
      await until(3_000, () =>
        f.events.fleet.some((event) => event.name === "codex.history-catchup.completed")
      )
    );
    const items = timelineItems(f.timeline, "pty:recovered");
    assert.equal(items.length, 2_000);
    assert.equal(items.at(-2)?.id, "cx-item-live-message");
    assert.equal(items.at(-1)?.text, "live answer");

    const oldItems = items.filter((item) => item.text?.startsWith("old-"));
    assert.equal(oldItems.length, 1_998);
    const oldIndexes = oldItems.map((item) => Number(item.text!.slice(4)));
    assert.ok(oldIndexes.every((value, index) => index === 0 || value > oldIndexes[index - 1]!));
    assert.ok(oldItems.every((item, index) =>
      index === 0 || Date.parse(item.at) > Date.parse(oldItems[index - 1]!.at)
    ));
  } finally {
    await f.close();
  }
});

test("terminal history catch-up failure is observable without rolling back the live session", async () => {
  const f = await fixture("pxa-history-failed-", {
    historyReplayRetryDelaysMs: [1],
    historyPageTimeoutMs: 30
  });
  try {
    f.fake.seedThread("thr_failed", []);
    f.fake.threadTurnsListFailuresRemaining = 2;
    const session = await f.adapter.startOwned(
      {
        command: "codex",
        agent: "codex",
        cwd: f.dir,
        sessionId: "pty:failed-history",
        args: ["resume", "thr_failed"]
      },
      { resume: { threadId: "thr_failed", socketPath: f.socketPath, rootTaskReportingTool: true } }
    );
    assert.equal(f.startHistoryCatchUp("pty:failed-history"), true);

    assert.equal(session.id, "pty:failed-history");
    assert.ok(
      await until(2_000, () =>
        f.events.fleet.some((event) => event.name === "codex.history-catchup.failed")
      )
    );
    assert.equal(f.adapter.has("pty:failed-history"), true);
    assert.deepEqual(f.events.exits, []);
  } finally {
    await f.close();
  }
});

test("a control drop records the active history receipt as failed", async () => {
  const f = await fixture("pxa-history-disconnect-", {
    reconnectDelaysMs: [1_000],
    historyPageTimeoutMs: 500
  });
  try {
    f.fake.seedThread("thr_disconnect", []);
    f.fake.threadTurnsListTimeoutsRemaining = 1;
    await f.adapter.startOwned(
      {
        command: "codex",
        agent: "codex",
        cwd: f.dir,
        sessionId: "pty:history-disconnect",
        args: ["resume", "thr_disconnect"]
      },
      { resume: { threadId: "thr_disconnect", socketPath: f.socketPath, rootTaskReportingTool: true } }
    );
    const terminal: Array<{ state: string; error?: string }> = [];
    assert.equal(
      f.adapter.startHistoryCatchUp("pty:history-disconnect", {
        syncId: "sync-disconnect",
        threadId: "thr_disconnect",
        cursor: null,
        onPage: () => {},
        onTerminal: (result) => terminal.push(result)
      }),
      true
    );
    assert.ok(
      await until(500, () =>
        f.fake.requestLog.some((entry) => entry.method === "thread/turns/list")
      )
    );

    await f.fake.stop();

    assert.ok(await until(500, () => terminal.length === 1));
    assert.equal(terminal[0]?.state, "failed");
    assert.match(terminal[0]?.error ?? "", /connection lost/i);
    assert.equal(f.adapter.has("pty:history-disconnect"), true);
  } finally {
    await f.close();
  }
});

test("startOwned resume adopts the recorded daemon when its runtime fingerprint still matches", async () => {
  const f = await fixture("pxa-fp-match-");
  try {
    await f.adapter.startOwned({ command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:old" });
    await f.adapter.submitAcknowledgedTurn("pty:old", "kick", { clientUserMessageId: "k1" });
    f.adapter.stop({ keepDaemons: true });
    await f.fake.restart();

    const session = await f.adapter.startOwned(
      { command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:new", args: ["resume", "thr_1"] },
      {
        resume: {
          threadId: "thr_1",
          socketPath: f.socketPath,
          runtimeFingerprint: "fp-live",
          rootTaskReportingTool: true
        }
      }
    );
    assert.equal(session.id, "pty:new");
    assert.equal(f.adapter.threadIdOf("pty:new"), "thr_1");
    assert.deepEqual(f.daemons.adopts, [f.socketPath]);
    assert.equal(f.daemons.acquires, 1); // only the original launch
  } finally {
    await f.close();
  }
});

test("startOwned resume refuses a daemon recorded by a different codex runtime and respawns", async () => {
  const f = await fixture("pxa-fp-mismatch-");
  try {
    await f.adapter.startOwned({ command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:old" });
    await f.adapter.submitAcknowledgedTurn("pty:old", "kick", { clientUserMessageId: "k1" });
    f.adapter.stop({ keepDaemons: true });
    await f.fake.restart();

    const session = await f.adapter.startOwned(
      { command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:new", args: ["resume", "thr_1"] },
      {
        resume: {
          threadId: "thr_1",
          socketPath: f.socketPath,
          runtimeFingerprint: "fp-old",
          rootTaskReportingTool: true
        }
      }
    );
    assert.equal(session.id, "pty:new");
    assert.equal(f.adapter.threadIdOf("pty:new"), "thr_1");
    // The stale-runtime daemon was never adopted; a fresh acquire resumed the
    // rollout-backed thread on the current runtime instead.
    assert.deepEqual(f.daemons.adopts, []);
    assert.equal(f.daemons.acquires, 2);
  } finally {
    await f.close();
  }
});

test("interrupt aborts the active turn over the protocol", async () => {
  const f = await fixture("pxa-interrupt-");
  try {
    await f.adapter.startOwned({ command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:s1" });
    await f.adapter.submitInput("pty:s1", "long job");
    await f.adapter.interrupt("pty:s1");
    assert.equal(f.fake.thread("thr_1").turns[0]!.status, "interrupted");
    assert.equal(f.fake.thread("thr_1").activeTurnId, null);
  } finally {
    await f.close();
  }
});

test("stopSession disconnects and releases the session's daemon", async () => {
  const f = await fixture("pxa-stop-");
  try {
    await f.adapter.startOwned({ command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:s1" });
    await f.adapter.stopSession("pty:s1");
    assert.deepEqual(f.daemons.releases, [f.socketPath]);
    assert.deepEqual(f.events.exits, [{ sessionId: "pty:s1", status: "done" }]);
    assert.equal((await f.adapter.listSessions()).length, 0);
  } finally {
    await f.close();
  }
});

test("switchModel arms the per-turn override and the next turn/start carries it", async () => {
  const f = await fixture("pxa-model-");
  try {
    await f.adapter.startOwned({ command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:s1" });
    assert.equal(f.adapter.switchModel("pty:s1", "gpt-5.5", "high"), true);
    await f.adapter.submitInput("pty:s1", "with the new model");
    const turnStart = f.fake.requestLog.find((entry) => entry.method === "turn/start");
    assert.equal(turnStart?.params.model, "gpt-5.5");
    assert.equal(turnStart?.params.effort, "high");
  } finally {
    await f.close();
  }
});
