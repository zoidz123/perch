# No-mistakes authorization

Perch task mode is a negative capability policy for the expensive no-mistakes pipeline.
Only a live worker linked to a durable task whose effective mode is exactly `no-mistakes` may use the managed pipeline.
An explicit persisted task mode wins over the project mode in either direction, and the built-in fallback is `direct-PR`.

The signed runtime bundled with `perchctl` consumes this verifier contract.
Perch therefore provides end-to-end managed enforcement when the packaged runtime passes its byte, version, architecture, and protocol checks.
Standalone no-mistakes execution with no managed context remains unchanged.

## Protocol version 1

Immediately before each protected operation the runtime sends:

```json
{
  "protocolVersion": "1",
  "requestId": "32-lowercase-hex-characters",
  "operation": "run",
  "taskId": "durable-task-id",
  "runtimeGeneration": 1,
  "sessionId": "live-session-id",
  "projectPath": "/canonical/project",
  "repository": "github.com/owner/repository",
  "worktreePath": "/canonical/worktree",
  "branch": "perch/task-id",
  "durableMode": "no-mistakes"
}
```

`operation` is `run`, `gate-push`, or `agent-launch`.
Every verifier call receives a fresh one-use request ID.
The hook token travels only in `x-perch-token`, with the live session in `x-perch-session`.

The response echoes every request field exactly and adds `allowed` and `reason`.
The runtime proceeds only after HTTP 200, protocol `1`, `allowed: true`, durable mode `no-mistakes`, and an exact scope echo.

Perch independently resolves the durable task, current live runtime generation and session, canonical project, credential-free canonical repository, worktree, branch, operation, and durable mode.
It rejects a protocol mismatch, malformed or incomplete scope, a reused request ID, a stale generation, and every cross-task, repository, worktree, branch, or session replay.
Request claims are never authority.

## Protected boundaries

The bundled fork authorizes before managed AXI run creation, before the gate receiver creates a run from a push, and immediately before every external-agent subprocess.
Each agent attempt reauthorizes.
An absolute executable path, another binary on PATH, a globally visible skill, an initialized repository, an existing gate remote, prompt language, and diff size cannot bypass these checks.

The fork carries the minimum authorization capability through local hook and daemon IPC in memory.
It does not write the hook token or provider authorization context to SQLite, prompts, telemetry, git configuration, push options, snapshots, or child-agent environments.
Missing verifier, timeout, connection failure, daemon recovery without live context, malformed response, non-200 response, denial, protocol mismatch, or scope mismatch fails closed.

## Durable evidence

Every authenticated allow or deny appends a secret-free task event containing protocol, request ID, operation, task, generation, session, canonical scope, durable mode, decision, and reason.
The operational audit receives the same decision metadata without credentials.
If task evidence cannot be appended, authorization fails closed.

## Packaged runtime

`perchctl@0.1.3` contains signed Darwin arm64 and x64 binaries from fork release `v1.39.0-perch.1` at commit `2d35e552b4cbc191b06abcadc3b05fd3da510d26`.
The runtime resolver selects only the matching packaged architecture and verifies exact bytes before use.
It never downloads during installation, works with `npm --ignore-scripts`, and never falls back to a PATH binary for Perch-managed execution.

See `vendor/no-mistakes/manifest.json`, [Third-party notices](../THIRD_PARTY_NOTICES.md), and [No-mistakes upstream sync](no-mistakes-upstream-sync.md) for provenance and maintenance details.
