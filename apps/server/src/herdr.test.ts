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
  type HerdrTabIdentity,
  type HerdrTransport
} from "./herdr.js";
import { FleetSettings, type HerdrSettings } from "./settings.js";
import { StateDb } from "./stateDb.js";
import { TaskStore } from "./tasks.js";

class FakeHerdrTransport implements HerdrTransport {
  compatibilityValue: HerdrCompatibility = { available: true, compatible: true, version: "0.7.4", protocol: 16 };
  readonly panes = new Map<string, HerdrPaneIdentity>();
  readonly tabs = new Map<string, HerdrTabIdentity>();
  readonly createdTabs: Array<{ name: string; cwd: string; env: Record<string, string> }> = [];
  readonly paneRuns: Array<{ paneId: string; command: string }> = [];
  readonly sent: Array<{ paneId: string; text: string }> = [];
  readonly keys: Array<{ paneId: string; keys: string[] }> = [];
  readonly closed: string[] = [];
  readonly closedTabs: string[] = [];
  readonly reports: Array<{ paneId: string; state: string }> = [];

  async compatibility(): Promise<HerdrCompatibility> {
    return this.compatibilityValue;
  }

  async installIntegration(): Promise<void> {}

  async createWorkerTab(input: { name: string; cwd: string; env: Record<string, string> }): Promise<HerdrPaneIdentity> {
    this.createdTabs.push(input);
    const index = this.createdTabs.length;
    const identity = {
      workspaceId: "mate-w1",
      tabId: `mate-w1:t${index}`,
      paneId: `mate-w1:p${index}`,
      terminalId: `term_${index}`
    };
    this.panes.set(identity.paneId, identity);
    this.tabs.set(identity.tabId, { workspaceId: identity.workspaceId, tabId: identity.tabId, paneCount: 1 });
    return identity;
  }

  async runPane(paneId: string, command: string): Promise<void> {
    if (!this.panes.has(paneId)) throw new Error(`pane ${paneId} not found`);
    this.paneRuns.push({ paneId, command });
  }

  async pane(paneId: string): Promise<HerdrPaneIdentity | undefined> {
    return this.panes.get(paneId);
  }

  async tab(tabId: string): Promise<HerdrTabIdentity | undefined> {
    return this.tabs.get(tabId);
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
    const pane = this.panes.get(paneId);
    if (pane) {
      const tab = this.tabs.get(pane.tabId);
      if (tab?.paneCount) tab.paneCount -= 1;
    }
    this.panes.delete(paneId);
  }

  async closeTab(tabId: string): Promise<void> {
    this.closedTabs.push(tabId);
    for (const [paneId, pane] of this.panes) {
      if (pane.tabId === tabId) this.panes.delete(paneId);
    }
    this.tabs.delete(tabId);
  }

  async reportConsoleAgent(paneId: string, state: "idle" | "working" | "blocked" | "unknown"): Promise<void> {
    if (!this.panes.has(paneId)) throw new Error(`pane ${paneId} not found`);
    this.reports.push({ paneId, state });
  }

  addUnrelatedPane(tabId: string): string {
    const tab = this.tabs.get(tabId);
    assert.ok(tab, `missing tab ${tabId}`);
    const paneId = `${tab.workspaceId}:unrelated-${this.panes.size + 1}`;
    this.panes.set(paneId, {
      workspaceId: tab.workspaceId,
      tabId,
      paneId,
      terminalId: `term_extra_${this.panes.size + 1}`
    });
    tab.paneCount = (tab.paneCount ?? 0) + 1;
    return paneId;
  }
}

function harness(config: HerdrSettings = { enabled: true, providers: { claude: true, codex: true } }) {
  const home = mkdtempSync(join(tmpdir(), "perch-herdr-"));
  const db = new StateDb({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const transport = new FakeHerdrTransport();
  const integration = new HerdrWorkerIntegration(
    db.herdrWorkerPanes,
    () => config,
    transport,
    (sessionId) => ({ command: process.execPath, args: ["perch", "herdr", "console", "--session", sessionId], env: {} })
  );
  return {
    db,
    tasks,
    transport,
    integration,
    close: () => {
      tasks.close();
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

test("public Herdr CLI transport creates an unfocused one-root-pane tab and treats structured missing identities as absent", async () => {
  assert.doesNotThrow(() => new CliHerdrTransport(), "the default public-CLI runner must initialize at server boot");
  const calls: string[][] = [];
  const transport = new CliHerdrTransport("herdr", async (_command, args) => {
    calls.push(args);
    if (args[0] === "tab" && args[1] === "create") {
      return JSON.stringify({
        id: "cli:tab:create",
        result: {
          root_pane: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", terminal_id: "term_1" },
          tab: { workspace_id: "w1", tab_id: "w1:t1", pane_count: 1 }
        }
      });
    }
    if (args[0] === "pane" && args[1] === "get") {
      return JSON.stringify({ error: { code: "pane_not_found", message: "pane w1:p1 not found" } });
    }
    if (args[0] === "tab" && args[1] === "get") {
      return JSON.stringify({ result: { tab: { workspace_id: "w1", tab_id: "w1:t1", pane_count: 1 } } });
    }
    if (args[0] === "pane" && args[1] === "read") return "live terminal output";
    return JSON.stringify({ id: "cli:ok", result: { type: "ok" } });
  });

  const identity = await transport.createWorkerTab({
    name: "Perch worker",
    cwd: "/tmp/project",
    env: { PERCH_SESSION_ID: "pty:worker" }
  });
  assert.deepEqual(identity, { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", terminalId: "term_1" });
  assert.deepEqual(calls[0], [
    "tab", "create", "--cwd", "/tmp/project", "--label", "Perch worker", "--no-focus",
    "--env", "PERCH_SESSION_ID=pty:worker"
  ]);
  await transport.runPane("w1:p1", "'claude' '--model' 'opus'");
  assert.deepEqual(calls[1], ["pane", "run", "w1:p1", "'claude' '--model' 'opus'"]);
  assert.deepEqual(await transport.tab("w1:t1"), { workspaceId: "w1", tabId: "w1:t1", paneCount: 1 });
  assert.equal(await transport.pane("w1:p1"), undefined);
  assert.equal(await transport.readPane("w1:p1", 20), "live terminal output");
});

test("Claude launches in one real no-focus Herdr tab root pane and forwards terminal input", async () => {
  const h = harness();
  const exits: string[] = [];
  const adapter = new HerdrClaudeAdapter(h.integration, {
    sessionEnv: () => ({ PERCH_HOOK_TOKEN: "secret", PERCH_SESSION_ID: "pty:claude-worker" }),
    taskIdForSession: () => undefined,
    onSessionExit: (sessionId) => exits.push(sessionId)
  });
  try {
    const session = await adapter.startAgent(claudeRequest());
    assert.equal(h.transport.createdTabs.length, 1);
    assert.match(h.transport.createdTabs[0]?.name ?? "", /^Birch - task task-1$/);
    assert.deepEqual(h.transport.paneRuns, [{ paneId: "mate-w1:p1", command: "'claude' '--model' 'opus'" }]);
    assert.equal(session.paneId, "mate-w1:p1");
    assert.equal(h.db.herdrWorkerPanes.find(session.id)?.taskId, undefined);
    assert.equal(h.db.herdrWorkerPanes.find(session.id)?.presentationKind, "provider");

    await adapter.sendInput(session.id, "continue");
    await adapter.sendEnter(session.id);
    assert.deepEqual(h.transport.sent, [{ paneId: "mate-w1:p1", text: "continue" }]);
    assert.deepEqual(h.transport.keys, [{ paneId: "mate-w1:p1", keys: ["ENTER"] }]);

    await adapter.stopSession(session.id);
    assert.deepEqual(h.transport.closedTabs, ["mate-w1:t1"]);
    assert.equal(h.db.herdrWorkerPanes.find(session.id)?.state, "closed");
    assert.deepEqual(exits, [session.id]);
  } finally {
    h.close();
  }
});

test("reconnect reuses the exact persisted tab and pane and missing panes become stale without duplicates", async () => {
  const h = harness();
  try {
    const record = await h.integration.startClaude(claudeRequest(), { PERCH_HOOK_TOKEN: "secret" });
    const reconnect = await h.integration.reconnect();
    assert.deepEqual(reconnect.connected.map((entry) => entry.paneId), [record.paneId]);
    assert.equal(h.transport.createdTabs.length, 1, "restart reconnect must not create another tab");

    h.transport.panes.delete(record.paneId);
    const stale = await h.integration.reconnect();
    assert.deepEqual(stale.stale.map((entry) => entry.perchSessionId), [record.perchSessionId]);
    assert.equal(h.db.herdrWorkerPanes.find(record.perchSessionId)?.state, "stale");
    assert.equal(h.transport.createdTabs.length, 1, "a missing pane is safe stale state, not a duplicate launch");
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
    assert.equal(record.presentationKind, "console");
    assert.match(h.transport.createdTabs[0]?.name ?? "", /^Cedar - session codex-worker$/);
    assert.equal(h.transport.paneRuns[0]?.command.includes("'codex'"), false, "no second Codex TUI may launch");
    assert.match(h.transport.paneRuns[0]?.command ?? "", /'perch' 'herdr' 'console'/);

    await h.integration.syncCodexStatus("pty:codex-worker", "running" as AgentSessionStatus);
    await h.integration.syncCodexStatus("pty:codex-worker", "needs_approval" as AgentSessionStatus);
    assert.deepEqual(h.transport.reports.map((entry) => entry.state), ["working", "working", "blocked"]);
    assert.ok(h.transport.reports.every((entry) => entry.paneId === record.paneId));
  } finally {
    h.close();
  }
});

test("multiple workers get sibling tabs and teardown closes only their durable worker surface", async () => {
  const h = harness();
  try {
    const claudeTask = h.tasks.create({ title: "Claude tab task", project: "/tmp/project" });
    const codexTask = h.tasks.create({ title: "Codex tab task", project: "/tmp/project" });
    const request = claudeRequest("pty:claude-a");
    request.labels = { ...request.labels, task: claudeTask.id };
    const claude = await h.integration.startClaude(request, { PERCH_HOOK_TOKEN: "secret" }, claudeTask.id);
    const codex = await h.integration.ensureCodexConsole({
      sessionId: "pty:codex-b",
      taskId: codexTask.id,
      workerName: "Cedar",
      cwd: "/tmp/project"
    });
    assert.ok(codex);
    assert.deepEqual(h.transport.createdTabs.map((entry) => entry.name), [
      `Birch - task ${claudeTask.id}`,
      `Cedar - task ${codexTask.id}`
    ]);
    assert.deepEqual([...h.transport.tabs.values()].map((tab) => tab.paneCount), [1, 1]);
    assert.notEqual(claude.tabId, codex.tabId);
    assert.equal(claude.workspaceId, codex.workspaceId, "each new worker uses the same current Mate workspace");

    const unrelatedPane = h.transport.addUnrelatedPane(codex.tabId);
    await h.integration.close(claude.perchSessionId);
    await h.integration.close(codex.perchSessionId);

    assert.deepEqual(h.transport.closedTabs, [claude.tabId], "the single-root worker tab is safe to close as a tab");
    assert.deepEqual(h.transport.closed, [codex.paneId], "a tab containing another pane closes only the stored worker pane");
    assert.ok(h.transport.panes.has(unrelatedPane), "unrelated panes survive worker cleanup");
  } finally {
    h.close();
  }
});

test("a missing Codex console becomes stale presentation without changing the worker lifecycle or creating a duplicate", async () => {
  const h = harness();
  try {
    const task = h.tasks.create({ title: "Working console task", project: "/tmp/project" });
    const record = await h.integration.ensureCodexConsole({
      sessionId: "pty:codex-working",
      taskId: task.id,
      workerName: "Dune",
      cwd: "/tmp/project"
    });
    assert.ok(record);
    h.transport.panes.delete(record.paneId);

    await h.integration.syncCodexStatus(record.perchSessionId, "running");

    assert.equal(h.db.herdrWorkerPanes.find(record.perchSessionId)?.state, "stale");
    assert.equal(h.transport.createdTabs.length, 1, "a still-working task never gets a duplicate replacement console");
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
    assert.equal(disabled.transport.createdTabs.length, 0);
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
    assert.equal(unavailable.transport.createdTabs.length, 0);
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
