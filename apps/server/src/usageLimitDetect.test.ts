import assert from "node:assert/strict";
import { test } from "node:test";
import { detectUsageLimit, usageLimitFromClaudeHook } from "./usageLimitDetect.js";

// The real codex out-of-credits line, as it prints it and then sits there.
const CODEX_LIMIT =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage " +
  "to purchase more credits or try again at 3:28 PM.";

function screen(...lines: string[]): string {
  // A bottom-anchored TUI: the limit line sits under a screenful of prior
  // output and blank padding rows.
  return [...lines].join("\n");
}

test("detects the codex usage-limit line with its retry time", () => {
  const limit = detectUsageLimit(
    screen("some earlier agent output", "", CODEX_LIMIT, ""),
    "codex"
  );
  assert.ok(limit);
  assert.equal(limit.provider, "codex");
  assert.equal(limit.retryAt, "3:28 PM");
  assert.match(limit.message, /hit your usage limit/);
});

test("detects the codex limit even when the TUI prefixes it with a notice bullet", () => {
  // The exact shape captured from a live out-of-credits codex worker at startup:
  // a `■ ` notice bullet prefix and the line wrapped so the retry time lands on
  // the next row. A bare `^you've` anchor missed this and left the task working.
  const limit = detectUsageLimit(
    screen(
      "• SessionStart hook (completed)",
      "",
      "■ You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at",
      "8:29 PM.",
      "",
      "› Write tests for @filename"
    ),
    "codex"
  );
  assert.ok(limit);
  assert.equal(limit.provider, "codex");
  assert.equal(limit.retryAt, "8:29 PM");
  // The reported note drops the bullet and reads as the CLI's own sentence.
  assert.match(limit.message, /^You've hit your usage limit/);
});

test("codex line with no retry time still detects (hard credit stop)", () => {
  const limit = detectUsageLimit(
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits.",
    "codex"
  );
  assert.ok(limit);
  assert.equal(limit.provider, "codex");
  assert.equal(limit.retryAt, undefined);
});

test("detects the claude usage-limit line and its reset time", () => {
  const resets = detectUsageLimit("Claude usage limit reached ∙ resets 3pm", "claude");
  assert.ok(resets);
  assert.equal(resets.provider, "claude");
  assert.equal(resets.retryAt, "3pm");

  const resetAt = detectUsageLimit(
    "Claude AI usage limit reached. Your limit will reset at 3pm (America/New_York).",
    "claude"
  );
  assert.ok(resetAt);
  assert.match(resetAt.retryAt ?? "", /3pm/);
});

test("does not fire on a worker merely discussing usage limits", () => {
  // Prose that talks about limits but is not the CLI's own error formatting.
  assert.equal(
    detectUsageLimit(
      screen(
        "Let me handle the case where you've hit your usage limit gracefully.",
        "I'll add a note about purchase more credits flows to the docs."
      ),
      "codex"
    ),
    undefined,
    "no anchor URL / exact frame -> no detection"
  );
  assert.equal(
    detectUsageLimit("We should warn the user when approaching usage limit.", "claude"),
    undefined,
    "soft 'approaching usage limit' is not 'usage limit reached'"
  );
});

test("a limit line scrolled far above the window is ignored", () => {
  const noise = Array<string>(40).fill("normal output line");
  assert.equal(detectUsageLimit(screen(CODEX_LIMIT, ...noise), "codex"), undefined);
});

test("only matches the agent whose CLI printed it", () => {
  // The codex line under a claude session is not the claude CLI's own error.
  assert.equal(detectUsageLimit(CODEX_LIMIT, "claude"), undefined);
  assert.equal(detectUsageLimit(CODEX_LIMIT, undefined), undefined);
  assert.equal(detectUsageLimit(CODEX_LIMIT, "shell"), undefined);
});

test("Claude hook requires a structured usage-limit code", () => {
  assert.deepEqual(
    usageLimitFromClaudeHook({ notification_type: "usage_limit", message: "Claude limit reached", reset_at: "3pm" }),
    { provider: "claude", message: "Claude limit reached", source: "hook", retryAt: "3pm" }
  );
  assert.equal(usageLimitFromClaudeHook({ notification_type: "idle_prompt", message: "usage limit reached" }), undefined);
});
