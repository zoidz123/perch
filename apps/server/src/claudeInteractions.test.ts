import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession } from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import { ClaudeInteractionCoordinator, pendingInteraction } from "./claudeInteractions.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { TaskStore } from "./tasks.js";

const SESSION_ID = "pty:w";

class Adapter implements AgentAdapter {
  readonly name = "interactions";
  readonly inputs: string[] = [];

  async getTopology() {
    return { windows: [], generatedAt: "" };
  }

  async listSessions(): Promise<AgentSession[]> {
    return [session()];
  }

  async readRecentEvents() {
    return { events: [], terminal: true };
  }

  async sendInput(_sessionId: string, text: string) {
    this.inputs.push(text);
  }

  async sendEnter() {}
  async interrupt() {}
}

function session(): AgentSession {
  return {
    id: SESSION_ID,
    title: "worker",
    agent: "claude",
    kind: "terminal",
    status: "idle",
    lastActivityAt: ""
  };
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "perch-interactions-"));
  const tasks = new TaskStore({ PERCH_HOME: home });
  const adapter = new Adapter();
  const monitor = new FleetMonitor(adapter, { reconcileMs: 60_000 });
  const coordinator = new ClaudeInteractionCoordinator(tasks, monitor, {
    deadlineMs: 500,
    pollMs: 2
  });
  return {
    tasks,
    adapter,
    monitor,
    coordinator,
    close() {
      monitor.stop();
      tasks.close();
      rmSync(home, { recursive: true, force: true });
    }
  };
}

function deniedPayload() {
  return {
    hook_event_name: "PermissionDenied",
    session_id: "claude-session",
    tool_use_id: "tool-1",
    tool_name: "Bash",
    permission_mode: "auto",
    timestamp: "2026-07-20T14:43:56.271Z"
  };
}

test("form and URL elicitation use exact id CAS and documented action output", async () => {
  for (const mode of ["form", "url"] as const) {
    const f = fixture();
    try {
      const payload = {
        hook_event_name: "Elicitation",
        session_id: "c",
        mcp_server_name: "auth",
        elicitation_id: `e-${mode}`,
        mode,
        message: "Continue",
        ...(mode === "form"
          ? {
              requested_schema: {
                type: "object",
                required: ["name"],
                properties: { name: { type: "string" } }
              }
            }
          : { url: "https://example.test/auth" })
      };
      const record = f.coordinator.register(SESSION_ID, payload).record!;
      const content = mode === "form" ? { name: "Kevin" } : undefined;
      assert.equal(f.coordinator.respond(SESSION_ID, record.id, "accept", content, "boss:device").status, 202);
      assert.equal(
        f.coordinator.respond(SESSION_ID, record.id, "accept", content, "boss:device").body.idempotent,
        true
      );
      assert.equal(f.coordinator.respond(SESSION_ID, record.id, "decline", undefined, "boss:device").status, 409);
      const decided = await f.coordinator.wait(record.id);
      assert.deepEqual(f.coordinator.hookOutput(decided), {
        hookSpecificOutput: {
          hookEventName: "Elicitation",
          action: "accept",
          ...(content ? { content } : {})
        }
      });
    } finally {
      f.close();
    }
  }
});

test("the observed 14:43:56 PermissionDenied remains evidence without gating input or surfacing status", async () => {
  const f = fixture();
  try {
    const record = f.coordinator.observePermissionDenied(SESSION_ID, deniedPayload());
    f.monitor.restorePendingClaudeInteraction(SESSION_ID, pendingInteraction(record));

    assert.equal(record.state, "observed");
    assert.equal(f.tasks.stateDb.claudeInteractions.find(record.id)?.kind, "permission_denied");
    assert.equal(f.monitor.pendingClaudeInteraction(SESSION_ID), undefined);
    assert.equal(f.monitor.withLiveState([session()])[0]?.status, "idle");
    assert.deepEqual(await f.monitor.queueOrSubmit(SESSION_ID, "wake the mate"), { queued: false });
    assert.deepEqual(f.adapter.inputs, ["wake the mate"]);
  } finally {
    f.close();
  }
});

test("startup replay demotes a legacy observed pending and flushes queued input", async () => {
  const f = fixture();
  try {
    f.coordinator.observePermissionDenied(SESSION_ID, deniedPayload());
    f.monitor.applyExternalStatus(SESSION_ID, "needs_approval", "claude", "hook");
    assert.deepEqual(await f.monitor.queueOrSubmit(SESSION_ID, "queued wake line"), { queued: true });

    f.coordinator.replay();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(f.monitor.pendingClaudeInteraction(SESSION_ID), undefined);
    assert.equal(f.monitor.withLiveState([session()])[0]?.status, "running");
    assert.deepEqual(f.adapter.inputs, ["queued wake line"]);
  } finally {
    f.close();
  }
});

test("an actionable elicitation still gates input and surfaces to the boss", async () => {
  const f = fixture();
  try {
    const record = f.coordinator.register(SESSION_ID, {
      hook_event_name: "Elicitation",
      session_id: "c",
      mcp_server_name: "auth",
      elicitation_id: "open-prompt",
      mode: "url",
      message: "Sign in",
      url: "https://example.test/auth"
    }).record!;

    const live = f.monitor.withLiveState([session()])[0];
    assert.equal(live?.status, "needs_approval");
    assert.equal(live?.pendingClaudeInteraction?.id, record.id);
    assert.deepEqual(await f.monitor.queueOrSubmit(SESSION_ID, "do not type into the prompt"), {
      queued: true
    });
    assert.deepEqual(f.adapter.inputs, []);
  } finally {
    f.close();
  }
});

test("classifier denials do not create boss-facing task events", () => {
  const f = fixture();
  try {
    const task = f.tasks.create({ title: "Denied classifier", project: "/tmp/repo" });
    f.tasks.update(task.id, { sessionId: SESSION_ID });

    f.coordinator.observePermissionDenied(SESSION_ID, deniedPayload());

    assert.deepEqual(
      f.tasks.events(task.id).map((event) => ({ kind: event.kind, message: event.message })),
      [{ kind: "created", message: "Denied classifier" }]
    );
  } finally {
    f.close();
  }
});
