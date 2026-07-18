import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    // Claude keys entries by the fully resolved cwd (tmpdir is symlinked on
    // macOS), so assertions look the entry up the same way.
    key: realpathSync(worktree),
    read: () => JSON.parse(readFileSync(stateFile, "utf8")),
    cleanup: () => rmSync(home, { recursive: true, force: true })
  };
}

test("claudeStateFilePath honors CLAUDE_CONFIG_DIR and falls back to the home root", () => {
  assert.equal(claudeStateFilePath({ CLAUDE_CONFIG_DIR: "/tmp/claude-config" }), "/tmp/claude-config/.claude.json");
  assert.match(claudeStateFilePath({}), /\/\.claude\.json$/);
  assert.ok(!claudeStateFilePath({}).includes("/.claude/"));
});

test("seeding creates the state file with Claude's own worktree entry shape when absent", () => {
  const fx = fixture();
  try {
    assert.equal(seedClaudeWorktreeTrust(fx.stateFile, fx.worktree), true);
    assert.deepEqual(fx.read().projects[fx.key], {
      allowedTools: [],
      mcpContextUris: [],
      enabledMcpjsonServers: [],
      disabledMcpjsonServers: [],
      hasTrustDialogAccepted: true,
      projectOnboardingSeenCount: 0,
      hasClaudeMdExternalIncludesApproved: false,
      hasClaudeMdExternalIncludesWarningShown: false
    });
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
    assert.equal(state.projects[fx.key].hasTrustDialogAccepted, true);

    // A second project entry rides along untouched.
    const other = { hasTrustDialogAccepted: false, allowedTools: ["Bash"] };
    writeFileSync(fx.stateFile, JSON.stringify({ projects: { "/somewhere/else": other, [fx.key]: undefined } }));
    assert.equal(seedClaudeWorktreeTrust(fx.stateFile, fx.worktree), true);
    assert.deepEqual(fx.read().projects["/somewhere/else"], other);
  } finally {
    fx.cleanup();
  }
});

test("an existing entry keeps its fields and only gains trust; a trusted one is left alone", () => {
  const fx = fixture();
  try {
    writeFileSync(
      fx.stateFile,
      JSON.stringify({
        projects: {
          [fx.key]: { hasTrustDialogAccepted: false, allowedTools: ["Read"], customField: "kept" }
        }
      })
    );
    assert.equal(seedClaudeWorktreeTrust(fx.stateFile, fx.worktree), true);
    assert.deepEqual(fx.read().projects[fx.key], {
      hasTrustDialogAccepted: true,
      allowedTools: ["Read"],
      customField: "kept"
    });

    // Already trusted: no rewrite at all (a live Claude may own the file).
    writeFileSync(fx.stateFile, JSON.stringify({ projects: { [fx.key]: { hasTrustDialogAccepted: true } } }));
    const before = readFileSync(fx.stateFile, "utf8");
    assert.equal(seedClaudeWorktreeTrust(fx.stateFile, fx.worktree), true);
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
