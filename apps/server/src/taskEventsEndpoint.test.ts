import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession, RecentEventsResult } from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import { AuditLog } from "./audit.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { HookRegistry } from "./hooks.js";
import { createControlServer, MAX_TASK_EVENT_MESSAGE_BYTES } from "./http.js";
import { DeviceRegistry } from "./pairing.js";
import { PrPoller, type GhRunner, type PrFinder, type RepoResolver } from "./prPoller.js";
import { ProjectRegistry } from "./projects.js";
import { TaskStore } from "./tasks.js";
import { TimelineStore } from "./timeline.js";
import { WorktreePool } from "./worktrees.js";

// POST /tasks/:id/events structured-data intake: the worker verb carries an
// optional `data` object persisted onto the event verbatim, bounded at 32 KB.

class NoopAdapter implements AgentAdapter {
  readonly name = "fake-pty";
  async getTopology() {
    return { windows: [], generatedAt: "" };
  }
  async listSessions(): Promise<AgentSession[]> {
    return [];
  }
  async readRecentEvents(): Promise<RecentEventsResult> {
    return { events: [], terminal: true };
  }
  async sendInput(): Promise<void> {}
  async sendEnter(): Promise<void> {}
  async interrupt(): Promise<void> {}
}

type Fixture = {
  home: string;
  port: number;
  tasks: TaskStore;
  hooks: HookRegistry;
};

async function withServer(
  run: (ctx: Fixture) => Promise<void>,
  runGh: GhRunner = async () => {
    throw new Error("gh disabled in tests");
  },
  findPr: PrFinder = async () => undefined,
  resolveLocalRepo?: RepoResolver
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "perch-task-events-http-"));
  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  const adapter = new NoopAdapter();
  const monitor = new FleetMonitor(adapter, { broadcastMs: 5 });
  const tasks = new TaskStore(env);
  const timeline = new TimelineStore();
  const hooks = new HookRegistry();
  const options = {
    adapter,
    auditLog: new AuditLog(join(home, "audit.jsonl")),
    authToken: "test-token",
    boxSecretKey: new Uint8Array(32),
    monitor,
    devices: new DeviceRegistry(env),
    port: 0,
    hooks,
    timeline,
    projects: new ProjectRegistry(env),
    worktrees: new WorktreePool({ env }),
    tasks,
    prPoller: new PrPoller(tasks, runGh, { findPr, resolveLocalRepo })
  };
  const server = createControlServer(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run({ home, port, tasks, hooks });
  } finally {
    timeline.stop();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}

function makeProject(home: string, remote = "https://github.com/o/r.git"): string {
  const project = mkdtempSync(join(home, "repo-"));
  execFileSync("git", ["init", "-q", project], { stdio: "pipe" });
  execFileSync("git", ["-C", project, "remote", "add", "origin", remote], { stdio: "pipe" });
  return project;
}

// A project repo with one commit, so the done gate's real resolveHead can read
// the checkout HEAD (the SHA the gate proves the PR carries). Returns the HEAD.
function makeProjectWithCommit(home: string, remote = "https://github.com/o/r.git"): { project: string; head: string } {
  const project = makeProject(home, remote);
  const run = (args: string[]) => execFileSync("git", ["-C", project, ...args], { stdio: "pipe" });
  run(["config", "user.email", "t@t"]);
  run(["config", "user.name", "t"]);
  execFileSync("git", ["-C", project, "commit", "-q", "--allow-empty", "-m", "work"], { stdio: "pipe" });
  const head = execFileSync("git", ["-C", project, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { project, head };
}

function post(port: number, taskId: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/tasks/${taskId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

function decideCompletion(
  port: number,
  taskId: string,
  body: unknown,
  headers: Record<string, string> = { authorization: "Bearer test-token" }
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/tasks/${taskId}/completion`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

const noMistakes = {
  step: "review",
  findings: [{ id: "r1", severity: "error", file: "src/db.ts", action: "ask-user", description: "index drop" }]
};

test("worker summary claiming a missing deliverable requests verification without becoming done", async () => {
  await withServer(async ({ home, port, tasks, hooks }) => {
    const project = makeProject(home);
    const artifact = join(project, "audit.md");
    const task = tasks.create({ title: "write audit artifact", project, kind: "scout" });
    const { token } = hooks.register("pty:worker");
    tasks.update(task.id, { sessionId: "pty:worker" });
    tasks.recordEvent(task.id, { kind: "working", source: "worker" });

    const response = await post(
      port,
      task.id,
      { "x-perch-session": "pty:worker", "x-perch-token": token },
      { kind: "done", message: "Created audit.md with the requested findings." }
    );

    assert.equal(response.status, 200);
    assert.equal(existsSync(artifact), false, "the claimed deliverable is absent");
    assert.equal(tasks.find(task.id)?.state, "completion_requested");
    assert.equal(tasks.events(task.id).at(-1)?.kind, "completion_requested");
  });
});

test("mate accepts the exact completion request and duplicate acceptance is idempotent", async () => {
  await withServer(async ({ port, tasks, hooks }) => {
    const task = tasks.create({ title: "verified scout", project: "/tmp/repo", kind: "scout", prompt: "Return a report" });
    const { token } = hooks.register("pty:worker");
    tasks.update(task.id, { sessionId: "pty:worker" });
    tasks.recordEvent(task.id, { kind: "working", source: "worker" });
    await post(port, task.id, { "x-perch-session": "pty:worker", "x-perch-token": token }, { kind: "done", message: "report" });
    const requestSeq = tasks.events(task.id).at(-1)!.seq;

    const body = { action: "accept", requestSeq, idempotencyKey: "accept-1" };
    const accepted = await decideCompletion(port, task.id, body);
    assert.equal(accepted.status, 200);
    assert.equal(tasks.find(task.id)?.state, "done");
    assert.equal(tasks.events(task.id).at(-1)?.kind, "completion_accepted");

    const duplicate = await decideCompletion(port, task.id, body);
    assert.equal(duplicate.status, 200);
    assert.equal(((await duplicate.json()) as { duplicate?: boolean }).duplicate, true);
    assert.equal(tasks.events(task.id).filter((event) => event.kind === "completion_accepted").length, 1);

    const lateWorker = await post(
      port,
      task.id,
      { "x-perch-session": "pty:worker", "x-perch-token": token },
      { kind: "done", message: "late duplicate claim" }
    );
    assert.equal(lateWorker.status, 409);
    assert.equal(tasks.find(task.id)?.state, "done", "late worker events never reopen trusted done");
  });
});

test("mate rejection persists feedback, returns to working, and duplicate rejection is idempotent", async () => {
  await withServer(async ({ port, tasks, hooks }) => {
    const task = tasks.create({ title: "incomplete scout", project: "/tmp/repo", kind: "scout", prompt: "Create audit.md" });
    const { token } = hooks.register("pty:worker");
    tasks.update(task.id, { sessionId: "pty:worker" });
    tasks.recordEvent(task.id, { kind: "working", source: "worker" });
    await post(port, task.id, { "x-perch-session": "pty:worker", "x-perch-token": token }, { kind: "done", message: "finished" });
    const requestSeq = tasks.events(task.id).at(-1)!.seq;
    const body = {
      action: "reject",
      requestSeq,
      feedback: "audit.md is absent; create it and include the requested evidence",
      idempotencyKey: "reject-1"
    };

    const rejected = await decideCompletion(port, task.id, body);
    assert.equal(rejected.status, 200);
    assert.equal(tasks.find(task.id)?.state, "working");
    const event = tasks.events(task.id).at(-1)!;
    assert.equal(event.kind, "completion_rejected");
    assert.equal(event.message, body.feedback);

    const duplicate = await decideCompletion(port, task.id, body);
    assert.equal(duplicate.status, 200);
    assert.equal(((await duplicate.json()) as { duplicate?: boolean }).duplicate, true);
    assert.equal(tasks.events(task.id).filter((candidate) => candidate.kind === "completion_rejected").length, 1);
  });
});

test("stale completion decisions and worker-authenticated acceptance are rejected", async () => {
  await withServer(async ({ port, tasks, hooks }) => {
    const task = tasks.create({ title: "retry scout", project: "/tmp/repo", kind: "scout" });
    const { token } = hooks.register("pty:worker");
    const workerHeaders = { "x-perch-session": "pty:worker", "x-perch-token": token };
    tasks.update(task.id, { sessionId: "pty:worker" });
    tasks.recordEvent(task.id, { kind: "working", source: "worker" });
    await post(port, task.id, workerHeaders, { kind: "done", message: "first claim" });
    const firstSeq = tasks.events(task.id).at(-1)!.seq;
    await post(port, task.id, workerHeaders, { kind: "done", message: "newer claim" });
    const latestSeq = tasks.events(task.id).at(-1)!.seq;

    const lateWorking = await post(port, task.id, workerHeaders, { kind: "working", message: "late prior-turn event" });
    assert.equal(lateWorking.status, 409);
    assert.equal(tasks.find(task.id)?.state, "completion_requested");

    const stale = await decideCompletion(port, task.id, {
      action: "accept",
      requestSeq: firstSeq,
      idempotencyKey: "stale-accept"
    });
    assert.equal(stale.status, 409);
    assert.equal(tasks.find(task.id)?.state, "completion_requested");

    const unauthorized = await decideCompletion(
      port,
      task.id,
      { action: "accept", requestSeq: latestSeq, idempotencyKey: "worker-accept" },
      workerHeaders
    );
    assert.equal(unauthorized.status, 401);
    assert.equal(tasks.find(task.id)?.state, "completion_requested");
  });
});

test("stale daemon hook credentials are rejected while the current session identity is accepted", async () => {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    await withServer(async ({ port, tasks, hooks }) => {
      const task = tasks.create({ title: "second sequential task", project: "/tmp/repo", kind: "scout" });
      const first = hooks.register("pty:first");
      const second = hooks.register("pty:second");
      tasks.update(task.id, { sessionId: "pty:second" });

      const stale = await post(
        port,
        task.id,
        { "x-perch-session": "pty:first", "x-perch-token": first.token },
        { kind: "working", message: "stale daemon identity" }
      );
      assert.equal(stale.status, 401);
      assert.equal(tasks.find(task.id)?.state, "queued");

      const current = await post(
        port,
        task.id,
        { "x-perch-session": "pty:second", "x-perch-token": second.token },
        { kind: "working", message: "current daemon identity" }
      );
      assert.equal(current.status, 200);
      assert.equal(tasks.find(task.id)?.state, "working");
      assert.ok(
        warnings.some((line) =>
          line.includes(`task-event: rejected status=401 task=${task.id}`) &&
          line.includes("reason=task_session_mismatch")
        ),
        "the hidden curl -f failure remains visible in server.log"
      );
      assert.equal(warnings.some((line) => line.includes(first.token)), false, "hook tokens are never logged");
    });
  } finally {
    console.warn = warn;
  }
});

test("a resumed blocked task accepts current working and done hooks after stale credentials fail", async () => {
  await withServer(async ({ port, tasks, hooks }) => {
    const task = tasks.create({ title: "resumed sequential scout", project: "/tmp/repo", kind: "scout" });
    const stale = hooks.register("pty:stale");
    const current = hooks.register("pty:current");
    tasks.update(task.id, { sessionId: "pty:current" });
    tasks.recordEvent(task.id, {
      kind: "blocked",
      source: "system",
      message: "worker produced no activity since launch",
      data: { reason: "no_launch_activity" }
    });

    const rejected = await post(
      port,
      task.id,
      { "x-perch-session": "pty:stale", "x-perch-token": stale.token },
      { kind: "working", message: "resumed work" }
    );
    assert.equal(rejected.status, 401, "authentication fails before the legal blocked -> working transition");
    assert.equal(tasks.find(task.id)?.state, "blocked");

    const working = await post(
      port,
      task.id,
      { "x-perch-session": "pty:current", "x-perch-token": current.token },
      { kind: "working", message: "resumed work" }
    );
    assert.equal(working.status, 200);
    assert.equal(tasks.find(task.id)?.state, "working");

    const done = await post(
      port,
      task.id,
      { "x-perch-session": "pty:current", "x-perch-token": current.token },
      { kind: "done", message: "resumed report delivered" }
    );
    assert.equal(done.status, 200);
    assert.equal(tasks.find(task.id)?.state, "completion_requested");
    assert.deepEqual(
      tasks.events(task.id).filter((event) => event.kind === "completion_requested").map((event) => event.message),
      ["resumed report delivered"]
    );
  });
});

test("a worker verb with data persists it onto the event verbatim", async () => {
  await withServer(async ({ port, tasks, hooks }) => {
    const task = tasks.create({ title: "gated ship", project: "/tmp/repo", mode: "no-mistakes" });
    const { token } = hooks.register("pty:worker");
    tasks.update(task.id, { sessionId: "pty:worker" });

    const ok = await post(
      port,
      task.id,
      { "x-perch-session": "pty:worker", "x-perch-token": token },
      { kind: "needs_decision", message: "review gate: 1 finding needs you", data: { noMistakes } }
    );
    assert.equal(ok.status, 200);
    const persisted = tasks.events(task.id).find((event) => event.kind === "needs_decision");
    assert.equal(persisted?.source, "worker");
    assert.deepEqual(persisted?.data, { noMistakes });
  });
});

test("completion reports above 4000 characters are preserved byte-for-byte in the event and notification intents", async () => {
  await withServer(async ({ port, tasks, hooks }) => {
    const task = tasks.create({ title: "long scout report", project: "/tmp/repo", kind: "scout" });
    const { token } = hooks.register("pty:worker");
    tasks.update(task.id, { sessionId: "pty:worker" });
    tasks.recordEvent(task.id, { kind: "working", source: "worker" });
    const report = `findings\n${"full report line with unicode café\n".repeat(300)}`;
    assert.ok(report.length > 4_000);
    assert.ok(Buffer.byteLength(report, "utf8") < MAX_TASK_EVENT_MESSAGE_BYTES);

    const response = await post(
      port,
      task.id,
      { "x-perch-session": "pty:worker", "x-perch-token": token },
      { kind: "done", message: report }
    );

    assert.equal(response.status, 200);
    const completion = tasks.events(task.id).at(-1)!;
    assert.equal(completion.kind, "completion_requested");
    assert.equal(completion.message, report);
    const intents = tasks.stateDb.outbox.forTaskEvent(task.id, completion.seq);
    assert.deepEqual(intents.map((intent) => intent.channel).sort(), ["mate", "push"]);
    for (const intent of intents) {
      assert.equal((intent.payload.event as { message?: string }).message, report);
    }
  });
});

test("oversize worker reports are rejected explicitly and atomically for every report verb", async () => {
  await withServer(async ({ port, tasks, hooks }) => {
    const message = "x".repeat(MAX_TASK_EVENT_MESSAGE_BYTES + 1);
    for (const kind of ["needs_decision", "blocked", "done", "failed", "note"] as const) {
      const task = tasks.create({ title: `oversize ${kind}`, project: "/tmp/repo", kind: "scout" });
      const sessionId = `pty:${kind}`;
      const { token } = hooks.register(sessionId);
      tasks.update(task.id, { sessionId });
      tasks.recordEvent(task.id, { kind: "working", source: "worker" });
      const before = tasks.events(task.id).length;

      const response = await post(
        port,
        task.id,
        { "x-perch-session": sessionId, "x-perch-token": token },
        { kind, message }
      );

      assert.equal(response.status, 413);
      const body = (await response.json()) as { error: string };
      assert.match(body.error, /message too large/);
      assert.match(body.error, /resubmit a shorter report or send a supplemental note/);
      assert.equal(tasks.events(task.id).length, before, `${kind} must not write a partial event`);
    }
  });
});

test("data is bounded: over 32 KB is a 400 naming the limit, nothing is written", async () => {
  await withServer(async ({ port, tasks }) => {
    const task = tasks.create({ title: "gated ship", project: "/tmp/repo" });
    const huge = { noMistakes: { step: "review", findings: [{ id: "r1", description: "x".repeat(33 * 1024) }] } };

    const refused = await post(
      port,
      task.id,
      { authorization: "Bearer test-token" },
      { kind: "needs_decision", data: huge }
    );
    assert.equal(refused.status, 400);
    const body = (await refused.json()) as { error: string };
    assert.match(body.error, /data too large/);
    assert.match(body.error, /32768/);
    assert.equal(tasks.events(task.id).some((event) => event.kind === "needs_decision"), false);
  });
});

test("non-object data is a 400; omitting data keeps the old wire shape working", async () => {
  await withServer(async ({ port, tasks }) => {
    const task = tasks.create({ title: "gated ship", project: "/tmp/repo" });
    const bearer = { authorization: "Bearer test-token" };

    for (const data of ["prose", 7, ["a"], null]) {
      const refused = await post(port, task.id, bearer, { kind: "note", data });
      assert.equal(refused.status, 400, `data=${JSON.stringify(data)} must be refused`);
      const body = (await refused.json()) as { error: string };
      assert.match(body.error, /data must be a JSON object/);
    }

    const plain = await post(port, task.id, bearer, { kind: "working", message: "no data field" });
    assert.equal(plain.status, 200);
    const working = tasks.events(task.id).find((event) => event.kind === "working");
    assert.ok(working && !("data" in working));
  });
});

test("done with an already-merged PR from the wrong branch is rejected before task.pr attaches", async () => {
  await withServer(
    async ({ home, port, tasks, hooks }) => {
      const project = makeProject(home);
      const task = tasks.create({ title: "ship identity check", project });
      const { token } = hooks.register("pty:worker");
      tasks.update(task.id, { sessionId: "pty:worker", branch: "perch/expected" });
      tasks.recordEvent(task.id, { kind: "working", source: "worker" });

      const refused = await post(
        port,
        task.id,
        { "x-perch-session": "pty:worker", "x-perch-token": token },
        { kind: "done", message: "merged elsewhere https://github.com/o/r/pull/44" }
      );

      assert.equal(refused.status, 409);
      const body = (await refused.json()) as { error: string };
      assert.match(body.error, /head branch/);
      const current = tasks.find(task.id);
      assert.equal(current?.state, "working");
      assert.equal(current?.pr, undefined);
      assert.equal(tasks.events(task.id).some((event) => event.kind === "done"), false);
    },
    async () => ({
      state: "MERGED",
      mergedAt: "2026-07-09T00:00:00Z",
      headRefName: "perch/unrelated",
      headRepository: { nameWithOwner: "o/r" }
    })
  );
});

test("remote ship modes keep the normal matching-PR attachment path", async () => {
  await withServer(
    async ({ home, port, tasks, hooks }) => {
      const project = makeProject(home);
      for (const mode of ["direct-PR", "no-mistakes"] as const) {
        const sessionId = `pty:${mode}`;
        const task = tasks.create({ title: `ship matching pr via ${mode}`, project, mode });
        const { token } = hooks.register(sessionId);
        tasks.update(task.id, { sessionId, branch: "perch/expected" });
        tasks.recordEvent(task.id, { kind: "working", source: "worker" });

        const accepted = await post(
          port,
          task.id,
          { "x-perch-session": sessionId, "x-perch-token": token },
          { kind: "done", message: "ready https://github.com/o/r/pull/45" }
        );

        assert.equal(accepted.status, 200, mode);
        const current = tasks.find(task.id);
        assert.equal(current?.state, "completion_requested", mode);
        assert.equal(current?.pr?.url, "https://github.com/o/r/pull/45", mode);
        assert.equal(current?.pr?.repo, "o/r", mode);
        assert.equal(current?.pr?.headRepo, "o/r", mode);
        assert.equal(current?.pr?.head, "perch/expected", mode);
      }
    },
    async () => ({
      state: "OPEN",
      headRefName: "perch/expected",
      headRepository: { nameWithOwner: "o/r" }
    })
  );
});

test("worker pr_linked persists a canonical fact before completion, exposes it immediately, and is idempotent", async () => {
  let checkoutHead = "";
  await withServer(
    async ({ home, port, tasks, hooks }) => {
      const { project, head } = makeProjectWithCommit(home);
      checkoutHead = head;
      const task = tasks.create({ title: "show PR while the gate runs", project, mode: "direct-PR" });
      const { token } = hooks.register("pty:worker");
      const headers = { "x-perch-session": "pty:worker", "x-perch-token": token };
      tasks.update(task.id, { sessionId: "pty:worker", branch: "perch/show-pr-now" });
      tasks.recordEvent(task.id, { kind: "working", source: "worker" });

      const bearerOnly = await post(
        port,
        task.id,
        { authorization: "Bearer test-token" },
        { kind: "pr_linked", pr: "https://github.com/o/r/pull/62" }
      );
      assert.equal(bearerOnly.status, 401);
      assert.match((await bearerOnly.json() as { error: string }).error, /task-session credentials/);

      const proseOnly = await post(port, task.id, headers, {
        kind: "pr_linked",
        message: "opened https://github.com/o/r/pull/62"
      });
      assert.equal(proseOnly.status, 400);
      assert.match((await proseOnly.json() as { error: string }).error, /pr is required/);
      assert.equal(tasks.find(task.id)?.pr, undefined, "ordinary worker prose never attaches a PR");

      const link = await post(port, task.id, headers, {
        kind: "pr_linked",
        pr: "https://github.com/O/R/pull/62/?ignored=1"
      });
      assert.equal(link.status, 200);
      const linked = (await link.json()) as { task: { state: string; presentation?: { state: string }; pr?: { url: string; number?: number; repo?: string; headOid?: string } } };
      assert.equal(linked.task.state, "working");
      assert.equal(linked.task.presentation?.state, "working");
      assert.equal(linked.task.pr?.url, "https://github.com/o/r/pull/62");
      assert.equal(linked.task.pr?.number, 62);
      assert.equal(linked.task.pr?.repo, "o/r");
      assert.equal(linked.task.pr?.headOid, checkoutHead);

      const detail = await fetch(`http://127.0.0.1:${port}/tasks/${task.id}`, {
        headers: { authorization: "Bearer test-token" }
      });
      const detailBody = (await detail.json()) as { task: { state: string; pr?: { number?: number }; }; events: Array<{ kind: string; data?: { pr?: { number?: number } } }> };
      assert.equal(detailBody.task.state, "working");
      assert.equal(detailBody.task.pr?.number, 62);
      const prEvent = detailBody.events.find((event) => event.kind === "pr_linked");
      assert.equal(prEvent?.data?.pr?.number, 62);
      assert.deepEqual(
        tasks.stateDb.outbox.forTaskEvent(task.id, tasks.events(task.id).find((event) => event.kind === "pr_linked")!.seq)
          .map((intent) => intent.channel)
          .sort(),
        ["mate", "push"]
      );

      const duplicate = await post(port, task.id, headers, { kind: "pr_linked", pr: "https://github.com/o/r/pull/62" });
      assert.equal(duplicate.status, 200);
      assert.equal(tasks.events(task.id).filter((event) => event.kind === "pr_linked").length, 1);

      const conflicting = await post(port, task.id, headers, { kind: "pr_linked", pr: "https://github.com/o/r/pull/63" });
      assert.equal(conflicting.status, 409);
      assert.match((await conflicting.json() as { error: string }).error, /already linked/);
      assert.equal(tasks.find(task.id)?.state, "working");

      const unauthorized = await post(
        port,
        task.id,
        { "x-perch-session": "pty:worker", "x-perch-token": "wrong" },
        { kind: "pr_linked", pr: "https://github.com/o/r/pull/62" }
      );
      assert.equal(unauthorized.status, 401);

      const completion = await post(port, task.id, headers, { kind: "done", pr: "https://github.com/o/r/pull/62", message: "checks still running" });
      assert.equal(completion.status, 200);
      assert.equal(tasks.find(task.id)?.state, "completion_requested");
      assert.equal(tasks.events(task.id).filter((event) => event.kind === "pr_linked").length, 1);
    },
    async () => ({
      state: "OPEN",
      headRefName: "perch/show-pr-now",
      headRefOid: checkoutHead,
      headRepository: { nameWithOwner: "o/r" }
    })
  );
});

test("no-mistakes pr_linked accepts the task branch before branch_sync but completion remains head-pinned", async () => {
  let prHead = "pipeline-head";
  await withServer(
    async ({ home, port, tasks, hooks }) => {
      const { project } = makeProjectWithCommit(home);
      const task = tasks.create({ title: "link gate PR early", project, mode: "no-mistakes" });
      const { token } = hooks.register("pty:worker");
      const headers = { "x-perch-session": "pty:worker", "x-perch-token": token };
      tasks.update(task.id, { sessionId: "pty:worker", branch: "perch/link-gate-pr-early" });
      tasks.recordEvent(task.id, { kind: "working", source: "worker" });

      const linked = await post(port, task.id, headers, { kind: "pr_linked", pr: "https://github.com/o/r/pull/64" });
      assert.equal(linked.status, 200);
      assert.equal(tasks.find(task.id)?.state, "working");
      assert.equal(tasks.find(task.id)?.pr?.headOid, "pipeline-head");

      const prematureDone = await post(port, task.id, headers, { kind: "done", pr: "https://github.com/o/r/pull/64" });
      assert.equal(prematureDone.status, 409);
      assert.match((await prematureDone.json() as { error: string }).error, /does not match checkout HEAD/);
      assert.equal(tasks.find(task.id)?.state, "working");

      execFileSync("git", ["-C", project, "commit", "-q", "--allow-empty", "-m", "branch sync"], { stdio: "pipe" });
      prHead = execFileSync("git", ["-C", project, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

      const completed = await post(port, task.id, headers, { kind: "done" });
      assert.equal(completed.status, 200);
      assert.equal(tasks.find(task.id)?.state, "completion_requested");
      assert.equal(tasks.find(task.id)?.pr?.headOid, prHead);
      assert.equal(tasks.events(task.id).filter((event) => event.kind === "pr_linked").length, 1);
    },
    async () => ({
      state: "OPEN",
      headRefName: "perch/link-gate-pr-early",
      headRefOid: prHead,
      headRepository: { nameWithOwner: "o/r" }
    })
  );
});

test("done revalidates an early-linked PR after it has merged", async () => {
  let checkoutHead = "";
  await withServer(
    async ({ home, port, tasks, hooks }) => {
      const { project, head } = makeProjectWithCommit(home);
      checkoutHead = head;
      const task = tasks.create({ title: "validate merged linked PR", project, mode: "no-mistakes" });
      const { token } = hooks.register("pty:worker");
      const headers = { "x-perch-session": "pty:worker", "x-perch-token": token };
      tasks.update(task.id, { sessionId: "pty:worker", branch: "perch/validate-merged" });
      tasks.recordEvent(task.id, { kind: "working", source: "worker" });

      const linked = await post(port, task.id, headers, {
        kind: "pr_linked",
        pr: "https://github.com/o/r/pull/65"
      });
      assert.equal(linked.status, 200);
      tasks.update(task.id, { pr: { ...tasks.find(task.id)!.pr!, merged: true } });
      execFileSync("git", ["-C", project, "commit", "-q", "--allow-empty", "-m", "unpublished work"], { stdio: "pipe" });

      const refused = await post(port, task.id, headers, { kind: "done" });
      assert.equal(refused.status, 409);
      assert.match((await refused.json() as { error: string }).error, /does not match checkout HEAD/);
      assert.equal(tasks.find(task.id)?.state, "working");
    },
    async () => ({
      state: "MERGED",
      mergedAt: "2026-07-23T00:00:00Z",
      headRefName: "perch/validate-merged",
      headRefOid: checkoutHead,
      headRepository: { nameWithOwner: "o/r" }
    })
  );
});

test("local-only done requests completion without resolving a GitHub repo", async () => {
  let repoResolutions = 0;
  await withServer(
    async ({ home, port, tasks, hooks }) => {
      const project = mkdtempSync(join(home, "local-only-"));
      const task = tasks.create({ title: "commit local work", project, mode: "local-only" });
      const { token } = hooks.register("pty:worker");
      tasks.update(task.id, { sessionId: "pty:worker", branch: "perch/local-only" });
      tasks.recordEvent(task.id, { kind: "working", source: "worker" });

      const accepted = await post(
        port,
        task.id,
        { "x-perch-session": "pty:worker", "x-perch-token": token },
        { kind: "done", message: "committed the requested work locally" }
      );

      assert.equal(accepted.status, 200);
      assert.equal(repoResolutions, 0, "local-only completion must not inspect GitHub remotes");
      assert.equal(tasks.find(task.id)?.state, "completion_requested");
      assert.equal(tasks.find(task.id)?.pr, undefined);
      assert.equal(tasks.events(task.id).at(-1)?.kind, "completion_requested");
    },
    undefined,
    undefined,
    async () => {
      repoResolutions += 1;
      return "o/r";
    }
  );
});

test("done with a reused-branch PR is accepted when its head commit is the checkout HEAD", async () => {
  // Reproduces the orchestrator bug: a worker briefed to reuse an existing
  // branch/PR delivers on head `feature/pre-existing`, not the auto-assigned
  // task branch. The done report used to 409 (head != task branch); it must now
  // be accepted because the PR head commit equals the worker's checkout HEAD,
  // and the actual PR (url/head) must be recorded for downstream polling.
  let checkoutHead = "";
  await withServer(
    async ({ home, port, tasks, hooks }) => {
      const { project, head } = makeProjectWithCommit(home);
      checkoutHead = head;
      const task = tasks.create({ title: "ship reused branch", project });
      const { token } = hooks.register("pty:worker");
      tasks.update(task.id, { sessionId: "pty:worker", branch: "perch/auto-assigned" });
      tasks.recordEvent(task.id, { kind: "working", source: "worker" });

      const accepted = await post(
        port,
        task.id,
        { "x-perch-session": "pty:worker", "x-perch-token": token },
        { kind: "done", message: "reused the existing PR https://github.com/o/r/pull/48" }
      );

      assert.equal(accepted.status, 200);
      const current = tasks.find(task.id);
      assert.equal(current?.state, "completion_requested");
      assert.equal(current?.pr?.url, "https://github.com/o/r/pull/48");
      assert.equal(current?.pr?.head, "feature/pre-existing");
      assert.equal(current?.pr?.headOid, checkoutHead);
      assert.equal(current?.pr?.repo, "o/r");
    },
    async () => ({
      state: "OPEN",
      headRefName: "feature/pre-existing",
      headRefOid: checkoutHead,
      headRepository: { nameWithOwner: "o/r" }
    })
  );
});

test("done with a reused-branch PR that lacks the worker's commits is still rejected", async () => {
  // The gate is not weakened into accepting arbitrary same-repo URLs: a reused
  // branch whose head commit is NOT the checkout HEAD carries no proof of the
  // worker's work and must 409.
  let checkoutHead = "";
  await withServer(
    async ({ home, port, tasks, hooks }) => {
      const { project, head } = makeProjectWithCommit(home);
      checkoutHead = head;
      const task = tasks.create({ title: "ship stale reuse", project });
      const { token } = hooks.register("pty:worker");
      tasks.update(task.id, { sessionId: "pty:worker", branch: "perch/auto-assigned" });
      tasks.recordEvent(task.id, { kind: "working", source: "worker" });

      const refused = await post(
        port,
        task.id,
        { "x-perch-session": "pty:worker", "x-perch-token": token },
        { kind: "done", message: "wrong pr https://github.com/o/r/pull/49" }
      );

      assert.equal(refused.status, 409);
      assert.match((await refused.json() as { error: string }).error, /does not match checkout HEAD/);
      const current = tasks.find(task.id);
      assert.equal(current?.state, "working");
      assert.equal(current?.pr, undefined);
    },
    async () => ({
      state: "OPEN",
      headRefName: "feature/pre-existing",
      headRefOid: "0000000000000000000000000000000000000000",
      headRepository: { nameWithOwner: "o/r" }
    })
  );
});

test("no-mistakes done rejects a pipeline-owned newer PR head until guarded sync advances the checkout", async () => {
  let pipelineHead = "";
  await withServer(
    async ({ home, port, tasks, hooks }) => {
      const { project, head: workerHead } = makeProjectWithCommit(home);
      execFileSync("git", ["-C", project, "commit", "-q", "--allow-empty", "-m", "pipeline review fix"], {
        stdio: "pipe"
      });
      pipelineHead = execFileSync("git", ["-C", project, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      execFileSync("git", ["-C", project, "reset", "--hard", workerHead], { stdio: "pipe" });

      const task = tasks.create({ title: "ship through no-mistakes", project, mode: "no-mistakes" });
      const { token } = hooks.register("pty:worker");
      const headers = { "x-perch-session": "pty:worker", "x-perch-token": token };
      const done = { kind: "done", message: "green checks https://github.com/o/r/pull/50" };
      tasks.update(task.id, { sessionId: "pty:worker", branch: "perch/gated" });
      tasks.recordEvent(task.id, { kind: "working", source: "worker" });

      const stale = await post(port, task.id, headers, done);
      assert.equal(stale.status, 409);
      const staleBody = (await stale.json()) as { error: string };
      assert.match(staleBody.error, new RegExp(`PR head commit ${pipelineHead} does not match checkout HEAD ${workerHead}`));
      assert.equal(tasks.find(task.id)?.state, "working");
      assert.equal(tasks.find(task.id)?.pr, undefined);

      // Simulate the guarded `no-mistakes axi sync` advancing the checkout to
      // the pipeline-owned PR head without weakening the endpoint's OID check.
      execFileSync("git", ["-C", project, "reset", "--hard", pipelineHead], { stdio: "pipe" });

      const accepted = await post(port, task.id, headers, done);
      assert.equal(accepted.status, 200);
      const acceptedBody = (await accepted.json()) as { task: { state: string } };
      assert.equal(acceptedBody.task.state, "completion_requested");
      assert.equal(tasks.find(task.id)?.state, "completion_requested");
      assert.equal(tasks.find(task.id)?.pr?.headOid, pipelineHead);
      assert.equal(tasks.events(task.id).at(-1)?.kind, "completion_requested");
    },
    async () => ({
      state: "OPEN",
      headRefName: "perch/gated",
      headRefOid: pipelineHead,
      headRepository: { nameWithOwner: "o/r" }
    })
  );
});

test("URL-less done deterministically binds the task branch before arming PR polling", async () => {
  await withServer(
    async ({ home, port, tasks, hooks }) => {
      const project = makeProject(home);
      const task = tasks.create({ title: "ship matching pr", project });
      const { token } = hooks.register("pty:worker");
      tasks.update(task.id, { sessionId: "pty:worker", branch: "perch/deterministic" });
      tasks.recordEvent(task.id, { kind: "working", source: "worker" });

      const accepted = await post(
        port,
        task.id,
        { "x-perch-session": "pty:worker", "x-perch-token": token },
        { kind: "done", message: "shipped" }
      );

      assert.equal(accepted.status, 200);
      const current = tasks.find(task.id);
      assert.equal(current?.state, "completion_requested");
      assert.equal(current?.pr?.url, "https://github.com/o/r/pull/46");
      assert.equal(current?.pr?.head, "perch/deterministic");
    },
    async () => ({
      state: "OPEN",
      headRefName: "perch/deterministic",
      headRepository: { nameWithOwner: "o/r" }
    }),
    async (repo, branch) => {
      assert.equal(repo, "o/r");
      assert.equal(branch, "perch/deterministic");
      return ["https://github.com/o/r/pull/46"];
    }
  );
});

test("URL-less done refuses to claim completion until the deterministic branch has one PR", async () => {
  await withServer(
    async ({ home, port, tasks, hooks }) => {
      const project = makeProject(home);
      const task = tasks.create({ title: "ship matching pr", project });
      const { token } = hooks.register("pty:worker");
      tasks.update(task.id, { sessionId: "pty:worker", branch: "perch/not-pushed" });
      tasks.recordEvent(task.id, { kind: "working", source: "worker" });

      const refused = await post(
        port,
        task.id,
        { "x-perch-session": "pty:worker", "x-perch-token": token },
        { kind: "done", message: "shipped" }
      );

      assert.equal(refused.status, 409);
      assert.match((await refused.json() as { error: string }).error, /no pull request found/);
      assert.equal(tasks.find(task.id)?.state, "working");
    },
    async () => undefined,
    async () => []
  );
});

test("scout done accepts its terminal report without PR binding in every ship mode, then closes", async () => {
  await withServer(async ({ port, tasks }) => {
    for (const mode of ["direct-PR", "no-mistakes", "local-only"] as const) {
      const task = tasks.create({ title: `scout ${mode}`, project: "/tmp/repo", kind: "scout", mode });
      tasks.update(task.id, { branch: `perch/scout-${mode}` });
      tasks.recordEvent(task.id, { kind: "working", source: "worker" });

      const done = await post(
        port,
        task.id,
        { authorization: "Bearer test-token" },
        {
          kind: "done",
          message:
            mode === "direct-PR"
              ? "report references https://github.com/o/r/pull/999 but delivers no code"
              : `report for ${mode}`
        }
      );

      assert.equal(done.status, 200, `${mode} scout report must not require a PR`);
      assert.equal(tasks.find(task.id)?.state, "completion_requested");
      assert.equal(tasks.find(task.id)?.pr, undefined);

      const requestSeq = tasks.events(task.id).at(-1)!.seq;
      const accepted = await decideCompletion(port, task.id, {
        action: "accept",
        requestSeq,
        idempotencyKey: `accept-scout-${mode}`
      });
      assert.equal(accepted.status, 200);
      assert.equal(tasks.find(task.id)?.state, "done");

      const closed = await fetch(`http://127.0.0.1:${port}/tasks/${task.id}/teardown`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: "{}"
      });
      assert.equal(closed.status, 200);
      assert.equal(tasks.find(task.id)?.state, "closed");
      assert.deepEqual(
        tasks.events(task.id).slice(-3).map((event) => event.kind),
        ["completion_accepted", "landed", "closed"]
      );
    }
  });
});
