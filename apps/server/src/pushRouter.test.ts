import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession, Task } from "@perch/shared";
import type { PushNotification } from "./push.js";
import { PushRouter, truncateAtWord, type PushRouterDeps } from "./pushRouter.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function session(id: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
    kind: "terminal",
    title: "claude",
    status: "running",
    lastActivityAt: new Date().toISOString(),
    cwd: "/Users/dev/projects/perch",
    ...overrides
  } as AgentSession;
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id,
    title: "fix the flaky test",
    project: "/Users/dev/projects/perch",
    kind: "ship",
    mode: "direct-PR",
    state: "working",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

type Harness = {
  router: PushRouter;
  sent: PushNotification[];
  deps: PushRouterDeps;
};

function harness(overrides: Partial<PushRouterDeps> = {}, fallbackMs = 30): Harness {
  const sent: PushNotification[] = [];
  const deps: PushRouterDeps = {
    push: { send: (notification) => { sent.push(notification); } },
    projectName: (path) => (path ? path.split("/").filter(Boolean).pop() : undefined),
    lastAssistantText: () => "All three PRs are green; the relay fix is ready for your review.",
    hasActiveViewer: () => false,
    hasLiveTasks: () => true,
    ...overrides
  };
  return { router: new PushRouter(deps, { fallbackMs }), sent, deps };
}

const mateSession = session("pty:mate", { labels: { role: "mate" }, cwd: "/Users/dev/.perch/mate" });
const crewSession = session("pty:crew", { labels: { task: "t-1", parent: "pty:mate" } });
const soloSession = session("pty:solo");

test("crew turn-done, waiting, and error never push directly", () => {
  const { router, sent } = harness();
  router.sessionStatusChanged("pty:crew", crewSession, "running", "idle");
  router.sessionStatusChanged("pty:crew", crewSession, "running", "waiting");
  router.sessionStatusChanged("pty:crew", crewSession, "running", "error");
  assert.equal(sent.length, 0);
});

test("solo turn-done pushes with the project name and reply snippet", () => {
  const { router, sent } = harness();
  router.sessionStatusChanged("pty:solo", soloSession, "running", "idle");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.title, "perch (solo) finished");
  assert.match(sent[0]?.body ?? "", /relay fix/);
  assert.equal(sent[0]?.category, "turn_done");
});

test("solo waiting and error keep their pushes", () => {
  const { router, sent } = harness();
  router.sessionStatusChanged("pty:solo", soloSession, "running", "waiting");
  router.sessionStatusChanged("pty:solo", soloSession, "waiting", "error");
  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.title, "perch (solo) is waiting on you");
  assert.equal(sent[1]?.category, "error");
});

test("a mate reply pushes like a message: title Mate, body = the text, mate thread", () => {
  const { router, sent } = harness();
  router.sessionStatusChanged("pty:mate", mateSession, "running", "idle");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.title, "Mate");
  assert.equal(sent[0]?.body, "All three PRs are green; the relay fix is ready for your review.");
  assert.equal(sent[0]?.category, "mate_message");
  assert.equal(sent[0]?.threadId, "mate");
});

test("a mate reply is not pushed while a phone is viewing the conversation", () => {
  const { router, sent } = harness({ hasActiveViewer: () => true });
  router.sessionStatusChanged("pty:mate", mateSession, "running", "idle");
  assert.equal(sent.length, 0);
});

test("mate message bodies truncate ~150 chars at a word boundary", () => {
  const long = `${"word ".repeat(60)}end`;
  const { router, sent } = harness({ lastAssistantText: () => long });
  router.sessionStatusChanged("pty:mate", mateSession, "running", "idle");
  const body = sent[0]?.body ?? "";
  assert.ok(body.length <= 151, `body too long: ${body.length}`);
  assert.ok(body.endsWith("…"));
  assert.ok(!body.slice(0, -1).endsWith(" "), "should cut at a word boundary");
});

test("approvals push for every role, crew included", () => {
  const { router, sent } = harness();
  const approval = { id: "a1", summary: "Bash", command: "rm -rf node_modules", at: new Date().toISOString() };
  router.approvalNeeded("pty:crew", crewSession, approval);
  router.approvalNeeded("pty:mate", mateSession, approval);
  router.approvalNeeded("pty:solo", soloSession, { id: "a2", summary: "Bash command", at: new Date().toISOString() });
  assert.equal(sent.length, 3);
  assert.equal(sent[0]?.title, "Worker needs permission");
  assert.match(sent[0]?.body ?? "", /The perch agent wants to run: rm -rf node_modules/);
  assert.equal(sent[0]?.category, "approval");
  assert.equal(sent[2]?.body, "perch: Bash command");
});

test("Computer Use push names the worker, tool, app, and exact session deep link", () => {
  const { router, sent } = harness();
  const worker = session("pty:crew", {
    workerName: "Alder",
    labels: { task: "t-1", parent: "pty:mate" },
    cwd: "/Users/dev/projects/perch"
  });
  router.approvalNeeded("pty:crew", worker, {
    id: "screen:computer-use",
    summary: 'Allow Computer Use to use "Xcode"?',
    context: { tool: "Computer Use", app: "Xcode" },
    decisions: [
      { id: "allow", label: "Allow", persistence: "turn" },
      { id: "allow_session", label: "Allow for this session", persistence: "session" },
      { id: "allow_always", label: "Always allow", persistence: "always" },
      { id: "cancel", label: "Cancel", destructive: true }
    ],
    at: new Date().toISOString()
  });
  assert.equal(sent[0]?.title, "Alder needs permission");
  assert.match(sent[0]?.body ?? "", /perch: Computer Use \/ Xcode/);
  assert.equal(sent[0]?.sessionId, "pty:crew");
  assert.equal(sent[0]?.category, "approval_choices");
});

test("mirrored approval task evidence does not schedule a duplicate fallback push", async () => {
  const { router, sent } = harness({ findSession: (id) => (id === "pty:crew" ? crewSession : undefined) });
  await router.deliverTaskEvent(task("t-1", { sessionId: "pty:crew", state: "needs_you" }), {
    kind: "needs_decision",
    message: "Allow Computer Use?",
    data: { reason: "approval_request", approvalId: "screen:1" }
  });
  await sleep(90);
  assert.equal(sent.length, 0);
  router.stop();
});

test("crew needs_decision does not push immediately; the fallback fires when unrelayed", async () => {
  const { router, sent } = harness({ findSession: (id) => (id === "pty:crew" ? crewSession : undefined) });
  const crewTask = task("t-1", { sessionId: "pty:crew", state: "needs_you" });
  router.taskEvent(crewTask, { kind: "needs_decision", message: "merge now or wait for CI?" });
  assert.equal(sent.length, 0);

  await sleep(90);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.title, "Needs your call");
  assert.equal(sent[0]?.body, "perch: merge now or wait for CI?");
  router.stop();
});

test("fallback task notifications identify the worker separately from the work title", async () => {
  const { router, sent } = harness({ findSession: (id) => (id === "pty:crew" ? crewSession : undefined) });
  router.taskEvent(task("t-1", { sessionId: "pty:crew", state: "needs_you", workerName: "Wren" }), {
    kind: "needs_decision",
    message: "merge now?"
  });
  await sleep(90);
  assert.equal(sent[0]?.subtitle, "Wren · fix the flaky test");
  router.stop();
});

test("a mate reply within the window relays the event: no fallback push", async () => {
  const { router, sent } = harness({ findSession: (id) => (id === "pty:crew" ? crewSession : undefined) });
  router.taskEvent(task("t-1", { sessionId: "pty:crew", state: "needs_you" }), {
    kind: "needs_decision",
    message: "merge now?"
  });
  router.sessionStatusChanged("pty:mate", mateSession, "running", "idle");
  const mateMessages = sent.length; // the relay itself may push (as a mate message)
  await sleep(90);
  assert.equal(sent.length, mateMessages);
  assert.ok(sent.every((notification) => notification.category === "mate_message"));
  router.stop();
});

test("crew blocked uses the stuck copy and re-arms per event", async () => {
  const { router, sent } = harness({ findSession: (id) => (id === "pty:crew" ? crewSession : undefined) }, 60);
  const crewTask = task("t-1", { sessionId: "pty:crew", state: "blocked" });
  router.taskEvent(crewTask, { kind: "blocked", message: "npm registry is down" });
  await sleep(30);
  // A fresh event replaces the armed timer: only the newest blocker pushes.
  router.taskEvent(crewTask, { kind: "blocked", message: "registry back, now the token is expired" });
  await sleep(40);
  assert.equal(sent.length, 0, "re-armed timer must not fire on the old schedule");
  await sleep(60);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.title, "Stuck on perch");
  assert.equal(sent[0]?.body, "registry back, now the token is expired");
  router.stop();
});

test("a later task event disarms the fallback (the moment passed)", async () => {
  const { router, sent } = harness({ findSession: (id) => (id === "pty:crew" ? crewSession : undefined) });
  const crewTask = task("t-1", { sessionId: "pty:crew", state: "needs_you" });
  router.taskEvent(crewTask, { kind: "needs_decision", message: "merge now?" });
  router.taskEvent({ ...crewTask, state: "working" }, { kind: "working", message: "mate answered in-session" });
  await sleep(90);
  assert.equal(sent.length, 0);
  router.stop();
});

test("crew done/failed/checks_green/merge_ready/merged stay silent; solo task events push friendly copy", () => {
  const { router, sent } = harness({
    findSession: (id) => (id === "pty:crew" ? crewSession : id === "pty:solo" ? soloSession : undefined)
  });
  const crewTask = task("t-1", { sessionId: "pty:crew", state: "done" });
  router.taskEvent(crewTask, { kind: "done", message: "PR is up" });
  router.taskEvent(crewTask, { kind: "failed", message: "could not finish" });
  router.taskEvent(crewTask, { kind: "checks_green" });
  router.taskEvent(crewTask, { kind: "merge_ready" });
  router.taskEvent(crewTask, { kind: "merged" });
  assert.equal(sent.length, 0);

  const soloTask = task("t-2", { sessionId: "pty:solo", state: "done" });
  router.taskEvent(soloTask, { kind: "done", message: "shipped it, PR #52" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.title, "perch task finished");
  assert.equal(sent[0]?.body, "shipped it, PR #52");

  const soloPrTask = task("t-3", {
    sessionId: "pty:solo",
    state: "done",
    pr: { url: "https://github.com/o/r/pull/52" }
  });
  router.taskEvent(soloPrTask, { kind: "checks_green" });
  router.taskEvent(soloPrTask, { kind: "merge_ready" });
  assert.equal(sent.length, 3);
  assert.equal(sent[1]?.title, "PR checks are green");
  assert.match(sent[1]?.body ?? "", /merge readiness not confirmed/);
  assert.equal(sent[2]?.title, "PR is ready to merge");
  assert.equal(sent[2]?.body, "https://github.com/o/r/pull/52");
});

test("solo needs_decision pushes immediately with the friendly copy", () => {
  const { router, sent } = harness({ findSession: (id) => (id === "pty:solo" ? soloSession : undefined) });
  router.taskEvent(task("t-2", { sessionId: "pty:solo", state: "needs_you" }), {
    kind: "needs_decision",
    message: "which branch?"
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.title, "Needs your call");
  assert.equal(sent[0]?.body, "perch: which branch?");
});

const gateData = {
  noMistakes: {
    step: "review",
    findings: [
      { id: "r1", severity: "warning", file: "src/app.ts", description: "prefer the shared helper" },
      { id: "r2", severity: "error", file: "src/db.ts", description: "dropping this index changes query plans" }
    ]
  }
};

test("solo needs_decision with a no-mistakes gate pushes the findings, worst first, verbatim", () => {
  const { router, sent } = harness({ findSession: (id) => (id === "pty:solo" ? soloSession : undefined) });
  router.taskEvent(task("t-2", { sessionId: "pty:solo", state: "needs_you" }), {
    kind: "needs_decision",
    message: "the worker's own prose, superseded by the structured table",
    data: gateData
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.title, "Needs your call");
  assert.equal(
    sent[0]?.body,
    "perch: review gate: 2 findings need you - r2 (error): dropping this index changes query plans"
  );
});

test("findings push bodies still obey the ~150 char truncation", () => {
  const { router, sent } = harness({ findSession: (id) => (id === "pty:solo" ? soloSession : undefined) });
  router.taskEvent(task("t-2", { sessionId: "pty:solo", state: "needs_you" }), {
    kind: "needs_decision",
    data: { noMistakes: { step: "review", findings: [{ id: "r1", severity: "error", description: "word ".repeat(60) }] } }
  });
  const body = sent[0]?.body ?? "";
  assert.ok(body.length <= "perch: ".length + 151, `body too long: ${body.length}`);
  assert.ok(body.endsWith("…"));
});

test("needs_decision with unparseable data falls back to the message", () => {
  const { router, sent } = harness({ findSession: (id) => (id === "pty:solo" ? soloSession : undefined) });
  router.taskEvent(task("t-2", { sessionId: "pty:solo", state: "needs_you" }), {
    kind: "needs_decision",
    message: "which branch?",
    data: { noMistakes: "junk" }
  });
  assert.equal(sent[0]?.body, "perch: which branch?");
});

test("crew gate findings survive the escalation fallback: the late push is findings-formatted", async () => {
  const { router, sent } = harness({ findSession: (id) => (id === "pty:crew" ? crewSession : undefined) });
  router.taskEvent(task("t-1", { sessionId: "pty:crew", state: "needs_you" }), {
    kind: "needs_decision",
    message: "review gate parked",
    data: gateData
  });
  assert.equal(sent.length, 0);
  await sleep(90);
  assert.equal(sent.length, 1);
  assert.match(sent[0]?.body ?? "", /review gate: 2 findings need you - r2 \(error\)/);
  router.stop();
});

test("classification survives session death: a late crew event after exit stays silent", async () => {
  // The PTY adapter drops ended sessions from the fleet immediately, so the
  // G4 death-blocked event arrives with no live session to classify against.
  const { router, sent } = harness({ findSession: () => undefined });
  router.sessionStatusChanged("pty:crew", crewSession, undefined, "running");
  router.taskEvent(task("t-1", { sessionId: "pty:crew", state: "blocked" }), {
    kind: "blocked",
    message: "worker session ended while working"
  });
  assert.equal(sent.length, 0, "must arm the fallback, not push immediately");
  await sleep(90);
  assert.equal(sent.length, 1);
  router.stop();
});

test("mate death while tasks are live pushes the backstop exactly once", () => {
  const { router, sent } = harness();
  router.sessionStatusChanged("pty:mate", mateSession, undefined, "running");
  router.sessionExited("pty:mate");
  router.sessionExited("pty:mate");
  router.sessionStatusChanged("pty:mate", mateSession, "running", "error");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.title, "Your mate went quiet");
  assert.equal(sent[0]?.body, "Not responding - tap to check on things.");
});

test("mate death with no live tasks stays silent", () => {
  const { router, sent } = harness({ hasLiveTasks: () => false });
  router.sessionStatusChanged("pty:mate", mateSession, undefined, "running");
  router.sessionExited("pty:mate");
  assert.equal(sent.length, 0);
});

test("a solo session exit never triggers the mate backstop", () => {
  const { router, sent } = harness();
  router.sessionStatusChanged("pty:solo", soloSession, undefined, "running");
  router.sessionExited("pty:solo");
  assert.equal(sent.length, 0);
});

test("truncateAtWord keeps short text intact and clips long text on a space", () => {
  assert.equal(truncateAtWord("short and sweet"), "short and sweet");
  assert.equal(truncateAtWord("one\n two   three"), "one two three");
  const clipped = truncateAtWord("a".repeat(200), 150);
  assert.equal(clipped.length, 151); // no space to break on: hard cut + ellipsis
  assert.ok(clipped.endsWith("…"));
});

test("chart-ready pushes for a crew session too - boss-facing, never absorbed as crew noise", () => {
  const { router, sent } = harness({
    findSession: (id) => (id === "pty:crew" ? crewSession : undefined)
  });
  // The same crew session whose task events stay silent behind the mate...
  router.taskEvent(task("t-1", { sessionId: "pty:crew", state: "done" }), { kind: "done" });
  assert.equal(sent.length, 0);
  // ...pushes immediately when it registers a chart for review.
  router.chartReady("pty:crew", crewSession, "relay-reliability");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.category, "chart_ready");
  assert.equal(sent[0]?.title, "perch: a chart is ready for review");
  assert.match(sent[0]?.body ?? "", /relay-reliability/);
});

test("chart-ready pushes for solo and mate sessions with the project in the title", () => {
  const { router, sent } = harness();
  router.chartReady("pty:solo", soloSession, "roadmap");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.category, "chart_ready");
  assert.match(sent[0]?.title ?? "", /chart is ready for review/);
});
