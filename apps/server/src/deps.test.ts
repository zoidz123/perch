import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession, DoctorResponse, RecentEventsResult } from "@perch/shared";
import type { AgentAdapter } from "./adapters/types.js";
import { AuditLog } from "./audit.js";
import { collectDoctor } from "./deps.js";
import { FleetMonitor } from "./fleetMonitor.js";
import { HookRegistry } from "./hooks.js";
import { createControlServer } from "./http.js";
import { DeviceRegistry } from "./pairing.js";
import { PrPoller } from "./prPoller.js";
import { ProjectRegistry } from "./projects.js";
import type { Project } from "./projects.js";
import { TaskStore } from "./tasks.js";
import { TimelineStore } from "./timeline.js";
import { WorktreePool } from "./worktrees.js";

// Environment doctor: table-driven tool detection against PATH shims (never
// the real binaries - the real no-mistakes writes global state) and
// no-mistakes gate readiness against scratch git repos.

function makeShimDir(): string {
  return mkdtempSync(join(tmpdir(), "perch-doctor-bin-"));
}

function writeShim(dir: string, name: string, script: string): void {
  writeFileSync(join(dir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

function project(rootPath: string, name: string, mode?: Project["mode"]): Project {
  return { rootPath, name, ...(mode ? { mode } : {}), addedAt: "2026-07-07T00:00:00.000Z", lastUsedAt: "2026-07-07T00:00:00.000Z" };
}

test("collectDoctor detects tools on PATH, parses versions, and hints missing ones", async () => {
  const bin = makeShimDir();
  writeShim(bin, "claude", 'echo "2.1.19 (Claude Code)"');
  writeShim(
    bin,
    "gh",
    'if [ "$1" = "--version" ]; then echo "gh version 2.49.0 (2026-01-01)"; exit 0; fi\nexit 1'
  );
  writeShim(
    bin,
    "no-mistakes",
    'if [ "$1" = "--version" ]; then echo "no-mistakes version v1.39.0-perch.1 authorization-protocol=1"; exit 0; fi\nif [ "$1" = "daemon" ]; then exit 0; fi\nexit 1'
  );
  // No codex shim: optional tool missing.
  try {
    const report = await collectDoctor({ env: { PATH: bin }, noMistakesPath: join(bin, "no-mistakes") });
    assert.equal(report.ok, true, "claude present, so required deps are satisfied");

    const claude = report.tools.find((tool) => tool.name === "claude");
    assert.equal(claude?.required, true);
    assert.equal(claude?.found, true);
    assert.equal(claude?.version, "2.1.19");
    assert.equal(claude?.path, join(bin, "claude"));

    const codex = report.tools.find((tool) => tool.name === "codex");
    assert.equal(codex?.required, false);
    assert.equal(codex?.found, false);
    assert.match(codex?.installHint ?? "", /npm install -g @openai\/codex/);

    const gh = report.tools.find((tool) => tool.name === "gh");
    assert.equal(gh?.found, true);
    assert.equal(gh?.version, "2.49.0");
    assert.match(gh?.note ?? "", /gh auth login/, "auth-status exit 1 reads as not authenticated");

    const noMistakes = report.tools.find((tool) => tool.name === "no-mistakes");
    assert.equal(noMistakes?.found, true);
    assert.equal(noMistakes?.version, "v1.39.0-perch.1");
    assert.equal(noMistakes?.note, "daemon running");
    assert.match(noMistakes?.installHint ?? "", /bundled with perchctl/);
    assert.equal(noMistakes?.installer, undefined);
    assert.equal(claude?.installer, undefined, "claude needs its own sign-in; --fix never installs it");
    assert.equal(report.noMistakes.binaryFound, true);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("collectDoctor reports ok=false when a required tool is missing", async () => {
  const bin = makeShimDir();
  try {
    const report = await collectDoctor({ env: { PATH: bin }, noMistakesPath: null });
    assert.equal(report.ok, false);
    const claude = report.tools.find((tool) => tool.name === "claude");
    assert.equal(claude?.found, false);
    assert.match(claude?.installHint ?? "", /@anthropic-ai\/claude-code/);
    assert.equal(report.noMistakes.binaryFound, false);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("collectDoctor probes gh auth and no-mistakes daemon states", async () => {
  const bin = makeShimDir();
  writeShim(bin, "claude", 'echo "2.1.19 (Claude Code)"');
  writeShim(bin, "gh", 'echo "gh version 2.49.0"; exit 0');
  writeShim(
    bin,
    "no-mistakes",
    'if [ "$1" = "daemon" ]; then exit 1; fi\necho "no-mistakes version v1.39.0-perch.1 authorization-protocol=1"'
  );
  try {
    const report = await collectDoctor({ env: { PATH: bin }, noMistakesPath: join(bin, "no-mistakes") });
    assert.equal(report.tools.find((tool) => tool.name === "gh")?.note, "authenticated");
    assert.equal(
      report.tools.find((tool) => tool.name === "no-mistakes")?.note,
      "daemon not running (it autostarts on use)"
    );
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("gate readiness reads the no-mistakes remote from repo config", async () => {
  const bin = makeShimDir();
  writeShim(bin, "claude", 'echo "2.1.19"');
  writeShim(bin, "no-mistakes", 'echo "no-mistakes version v1.39.0-perch.1 authorization-protocol=1"');
  const inited = mkdtempSync(join(tmpdir(), "perch-doctor-inited-"));
  const bare = mkdtempSync(join(tmpdir(), "perch-doctor-uninited-"));
  try {
    for (const repo of [inited, bare]) {
      execFileSync("git", ["init", "-q", repo], { stdio: "pipe" });
    }
    execFileSync("git", ["-C", inited, "remote", "add", "no-mistakes", join(inited, ".fake-gate.git")], {
      stdio: "pipe"
    });

    const report = await collectDoctor({
      env: { PATH: bin },
      noMistakesPath: join(bin, "no-mistakes"),
      projects: [
        project(inited, "gated", "no-mistakes"),
        project(bare, "plain"),
        project(join(bare, "missing-subdir"), "gone")
      ]
    });
    const gates = report.noMistakes.projects;
    assert.equal(gates.length, 3);

    const gated = gates.find((gate) => gate.name === "gated");
    assert.equal(gated?.initialized, true);
    assert.equal(gated?.ready, true, "binary present + remote present = ready");
    assert.equal(gated?.mode, "no-mistakes");

    const plain = gates.find((gate) => gate.name === "plain");
    assert.equal(plain?.initialized, false);
    assert.equal(plain?.ready, false);
    assert.equal(plain?.note, undefined, "absent key is a clean not-initialized, not an error");

    const gone = gates.find((gate) => gate.name === "gone");
    assert.equal(gone?.initialized, false);
    assert.equal(gone?.note, "not a readable git repository");
  } finally {
    rmSync(bin, { recursive: true, force: true });
    rmSync(inited, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test("gate readiness is never ready without the binary", async () => {
  const bin = makeShimDir();
  const repo = mkdtempSync(join(tmpdir(), "perch-doctor-nobin-"));
  try {
    execFileSync("git", ["init", "-q", repo], { stdio: "pipe" });
    execFileSync("git", ["-C", repo, "remote", "add", "no-mistakes", join(repo, ".fake-gate.git")], {
      stdio: "pipe"
    });
    const report = await collectDoctor({ env: { PATH: bin }, noMistakesPath: null, projects: [project(repo, "gated")] });
    const gate = report.noMistakes.projects[0];
    assert.equal(gate?.initialized, true);
    assert.equal(gate?.ready, false);
  } finally {
    rmSync(bin, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// --- `perch doctor --fix` planner (no network, no real installer) -----------

test("planFix never downloads or repairs the bundled no-mistakes runtime", async () => {
  const bin = makeShimDir();
  try {
    // Empty PATH: everything is missing.
    const report = await collectDoctor({ env: { PATH: bin }, noMistakesPath: null });
    assert.deepEqual(
      report.fix.map((action) => `${action.name}:${action.kind}`),
      ["claude:manual", "codex:manual", "gh:manual"]
    );
    assert.equal(report.fix.some((action) => action.name === "no-mistakes"), false);

    const claude = report.fix.find((action) => action.name === "claude");
    assert.deepEqual(claude?.commands, [
      "npm install -g @anthropic-ai/claude-code",
      "claude   # first run opens sign-in (Claude subscription or Anthropic API key)"
    ]);
    const gh = report.fix.find((action) => action.name === "gh");
    assert.deepEqual(gh?.commands, ["brew install gh", "gh auth login"]);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("planFix flags an installed-but-unauthenticated gh and is empty when all is well", async () => {
  const bin = makeShimDir();
  writeShim(bin, "claude", 'echo "2.1.19 (Claude Code)"');
  writeShim(bin, "codex", 'echo "codex-cli 0.9.0"');
  writeShim(bin, "no-mistakes", 'if [ "$1" = "daemon" ]; then exit 0; fi\necho "no-mistakes version v1.39.0-perch.1 authorization-protocol=1"');
  writeShim(bin, "gh", 'if [ "$1" = "--version" ]; then echo "gh version 2.49.0"; exit 0; fi\nexit 1');
  try {
    const unauthed = await collectDoctor({ env: { PATH: bin }, noMistakesPath: join(bin, "no-mistakes") });
    assert.deepEqual(unauthed.fix, [
      { name: "gh", kind: "manual", commands: ["gh auth login"], reason: "installed but not signed in" }
    ]);

    writeShim(bin, "gh", 'echo "gh version 2.49.0"; exit 0');
    const healthy = await collectDoctor({ env: { PATH: bin }, noMistakesPath: join(bin, "no-mistakes") });
    assert.deepEqual(healthy.fix, [], "idempotent re-run: nothing to fix once everything is present");
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("no-mistakes probes run with the telemetry opt-out unless the user exported the variable", async () => {
  const bin = makeShimDir();
  // The shim's reported patch version echoes the effective telemetry
  // setting, so the assertion reads it back out of the parsed version.
  writeShim(bin, "claude", 'echo "2.1.19"');
  writeShim(bin, "no-mistakes", 'echo "no-mistakes version v9.9.$NO_MISTAKES_TELEMETRY authorization-protocol=1"');
  const saved = process.env.NO_MISTAKES_TELEMETRY;
  try {
    delete process.env.NO_MISTAKES_TELEMETRY;
    const defaulted = await collectDoctor({ env: { PATH: bin }, noMistakesPath: join(bin, "no-mistakes") });
    assert.equal(
      defaulted.tools.find((tool) => tool.name === "no-mistakes")?.version,
      "v9.9.0",
      "perch defaults the opt-out for its own no-mistakes invocations"
    );

    process.env.NO_MISTAKES_TELEMETRY = "1";
    const reEnabled = await collectDoctor({ env: { PATH: bin }, noMistakesPath: join(bin, "no-mistakes") });
    assert.equal(
      reEnabled.tools.find((tool) => tool.name === "no-mistakes")?.version,
      "v9.9.1",
      "an exported value wins - the opt-out is reversible"
    );
  } finally {
    if (saved === undefined) delete process.env.NO_MISTAKES_TELEMETRY;
    else process.env.NO_MISTAKES_TELEMETRY = saved;
    rmSync(bin, { recursive: true, force: true });
  }
});

// --- GET /doctor wiring ------------------------------------------------------

class NoopAdapter implements AgentAdapter {
  readonly name = "fake-pty";
  async getTopology() {
    return { windows: [], generatedAt: "" };
  }
  async listSessions(): Promise<AgentSession[]> {
    return [];
  }
  async readRecentEvents(): Promise<RecentEventsResult> {
    return { events: [], terminal: true };
  }
  async sendInput(): Promise<void> {}
  async sendEnter(): Promise<void> {}
  async interrupt(): Promise<void> {}
}

test("GET /doctor is authed and returns the report for registered projects", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-doctor-http-"));
  const bin = makeShimDir();
  writeShim(bin, "claude", 'echo "2.1.19 (Claude Code)"');
  const repo = mkdtempSync(join(tmpdir(), "perch-doctor-repo-"));
  execFileSync("git", ["init", "-q", repo], { stdio: "pipe" });

  const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
  const adapter = new NoopAdapter();
  const monitor = new FleetMonitor(adapter, { broadcastMs: 5 });
  const tasks = new TaskStore(env);
  const projects = new ProjectRegistry(env);
  const timeline = new TimelineStore();
  const server = createControlServer({
    adapter,
    auditLog: new AuditLog(join(home, "audit.jsonl")),
    authToken: "test-token",
    boxSecretKey: new Uint8Array(32),
    monitor,
    devices: new DeviceRegistry(env),
    port: 0,
    hooks: new HookRegistry(),
    timeline,
    projects,
    worktrees: new WorktreePool({ env }),
    tasks,
    prPoller: new PrPoller(tasks, async () => {
      throw new Error("gh disabled in tests");
    }),
    doctorDeps: { env: { PATH: bin }, noMistakesPath: null }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    projects.touch(repo);

    const unauthed = await fetch(`http://127.0.0.1:${port}/doctor`);
    assert.equal(unauthed.status, 401);

    const response = await fetch(`http://127.0.0.1:${port}/doctor`, {
      headers: { authorization: "Bearer test-token" }
    });
    assert.equal(response.status, 200);
    const report = (await response.json()) as DoctorResponse;
    assert.equal(report.ok, true);
    assert.deepEqual(
      report.tools.map((tool) => tool.name),
      ["claude", "codex", "gh", "no-mistakes"]
    );
    assert.equal(report.noMistakes.binaryFound, false);
    assert.equal(report.noMistakes.projects.length, 1);
    assert.equal(report.noMistakes.projects[0]?.rootPath, repo);
    assert.equal(report.noMistakes.projects[0]?.initialized, false);
  } finally {
    timeline.stop();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
