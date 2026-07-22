import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexDaemonManager,
  type CodexDaemonProcess
} from "./codexDaemon.js";

// A fake daemon process that never really spawns codex.
function fakeProcess(): CodexDaemonProcess & { killed: boolean } {
  const state = {
    killed: false,
    pid: 4242,
    onExit(_cb: (code: number | null) => void) {
      /* stays alive for the test */
    },
    kill() {
      state.killed = true;
    }
  };
  return state as CodexDaemonProcess & { killed: boolean };
}

test("acquire spawns one daemon per workdir and reuses a healthy one", async () => {
  const spawns: Array<{ socketPath: string; cwd: string }> = [];
  const manager = new CodexDaemonManager({
    env: { PERCH_HOME: "/tmp/perch-daemon-test" },
    spawn: (args) => {
      spawns.push(args);
      return fakeProcess();
    },
    waitHealthy: async () => {
      /* always healthy */
    }
  });

  const a1 = await manager.acquire("/repo/one");
  const a2 = await manager.acquire("/repo/one");
  const b1 = await manager.acquire("/repo/two");

  // Same cwd reuses the daemon; distinct cwd gets its own (worktree isolation).
  assert.equal(a1.socketPath, a2.socketPath);
  assert.notEqual(a1.socketPath, b1.socketPath);
  assert.equal(spawns.length, 2);
  assert.equal(spawns[0]?.cwd, "/repo/one");
  assert.equal(spawns[1]?.cwd, "/repo/two");
  manager.stopAll();
});

test("acquire does not reuse a daemon across distinct session-scoped hook identities", async () => {
  const spawns: Array<{ socketPath: string; env?: Record<string, string> }> = [];
  const manager = new CodexDaemonManager({
    env: { PERCH_HOME: "/tmp/perch-daemon-test" },
    spawn: (args) => {
      spawns.push(args);
      return fakeProcess();
    },
    waitHealthy: async () => {
      /* always healthy */
    }
  });
  const firstEnv = {
    PERCH_SESSION_ID: "pty:first",
    PERCH_HOOK_URL: "http://127.0.0.1:8787/hooks",
    PERCH_HOOK_TOKEN: "first-token"
  };
  const secondEnv = {
    PERCH_SESSION_ID: "pty:second",
    PERCH_HOOK_URL: "http://127.0.0.1:8787/hooks",
    PERCH_HOOK_TOKEN: "second-token"
  };

  const first = await manager.acquire("/repo/one", { env: firstEnv });
  const second = await manager.acquire("/repo/one", { env: secondEnv });

  assert.notEqual(first.socketPath, second.socketPath);
  assert.equal(spawns.length, 2);
  assert.deepEqual(spawns[0]?.env, firstEnv);
  assert.deepEqual(spawns[1]?.env, secondEnv);
  manager.stopAll();
});

test("acquire threads config overrides to the spawn and keys distinct daemons per override", async () => {
  const spawns: Array<{ socketPath: string; cwd: string; configOverrides?: string[] }> = [];
  const manager = new CodexDaemonManager({
    env: { PERCH_HOME: "/tmp/perch-daemon-test" },
    spawn: (args) => {
      spawns.push(args);
      return fakeProcess();
    },
    waitHealthy: async () => {
      /* always healthy */
    }
  });

  const bare = await manager.acquire("/repo/one");
  const xhigh = await manager.acquire("/repo/one", {
    configOverrides: ['model_reasoning_effort="xhigh"']
  });
  const xhighAgain = await manager.acquire("/repo/one", {
    configOverrides: ['model_reasoning_effort="xhigh"']
  });

  // Same cwd but a different override is a different daemon; the same override
  // reuses it.
  assert.notEqual(bare.socketPath, xhigh.socketPath);
  assert.equal(xhigh.socketPath, xhighAgain.socketPath);
  assert.equal(spawns.length, 2);
  assert.deepEqual(spawns[0]?.configOverrides, []);
  assert.deepEqual(spawns[1]?.configOverrides, ['model_reasoning_effort="xhigh"']);
  manager.stopAll();
});

test("acquire restarts a daemon that stopped answering the health probe", async () => {
  let healthyCalls = 0;
  const spawns: number[] = [];
  const manager = new CodexDaemonManager({
    env: { PERCH_HOME: "/tmp/perch-daemon-test" },
    spawn: () => {
      spawns.push(1);
      return fakeProcess();
    },
    waitHealthy: async () => {
      healthyCalls += 1;
      // First acquire: healthy. Reuse probe (2nd call): dead. Restart probe: healthy.
      if (healthyCalls === 2) throw new Error("dead");
    }
  });

  await manager.acquire("/repo/x");
  await manager.acquire("/repo/x"); // reuse probe fails -> respawn
  assert.equal(spawns.length, 2);
  manager.stopAll();
});

test("acquire kills the process and rejects when the daemon never becomes healthy", async () => {
  const proc = fakeProcess();
  const manager = new CodexDaemonManager({
    env: { PERCH_HOME: "/tmp/perch-daemon-test" },
    spawn: () => proc,
    waitHealthy: async () => {
      throw new Error("never healthy");
    }
  });

  await assert.rejects(() => manager.acquire("/repo/dead"), /never healthy/);
  assert.equal(proc.killed, true);
  manager.stopAll();
});

test("release stops the daemon owned by a detached session and removes its socket artifacts", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-daemon-release-"));
  const proc = fakeProcess();
  const manager = new CodexDaemonManager({
    env: { PERCH_HOME: home },
    spawn: () => proc,
    waitHealthy: async () => {}
  });
  const handle = await manager.acquire("/repo/session", {
    env: { PERCH_SESSION_ID: "pty:session", PERCH_HOOK_TOKEN: "token" }
  });
  writeFileSync(handle.socketPath, "");
  assert.equal(existsSync(`${handle.socketPath}.pid`), true);

  manager.release(handle.socketPath);

  assert.equal(proc.killed, true);
  assert.equal(existsSync(handle.socketPath), false);
  assert.equal(existsSync(`${handle.socketPath}.pid`), false);
  rmSync(home, { recursive: true, force: true });
});

test("adopting a live socket recovers its recorded pid so release still stops the daemon", async () => {
  // The re-acquire-after-forget path: a perch-spawned daemon whose health
  // check once timed out is found listening again at its own socket path. The
  // adoption must read back the recorded pidfile so release() can stop the
  // process (via the identity-verifying killOrphan) instead of leaking a
  // daemon the next boot's sweep can no longer find.
  const home = mkdtempSync(join(tmpdir(), "perch-daemon-adopt-"));
  mkdirSync(join(home, "codex-daemons"), { recursive: true });
  const killed: number[] = [];
  let spawned = 0;
  const manager = new CodexDaemonManager({
    env: { PERCH_HOME: home },
    spawn: () => {
      spawned += 1;
      return fakeProcess();
    },
    waitHealthy: async () => {},
    killOrphan: (pid) => killed.push(pid)
  });
  const env = { PERCH_SESSION_ID: "pty:adopted", PERCH_HOOK_TOKEN: "token" };
  const socketPath = manager.socketPathFor("/repo/adopted", [], env);
  writeFileSync(socketPath, "");
  writeFileSync(`${socketPath}.pid`, "31337");

  const handle = await manager.acquire("/repo/adopted", { env });
  assert.equal(handle.socketPath, socketPath);
  assert.equal(spawned, 0, "a healthy same-identity socket is adopted, not respawned");

  manager.release(socketPath);

  assert.deepEqual(killed, [31337], "release signals the adopted daemon's recorded pid");
  assert.equal(existsSync(socketPath), false);
  assert.equal(existsSync(`${socketPath}.pid`), false);
  rmSync(home, { recursive: true, force: true });
});

test("replacing an unresponsive socket retires its recorded pid and both files before spawning the successor", async () => {
  // A socket that stops answering may belong to a daemon that is hung rather
  // than dead. The replacement must signal its recorded pid (identity-verified
  // via killOrphan) and remove socket + pidfile together - otherwise the
  // successor's spawn overwrites the pidfile and the hung daemon leaks with no
  // record release() or a later boot sweep could ever find.
  const home = mkdtempSync(join(tmpdir(), "perch-daemon-replace-"));
  mkdirSync(join(home, "codex-daemons"), { recursive: true });
  const killed: number[] = [];
  let probes = 0;
  const manager = new CodexDaemonManager({
    env: { PERCH_HOME: home },
    spawn: () => fakeProcess(),
    waitHealthy: async () => {
      probes += 1;
      // Probe of the pre-existing socket: unresponsive. Successor startup: healthy.
      if (probes === 1) throw new Error("unresponsive");
    },
    killOrphan: (pid) => killed.push(pid)
  });
  const env = { PERCH_SESSION_ID: "pty:replace", PERCH_HOOK_TOKEN: "token" };
  const socketPath = manager.socketPathFor("/repo/replace", [], env);
  writeFileSync(socketPath, "");
  writeFileSync(`${socketPath}.pid`, "40001");

  const handle = await manager.acquire("/repo/replace", { env });

  assert.equal(handle.socketPath, socketPath);
  assert.deepEqual(killed, [40001], "the hung predecessor's recorded pid is retired");
  assert.equal(readFileSync(`${socketPath}.pid`, "utf8"), "4242", "the pidfile now records the successor");
  manager.stopAll();
  rmSync(home, { recursive: true, force: true });
});

test("a replaced daemon's delayed exit cannot delete its successor's files during startup", async () => {
  // The window between the successor's spawn and its daemons.set registration
  // (waitHealthy) used to leave the exit guard blind: a delayed exit event
  // from the daemon being replaced fell through and removed the successor's
  // freshly written socket/pidfile. The spawn-identity guard closes it.
  const home = mkdtempSync(join(tmpdir(), "perch-daemon-exitrace-"));
  const exits: Array<(code: number | null) => void> = [];
  let pids = 5000;
  const manager = new CodexDaemonManager({
    env: { PERCH_HOME: home },
    spawn: () => {
      const pid = ++pids;
      return {
        pid,
        onExit(cb: (code: number | null) => void) {
          exits.push(cb);
        },
        kill() {}
      };
    },
    waitHealthy: (() => {
      let calls = 0;
      return async () => {
        calls += 1;
        // 1: first startup ok. 2: reuse probe fails. 3: successor startup -
        // the replaced daemon's exit lands mid-window, then health succeeds.
        if (calls === 2) throw new Error("dead");
        if (calls === 3) exits[0]!(null);
      };
    })()
  });

  const first = await manager.acquire("/repo/exitrace");
  const second = await manager.acquire("/repo/exitrace");

  assert.equal(second.socketPath, first.socketPath);
  assert.equal(
    readFileSync(`${second.socketPath}.pid`, "utf8"),
    "5002",
    "the successor's pidfile survives the predecessor's delayed exit"
  );
  manager.stopAll();
  assert.equal(existsSync(`${second.socketPath}.pid`), false, "the successor is still registered and cleaned by stopAll");
  rmSync(home, { recursive: true, force: true });
});

test("daemons are keyed by the codex runtime fingerprint so a client never redials an older runtime's socket", () => {
  const base = {
    env: { PERCH_HOME: "/tmp/perch-daemon-test" } as NodeJS.ProcessEnv,
    spawn: fakeProcess,
    waitHealthy: async () => {}
  };
  const older = new CodexDaemonManager({ ...base, runtimeFingerprint: () => "codex-cli 0.142.5" });
  const current = new CodexDaemonManager({ ...base, runtimeFingerprint: () => "codex-cli 0.144.1" });
  const env = { PERCH_SESSION_ID: "pty:same", PERCH_HOOK_TOKEN: "token" };

  // The same session identity on a newer runtime resolves a different socket
  // path, so the old daemon can never be adopted merely because it answers.
  assert.notEqual(older.socketPathFor("/repo/one", [], env), current.socketPathFor("/repo/one", [], env));
  assert.equal(current.socketPathFor("/repo/one", [], env), current.socketPathFor("/repo/one", [], env));
});

test("adoptExisting enforces the recorded runtime fingerprint: match adopts, mismatch refuses", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-daemon-adopt-fp-"));
  const dir = join(home, "codex-daemons");
  mkdirSync(dir, { recursive: true });
  const socketPath = join(dir, "adopt.sock");
  writeFileSync(socketPath, "");
  writeFileSync(`${socketPath}.pid`, "4321");

  const manager = new CodexDaemonManager({
    env: { PERCH_HOME: home },
    spawn: fakeProcess,
    waitHealthy: async () => {
      /* the recorded daemon still answers */
    },
    runtimeFingerprint: () => "codex-cli 0.144.6"
  });
  assert.equal(manager.currentRuntimeFingerprint(), "codex-cli 0.144.6");

  // Codex was upgraded between server lives: the recorded daemon still
  // answers, but adopting it would attach the new TUI to the old runtime -
  // the exact mismatch the acquire() fingerprint keying prevents.
  const mismatch = await manager.adoptExisting(socketPath, "/repo/one", {
    expectedRuntimeFingerprint: "codex-cli 0.142.5"
  });
  assert.equal(mismatch, null);

  const match = await manager.adoptExisting(socketPath, "/repo/one", {
    expectedRuntimeFingerprint: "codex-cli 0.144.6"
  });
  assert.equal(match?.socketPath, socketPath);

  // Runtime metadata recorded before the fingerprint existed still adopts.
  const legacy = await manager.adoptExisting(socketPath, "/repo/one");
  assert.equal(legacy?.socketPath, socketPath);

  manager.stopAll();
  rmSync(home, { recursive: true, force: true });
});

test("sweepOrphans retires stale sockets and recorded pids without touching owned daemons", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-daemon-sweep-"));
  const dir = join(home, "codex-daemons");
  mkdirSync(dir, { recursive: true });
  // Leftovers from a previous, non-gracefully exited server run.
  writeFileSync(join(dir, "aaaa.sock"), "");
  writeFileSync(join(dir, "aaaa.sock.pid"), "4321");
  writeFileSync(join(dir, "bbbb.sock"), "");
  writeFileSync(join(dir, "cccc.sock.pid"), "9999");

  const killed: number[] = [];
  const manager = new CodexDaemonManager({
    env: { PERCH_HOME: home },
    spawn: fakeProcess,
    waitHealthy: async () => {},
    killOrphan: (pid) => killed.push(pid)
  });
  const owned = await manager.acquire("/repo/live", {
    env: { PERCH_SESSION_ID: "pty:live", PERCH_HOOK_TOKEN: "token" }
  });
  writeFileSync(owned.socketPath, "");

  manager.sweepOrphans();

  // Only the pid recorded for a leftover socket is signalled; a dangling
  // pidfile with no socket is dropped without a kill.
  assert.deepEqual(killed, [4321]);
  assert.equal(existsSync(join(dir, "aaaa.sock")), false);
  assert.equal(existsSync(join(dir, "aaaa.sock.pid")), false);
  assert.equal(existsSync(join(dir, "bbbb.sock")), false);
  assert.equal(existsSync(join(dir, "cccc.sock.pid")), false);
  // The daemon this manager owns is untouched.
  assert.equal(existsSync(owned.socketPath), true);
  assert.equal(existsSync(`${owned.socketPath}.pid`), true);

  manager.stopAll();
  rmSync(home, { recursive: true, force: true });
});

test("socketPathFor is deterministic, per-workdir, and under PERCH_HOME", () => {
  const manager = new CodexDaemonManager({
    env: { PERCH_HOME: "/tmp/perch-daemon-test" },
    spawn: fakeProcess,
    waitHealthy: async () => {}
  });
  const p1 = manager.socketPathFor("/repo/one");
  const p2 = manager.socketPathFor("/repo/one");
  const p3 = manager.socketPathFor("/repo/two");
  assert.equal(p1, p2);
  assert.notEqual(p1, p3);
  assert.match(p1, /\/tmp\/perch-daemon-test\/codex-daemons\/[0-9a-f]{16}\.sock$/);
});
