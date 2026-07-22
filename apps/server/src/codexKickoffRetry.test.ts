import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession, RecentEventsResult, StartAgentRequest } from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import {
  armCodexKickoffWatchdog,
  codexFirstTurnEvidence,
  rearmCodexKickoffWatchdogs,
  startManagedAgent
} from "./agentLauncher.js";
import { AuditLog } from "./audit.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { HookRegistry } from "./hooks.js";
import { ProjectRegistry } from "./projects.js";
import { TaskStore } from "./tasks.js";
import { TimelineStore } from "./timeline.js";
import { WorktreePool } from "./worktrees.js";

// Regression: a dispatched codex worker whose kickoff prompt was typed into a
// TUI that was not ready loses the prompt silently - the session shows a bare
// codex banner and the task sits "working" forever with an empty transcript.
// The kickoff watchdog retries the exact original kickoff once after a bounded
// window without first-turn evidence, and after a second silent window parks
// the task blocked instead of leaving it silently empty (or retrying forever).

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(deadlineMs: number, check: () => boolean): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await tick(10);
  }
  return check();
}

class KickoffAdapter implements AgentAdapter {
  readonly name = "kickoff-test";
  sessions: AgentSession[] = [];
  submitted: string[] = [];

  async getTopology() { return { windows: [], generatedAt: "" }; }
  async listSessions(): Promise<AgentSession[]> { return this.sessions; }
  async readRecentEvents(): Promise<RecentEventsResult> { return { events: [], terminal: true }; }
  async sendInput(): Promise<void> {}
  async sendEnter(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async submitInput(_sessionId: string, text: string): Promise<boolean> {
    this.submitted.push(text);
    return true;
  }
  async startAgent(request: StartAgentRequest): Promise<AgentSession> {
    const session: AgentSession = {
      id: request.sessionId ?? "pty:kickoff-session",
      title: request.title ?? request.command,
      agent: request.agent ?? "codex",
      cwd: request.cwd,
      labels: request.labels,
      kind: "terminal",
      status: "running",
      lastActivityAt: new Date().toISOString()
    };
    this.sessions.push(session);
    return session;
  }
}

type Fixture = {
  home: string;
  adapter: KickoffAdapter;
  tasks: TaskStore;
  monitor: FleetMonitor;
  hooks: HookRegistry;
  timeline: TimelineStore;
  taskId: string;
  sessionId: string;
  close: () => void;
};

function fixture(prefix: string): Fixture {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const adapter = new KickoffAdapter();
  const tasks = new TaskStore({ PERCH_HOME: home } as NodeJS.ProcessEnv);
  const monitor = new FleetMonitor(adapter, { broadcastMs: 5 });
  const hooks = new HookRegistry();
  const timeline = new TimelineStore();
  const sessionId = "pty:kickoff-session";
  const task = tasks.create({ title: "kickoff", project: home });
  tasks.update(task.id, { sessionId });
  return {
    home,
    adapter,
    tasks,
    monitor,
    hooks,
    timeline,
    taskId: task.id,
    sessionId,
    close: () => {
      monitor.stop();
      timeline.stop();
      tasks.close();
      rmSync(home, { recursive: true, force: true });
    }
  };
}

test("a swallowed codex kickoff is retried exactly once and an exhausted retry parks the task truthfully", async () => {
  const f = fixture("perch-kickoff-retry-");
  try {
    armCodexKickoffWatchdog(f, f.sessionId, f.taskId, "kickoff prompt", 40);
    // Boundary race: a second arm for the same session is a no-op, so timers
    // can never stack up and duplicate the kickoff.
    armCodexKickoffWatchdog(f, f.sessionId, f.taskId, "kickoff prompt", 40);

    assert.ok(await until(2_000, () => f.adapter.submitted.length === 1), "kickoff was retried");
    assert.deepEqual(f.adapter.submitted, ["kickoff prompt"]);

    assert.ok(
      await until(2_000, () => f.tasks.find(f.taskId)?.state === "blocked"),
      "exhausted retry parked the task"
    );
    const blocked = f.tasks.events(f.taskId).find((event) => event.kind === "blocked");
    assert.equal(blocked?.source, "system");
    assert.equal(blocked?.data?.reason, "kickoff_not_accepted");
    assert.equal(blocked?.data?.sessionId, f.sessionId);
    assert.equal(blocked?.data?.retry, "submitted");
    // The submitted retry is journaled durably so a restart cannot repeat it.
    assert.ok(
      f.tasks
        .events(f.taskId)
        .some((event) => event.kind === "note" && event.data?.reason === "kickoff_retried")
    );
    // Exactly once: the exhausted pass never submits again.
    assert.equal(f.adapter.submitted.length, 1);
  } finally {
    f.close();
  }
});

test("an open permission gate skips the retry and the blocked outcome says so", async () => {
  const f = fixture("perch-kickoff-gated-");
  try {
    let recorded = 0;
    const deps = {
      tasks: f.tasks,
      monitor: f.monitor,
      hooks: f.hooks,
      timeline: {
        recordSource: () => {
          recorded += 1;
        }
      }
    };
    f.monitor.applyExternalStatus(f.sessionId, "needs_approval", "codex", "adapter");
    armCodexKickoffWatchdog(deps, f.sessionId, f.taskId, "kickoff prompt", 40);

    assert.ok(
      await until(2_000, () => f.tasks.find(f.taskId)?.state === "blocked"),
      "a gate-skipped retry still adjudicates"
    );
    // Nothing was submitted, so the timeline records no agent-sourced kickoff
    // and no spent-retry journal entry exists.
    assert.deepEqual(f.adapter.submitted, []);
    assert.equal(recorded, 0);
    assert.ok(
      !f.tasks
        .events(f.taskId)
        .some((event) => event.kind === "note" && event.data?.reason === "kickoff_retried")
    );
    const blocked = f.tasks.events(f.taskId).find((event) => event.kind === "blocked");
    assert.equal(blocked?.data?.retry, "gated");
    assert.match(blocked?.message ?? "", /skipped by an open permission gate/);
  } finally {
    f.close();
  }
});

test("first-turn evidence suppresses the kickoff retry", async () => {
  const f = fixture("perch-kickoff-evidence-");
  try {
    // The authoritative lifecycle signal: the provider's turn started against
    // this exact session (recorded by TaskCompletionReconciler from the codex
    // control plane's turn/started).
    f.tasks.recordEvent(f.taskId, {
      kind: "turn_started",
      source: "hook",
      message: "codex turn started",
      data: { provider: "codex", sessionId: f.sessionId, taskEventSeqAtStart: 0 }
    });
    assert.equal(codexFirstTurnEvidence(f, f.sessionId, f.taskId), "turn");

    armCodexKickoffWatchdog(f, f.sessionId, f.taskId, "kickoff prompt", 30);
    await tick(150);
    assert.deepEqual(f.adapter.submitted, []);
    assert.ok(!f.tasks.events(f.taskId).some((event) => event.kind === "blocked"));
  } finally {
    f.close();
  }
});

test("rollout correlation counts as first-turn evidence (codex writes it only at the first turn)", async () => {
  const f = fixture("perch-kickoff-rollout-");
  try {
    f.hooks.correlate(f.sessionId, "0197aaaa-bbbb-7ccc-8ddd-eeeeffff0001", join(f.home, "rollout.jsonl"));
    assert.equal(codexFirstTurnEvidence(f, f.sessionId, f.taskId), "rollout");

    armCodexKickoffWatchdog(f, f.sessionId, f.taskId, "kickoff prompt", 30);
    await tick(150);
    assert.deepEqual(f.adapter.submitted, []);
  } finally {
    f.close();
  }
});

test("evidence arriving after the retry suppresses the blocked outcome", async () => {
  const f = fixture("perch-kickoff-late-evidence-");
  try {
    armCodexKickoffWatchdog(f, f.sessionId, f.taskId, "kickoff prompt", 40);
    assert.ok(await until(2_000, () => f.adapter.submitted.length === 1), "kickoff was retried");
    // The retried kickoff was accepted: the worker reports from inside its
    // first turn before the second window elapses.
    f.tasks.recordEvent(f.taskId, { kind: "working", source: "worker", message: "on it" });
    assert.equal(codexFirstTurnEvidence(f, f.sessionId, f.taskId), "worker");

    await tick(200);
    assert.ok(!f.tasks.events(f.taskId).some((event) => event.kind === "blocked"));
    assert.equal(f.tasks.find(f.taskId)?.state, "working");
    assert.equal(f.adapter.submitted.length, 1);
  } finally {
    f.close();
  }
});

test("startManagedAgent arms the kickoff watchdog for codex task dispatches only", async () => {
  const f = fixture("perch-kickoff-wiring-");
  const claude = fixture("perch-kickoff-wiring-claude-");
  const base = (fx: Fixture) => ({
    adapter: fx.adapter,
    auditLog: new AuditLog(join(fx.home, "audit.jsonl")),
    monitor: fx.monitor,
    projects: new ProjectRegistry({ PERCH_HOME: fx.home } as NodeJS.ProcessEnv),
    worktrees: new WorktreePool({ env: { PERCH_HOME: fx.home } as NodeJS.ProcessEnv }),
    hooks: fx.hooks,
    timeline: fx.timeline,
    tasks: fx.tasks,
    port: 8787,
    codexKickoffRetryMs: 40
  });
  try {
    const codexResult = await startManagedAgent(base(f), {
      request: {
        command: "codex",
        agent: "codex",
        sessionId: f.sessionId,
        cwd: f.home,
        labels: { task: f.taskId },
        initialPrompt: "codex kickoff"
      },
      taskId: f.taskId,
      initialPromptSource: "agent"
    });
    assert.equal(codexResult.session.id, f.sessionId);
    assert.ok(await until(2_000, () => f.adapter.submitted.includes("codex kickoff")), "codex dispatch armed the retry");

    // A claude dispatch never arms it (claude's hook path owns delivery).
    await startManagedAgent(base(claude), {
      request: {
        command: "claude",
        agent: "claude",
        sessionId: claude.sessionId,
        cwd: claude.home,
        labels: { task: claude.taskId },
        initialPrompt: "claude kickoff"
      },
      taskId: claude.taskId,
      initialPromptSource: "agent"
    });
    await tick(200);
    assert.deepEqual(claude.adapter.submitted, []);
    assert.ok(!claude.tasks.events(claude.taskId).some((event) => event.kind === "blocked"));
  } finally {
    f.close();
    claude.close();
  }
});

// Simulate a server restart inside the watchdog window: the in-memory arm is
// gone, but the dispatch operation (holding the exact kickoff) and the task
// ledger survive in SQLite, and the session is still live in the adapter.
function recordDispatchOperation(f: Fixture): void {
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
          initialPrompt: "kickoff prompt"
        },
        leaseId: "wt-rearm"
      },
      launchStarted: true
    }
  });
}

function markSessionLive(f: Fixture): void {
  f.adapter.sessions.push({
    id: f.sessionId,
    title: "codex - kickoff",
    agent: "codex",
    cwd: f.home,
    kind: "terminal",
    status: "running",
    lastActivityAt: new Date().toISOString()
  });
}

test("a server restart inside the window rearms the watchdog from durable dispatch state", async () => {
  const f = fixture("perch-kickoff-rearm-");
  try {
    recordDispatchOperation(f);
    markSessionLive(f);

    await rearmCodexKickoffWatchdogs(f, 40);
    assert.ok(await until(2_000, () => f.adapter.submitted.length === 1), "rearm retried the kickoff");
    assert.deepEqual(f.adapter.submitted, ["kickoff prompt"]);
    assert.ok(
      await until(2_000, () => f.tasks.find(f.taskId)?.state === "blocked"),
      "a rearmed exhausted retry still parks the task"
    );
    assert.equal(f.adapter.submitted.length, 1);
  } finally {
    f.close();
  }
});

test("a retry journaled before the restart is never submitted a second time", async () => {
  const f = fixture("perch-kickoff-rearm-spent-");
  try {
    recordDispatchOperation(f);
    markSessionLive(f);
    f.tasks.recordEvent(f.taskId, {
      kind: "note",
      source: "system",
      message: "codex kickoff retried after a silent launch window",
      data: { reason: "kickoff_retried", sessionId: f.sessionId }
    });

    await rearmCodexKickoffWatchdogs(f, 30);
    assert.ok(
      await until(2_000, () => f.tasks.find(f.taskId)?.state === "blocked"),
      "the final adjudication window still runs after the restart"
    );
    assert.deepEqual(f.adapter.submitted, []);
    const blocked = f.tasks.events(f.taskId).find((event) => event.kind === "blocked");
    assert.equal(blocked?.data?.retry, "submitted");
    assert.match(blocked?.message ?? "", /one kickoff retry/);
  } finally {
    f.close();
  }
});

test("rearm skips tasks whose session did not survive the restart", async () => {
  const f = fixture("perch-kickoff-rearm-dead-");
  try {
    recordDispatchOperation(f);

    await rearmCodexKickoffWatchdogs(f, 30);
    await tick(200);
    assert.deepEqual(f.adapter.submitted, []);
    assert.ok(!f.tasks.events(f.taskId).some((event) => event.kind === "blocked"));
  } finally {
    f.close();
  }
});

test("rearm skips tasks with first-turn evidence", async () => {
  const f = fixture("perch-kickoff-rearm-evidence-");
  try {
    recordDispatchOperation(f);
    markSessionLive(f);
    f.tasks.recordEvent(f.taskId, { kind: "working", source: "worker", message: "on it" });

    await rearmCodexKickoffWatchdogs(f, 30);
    await tick(200);
    assert.deepEqual(f.adapter.submitted, []);
    assert.ok(!f.tasks.events(f.taskId).some((event) => event.kind === "blocked"));
  } finally {
    f.close();
  }
});
