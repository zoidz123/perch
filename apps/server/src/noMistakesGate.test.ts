import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TaskStore } from "./tasks.js";

test("retired no-mistakes delivery modes remain importable but never initialize a new task runtime", () => {
  const home = mkdtempSync(join(tmpdir(), "perch-legacy-mode-"));
  const tasks = new TaskStore({ PERCH_HOME: home });
  try {
    const legacy = {
      id: "legacy-no-mistakes-a1b2", title: "legacy gate", project: "/tmp/repo", kind: "ship" as const,
      mode: "no-mistakes" as const, state: "working" as const,
      createdAt: "2026-08-06T00:00:00.000Z", updatedAt: "2026-08-06T00:00:00.000Z"
    };
    tasks.stateDb.tasks.insertImported(legacy, []);
    assert.equal(tasks.find(legacy.id)?.mode, "no-mistakes");
    assert.throws(
      () => tasks.create({ title: "new legacy mode", project: "/tmp/repo", mode: "no-mistakes" }),
      /legacy-only/
    );
  } finally {
    tasks.close();
    rmSync(home, { recursive: true, force: true });
  }
});
