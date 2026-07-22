import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodexAppServerClient } from "./codexAppServer.js";
import { codexOnPath } from "./codexDaemon.js";
import { isCodexMissingRolloutResumeError } from "../recovery.js";
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
