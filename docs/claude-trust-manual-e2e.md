# Claude folder trust manual E2E

This check confirms both the trust-dialog skip and the manual fallback against an installed Claude Code binary.
It never reads or writes the real Claude state file.

## Confirm the supported state field

Record the installed version.

```sh
claude --version
```

Confirm that the installed binary still names `projects[<canonical path>].hasTrustDialogAccepted: true` as the headless workspace trust state.

```sh
strings "$(realpath "$(command -v claude)")" | rg -F "hasTrustDialogAccepted"
```

If Claude stops naming that field, stop and update the integration before relying on the seed.

## Confirm the dialog is skipped

Run these commands from the Perch repository root.

```sh
export CLAUDE_TRUST_E2E_ROOT="$(mktemp -d)"
export CLAUDE_TRUST_E2E_CONFIG="$CLAUDE_TRUST_E2E_ROOT/config"
export CLAUDE_TRUST_E2E_HOME="$CLAUDE_TRUST_E2E_ROOT/home"
export CLAUDE_TRUST_E2E_WORKTREE="$CLAUDE_TRUST_E2E_ROOT/worktree"
mkdir -p "$CLAUDE_TRUST_E2E_CONFIG" "$CLAUDE_TRUST_E2E_HOME" "$CLAUDE_TRUST_E2E_WORKTREE"
printf '{"projects":{}}\n' > "$CLAUDE_TRUST_E2E_CONFIG/.claude.json"
node --import tsx --input-type=module --eval '
  const { seedClaudeWorktreeTrust } = await import("./apps/server/src/claudeTrust.ts");
  process.exit(seedClaudeWorktreeTrust(process.argv[1], process.argv[2]) ? 0 : 1);
' "$CLAUDE_TRUST_E2E_CONFIG/.claude.json" "$CLAUDE_TRUST_E2E_WORKTREE"
```

Launch Claude with only the isolated test home and config.

```sh
cd "$CLAUDE_TRUST_E2E_WORKTREE"
HOME="$CLAUDE_TRUST_E2E_HOME" CLAUDE_CONFIG_DIR="$CLAUDE_TRUST_E2E_CONFIG" claude
```

Pass criteria: the folder-trust dialog does not appear.
A normal authentication or first-run screen is acceptable because the isolated home contains no real credentials or settings.

## Confirm seed failure falls back to the dialog

Return to the Perch repository root and record an explicit decline in only the isolated state file.

```sh
cd -
node --input-type=module --eval '
  const { realpathSync, writeFileSync } = await import("node:fs");
  const [stateFile, worktree] = process.argv.slice(1);
  const key = realpathSync(worktree);
  writeFileSync(stateFile, JSON.stringify({ projects: { [key]: { hasTrustDialogAccepted: false } } }, null, 2));
' "$CLAUDE_TRUST_E2E_CONFIG/.claude.json" "$CLAUDE_TRUST_E2E_WORKTREE"
node --import tsx --input-type=module --eval '
  const { seedClaudeWorktreeTrust } = await import("./apps/server/src/claudeTrust.ts");
  process.exit(seedClaudeWorktreeTrust(process.argv[1], process.argv[2]) ? 0 : 1);
' "$CLAUDE_TRUST_E2E_CONFIG/.claude.json" "$CLAUDE_TRUST_E2E_WORKTREE"
```

Pass criteria: the seed command exits nonzero, logs that the explicit decline remains unchanged, and the entry is still false.
When the server launches a Claude worker in this condition, it must continue launching and log that Claude may show the manual trust gate.

Run Claude again with the isolated environment.

```sh
cd "$CLAUDE_TRUST_E2E_WORKTREE"
HOME="$CLAUDE_TRUST_E2E_HOME" CLAUDE_CONFIG_DIR="$CLAUDE_TRUST_E2E_CONFIG" claude
```

Pass criteria: Perch has not claimed a successful seed, and Claude shows its folder-trust dialog.

## Confirm corrupt state is refused

Return to the Perch repository root and replace only the isolated state with corrupt JSON.

```sh
cd -
printf '{ corrupt\n' > "$CLAUDE_TRUST_E2E_CONFIG/.claude.json"
node --import tsx --input-type=module --eval '
  const { seedClaudeWorktreeTrust } = await import("./apps/server/src/claudeTrust.ts");
  process.exit(seedClaudeWorktreeTrust(process.argv[1], process.argv[2]) ? 0 : 1);
' "$CLAUDE_TRUST_E2E_CONFIG/.claude.json" "$CLAUDE_TRUST_E2E_WORKTREE"
```

Pass criteria: the seed command exits nonzero, logs that the corrupt file was not modified, and the file still contains the same corrupt bytes.

Remove the isolated fixture when finished.

```sh
rm -rf "$CLAUDE_TRUST_E2E_ROOT"
```
