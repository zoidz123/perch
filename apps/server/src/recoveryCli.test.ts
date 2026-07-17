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

async function runCli(args: string[], tasks: unknown[]) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") return response.end(JSON.stringify({ ok: true, adapter: "stub" }));
    if (request.url === "/tasks" && request.method === "GET") return response.end(JSON.stringify({ tasks }));
    if (request.url?.match(/^\/tasks\/[^/]+\/recover$/) && request.method === "POST") {
      requests.push(request.url);
      return response.end(JSON.stringify({
        recovered: true,
        task: { id: request.url.split("/")[2], runtime: { generation: 2, ptySessionId: "pty:recovered" } }
      }));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const home = mkdtempSync(join(tmpdir(), "perch-recovery-cli-"));
  const port = (server.address() as AddressInfo).port;
  try {
    const result = await execFileAsync(process.execPath, [PERCH_BIN, ...args], {
      env: {
        ...process.env,
        PERCH_HOME: home,
        PERCH_SERVER_URL: `http://127.0.0.1:${port}`,
        PERCH_TOKEN: "test"
      }
    });
    return { ...result, requests };
  } finally {
    rmSync(home, { recursive: true, force: true });
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("perch recover task invokes the provider-neutral task endpoint", async () => {
  const result = await runCli(["recover", "task", "task-123"], []);
  assert.deepEqual(result.requests, ["/tasks/task-123/recover"]);
  assert.match(result.stdout, /recovered task task-123 as generation 2/);
});
