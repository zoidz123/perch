import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PERCH_BIN = fileURLToPath(new URL("../../../bin/perch.mjs", import.meta.url));

test("server stop waits for delayed exit before an immediate start", async () => {
  const fixture = await createCliFixture(500);

  try {
    await runCli(fixture, "start");
    const stopped = await runCli(fixture, "stop");
    assert.match(stopped.stdout, /stopped/);
    await assertPortCanBind(fixture.port);

    const restarted = await runCli(fixture, "start");
    assert.match(restarted.stdout, /running/);
    await waitForPort(fixture.port);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("concurrent server starts converge on one healthy server", async () => {
  const fixture = await createCliFixture(0);

  try {
    const starts = await Promise.all([runCli(fixture, "start"), runCli(fixture, "start")]);
    for (const result of starts) {
      assert.match(result.stdout, /running/);
    }
    await waitForPort(fixture.port);
    assert.ok(readPid(fixture));
    assert.equal(
      readFileSync(fixture.log, "utf8")
        .split("\n")
        .filter((line) => line === "fixture listening").length,
      1
    );
  } finally {
    await cleanupFixture(fixture);
  }
});

test("server stop fails closed when process inspection fails", async () => {
  const fixture = await createCliFixture(0);
  const fakeBin = join(fixture.root, "fake-bin");
  mkdirSync(fakeBin);
  const fakePs = join(fakeBin, "ps");
  writeFileSync(fakePs, "#!/bin/sh\nexit 2\n");
  chmodSync(fakePs, 0o755);

  try {
    await runCli(fixture, "start");
    await assert.rejects(
      runCli(fixture, "stop", { PATH: `${fakeBin}:${process.env.PATH ?? ""}` }),
      /could not verify server pid/
    );
    await waitForPort(fixture.port);
  } finally {
    await cleanupFixture(fixture);
  }
});

type CliFixture = {
  root: string;
  home: string;
  bin: string;
  log: string;
  port: number;
};

async function createCliFixture(shutdownDelayMs: number): Promise<CliFixture> {
  const root = mkdtempSync(join(tmpdir(), "perch-server-stop-"));
  const home = join(root, "home");
  const bin = join(root, "bin", "perch.mjs");
  const entry = join(root, "apps", "server", "dist", "index.js");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(bin, ".."), { recursive: true });
  mkdirSync(join(entry, ".."), { recursive: true });
  mkdirSync(join(root, "vendor", "no-mistakes"), { recursive: true });
  mkdirSync(join(root, "node_modules", "ws"), { recursive: true });
  copyFileSync(PERCH_BIN, bin);
  chmodSync(bin, 0o755);
  writeFileSync(join(root, "package.json"), '{"type":"module","version":"0.0.0"}\n');
  writeFileSync(join(root, "vendor", "no-mistakes", "manifest.json"), "{}\n");
  writeFileSync(join(root, "node_modules", "ws", "package.json"), '{"type":"module","exports":"./index.js"}\n');
  writeFileSync(join(root, "node_modules", "ws", "index.js"), "export default class WebSocket {}\n");
  writeFileSync(
    entry,
    [
      'import { writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'import { createServer } from "node:http";',
      "const server = createServer((request, response) => {",
      '  if (request.url === "/health") {',
      '    response.writeHead(200, { "content-type": "application/json" });',
      '    response.end(JSON.stringify({ ok: true, adapter: "fixture", version: "0.0.0" }));',
      "    return;",
      "  }",
      "  response.writeHead(404);",
      "  response.end();",
      "});",
      'server.listen(Number(process.env.PORT), "127.0.0.1", () => {',
      '  writeFileSync(join(process.env.PERCH_HOME, "perch.pid"), String(process.pid));',
      '  console.log("fixture listening");',
      "});",
      'process.on("SIGTERM", () => {',
      `  setTimeout(() => server.close(() => process.exit(0)), ${shutdownDelayMs});`,
      "});"
    ].join("\n")
  );

  const port = await availablePort();
  return { root, home, bin, log: join(home, "server.log"), port };
}

async function runCli(
  fixture: CliFixture,
  action: "start" | "stop",
  env: NodeJS.ProcessEnv = {}
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [fixture.bin, "server", action], {
    env: {
      ...process.env,
      PERCH_HOME: fixture.home,
      PERCH_SERVER_URL: `http://127.0.0.1:${fixture.port}`,
      PERCH_RELAY_URL: "off",
      ...env
    }
  });
}

async function cleanupFixture(fixture: CliFixture): Promise<void> {
  const pid = readPid(fixture);
  if (pid && isAlive(pid)) {
    process.kill(pid, "SIGKILL");
    const deadline = Date.now() + 2_000;
    while (isAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  rmSync(fixture.root, { recursive: true, force: true });
}

function readPid(fixture: CliFixture): number | undefined {
  try {
    const pid = Number(readFileSync(join(fixture.home, "perch.pid"), "utf8").trim());
    return Number.isInteger(pid) && pid > 1 ? pid : undefined;
  } catch {
    return undefined;
  }
}

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
