import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { attachmentsDir } from "./home.js";

export type StoredAttachment = { path: string; filename: string };

// Accept only image bytes (no video: neither agent CLI supports it), write
// them into the session scratch dir, and hand back the absolute path the
// injected prompt will reference.
export function storeAttachment(opts: {
  sessionId: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
  env?: NodeJS.ProcessEnv;
}): StoredAttachment {
  if (!opts.contentType.toLowerCase().startsWith("image/")) {
    throw new Error(`Unsupported attachment content type: ${opts.contentType} (image/* only)`);
  }
  // basename() strips any directory components, defeating ../ traversal; then
  // keep only a safe charset and fall back to a generic name if nothing's left.
  const safe = basename(opts.filename).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") || "image";
  const dir = attachmentsDir(opts.sessionId, opts.env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, safe);
  writeFileSync(path, opts.bytes);
  return { path, filename: safe };
}
