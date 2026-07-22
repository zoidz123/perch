import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  claudeRowModel,
  codexRowThreadSettings,
  normalizeClaudeRow,
  normalizeCodexRow,
  TimelineStore
} from "./timeline.js";

function seqCounter(): () => number {
  let seq = 0;
  return () => {
    seq += 1;
    return seq;
  };
}

test("normalizes user prompts, assistant text, tool calls, and tool results", () => {
  const next = seqCounter();

  const user = normalizeClaudeRow(
    "pty:1",
    {
      type: "user",
      uuid: "u1",
      timestamp: "2026-07-01T00:00:00Z",
      message: { role: "user", content: "fix the tests" }
    },
    next
  );
  assert.equal(user.length, 1);
  assert.equal(user[0]?.kind, "user");
  assert.equal(user[0]?.text, "fix the tests");

  const assistant = normalizeClaudeRow(
    "pty:1",
    {
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-07-01T00:00:01Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "On it." },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }
        ]
      }
    },
    next
  );
  assert.equal(assistant.length, 2);
  assert.equal(assistant[0]?.kind, "assistant");
  assert.equal(assistant[1]?.kind, "tool_call");
  assert.equal(assistant[1]?.tool?.name, "Bash");
  assert.equal(assistant[1]?.tool?.input, "npm test");

  const result = normalizeClaudeRow(
    "pty:1",
    {
      type: "user",
      uuid: "r1",
      timestamp: "2026-07-01T00:00:02Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "42 passing" }] }]
      }
    },
    next
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]?.kind, "tool_result");
  assert.equal(result[0]?.text, "42 passing");

  const seqs = [...user, ...assistant, ...result].map((item) => item.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4]);
});

test("skips synthetic user rows, meta rows, and unknown shapes", () => {
  const next = seqCounter();
  const rows: Array<Record<string, unknown>> = [
    { type: "user", message: { content: "<system-reminder>noise</system-reminder>" } },
    { type: "user", isMeta: true, message: { content: "meta" } },
    { type: "summary", summary: "compacted" },
    { type: "progress" },
    { garbage: true }
  ];
  for (const row of rows) {
    assert.equal(normalizeClaudeRow("pty:1", row, next).length, 0, JSON.stringify(row));
  }
});

test("tailer picks up appended rows and survives malformed lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perch-tl-"));
  const transcript = join(dir, "session.jsonl");
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: "user", uuid: "u1", timestamp: "t", message: { content: "first" } })}\n`
  );

  const store = new TimelineStore();
  const received: string[] = [];
  store.subscribe((item) => received.push(item.text ?? item.tool?.name ?? ""));

  store.attach("pty:1", transcript);
  // The initial backfill is fetchable history, never listener fan-out.
  assert.equal(store.fetch("pty:1", 0, 10).items[0]?.text, "first");
  assert.deepEqual(received, []);

  appendFileSync(transcript, "not-json\n");
  appendFileSync(
    transcript,
    `${JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "t", message: { content: [{ type: "text", text: "second" }] } })}\n`
  );
  await waitFor(() => received.length >= 1);
  assert.deepEqual(received, ["second"]);

  const page = store.fetch("pty:1", 0, 10);
  assert.equal(page.items.length, 2);
  assert.equal(page.lastSeq, 2);
  const afterFirst = store.fetch("pty:1", 1, 10);
  assert.equal(afterFirst.items.length, 1);
  assert.equal(afterFirst.items[0]?.text, "second");

  // Non-numeric query params fall back to the defaults instead of NaN.
  const nanPage = store.fetch("pty:1", Number("abc"), Number("xyz"));
  assert.equal(nanPage.items.length, 2);
  assert.equal(nanPage.lastSeq, 2);

  store.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("transcript appearing after attach backfills without listener fan-out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perch-tl-late-"));
  const transcript = join(dir, "session.jsonl");

  const store = new TimelineStore();
  const received: string[] = [];
  const observed: string[] = [];
  store.subscribe((item) => received.push(item.text ?? ""));
  store.observe((item) => observed.push(item.text ?? ""));

  // Attach before the file exists (SessionStart racing transcript creation);
  // the history written moments later must not replay as live frames.
  store.attach("pty:1", transcript);
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: "user", uuid: "u1", timestamp: "t", message: { content: "old1" } })}\n` +
      `${JSON.stringify({ type: "user", uuid: "u2", timestamp: "t", message: { content: "old2" } })}\n`
  );

  await waitFor(() => store.fetch("pty:1", 0, 10).items.length >= 2);
  assert.deepEqual(received, []);
  assert.deepEqual(observed, ["old1", "old2"]);

  appendFileSync(
    transcript,
    `${JSON.stringify({ type: "user", uuid: "u3", timestamp: "t", message: { content: "live" } })}\n`
  );
  await waitFor(() => received.length >= 1);
  assert.deepEqual(received, ["live"]);
  assert.deepEqual(observed, ["old1", "old2", "live"]);

  store.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("catch-up waits for an unterminated transcript row to finish", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perch-tl-partial-catchup-"));
  const transcript = join(dir, "session.jsonl");
  const row = JSON.stringify({
    type: "user",
    uuid: "partial-user",
    timestamp: new Date().toISOString(),
    message: { content: "complete me" }
  });
  writeFileSync(transcript, row.slice(0, -2));
  const store = new TimelineStore();
  const caughtUp: string[] = [];
  store.observeCatchUp((sessionId) => caughtUp.push(sessionId));
  try {
    store.attach("pty:partial", transcript);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(caughtUp, []);
    appendFileSync(transcript, `${row.slice(-2)}\n`);
    await waitFor(() => caughtUp.length === 1);
    assert.deepEqual(caughtUp, ["pty:partial"]);
  } finally {
    store.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lastActivityAt ignores user rows and reports the last worker-produced row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perch-tl-activity-"));
  const transcript = join(dir, "session.jsonl");
  // The server-injected kickoff prompt lands as a user row at submission; it
  // proves nothing about the worker, so it must not read as activity.
  writeFileSync(
    transcript,
    `${JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2026-07-13T00:00:00Z",
      message: { content: "PERCH TASK BRIEF kickoff" }
    })}\n`
  );

  const store = new TimelineStore();
  store.attach("pty:1", transcript);
  await waitFor(() => store.fetch("pty:1", 0, 10).items.length >= 1);
  assert.equal(store.lastActivityAt("pty:1"), undefined);

  appendFileSync(
    transcript,
    `${JSON.stringify({
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-07-13T00:00:05Z",
      message: { content: [{ type: "text", text: "on it" }] }
    })}\n`
  );
  await waitFor(() => store.fetch("pty:1", 0, 10).items.length >= 2);
  assert.equal(store.lastActivityAt("pty:1"), Date.parse("2026-07-13T00:00:05Z"));

  // A later user row (e.g. a queued composer message) never masks how long the
  // worker itself has been quiet.
  appendFileSync(
    transcript,
    `${JSON.stringify({
      type: "user",
      uuid: "u2",
      timestamp: "2026-07-13T00:10:00Z",
      message: { content: "are you still there?" }
    })}\n`
  );
  await waitFor(() => store.fetch("pty:1", 0, 10).items.length >= 3);
  assert.equal(store.lastActivityAt("pty:1"), Date.parse("2026-07-13T00:00:05Z"));

  store.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("tailer never reads a transcript the path guard rejects", () => {
  const dir = mkdtempSync(join(tmpdir(), "perch-tl-guard-"));
  const transcript = join(dir, "session.jsonl");
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: "user", uuid: "u1", timestamp: "t", message: { content: "secret" } })}\n`
  );

  const store = new TimelineStore();
  store.attach("pty:1", transcript, () => false);
  assert.equal(store.fetch("pty:1", 0, 10).items.length, 0);

  store.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition not met in time");
}

function claudeUser(uuid: string, text: string): string {
  return `${JSON.stringify({ type: "user", uuid, timestamp: "2026-07-18T00:00:00Z", message: { role: "user", content: text } })}\n`;
}

function claudeAssistant(uuid: string, text: string): string {
  return `${JSON.stringify({ type: "assistant", uuid, timestamp: "2026-07-18T00:00:00Z", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;
}

function textsFor(store: TimelineStore, sessionId: string): string[] {
  return store
    .fetch(sessionId, 0, 500)
    .items.map((item) => item.text)
    .filter((text): text is string => typeof text === "string");
}

// Freeze reproduction: a plain tailer follows only the file it attached to.
// When Claude resumes and forks into a new jsonl, the resumed-from file goes
// quiet and every post-resume row lands in the fork the tailer never opens.
test("without re-resolution a resumed Claude timeline freezes at the resume boundary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perch-resume-freeze-"));
  const resumedFrom = join(dir, "resumed-from.jsonl");
  writeFileSync(resumedFrom, claudeUser("root-1", "kickoff") + claudeAssistant("pre-1", "before resume"));

  const store = new TimelineStore();
  store.attach("pty:freeze", resumedFrom);
  await waitFor(() => textsFor(store, "pty:freeze").includes("before resume"));

  // Claude forks: new turns go to a brand-new file, never the attached one.
  const fork = join(dir, "fork.jsonl");
  writeFileSync(
    fork,
    claudeUser("root-1", "kickoff") + claudeAssistant("pre-1", "before resume") + claudeAssistant("post-1", "after resume")
  );
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(textsFor(store, "pty:freeze").includes("after resume"), false);
  store.stop();
  rmSync(dir, { recursive: true, force: true });
});

// The fix: followClaudeResume re-resolves the newest lineage descendant in the
// project dir and re-points the tailer, so post-resume rows surface. The fork
// replays the resumed-from rows verbatim (same uuids), so re-attaching to the
// full fork re-emits nothing from before the resume.
test("followClaudeResume re-attaches to the forked transcript and surfaces post-resume rows", async () => {
  const previous = process.env.PERCH_RESUME_SCAN_MS;
  process.env.PERCH_RESUME_SCAN_MS = "30";
  const dir = mkdtempSync(join(tmpdir(), "perch-resume-fix-"));
  const resumedFrom = join(dir, "resumed-from.jsonl");
  writeFileSync(resumedFrom, claudeUser("root-1", "kickoff") + claudeAssistant("pre-1", "before resume"));
  // The resumed-from file is frozen at resume; force its mtime into the past so
  // the later fork is unambiguously newer regardless of filesystem resolution.
  utimesSync(resumedFrom, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

  const store = new TimelineStore();
  try {
    store.followClaudeResume("pty:fix");
    store.attach("pty:fix", resumedFrom);
    await waitFor(() => textsFor(store, "pty:fix").includes("before resume"));
    assert.equal(textsFor(store, "pty:fix").includes("after resume"), false);

    // Claude forks: replayed prefix (same uuids) plus the live post-resume turn.
    const fork = join(dir, "fork.jsonl");
    writeFileSync(
      fork,
      claudeUser("root-1", "kickoff") + claudeAssistant("pre-1", "before resume") + claudeAssistant("post-1", "after resume")
    );

    await waitFor(() => textsFor(store, "pty:fix").includes("after resume"));
    const texts = textsFor(store, "pty:fix");
    // The replayed prefix dedups by uuid: exactly one copy of the pre-resume row.
    assert.equal(texts.filter((text) => text === "before resume").length, 1);
    assert.equal(texts.filter((text) => text === "after resume").length, 1);
  } finally {
    store.stop();
    rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PERCH_RESUME_SCAN_MS;
    else process.env.PERCH_RESUME_SCAN_MS = previous;
  }
});

// Lineage safety: a concurrent unrelated session writing a newer file in the
// same project dir must never be adopted. Confirmation is by the shared root
// message uuid, not mtime alone.
test("followClaudeResume ignores an unrelated newer session in the same dir", async () => {
  const previous = process.env.PERCH_RESUME_SCAN_MS;
  process.env.PERCH_RESUME_SCAN_MS = "30";
  const dir = mkdtempSync(join(tmpdir(), "perch-resume-lineage-"));
  const resumedFrom = join(dir, "resumed-from.jsonl");
  writeFileSync(resumedFrom, claudeUser("root-1", "kickoff") + claudeAssistant("pre-1", "before resume"));
  utimesSync(resumedFrom, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

  const store = new TimelineStore();
  try {
    store.followClaudeResume("pty:lineage");
    store.attach("pty:lineage", resumedFrom);
    await waitFor(() => textsFor(store, "pty:lineage").includes("before resume"));

    // A different conversation (different root uuid), newer, same directory.
    const unrelated = join(dir, "unrelated.jsonl");
    writeFileSync(unrelated, claudeUser("other-root", "different chat") + claudeAssistant("other-1", "unrelated reply"));

    // Give the resolver several scan intervals to (wrongly) adopt it.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(textsFor(store, "pty:lineage").includes("unrelated reply"), false);
  } finally {
    store.stop();
    rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PERCH_RESUME_SCAN_MS;
    else process.env.PERCH_RESUME_SCAN_MS = previous;
  }
});

test("normalizes codex rollout rows: messages, tool calls, outputs", () => {
  const next = seqCounter();
  const user = normalizeCodexRow(
    "pty:1",
    { timestamp: "t1", type: "event_msg", payload: { type: "user_message", message: "fix the bug" } },
    next
  );
  assert.equal(user.length, 1);
  assert.equal(user[0]?.kind, "user");
  assert.equal(user[0]?.text, "fix the bug");

  const agent = normalizeCodexRow(
    "pty:1",
    { timestamp: "t2", type: "event_msg", payload: { type: "agent_message", message: "On it." } },
    next
  );
  assert.equal(agent[0]?.kind, "assistant");

  const call = normalizeCodexRow(
    "pty:1",
    {
      timestamp: "t3",
      type: "response_item",
      payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"npm test","workdir":"/x"}' }
    },
    next
  );
  assert.equal(call[0]?.kind, "tool_call");
  assert.equal(call[0]?.tool?.name, "exec_command");
  assert.equal(call[0]?.tool?.input, "npm test");

  const output = normalizeCodexRow(
    "pty:1",
    {
      timestamp: "t4",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "c1",
        output: "Chunk ID: x\nWall time: 0.1\nOutput:\n42 passing"
      }
    },
    next
  );
  assert.equal(output[0]?.kind, "tool_result");
  assert.equal(output[0]?.text, "42 passing");

  // Noise rows yield nothing; ids are stable across re-reads.
  assert.equal(
    normalizeCodexRow("pty:1", { type: "response_item", payload: { type: "reasoning" } }, next).length,
    0
  );
  assert.equal(
    normalizeCodexRow("pty:1", { type: "event_msg", payload: { type: "token_count" } }, next).length,
    0
  );
  const again = normalizeCodexRow(
    "pty:1",
    { timestamp: "t1", type: "event_msg", payload: { type: "user_message", message: "fix the bug" } },
    next
  );
  assert.equal(again[0]?.id, user[0]?.id);
});

test("parses both authoritative codex settings rows with model and effort kept separate", () => {
  const settingsRow = (thread_settings: Record<string, unknown>) => ({
    timestamp: "2026-07-15T17:21:29.220Z",
    type: "event_msg",
    payload: { type: "thread_settings_applied", thread_settings }
  });
  const turnContextRow = (payload: Record<string, unknown>) => ({
    timestamp: "2026-07-15T20:03:44.928Z",
    type: "turn_context",
    payload
  });

  assert.deepEqual(codexRowThreadSettings(settingsRow({ reasoning_effort: "medium" })), { effort: "medium" });
  assert.deepEqual(codexRowThreadSettings(settingsRow({ model: "gpt-5.6-terra", reasoning_effort: "xhigh" })), {
    model: "gpt-5.6-terra",
    effort: "xhigh"
  });
  assert.deepEqual(codexRowThreadSettings(turnContextRow({ model: "gpt-5.6-sol", effort: "medium" })), {
    model: "gpt-5.6-sol",
    effort: "medium"
  });
  assert.deepEqual(codexRowThreadSettings(turnContextRow({ effort: "high" })), { effort: "high" });
  assert.deepEqual(codexRowThreadSettings(settingsRow({ model: " gpt-5.6-sol " })), { model: "gpt-5.6-sol" });
  assert.deepEqual(codexRowThreadSettings(settingsRow({ model: "gpt-5.6-sol", reasoning_effort: "turbo" })), {
    model: "gpt-5.6-sol"
  });
  assert.equal(codexRowThreadSettings(turnContextRow({ effort: "turbo" })), undefined);
  assert.equal(codexRowThreadSettings(settingsRow({ reasoning_effort: 42 })), undefined);
  assert.equal(codexRowThreadSettings({ type: "event_msg", payload: { type: "token_count" } }), undefined);
});

test("codex settings tailing accepts only the expected rollout thread and includes catch-up rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perch-tl-codex-settings-"));
  const matching = join(dir, "matching.jsonl");
  const mismatched = join(dir, "mismatched.jsonl");
  const settingsRow = (effort: string) => ({
    timestamp: "t1",
    type: "event_msg",
    payload: {
      type: "thread_settings_applied",
      thread_settings: { model: "gpt-5.6-sol", reasoning_effort: effort }
    }
  });
  const turnContextRow = (effort: string) => ({
    timestamp: "t2",
    type: "turn_context",
    payload: { model: "gpt-5.6-sol", effort }
  });
  writeFileSync(
    matching,
    `${JSON.stringify({ timestamp: "t0", type: "session_meta", payload: { id: "thread-live" } })}\n` +
      `${JSON.stringify(settingsRow("medium"))}\n`
  );
  writeFileSync(
    mismatched,
    `${JSON.stringify({ timestamp: "t0", type: "session_meta", payload: { id: "thread-stale" } })}\n` +
      `${JSON.stringify(settingsRow("high"))}\n`
  );

  const store = new TimelineStore();
  const observed: string[] = [];
  store.subscribeCodexThreadSettings((sessionId, threadId, settings) => {
    observed.push(`${sessionId}:${threadId}:${settings.model ?? "-"}:${settings.effort ?? "-"}`);
  });

  store.attach("pty:live", matching, () => true, "codex", "thread-live");
  await waitFor(() => observed.length === 1);
  assert.deepEqual(observed, ["pty:live:thread-live:gpt-5.6-sol:medium"]);

  store.attach("pty:stale", mismatched, () => true, "codex", "thread-live");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(observed.length, 1, "a rollout whose session_meta id differs is rejected");

  appendFileSync(mismatched, `${JSON.stringify(turnContextRow("medium"))}\n`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(observed.length, 1, "a turn_context row from a stale thread is rejected too");

  appendFileSync(matching, `${JSON.stringify(turnContextRow("medium"))}\n`);
  await waitFor(() => observed.length === 2);
  assert.equal(observed[1], observed[0], "remote turn_context converges to the same canonical settings");

  appendFileSync(matching, `${JSON.stringify(turnContextRow("medium"))}\n`);
  await waitFor(() => observed.length === 3);
  assert.equal(observed[2], observed[1], "duplicate settings are harmless canonical updates");

  store.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("normalizer stamps user source only when the resolver returns one", () => {
  const next = seqCounter();
  const resolve = (text: string) => (text === "steer" ? ("agent" as const) : undefined);

  const steer = normalizeClaudeRow(
    "pty:1",
    { type: "user", uuid: "u1", timestamp: "t", message: { content: "steer" } },
    next,
    resolve
  );
  assert.equal(steer[0]?.source, "agent");

  const typed = normalizeClaudeRow(
    "pty:1",
    { type: "user", uuid: "u2", timestamp: "t", message: { content: "typed" } },
    next,
    resolve
  );
  // Absent, not "human": clients render absent as human (the safe default).
  assert.equal(typed[0]?.source, undefined);

  // Assistant rows never consult the resolver.
  const assistant = normalizeClaudeRow(
    "pty:1",
    { type: "assistant", uuid: "a1", timestamp: "t", message: { content: [{ type: "text", text: "steer" }] } },
    next,
    resolve
  );
  assert.equal(assistant[0]?.source, undefined);
});

test("codex normalizer stamps user source from the resolver", () => {
  const next = seqCounter();
  const user = normalizeCodexRow(
    "pty:1",
    { timestamp: "t", type: "event_msg", payload: { type: "user_message", message: "run tests" } },
    next,
    () => "agent"
  );
  assert.equal(user[0]?.source, "agent");
});

test("recorded agent injection is correlated onto its tailed user row; humans default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perch-tl-src-"));
  const transcript = join(dir, "session.jsonl");
  const store = new TimelineStore();

  // The mate steers a worker (POST /sessions/:id/input) before the transcript
  // row it produces tails back in.
  store.recordSource("pty:1", "run the tests again", "agent");

  writeFileSync(
    transcript,
    `${JSON.stringify({ type: "user", uuid: "u1", timestamp: "t", message: { content: "run the tests again" } })}\n` +
      `${JSON.stringify({ type: "user", uuid: "u2", timestamp: "t", message: { content: "actually never mind" } })}\n`
  );
  store.attach("pty:1", transcript);

  await waitFor(() => store.fetch("pty:1", 0, 10).items.length >= 2);
  const items = store.fetch("pty:1", 0, 10).items;
  assert.equal(items[0]?.source, "agent", "the injected turn is attributed to the agent");
  assert.equal(items[1]?.source, undefined, "an unmatched turn stays human");

  store.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("a truncated transcript row still prefix-matches the fuller injection; match consumed once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perch-tl-src2-"));
  const transcript = join(dir, "session.jsonl");
  const store = new TimelineStore();

  // Dispatch injects prompt + a large brief; the tailed row is only its prefix.
  store.recordSource("pty:1", "open the PR now with all the extra brief details", "agent");

  writeFileSync(
    transcript,
    `${JSON.stringify({ type: "user", uuid: "u1", timestamp: "t", message: { content: "open the PR now" } })}\n` +
      `${JSON.stringify({ type: "user", uuid: "u2", timestamp: "t", message: { content: "open the PR now" } })}\n`
  );
  store.attach("pty:1", transcript);

  await waitFor(() => store.fetch("pty:1", 0, 10).items.length >= 2);
  const items = store.fetch("pty:1", 0, 10).items;
  assert.equal(items[0]?.source, "agent", "the prefix of the injection matches");
  assert.equal(items[1]?.source, undefined, "the entry is consumed once, so a repeat turn defaults to human");

  store.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("claudeRowModel reads assistant models and rejects synthetic/user rows", () => {
  assert.equal(
    claudeRowModel({ type: "assistant", message: { model: "claude-fable-5" } }),
    "claude-fable-5"
  );
  assert.equal(claudeRowModel({ type: "assistant", message: { model: "<synthetic>" } }), undefined);
  assert.equal(claudeRowModel({ type: "assistant", message: { model: "  " } }), undefined);
  assert.equal(claudeRowModel({ type: "assistant", message: {} }), undefined);
  assert.equal(claudeRowModel({ type: "user", message: { model: "claude-fable-5" } }), undefined);
});

test("model listener fires on tailed claude assistant rows, backfill included", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perch-tl-model-"));
  const transcript = join(dir, "session.jsonl");
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "t", message: { model: "claude-opus-4-8", content: [{ type: "text", text: "hi" }] } })}\n`
  );

  const store = new TimelineStore();
  const models: string[] = [];
  store.subscribeModel((sessionId, model) => models.push(`${sessionId}:${model}`));

  store.attach("pty:1", transcript);
  // Backfill rows report too: after a tailer re-attach the last row is still
  // the session's current model.
  await waitFor(() => models.length >= 1);
  assert.deepEqual(models, ["pty:1:claude-opus-4-8"]);

  appendFileSync(
    transcript,
    `${JSON.stringify({ type: "assistant", uuid: "a2", timestamp: "t", message: { model: "claude-fable-5", content: [{ type: "text", text: "switched" }] } })}\n` +
      `${JSON.stringify({ type: "assistant", uuid: "a3", timestamp: "t", message: { model: "<synthetic>", content: [{ type: "text", text: "err" }] } })}\n`
  );
  await waitFor(() => models.length >= 2);
  assert.deepEqual(models, ["pty:1:claude-opus-4-8", "pty:1:claude-fable-5"]);

  store.stop();
  rmSync(dir, { recursive: true, force: true });
});
