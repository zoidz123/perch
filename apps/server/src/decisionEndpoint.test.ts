import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession, RecentEventsResult } from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import { AuditLog } from "./audit.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { HookRegistry } from "./hooks.js";
import { createControlServer, handleWebSocketRpcRequest } from "./http.js";
import { DeviceRegistry } from "./pairing.js";
import { PrPoller } from "./prPoller.js";
import { ProjectRegistry } from "./projects.js";
import { TaskStore } from "./tasks.js";
import { TimelineStore } from "./timeline.js";
import { WorktreePool } from "./worktrees.js";

// POST /tasks/:id/decision: the boss answers a parked no-mistakes gate from
// the phone. The decision becomes the matching `no-mistakes axi respond ...`
// line injected into the worker's composer, a ledger note, an audit record,
// and an FYI wake to the mate.

function session(id: string, labels?: Record<string, string>): AgentSession {
  return {
    id,
    title: id,
    agent: "claude",
    kind: "terminal",
    status: "idle",
    lastActivityAt: new Date().toISOString(),
    ...(labels ? { labels } : {})
  } as AgentSession;
}

class FakeAdapter implements AgentAdapter {
  readonly name = "fake-pty";
  sessions: AgentSession[] = [];
  submitted: Array<{ sessionId: string; text: string }> = [];
  async getTopology() {
    return { windows: [], generatedAt: "" };
  }
  async listSessions(): Promise<AgentSession[]> {
    return this.sessions;
  }
  async readRecentEvents(): Promise<RecentEventsResult> {
    return { events: [], terminal: true };
  }
  async sendInput(): Promise<void> {}
  async sendEnter(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async submitInput(sessionId: string, text: string): Promise<boolean> {
    this.submitted.push({ sessionId, text });
    return true;
  }
}

type Fixture = {
  port: number;
  home: string;
  adapter: FakeAdapter;
  tasks: TaskStore;
  hooks: HookRegistry;
  devices: DeviceRegistry;
  options: Parameters<typeof createControlServer>[0];
};

async function withServer(run: (ctx: Fixture) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "perch-task-decision-"));
  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  const adapter = new FakeAdapter();
  const monitor = new FleetMonitor(adapter, { broadcastMs: 5 });
  const tasks = new TaskStore(env);
  const timeline = new TimelineStore();
  const hooks = new HookRegistry();
  const devices = new DeviceRegistry(env);
  const options = {
    adapter,
    auditLog: new AuditLog(join(home, "audit.jsonl")),
    authToken: "test-token",
    boxSecretKey: new Uint8Array(32),
    monitor,
    devices,
    port: 0,
    hooks,
    timeline,
    projects: new ProjectRegistry(env),
    worktrees: new WorktreePool({ env }),
    tasks,
    prPoller: new PrPoller(tasks, async () => {
      throw new Error("gh disabled in tests");
    })
  };
  const server = createControlServer(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run({ port, home, adapter, tasks, hooks, devices, options });
  } finally {
    timeline.stop();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}

const gate = {
  step: "review",
  findings: [
    { id: "r1", severity: "warning", file: "src/app.ts", action: "ask-user", description: "renames a public flag" },
    { id: "r2", severity: "error", file: "src/db.ts", line: 42, action: "ask-user", description: "drops an index" }
  ]
};

// A needs_you task with a live worker parked at the fixture gate.
function parkedTask(ctx: Fixture): { taskId: string; sessionId: string } {
  const task = ctx.tasks.create({ title: "gated ship", project: "/tmp/repo", mode: "no-mistakes" });
  const sessionId = "pty:worker";
  ctx.tasks.update(task.id, { sessionId });
  ctx.tasks.recordEvent(task.id, {
    kind: "needs_decision",
    source: "worker",
    message: "review gate: 2 findings need you",
    data: { noMistakes: gate }
  });
  ctx.adapter.sessions = [session(sessionId)];
  return { taskId: task.id, sessionId };
}

function decide(
  port: number,
  taskId: string,
  body: unknown,
  headers: Record<string, string> = { authorization: "Bearer test-token" }
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/tasks/${taskId}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

test("a fix decision injects the exact axi respond line into the worker", async () => {
  await withServer(async (ctx) => {
    const { taskId, sessionId } = parkedTask(ctx);

    const response = await decide(ctx.port, taskId, {
      action: "fix",
      findingIds: ["r2"],
      instructions: "keep the index,\nguard the null case"
    });
    assert.equal(response.status, 202);
    const body = (await response.json()) as { ok: boolean; queued: boolean; task: { state: string } };
    assert.equal(body.ok, true);
    assert.equal(body.queued, false);

    assert.equal(ctx.adapter.submitted.length, 1);
    assert.equal(ctx.adapter.submitted[0]?.sessionId, sessionId);
    // One line: the gate, the gist, and the exact command (instructions
    // squeezed to one line and shell-quoted).
    assert.equal(
      ctx.adapter.submitted[0]?.text,
      "[perch] boss decision on review gate: fix r2 - keep the index, guard the null case" +
        " - resume the parked run with: no-mistakes axi respond --action fix --findings r2" +
        " --instructions 'keep the index, guard the null case'"
    );

    // The ledger note records the decision without moving state.
    const note = ctx.tasks.events(taskId).find((event) => event.kind === "note");
    assert.ok(note);
    assert.match(note.message ?? "", /boss decision on review gate: fix r2/);
    assert.deepEqual(note.data, {
      noMistakesDecision: {
        step: "review",
        action: "fix",
        findingIds: ["r2"],
        instructions: "keep the index,\nguard the null case"
      }
    });
    assert.equal(ctx.tasks.find(taskId)?.state, "needs_you");
  });
});

test("approve and skip compose bare respond commands; embedded quotes survive fix", async () => {
  await withServer(async (ctx) => {
    const { taskId } = parkedTask(ctx);

    const approve = await decide(ctx.port, taskId, { action: "approve" });
    assert.equal(approve.status, 202);
    assert.match(
      ctx.adapter.submitted[0]?.text ?? "",
      /resume the parked run with: no-mistakes axi respond --action approve$/
    );

    const skip = await decide(ctx.port, taskId, { action: "skip" });
    assert.equal(skip.status, 202);
    assert.match(
      ctx.adapter.submitted[1]?.text ?? "",
      /resume the parked run with: no-mistakes axi respond --action skip$/
    );

    const quoted = await decide(ctx.port, taskId, { action: "fix", instructions: "don't drop it" });
    assert.equal(quoted.status, 202);
    assert.match(ctx.adapter.submitted[2]?.text ?? "", /--instructions 'don'\\''t drop it'$/);
  });
});

test("the decision verb requires device or server auth; hook tokens are refused", async () => {
  await withServer(async (ctx) => {
    const { taskId, sessionId } = parkedTask(ctx);
    const { token } = ctx.hooks.register(sessionId);

    const anonymous = await decide(ctx.port, taskId, { action: "approve" }, {});
    assert.equal(anonymous.status, 401);

    // A worker must never answer its own gate: hook headers do not authenticate.
    const hook = await decide(
      ctx.port,
      taskId,
      { action: "approve" },
      { "x-perch-session": sessionId, "x-perch-token": token }
    );
    assert.equal(hook.status, 401);

    const { token: deviceToken } = ctx.devices.create("phone");
    const device = await decide(ctx.port, taskId, { action: "approve" }, { authorization: `Bearer ${deviceToken}` });
    assert.equal(device.status, 202);
    assert.equal(ctx.adapter.submitted.length, 1);
  });
});

test("the decision is audit-logged with task, session, and device linkage", async () => {
  await withServer(async (ctx) => {
    const { taskId, sessionId } = parkedTask(ctx);
    const { device, token } = ctx.devices.create("phone");

    const response = await decide(ctx.port, taskId, { action: "approve" }, { authorization: `Bearer ${token}` });
    assert.equal(response.status, 202);

    const records = readFileSync(join(ctx.home, "audit.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const record = records.find((entry) => entry.action === "task_decision");
    assert.ok(record, "task_decision audit record missing");
    assert.equal(record.taskId, taskId);
    assert.equal(record.sessionId, sessionId);
    assert.equal(record.deviceId, device.id);
  });
});

test("a dead or missing worker session refuses with 409 and injects nothing", async () => {
  await withServer(async (ctx) => {
    const { taskId, sessionId } = parkedTask(ctx);

    // Session vanished from the fleet entirely.
    ctx.adapter.sessions = [];
    const gone = await decide(ctx.port, taskId, { action: "approve" });
    assert.equal(gone.status, 409);
    assert.match(((await gone.json()) as { error: string }).error, /worker session is gone/);

    // Session still listed but terminal.
    ctx.adapter.sessions = [{ ...session(sessionId), status: "done" } as AgentSession];
    const dead = await decide(ctx.port, taskId, { action: "approve" });
    assert.equal(dead.status, 409);

    assert.equal(ctx.adapter.submitted.length, 0);
    assert.equal(ctx.tasks.events(taskId).some((event) => event.kind === "note"), false);
  });
});

test("validation: bad action, misplaced fix fields, unknown finding ids, no gate", async () => {
  await withServer(async (ctx) => {
    const { taskId } = parkedTask(ctx);

    const badAction = await decide(ctx.port, taskId, { action: "merge" });
    assert.equal(badAction.status, 400);

    // Boss-typed input must reach the pipeline or be refused - never dropped.
    const misplaced = await decide(ctx.port, taskId, { action: "approve", instructions: "careful" });
    assert.equal(misplaced.status, 400);
    assert.match(((await misplaced.json()) as { error: string }).error, /only apply to action "fix"/);

    const unknown = await decide(ctx.port, taskId, { action: "fix", findingIds: ["r9"] });
    assert.equal(unknown.status, 409);
    assert.match(((await unknown.json()) as { error: string }).error, /gate may have changed/);

    const missing = await decide(ctx.port, "no-such-task", { action: "approve" });
    assert.equal(missing.status, 404);

    // A needs_decision without findings data keeps today's flow: no card verb.
    const plain = ctx.tasks.create({ title: "plain ask", project: "/tmp/repo" });
    ctx.tasks.update(plain.id, { sessionId: "pty:worker" });
    ctx.tasks.recordEvent(plain.id, { kind: "needs_decision", source: "worker", message: "which color?" });
    const noGate = await decide(ctx.port, plain.id, { action: "approve" });
    assert.equal(noGate.status, 409);
    assert.match(((await noGate.json()) as { error: string }).error, /No parked no-mistakes gate/);

    // A task that is not waiting on a decision refuses too.
    const working = ctx.tasks.create({ title: "busy", project: "/tmp/repo" });
    ctx.tasks.update(working.id, { sessionId: "pty:worker" });
    ctx.tasks.recordEvent(working.id, { kind: "working", source: "worker" });
    const notParked = await decide(ctx.port, working.id, { action: "approve" });
    assert.equal(notParked.status, 409);
    assert.match(((await notParked.json()) as { error: string }).error, /not waiting on a decision/);

    assert.equal(ctx.adapter.submitted.length, 0);
  });
});

test("the RPC surface (relay path) mirrors POST /tasks/:id/decision", async () => {
  await withServer(async (ctx) => {
    const { taskId, sessionId } = parkedTask(ctx);

    const response = await handleWebSocketRpcRequest(
      {
        type: "rpc",
        id: "rpc-1",
        method: "POST",
        path: `/tasks/${taskId}/decision`,
        body: { action: "approve" }
      },
      { kind: "device", deviceId: "phone-1" },
      ctx.options
    );
    assert.equal(response.ok, true);
    assert.equal(response.status, 202);
    assert.match(
      ctx.adapter.submitted.find((entry) => entry.sessionId === sessionId)?.text ?? "",
      /no-mistakes axi respond --action approve$/
    );
  });
});

test("a live mate gets the FYI wake line; the worker still gets the command", async () => {
  await withServer(async (ctx) => {
    const { taskId, sessionId } = parkedTask(ctx);
    ctx.adapter.sessions = [session(sessionId), session("pty:mate", { role: "mate" })];

    const response = await decide(ctx.port, taskId, { action: "skip" });
    assert.equal(response.status, 202);

    const byTarget = new Map(ctx.adapter.submitted.map((entry) => [entry.sessionId, entry.text]));
    assert.match(byTarget.get(sessionId) ?? "", /no-mistakes axi respond --action skip/);
    assert.equal(
      byTarget.get("pty:mate"),
      `[perch] ${taskId} · boss_decision: the boss answered the review gate from the phone (skip)` +
        " - already injected into the worker; do not answer this gate again."
    );
  });
});
