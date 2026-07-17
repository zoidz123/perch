import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  claudeSettingsPath,
  codexHookHash,
  findCodexRollout,
  HookRegistry,
  installClaudeHooks,
  installCodexHooks,
  isAllowedTranscriptPath,
  normalizeHookEvent
} from "./hooks.js";

function makeEnv(settings?: object): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "perch-hooks-"));
  if (settings) {
    writeFileSync(join(dir, "settings.json"), JSON.stringify(settings, null, 2));
  }
  return { CLAUDE_CONFIG_DIR: dir };
}

test("installs hook entries for every event, idempotently, preserving user hooks", () => {
  const env = makeEnv({
    theme: "dark",
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "echo user-stop-hook" }] }]
    }
  });

  assert.equal(installClaudeHooks(env), true);
  const first = JSON.parse(readFileSync(claudeSettingsPath(env), "utf8"));

  // User settings and hooks survive.
  assert.equal(first.theme, "dark");
  const stopCommands = first.hooks.Stop.flatMap((entry: { hooks: Array<{ command: string }> }) =>
    entry.hooks.map((hook) => hook.command)
  );
  assert.ok(stopCommands.some((command: string) => command.includes("echo user-stop-hook")));
  assert.ok(stopCommands.some((command: string) => command.includes("$PERCH_HOOK_URL")));

  // Every perch event is present and env-gated.
  for (const event of ["SessionStart", "UserPromptSubmit", "PermissionRequest", "Stop"]) {
    const entries = first.hooks[event] ?? [];
    const perch = entries.filter((entry: { hooks: Array<{ command: string }> }) =>
      entry.hooks.some((hook) => hook.command.includes("$PERCH_HOOK_URL"))
    );
    assert.equal(perch.length, 1, event);
    assert.match(perch[0].hooks[0].command, /PERCH_SESSION_ID/);
  }

  // Second run changes nothing.
  assert.equal(installClaudeHooks(env), true);
  const second = JSON.parse(readFileSync(claudeSettingsPath(env), "utf8"));
  assert.deepEqual(second, first);

  rmSync(env.CLAUDE_CONFIG_DIR as string, { recursive: true, force: true });
});

test("SessionStart and Stop echo structured responses while other hooks stay silent", () => {
  // A pre-existing install with the old shared command (which discarded the
  // /hooks response body for every event, SessionStart included).
  const oldCommand =
    '[ -z "$PERCH_SESSION_ID" ] || curl -sf --max-time 3 -X POST "$PERCH_HOOK_URL" ' +
    '-H "content-type: application/json" -H "x-perch-session: $PERCH_SESSION_ID" ' +
    '-H "x-perch-token: $PERCH_HOOK_TOKEN" --data-binary @- >/dev/null 2>&1; exit 0';
  const env = makeEnv({
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: oldCommand, timeout: 10 }] }] }
  });

  assert.equal(installClaudeHooks(env), true);
  const settings = JSON.parse(readFileSync(claudeSettingsPath(env), "utf8"));

  // Exactly one perch SessionStart entry: the old command was upgraded in
  // place, not duplicated.
  const perchStart = settings.hooks.SessionStart.filter((entry: { hooks: Array<{ command: string }> }) =>
    entry.hooks.some((hook) => hook.command.includes("$PERCH_HOOK_URL"))
  );
  assert.equal(perchStart.length, 1);
  const startCommand: string = perchStart[0].hooks[0].command;
  // SessionStart echoes the response body (the capability note) to stdout,
  // still gated and fail-silent: only stderr is discarded.
  assert.ok(!startCommand.includes(">/dev/null 2>&1"));
  assert.match(startCommand, /@- 2>\/dev\/null; exit 0$/);
  assert.match(startCommand, /PERCH_SESSION_ID/);
  const perchStop = settings.hooks.Stop.filter((entry: { hooks: Array<{ command: string }> }) =>
    entry.hooks.some((hook) => hook.command.includes("$PERCH_HOOK_URL"))
  );
  assert.equal(perchStop.length, 1);
  const stopCommand: string = perchStop[0].hooks[0].command;
  assert.ok(!stopCommand.includes(">/dev/null 2>&1"));
  assert.match(stopCommand, /@- 2>\/dev\/null; exit 0$/);

  // Hooks without structured response semantics keep discarding output.
  for (const event of ["UserPromptSubmit", "PreToolUse", "SessionEnd"]) {
    const perch = settings.hooks[event].filter((entry: { hooks: Array<{ command: string }> }) =>
      entry.hooks.some((hook) => hook.command.includes("$PERCH_HOOK_URL"))
    );
    assert.equal(perch.length, 1, event);
    assert.ok(perch[0].hooks[0].command.includes(">/dev/null 2>&1"), event);
  }

  // Second run changes nothing.
  assert.equal(installClaudeHooks(env), true);
  assert.deepEqual(JSON.parse(readFileSync(claudeSettingsPath(env), "utf8")), settings);

  rmSync(env.CLAUDE_CONFIG_DIR as string, { recursive: true, force: true });
});

test("rewriting settings preserves the original file mode", () => {
  const env = makeEnv({ theme: "dark" });
  chmodSync(claudeSettingsPath(env), 0o600);

  assert.equal(installClaudeHooks(env), true);
  assert.equal(statSync(claudeSettingsPath(env)).mode & 0o777, 0o600);

  rmSync(env.CLAUDE_CONFIG_DIR as string, { recursive: true, force: true });
});

test("transcript containment holds through symlinks inside the projects dir", () => {
  const env = makeEnv();
  const root = env.CLAUDE_CONFIG_DIR as string;
  const projects = join(root, "projects");
  mkdirSync(projects, { recursive: true });
  const outside = mkdtempSync(join(tmpdir(), "perch-escape-"));
  writeFileSync(join(outside, "secret.jsonl"), "{}");

  assert.equal(isAllowedTranscriptPath(join(projects, "repo", "session.jsonl"), env), true);
  assert.equal(isAllowedTranscriptPath(join(root, "outside.jsonl"), env), false);
  assert.equal(isAllowedTranscriptPath(join(outside, "secret.jsonl"), env), false);

  // A symlinked directory escaping the root, and a direct symlinked file.
  symlinkSync(outside, join(projects, "link"));
  assert.equal(isAllowedTranscriptPath(join(projects, "link", "secret.jsonl"), env), false);
  symlinkSync(join(outside, "secret.jsonl"), join(projects, "direct.jsonl"));
  assert.equal(isAllowedTranscriptPath(join(projects, "direct.jsonl"), env), false);

  // A dangling symlink (outside target created only AFTER the check) must
  // also fail: its real target is unknowable at check time.
  symlinkSync(join(outside, "later.jsonl"), join(projects, "dangling.jsonl"));
  assert.equal(isAllowedTranscriptPath(join(projects, "dangling.jsonl"), env), false);
  writeFileSync(join(outside, "later.jsonl"), "{}");
  assert.equal(isAllowedTranscriptPath(join(projects, "dangling.jsonl"), env), false);

  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("leaves an unparseable settings file untouched", () => {
  const env = makeEnv();
  writeFileSync(claudeSettingsPath(env), "{not json");
  assert.equal(installClaudeHooks(env), false);
  assert.equal(readFileSync(claudeSettingsPath(env), "utf8"), "{not json");
  rmSync(env.CLAUDE_CONFIG_DIR as string, { recursive: true, force: true });
});

test("hook registry verifies per-session tokens and correlates transcripts", () => {
  const registry = new HookRegistry();
  const { token } = registry.register("pty:1");

  assert.equal(registry.verify("pty:1", token), true);
  assert.equal(registry.verify("pty:2", token), false);
  assert.equal(registry.verify("pty:1", "wrong"), false);

  registry.correlate("pty:1", "claude-abc", "/tmp/session.jsonl");
  assert.equal(registry.correlation("pty:1")?.transcriptPath, "/tmp/session.jsonl");

  registry.unregister("pty:1");
  assert.equal(registry.verify("pty:1", token), false);
});

test("normalizes hook events into status transitions and approvals", () => {
  assert.equal(normalizeHookEvent({ hook_event_name: "UserPromptSubmit" }).status, "running");
  assert.equal(normalizeHookEvent({ hook_event_name: "PreToolUse" }).status, "running");
  assert.equal(normalizeHookEvent({ hook_event_name: "Stop" }).status, "idle");
  assert.equal(normalizeHookEvent({ hook_event_name: "SessionEnd" }).status, "idle");

  const start = normalizeHookEvent({
    hook_event_name: "SessionStart",
    session_id: "claude-1",
    transcript_path: "/tmp/t.jsonl"
  });
  assert.equal(start.correlation?.agentSessionId, "claude-1");
  assert.equal(start.correlation?.transcriptPath, "/tmp/t.jsonl");

  const permission = normalizeHookEvent({
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "git push origin main" }
  });
  assert.equal(permission.status, "needs_approval");
  assert.equal(permission.approval?.command, "git push origin main");
  assert.match(permission.approval?.summary ?? "", /Bash/);

  // Non-approval notifications stay quiet.
  assert.equal(normalizeHookEvent({ hook_event_name: "Notification", message: "compacting" }).approval, undefined);
  // "Waiting for input" is attention, never an approval gate (a gated
  // composer would deadlock queued messages).
  const idlePrompt = normalizeHookEvent({
    hook_event_name: "Notification",
    message: "Claude is waiting for your input"
  });
  assert.equal(idlePrompt.status, "waiting");
  assert.equal(idlePrompt.approval, undefined);
  const permissionNote = normalizeHookEvent({
    hook_event_name: "Notification",
    message: "Claude needs your permission to use Bash"
  });
  assert.equal(permissionNote.status, "needs_approval");
  assert.ok(permissionNote.approval);

  assert.deepEqual(normalizeHookEvent({ hook_event_name: "SomethingNew" }).status, undefined);
});

test("codex hook hash matches the codex-rs fingerprint formula", () => {
  // Vector cross-checked against a real trusted_hash that codex itself wrote
  // for a PreToolUse entry: identity JSON -> sorted compact -> sha256.
  const hash = codexHookHash("pre_tool_use", "echo hi", 10);
  const expected = createHash("sha256")
    .update('{"event_name":"pre_tool_use","hooks":[{"async":false,"command":"echo hi","timeout":10,"type":"command"}]}')
    .digest("hex");
  assert.equal(hash, `sha256:${expected}`);
});

test("codex hook installer is idempotent and writes trust hashes", () => {
  const home = mkdtempSync(join(tmpdir(), "perch-codex-"));
  const env = { CODEX_HOME: home } as NodeJS.ProcessEnv;
  writeFileSync(join(home, "config.toml"), "[features]\nmemories = true\n");

  assert.equal(installCodexHooks(env), true);
  const first = readFileSync(join(home, "hooks.json"), "utf8");
  const config = readFileSync(join(home, "config.toml"), "utf8");
  assert.match(config, /hooks = true # perch-codex/);
  assert.match(config, /perch-codex-trust begin/);
  assert.match(config, /hooks\.state\."[^"]+:session_start:0:0"/);
  assert.match(config, /trusted_hash = "sha256:[0-9a-f]{64}"/);

  // Re-run: no drift.
  assert.equal(installCodexHooks(env), true);
  assert.equal(readFileSync(join(home, "hooks.json"), "utf8"), first);
  assert.equal(readFileSync(join(home, "config.toml"), "utf8"), config);

  // User hooks survive and shift perch's trust index.
  const parsed = JSON.parse(readFileSync(join(home, "hooks.json"), "utf8"));
  parsed.hooks.SessionStart.unshift({ hooks: [{ type: "command", command: "user-hook" }] });
  writeFileSync(join(home, "hooks.json"), JSON.stringify(parsed));
  assert.equal(installCodexHooks(env), true);
  const reconfig = readFileSync(join(home, "config.toml"), "utf8");
  assert.match(reconfig, /session_start:1:0/);
  rmSync(home, { recursive: true, force: true });
});

test("codex installer maintains the perch block in ~/.codex/AGENTS.md", () => {
  const home = mkdtempSync(join(tmpdir(), "perch-codex-agents-"));
  const env = { CODEX_HOME: home } as NodeJS.ProcessEnv;

  assert.equal(installCodexHooks(env), true);
  const agents = readFileSync(join(home, "AGENTS.md"), "utf8");
  assert.match(agents, /<!-- perch begin -->/);
  assert.match(agents, /<!-- perch end -->/);
  // The block's FIRST line self-gates on PERCH_SESSION_ID.
  const afterBegin = agents.slice(agents.indexOf("<!-- perch begin -->\n") + "<!-- perch begin -->\n".length);
  assert.ok(afterBegin.startsWith("This perch-managed block applies ONLY when PERCH_SESSION_ID is set"));
  // The note points at the served authoring guide and the register curl.
  assert.match(agents, /\$\{PERCH_HOOK_URL%\/hooks\}\/charts\/authoring/);
  assert.match(agents, /\.charts\/<slug>\.html/);

  // Re-run: no drift.
  assert.equal(installCodexHooks(env), true);
  assert.equal(readFileSync(join(home, "AGENTS.md"), "utf8"), agents);

  rmSync(home, { recursive: true, force: true });
});

test("codex AGENTS.md block upgrades stale content and preserves user text outside the markers", () => {
  const home = mkdtempSync(join(tmpdir(), "perch-codex-agents-up-"));
  const env = { CODEX_HOME: home } as NodeJS.ProcessEnv;
  writeFileSync(
    join(home, "AGENTS.md"),
    "# My global rules\n\n<!-- perch begin -->\nan old perch note\n<!-- perch end -->\n\nTrailing user text.\n"
  );

  assert.equal(installCodexHooks(env), true);
  const agents = readFileSync(join(home, "AGENTS.md"), "utf8");
  // User text on both sides of the block survives byte-for-byte.
  assert.ok(agents.startsWith("# My global rules\n\n<!-- perch begin -->"));
  assert.match(agents, /<!-- perch end -->\n\nTrailing user text\.\n$/);
  // The stale block content was replaced, and only one block exists.
  assert.ok(!agents.includes("an old perch note"));
  assert.equal((agents.match(/<!-- perch begin -->/g) ?? []).length, 1);
  assert.match(agents, /charts\/authoring/);

  rmSync(home, { recursive: true, force: true });
});

test("codex AGENTS.md block leaves an orphaned begin marker untouched", () => {
  const home = mkdtempSync(join(tmpdir(), "perch-codex-agents-orphan-"));
  const env = { CODEX_HOME: home } as NodeJS.ProcessEnv;
  const original = "# My global rules\n\n<!-- perch begin -->\nUser text after an orphaned marker.\n";
  writeFileSync(join(home, "AGENTS.md"), original);

  assert.equal(installCodexHooks(env), true);
  assert.equal(readFileSync(join(home, "AGENTS.md"), "utf8"), original);
  assert.match(readFileSync(join(home, "config.toml"), "utf8"), /perch-codex-trust begin/);
  assert.ok(JSON.parse(readFileSync(join(home, "hooks.json"), "utf8")).hooks.SessionStart);

  rmSync(home, { recursive: true, force: true });
});

test("codex AGENTS.md write failure does not block trust persistence", () => {
  const home = mkdtempSync(join(tmpdir(), "perch-codex-agents-fail-"));
  const env = { CODEX_HOME: home } as NodeJS.ProcessEnv;
  const original = "# My global rules\n";
  writeFileSync(join(home, "AGENTS.md"), original);
  mkdirSync(join(home, "AGENTS.md.perch-tmp"));

  assert.equal(installCodexHooks(env), true);
  assert.equal(readFileSync(join(home, "AGENTS.md"), "utf8"), original);
  assert.match(readFileSync(join(home, "config.toml"), "utf8"), /perch-codex-trust begin/);
  assert.ok(JSON.parse(readFileSync(join(home, "hooks.json"), "utf8")).hooks.SessionStart);

  rmSync(home, { recursive: true, force: true });
});

test("codex hook installer reuses a [features] header with a trailing comment", () => {
  const home = mkdtempSync(join(tmpdir(), "perch-codex-cmt-"));
  const env = { CODEX_HOME: home } as NodeJS.ProcessEnv;
  writeFileSync(join(home, "config.toml"), "[ features ] # user notes\nmemories = true\n");

  assert.equal(installCodexHooks(env), true);
  const config = readFileSync(join(home, "config.toml"), "utf8");
  // The flag lands inside the existing table; no second [features] is defined.
  assert.match(config, /hooks = true # perch-codex/);
  assert.equal((config.match(/^[ \t]*\[[ \t]*features[ \t]*\]/gm) ?? []).length, 1);
  rmSync(home, { recursive: true, force: true });
});

test("codex hook installer respects hooks = false", () => {
  const home = mkdtempSync(join(tmpdir(), "perch-codex-off-"));
  writeFileSync(join(home, "config.toml"), "[features]\nhooks = false\n");
  assert.equal(installCodexHooks({ CODEX_HOME: home } as NodeJS.ProcessEnv), false);
  rmSync(home, { recursive: true, force: true });
});

test("codex hook payloads normalize through the nested envelope", () => {
  const start = normalizeHookEvent({
    session_id: "0199-abc",
    cwd: "/tmp",
    hook_event: { event_type: "session_start" }
  });
  assert.equal(start.status, "idle");
  assert.equal(start.correlation?.agentSessionId, "0199-abc");

  const permission = normalizeHookEvent({
    session_id: "0199-abc",
    hook_event: { event_type: "permission_request", tool_name: "exec_command", command: "rm -rf /tmp/x" }
  });
  assert.equal(permission.status, "needs_approval");
  assert.equal(permission.approval?.command, "rm -rf /tmp/x");
  assert.equal(normalizeHookEvent({ hook_event: { event_type: "stop" } }).status, "idle");
});

test("findCodexRollout locates rollouts by session id in date dirs", () => {
  const home = mkdtempSync(join(tmpdir(), "perch-codex-roll-"));
  const now = new Date();
  const day = join(
    home,
    "sessions",
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  );
  mkdirSync(day, { recursive: true });
  const file = join(day, "rollout-2026-07-02T10-00-00-0199ffff-aaaa-bbbb.jsonl");
  writeFileSync(file, "");
  const env = { CODEX_HOME: home } as NodeJS.ProcessEnv;
  assert.equal(findCodexRollout("0199ffff-aaaa-bbbb", env), file);
  assert.equal(findCodexRollout("missing", env), undefined);
  rmSync(home, { recursive: true, force: true });
});

test("findCodexRollout searches days back for older sessions", () => {
  const home = mkdtempSync(join(tmpdir(), "perch-codex-roll-"));
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
  const day = join(
    home,
    "sessions",
    String(twoDaysAgo.getFullYear()),
    String(twoDaysAgo.getMonth() + 1).padStart(2, "0"),
    String(twoDaysAgo.getDate()).padStart(2, "0")
  );
  mkdirSync(day, { recursive: true });
  const file = join(day, "rollout-2026-06-30T10-00-00-0199ffff-cccc-dddd.jsonl");
  writeFileSync(file, "");
  const env = { CODEX_HOME: home } as NodeJS.ProcessEnv;
  assert.equal(findCodexRollout("0199ffff-cccc-dddd", env), file);
  rmSync(home, { recursive: true, force: true });
});
