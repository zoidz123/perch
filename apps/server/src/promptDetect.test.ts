import assert from "node:assert/strict";
import { test } from "node:test";
import { detectPrompt } from "./promptDetect.js";

// The 2.1.205 model-switch confirm, transcribed from the real TUI, including
// the blank rows it pads between the dialog and its bottom-anchored input box.
const MODEL_SWITCH = [
  "  Something the agent said a moment ago.",
  "",
  "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔",
  "   Switch model?",
  "   Your next response will be slower and use more tokens",
  "",
  "   This conversation is cached for the current model. Switching to Sonnet 5",
  "   means the full history gets re-read on your next message.",
  "",
  "   ❯ 1. Yes, switch to Sonnet 5",
  "     2. No, go back",
  ...Array<string>(18).fill(""),
  "╭──────────────────────────────────────────╮",
  "│ > Try \"fix the failing test\"             │",
  "╰──────────────────────────────────────────╯"
].join("\n");

// A boxed permission dialog: the same frame, drawn inside borders.
const PERMISSION = [
  "╭──────────────────────────────────────────╮",
  "│ Bash command                             │",
  "│                                          │",
  "│ npm test                                 │",
  "│ Run the test suite                       │",
  "│                                          │",
  "│ Do you want to proceed?                  │",
  "│ ❯ 1. Yes                                 │",
  "│   2. Yes, and don't ask again this session│",
  "│   3. No, and tell Claude what to do      │",
  "╰──────────────────────────────────────────╯"
].join("\n");

test("a confirm frame is recognized and titled by the question it asks", () => {
  const prompt = detectPrompt(MODEL_SWITCH, "claude");
  assert.ok(prompt, "the model-switch confirm is a prompt");
  assert.equal(prompt.summary, "Switch model?");
  assert.deepEqual(prompt.options, ["Yes, switch to Sonnet 5", "No, go back"]);
});

test("a boxed permission dialog is recognized through its borders", () => {
  const prompt = detectPrompt(PERMISSION, "claude");
  assert.ok(prompt);
  assert.equal(prompt.summary, "Do you want to proceed?");
  assert.equal(prompt.options.length, 3);
  assert.equal(prompt.options[0], "Yes");
  assert.equal(prompt.decisions, undefined, "Claude keeps its verified generic Allow / Deny path");
});

test("the id survives cursor movement but not a different dialog", () => {
  const onFirst = detectPrompt(MODEL_SWITCH, "claude");
  const onSecond = detectPrompt(
    MODEL_SWITCH.replace("   ❯ 1. Yes", "     1. Yes").replace("     2. No", "   ❯ 2. No"),
    "claude"
  );
  assert.ok(onFirst && onSecond);
  assert.equal(onSecond.id, onFirst.id, "arrowing to option 2 is the same dialog");

  const other = detectPrompt(PERMISSION, "claude");
  assert.notEqual(other?.id, onFirst.id);
});

test("numbered lines without the cursor glyph are not a prompt", () => {
  const output = [
    "Here is the plan:",
    "  1. install the deps",
    "  2. run the tests",
    "  3. ship it",
    "Done."
  ].join("\n");
  assert.equal(detectPrompt(output, "claude"), undefined);
});

test("a cursor that is not on an option is not a prompt", () => {
  const shell = ["❯ npm test", "1. one failed", "2. two passed"].join("\n");
  assert.equal(detectPrompt(shell, "claude"), undefined);
});

test("a code block with numbered lines beneath a shell prompt is not a prompt", () => {
  const code = [
    "❯ cat -n server.ts",
    "     1) const port = 4000;",
    "     2) listen(port);"
  ].join("\n");
  // Two contiguous numbered lines, but the cursor sits on neither.
  assert.equal(detectPrompt(code, "claude"), undefined);
});

test("a single option, a numbering gap, or a broken block is not a prompt", () => {
  assert.equal(detectPrompt("Proceed?\n❯ 1. Yes", "claude"), undefined, "one option is not a choice");
  assert.equal(detectPrompt("Proceed?\n❯ 1. Yes\n  3. No", "claude"), undefined, "numbering must run 1..n");
  assert.equal(
    detectPrompt("Proceed?\n❯ 1. Yes\nsome prose\n2. No", "claude"),
    undefined,
    "the options must be one block"
  );
});

test("a dialog scrolled off the bottom of the screen is not a prompt", () => {
  const scrolled = [MODEL_SWITCH, ...Array<string>(13).fill("the agent kept talking")].join("\n");
  assert.equal(detectPrompt(scrolled, "claude"), undefined);
});

test("only Claude's frame is claimed", () => {
  assert.equal(detectPrompt(MODEL_SWITCH, "codex"), undefined);
  assert.equal(detectPrompt(MODEL_SWITCH, undefined), undefined);
});

test("Codex recognizes the live four-choice Computer Use field prompt with exact choices", () => {
  const computerUse = [
    "Field 1/1",
    'Allow Computer Use to use "Xcode"?',
    "App: Xcode",
    "› 1. Allow                   Run the tool and continue.",
    "  2. Allow for this session  Run the tool and remember this choice for this session.",
    "  3. Always allow            Run the tool and remember this choice for future tool calls.",
    "  4. Cancel                  Cancel this tool call",
    "enter to submit | esc to cancel"
  ].join("\n");
  const prompt = detectPrompt(computerUse, "codex");
  assert.ok(prompt);
  assert.equal(prompt.summary, 'Allow Computer Use to use "Xcode"?');
  assert.deepEqual(prompt.context, { app: "Xcode", tool: "Computer Use" });
  assert.deepEqual(
    prompt.decisions?.map(({ id, label, persistence, destructive }) => ({ id, label, persistence, destructive })),
    [
      { id: "allow", label: "Allow", persistence: "turn", destructive: undefined },
      { id: "allow_session", label: "Allow for this session", persistence: "session", destructive: undefined },
      { id: "allow_always", label: "Always allow", persistence: "always", destructive: undefined },
      { id: "cancel", label: "Cancel", persistence: undefined, destructive: true }
    ]
  );
  assert.equal(detectPrompt(MODEL_SWITCH, "codex"), undefined);
});

test("the older verified Computer Use frame remains a truthful desktop-only fallback", () => {
  const prompt = detectPrompt(
    "Computer Use wants permission\n❯ 1. Allow\n  2. Allow for this session\n  3. Always allow\n  4. Cancel",
    "codex"
  );
  assert.equal(prompt?.remoteResolutionUnavailable, true);
  assert.equal(prompt?.decisions, undefined);
});

test("Codex Computer Use detection is app-agnostic but rejects lookalike output", () => {
  const prompt = detectPrompt(
    [
      "Field 1/1",
      'Allow Computer Use to use "Simulator"?',
      "App: Simulator",
      "› 1. Allow  Run the tool and continue.",
      "  2. Allow for this session  Remember this session.",
      "  3. Always allow  Remember future calls.",
      "  4. Cancel  Cancel this tool call"
    ].join("\n"),
    "codex"
  );
  assert.equal(prompt?.context?.app, "Simulator");
  assert.equal(
    detectPrompt("Allow Computer Use to use Xcode?\n› 1. Allow\n2. Allow for this session\n3. Always allow\n4. Cancel", "codex"),
    undefined,
    "an App field is required so ordinary numbered text cannot become an actionable prompt"
  );
});

test("a prompt with no question line falls back to its topmost content line", () => {
  const frame = ["▔▔▔▔▔▔▔▔", "Pick a branch", "❯ 1. main", "  2. dev"].join("\n");
  assert.equal(detectPrompt(frame, "claude")?.summary, "Pick a branch");
});
