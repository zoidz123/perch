import { createHash } from "node:crypto";
import type { QuestionItem } from "@perch/shared";

// Claude Code's AskUserQuestion widget is an interactive selection prompt, not
// a permission dialog: the user picks among options rather than allow/deny.
// Perch recovers its structure from the hook tool_input (the transcript does
// not carry the tool_use until the turn completes, so it is useless while the
// prompt is still open) and drives it with the widget's own keystrokes.
//
// Behavior verified against Claude Code 2.1.201:
//  - The cursor opens on the first option of the first question.
//  - Single-select: navigating to an option and pressing Enter selects it and
//    advances to the next question (or, for the last question, to the review).
//  - Multi-select: Enter toggles the option under the cursor in place; a
//    "Submit" row sits one past the last real option (after the always-present
//    "Type something" row) and advances the question.
//  - Any multi-select question, or more than one question, ends on a
//    "Submit answers / Cancel" review that needs one confirming Enter. A lone
//    single-select question submits on its own Enter with no review step.

export const ASK_USER_QUESTION_TOOL = "AskUserQuestion";

export const DOWN = "\x1b[B";
export const ENTER = "\r";

// The widget's input parser drops keys when a whole navigation sequence lands
// in one write (arrow escape sequences run together and only the trailing Enter
// registers - verified: a bursted "Down, Enter" selects option 0, not 1). Each
// key must be delivered as its own write, spaced out; 30ms is reliable, 40ms
// adds margin and is still imperceptible for the ~1-10 keys a question needs.
export const KEY_DELAY_MS = 40;

// Extracts and defensively normalizes the questions from a hook's tool_input.
// Returns undefined for anything that is not a well-formed AskUserQuestion so
// the caller falls back to the normal (running) status.
export function extractQuestions(toolInput: unknown): QuestionItem[] | undefined {
  if (!toolInput || typeof toolInput !== "object") {
    return undefined;
  }
  const raw = (toolInput as Record<string, unknown>).questions;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const questions: QuestionItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const question = typeof record.question === "string" ? record.question : "";
    const optionsRaw = Array.isArray(record.options) ? record.options : [];
    const options = optionsRaw
      .map((option) => {
        const opt = option as Record<string, unknown>;
        return {
          label: typeof opt?.label === "string" ? opt.label : "",
          ...(typeof opt?.description === "string" ? { description: opt.description } : {})
        };
      })
      .filter((option) => option.label.length > 0);
    if (!question || options.length === 0) {
      continue;
    }
    questions.push({
      ...(typeof record.header === "string" ? { header: record.header } : {}),
      question,
      multiSelect: record.multiSelect === true,
      options
    });
  }
  return questions.length > 0 ? questions : undefined;
}

// A stable legacy id for degraded question detection. The structured path uses
// Claude's exact PreToolUse tool_use_id as its authority.
export function questionId(questions: QuestionItem[]): string {
  const canonical = JSON.stringify(
    questions.map((q) => ({ h: q.header ?? "", q: q.question, m: !!q.multiSelect, o: q.options.map((o) => o.label) }))
  );
  return `askq-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

// Translates chosen option indices into the ordered keystrokes that drive the
// widget from its initial (cursor-on-first-option) state. Returns ONE key per
// element (never a run of arrows in a single string) so the caller can space
// them out - a run in one write is dropped by the widget. `selections` is
// per-question; out-of-range indices are dropped, and a single-select question
// with no valid choice defaults to the first option (the widget's own default).
export function questionKeystrokes(questions: QuestionItem[], selections: number[][]): string[] {
  const keys: string[] = [];
  const down = (count: number) => {
    for (let i = 0; i < Math.max(0, count); i += 1) {
      keys.push(DOWN);
    }
  };

  questions.forEach((question, qi) => {
    const optionCount = question.options.length;
    const chosen = (selections[qi] ?? []).filter(
      (index) => Number.isInteger(index) && index >= 0 && index < optionCount
    );

    if (question.multiSelect) {
      const sorted = [...new Set(chosen)].sort((a, b) => a - b);
      let cursor = 0;
      for (const index of sorted) {
        down(index - cursor);
        keys.push(ENTER); // toggle the checkbox in place
        cursor = index;
      }
      // The "Submit" row sits one past the last real option (there is always a
      // "Type something" row between the options and Submit).
      const submitRow = optionCount + 1;
      down(submitRow - cursor);
      keys.push(ENTER); // advance to the next question / review
    } else {
      const index = chosen.length > 0 ? chosen[0] : 0;
      down(index);
      keys.push(ENTER); // select and advance
    }
  });

  // Multi-question or any multi-select ends on a review step; confirm it.
  const needsConfirm = questions.length > 1 || questions.some((question) => question.multiSelect);
  if (needsConfirm) {
    keys.push(ENTER);
  }
  return keys;
}
