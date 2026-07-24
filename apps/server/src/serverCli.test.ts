import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PERCH_BIN = fileURLToPath(new URL("../../../bin/perch.mjs", import.meta.url));

test("perch server stop waits until the server process releases its port", async () => {
  const root = mkdtempSync(join(tmpdir(), "perch-server-stop-"));
  const home = join(root, "home");
  const entry = join(root, "apps", "server", "dist", "index.js");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(entry, ".."), { recursive: true });
  writeFileSync(
    entry,
    [
      'import { createServer } from "node:net";',
      "const server = createServer();",
      'server.listen(Number(process.env.PORT), "127.0.0.1");',
      'process.on("SIGTERM", () => {',
      "  setTimeout(() => server.close(() => process.exit(0)), 500);",
      "});"
    ].join("\n")
  );

  const port = await availablePort();
  const child = execFile(process.execPath, [entry], {
    env: { ...process.env, PORT: String(port) }
  });
  assert.ok(child.pid);
  writeFileSync(join(home, "perch.pid"), String(child.pid));

  try {
    await waitForPort(port);
    const result = await execFileAsync(process.execPath, [PERCH_BIN, "server", "stop"], {
      env: {
        ...process.env,
        PERCH_HOME: home,
        PERCH_SERVER_URL: `http://127.0.0.1:${port}`
      }
    });
    assert.match(result.stdout, /stopped/);
    await assertPortCanBind(port);
  } finally {
    if (child.pid && isAlive(child.pid)) {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    rmSync(root, { recursive: true, force: true });
  }
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (
      await new Promise<boolean>((resolve) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
      })
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`fixture server did not listen on port ${port}`);
}

async function assertPortCanBind(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
