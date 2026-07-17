import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { suggestDirectories, resetSuggestCache } from "./fsSuggest.js";
import { ProjectRegistry } from "./projects.js";

test("project registry seeds from usage and sorts by recency", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-proj-"));
  const registry = new ProjectRegistry({ PERCH_HOME: home } as NodeJS.ProcessEnv);

  registry.touch("/tmp/alpha");
  await new Promise((resolve) => setTimeout(resolve, 5));
  registry.touch("/tmp/beta", { mode: "direct-PR" });

  const listed = registry.list();
  assert.equal(listed[0]?.name, "beta");
  assert.equal(listed[0]?.mode, "direct-PR");
  assert.equal(listed.length, 2);

  // Re-touch bumps recency, keeps fields, no duplicate.
  await new Promise((resolve) => setTimeout(resolve, 5));
  registry.touch("/tmp/alpha");
  assert.equal(registry.list()[0]?.name, "alpha");
  assert.equal(registry.list().length, 2);
  assert.equal(registry.find("/tmp/beta")?.mode, "direct-PR");

  rmSync(home, { recursive: true, force: true });
});

test("directory suggestions rank exact, prefix, then fuzzy; path queries complete", () => {
  resetSuggestCache();
  const home = mkdtempSync(join(tmpdir(), "perch-sugg-"));
  mkdirSync(join(home, "perch"), { recursive: true });
  mkdirSync(join(home, "perch-experiments"), { recursive: true });
  mkdirSync(join(home, "projects", "porch"), { recursive: true });
  mkdirSync(join(home, "node_modules", "perch-fake"), { recursive: true });

  const results = suggestDirectories("perch", { home });
  assert.equal(results[0], join(home, "perch"), "exact basename wins");
  assert.equal(results[1], join(home, "perch-experiments"), "prefix second");
  assert.ok(!results.some((path) => path.includes("node_modules")), "ignored dirs excluded");

  resetSuggestCache();
  const completed = suggestDirectories(join(home, "proj"), { home });
  assert.deepEqual(completed, [join(home, "projects")]);

  rmSync(home, { recursive: true, force: true });
});
