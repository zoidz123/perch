import assert from "node:assert/strict";
import { test } from "node:test";
import { PtyAgentAdapter, type PtyProcess, type SpawnPty } from "./adapters/pty.js";

class FakePtyProcess implements PtyProcess {
  // A live pid by default so the liveness sweep never reaps fake sessions.
  pid = process.pid;
  writes: string[] = [];
  killed = false;
  resizes: Array<{ cols: number; rows: number }> = [];
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  write(data: string): void {
    this.writes.push(data);
    // Real TTYs echo typed input; submit verification reads it off the screen.
    this.emitData(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
    // Real PTYs report exit shortly after a kill.
    this.emitExit(0);
  }

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return {
      dispose: () => {
        this.dataListeners.delete(listener);
      }
    };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.add(listener);
    return {
      dispose: () => {
        this.exitListeners.delete(listener);
      }
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(exitCode: number): void {
    for (const listener of this.exitListeners) {
      listener({ exitCode });
    }
  }
}

type RecordedEvent = {
  type: string;
  sessionId: string;
  text?: string;
  raw?: string;
  seq?: number;
  status?: string;
};

test("PTY adapter starts sessions and streams coalesced raw deltas", async () => {
  let child: FakePtyProcess | undefined;
  let spawnOptions: Parameters<SpawnPty>[2] | undefined;
  const spawn: SpawnPty = (_command, _args, options) => {
    spawnOptions = options;
    child = new FakePtyProcess();
    return child;
  };
  const adapter = new PtyAgentAdapter(spawn);
  const agentEvents: RecordedEvent[] = [];
  const fleetEvents: Array<{ kind: string; sessionId?: string; status?: string }> = [];
  adapter.subscribeAgentEvents((event) => agentEvents.push(event));
  adapter.subscribeFleetEvents((event) => fleetEvents.push(event));

  const session = await adapter.startAgent({
    command: "codex",
    args: ["--model", "test"],
    cwd: "/tmp/perch-test",
    title: "Test agent",
    desktop: {
      sessionId: "workspace:1::surface:2",
      workspaceId: "workspace:1",
      surfaceId: "surface:2",
      terminal: "ghostty",
      cols: 88,
      rows: 24
    }
  });

  assert.ok(session.id.startsWith("pty:"));
  assert.equal(session.agent, "codex");
  assert.equal(session.cwd, "/tmp/perch-test");
  assert.equal(spawnOptions?.cols, 88);
  assert.equal(spawnOptions?.rows, 24);
  assert.equal(adapter.sessionAliases().get("workspace:1::surface:2"), session.id);
  assert.equal((await adapter.listSessions()).length, 1);
  assert.equal((await adapter.getTopology()).windows[0]?.workspaces[0]?.title, "Perch agents");
  assert.equal(fleetEvents.at(-1)?.kind, "topology");

  child?.emitData("hello");
  child?.emitData(" world\n");

  // Deltas carry raw bytes (coalesced), not rendered text; joined they must
  // reproduce the byte stream, with monotonically increasing seq.
  const raw = await waitForRaw(agentEvents, "hello world\n");
  assert.equal(raw, "hello world\n");
  const outputs = agentEvents.filter((event) => event.type === "terminal_output");
  assert.ok(outputs.every((event) => event.text === undefined));
  const seqs = outputs.map((event) => event.seq ?? 0);
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs);

  // Rendered text is available on demand for the tail/logs path.
  const recent = await adapter.readRecentEvents(session.id, 20);
  assert.equal(recent.terminal, true);
  assert.equal(recent.events[0]?.type, "terminal_output");
  assert.equal(recent.events[0]?.type === "terminal_output" ? recent.events[0].text : "", "hello world");

  // Snapshot carries the serialized screen and current geometry/seq.
  const snapshot = await adapter.snapshot(session.id);
  assert.ok(snapshot.data.includes("hello world"));
  assert.equal(snapshot.cols, 88);
  assert.equal(snapshot.rows, 24);
  assert.equal(snapshot.seq, seqs.at(-1));

  await adapter.resize(session.id, 120, 40);
  assert.deepEqual(child?.resizes, [{ cols: 120, rows: 40 }]);
  assert.equal((await adapter.snapshot(session.id)).cols, 120);

  await adapter.sendInput(session.id, "prompt");
  await adapter.submitInput(session.id, "submitted prompt");
  await adapter.sendEnter(session.id);
  await adapter.interrupt(session.id);
  assert.deepEqual(child?.writes, ["prompt", "submitted prompt", "\r", "\r", "\x03"]);

  // Raw keystrokes are activity only; submit is what claims running.
  assert.equal((await adapter.listSessions())[0]?.status, "waiting");
  await adapter.sendInput(session.id, "j");
  assert.equal((await adapter.listSessions())[0]?.status, "waiting");
  await adapter.submitInput(session.id, "go");
  assert.equal((await adapter.listSessions())[0]?.status, "running");

  child?.emitExit(0);
  assert.equal(agentEvents.at(-1)?.type, "status");
  assert.equal(agentEvents.at(-1)?.status, "done");

  // Ended sessions leave the fleet immediately and refuse further input.
  assert.equal((await adapter.listSessions()).length, 0);
  await assert.rejects(adapter.sendInput(session.id, "x"), /Unknown PTY session/);

  adapter.stop();
});

test("spawned sessions default the no-mistakes telemetry opt-out; a user export wins", async () => {
  let spawnEnv: NodeJS.ProcessEnv | undefined;
  const spawn: SpawnPty = (_command, _args, options) => {
    spawnEnv = options.env;
    return new FakePtyProcess();
  };
  const adapter = new PtyAgentAdapter(spawn);
  const saved = process.env.NO_MISTAKES_TELEMETRY;
  try {
    delete process.env.NO_MISTAKES_TELEMETRY;
    const first = await adapter.startAgent({ command: "claude", args: [], cwd: "/tmp" });
    assert.equal(spawnEnv?.NO_MISTAKES_TELEMETRY, "0", "no-cloud posture: telemetry off by default");
    await adapter.stopSession(first.id);

    process.env.NO_MISTAKES_TELEMETRY = "1";
    await adapter.startAgent({ command: "claude", args: [], cwd: "/tmp" });
    assert.equal(spawnEnv?.NO_MISTAKES_TELEMETRY, "1", "the exported value is the re-enable knob");
  } finally {
    if (saved === undefined) delete process.env.NO_MISTAKES_TELEMETRY;
    else process.env.NO_MISTAKES_TELEMETRY = saved;
    adapter.stop();
  }
});

test("PTY adapter renders control sequences for the on-demand text path", async () => {
  let child: FakePtyProcess | undefined;
  const spawn: SpawnPty = () => {
    child = new FakePtyProcess();
    return child;
  };
  const adapter = new PtyAgentAdapter(spawn);
  const agentEvents: RecordedEvent[] = [];
  adapter.subscribeAgentEvents((event) => agentEvents.push(event));

  const session = await adapter.startAgent({
    command: "codex",
    title: "Codex"
  });

  child?.emitData("\x1b[?1049h\x1b[2J\x1b[H\x1b[31mCodex\x1b[0m");
  child?.emitData("\x1b[2;1Hready");
  await waitForRaw(agentEvents, "ready");

  // The rendered path strips control sequences; the raw path preserves them.
  const recent = await adapter.readRecentEvents(session.id, 20);
  assert.equal(recent.events[0]?.type, "terminal_output");
  const text = recent.events[0]?.type === "terminal_output" ? recent.events[0].text : "";
  assert.equal(text, "Codex\nready");
  assert.doesNotMatch(text ?? "", /\x1b|\[31m|1049/);

  adapter.stop();
});

test("PTY adapter coalesces bursts into few deltas", async () => {
  let child: FakePtyProcess | undefined;
  const spawn: SpawnPty = () => {
    child = new FakePtyProcess();
    return child;
  };
  const adapter = new PtyAgentAdapter(spawn);
  const agentEvents: RecordedEvent[] = [];
  adapter.subscribeAgentEvents((event) => agentEvents.push(event));

  await adapter.startAgent({ command: "codex", title: "Codex" });

  const chunks = 200;
  for (let index = 0; index < chunks; index += 1) {
    child?.emitData(`line ${index}\n`);
  }
  const raw = await waitForRaw(agentEvents, `line ${chunks - 1}\n`);
  assert.ok(raw.endsWith(`line ${chunks - 1}\n`));

  const outputs = agentEvents.filter((event) => event.type === "terminal_output");
  // 200 synchronous chunks must not become 200 websocket frames. Leading
  // flush + a handful of trailing flushes is the expected shape.
  assert.ok(outputs.length < 20, `expected <20 coalesced deltas, got ${outputs.length}`);

  adapter.stop();
});

test("submitInput recovers a swallowed keystroke: kill-line, retype, land once", async () => {
  // Model a TUI that is not yet interactive when the first keystroke arrives:
  // the initial write is dropped on the floor (never echoed to the screen).
  // Later writes echo normally, as a ready TUI would.
  class SwallowingPty extends FakePtyProcess {
    private swallowed = false;
    override write(data: string): void {
      this.writes.push(data);
      if (!this.swallowed) {
        // The very first keystroke is silently swallowed (no echo): the
        // failure mode the fix exists for.
        this.swallowed = true;
        return;
      }
      this.emitData(data);
    }
  }

  let child: SwallowingPty | undefined;
  const spawn: SpawnPty = () => {
    child = new SwallowingPty();
    return child;
  };
  const adapter = new PtyAgentAdapter(spawn);
  const session = await adapter.startAgent({ command: "codex", title: "Codex" });

  // A distinctive, long-enough text so verification actually runs (short
  // texts like "y"/"1" keep single-shot behavior by design).
  const text = "please wire the flux capacitor now";
  await adapter.submitInput(session.id, text);

  // The first write was swallowed, so verification missed and the adapter
  // issued a kill-line (Ctrl+U) before re-typing - idempotent recovery.
  const killLineIndex = child!.writes.indexOf("\x15");
  assert.ok(killLineIndex >= 0, "expected a kill-line (\\x15) before retype");
  // Text was typed, swallowed, then retyped after the kill-line.
  const textWrites = child!.writes.filter((write) => write === text);
  assert.equal(textWrites.length, 2, "expected the swallowed text to be retyped once");
  assert.ok(child!.writes.indexOf(text, killLineIndex) > killLineIndex, "retype must follow the kill-line");

  // Critically, Enter is pressed exactly once: the recovery re-types text but
  // never re-submits, so the agent receives the prompt a single time.
  const enters = child!.writes.filter((write) => write === "\r");
  assert.equal(enters.length, 1, "the prompt must be submitted exactly once");

  // The prompt actually landed on the rendered screen (exactly one copy).
  const snapshot = await adapter.snapshot(session.id);
  const squeezed = snapshot.data.replace(/\s+/g, "");
  const needle = text.replace(/\s+/g, "");
  const occurrences = squeezed.split(needle).length - 1;
  assert.equal(occurrences, 1, "the prompt must appear exactly once on screen");

  // Submit claims running.
  assert.equal((await adapter.listSessions())[0]?.status, "running");

  adapter.stop();
});

test("submitInput confirm barrier blocks until the marker renders (model-switch race fix)", async () => {
  // A TUI that echoes typed input immediately but only renders the slash
  // command's confirmation ("Set model to ...") after a delay - the real CLI's
  // model-switch re-render window. Without the barrier a follow-on write lands
  // during that window and is lost / runs on the old model.
  class LaggyConfirmPty extends FakePtyProcess {
    override write(data: string): void {
      this.writes.push(data);
      this.emitData(data);
      if (data === "\r") {
        // Enter submits the /model command; the CLI applies + renders the
        // confirmation a beat later, not synchronously.
        setTimeout(() => this.emitData("\nSet model to Haiku 4.5 and saved as your default"), 60);
      }
    }
  }

  let child: LaggyConfirmPty | undefined;
  const spawn: SpawnPty = () => {
    child = new LaggyConfirmPty();
    return child;
  };
  const adapter = new PtyAgentAdapter(spawn);
  const session = await adapter.startAgent({ command: "claude", title: "Claude" });

  const before = child!.writes.length;
  const landed = await adapter.submitInput(session.id, "/model haiku", {
    awaitText: "Set model to",
    awaitMs: 4000
  });

  // The submit only resolves once the confirmation is on the rendered screen,
  // so by return time the switch has visibly landed - a following message is
  // safe to type. (No confirmation would leave the marker absent and time out.)
  assert.equal(landed, true, "a rendered marker must report the switch as landed");
  const snapshot = await adapter.snapshot(session.id);
  assert.ok(snapshot.data.includes("Set model to Haiku 4.5"), "barrier must wait for the switch to render");

  // Exactly one Enter: the barrier only observes, it never re-submits.
  const enters = child!.writes.slice(before).filter((write) => write === "\r");
  assert.equal(enters.length, 1, "the barrier must not press Enter again");

  adapter.stop();
});

test("submitInput confirm barrier gives up at awaitMs when the marker never renders", async () => {
  // A marker that never appears (changed CLI copy, a hung TUI) must not hang
  // the switch forever - the barrier times out and reports the miss, so the
  // caller can refuse to claim a switch that did not happen.
  let child: FakePtyProcess | undefined;
  const spawn: SpawnPty = () => {
    child = new FakePtyProcess();
    return child;
  };
  const adapter = new PtyAgentAdapter(spawn);
  const session = await adapter.startAgent({ command: "claude", title: "Claude" });

  const started = Date.now();
  const landed = await adapter.submitInput(session.id, "/model haiku", {
    awaitText: "never appears",
    awaitMs: 300
  });
  const elapsed = Date.now() - started;
  assert.equal(landed, false, "a missing marker must report the submit as not landed");
  assert.ok(elapsed >= 300, `expected to wait out awaitMs, waited ${elapsed}ms`);
  assert.ok(elapsed < 3000, `must not hang far past awaitMs, waited ${elapsed}ms`);

  adapter.stop();
});

test("submitInput answers the CLI's confirm dialog, then waits for the switch to land", async () => {
  // claude 2.1.205 on a cached conversation: `/model <alias>` opens a yes/no
  // confirm and waits. Unanswered, the dialog swallows whatever is typed next
  // (its Enter answers the confirm), so the barrier must answer it itself.
  class ConfirmDialogPty extends FakePtyProcess {
    answered = false;
    override write(data: string): void {
      this.writes.push(data);
      if (data === "\r" && !this.answered) {
        setTimeout(() => this.emitData("\nSwitch model?\n  1. Yes, switch to Haiku 4.5\n  2. No, go back"), 40);
        return;
      }
      if (data === "1" && !this.answered) {
        this.answered = true;
        // The dialog closes and the switch lands a beat later.
        setTimeout(() => this.emitData("\x1b[2J\x1b[H\nSet model to Haiku 4.5 and saved as your default"), 40);
        return;
      }
      this.emitData(data);
    }
  }

  let child: ConfirmDialogPty | undefined;
  const spawn: SpawnPty = () => {
    child = new ConfirmDialogPty();
    return child;
  };
  const adapter = new PtyAgentAdapter(spawn);
  const session = await adapter.startAgent({ command: "claude", title: "Claude" });

  const landed = await adapter.submitInput(session.id, "/model haiku", {
    awaitText: "Set model to",
    awaitMs: 4000,
    prompt: { awaitText: "Switch model?", keys: "1" }
  });

  assert.equal(landed, true, "answering the dialog must let the marker render");
  const answers = child!.writes.filter((write) => write === "1");
  assert.equal(answers.length, 1, "the dialog must be answered exactly once");
  const enters = child!.writes.filter((write) => write === "\r");
  assert.equal(enters.length, 1, "answering must not press Enter again");

  adapter.stop();
});

test("submitInput never answers a dialog that did not open", async () => {
  // 2.1.204, and 2.1.205 on an uncached conversation, set the model directly.
  // A blind answer key would land in the composer as literal text and corrupt
  // the next message ("1ok cool"), so the answer is conditional on the dialog.
  class DirectSetPty extends FakePtyProcess {
    override write(data: string): void {
      this.writes.push(data);
      this.emitData(data);
      if (data === "\r") {
        setTimeout(() => this.emitData("\nSet model to Haiku 4.5 and saved as your default"), 40);
      }
    }
  }

  let child: DirectSetPty | undefined;
  const spawn: SpawnPty = () => {
    child = new DirectSetPty();
    return child;
  };
  const adapter = new PtyAgentAdapter(spawn);
  const session = await adapter.startAgent({ command: "claude", title: "Claude" });

  const landed = await adapter.submitInput(session.id, "/model haiku", {
    awaitText: "Set model to",
    awaitMs: 4000,
    prompt: { awaitText: "Switch model?", keys: "1" }
  });

  assert.equal(landed, true);
  assert.equal(
    child!.writes.filter((write) => write === "1").length,
    0,
    "no dialog means no answer key may be typed"
  );

  adapter.stop();
});

test("submitInput confirm barrier sees a marker behind the TUI's blank bottom-padding", async () => {
  // The real TUI anchors its input box to the bottom of the viewport and pads
  // the gap above it with blank rows - 15 of them on a short transcript. That
  // puts the marker 22 RAW lines from the bottom but only 6 content lines up,
  // so the tail window has to be counted in non-blank lines or a perfectly good
  // switch reports as "never landed".
  class PaddedPty extends FakePtyProcess {
    override write(data: string): void {
      this.writes.push(data);
      this.emitData(data);
      if (data === "\r") {
        setTimeout(() => {
          this.emitData("\r\n  Set model to Haiku 4.5 and saved as your default");
          this.emitData("\r\n".repeat(17));
          this.emitData("  high · /effort\r\n────\r\n❯\r\n────\r\n  auto mode on");
        }, 40);
      }
    }
  }

  let child: PaddedPty | undefined;
  const spawn: SpawnPty = () => {
    child = new PaddedPty();
    return child;
  };
  const adapter = new PtyAgentAdapter(spawn);
  const session = await adapter.startAgent({ command: "claude", title: "Claude" });

  const landed = await adapter.submitInput(session.id, "/model haiku", {
    awaitText: "Set model to",
    awaitMs: 4000
  });
  assert.equal(landed, true, "blank bottom-padding must not hide the marker from the barrier");

  adapter.stop();
});

test("submitInput confirm barrier ignores a marker left by an earlier switch", async () => {
  // `renderedText` returns the viewport PLUS ~1000 lines of scrollback, so a
  // "Set model to" printed by any earlier switch would satisfy the barrier on
  // its first poll - returning "landed" before the CLI has even reacted, and
  // skipping the dialog the new switch is about to raise.
  class StaleMarkerPty extends FakePtyProcess {
    override write(data: string): void {
      this.writes.push(data);
      this.emitData(data);
    }
  }

  let child: StaleMarkerPty | undefined;
  const spawn: SpawnPty = () => {
    child = new StaleMarkerPty();
    return child;
  };
  const adapter = new PtyAgentAdapter(spawn);
  const session = await adapter.startAgent({ command: "claude", title: "Claude" });

  // An earlier switch, then enough conversation to scroll it up but not out.
  child!.emitData("\nSet model to Sonnet 5 and saved as your default\n");
  for (let line = 0; line < 6; line += 1) {
    child!.emitData(`transcript line ${line}\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));

  const started = Date.now();
  const landed = await adapter.submitInput(session.id, "/model haiku", {
    awaitText: "Set model to",
    awaitMs: 500
  });

  assert.equal(landed, false, "a stale marker must not satisfy the barrier");
  assert.ok(Date.now() - started >= 500, "the barrier must wait for a NEW marker, not match the old one");

  adapter.stop();
});

async function waitForRaw(events: RecordedEvent[], suffix: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const raw = events
      .filter((event) => event.type === "terminal_output")
      .map((event) => event.raw ?? "")
      .join("");
    if (raw.includes(suffix)) {
      return raw;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return events
    .filter((event) => event.type === "terminal_output")
    .map((event) => event.raw ?? "")
    .join("");
}


test("startAgent appends the launch-time model flag after the caller's args", async () => {
  const spawns: Array<{ command: string; args: string[] }> = [];
  const spawn: SpawnPty = (command, args) => {
    spawns.push({ command, args });
    return new FakePtyProcess();
  };
  const adapter = new PtyAgentAdapter(spawn);

  await adapter.startAgent({ command: "claude", model: "opus" });
  await adapter.startAgent({ command: "codex", args: ["--search"], model: "gpt-5.5" });
  // Empty model contributes nothing (codex errors on a blank -m "").
  await adapter.startAgent({ command: "codex", model: "" });

  assert.deepEqual(spawns[0]?.args, ["--model", "opus"]);
  assert.deepEqual(spawns[1]?.args, ["--search", "-m", "gpt-5.5"]);
  assert.deepEqual(spawns[2]?.args, []);

  adapter.stop();
});

test("PTY adapter reaps dead sessions and purges them from the fleet", async () => {
  let child: FakePtyProcess | undefined;
  const spawn: SpawnPty = () => {
    child = new FakePtyProcess();
    return child;
  };
  const adapter = new PtyAgentAdapter(spawn);
  const session = await adapter.startAgent({ command: "codex", title: "Codex" });

  // Simulate a missed onExit: process gone (impossible pid), no exit event.
  if (child) {
    child.pid = 9_999_999;
  }
  const sessions = await adapter.listSessions();
  assert.equal(sessions.length, 0);
  // The record is gone with the process; all operations are refused.
  await assert.rejects(adapter.snapshot(session.id), /Unknown PTY session/);
  await assert.rejects(adapter.sendInput(session.id, "x"), /Unknown PTY session/);

  adapter.stop();
});

test("PTY adapter stopSession kills the process and marks the session done", async () => {
  let child: FakePtyProcess | undefined;
  const spawn: SpawnPty = () => {
    child = new FakePtyProcess();
    return child;
  };
  const adapter = new PtyAgentAdapter(spawn);
  const events: RecordedEvent[] = [];
  const fleetEvents: Array<{ kind: string; sessionId?: string; name?: string }> = [];
  adapter.subscribeAgentEvents((event) => events.push(event));
  adapter.subscribeFleetEvents((event) => fleetEvents.push(event));

  const session = await adapter.startAgent({ command: "codex", title: "Codex" });
  await adapter.stopSession(session.id);

  assert.equal(child?.killed, true);
  assert.equal(events.at(-1)?.type, "status");
  assert.equal(events.at(-1)?.status, "done");

  // The row disappears immediately: the record is purged with the exit and
  // the fleet is told, so clients drop it without waiting for a reconcile.
  assert.equal((await adapter.listSessions()).length, 0);
  const purged = fleetEvents.at(-1);
  assert.equal(purged?.kind, "topology");
  assert.equal(purged?.sessionId, session.id);
  assert.equal(purged?.name, "pty.session.purged");
  await assert.rejects(adapter.stopSession(session.id), /Unknown PTY session/);

  adapter.stop();
});
