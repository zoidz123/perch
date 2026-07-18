import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { AgentAdapter } from "./adapters/types.js";
import { ClaudeApprovalCoordinator, publicRecord } from "./claudeApprovals.js";
import { surfaceApprovalToTask } from "./agentLauncher.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { wakeLine } from "./mateWake.js";
import { TaskStore } from "./tasks.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

class ApprovalAdapter implements AgentAdapter {
  readonly name = "claude-approval-test";
  inputs: string[] = [];

  async getTopology() { return { windows: [], generatedAt: "" }; }
  async listSessions() { return []; }
  async readRecentEvents() { return { events: [], terminal: true }; }
  async sendInput(_sessionId: string, input: string) { this.inputs.push(input); }
  async sendEnter() {}
  async interrupt() {}
}

function fixture(options: { linked?: boolean; deadlineMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "perch-claude-approval-"));
  const tasks = new TaskStore({ PERCH_HOME: home });
  const adapter = new ApprovalAdapter();
  const monitor = new FleetMonitor(adapter, {
    reconcileMs: 60_000,
    onApprovalNeeded: (sessionId, approval) => surfaceApprovalToTask(tasks, sessionId, approval)
  });
  const coordinator = new ClaudeApprovalCoordinator(tasks, monitor, {
    deadlineMs: options.deadlineMs ?? 1_000,
    pollMs: 2
  });
  let taskId: string | undefined;
  if (options.linked !== false) {
    const task = tasks.create({ title: "Approval test", project: "/tmp/project" });
    tasks.update(task.id, { sessionId: "pty:worker", parentSessionId: "pty:mate", workerName: "Cedar" });
    tasks.stateDb.runtimes.create({
      taskId: task.id,
      generation: 0,
      state: "live",
      agent: "claude",
      provider: "claude",
      providerSessionId: "claude-session",
      ptySessionId: "pty:worker"
    });
    taskId = task.id;
  }
  cleanups.push(() => {
    monitor.stop();
    tasks.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, tasks, adapter, monitor, coordinator, taskId };
}

function payload() {
  return {
    hook_event_name: "PermissionRequest",
    session_id: "claude-session",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/tmp/project",
    tool_name: "Bash",
    tool_input: { description: "Check status", command: "git status --short" },
    permission_suggestions: [{ type: "addRules", destination: "userSettings" }]
  };
}

test("allow and deny return only Claude's documented structured decision and never PTY input", async () => {
  for (const decision of ["allow", "deny"] as const) {
    const { coordinator, adapter } = fixture();
    const request = coordinator.register("pty:worker", { ...payload(), session_id: `claude-${decision}` }).record;
    const waiting = coordinator.waitForDecision(request.id);
    const result = coordinator.decide("pty:worker", request.id, decision, "boss:device:test");
    assert.equal(result.status, 202);
    const decided = await waiting;
    assert.deepEqual(
      coordinator.hookOutput(decided),
      decision === "allow"
        ? { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }
        : { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Denied by the boss in Perch" } } }
    );
    assert.deepEqual(adapter.inputs, [], "structured Claude approval never injects a PTY key");
  }
});

test("decision_sent survives until later Claude activity confirms continuation or denial", () => {
  const { coordinator, tasks, monitor } = fixture();
  const request = coordinator.register("pty:worker", payload()).record;
  coordinator.decide("pty:worker", request.id, "allow", "boss:device:test");
  assert.equal(tasks.stateDb.claudeApprovals.find(request.id)?.state, "decided");
  coordinator.hookOutput(tasks.stateDb.claudeApprovals.find(request.id)!);
  assert.equal(tasks.stateDb.claudeApprovals.find(request.id)?.state, "decision_sent");
  assert.equal(monitor.pendingApproval("pty:worker")?.submittedDecision, "allow");
  coordinator.confirmLaterActivity("pty:worker", "Notification");
  assert.equal(tasks.stateDb.claudeApprovals.find(request.id)?.state, "decision_sent", "notification is not a continuation barrier");
  coordinator.confirmLaterActivity("pty:worker", "PostToolUse");
  assert.equal(tasks.stateDb.claudeApprovals.find(request.id)?.state, "continued");
  assert.equal(monitor.pendingApproval("pty:worker"), undefined);
});

test("hook retry reuses one durable request and duplicate decisions are idempotent", () => {
  const { coordinator } = fixture();
  const first = coordinator.register("pty:worker", payload());
  const retry = coordinator.register("pty:worker", payload());
  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(retry.record.id, first.record.id);
  assert.equal(coordinator.decide("pty:worker", first.record.id, "allow", "boss:device:test").status, 202);
  const duplicate = coordinator.decide("pty:worker", first.record.id, "allow", "boss:device:test");
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.body.idempotent, true);
  assert.equal(coordinator.decide("pty:worker", first.record.id, "deny", "boss:device:test").status, 409);
});

test("PermissionRequest correlates a safe PreToolUse id or uses a generation-bound helper occurrence", () => {
  const { coordinator } = fixture();
  coordinator.recordPreToolUse("pty:worker", {
    hook_event_name: "PreToolUse", session_id: "claude-session", tool_use_id: "tool-use-42",
    tool_name: "Bash", tool_input: { description: "Check status", command: "git status --short" }
  });
  const correlated = coordinator.register("pty:worker", payload()).record;
  assert.equal(correlated.promptIdentity, "tool-use-42");
  coordinator.decide("pty:worker", correlated.id, "deny", "boss:device:test");
  coordinator.hookOutput(coordinator.latestForSession("pty:worker")!);
  coordinator.confirmLaterActivity("pty:worker", "PostToolUse");
  const fallback = coordinator.register("pty:worker", { ...payload(), tool_input: { command: "pwd" } }).record;
  assert.match(fallback.promptIdentity, /^helper:[a-f0-9]{24}:g0:n2$/);
});

test("timeout, lost bridge, and later local activity keep durable fallback evidence", async () => {
  const timeout = fixture({ deadlineMs: 25 });
  const expiring = timeout.coordinator.register("pty:worker", payload()).record;
  assert.equal((await timeout.coordinator.waitForDecision(expiring.id)).state, "expired");
  assert.equal(timeout.monitor.pendingApproval("pty:worker")?.remoteResolutionUnavailable, true);
  assert.equal(timeout.coordinator.decide("pty:worker", expiring.id, "allow", "boss:device:test").status, 409);

  const lost = fixture();
  const disconnected = lost.coordinator.register("pty:worker", { ...payload(), session_id: "claude-lost" }).record;
  assert.equal((await lost.coordinator.waitForDecision(disconnected.id, () => false)).state, "local_fallback");
  lost.coordinator.confirmLaterActivity("pty:worker", "Stop");
  assert.equal(lost.monitor.pendingApproval("pty:worker"), undefined);
});

test("runtime generation changes reject a stale request", () => {
  const { coordinator, tasks, taskId } = fixture();
  const request = coordinator.register("pty:worker", payload()).record;
  tasks.stateDb.runtimes.compareAndSwap(taskId!, 0, "live", "ended");
  tasks.stateDb.runtimes.create({
    taskId: taskId!, generation: 1, state: "live", agent: "claude", provider: "claude",
    providerSessionId: "claude-next", ptySessionId: "pty:next"
  });
  const result = coordinator.decide("pty:worker", request.id, "allow", "boss:device:test");
  assert.equal(result.status, 409);
  assert.equal(result.body.reason, "stale_generation");
});

test("restart replay restores the same request without repeating notification authority", () => {
  const first = fixture();
  const request = first.coordinator.register("pty:worker", payload()).record;
  first.monitor.stop();
  first.tasks.close();
  cleanups.pop();

  const tasks = new TaskStore({ PERCH_HOME: first.home });
  const monitor = new FleetMonitor(new ApprovalAdapter(), { reconcileMs: 60_000 });
  const replayed = new ClaudeApprovalCoordinator(tasks, monitor);
  replayed.replay();
  assert.equal(monitor.pendingApproval("pty:worker")?.id, request.id);
  assert.equal(replayed.latestForSession("pty:worker")?.state, "pending");
  monitor.stop();
  tasks.close();
  rmSync(first.home, { recursive: true, force: true });
});

test("durable inbox exposes a full sequence and redacted ordered deltas", () => {
  const { coordinator, tasks } = fixture();
  const request = coordinator.register("pty:worker", payload()).record;
  coordinator.decide("pty:worker", request.id, "allow", "boss:device:test");
  coordinator.hookOutput(tasks.stateDb.claudeApprovals.find(request.id)!);
  const deltas = tasks.stateDb.claudeInbox.deltas(0).filter((delta) => delta.requestId === request.id);
  assert.deepEqual(deltas.map((delta) => delta.state), ["pending", "decided", "decision_sent"]);
  assert.ok(deltas.every((delta, index) => index === 0 || delta.seq > deltas[index - 1]!.seq));
  assert.doesNotMatch(JSON.stringify(deltas), /git status|tool_input|permission_suggestions/);
  assert.equal(tasks.stateDb.claudeInbox.sequence(), deltas.at(-1)!.seq);
});

test("Mate absence does not absorb the request and safe wake details survive in the task ledger", () => {
  const { coordinator, tasks, taskId } = fixture();
  const request = coordinator.register("pty:worker", payload()).record;
  const event = tasks.events(taskId!).at(-1)!;
  assert.equal(event.kind, "needs_decision");
  assert.equal(event.data?.approvalId, request.id);
  assert.match(wakeLine(tasks.find(taskId!)!, event), /Bash - git status --short - cwd \/tmp\/project/);
  assert.equal(tasks.stateDb.outbox.forTaskEvent(taskId!, event.seq).length, 2, "Mate and push intents are durable while Mate is offline");
});

test("unlinked solo requests surface without invented task or runtime identity", () => {
  const { coordinator, monitor } = fixture({ linked: false });
  const request = coordinator.register("pty:solo", payload()).record;
  assert.equal(request.taskId, undefined);
  assert.equal(request.runtimeGeneration, undefined);
  assert.equal(monitor.pendingApproval("pty:solo")?.id, request.id);
});

test("permission suggestions stay ephemeral unless the boss chooses the exact validated rule", () => {
  const { coordinator, monitor, tasks } = fixture();
  const request = coordinator.register("pty:worker", payload()).record;
  const serialized = JSON.stringify(publicRecord(request));
  assert.doesNotMatch(serialized, /permission_suggestions|addRules|userSettings/);
  assert.deepEqual((publicRecord(request).allowedDecisions), ["allow", "deny"]);
  const exact = monitor.pendingApproval("pty:worker")!.decisions!.find((decision) => decision.id.startsWith("allow_always:"))!;
  assert.equal(coordinator.decide("pty:worker", request.id, exact.id, "boss:device:test").status, 202);
  const chosen = tasks.stateDb.claudeApprovals.find(request.id)!;
  assert.equal(chosen.decision, "allow_always");
  assert.deepEqual(chosen.selectedPermission, { type: "addRules", destination: "userSettings" });
  assert.deepEqual(coordinator.hookOutput(chosen), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: {
    behavior: "allow", updatedPermissions: [{ type: "addRules", destination: "userSettings" }]
  } } });
});

test("ExitPlanMode is separate PreToolUse state and returns the original input in updatedInput", async () => {
  const { coordinator, adapter } = fixture();
  const toolInput = { plan: "Implement the focused fix", planFilePath: "/tmp/plan.md", allowedPrompts: [{ tool: "Bash", prompt: "test" }] };
  const registered = coordinator.registerExitPlan("pty:worker", {
    hook_event_name: "PreToolUse", session_id: "claude-session", tool_name: "ExitPlanMode", tool_use_id: "exit-plan-1", tool_input: toolInput
  });
  assert.equal(registered.record?.interactionKind, "exit_plan_mode");
  coordinator.decide("pty:worker", registered.record!.id, "allow", "boss:device:test");
  const record = await coordinator.waitForDecision(registered.record!.id);
  assert.deepEqual(coordinator.hookOutput(record), { hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "Plan accepted by the boss in Perch", updatedInput: toolInput
  } });
  assert.deepEqual(adapter.inputs, []);
});
