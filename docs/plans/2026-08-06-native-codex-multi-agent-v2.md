# Native Codex multi-agent V2 observation

## Goal

Allow a Perch-managed Codex Mate or worker root turn to use Codex native multi-agent V2 while Perch observes the child tree without taking over native orchestration.

## Boundaries

Codex remains the only caller of `spawnAgent`, `sendInput`, `wait`, `resumeAgent`, and `closeAgent`.

Perch observes only root-thread `subAgentActivity` and `collabAgentToolCall` items.

Perch never turns a native child into a Task, Runtime, AgentSession, fleet row, worktree, attach target, timeline, or completion authority.

Perch will not expose direct child interruption because the verified Codex 0.146.0 probe interrupted the root workflow too.

Native children share the root worktree by default, so worker guidance will prefer read-only decomposition and prohibit concurrent writes.

## Protocol and capability plan

Treat native support as opt-in observation discovered from known root-thread item shapes, not from a Codex version string.

Preserve exact root-only behavior when the feature is absent, disabled, returns an unsupported-method error, or sends an unknown shape.

Keep the normal managed daemon environment intact so its nonsecret user Codex configuration remains available, without copying configuration, credentials, or unrelated account state.

Filter all root lifecycle callbacks by root thread identity before they can change a root turn, status, delivery receipt, task lifecycle, or timeline.

Parse native items tolerantly and retain only child identity, linkage, depth or path, role, status, timestamps, and safe protocol metadata.

Do not retain a child prompt, tool input or output, or assistant content.

## Durable model

Add a migration-backed `NativeChildRun` observation keyed by outer runtime kind and id, runtime generation, and child thread id.

Upserts must deduplicate repeated notifications, preserve a completed identity across restart, reject stale status observations, and never infer child liveness after restart.

Expose an optional child summary on existing server responses so old clients continue decoding the unchanged fields.

## Wiring and verification

Route native observations through the owned Codex adapter into server state for both Mate owner runtimes and dispatched worker runtimes.

Update the standard worker brief with defense-in-depth native-child reporting and shared-worktree guidance while documenting that inherited hook credentials do not mechanically prove root-only task-hook authority.

Test tolerant parsing, unknown fallback, root lifecycle isolation, adapter and fleet exclusion, migration and restart behavior, shared-wire compatibility, Mate and worker wiring, and the direct-child-interrupt regression.

Add a gated real Codex app-server contract test that uses a private daemon and only runs a model tree when the environment explicitly enables that isolated live check.
