import assert from "node:assert/strict";
import { test } from "node:test";
import { extractQuestions, questionId, questionKeystrokes } from "./askQuestion.js";
import { normalizeHookEvent } from "./hooks.js";
import type { QuestionItem } from "@perch/shared";

const DOWN = "\x1b[B";
const ENTER = "\r";

// Every element must be a single key (one arrow or one Enter) so the caller can
// space them out: a run of arrows in one write is dropped by the widget.
function assertPerKey(keys: string[]) {
  for (const key of keys) {
    assert.ok(key === DOWN || key === ENTER, `expected a single key, got ${JSON.stringify(key)}`);
  }
}

const single: QuestionItem[] = [
  {
    header: "Fruit",
    question: "Which fruit?",
    multiSelect: false,
    options: [{ label: "Apple" }, { label: "Banana" }, { label: "Cherry" }]
  }
];

// These sequences were verified keystroke-for-keystroke against the live
// Claude Code 2.1.201 AskUserQuestion widget; they are the contract this
// builder must not drift from.
test("single-select single question: Down*i then Enter, no confirm", () => {
  assert.deepEqual(questionKeystrokes(single, [[0]]), [ENTER]);
  assert.deepEqual(questionKeystrokes(single, [[1]]), [DOWN, ENTER]);
  assert.deepEqual(questionKeystrokes(single, [[2]]), [DOWN, DOWN, ENTER]);
  assertPerKey(questionKeystrokes(single, [[2]]));
});

test("single-select defaults to the first option when nothing valid is chosen", () => {
  assert.deepEqual(questionKeystrokes(single, [[]]), [ENTER]);
  assert.deepEqual(questionKeystrokes(single, [[99]]), [ENTER]);
  assert.deepEqual(questionKeystrokes(single, []), [ENTER]);
});

test("multi-select single question: toggles, navigate to Submit, then confirm", () => {
  const multi: QuestionItem[] = [
    {
      header: "Toppings",
      question: "Pick toppings",
      multiSelect: true,
      options: [{ label: "Cheese" }, { label: "Mushroom" }, { label: "Onion" }, { label: "Olives" }]
    }
  ];
  // Toggle Cheese(0) and Onion(2); Submit row is at options.length+1 = 5.
  // Verified live: enter, down down enter, down down down enter, enter.
  const keys = questionKeystrokes(multi, [[0, 2]]);
  assert.deepEqual(keys, [
    ENTER, // toggle Cheese
    DOWN, DOWN, ENTER, // to Onion, toggle
    DOWN, DOWN, DOWN, ENTER, // to Submit row, advance
    ENTER // confirm review
  ]);
  assertPerKey(keys);
});

test("two single-select questions: select+advance each, then confirm", () => {
  const two: QuestionItem[] = [
    { header: "Size", question: "What size?", multiSelect: false, options: [{ label: "Small" }, { label: "Large" }] },
    { header: "Color", question: "What color?", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }] }
  ];
  // Small(0), Blue(1). Verified live: enter, down enter, enter.
  assert.deepEqual(questionKeystrokes(two, [[0], [1]]), [ENTER, DOWN, ENTER, ENTER]);
});

test("extractQuestions reads and cleans the tool_input, rejects junk", () => {
  const input = {
    questions: [
      {
        header: "Fruit",
        question: "Which fruit?",
        multiSelect: false,
        options: [{ label: "Apple", description: "crisp" }, { label: "Banana" }, { bad: true }]
      },
      { question: "", options: [] }
    ]
  };
  const questions = extractQuestions(input);
  assert.ok(questions);
  assert.equal(questions!.length, 1);
  assert.equal(questions![0].options.length, 2);
  assert.equal(questions![0].options[0].description, "crisp");
  assert.equal(extractQuestions({}), undefined);
  assert.equal(extractQuestions({ questions: "nope" }), undefined);
  assert.equal(extractQuestions(null), undefined);
});

test("questionId is stable across identical question sets", () => {
  assert.equal(questionId(single), questionId(structuredClone(single)));
});

test("normalizeHookEvent routes only the official AskUserQuestion PreToolUse path to a question", () => {
  const toolInput = { questions: [{ header: "Fruit", question: "Which fruit?", options: [{ label: "Apple" }] }] };
  const normalized = normalizeHookEvent({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: toolInput });
  assert.equal(normalized.status, "needs_approval");
  assert.equal(normalized.question?.questions[0].question, "Which fruit?");
  const permission = normalizeHookEvent({ hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: toolInput });
  assert.equal(permission.question, undefined);
  assert.ok(permission.approval);
});

test("normalizeHookEvent leaves non-question PreToolUse as running", () => {
  const normalized = normalizeHookEvent({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
  assert.equal(normalized.status, "running");
  assert.equal(normalized.question, undefined);
});
