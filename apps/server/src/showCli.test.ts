import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PERCH_BIN = fileURLToPath(new URL("../../../bin/perch.mjs", import.meta.url));

type CliResult = { code: number; stdout: string; stderr: string };

const sessions = [
  {
    id: "pty:mate",
    title: "mate",
    agent: "codex",
    labels: { role: "mate" },
    kind: "terminal",
    status: "running",
    lastActivityAt: "2026-08-13T17:00:00.000Z"
  },
  {
    id: "pty:alder",
    title: "codex - Add fleet view",
    workerName: "Alder",
    agent: "codex",
    kind: "terminal",
    status: "running",
    lastActivityAt: "2026-08-13T17:00:00.000Z"
  },
  {
    id: "pty:birch",
    title: "claude - Fix status",
    workerName: "Birch",
    agent: "claude",
    kind: "terminal",
    status: "waiting",
    lastActivityAt: "2026-08-13T17:00:00.000Z"
  },
  {
    id: "pty:ended",
    title: "ended worker",
    workerName: "Cedar",
    agent: "codex",
    kind: "terminal",
    status: "done",
    lastActivityAt: "2026-08-13T17:00:00.000Z"
  }
];

const tasks = [
  { id: "alder-task", title: "Add fleet view", workerName: "Alder", sessionId: "pty:alder", state: "working" },
  { id: "birch-task", title: "Fix status", workerName: "Birch", runtime: { ptySessionId: "pty:birch" }, state: "working" },
  { id: "ended-task", title: "Finished", workerName: "Cedar", sessionId: "pty:ended", state: "done" }
];

async function runShow(serverUrl: string, home: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [PERCH_BIN, "show", ...args], {
      env: { ...process.env, PERCH_HOME: home, PERCH_SERVER_URL: serverUrl, PERCH_TOKEN: "test-token", ...extraEnv }
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function withFleetServer(run: (serverUrl: string) => Promise<void>) {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") response.end(JSON.stringify({ ok: true, adapter: "stub" }));
    else if (request.url === "/sessions") response.end(JSON.stringify({ sessions }));
    else if (request.url === "/tasks") response.end(JSON.stringify({ tasks }));
    else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    }
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

function createCmuxMock() {
  const root = mkdtempSync(join(tmpdir(), "perch-show-cmux-"));
  const bin = join(root, "bin");
  const statePath = join(root, "state.json");
  const logPath = join(root, "commands.jsonl");
  const script = join(bin, "cmux");
  const source = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const statePath = process.env.CMUX_SHOW_STATE;
const logPath = process.env.CMUX_SHOW_LOG;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
if (args[0] === "identify" && args[1] === "--json") {
  console.log(JSON.stringify({ caller: { workspace_ref: "workspace:7", window_ref: "window:2" } }));
  process.exit(0);
}
const state = JSON.parse(readFileSync(statePath, "utf8"));
if (args[0] === "workspace" && args[1] === "list") {
  console.log(JSON.stringify({ workspaces: state.workspaces }));
  process.exit(0);
}
if (args[0] === "workspace" && args[1] === "create") {
  const value = (flag) => args[args.indexOf(flag) + 1];
  state.workspaces.push({ title: value("--name"), description: value("--description") });
  writeFileSync(statePath, JSON.stringify(state));
  process.exit(0);
}
console.error("unexpected cmux command: " + args.join(" "));
process.exit(2);
`;
  mkdirSync(bin);
  writeFileSync(script, source);
  chmodSync(script, 0o755);
  writeFileSync(statePath, JSON.stringify({ workspaces: [] }));
  writeFileSync(logPath, "");
  return {
    root,
    env: {
      CMUX_WORKSPACE_ID: "workspace-current",
      CMUX_SHOW_STATE: statePath,
      CMUX_SHOW_LOG: logPath,
      PATH: `${bin}:${process.env.PATH ?? ""}`
    },
    state: () => JSON.parse(readFileSync(statePath, "utf8")) as { workspaces: Array<{ title: string; description: string }> },
    commands: () => readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[])
  };
}

test("perch show auto-detects cmux, creates named worker workspaces once, and can include Mate", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-show-cli-"));
  const cmux = createCmuxMock();
  try {
    await withFleetServer(async (serverUrl) => {
      const first = await runShow(serverUrl, home, [], cmux.env);
      assert.equal(first.code, 0, first.stderr);
      assert.equal(first.stdout, "cmux fleet: added 2, already present 0\n");
      assert.deepEqual(cmux.state().workspaces, [
        { title: "Perch: Alder - Add fleet view", description: "perch-show session=pty:alder" },
        { title: "Perch: Birch - Fix status", description: "perch-show session=pty:birch" }
      ]);
      assert.ok(cmux.commands().some((args) => args.includes("perch attach pty:alder")));
      assert.ok(cmux.commands().some((args) => args.includes("perch attach pty:birch")));

      const second = await runShow(serverUrl, home, ["cmux"], cmux.env);
      assert.equal(second.code, 0, second.stderr);
      assert.equal(second.stdout, "cmux fleet: added 0, already present 2\n");

      const all = await runShow(serverUrl, home, ["cmux", "--all"], cmux.env);
      assert.equal(all.code, 0, all.stderr);
      assert.equal(all.stdout, "cmux fleet: added 1, already present 2\n");
      assert.deepEqual(cmux.state().workspaces[2], {
        title: "Perch: Mate - mate",
        description: "perch-show session=pty:mate"
      });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cmux.root, { recursive: true, force: true });
  }
});

test("perch show cmux --once prints exact attach commands without cmux", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-show-cli-"));
  try {
    await withFleetServer(async (serverUrl) => {
      const workers = await runShow(serverUrl, home, ["cmux", "--once"], { CMUX_WORKSPACE_ID: "" });
      assert.equal(workers.code, 0, workers.stderr);
      assert.equal(workers.stdout, "perch attach pty:alder\nperch attach pty:birch\n");

      const all = await runShow(serverUrl, home, ["cmux", "--all", "--once"], { CMUX_WORKSPACE_ID: "" });
      assert.equal(all.code, 0, all.stderr);
      assert.equal(all.stdout, "perch attach pty:mate\nperch attach pty:alder\nperch attach pty:birch\n");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("perch show names required and unknown backends clearly", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-show-cli-"));
  try {
    await withFleetServer(async (serverUrl) => {
      const missing = await runShow(serverUrl, home, [], { CMUX_WORKSPACE_ID: "" });
      assert.equal(missing.code, 1);
      assert.match(missing.stderr, /could not auto-detect a terminal backend; supported backends: cmux/);

      const unknown = await runShow(serverUrl, home, ["ghostty"]);
      assert.equal(unknown.code, 1);
      assert.match(unknown.stderr, /unknown show backend: ghostty \(supported: cmux\)/);

      const invalid = await runShow(serverUrl, home, ["cmux", "--bad"]);
      assert.equal(invalid.code, 1);
      assert.match(invalid.stderr, /unknown show option: --bad/);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
