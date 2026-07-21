import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CodexControlPlane } from "./codexControl.js";
import { CodexAppServerClient, type CodexTransport } from "./adapters/codexAppServer.js";
import { CodexDaemonManager } from "./adapters/codexDaemon.js";
import { markTaskWorkingFromActivity } from "./agentLauncher.js";
import { TaskCompletionReconciler } from "./taskCompletion.js";
import { TaskStore } from "./tasks.js";

// A scripted codex app-server over PassThrough streams (mirrors the harness in
// codexAppServer.test.ts): it parses the client's NDJSON, auto-replies to the
// lifecycle methods, records every request, and can push notifications. Lets a
// test exercise the REAL transport -> JSON-RPC path with no daemon or codex.
class ScriptedDaemon {
  toClient = new PassThrough();
  fromClient = new PassThrough();
  requests: Array<{ id?: number; method?: string; params?: any }> = [];
  private buf = "";
  private responders = new Map<string, (params: any) => unknown>();

  constructor() {
    this.fromClient.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString();
      let idx: number;
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        this.requests.push(msg);
        if (msg.id != null && msg.method && this.responders.has(msg.method)) {
          this.toClient.write(
            JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: this.responders.get(msg.method)!(msg.params) }) + "\n"
          );
        }
      }
    });
    this.responders.set("initialize", () => ({}));
    this.responders.set("thread/resume", () => ({ thread: { id: "thr_1" }, model: "gpt-5.5" }));
    this.responders.set("turn/start", () => ({ turn: { id: "turn_1" } }));
  }

  push(method: string, params: unknown): void {
    this.toClient.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  find(method: string): { params?: any } | undefined {
    return this.requests.find((r) => r.method === method);
  }
  transport(): CodexTransport {
    return {
      stdin: this.fromClient,
      stdout: this.toClient,
      stderr: null,
      pid: undefined,
      onExit: () => {},
      kill: () => {}
    };
  }
}

const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// A fake control client exposing only the surface the control plane touches.
function fakeClient(opts?: { failConnect?: boolean }) {
  const state = {
    connected: false,
    threadId: null as string | null,
    modelOverride: undefined as string | undefined,
    effortOverride: undefined as string | undefined,
    submitted: [] as Array<{ text: string; source?: string }>,
    onThreadStarted: undefined as ((id: string) => void) | undefined,
    async connect() {
      if (opts?.failConnect) throw new Error("connect failed");
      state.connected = true;
    },
    async disconnect() {
      state.connected = false;
    },
    isConnected() {
      return state.connected;
    },
    setModelForNextTurn(model?: string, effort?: string) {
      if (model?.trim()) state.modelOverride = model.trim();
      if (effort) state.effortOverride = effort;
    },
    async submitTurn(text: string, o?: { source?: string }) {
      state.submitted.push({ text, source: o?.source });
      return { turnId: "t1" };
    }
  };
  return state;
}

function planeWith(client: ReturnType<typeof fakeClient>, enabled = true) {
  return new CodexControlPlane({
    enabled,
    // Never spawns a real daemon in these tests.
    daemonManager: new CodexDaemonManager({
      env: { PERCH_HOME: "/tmp/perch-cc-test" },
      spawn: () => ({ pid: 1, onExit() {}, kill() {} }),
      waitHealthy: async () => {}
    }),
    createClient: ({ onThreadStarted }) => {
      client.onThreadStarted = onThreadStarted;
      return client as unknown as CodexAppServerClient;
    }
  });
}

test("prepareRemote returns null when the control plane is disabled", async () => {
  const plane = planeWith(fakeClient(), false);
  assert.equal(await plane.prepareRemote("/repo"), null);
});

test("prepareRemote acquires a daemon socket when enabled", async () => {
  const plane = planeWith(fakeClient(), true);
  const handle = await plane.prepareRemote("/repo");
  assert.notEqual(handle, null);
  assert.match(handle!.socketPath, /codex-daemons\/[0-9a-f]{16}\.sock$/);
});

test("prepareRemote bakes the reasoning effort into the daemon as a -c override", async () => {
  const spawns: Array<{ configOverrides?: string[] }> = [];
  const plane = new CodexControlPlane({
    enabled: true,
    daemonManager: new CodexDaemonManager({
      env: { PERCH_HOME: "/tmp/perch-cc-test" },
      spawn: (args) => {
        spawns.push(args);
        return { pid: 1, onExit() {}, kill() {} };
      },
      waitHealthy: async () => {}
    }),
    createClient: () => fakeClient() as unknown as CodexAppServerClient
  });
  await plane.prepareRemote("/repo", { effort: "xhigh" });
  assert.deepEqual(spawns.at(-1)?.configOverrides, ['model_reasoning_effort="xhigh"']);
});

test("prepareRemote seeds the daemon with the per-session hook env", async () => {
  const spawns: Array<{ env?: Record<string, string> }> = [];
  const plane = new CodexControlPlane({
    enabled: true,
    daemonManager: new CodexDaemonManager({
      env: { PERCH_HOME: "/tmp/perch-cc-test" },
      spawn: (args) => {
        spawns.push(args);
        return { pid: 1, onExit() {}, kill() {} };
      },
      waitHealthy: async () => {}
    }),
    createClient: () => fakeClient() as unknown as CodexAppServerClient
  });
  const env = { PERCH_SESSION_ID: "pty:abc", PERCH_HOOK_URL: "http://127.0.0.1:1/hooks", PERCH_HOOK_TOKEN: "tok" };
  await plane.prepareRemote("/repo", { env });
  assert.deepEqual(spawns.at(-1)?.env, env);
});

test("switchModel arms the per-turn override; submitTurn routes only once a shared thread is known", async () => {
  const client = fakeClient();
  const plane = planeWith(client);
  await plane.attach("cx-1", { socketPath: "/tmp/s", cwd: "/repo" });

  assert.equal(plane.switchModel("cx-1", "gpt-5.5", "low"), true);
  assert.equal(client.modelOverride, "gpt-5.5");
  assert.equal(client.effortOverride, "low");

  // No shared thread yet -> caller must fall back to the PTY path.
  assert.equal(await plane.submitTurn("cx-1", "hello"), false);
  assert.equal(client.submitted.length, 0);

  // The daemon broadcasts the TUI's thread; now the control client can steer it.
  client.onThreadStarted?.("thread-abc");
  assert.equal(await plane.submitTurn("cx-1", "hello"), true);
  assert.deepEqual(client.submitted, [{ text: "hello", source: "human" }]);
});

test("switchModel ignores empty models and unknown sessions", async () => {
  const client = fakeClient();
  const plane = planeWith(client);
  await plane.attach("cx-1", { socketPath: "/tmp/s", cwd: "/repo" });
  assert.equal(plane.switchModel("cx-1", "   "), false);
  assert.equal(plane.switchModel("nope", "gpt-5.5"), false);
  assert.equal(client.modelOverride, undefined);
});

test("attach failure forfeits the chip but does not throw; has() stays false", async () => {
  const client = fakeClient({ failConnect: true });
  const plane = planeWith(client);
  const ok = await plane.attach("cx-1", { socketPath: "/tmp/s", cwd: "/repo" });
  assert.equal(ok, false);
  assert.equal(plane.has("cx-1"), false);
  assert.equal(plane.switchModel("cx-1", "gpt-5.5"), false);
});

test("a phone-composer turn routes over the real transport as a turn/start RPC once the shared thread is known", async () => {
  // The regression: a codex session's input from the app must reach the
  // app-server as a turn/start RPC on the TUI's shared thread, and learning
  // that thread must fire onSharedThread (the http layer's cue to attach the
  // rollout tailer, the only channel by which daemon-driven turns reach the
  // app - the daemon runs `--remote` turns with no PERCH_SESSION_ID, so the
  // codex hooks never correlate this session).
  const daemon = new ScriptedDaemon();
  const shared: string[] = [];
  const plane = new CodexControlPlane({
    enabled: true,
    daemonManager: new CodexDaemonManager({
      env: { PERCH_HOME: "/tmp/perch-cc-test" },
      spawn: () => ({ pid: 1, onExit() {}, kill() {} }),
      waitHealthy: async () => {}
    }),
    createClient: ({ sessionId, onThreadStarted }) =>
      new CodexAppServerClient({ sessionId, spawn: () => daemon.transport(), onThreadStarted })
  });

  await plane.attach("cx-1", {
    socketPath: "/tmp/s",
    cwd: "/repo",
    onSharedThread: (threadId) => shared.push(threadId)
  });

  // No shared thread yet: the turn must NOT go over the protocol (caller falls
  // back to the PTY path), and onSharedThread has not fired.
  assert.equal(await plane.submitTurn("cx-1", "before"), false);
  assert.equal(daemon.find("turn/start"), undefined);
  assert.deepEqual(shared, []);

  // The daemon broadcasts the thread the `--remote` TUI opened.
  daemon.push("thread/started", { thread: { id: "thr_shared" } });
  await tick();
  assert.deepEqual(shared, ["thr_shared"]);

  // The shared daemon can later broadcast another thread (for example, an
  // internal Codex thread opened while the Mate keeps running). That must not
  // replace the root thread Perch persists for crash recovery.
  daemon.push("thread/started", { thread: { id: "thr_unrelated" } });
  await tick();
  assert.deepEqual(shared, ["thr_shared"]);

  // Now a composer turn routes over the wire as turn/start on that thread.
  assert.equal(await plane.submitTurn("cx-1", "hello codex", "human"), true);
  await tick();
  const turn = daemon.find("turn/start");
  assert.equal(turn?.params?.threadId, "thr_shared");
  assert.equal(turn?.params?.input?.[0]?.text, "hello codex");

  await plane.detach("cx-1");
});

test("an empty-message Codex turn records completion and immediate stalled once", async () => {
  // End-to-end over the real control transport: a daemon-driven codex worker
  // (as the orchestrator dispatches it - no PERCH_SESSION_ID Stop hook fires)
  // finishes on a tool result without a final assistant message. Provider
  // completion must still reach the task reconciler exactly once.
  const home = mkdtempSync(join(tmpdir(), "perch-cc-e2e-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const task = tasks.update(tasks.create({ title: "port the fix", project: "/repo" }).id, {
    sessionId: "pty:worker-1"
  });
  tasks.recordEvent(task.id, { kind: "working", source: "worker", message: "starting" });
  const reconciler = new TaskCompletionReconciler({ tasks });

  const daemon = new ScriptedDaemon();
  const plane = new CodexControlPlane({
    enabled: true,
    daemonManager: new CodexDaemonManager({
      env: { PERCH_HOME: home },
      spawn: () => ({ pid: 1, onExit() {}, kill() {} }),
      waitHealthy: async () => {}
    }),
    createClient: ({ sessionId, onThreadStarted, onTurnComplete, onTurnStarted, onStatus }) =>
      new CodexAppServerClient({
        sessionId,
        spawn: () => daemon.transport(),
        onThreadStarted,
        onTurnComplete,
        onTurnStarted,
        onStatus
      })
  });

  const completed: string[] = [];
  const statuses: string[] = [];

  await plane.attach("pty:worker-1", {
    socketPath: "/tmp/s",
    cwd: "/repo",
    onTurnStarted: () => {
      reconciler.onTurnStarted("pty:worker-1", "codex");
    },
    onTurnComplete: (ev) => {
      completed.push(ev.message);
      reconciler.onTurnCompleted("pty:worker-1", "codex");
    },
    onStatus: (status) => statuses.push(status)
  });

  // The daemon drives the incident shape: the last item is a tool result, then
  // authoritative completion arrives twice through provider notifications.
  daemon.push("thread/started", { thread: { id: "thr_shared" } });
  daemon.push("turn/started", { turn: { id: "turn_1" } });
  daemon.push("item/completed", {
    item: { type: "commandExecution", id: "tool_1", aggregatedOutput: "tests passed" }
  });
  daemon.push("turn/completed", { turn: { id: "turn_1", status: "completed" } });
  daemon.push("turn/completed", { turn: { id: "turn_1", status: "completed" } });
  await tick();

  const after = tasks.find(task.id)!;
  assert.equal(after.state, "working");
  assert.deepEqual(completed, [""]);
  assert.equal(statuses.at(-1), "idle");
  const lifecycle = tasks.events(task.id).filter((event) =>
    event.kind === "turn_started" || event.kind === "turn_completed" || event.kind === "stalled"
  );
  assert.deepEqual(lifecycle.map((event) => event.kind), ["turn_started", "turn_completed", "stalled"]);
  assert.equal(lifecycle[1]?.data?.retryNeeded, true);
  assert.equal(lifecycle[1]?.data?.outcomeEventSeq, undefined);
  assert.equal(lifecycle[2]?.data?.reason, "turn_outcome_missing");

  await plane.detach("pty:worker-1");
  rmSync(home, { recursive: true, force: true });
});

test("a mid-turn approval resume preserves a deliberate blocked verb; only the next real turn recovers it", async () => {
  // Live-shaped regression for the approval-resume clobber: a worker curls
  // `blocked` mid-turn, later hits an exec approval in the SAME turn, and the
  // boss approves. The needs_approval -> running resolution and the turn's
  // trailing stream/completion frames must all leave the ledger blocked; the
  // next actual turn start recovers it to working. Turn completion remains
  // runtime evidence and never creates task done.
  const home = mkdtempSync(join(tmpdir(), "perch-cc-blocked-"));
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const task = tasks.create({ title: "ship it", project: "/repo" });
  tasks.update(task.id, { sessionId: "pty:worker-2", branch: "perch/ship" });
  tasks.recordEvent(task.id, { kind: "working", source: "worker" });

  const reconciler = new TaskCompletionReconciler({ tasks });

  const daemon = new ScriptedDaemon();
  const plane = new CodexControlPlane({
    enabled: true,
    daemonManager: new CodexDaemonManager({
      env: { PERCH_HOME: home },
      spawn: () => ({ pid: 1, onExit() {}, kill() {} }),
      waitHealthy: async () => {}
    }),
    createClient: ({ sessionId, onThreadStarted, onAssistantStream, onStatus, onTurnComplete, onTurnStarted }) =>
      new CodexAppServerClient({
        sessionId,
        spawn: () => daemon.transport(),
        onThreadStarted,
        onAssistantStream,
        onStatus,
        onTurnComplete,
        onTurnStarted,
        approvalHandler: async () => "approved"
      })
  });

  // Mirror the production launcher wiring (attachCodexControl).
  const sessionId = "pty:worker-2";
  await plane.attach(sessionId, {
    socketPath: "/tmp/s2",
    cwd: "/repo",
    onAssistantStream: () => markTaskWorkingFromActivity({ tasks }, sessionId),
    onTurnStarted: () => {
      reconciler.onTurnStarted(sessionId, "codex");
      markTaskWorkingFromActivity({ tasks }, sessionId, { newTurn: true });
    },
    onTurnComplete: () => {
      markTaskWorkingFromActivity({ tasks }, sessionId);
      reconciler.onTurnCompleted(sessionId, "codex");
    }
  });

  daemon.push("thread/started", { thread: { id: "thr_2" } });
  daemon.push("turn/started", { turn: { id: "turn_1" } });
  await tick();
  // The worker deliberately parks the task mid-turn.
  tasks.recordEvent(task.id, { kind: "blocked", source: "worker", message: "need the boss to unlock CI" });

  // Later in the SAME turn: an exec approval the boss approves. Resolution
  // flips needs_approval -> running, which must not read as a new turn.
  daemon.toClient.write(
    JSON.stringify({ jsonrpc: "2.0", id: 77, method: "execCommandApproval", params: { callId: "c1", command: ["make", "test"] } }) + "\n"
  );
  await tick();
  assert.equal(tasks.find(task.id)?.state, "blocked", "approval resume leaves the deliberate blocked verb intact");

  // The turn's trailing stream frame and completion must not recover it either.
  daemon.push("item/agentMessage/delta", { itemId: "a1", delta: "wrapping up" });
  daemon.push("item/completed", { item: { type: "agentMessage", id: "a1", text: "blocked on CI access" } });
  daemon.push("turn/completed", { turn: { id: "turn_1", status: "completed" } });
  await tick();
  assert.equal(tasks.find(task.id)?.state, "blocked", "trailing completion never clobbers blocked");

  // The boss unblocks and the worker starts an actual new turn: that explicit
  // start recovers working, and its completion records evidence only.
  daemon.push("turn/started", { turn: { id: "turn_2" } });
  await tick();
  assert.equal(tasks.find(task.id)?.state, "working", "a real turn start recovers blocked -> working");
  daemon.push("item/completed", { item: { type: "agentMessage", id: "a2", text: "Shipped: https://github.com/o/r/pull/7" } });
  daemon.push("turn/completed", { turn: { id: "turn_2", status: "completed" } });
  await tick(20);

  assert.equal(tasks.find(task.id)?.state, "working");
  assert.equal(
    tasks.events(task.id).filter((event) => event.kind === "turn_completed").length,
    2,
    "both provider turn endings are durable without inventing done"
  );

  await plane.detach(sessionId);
  rmSync(home, { recursive: true, force: true });
});

test("detach disconnects and forgets the session", async () => {
  const client = fakeClient();
  const plane = planeWith(client);
  await plane.attach("cx-1", { socketPath: "/tmp/s", cwd: "/repo" });
  assert.equal(plane.has("cx-1"), true);
  await plane.detach("cx-1");
  assert.equal(plane.has("cx-1"), false);
  assert.equal(client.isConnected(), false);
});

function planeWithDaemonProc(client: ReturnType<typeof fakeClient>, home: string) {
  const proc = { pid: 4242, killed: false, onExit() {}, kill() { proc.killed = true; } };
  const plane = new CodexControlPlane({
    enabled: true,
    daemonManager: new CodexDaemonManager({
      env: { PERCH_HOME: home },
      spawn: () => proc,
      waitHealthy: async () => {}
    }),
    createClient: () => client as unknown as CodexAppServerClient
  });
  return { plane, proc };
}

test("a session whose control attach failed still releases its daemon on detach", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-cc-release-"));
  const { plane, proc } = planeWithDaemonProc(fakeClient({ failConnect: true }), home);

  const handle = await plane.prepareRemote("/repo", {
    env: { PERCH_SESSION_ID: "pty:worker", PERCH_HOOK_URL: "http://127.0.0.1:1/hooks", PERCH_HOOK_TOKEN: "tok" }
  });
  assert.notEqual(handle, null);
  assert.equal(await plane.attach("pty:worker", { socketPath: handle!.socketPath, cwd: "/repo" }), false);

  // Attach is best-effort, but ownership was recorded at acquisition: the
  // session's exit must still stop the daemon instead of leaking it.
  await plane.detach("pty:worker");
  assert.equal(proc.killed, true);
  rmSync(home, { recursive: true, force: true });
});

test("transferDaemon re-keys ownership so detaching a refused pre-minted id cannot kill the live daemon", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-cc-transfer-"));
  const { plane, proc } = planeWithDaemonProc(fakeClient(), home);

  const handle = await plane.prepareRemote("/repo", {
    env: { PERCH_SESSION_ID: "pty:minted", PERCH_HOOK_URL: "http://127.0.0.1:1/hooks", PERCH_HOOK_TOKEN: "tok" }
  });
  await plane.attach("pty:minted", { socketPath: handle!.socketPath, cwd: "/repo" });

  plane.transferDaemon("pty:minted", "pty:adapter");
  await plane.detach("pty:minted");
  assert.equal(proc.killed, false, "the misaddressed control client detach must not stop the live daemon");

  await plane.detach("pty:adapter");
  assert.equal(proc.killed, true, "the adopted id's exit releases the daemon");
  rmSync(home, { recursive: true, force: true });
});
