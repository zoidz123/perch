import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { claudeStateFilePath, seedClaudeWorktreeTrust } from "./claudeTrust.js";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "perch-claude-trust-"));
  const stateFile = join(home, ".claude.json");
  const worktree = join(home, "worktrees", "repo-abc123", "1", "repo");
  mkdirSync(worktree, { recursive: true });
  return {
    home,
    stateFile,
    worktree,
    key: realpathSync(worktree),
    read: () => JSON.parse(readFileSync(stateFile, "utf8")),
    cleanup: () => rmSync(home, { recursive: true, force: true })
  };
}

function atomicWrite(path: string, state: unknown): void {
  const temp = `${path}.external-${process.pid}-${randomUUID()}`;
  writeFileSync(temp, JSON.stringify(state));
  renameSync(temp, path);
}

function trustTemps(stateFile: string): string[] {
  const prefix = `${stateFile.split("/").at(-1)}.perch-tmp-`;
  return readdirSync(dirname(stateFile)).filter((entry) => entry.startsWith(prefix));
}

async function waitForFiles(paths: string[], timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every(existsSync)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${paths.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function childCompletion(child: ChildProcessWithoutNullStreams): Promise<{ stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`child exited ${code}: ${stderr || stdout}`));
    });
  });
}

test("claudeStateFilePath honors CLAUDE_CONFIG_DIR and falls back to the home root", () => {
  assert.equal(claudeStateFilePath({ CLAUDE_CONFIG_DIR: "/tmp/claude-config" }), "/tmp/claude-config/.claude.json");
  assert.match(claudeStateFilePath({}), /\/\.claude\.json$/);
  assert.ok(!claudeStateFilePath({}).includes("/.claude/"));
});

test("seeding creates only Claude's supported trust field when state is absent", () => {
  const fx = fixture();
  try {
    assert.equal(seedClaudeWorktreeTrust(fx.stateFile, fx.worktree), true);
    assert.deepEqual(fx.read().projects[fx.key], { hasTrustDialogAccepted: true });
  } finally {
    fx.cleanup();
  }
});

test("seeding preserves unknown top-level fields, other projects, and a missing projects key", () => {
  const fx = fixture();
  try {
    writeFileSync(
      fx.stateFile,
      JSON.stringify({
        numStartups: 42,
        oauthAccount: { emailAddress: "boss@example.com" },
        tipsHistory: { "shift-enter": 3 }
      })
    );
    assert.equal(seedClaudeWorktreeTrust(fx.stateFile, fx.worktree), true);
    const state = fx.read();
    assert.equal(state.numStartups, 42);
    assert.deepEqual(state.oauthAccount, { emailAddress: "boss@example.com" });
    assert.deepEqual(state.tipsHistory, { "shift-enter": 3 });
    assert.deepEqual(state.projects[fx.key], { hasTrustDialogAccepted: true });

    const other = { hasTrustDialogAccepted: false, allowedTools: ["Bash"] };
    writeFileSync(fx.stateFile, JSON.stringify({ projects: { "/somewhere/else": other } }));
    assert.equal(seedClaudeWorktreeTrust(fx.stateFile, fx.worktree), true);
    assert.deepEqual(fx.read().projects["/somewhere/else"], other);
  } finally {
    fx.cleanup();
  }
});

test("an existing undecided entry keeps its fields and a trusted entry is a byte-for-byte no-op", () => {
  const fx = fixture();
  try {
    writeFileSync(
      fx.stateFile,
      JSON.stringify({ projects: { [fx.key]: { allowedTools: ["Read"], customField: "kept" } } })
    );
    assert.equal(seedClaudeWorktreeTrust(fx.stateFile, fx.worktree), true);
    assert.deepEqual(fx.read().projects[fx.key], {
      hasTrustDialogAccepted: true,
      allowedTools: ["Read"],
      customField: "kept"
    });

    writeFileSync(fx.stateFile, JSON.stringify({ projects: { [fx.key]: { hasTrustDialogAccepted: true } } }));
    const before = readFileSync(fx.stateFile, "utf8");
    assert.equal(seedClaudeWorktreeTrust(fx.stateFile, fx.worktree), true);
    assert.equal(readFileSync(fx.stateFile, "utf8"), before);
  } finally {
    fx.cleanup();
  }
});

test("an explicit human trust decline remains false and is not rewritten", () => {
  const fx = fixture();
  try {
    writeFileSync(
      fx.stateFile,
      JSON.stringify({ projects: { [fx.key]: { hasTrustDialogAccepted: false, customField: "kept" } } })
    );
    const before = readFileSync(fx.stateFile, "utf8");
    assert.equal(seedClaudeWorktreeTrust(fx.stateFile, fx.worktree), false);
    assert.equal(readFileSync(fx.stateFile, "utf8"), before);
  } finally {
    fx.cleanup();
  }
});

test("a corrupt or non-object state file is never touched", () => {
  const fx = fixture();
  try {
    for (const content of ["{ not json", "[]", JSON.stringify({ projects: "nope" })]) {
      writeFileSync(fx.stateFile, content);
      assert.equal(seedClaudeWorktreeTrust(fx.stateFile, fx.worktree), false);
      assert.equal(readFileSync(fx.stateFile, "utf8"), content);
    }
  } finally {
    fx.cleanup();
  }
});

test("a Claude rewrite before replace causes a retry from newest bytes", () => {
  const fx = fixture();
  const temps: string[] = [];
  try {
    writeFileSync(fx.stateFile, JSON.stringify({ oauthToken: "token-before", projects: {} }));
    assert.equal(
      seedClaudeWorktreeTrust(fx.stateFile, fx.worktree, {
        beforeReplace(attempt, target, temp) {
          temps.push(temp);
          if (attempt === 1) {
            atomicWrite(target, {
              oauthToken: "token-after",
              claudeCommit: 1,
              projects: { "/claude-owned": { hasTrustDialogAccepted: true } }
            });
          }
        }
      }),
      true
    );
    const state = fx.read();
    assert.equal(state.oauthToken, "token-after");
    assert.equal(state.claudeCommit, 1);
    assert.equal(state.projects["/claude-owned"].hasTrustDialogAccepted, true);
    assert.equal(state.projects[fx.key].hasTrustDialogAccepted, true);
    assert.equal(temps.length, 2);
    assert.equal(new Set(temps).size, 2);
    assert.deepEqual(trustTemps(fx.stateFile), []);
  } finally {
    fx.cleanup();
  }
});

test("a Claude rewrite after replace is detected and the trust merge is retried", () => {
  const fx = fixture();
  try {
    writeFileSync(fx.stateFile, JSON.stringify({ oauthToken: "token-before", projects: {} }));
    let replacements = 0;
    assert.equal(
      seedClaudeWorktreeTrust(fx.stateFile, fx.worktree, {
        afterReplace(attempt, target) {
          replacements += 1;
          if (attempt === 1) {
            atomicWrite(target, {
              oauthToken: "token-after",
              claudeCommit: 2,
              projects: { "/claude-owned": { hasTrustDialogAccepted: true } }
            });
          }
        }
      }),
      true
    );
    const state = fx.read();
    assert.equal(replacements, 2);
    assert.equal(state.oauthToken, "token-after");
    assert.equal(state.claudeCommit, 2);
    assert.equal(state.projects["/claude-owned"].hasTrustDialogAccepted, true);
    assert.equal(state.projects[fx.key].hasTrustDialogAccepted, true);
  } finally {
    fx.cleanup();
  }
});

test("five changing snapshots fail honestly and clean every unique temporary file", () => {
  const fx = fixture();
  const temps: string[] = [];
  try {
    writeFileSync(fx.stateFile, JSON.stringify({ projects: {} }));
    assert.equal(
      seedClaudeWorktreeTrust(fx.stateFile, fx.worktree, {
        beforeReplace(attempt, target, temp) {
          temps.push(temp);
          atomicWrite(target, { claudeCommit: attempt, oauthToken: `token-${attempt}`, projects: {} });
        }
      }),
      false
    );
    assert.equal(temps.length, 5);
    assert.equal(new Set(temps).size, 5);
    assert.equal(fx.read().claudeCommit, 5);
    assert.equal(fx.read().oauthToken, "token-5");
    assert.equal(fx.read().projects[fx.key], undefined);
    assert.deepEqual(trustTemps(fx.stateFile), []);
  } finally {
    fx.cleanup();
  }
});

test("seeding writes through a symlink without replacing the link", () => {
  const fx = fixture();
  try {
    const target = join(fx.home, "state", "claude.json");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ oauthToken: "kept", projects: {} }));
    symlinkSync(target, fx.stateFile);

    assert.equal(seedClaudeWorktreeTrust(fx.stateFile, fx.worktree), true);
    assert.equal(lstatSync(fx.stateFile).isSymbolicLink(), true);
    const state = JSON.parse(readFileSync(target, "utf8"));
    assert.equal(state.oauthToken, "kept");
    assert.equal(state.projects[fx.key].hasTrustDialogAccepted, true);
    assert.deepEqual(trustTemps(target), []);
  } finally {
    fx.cleanup();
  }
});

test("the temporary file is fsynced before replace", () => {
  const fx = fixture();
  const events: string[] = [];
  try {
    writeFileSync(fx.stateFile, JSON.stringify({ projects: {} }));
    assert.equal(
      seedClaudeWorktreeTrust(fx.stateFile, fx.worktree, {
        fsync() {
          events.push("fsync");
        },
        beforeReplace() {
          events.push("replace");
        }
      }),
      true
    );
    assert.deepEqual(events, ["fsync", "replace"]);
  } finally {
    fx.cleanup();
  }
});

test("fsync and pre-replace errors leave the target untouched and remove the temporary file", () => {
  for (const failure of ["fsync", "replace"] as const) {
    const fx = fixture();
    try {
      writeFileSync(fx.stateFile, JSON.stringify({ oauthToken: "kept", projects: {} }));
      const before = readFileSync(fx.stateFile, "utf8");
      assert.equal(
        seedClaudeWorktreeTrust(fx.stateFile, fx.worktree, {
          fsync() {
            if (failure === "fsync") throw new Error("forced fsync failure");
          },
          beforeReplace() {
            if (failure === "replace") throw new Error("forced replace failure");
          }
        }),
        false
      );
      assert.equal(readFileSync(fx.stateFile, "utf8"), before);
      assert.deepEqual(trustTemps(fx.stateFile), []);
    } finally {
      fx.cleanup();
    }
  }
});

test("parallel Perch processes preserve both existing fields and both trust entries", async () => {
  const fx = fixture();
  const worktreeB = join(fx.home, "worktrees", "repo-abc123", "2", "repo");
  mkdirSync(worktreeB, { recursive: true });
  const keyB = realpathSync(worktreeB);
  const checked = [join(fx.home, "checked-a"), join(fx.home, "checked-b")];
  const renamed = [join(fx.home, "renamed-a"), join(fx.home, "renamed-b")];
  const releaseRename = join(fx.home, "release-rename");
  const releaseVerify = join(fx.home, "release-verify");
  const moduleUrl = new URL("./claudeTrust.ts", import.meta.url).href;
  const childSource = `
    const [moduleUrl, stateFile, worktree, checked, renamed, releaseRename, releaseVerify] = process.argv.slice(1);
    const { existsSync, writeFileSync } = await import("node:fs");
    const { seedClaudeWorktreeTrust } = await import(moduleUrl);
    const wait = (path) => {
      const cell = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(path)) Atomics.wait(cell, 0, 0, 10);
    };
    const ok = seedClaudeWorktreeTrust(stateFile, worktree, {
      afterVersionCheck(attempt) {
        if (attempt !== 1) return;
        writeFileSync(checked, "ready");
        wait(releaseRename);
      },
      afterReplace(attempt) {
        if (attempt !== 1) return;
        writeFileSync(renamed, "ready");
        wait(releaseVerify);
      }
    });
    process.exit(ok ? 0 : 1);
  `;
  const childArgs = (worktree: string, index: number) => [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    childSource,
    moduleUrl,
    fx.stateFile,
    worktree,
    checked[index]!,
    renamed[index]!,
    releaseRename,
    releaseVerify
  ];
  let children: ChildProcessWithoutNullStreams[] = [];
  try {
    writeFileSync(
      fx.stateFile,
      JSON.stringify({
        padding: "x".repeat(2_000_000),
        projects: {
          [fx.key]: { writerField: "alpha" },
          [keyB]: { writerField: "beta" }
        }
      })
    );
    children = [
      spawn(process.execPath, childArgs(fx.worktree, 0)),
      spawn(process.execPath, childArgs(worktreeB, 1))
    ];
    const completions = children.map(childCompletion);
    await waitForFiles(checked);
    writeFileSync(releaseRename, "go");
    await waitForFiles(renamed);
    writeFileSync(releaseVerify, "go");
    await Promise.all(completions);

    const state = fx.read();
    assert.deepEqual(state.projects[fx.key], { writerField: "alpha", hasTrustDialogAccepted: true });
    assert.deepEqual(state.projects[keyB], { writerField: "beta", hasTrustDialogAccepted: true });
    assert.deepEqual(trustTemps(fx.stateFile), []);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
    fx.cleanup();
  }
});
