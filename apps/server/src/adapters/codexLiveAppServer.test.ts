import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodexAppServerClient } from "./codexAppServer.js";
import { codexOnPath } from "./codexDaemon.js";
import { isCodexMissingRolloutResumeError } from "../recovery.js";
import type { NativeChildRunObservation } from "../nativeChildRuns.js";
import { websocketUnixTransport } from "./wsUnixTransport.js";

// Live verification against the INSTALLED codex (0.144.6 at authoring time):
// the generated protocol schemas carry the fields the owned adapter depends
// on, a real `codex app-server --listen unix://` daemon accepts the owner
// handshake plus a second same-user client resuming the same thread (exactly
// what `codex resume <threadId> --remote unix://<socket>` does), and the
// native TUI advertises `--remote`. No model turns run, an isolated
// CODEX_HOME keeps the user's sessions untouched, and everything skips
// cleanly where codex is not installed (CI).

const HAVE_CODEX = codexOnPath();
// This test performs real model work and can create rollout records under the
// explicitly supplied, dedicated Codex home. It never runs in ordinary local
// or CI suites, and it never copies the user's config or credentials.
const NATIVE_MULTI_AGENT_E2E_HOME = process.env.PERCH_CODEX_NATIVE_MULTI_AGENT_E2E_HOME;
const RUN_NATIVE_MULTI_AGENT_E2E =
  HAVE_CODEX &&
  process.env.PERCH_CODEX_NATIVE_MULTI_AGENT_E2E === "1" &&
  typeof NATIVE_MULTI_AGENT_E2E_HOME === "string" &&
  NATIVE_MULTI_AGENT_E2E_HOME.length > 0;

async function waitForDaemonClient(client: CodexAppServerClient, socketPath: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) {
      try {
        await client.connect();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`app-server did not become healthy: ${String(lastError)}`);
}

test("installed codex schemas carry clientUserMessageId, expectedTurnId, and thread/read includeTurns", {
  skip: !HAVE_CODEX,
  timeout: 60_000
}, () => {
  const out = mkdtempSync(join(tmpdir(), "pxschema-"));
  try {
    execFileSync("codex", ["app-server", "generate-json-schema", "--out", out], { timeout: 30_000 });
    const v2 = join(out, "v2");
    const turnStart = JSON.parse(readFileSync(join(v2, "TurnStartParams.json"), "utf8")) as {
      properties?: Record<string, unknown>;
    };
    assert.ok(turnStart.properties?.clientUserMessageId, "turn/start accepts clientUserMessageId");
    const turnSteer = JSON.parse(readFileSync(join(v2, "TurnSteerParams.json"), "utf8")) as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    assert.ok(turnSteer.required?.includes("expectedTurnId"), "turn/steer requires the expectedTurnId CAS");
    const threadRead = JSON.parse(readFileSync(join(v2, "ThreadReadParams.json"), "utf8")) as {
      properties?: Record<string, unknown>;
    };
    assert.ok(threadRead.properties?.includeTurns, "thread/read replays turns from rollout history");
    const threadReadResponse = readFileSync(join(v2, "ThreadReadResponse.json"), "utf8");
    assert.match(threadReadResponse, /"clientId"/, "history user messages surface the clientId");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("the installed native TUI advertises the --remote attach surface", { skip: !HAVE_CODEX, timeout: 30_000 }, () => {
  const help = execFileSync("codex", ["resume", "--help"], { encoding: "utf8", timeout: 15_000 });
  assert.match(help, /--remote/, "codex resume supports --remote <ADDR>");
  assert.match(help, /\[SESSION_ID\]/, "codex resume takes the thread id positionally");
});

test("live daemon: owner handshake, thread/start, thread/read, and the fresh-thread resume race", {
  skip: !HAVE_CODEX,
  timeout: 60_000
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pxlive-"));
  const codexHome = mkdtempSync(join(tmpdir(), "pxlive-home-"));
  const socketPath = join(dir, "s");
  let daemon: ChildProcess | undefined;
  const owner = new CodexAppServerClient({
    sessionId: "live-owner",
    spawn: websocketUnixTransport({ socketPath }),
    clientName: "perch-live-test"
  });
  const attacher = new CodexAppServerClient({
    sessionId: "live-attacher",
    spawn: websocketUnixTransport({ socketPath }),
    clientName: "perch-live-attach"
  });
  try {
    daemon = spawn("codex", ["app-server", "--listen", `unix://${socketPath}`], {
      cwd: dir,
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ["ignore", "ignore", "ignore"]
    });
    const deadline = Date.now() + 30_000;
    let connected = false;
    while (Date.now() < deadline && !connected) {
      if (existsSync(socketPath)) {
        try {
          await owner.connect();
          connected = true;
          break;
        } catch {
          // Daemon still booting.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(connected, "owner client completed initialize against the live daemon");

    const started = await owner.startThread({ cwd: dir });
    assert.ok(started.threadId.length > 0, "thread/start returned the authoritative thread id");

    // Pinned live contract: before the first user message the thread is not
    // materialized and refuses includeTurns - the adapter treats exactly this
    // rejection as authoritative absence during lost-input reconciliation.
    await assert.rejects(owner.readThread(started.threadId), /not materialized yet.*code=-32600/s);

    // The fresh-thread missing-rollout race, pinned against the REAL daemon:
    // codex writes the rollout only at the thread's first turn, so a second
    // client's thread/resume on a turn-less thread fails with exactly the
    // -32600 condition the recovery classifier matches. In production the
    // kickoff turn always precedes any human attach, so the surfaced
    // `codex resume <threadId> --remote unix://<socket>` command targets a
    // rollout-backed thread; this assertion is the race's contract, and it
    // doubles as live proof the classifier still matches 0.144.6's message.
    await attacher.connect();
    await assert.rejects(
      attacher.resumeThread({ threadId: started.threadId, cwd: dir }),
      (error: unknown) => {
        assert.ok(isCodexMissingRolloutResumeError(error), `unexpected resume error: ${String(error)}`);
        return true;
      }
    );
  } finally {
    await attacher.disconnect().catch(() => {});
    await owner.disconnect().catch(() => {});
    daemon?.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 200));
    rmSync(dir, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("opt-in live native multi-agent root observes children, then reopens the completed graph after daemon restart", {
  skip: !RUN_NATIVE_MULTI_AGENT_E2E,
  timeout: 420_000
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pxlive-native-multi-agent-"));
  const socketPath = join(dir, "s");
  const observations: NativeChildRunObservation[] = [];
  let daemon: ChildProcess | undefined;
  const root = new CodexAppServerClient({
    sessionId: "live-native-root",
    spawn: websocketUnixTransport({ socketPath }),
    clientName: "perch-live-native-root",
    onNativeChildObservation: (observation) => observations.push(observation)
  });
  const reopenRoot = new CodexAppServerClient({
    sessionId: "live-native-reopen-root",
    spawn: websocketUnixTransport({ socketPath }),
    clientName: "perch-live-native-reopen-root"
  });
  const reopenChildren: CodexAppServerClient[] = [];
  const startDaemon = () => spawn("codex", ["app-server", "--listen", `unix://${socketPath}`], {
    cwd: dir,
    env: { ...process.env, CODEX_HOME: NATIVE_MULTI_AGENT_E2E_HOME! },
    stdio: ["ignore", "ignore", "ignore"]
  });
  const stopDaemon = async () => {
    if (!daemon || daemon.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => {
      daemon!.once("exit", () => resolve());
      daemon!.once("error", () => resolve());
    });
    daemon.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("native test daemon did not exit")), 10_000))
    ]);
  };
  try {
    daemon = startDaemon();
    await waitForDaemonClient(root, socketPath);
    const started = await root.startThread({ cwd: dir, sandbox: "read-only" });
    const settled = await root.submitTurnAndWait(
      "Use native multi-agent collaboration now. Spawn exactly two read-only children with distinct small research tasks about this empty temporary directory. Follow up with one child for a concise status, wait for both children to finish, then return a concise combined result. Do not write files and do not call any Perch hook or task endpoint.",
      { turnTimeoutMs: 360_000 }
    );
    assert.equal(settled.aborted, false, "the root native collaboration turn completed");
    const childThreadIds = [...new Set(observations.map((observation) => observation.childThreadId))];
    assert.ok(childThreadIds.length >= 2, "root emitted observations for at least two native children");
    assert.ok(
      observations.some((observation) => observation.protocol.itemType === "subAgentActivity"),
      "root exposed native child activity"
    );

    await root.disconnect();
    await stopDaemon();
    daemon = startDaemon();
    await waitForDaemonClient(reopenRoot, socketPath);
    const resumedRoot = await reopenRoot.resumeThread({ threadId: started.threadId, cwd: dir, excludeTurns: true });
    assert.equal(resumedRoot.threadId, started.threadId, "completed root reopens after daemon restart");
    for (const childThreadId of childThreadIds.slice(0, 2)) {
      const child = new CodexAppServerClient({
        sessionId: `live-native-reopen-${childThreadId}`,
        spawn: websocketUnixTransport({ socketPath }),
        clientName: "perch-live-native-reopen-child"
      });
      reopenChildren.push(child);
      await child.connect();
      const resumedChild = await child.resumeThread({ threadId: childThreadId, cwd: dir, excludeTurns: true });
      assert.equal(resumedChild.threadId, childThreadId, "completed native child reopens after daemon restart");
    }
  } finally {
    await Promise.all(reopenChildren.map((client) => client.disconnect().catch(() => {})));
    await reopenRoot.disconnect().catch(() => {});
    await root.disconnect().catch(() => {});
    await stopDaemon().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    rmSync(dir, { recursive: true, force: true });
  }
});
