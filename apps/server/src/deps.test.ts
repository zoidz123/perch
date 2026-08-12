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
import { TaskStore } from "./tasks.js";
import { TimelineStore } from "./timeline.js";
import { WorktreePool } from "./worktrees.js";

// Environment doctor: table-driven tool detection against PATH shims, never
// the real binaries.

function makeShimDir(): string {
  return mkdtempSync(join(tmpdir(), "perch-doctor-bin-"));
}

function writeShim(dir: string, name: string, script: string): void {
  writeFileSync(join(dir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

test("collectDoctor detects tools on PATH, parses versions, and hints missing ones", async () => {
  const bin = makeShimDir();
  writeShim(bin, "claude", 'echo "2.1.19 (Claude Code)"');
  writeShim(
    bin,
    "gh",
    'if [ "$1" = "--version" ]; then echo "gh version 2.49.0 (2026-01-01)"; exit 0; fi\nexit 1'
  );
  // No codex shim: optional tool missing.
  try {
    const report = await collectDoctor({ env: { PATH: bin } });
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

    assert.equal(claude?.installer, undefined, "claude needs its own sign-in; --fix never installs it");
    assert.deepEqual(report.tools.map((tool) => tool.name), ["claude", "codex", "gh"]);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("collectDoctor reports ok=false when a required tool is missing", async () => {
  const bin = makeShimDir();
  try {
    const report = await collectDoctor({ env: { PATH: bin } });
    assert.equal(report.ok, false);
    const claude = report.tools.find((tool) => tool.name === "claude");
    assert.equal(claude?.found, false);
    assert.match(claude?.installHint ?? "", /@anthropic-ai\/claude-code/);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("collectDoctor probes gh auth state", async () => {
  const bin = makeShimDir();
  writeShim(bin, "claude", 'echo "2.1.19 (Claude Code)"');
  writeShim(bin, "gh", 'echo "gh version 2.49.0"; exit 0');
  try {
    const report = await collectDoctor({ env: { PATH: bin } });
    assert.equal(report.tools.find((tool) => tool.name === "gh")?.note, "authenticated");
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

// --- `perch doctor --fix` planner (no network, no real installer) -----------

test("planFix reports every missing tool as a manual, sign-in-bearing install", async () => {
  const bin = makeShimDir();
  try {
    // Empty PATH: everything is missing.
    const report = await collectDoctor({ env: { PATH: bin } });
    assert.deepEqual(
      report.fix.map((action) => `${action.name}:${action.kind}`),
      ["claude:manual", "codex:manual", "gh:manual"]
    );

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
  writeShim(bin, "gh", 'if [ "$1" = "--version" ]; then echo "gh version 2.49.0"; exit 0; fi\nexit 1');
  try {
    const unauthed = await collectDoctor({ env: { PATH: bin } });
    assert.deepEqual(unauthed.fix, [
      { name: "gh", kind: "manual", commands: ["gh auth login"], reason: "installed but not signed in" }
    ]);

    writeShim(bin, "gh", 'echo "gh version 2.49.0"; exit 0');
    const healthy = await collectDoctor({ env: { PATH: bin } });
    assert.deepEqual(healthy.fix, [], "idempotent re-run: nothing to fix once everything is present");
  } finally {
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

test("GET /doctor is authed and returns the environment report", async () => {
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
    doctorDeps: { env: { PATH: bin } }
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
      ["claude", "codex", "gh"]
    );
    assert.equal(Object.hasOwn(report, "noMistakes"), false, "the retired gate block is gone from the wire");
  } finally {
    timeline.stop();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
