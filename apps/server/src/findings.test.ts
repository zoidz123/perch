import assert from "node:assert/strict";
import { test } from "node:test";
import { findingsPushBody, findingsWakeSummary, parseNoMistakesGate, worstFinding } from "./findings.js";

const gateData = (overrides: Record<string, unknown> = {}) => ({
  noMistakes: {
    step: "review",
    runId: "run-7",
    findings: [
      { id: "r1", severity: "warning", file: "src/app.ts", line: 12, action: "fix", description: "prefer the shared helper" },
      { id: "r2", severity: "error", file: "src/db.ts", action: "ask-user", description: "dropping this index changes query plans" }
    ],
    ...overrides
  }
});

test("parseNoMistakesGate carries id, severity, file, line, action, and description verbatim", () => {
  const gate = parseNoMistakesGate(gateData());
  assert.ok(gate);
  assert.equal(gate.step, "review");
  assert.equal(gate.runId, "run-7");
  assert.equal(gate.findings.length, 2);
  assert.deepEqual(gate.findings[0], {
    id: "r1",
    severity: "warning",
    file: "src/app.ts",
    line: 12,
    action: "fix",
    description: "prefer the shared helper"
  });
  assert.equal(gate.findings[1]?.line, undefined);
});

test("parseNoMistakesGate returns undefined for absent, malformed, or empty payloads", () => {
  assert.equal(parseNoMistakesGate(undefined), undefined);
  assert.equal(parseNoMistakesGate({}), undefined);
  assert.equal(parseNoMistakesGate({ noMistakes: "review failed" }), undefined);
  assert.equal(parseNoMistakesGate({ noMistakes: [1, 2] }), undefined);
  assert.equal(parseNoMistakesGate({ noMistakes: { step: "review", findings: [] } }), undefined);
  // Rows without an id or description have nothing to relay and are dropped;
  // a table of only such rows is no gate at all.
  assert.equal(
    parseNoMistakesGate({ noMistakes: { step: "review", findings: [{ severity: "error" }, "junk", null] } }),
    undefined
  );
});

test("parseNoMistakesGate is tolerant: defaults for missing step/severity, junk rows dropped", () => {
  const gate = parseNoMistakesGate({
    noMistakes: {
      findings: [
        { id: "x1", description: "kept, defaults filled" },
        { id: "  ", description: "blank id dropped" },
        { id: "x2", description: "", severity: "error" },
        { id: "x3", description: "kept too", line: "42", file: 7 }
      ]
    }
  });
  assert.ok(gate);
  assert.equal(gate.step, "pipeline");
  assert.equal(gate.runId, undefined);
  assert.deepEqual(
    gate.findings.map((finding) => finding.id),
    ["x1", "x3"]
  );
  assert.equal(gate.findings[0]?.severity, "unknown");
  // Non-string file / non-number line are dropped, the finding survives.
  assert.equal(gate.findings[1]?.file, undefined);
  assert.equal(gate.findings[1]?.line, undefined);
});

test("worstFinding picks by severity rank, unknown words behind the known ones, ties keep table order", () => {
  const gate = parseNoMistakesGate(gateData());
  assert.ok(gate);
  assert.equal(worstFinding(gate).id, "r2"); // error beats warning
  const ties = parseNoMistakesGate({
    noMistakes: {
      step: "review",
      findings: [
        { id: "a", severity: "error", description: "first" },
        { id: "b", severity: "ERROR", description: "second" }
      ]
    }
  });
  assert.ok(ties);
  assert.equal(worstFinding(ties).id, "a");
  const exotic = parseNoMistakesGate({
    noMistakes: {
      step: "review",
      findings: [
        { id: "odd", severity: "informational", description: "custom tier" },
        { id: "warn", severity: "warning", description: "known tier wins" }
      ]
    }
  });
  assert.ok(exotic);
  assert.equal(worstFinding(exotic).id, "warn");
});

test("findingsPushBody names the step, the count, and the worst finding verbatim", () => {
  const gate = parseNoMistakesGate(gateData());
  assert.ok(gate);
  assert.equal(
    findingsPushBody(gate),
    "review gate: 2 findings need you - r2 (error): dropping this index changes query plans"
  );
  const single = parseNoMistakesGate({
    noMistakes: { step: "test", findings: [{ id: "t1", severity: "error", description: "flaky\nassertion" }] }
  });
  assert.ok(single);
  // Singular copy; multi-line descriptions squeeze to one line.
  assert.equal(findingsPushBody(single), "test gate: 1 finding needs you - t1 (error): flaky assertion");
});

test("findingsWakeSummary renders the whole table on one line, descriptions verbatim", () => {
  const gate = parseNoMistakesGate(gateData());
  assert.ok(gate);
  const summary = findingsWakeSummary(gate);
  assert.equal(
    summary,
    "review gate parked with 2 findings: " +
      "r1 (warning) src/app.ts:12 [fix]: prefer the shared helper | " +
      "r2 (error) src/db.ts [ask-user]: dropping this index changes query plans"
  );
  assert.ok(!summary.includes("\n"), "a newline would submit the mate composer early");
});
