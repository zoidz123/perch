import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { storeAttachment } from "./attachments.js";

function env(): NodeJS.ProcessEnv {
  return { PERCH_HOME: mkdtempSync(join(tmpdir(), "perch-home-")) };
}

test("storeAttachment writes bytes under the session attachments dir and returns an absolute path", () => {
  const e = env();
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic
  const out = storeAttachment({ sessionId: "pty:s1", filename: "shot.png", contentType: "image/png", bytes, env: e });
  assert.equal(out.path, join(e.PERCH_HOME as string, "attachments", "pty:s1", "shot.png"));
  assert.ok(existsSync(out.path));
  assert.deepEqual(readFileSync(out.path), bytes);
});

test("storeAttachment strips path traversal from the filename", () => {
  const e = env();
  const out = storeAttachment({
    sessionId: "pty:s2",
    filename: "../../etc/evil.png",
    contentType: "image/png",
    bytes: Buffer.from("x"),
    env: e
  });
  assert.equal(basename(out.path), "evil.png");
  assert.ok(out.path.includes(join("attachments", "pty:s2")));
});

test("storeAttachment rejects a non-image content type", () => {
  const e = env();
  assert.throws(
    () => storeAttachment({ sessionId: "pty:s3", filename: "a.txt", contentType: "text/plain", bytes: Buffer.from("x"), env: e }),
    /image/i
  );
});
