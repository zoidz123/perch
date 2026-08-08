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

async function runCli(serverUrl: string, home: string, args: string[]) {
  try {
    const result = await execFileAsync(process.execPath, [PERCH_BIN, ...args], {
      env: {
        ...process.env,
        PERCH_HOME: home,
        PERCH_SERVER_URL: serverUrl,
        PERCH_HOOK_URL: `${serverUrl}/hooks`,
        PERCH_SESSION_ID: "pty:claude-root",
        PERCH_HOOK_TOKEN: "hook-token"
      }
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

// A real review holds one request open for minutes: focused tests up to 15
// and the bundled helper up to 31. Node's global fetch client abandons a
// response after its 300s default headers deadline (UND_ERR_HEADERS_TIMEOUT),
// so these two commands must not run on it. This proves the deferred-response
// path end to end and that a refusal still reaches the worker verbatim.
test("AutoReview and delivery survive a deferred response and still surface refusals", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-autoreview-cli-slow-"));
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") return response.end(JSON.stringify({ ok: true, adapter: "test" }));
    if (request.url === "/tasks/task-1/autoreview") {
      // No byte of the response head is written until well after the request
      // body arrived, which is exactly the shape that trips the fetch client.
      setTimeout(() => response.end(JSON.stringify({ attempt: { id: "a-1", state: "clean" }, duplicate: false })), 1_500);
      return;
    }
    if (request.url === "/tasks/task-1/delivery/pr") {
      response.statusCode = 409;
      return setTimeout(() => response.end(JSON.stringify({ error: "delivery requires a clean AutoReview receipt with no actionable findings" })), 1_500);
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const review = await runCli(serverUrl, home, [
      "autoreview", "run", "--task", "task-1", "--idempotency-key", "slow", "--test-argv-json", '["npm","test"]'
    ]);
    assert.equal(review.code, 0, review.stderr);
    assert.match(review.stdout, /"state": "clean"/);

    const delivery = await runCli(serverUrl, home, ["delivery", "create-pr", "--task", "task-1", "--idempotency-key", "slow"]);
    assert.notEqual(delivery.code, 0, "a 409 refusal must fail the command");
    assert.match(delivery.stderr, /clean AutoReview receipt with no actionable findings/);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});

test("managed-worker CLI uses the same typed AutoReview and server-delivery contracts", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-autoreview-cli-"));
  const requests: Array<{ path: string; method: string; session?: string; token?: string; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({
      path: request.url ?? "",
      method: request.method ?? "GET",
      session: typeof request.headers["x-perch-session"] === "string" ? request.headers["x-perch-session"] : undefined,
      token: typeof request.headers["x-perch-token"] === "string" ? request.headers["x-perch-token"] : undefined,
      body
    });
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") return response.end(JSON.stringify({ ok: true, adapter: "test" }));
    if (request.url === "/tasks/task-1/autoreview") {
      return response.end(JSON.stringify({ attempt: { id: "attempt-1", state: "clean", findings: [] }, duplicate: false }));
    }
    if (request.url === "/tasks/task-1/delivery/pr") {
      return response.end(JSON.stringify({ pr: { url: "https://github.com/o/r/pull/99" }, duplicate: false }));
    }
    if (request.url === "/tasks/task-1/events") {
      return response.end(JSON.stringify({ task: { id: "task-1", state: "working" } }));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const review = await runCli(serverUrl, home, [
      "autoreview", "run", "--task", "task-1", "--idempotency-key", "review-1",
      "--test-argv-json", '["npm","test"]', "--base-ref", "origin/main"
    ]);
    assert.equal(review.code, 0, review.stderr);
    assert.match(review.stdout, /"state": "clean"/);

    const delivery = await runCli(serverUrl, home, ["delivery", "create-pr", "--task", "task-1", "--idempotency-key", "delivery-1"]);
    assert.equal(delivery.code, 0, delivery.stderr);
    assert.match(delivery.stdout, /pull\/99/);

    const lifecycle = await runCli(serverUrl, home, ["task", "event", "--task", "task-1", "--kind", "working", "--message", "review started"]);
    assert.equal(lifecycle.code, 0, lifecycle.stderr);
    assert.match(lifecycle.stdout, /"working"/);

    assert.deepEqual(requests.filter((entry) => entry.path !== "/health"), [
      {
        path: "/tasks/task-1/autoreview", method: "POST", session: "pty:claude-root", token: "hook-token",
        body: { idempotencyKey: "review-1", testArgv: ["npm", "test"], baseRef: "origin/main" }
      },
      {
        path: "/tasks/task-1/delivery/pr", method: "POST", session: "pty:claude-root", token: "hook-token",
        body: { idempotencyKey: "delivery-1" }
      },
      {
        path: "/tasks/task-1/events", method: "POST", session: "pty:claude-root", token: "hook-token",
        body: { kind: "working", message: "review started" }
      }
    ]);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});
