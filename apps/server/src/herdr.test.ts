import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSessionStatus, StartAgentRequest } from "@perch/shared";
import {
  CliHerdrTransport,
  HerdrClaudeAdapter,
  HerdrUnavailableError,
  HerdrWorkerIntegration,
  type HerdrCompatibility,
  type HerdrPaneIdentity,
  type HerdrTransport
} from "./herdr.js";
import { FleetSettings, type HerdrSettings } from "./settings.js";
import { StateDb } from "./stateDb.js";

class FakeHerdrTransport implements HerdrTransport {
  compatibilityValue: HerdrCompatibility = { available: true, compatible: true, version: "0.7.4", protocol: 16 };
  readonly panes = new Map<string, HerdrPaneIdentity>();
  readonly starts: Array<{ name: string; command: string; args: string[]; env: Record<string, string> }> = [];
  readonly sent: Array<{ paneId: string; text: string }> = [];
  readonly keys: Array<{ paneId: string; keys: string[] }> = [];
  readonly closed: string[] = [];
  readonly reports: Array<{ paneId: string; state: string }> = [];

  async compatibility(): Promise<HerdrCompatibility> {
    return this.compatibilityValue;
  }

  async installIntegration(): Promise<void> {}

  async startAgent(input: { name: string; cwd: string; command: string; args: string[]; env: Record<string, string> }): Promise<HerdrPaneIdentity> {
    this.starts.push(input);
    const index = this.starts.length;
    const identity = { workspaceId: `w${index}`, tabId: `w${index}:t1`, paneId: `w${index}:p1`, terminalId: `term_${index}` };
    this.panes.set(identity.paneId, identity);
    return identity;
  }

  async pane(paneId: string): Promise<HerdrPaneIdentity | undefined> {
    return this.panes.get(paneId);
  }

  async readPane(paneId: string): Promise<string> {
    return `output from ${paneId}`;
  }

  async sendText(paneId: string, text: string): Promise<void> {
    this.sent.push({ paneId, text });
  }

  async sendKeys(paneId: string, ...keys: string[]): Promise<void> {
    this.keys.push({ paneId, keys });
  }

  async closePane(paneId: string): Promise<void> {
    this.closed.push(paneId);
    this.panes.delete(paneId);
  }

  async reportConsoleAgent(paneId: string, state: "idle" | "working" | "blocked" | "unknown"): Promise<void> {
    this.reports.push({ paneId, state });
  }
}

function harness(config: HerdrSettings = { enabled: true, providers: { claude: true, codex: true } }) {
  const home = mkdtempSync(join(tmpdir(), "perch-herdr-"));
  const db = new StateDb({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const transport = new FakeHerdrTransport();
  const integration = new HerdrWorkerIntegration(
    db.herdrWorkerPanes,
    () => config,
    transport,
    (sessionId) => ({ command: process.execPath, args: ["perch", "herdr", "console", "--session", sessionId], env: {} })
  );
  return {
    db,
    transport,
    integration,
    close: () => {
      db.close();
      rmSync(home, { recursive: true, force: true });
    }
  };
}

function claudeRequest(sessionId = "pty:claude-worker"): StartAgentRequest {
  return {
    command: "claude",
    agent: "claude",
    sessionId,
    cwd: "/tmp/project",
    title: "Sensitive task title must not become metadata",
    labels: { task: "task-1", workerName: "Birch" },
    model: "opus"
  };
}

test("public Herdr CLI transport starts no-focus panes and treats structured missing-pane errors as absent", async () => {
  const calls: string[][] = [];
  const transport = new CliHerdrTransport("herdr", async (_command, args) => {
    calls.push(args);
    if (args[0] === "agent") {
      return JSON.stringify({
        id: "cli:agent:start",
        result: {
          agent: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", terminal_id: "term_1" }
        }
      });
    }
    if (args[0] === "pane" && args[1] === "get") {
      return JSON.stringify({ error: { code: "pane_not_found", message: "pane w1:p1 not found" } });
    }
    if (args[0] === "pane" && args[1] === "read") return "live terminal output";
    return JSON.stringify({ id: "cli:ok", result: { type: "ok" } });
  });

  const identity = await transport.startAgent({
    name: "Perch worker",
    cwd: "/tmp/project",
    command: "claude",
    args: ["--model", "opus"],
    env: { PERCH_SESSION_ID: "pty:worker" }
  });
  assert.deepEqual(identity, { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", terminalId: "term_1" });
  assert.deepEqual(calls[0], [
    "agent", "start", "Perch worker", "--cwd", "/tmp/project", "--no-focus",
    "--env", "PERCH_SESSION_ID=pty:worker", "--", "claude", "--model", "opus"
  ]);
  assert.equal(await transport.pane("w1:p1"), undefined);
  assert.equal(await transport.readPane("w1:p1", 20), "live terminal output");
});

test("Claude launches in one real no-focus Herdr pane and forwards terminal input", async () => {
  const h = harness();
  const exits: string[] = [];
  const adapter = new HerdrClaudeAdapter(h.integration, {
    sessionEnv: () => ({ PERCH_HOOK_TOKEN: "secret", PERCH_SESSION_ID: "pty:claude-worker" }),
    taskIdForSession: () => undefined,
    onSessionExit: (sessionId) => exits.push(sessionId)
  });
  try {
    const session = await adapter.startAgent(claudeRequest());
    assert.equal(h.transport.starts.length, 1);
    assert.equal(h.transport.starts[0]?.command, "claude");
    assert.deepEqual(h.transport.starts[0]?.args, ["--model", "opus"]);
    assert.equal(session.paneId, "w1:p1");
    assert.equal(h.db.herdrWorkerPanes.find(session.id)?.taskId, undefined);
    assert.equal(h.db.herdrWorkerPanes.find(session.id)?.presentationKind, "provider");

    await adapter.sendInput(session.id, "continue");
    await adapter.sendEnter(session.id);
    assert.deepEqual(h.transport.sent, [{ paneId: "w1:p1", text: "continue" }]);
    assert.deepEqual(h.transport.keys, [{ paneId: "w1:p1", keys: ["ENTER"] }]);

    await adapter.stopSession(session.id);
    assert.deepEqual(h.transport.closed, ["w1:p1"]);
    assert.equal(h.db.herdrWorkerPanes.find(session.id)?.state, "closed");
    assert.deepEqual(exits, [session.id]);
  } finally {
    h.close();
  }
});

test("reconnect reuses the exact persisted pane and missing panes become stale without duplicates", async () => {
  const h = harness();
  try {
    const record = await h.integration.startClaude(claudeRequest(), { PERCH_HOOK_TOKEN: "secret" });
    const reconnect = await h.integration.reconnect();
    assert.deepEqual(reconnect.connected.map((entry) => entry.paneId), [record.paneId]);
    assert.equal(h.transport.starts.length, 1, "restart reconnect must not create another pane");

    h.transport.panes.delete(record.paneId);
    const stale = await h.integration.reconnect();
    assert.deepEqual(stale.stale.map((entry) => entry.perchSessionId), [record.perchSessionId]);
    assert.equal(h.db.herdrWorkerPanes.find(record.perchSessionId)?.state, "stale");
    assert.equal(h.transport.starts.length, 1, "a missing pane is safe stale state, not a duplicate launch");
  } finally {
    h.close();
  }
});

test("Codex gets a labeled Perch console, status mapping, and never a Codex command", async () => {
  const h = harness();
  try {
    const record = await h.integration.ensureCodexConsole({
      sessionId: "pty:codex-worker",
      workerName: "Cedar",
      cwd: "/tmp/project"
    });
    assert.ok(record);
    assert.equal(record?.presentationKind, "console");
    assert.equal(h.transport.starts.length, 1);
    assert.equal(h.transport.starts[0]?.command, process.execPath);
    assert.ok(h.transport.starts[0]?.args.includes("console"));
    assert.equal(h.transport.starts[0]?.command.includes("codex"), false, "no second Codex TUI may launch");
    assert.equal(h.transport.starts[0]?.args.includes("codex"), false, "console arguments must not launch Codex");

    await h.integration.syncCodexStatus("pty:codex-worker", "running" as AgentSessionStatus);
    await h.integration.syncCodexStatus("pty:codex-worker", "needs_approval" as AgentSessionStatus);
    assert.deepEqual(h.transport.reports.map((entry) => entry.state), ["working", "working", "blocked"]);
    assert.ok(h.transport.reports.every((entry) => entry.paneId === record?.paneId));
  } finally {
    h.close();
  }
});

test("disabled and unavailable Herdr are safe fallbacks", async () => {
  const disabled = harness({ enabled: false, providers: { claude: true, codex: true } });
  try {
    await assert.rejects(
      disabled.integration.startClaude(claudeRequest(), { PERCH_HOOK_TOKEN: "secret" }),
      HerdrUnavailableError
    );
    assert.equal(await disabled.integration.ensureCodexConsole({ sessionId: "pty:codex", cwd: "/tmp/project" }), undefined);
    assert.equal(disabled.transport.starts.length, 0);
  } finally {
    disabled.close();
  }

  const unavailable = harness();
  try {
    unavailable.transport.compatibilityValue = { available: false, compatible: false, reason: "Herdr CLI is not installed" };
    await assert.rejects(
      unavailable.integration.startClaude(claudeRequest(), { PERCH_HOOK_TOKEN: "secret" }),
      HerdrUnavailableError
    );
    assert.equal(await unavailable.integration.ensureCodexConsole({ sessionId: "pty:codex", cwd: "/tmp/project" }), undefined);
    assert.equal(unavailable.transport.starts.length, 0);
  } finally {
    unavailable.close();
  }
});

test("Herdr settings persist opt-in state and reject unimplemented Cursor", () => {
  const home = mkdtempSync(join(tmpdir(), "perch-herdr-settings-"));
  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  try {
    const settings = new FleetSettings(env);
    assert.deepEqual(settings.herdr(), {
      enabled: false,
      providers: { claude: false, codex: false, cursor: false }
    });
    settings.updateHerdr({ enabled: true, providers: { claude: true, codex: true } });
    assert.deepEqual(new FleetSettings(env).herdr(), {
      enabled: true,
      providers: { claude: true, codex: true, cursor: false }
    });
    assert.throws(() => settings.updateHerdr({ providers: { cursor: true } }), /not implemented/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
