import { basename } from "node:path";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { StartAgentRequest, Task } from "@perch/shared";
import type { HookEventPayload } from "./hooks.js";
import { hookEventName, isAllowedTranscriptPath } from "./hooks.js";
import { isTrustedProviderIdentity } from "./runtimeManager.js";
import type { RuntimeRecord } from "./stateDb.js";

export type PreparedProviderRecovery = {
  request: StartAgentRequest;
  expectedProviderSessionId: string;
};

export type ProviderRecoveryDriver = {
  readonly provider: "claude";
  prepare(runtime: RuntimeRecord, task: Task): PreparedProviderRecovery;
  verifySessionStart(expectedProviderSessionId: string, payload: HookEventPayload): boolean;
};

export const claudeRecoveryDriver: ProviderRecoveryDriver = {
  provider: "claude",
  prepare(runtime, task) {
    if (runtime.state !== "recovering") {
      throw new Error(`Claude recovery unavailable: runtime is ${runtime.state}, not a held recovering claim`);
    }
    if (runtime.provider !== "claude" || runtime.agent !== "claude") {
      throw new Error(
        `Claude recovery unavailable: runtime identity is agent=${runtime.agent} provider=${runtime.provider ?? "unknown"}, not claude`
      );
    }
    if (!isTrustedProviderIdentity(runtime.provider, runtime.providerSessionId)) {
      throw new Error("Claude recovery unavailable: trusted provider session identity is missing");
    }
    const providerSessionId = runtime.providerSessionId!;
    const sessionId = `pty:${randomUUID()}`;
    return {
      expectedProviderSessionId: providerSessionId,
      request: {
        command: "claude",
        args: ["--resume", providerSessionId],
        agent: "claude",
        sessionId,
        cwd: canonicalPath(runtime.worktreePath ?? task.project),
        title: task.title,
        ...(runtime.model ? { model: runtime.model } : {}),
        labels: {
          task: task.id,
          ...(runtime.workerName ? { workerName: runtime.workerName } : {}),
          ...(runtime.parentSessionId ? { parent: runtime.parentSessionId } : {})
        }
      }
    };
  },
  verifySessionStart(expectedProviderSessionId, payload) {
    if (
      hookEventName(payload) !== "SessionStart" ||
      payload.session_id !== expectedProviderSessionId ||
      !isTrustedProviderIdentity("claude", payload.session_id) ||
      typeof payload.transcript_path !== "string" ||
      !isAllowedTranscriptPath(payload.transcript_path)
    ) {
      return false;
    }
    return basename(payload.transcript_path) === `${expectedProviderSessionId}.jsonl`;
  }
};

export function providerRecoveryDriver(provider: string | undefined): ProviderRecoveryDriver | undefined {
  return provider === "claude" ? claudeRecoveryDriver : undefined;
}

function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}
