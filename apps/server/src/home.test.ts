import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { attachmentsDir, perchHome, readOrCreateToken, removeAttachments, tokenPath } from "./home.js";

function makeEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "perch-home-"));
  return { PERCH_HOME: home };
}

test("perchHome respects PERCH_HOME override", () => {
  const env = makeEnv();
  assert.equal(perchHome(env), env.PERCH_HOME);
  rmSync(env.PERCH_HOME as string, { recursive: true, force: true });
});

test("readOrCreateToken creates a 64-char hex token with 0600 perms", () => {
  const env = makeEnv();
  const token = readOrCreateToken(env);

  assert.match(token, /^[0-9a-f]{64}$/);
  const stats = statSync(tokenPath(env));
  assert.equal(stats.mode & 0o777, 0o600);
  rmSync(env.PERCH_HOME as string, { recursive: true, force: true });
});

test("readOrCreateToken is stable across calls", () => {
  const env = makeEnv();
  const first = readOrCreateToken(env);
  const second = readOrCreateToken(env);

  assert.equal(first, second);
  assert.equal(readFileSync(tokenPath(env), "utf8").trim(), first);
  rmSync(env.PERCH_HOME as string, { recursive: true, force: true });
});

test("attachmentsDir is under PERCH_HOME/attachments/<sessionId>", () => {
  const env = makeEnv();
  const dir = attachmentsDir("pty:abc", env);
  assert.equal(dir, join(env.PERCH_HOME as string, "attachments", "pty:abc"));
  rmSync(env.PERCH_HOME as string, { recursive: true, force: true });
});

test("removeAttachments deletes the session dir and tolerates a missing one", () => {
  const env = makeEnv();
  const dir = attachmentsDir("pty:xyz", env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "a.png"), "x");
  removeAttachments("pty:xyz", env);
  assert.equal(existsSync(dir), false);
  removeAttachments("pty:never", env); // no throw on missing
  rmSync(env.PERCH_HOME as string, { recursive: true, force: true });
});
