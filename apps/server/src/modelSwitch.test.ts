import { test } from "node:test";
import assert from "node:assert/strict";
import { modelSwitchSteps, spawnModelArgs } from "./modelSwitch.js";

test("claude switch is a single /model <alias> submit that waits for the switch to land", () => {
  // `/model <alias>` sets inline (no picker). The submit blocks on the CLI's
  // "Set model to ..." confirmation so a message sent right after the switch
  // never races the CLI's re-render and lands on the new model. On a cached
  // conversation 2.1.205 first raises a "Switch model?" confirm, which the
  // barrier answers with "1" - the same key the approve route sends.
  assert.deepEqual(modelSwitchSteps("claude", "opus"), [
    {
      kind: "submit",
      text: "/model opus",
      confirm: {
        awaitText: "Set model to",
        awaitMs: 8000,
        prompt: { awaitText: "Switch model?", keys: "1" }
      }
    }
  ]);
});

test("unsupported agent throws", () => {
  assert.throws(() => modelSwitchSteps("shell", "opus"), /support/i);
});

test("codex is not a keystroke switch - it routes through the app-server control plane", () => {
  // Codex must never be driven by keystrokes into its interactive picker; the
  // http model route sends it over the protocol instead, so it never reaches
  // modelSwitchSteps.
  assert.throws(() => modelSwitchSteps("codex", "gpt-5.5"), /keystroke/i);
});

test("spawnModelArgs maps each agent to its launch-time model flag", () => {
  assert.deepEqual(spawnModelArgs("claude", "opus"), ["--model", "opus"]);
  assert.deepEqual(spawnModelArgs("codex", "gpt-5.5"), ["-m", "gpt-5.5"]);
});

test("spawnModelArgs threads codex reasoning effort as a -c config override", () => {
  assert.deepEqual(spawnModelArgs("codex", "gpt-5.5", "xhigh"), [
    "-m",
    "gpt-5.5",
    "-c",
    'model_reasoning_effort="xhigh"'
  ]);
  // Effort without a model still passes the override (config default model).
  assert.deepEqual(spawnModelArgs("codex", undefined, "high"), ["-c", 'model_reasoning_effort="high"']);
});

test("spawnModelArgs ignores effort for agents without a reasoning tier", () => {
  // Claude has no effort control; the effort must never leak into its argv.
  assert.deepEqual(spawnModelArgs("claude", "opus", "xhigh"), ["--model", "opus"]);
});

test("spawnModelArgs omits the flag for an empty/blank/undefined model", () => {
  assert.deepEqual(spawnModelArgs("claude", undefined), []);
  assert.deepEqual(spawnModelArgs("claude", ""), []);
  assert.deepEqual(spawnModelArgs("codex", "   "), []);
});

test("spawnModelArgs stays silent for agents without a verified model flag", () => {
  assert.deepEqual(spawnModelArgs("shell", "whatever"), []);
});

test("local runtime paths reject provider-prefixed gateway model ids", () => {
  assert.throws(
    () => spawnModelArgs("codex", "openai/gpt-5.6-sol"),
    /not a local runtime id/
  );
  assert.throws(
    () => modelSwitchSteps("claude", "anthropic/claude-fable-5"),
    /not a local runtime id/
  );
});
