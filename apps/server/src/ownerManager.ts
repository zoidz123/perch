import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { StartAgentRequest } from "@perch/shared";
import { isTrustedProviderIdentity, type RuntimeProcessOwnership } from "./runtimeManager.js";
import type { OwnerRuntimeRecord } from "./stateDb.js";
import type { TaskStore } from "./tasks.js";

export const MATE_OWNER_ID = "owner:mate";

export type MateOwnerSnapshot = {
  id: string;
  generation: number;
  state: OwnerRuntimeRecord["state"];
  agent: string;
  provider: string;
  providerSessionId?: string;
  ptySessionId?: string;
  model?: string;
  recoveryAvailable: boolean;
  recoveryUnavailableReason?: string;
};

export class OwnerManager {
  readonly instanceId = `server:${randomUUID()}`;

  constructor(private readonly tasks: TaskStore) {
    tasks.stateDb.owners.ensure(MATE_OWNER_ID, "mate");
  }

  beginMateLaunch(request: StartAgentRequest, forceNew = false): OwnerRuntimeRecord {
    const latest = this.latestMate();
    if (latest && latest.state !== "ended") {
      if (!forceNew) {
        throw new Error(`mate owner already has generation ${latest.generation} (${latest.state})`);
      }
      if (latest.state === "starting" || latest.state === "live" || latest.state === "recovering") {
        throw new Error(`mate owner generation ${latest.generation} is ${latest.state}; stop it before --new`);
      }
      const ended = this.tasks.stateDb.ownerRuntimes.compareAndSwap(
        MATE_OWNER_ID,
        latest.generation,
        "recoverable",
        "ended",
        { metadata: { ...latest.metadata, endedReason: "intentional-fresh-start" } }
      );
      if (!ended) {
        throw new Error(`mate owner generation ${latest.generation} changed state during --new; retry`);
      }
    }
    const generation = (latest?.generation ?? -1) + 1;
    const agent = request.agent ?? providerForCommand(request.command);
    return this.tasks.stateDb.ownerRuntimes.create({
      ownerId: MATE_OWNER_ID,
      generation,
      state: "starting",
      agent,
      provider: providerForCommand(request.command, request.agent),
      cwd: canonicalPath(request.cwd ?? process.cwd()),
      ...(request.model ? { model: request.model } : {}),
      ...(request.sessionId ? { ptySessionId: request.sessionId } : {}),
      ownerInstanceId: this.instanceId,
      metadata: { source: "mate-launch" }
    });
  }

  markLive(runtime: OwnerRuntimeRecord, sessionId: string, ownership?: RuntimeProcessOwnership): OwnerRuntimeRecord {
    const live = this.tasks.stateDb.ownerRuntimes.compareAndSwap(
      runtime.ownerId,
      runtime.generation,
      "starting",
      "live",
      { ptySessionId: sessionId, ownerInstanceId: this.instanceId, ...(ownership ?? {}) }
    );
    if (!live) throw new Error(`mate runtime generation conflict at g${runtime.generation}`);
    return live;
  }

  markLaunchFailed(runtime: OwnerRuntimeRecord): void {
    this.tasks.stateDb.ownerRuntimes.compareAndSwap(runtime.ownerId, runtime.generation, "starting", "ended");
  }

  recordProviderSession(sessionId: string, provider: string, providerSessionId: string): OwnerRuntimeRecord | undefined {
    const runtime = this.tasks.stateDb.ownerRuntimes.findBySession(sessionId);
    if (!runtime || (runtime.state !== "starting" && runtime.state !== "live")) return runtime;
    if (runtime.agent !== provider || runtime.provider !== provider) return undefined;
    return this.tasks.stateDb.ownerRuntimes.compareAndSwap(
      runtime.ownerId,
      runtime.generation,
      runtime.state,
      runtime.state,
      { providerSessionId }
    );
  }

  interruptSession(sessionId: string): OwnerRuntimeRecord | undefined {
    const runtime = this.tasks.stateDb.ownerRuntimes.findBySession(sessionId);
    if (!runtime || (runtime.state !== "starting" && runtime.state !== "live")) return undefined;
    return this.tasks.stateDb.ownerRuntimes.compareAndSwap(
      runtime.ownerId,
      runtime.generation,
      ["starting", "live"],
      "recoverable"
    );
  }

  reconcile(liveSessionIds: ReadonlySet<string>, owns: (sessionId: string) => boolean): OwnerRuntimeRecord[] {
    const changed: OwnerRuntimeRecord[] = [];
    for (const runtime of this.tasks.stateDb.ownerRuntimes.active()) {
      if (runtime.state === "recoverable") continue;
      if (runtime.state === "recovering" && runtime.ownerInstanceId === this.instanceId) continue;
      const live = Boolean(runtime.ptySessionId && liveSessionIds.has(runtime.ptySessionId) && owns(runtime.ptySessionId));
      if (live && runtime.ownerInstanceId === this.instanceId) continue;
      const next = this.tasks.stateDb.ownerRuntimes.compareAndSwap(
        runtime.ownerId,
        runtime.generation,
        runtime.state,
        "recoverable",
        { metadata: { ...runtime.metadata, interruptedReason: "startup-ownership-reconcile" } }
      );
      if (next) changed.push(next);
    }
    return changed;
  }

  claimMateRecovery(generation: number): OwnerRuntimeRecord | undefined {
    return this.tasks.stateDb.ownerRuntimes.compareAndSwap(
      MATE_OWNER_ID,
      generation,
      "recoverable",
      "recovering",
      { ownerInstanceId: this.instanceId }
    );
  }

  bindRecoveredMate(
    recovering: OwnerRuntimeRecord,
    input: { sessionId: string; provider: string; providerSessionId: string; ownership?: RuntimeProcessOwnership }
  ): OwnerRuntimeRecord {
    if (
      recovering.state !== "recovering" ||
      recovering.provider !== input.provider ||
      recovering.providerSessionId !== input.providerSessionId ||
      !isTrustedProviderIdentity(input.provider, input.providerSessionId)
    ) {
      throw new Error(`mate provider identity mismatch at g${recovering.generation}`);
    }
    const next = this.tasks.stateDb.transaction(() => {
      const ended = this.tasks.stateDb.ownerRuntimes.compareAndSwap(
        recovering.ownerId,
        recovering.generation,
        "recovering",
        "ended"
      );
      if (!ended) return undefined;
      return this.tasks.stateDb.ownerRuntimes.create({
        ownerId: recovering.ownerId,
        generation: recovering.generation + 1,
        state: "live",
        agent: recovering.agent,
        provider: recovering.provider,
        providerSessionId: recovering.providerSessionId,
        ptySessionId: input.sessionId,
        ...(input.ownership ?? {}),
        cwd: recovering.cwd,
        ...(recovering.model ? { model: recovering.model } : {}),
        ownerInstanceId: this.instanceId,
        metadata: { source: "mate-provider-recovery", previousRuntimeId: recovering.id }
      });
    });
    if (!next) throw new Error(`mate runtime generation conflict at g${recovering.generation}`);
    return next;
  }

  failRecovery(recovering: OwnerRuntimeRecord, message: string): OwnerRuntimeRecord | undefined {
    return this.tasks.stateDb.ownerRuntimes.compareAndSwap(
      recovering.ownerId,
      recovering.generation,
      "recovering",
      "recoverable",
      { metadata: { ...recovering.metadata, recoveryError: message } }
    );
  }

  latestMate(): OwnerRuntimeRecord | undefined {
    return this.tasks.stateDb.ownerRuntimes.latest(MATE_OWNER_ID);
  }

  snapshot(): MateOwnerSnapshot | undefined {
    const runtime = this.latestMate();
    if (!runtime) return undefined;
    const recoveryAvailable = runtime.state === "recoverable" && isTrustedProviderIdentity(runtime.provider, runtime.providerSessionId);
    return {
      id: MATE_OWNER_ID,
      generation: runtime.generation,
      state: runtime.state,
      agent: runtime.agent,
      provider: runtime.provider,
      ...(runtime.providerSessionId ? { providerSessionId: runtime.providerSessionId } : {}),
      ...(runtime.ptySessionId ? { ptySessionId: runtime.ptySessionId } : {}),
      ...(runtime.model ? { model: runtime.model } : {}),
      recoveryAvailable,
      ...(!recoveryAvailable && runtime.state === "recoverable"
        ? { recoveryUnavailableReason: "provider session identity is missing or untrusted" }
        : {})
    };
  }
}

function providerForCommand(command: string, agent?: string): string {
  if (agent === "claude" || agent === "codex") return agent;
  return command.toLowerCase().includes("codex") ? "codex" : "claude";
}

function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}
