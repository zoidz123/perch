import type { AgentKind, CodexReasoningEffort } from "@perch/shared";

// A dialog the CLI may raise in response to a submitted command, and the keys
// that answer it "yes". Perch answers the dialogs IT caused: a confirm raised
// by a switch the app itself initiated is not a decision to bounce back to the
// phone. Answering is conditional on having actually seen `awaitText` on the
// rendered screen - a blind answer key would land in the composer as literal
// text on any CLI (or session) that does not raise the dialog.
export type ConfirmPrompt = { awaitText: string; keys: string };

// A post-Enter barrier: block until `awaitText` renders (the submitted command
// has visibly landed) or `awaitMs` elapses. Model switching needs this:
// `/model <alias>` returns the instant Enter is pressed, but the CLI applies
// the switch and re-renders its input line a beat later; without the barrier
// the app's next message is typed into a mid-transition TUI and is swallowed
// (or runs on the old model). `prompt`, when set, is a dialog that may stand
// between Enter and `awaitText`; seeing it makes the barrier answer once and
// keep waiting. The barrier reports whether `awaitText` was ever reached, so a
// caller never reports a command that did not land.
export type SubmitBarrier = { awaitText: string; awaitMs: number; prompt?: ConfirmPrompt };

export type InjectionStep =
  | { kind: "submit"; text: string; confirm?: SubmitBarrier }
  | { kind: "keys"; bytes: string; settleMs: number };

export function isProviderPrefixedModelId(model: string): boolean {
  return /^[a-z][a-z0-9-]*\//i.test(model.trim());
}

export function assertLocalRuntimeModelId(model: string): void {
  if (isProviderPrefixedModelId(model)) {
    throw new Error(`Provider-prefixed model id is not a local runtime id: ${model}`);
  }
}

// Agent-specific keystrokes to switch the running TUI to `model`. Kept as a
// pure function so it is unit-testable and the app stays agent-agnostic. This
// is only for agents that switch via TUI keystrokes (Claude). Codex switches
// over the app-server protocol (a per-turn `turn/start` model override, no
// keystrokes) and is routed through the control plane in http.ts, so it never
// reaches this function.
export function modelSwitchSteps(agent: AgentKind, model: string): InjectionStep[] {
  const value = model.trim();
  if (value) assertLocalRuntimeModelId(value);
  switch (agent) {
    case "claude":
      // `/model <alias>` prints "Set model to <label> ..." once the switch
      // lands, so we block on that marker before returning - otherwise a
      // message sent right after (the app flushes a pending switch on send) is
      // typed while the CLI is still re-rendering and gets lost or runs on the
      // old model.
      //
      // Two shapes reach that marker, both verified by driving the real TUI:
      // 2.1.204 always sets directly, and so does 2.1.205 on a conversation the
      // CLI has not cached yet. But once the conversation IS cached, 2.1.205
      // first raises a "Switch model?" confirm ("the full history gets re-read
      // on your next message") and waits. Unanswered, it swallows whatever the
      // app types next - its Enter answers the dialog and the text is consumed.
      // So the barrier answers that dialog, and only that dialog, with the same
      // "1" the approve route sends into Claude's numbered prompts.
      return [
        {
          kind: "submit",
          text: `/model ${value}`,
          confirm: {
            awaitText: "Set model to",
            awaitMs: 8000,
            prompt: { awaitText: "Switch model?", keys: "1" }
          }
        }
      ];
    default:
      throw new Error(`Agent ${agent} does not support keystroke model switching`);
  }
}

// Agent-specific CLI flags to start a NEW session on `model` (and, for Codex, a
// reasoning `effort`) at spawn time. Unlike modelSwitchSteps (which drives a
// running TUI), this only shapes the spawn argv, so it works for every agent
// whose CLI takes a model flag. An empty/whitespace model yields no model flag,
// leaving the CLI's own default (codex in particular errors on an empty `-m ""`,
// so it must be omitted, not blank). Codex effort is passed as a `-c` config
// override (`model_reasoning_effort="<level>"`), which the CLI parses as TOML;
// Claude has no effort control so the effort is ignored there.
export function spawnModelArgs(
  agent: AgentKind,
  model?: string,
  effort?: CodexReasoningEffort
): string[] {
  const value = model?.trim();
  switch (agent) {
    case "claude":
      if (value) assertLocalRuntimeModelId(value);
      return value ? ["--model", value] : [];
    case "codex": {
      const args: string[] = [];
      if (value) {
        assertLocalRuntimeModelId(value);
        args.push("-m", value);
      }
      if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
      return args;
    }
    default:
      // Other agents' launch-time model flags are unverified; omit rather than
      // pass a flag the CLI may reject and fail the whole spawn.
      return [];
  }
}
