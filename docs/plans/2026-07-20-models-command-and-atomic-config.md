# Models command and atomic model configuration

Date: 2026-07-20
Reference: owner-approved CLI redesign superseding the `perch-cli-redesign` scout directions

## Decision

Add `perch models` as the complete, scriptable inventory of models Perch can launch across Codex and Claude.
Add atomic role commands that resolve and validate an agent, model, and effort tuple before writing global configuration.
Keep existing configuration files and dotted-key commands compatible while making invalid saved tuples visible.

## Model inventory

`perch models` combines the bundled Claude `CLAUDE_ALIAS_CATALOG` with Codex live app-server discovery and its existing static fallback.
Claude model listing never invokes the Claude CLI, an external API, or a gateway.
Codex discovery failures never fail the command and instead produce a note identifying the missing or unsupported source.
The default table shows model id, agent, supported effort levels, aliases, source, and the current mate or dispatch selection.
Each row labels its source as live or bundled.
`perch models --json` returns the same inventory and source notes as structured data for scripts.

## Atomic role selection

`perch config set mate <model> [--effort <level>] [--agent <agent>]` sets the global mate tuple.
`perch config set dispatch <model> [--effort <level>] [--agent <agent>]` sets the global dispatch tuple.
An exact model id or alias resolves through the registry to exactly one agent before configuration changes.
An omitted effort uses the registry default for the resolved model.
An unsupported effort fails with the model's valid effort levels.
An unknown model fails with closest matches and a pointer to `perch models`.
An ambiguous model prompts for an agent on a TTY and otherwise fails with instructions to pass `--agent`.
The validated agent, model, and effort are persisted together so no intermediate mismatched state is observable.

## Compatibility and reporting

Existing dotted-key `config set --global` commands keep working and print one deprecation line recommending the atomic role form.
Existing configuration files remain readable without migration or silent rewriting.
`perch config` and `perch config show` continue to display effective values and add the resolved agent for mate and dispatch.
Saved invalid agent and model tuples produce a warning row while remaining unchanged on disk.

## Documentation and verification

Update `docs/cli.md` with the model inventory and both atomic role commands.
Test name-to-agent resolution, aliases, atomic persistence, unknown-model errors, invalid-effort errors, dotted-key compatibility, and listing when a provider is absent.
Run the focused CLI and model tests, the full server suite, relevant build and lint checks, the documentation gate, and `git diff --check`.

## Risks and open questions

Live Codex output can change shape, so discovery must remain isolated behind the existing registry parser and preserve fallback source notes.
Aliases shared across agents require deterministic ambiguity handling without guessing in non-interactive use.
Compatibility reporting must diagnose invalid historical tuples without mutating user-owned configuration.
