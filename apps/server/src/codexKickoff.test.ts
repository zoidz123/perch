import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession, RecentEventsResult, StartAgentRequest } from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import { CodexRpcError } from "./adapters/codexAppServer.js";
import {
  CodexDeliveryUnknownError,
  type CodexAppServerAdapter
} from "./adapters/codexAppServerAdapter.js";
import { FakeCodexOwnedAdapter } from "./adapters/fakeCodexAppServer.js";
import {
  CLAUDE_KICKOFF_ARG_MAX_BYTES,
  codexKickoffClientMessageId,
  reconcileCodexKickoff,
  startManagedAgent,
  submitCodexKickoff
} from "./agentLauncher.js";
import { AuditLog } from "./audit.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { HookRegistry } from "./hooks.js";
import { ProjectRegistry } from "./projects.js";
import { TaskStore } from "./tasks.js";
import { TimelineStore } from "./timeline.js";
import { WorktreePool } from "./worktrees.js";

// The delivery contract for a dispatched Codex worker's kickoff, after the
// PTY watchdog's removal: the kickoff is one acknowledged turn/start; intent
// (`kickoff_submitted`) is journaled durably BEFORE the send and acceptance
// (`kickoff_accepted`, with the provider turn id) only after a successful
// response or history reconciliation; a rejection or unknown outcome parks
// the task truthfully; and NOTHING is ever typed into a PTY.

// A PTY backend that records every submission attempt; the regression
// assertions require these stay empty on every Codex path.
class PtySpyAdapter implements AgentAdapter {
  readonly name = "pty-spy";
  requests: StartAgentRequest[] = [];
  ptyWrites: string[] = [];
  async getTopology() {
    return { windows: [], generatedAt: "" };
  }
  async listSessions(): Promise<AgentSession[]> {
    return [];
  }
  async readRecentEvents(): Promise<RecentEventsResult> {
    return { events: [], terminal: true };
  }
  async sendInput(_sessionId: string, text: string): Promise<void> {
    this.ptyWrites.push(text);
  }
  async sendEnter(): Promise<void> {
    this.ptyWrites.push("<enter>");
  }
  async submitInput(_sessionId: string, text: string): Promise<boolean> {
    this.ptyWrites.push(text);
    return true;
  }
  async interrupt(): Promise<void> {}
  async startAgent(request: StartAgentRequest): Promise<AgentSession> {
    this.requests.push({ ...request, args: request.args ? [...request.args] : undefined });
    return {
      id: request.sessionId ?? "pty:spy",
      title: request.title ?? request.command,
      agent: request.agent ?? "claude",
      cwd: request.cwd,
      kind: "terminal",
      status: "running",
      lastActivityAt: new Date().toISOString()
    };
  }
}

function fixture(prefix: string) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  const pty = new PtySpyAdapter();
  const codexOwned = new FakeCodexOwnedAdapter();
  const tasks = new TaskStore(env);
  const monitor = new FleetMonitor(pty, { broadcastMs: 5 });
  const queuedInitialPrompts: string[] = [];
  const originalQueueInitial = monitor.queueInitialPrompt.bind(monitor);
  monitor.queueInitialPrompt = (sessionId: string, text: string) => {
    queuedInitialPrompts.push(text);
    originalQueueInitial(sessionId, text);
  };
  const timeline = new TimelineStore();
  const task = tasks.create({ title: "kickoff", project: home });
  const sessionId = "pty:owned-session";
  tasks.update(task.id, { sessionId });
  return {
    home,
    pty,
    codexOwned,
    tasks,
    monitor,
    timeline,
    queuedInitialPrompts,
    taskId: task.id,
    sessionId,
    deps: { tasks, codexOwned: codexOwned as unknown as CodexAppServerAdapter },
    launcherOptions: () => ({
      adapter: pty,
      auditLog: new AuditLog(join(home, "audit.jsonl")),
      monitor,
      projects: new ProjectRegistry(env),
      worktrees: new WorktreePool({ env }),
      hooks: new HookRegistry(),
      timeline,
      tasks,
      port: 0,
      codexOwned: codexOwned as unknown as CodexAppServerAdapter
    }),
    close: () => {
      monitor.stop();
      timeline.stop();
      tasks.close();
      rmSync(home, { recursive: true, force: true });
    }
  };
}

function reasons(f: ReturnType<typeof fixture>): Array<string | undefined> {
  return f.tasks.events(f.taskId).map((event) => event.data?.reason as string | undefined);
}

test("kickoff success journals intent before the send and the accepted turn id after it", async () => {
  const f = fixture("perch-kick-ok-");
  try {
    await f.codexOwned.startOwned({ sessionId: f.sessionId });
    await submitCodexKickoff(f.deps, f.sessionId, f.taskId, "go build it");
    const events = f.tasks.events(f.taskId);
    const submitted = events.find((event) => event.data?.reason === "kickoff_submitted");
    const accepted = events.find((event) => event.data?.reason === "kickoff_accepted");
    assert.ok(submitted && accepted);
    assert.ok(submitted!.seq < accepted!.seq, "intent lands before acceptance");
    assert.equal(submitted?.data?.clientUserMessageId, codexKickoffClientMessageId(f.taskId));
    assert.equal(accepted?.data?.turnId, "turn-fake-1");
    // Exactly one acknowledged submission; nothing typed into any PTY.
    assert.equal(f.codexOwned.submitted.length, 1);
    assert.deepEqual(f.pty.ptyWrites, []);
    assert.equal(f.tasks.find(f.taskId)?.state, "working");
  } finally {
    f.close();
  }
});

test("a kickoff is not sent when its durable intent cannot be recorded", async () => {
  const f = fixture("perch-kick-ledger-fail-");
  try {
    await f.codexOwned.startOwned({ sessionId: f.sessionId });
    f.tasks.recordEvent = (() => {
      throw new Error("ledger unavailable");
    }) as typeof f.tasks.recordEvent;
    await assert.rejects(
      submitCodexKickoff(f.deps, f.sessionId, f.taskId, "go build it"),
      /ledger unavailable/
    );
    assert.equal(f.codexOwned.submitted.length, 0);
  } finally {
    f.close();
  }
});

test("a managed launch fails and stops its worker when kickoff intent cannot be recorded", async () => {
  const f = fixture("perch-launch-ledger-fail-");
  try {
    f.tasks.recordEvent = (() => {
      throw new Error("ledger unavailable");
    }) as typeof f.tasks.recordEvent;
    await assert.rejects(
      startManagedAgent(f.launcherOptions(), {
        request: {
          command: "codex",
          agent: "codex",
          sessionId: f.sessionId,
          cwd: f.home,
          initialPrompt: "go build it"
        },
        taskId: f.taskId,
        initialPromptSource: "agent"
      }),
      /ledger unavailable/
    );
    assert.equal(f.codexOwned.submitted.length, 0);
    assert.deepEqual(f.codexOwned.stopped, [f.sessionId]);
  } finally {
    f.close();
  }
});

test("a rejected kickoff parks the task blocked with the provider's real error and never retries", async () => {
  const f = fixture("perch-kick-reject-");
  try {
    await f.codexOwned.startOwned({ sessionId: f.sessionId });
    f.codexOwned.nextSubmitError = new CodexRpcError("turn/start", "model not available", -32001);
    await submitCodexKickoff(f.deps, f.sessionId, f.taskId, "go build it");
    const blocked = f.tasks.events(f.taskId).find((event) => event.kind === "blocked");
    assert.equal(blocked?.data?.reason, "kickoff_rejected");
    assert.equal(blocked?.data?.code, -32001);
    assert.match(blocked?.message ?? "", /model not available \(code=-32001\)/);
    assert.equal(f.tasks.find(f.taskId)?.state, "blocked");
    // No retry of any kind - not over the protocol, not over a PTY.
    assert.equal(f.codexOwned.submitted.length, 0);
    assert.deepEqual(f.pty.ptyWrites, []);
  } finally {
    f.close();
  }
});

test("an unknown kickoff outcome parks the task truthfully as unknown, never resent", async () => {
  const f = fixture("perch-kick-unknown-");
  try {
    await f.codexOwned.startOwned({ sessionId: f.sessionId });
    f.codexOwned.nextSubmitError = new CodexDeliveryUnknownError(
      "input delivery is unknown: the codex app-server connection was lost and could not be re-established; not resent"
    );
    await submitCodexKickoff(f.deps, f.sessionId, f.taskId, "go build it");
    const blocked = f.tasks.events(f.taskId).find((event) => event.kind === "blocked");
    assert.equal(blocked?.data?.reason, "kickoff_unknown");
    assert.match(blocked?.message ?? "", /not resent/);
    assert.deepEqual(f.pty.ptyWrites, []);
  } finally {
    f.close();
  }
});

// Restart boundary: the previous life journaled kickoff_submitted, then died
// before persisting the outcome. History decides - never a blind resend.
function journalSubmitted(f: ReturnType<typeof fixture>): void {
  f.tasks.recordEvent(f.taskId, {
    kind: "note",
    source: "system",
    message: "codex kickoff submitted over the app-server protocol; acceptance pending",
    data: {
      reason: "kickoff_submitted",
      sessionId: f.sessionId,
      clientUserMessageId: codexKickoffClientMessageId(f.taskId)
    }
  });
}

function recordDispatchOperation(f: ReturnType<typeof fixture>, kickoff: string): void {
  f.tasks.stateDb.operations.create({
    taskId: f.taskId,
    kind: "dispatch",
    idempotencyKey: `dispatch:${f.taskId}`,
    payload: {
      prepared: {
        request: {
          command: "codex",
          agent: "codex",
          sessionId: f.sessionId,
          cwd: f.home,
          labels: { task: f.taskId },
          initialPrompt: kickoff
        },
        leaseId: "wt-1"
      },
      launchStarted: true
    }
  });
}

test("restart reconciliation: history contains the kickoff -> accepted is journaled, nothing resent", async () => {
  const f = fixture("perch-kick-restart-found-");
  try {
    await f.codexOwned.startOwned({ sessionId: f.sessionId });
    journalSubmitted(f);
    f.codexOwned.history.set(codexKickoffClientMessageId(f.taskId), { id: "turn-historic" });
    await reconcileCodexKickoff(f.deps, f.sessionId, f.taskId);
    const accepted = f.tasks.events(f.taskId).find((event) => event.data?.reason === "kickoff_accepted");
    assert.equal(accepted?.data?.turnId, "turn-historic");
    assert.equal(accepted?.data?.reconciled, true);
    assert.equal(f.codexOwned.submitted.length, 0, "an accepted kickoff is never resent");
    assert.deepEqual(f.pty.ptyWrites, []);
  } finally {
    f.close();
  }
});

test("restart reconciliation: history proves absence -> the exact kickoff is resubmitted once with the same id", async () => {
  const f = fixture("perch-kick-restart-absent-");
  try {
    await f.codexOwned.startOwned({ sessionId: f.sessionId });
    journalSubmitted(f);
    recordDispatchOperation(f, "the exact original kickoff");
    await reconcileCodexKickoff(f.deps, f.sessionId, f.taskId);
    assert.equal(f.codexOwned.submitted.length, 1);
    assert.equal(f.codexOwned.submitted[0]?.text, "the exact original kickoff");
    assert.equal(f.codexOwned.submitted[0]?.clientUserMessageId, codexKickoffClientMessageId(f.taskId));
    const accepted = f.tasks.events(f.taskId).find((event) => event.data?.reason === "kickoff_accepted");
    assert.ok(accepted);
    assert.deepEqual(f.pty.ptyWrites, []);
  } finally {
    f.close();
  }
});

test("restart reconciliation: unreadable history parks the task blocked as unknown", async () => {
  const f = fixture("perch-kick-restart-unread-");
  try {
    await f.codexOwned.startOwned({ sessionId: f.sessionId });
    journalSubmitted(f);
    f.codexOwned.historyReadError = new Error("thread/read timed out after 30000ms");
    await reconcileCodexKickoff(f.deps, f.sessionId, f.taskId);
    const blocked = f.tasks.events(f.taskId).find((event) => event.kind === "blocked");
    assert.equal(blocked?.data?.reason, "kickoff_unknown");
    assert.match(blocked?.message ?? "", /not resent/);
    assert.equal(f.codexOwned.submitted.length, 0);
  } finally {
    f.close();
  }
});

test("restart reconciliation is a no-op when acceptance is already journaled", async () => {
  const f = fixture("perch-kick-restart-done-");
  try {
    await f.codexOwned.startOwned({ sessionId: f.sessionId });
    journalSubmitted(f);
    f.tasks.recordEvent(f.taskId, {
      kind: "note",
      source: "system",
      message: "codex accepted the kickoff turn",
      data: { reason: "kickoff_accepted", sessionId: f.sessionId, turnId: "turn-1" }
    });
    await reconcileCodexKickoff(f.deps, f.sessionId, f.taskId);
    assert.equal(f.codexOwned.submitted.length, 0);
    assert.equal(reasons(f).filter((reason) => reason === "kickoff_accepted").length, 1);
  } finally {
    f.close();
  }
});

test("REGRESSION: a Codex dispatch launch reaches no PTY submission path at all", async () => {
  const f = fixture("perch-kick-nopty-");
  try {
    const result = await startManagedAgent(f.launcherOptions(), {
      request: {
        command: "codex",
        agent: "codex",
        sessionId: f.sessionId,
        cwd: f.home,
        labels: { task: f.taskId },
        initialPrompt: "codex kickoff brief"
      },
      taskId: f.taskId,
      initialPromptSource: "agent"
    });
    assert.equal(result.session.id, f.sessionId);
    // The owning adapter got the launch and the acknowledged kickoff...
    assert.equal(f.codexOwned.launches.length, 1);
    assert.equal(f.codexOwned.submitted.length, 1);
    // ...and no Codex byte ever touched a PTY: no spawn, no typed prompt, no
    // queued initial prompt, no Enter.
    assert.deepEqual(f.pty.requests, []);
    assert.deepEqual(f.pty.ptyWrites, []);
    assert.deepEqual(f.queuedInitialPrompts, []);
  } finally {
    f.close();
  }
});

test("a positional codex launch argument becomes one acknowledged kickoff", async () => {
  const f = fixture("perch-kick-args-");
  try {
    await startManagedAgent(f.launcherOptions(), {
      request: {
        command: "codex",
        agent: "codex",
        sessionId: f.sessionId,
        cwd: f.home,
        args: ["Fix this"]
      }
    });
    assert.equal(f.codexOwned.submitted.length, 1);
    assert.equal(f.codexOwned.submitted[0]?.text, "Fix this");
    assert.deepEqual(f.codexOwned.launches[0]?.request.args, undefined);
  } finally {
    f.close();
  }
});

test("Claude's kickoff rides the spawn argv exactly once and is never typed through the PTY", async () => {
  const f = fixture("perch-claude-argv-");
  try {
    const prompt = "multiline kickoff\nwith unicode: 直接起動 ✓\nand a trailing line";
    await startManagedAgent(f.launcherOptions(), {
      request: {
        command: "claude",
        agent: "claude",
        cwd: f.home,
        labels: { task: f.taskId },
        initialPrompt: prompt
      },
      taskId: f.taskId,
      initialPromptSource: "agent"
    });
    const args = f.pty.requests[0]?.args ?? [];
    assert.equal(args.filter((arg) => arg === prompt).length, 1, "the prompt appears exactly once in argv");
    assert.deepEqual(f.pty.ptyWrites, [], "nothing is typed into the Claude PTY for the kickoff");
    assert.deepEqual(f.queuedInitialPrompts, [], "the kickoff is not queued for PTY delivery");
  } finally {
    f.close();
  }
});

test("a Claude kickoff beyond the spawn-argument limit refuses the launch instead of truncating", async () => {
  const f = fixture("perch-claude-argmax-");
  try {
    const oversized = "x".repeat(CLAUDE_KICKOFF_ARG_MAX_BYTES + 1);
    await assert.rejects(
      startManagedAgent(f.launcherOptions(), {
        request: { command: "claude", agent: "claude", cwd: f.home, initialPrompt: oversized }
      }),
      /spawn-argument limit.*refused rather than truncating/s
    );
    assert.deepEqual(f.pty.requests, [], "the refused launch never spawned");
  } finally {
    f.close();
  }
});
