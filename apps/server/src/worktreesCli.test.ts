import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PERCH_BIN = fileURLToPath(new URL("../../../bin/perch.mjs", import.meta.url));

test("perch worktrees explicitly requests the full task ledger for its history join", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") return response.end(JSON.stringify({ ok: true, adapter: "stub" }));
    if (request.url === "/worktrees") return response.end(JSON.stringify({ worktrees: [] }));
    if (request.url === "/tasks?includeClosed=1") return response.end(JSON.stringify({ tasks: [] }));
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const home = mkdtempSync(join(tmpdir(), "perch-worktrees-cli-"));
  const port = (server.address() as AddressInfo).port;
  try {
    const result = await execFileAsync(process.execPath, [PERCH_BIN, "worktrees"], {
      env: {
        ...process.env,
        PERCH_HOME: home,
        PERCH_SERVER_URL: `http://127.0.0.1:${port}`,
        PERCH_TOKEN: "test"
      }
    });
    assert.match(result.stdout, /no worktrees/);
    assert.ok(requests.includes("/tasks?includeClosed=1"));
  } finally {
    rmSync(home, { recursive: true, force: true });
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
