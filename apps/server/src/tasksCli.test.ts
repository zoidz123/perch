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

async function runTasks(serverUrl: string, home: string, args: string[] = []) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [PERCH_BIN, "tasks", ...args], {
      env: { ...process.env, PERCH_HOME: home, PERCH_SERVER_URL: serverUrl, PERCH_TOKEN: "test-token" }
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function withTaskServer(
  handler: (request: string, authorization: string | undefined) => { status?: number; body: unknown },
  run: (serverUrl: string) => Promise<void>
) {
  const server = createServer((request, response) => {
    const result = handler(request.url ?? "", request.headers.authorization);
    response.statusCode = result.status ?? 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("perch tasks renders active durable task, runtime, and PR facts in plain non-TTY output", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-tasks-cli-"));
  const tasks = [
    {
      id: "reviewing-task",
      title: "Review task status",
      workerName: "Alder",
      project: "/work/perch",
      kind: "ship",
      mode: "no-mistakes",
      state: "working",
      presentation: { state: "reviewing" },
      runtime: { state: "live", workerName: "Alder", recoveryAvailable: false },
      pr: { url: "https://github.com/zoidz123/perch/pull/42", checks: "passing" },
      createdAt: "2026-07-23T12:00:00.000Z",
      updatedAt: new Date().toISOString()
    },
    {
      id: "merge-task",
      title: "Ship release notes",
      workerName: "Birch",
      project: "/work/release-notes",
      kind: "ship",
      mode: "direct-PR",
      state: "done",
      presentation: { state: "ready_to_merge" },
      pr: { url: "https://github.com/zoidz123/perch/pull/43", checks: "passing", mergeReady: true },
      createdAt: "2026-07-23T12:00:00.000Z",
      updatedAt: new Date().toISOString()
    },
    {
      id: "recoverable-task",
      title: "Resume interrupted worker",
      project: "/work/recovery",
      kind: "scout",
      mode: "local-only",
      state: "working",
      presentation: { state: "working" },
      runtime: { state: "recoverable", recoveryAvailable: false },
      createdAt: "2026-07-23T12:00:00.000Z",
      updatedAt: new Date().toISOString()
    }
  ];
  try {
    await withTaskServer((request, authorization) => {
      if (request === "/health") return { body: { ok: true, adapter: "stub" } };
      if (request === "/tasks") {
        assert.equal(authorization, "Bearer test-token");
        return { body: { tasks } };
      }
      return { status: 404, body: { error: "not found" } };
    }, async (serverUrl) => {
      const result = await runTasks(serverUrl, home);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /^TASK\s+PROJECT\s+STATE\s+WORKER\/RUNTIME\s+UPDATED\s+PR/m);
      assert.match(result.stdout, /Review task status\s+perch\s+Reviewing\s+Live \(Alder\)\s+now\s+PR #42 checks passed/);
      assert.match(result.stdout, /Ship release notes\s+release-notes\s+Ready to merge\s+Birch\s+now\s+PR #43 ready to merge/);
      assert.match(result.stdout, /Resume interrupted worker\s+recovery\s+Working\s+Interrupted\s+now\s+-/);
      assert.doesNotMatch(result.stdout, /\x1b\[/);

      const json = await runTasks(serverUrl, home, ["--json"]);
      assert.equal(json.code, 0, json.stderr);
      assert.deepEqual(JSON.parse(json.stdout), { tasks });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("perch tasks prints a clear empty state", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-tasks-cli-"));
  try {
    await withTaskServer((request) => {
      if (request === "/health") return { body: { ok: true, adapter: "stub" } };
      if (request === "/tasks") return { body: { tasks: [] } };
      return { status: 404, body: { error: "not found" } };
    }, async (serverUrl) => {
      const result = await runTasks(serverUrl, home);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, "no active tasks\n");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("perch tasks surfaces server failures", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-tasks-cli-"));
  try {
    await withTaskServer((request) => {
      if (request === "/health") return { body: { ok: true, adapter: "stub" } };
      if (request === "/tasks") return { status: 503, body: { error: "durable task ledger unavailable" } };
      return { status: 404, body: { error: "not found" } };
    }, async (serverUrl) => {
      const result = await runTasks(serverUrl, home);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /perch: durable task ledger unavailable/);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
