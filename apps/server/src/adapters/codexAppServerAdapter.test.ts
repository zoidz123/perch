import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionStatus, PendingServerRequest, TimelineItem } from "@perch/shared";
import { CodexAppServerAdapter, CodexDeliveryUnknownError } from "./codexAppServerAdapter.js";
import { CodexAppServerClient, isCodexRpcError } from "./codexAppServer.js";
import type { CodexDaemonManager } from "./codexDaemon.js";
import { FakeCodexAppServer, type FakeTurn } from "./fakeCodexAppServer.js";
import { websocketUnixTransport } from "./wsUnixTransport.js";

// The adapter suite runs against the fake daemon over the REAL ws-unix
// transport and protocol engine, so what passes here is the wire behavior
// verified against codex 0.144.6, not a hand-rolled stub's opinion.

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
  daemons: {
    acquires: number;
    releases: string[];
    adopts: string[];
  };
  events: {
    timeline: Array<{ item: TimelineItem; live: boolean }>;
    statuses: Array<{ sessionId: string; status: AgentSessionStatus }>;
    serverRequests: PendingServerRequest[];
    serverRequestsResolved: PendingServerRequest[];
    turnStarts: string[];
    turnCompletes: Array<{ sessionId: string; message: string }>;
    threads: Array<{ sessionId: string; threadId: string; socketPath: string }>;
    exits: Array<{ sessionId: string; status: string }>;
  };
  close: () => Promise<void>;
};

async function fixture(prefix: string, opts: { reconnectDelaysMs?: number[] } = {}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const socketPath = join(dir, "s");
  const fake = new FakeCodexAppServer();
  await fake.start(socketPath);
  const daemons = { acquires: 0, releases: [] as string[], adopts: [] as string[] };
  const fakeManager = {
    acquire: async () => {
      daemons.acquires += 1;
      return { socketPath, cwd: dir };
    },
    release: (path: string) => {
      daemons.releases.push(path);
    },
    adoptExisting: async (path: string, cwd: string) => {
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
    threads: [],
    exits: []
  };
  const adapter = new CodexAppServerAdapter({
    daemons: fakeManager,
    reconnectDelaysMs: opts.reconnectDelaysMs ?? [40, 80],
    sessionEnv: () => ({ PERCH_SESSION_ID: "wired" })
  });
  adapter.wireEvents({
    onTimelineItem: (item, live) => events.timeline.push({ item, live }),
    onStatus: (sessionId, status) => events.statuses.push({ sessionId, status }),
    onServerRequest: (_sessionId, request) => events.serverRequests.push(request),
    onServerRequestResolved: (_sessionId, request) => events.serverRequestsResolved.push(request),
    onTurnStarted: (sessionId) => events.turnStarts.push(sessionId),
    onTurnComplete: (sessionId, ev) => events.turnCompletes.push({ sessionId, message: ev.message }),
    onThreadStarted: (sessionId, threadId, socket) => events.threads.push({ sessionId, threadId, socketPath: socket }),
    onSessionExit: (sessionId, context) => events.exits.push({ sessionId, status: context.status })
  });
  return {
    dir,
    socketPath,
    fake,
    adapter,
    daemons,
    events,
    close: async () => {
      adapter.stop();
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

test("startOwned captures the thread id from the thread/start response and surfaces the attach command", async () => {
  const f = await fixture("pxa-");
  try {
    const session = await f.adapter.startOwned({ command: "codex", agent: "codex", cwd: f.dir, sessionId: "pty:s1" });
    assert.equal(session.id, "pty:s1");
    assert.equal(session.agent, "codex");
    assert.equal(f.adapter.threadIdOf("pty:s1"), "thr_1");
    assert.equal(session.attachCommand, `codex resume thr_1 --remote unix://${f.socketPath}`);
    assert.equal(session.model, "gpt-5.5-codex");
    assert.deepEqual(f.events.threads, [{ sessionId: "pty:s1", threadId: "thr_1", socketPath: f.socketPath }]);
    // The daemon env carried the per-session hook wiring request.
    assert.equal(f.daemons.acquires, 1);
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
    const { turnId } = await f.adapter.submitAcknowledgedTurn("pty:s1", "kick", { clientUserMessageId: "k1" });
    // Reconciliation found the accepted turn in history - same turn id, no resend.
    assert.equal(turnId, "turn_1");
    assert.deepEqual(userClientIds(f.fake.thread("thr_1").turns), ["k1"]);
    assert.equal(f.fake.requestLog.filter((entry) => entry.method === "turn/start").length, 1);
    assert.equal(f.fake.requestLog.filter((entry) => entry.method === "thread/read").length, 1);
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

    await f.fake.restart();
    // Bounded backoff reconnect + thread/resume, no session death.
    assert.ok(await until(3_000, () => f.fake.requestLog.some((entry) => entry.method === "thread/resume")));
    assert.ok(await until(3_000, () => f.adapter.has("pty:s1")));
    assert.deepEqual(f.events.exits, []);

    // Replayed history rows arrive as catch-up (live=false) with the same
    // stable ids the live path already emitted - downstream dedupe keeps one.
    const replayedUser = f.events.timeline.filter(
      (entry) => entry.item.kind === "user" && entry.item.id === "cx-item-k1"
    );
    assert.ok(replayedUser.some((entry) => entry.live === false));

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
      { resume: { threadId: "thr_1", socketPath: f.socketPath } }
    );
    assert.equal(session.id, "pty:new");
    assert.equal(f.adapter.threadIdOf("pty:new"), "thr_1");
    // Rebind adopted the recorded socket instead of acquiring a fresh daemon.
    assert.deepEqual(f.daemons.adopts, [f.socketPath]);
    assert.equal(f.daemons.acquires, 1); // only the original launch
    // The stale in-flight turn is represented truthfully as interrupted.
    const interrupted = f.events.timeline.find(
      (entry) => entry.item.kind === "system" && /interrupted/.test(entry.item.text ?? "")
    );
    assert.ok(interrupted, "interrupted turn marker replayed");
    assert.equal(interrupted?.live, false);
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
