import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentKind, DispatchDefaults, MateDefaults } from "@perch/shared";
import {
  collectModels,
  DISPATCH_CODEX_FALLBACK,
  MATE_CODEX_FALLBACK,
  MATE_MODEL_AUTO,
  modelAgentsForIdentifier
} from "./models.js";

// Fleet-level user settings, persisted in $PERCH_HOME/settings.json. Same
// conventions as the other config surfaces: env overrides win over the
// persisted file (mirroring PERCH_TOKEN vs the token file), the file is
// mtime-cached and written atomically (mirroring the project registry).
//
// Two things live here: the dispatch defaults (`dispatch.*` via `perch config`) -
// the agent/model/effort POST /tasks falls back to when a dispatch omits
// them - and the mate defaults (`mate.*` via `perch config`) - the model/effort
// `perch mate` launches with. An explicit per-call value always wins;
// nothing configured means the built-in behavior (claude, CLI-default model)
// is unchanged.

// Agents a dispatch can spawn; the whitelist for `dispatch.agent`. "shell" and
// "unknown" are session classifications, never dispatch targets.
export const DISPATCH_AGENTS = new Set(["claude", "codex"]);

// The full set of known codex reasoning efforts (CodexReasoningEffort). This is
// the membership check that rejects nonsense strings ("turbo"); the SELECTED
// model's own supported subset is enforced separately via a CodexEffortResolver
// so e.g. `ultra` is accepted for gpt-5.6 but rejected for gpt-5.5. Kept as the
// union so a value the resolver cannot classify (unknown/freshly-pinned model)
// still passes this baseline. Env-provided values flow through unvalidated like
// every PERCH_* env.
export const DISPATCH_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

// Resolves the reasoning efforts a given codex model supports, from the live
// model registry. Injected by the HTTP layer (which has async registry access)
// so settings validation can reject an effort the selected model does not
// offer. An undefined result means the model is not enumerated in the catalog
// (unknown/freshly-pinned id) - the baseline DISPATCH_EFFORTS check still
// applies, but no per-model narrowing happens (append-only tolerance).
export type CodexEffortResolver = (model: string | undefined) => readonly string[] | undefined;
export type ModelAgentResolver = (model: string | undefined) => readonly AgentKind[];

// A write-side update: string sets, null clears, undefined leaves untouched.
export type DispatchDefaultsUpdate = {
  agent?: string | null;
  model?: string | null;
  effort?: string | null;
};

// Same shape as DispatchDefaultsUpdate: agent picks which CLI a fresh mate
// launches as (launch-time only - no mid-conversation switch).
export type MateDefaultsUpdate = {
  agent?: string | null;
  model?: string | null;
  effort?: string | null;
};

export type SettingsFile = {
  dispatchDefaults?: DispatchDefaults;
  mateDefaults?: MateDefaults;
};

const STORED_MODEL_REGISTRY = collectModels();

export class FleetSettings {
  private readonly path: string;
  private readonly env: NodeJS.ProcessEnv;
  private cache?: { file: SettingsFile; mtimeMs: number };

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
    this.path = join(env.PERCH_HOME ?? join(homedir(), ".perch"), "settings.json");
  }

  stored(): SettingsFile {
    return structuredClone(this.load());
  }

  environmentOverrides(): SettingsFile {
    return {
      dispatchDefaults: compactDefaults({
        agent: this.env.PERCH_DEFAULT_AGENT,
        model: this.env.PERCH_DEFAULT_MODEL,
        effort: this.env.PERCH_DEFAULT_EFFORT
      }) as DispatchDefaults,
      mateDefaults: compactDefaults({
        agent: this.env.PERCH_MATE_AGENT,
        model: this.env.PERCH_MATE_MODEL,
        effort: this.env.PERCH_MATE_EFFORT
      }) as MateDefaults
    };
  }

  // The effective dispatch defaults: PERCH_DEFAULT_* env > persisted setting.
  dispatchDefaults(): DispatchDefaults {
    const persisted = this.load().dispatchDefaults ?? {};
    const envAgent = this.env.PERCH_DEFAULT_AGENT;
    const agent = envAgent ?? persisted.agent;
    const sameAgentLayer = !envAgent || envAgent === persisted.agent;
    const model = this.env.PERCH_DEFAULT_MODEL ?? (sameAgentLayer ? persisted.model : undefined);
    const effort = this.env.PERCH_DEFAULT_EFFORT ?? (sameAgentLayer ? persisted.effort : undefined);
    return completeCodexDefaults("dispatch", {
      ...(agent ? { agent: agent as DispatchDefaults["agent"] } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort: effort as DispatchDefaults["effort"] } : {})
    });
  }

  // Apply a partial update to the persisted defaults (null clears a key).
  // Throws on invalid values; the caller maps that to a 400. `resolveEfforts`
  // narrows the accepted effort to the SELECTED model's supported set.
  updateDispatchDefaults(
    update: DispatchDefaultsUpdate,
    resolveEfforts?: CodexEffortResolver,
    resolveAgents?: ModelAgentResolver
  ): DispatchDefaults {
    const next: DispatchDefaults = { ...(this.load().dispatchDefaults ?? {}) };
    if (update.agent !== undefined) {
      if (update.agent === null) {
        delete next.agent;
        delete next.model;
        delete next.effort;
      } else if (!DISPATCH_AGENTS.has(update.agent)) {
        throw new Error(
          `invalid default agent "${update.agent}" (expected ${[...DISPATCH_AGENTS].join(" | ")})`
        );
      } else {
        next.agent = update.agent as DispatchDefaults["agent"];
      }
    }
    validateEffortUpdate("default", update.effort);
    if (update.model !== undefined) {
      if (update.model === null || update.model.trim().length === 0) {
        delete next.model;
      } else {
        next.model = update.model.trim();
      }
    }
    if (update.effort !== undefined) {
      if (update.effort === null) {
        delete next.effort;
      } else {
        next.effort = update.effort as DispatchDefaults["effort"];
      }
    }
    const completed = completeCodexDefaults("dispatch", next);
    next.agent = completed.agent;
    next.model = completed.model;
    next.effort = completed.effort;
    assertModelSupported("dispatch", next, resolveAgents);
    assertEffortSupported("dispatch", next, resolveEfforts);
    this.persist({ ...this.load(), dispatchDefaults: next });
    return this.dispatchDefaults();
  }

  // The effective mate defaults: PERCH_MATE_* env > persisted setting.
  mateDefaults(): MateDefaults {
    const persisted = this.load().mateDefaults ?? {};
    const envAgent = this.env.PERCH_MATE_AGENT;
    const agent = envAgent ?? persisted.agent;
    const sameAgentLayer = !envAgent || envAgent === persisted.agent;
    const model = this.env.PERCH_MATE_MODEL ?? (sameAgentLayer ? persisted.model : undefined);
    const effort = this.env.PERCH_MATE_EFFORT ?? (sameAgentLayer ? persisted.effort : undefined);
    return completeCodexDefaults("mate", {
      ...(agent ? { agent: agent as MateDefaults["agent"] } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort: effort as MateDefaults["effort"] } : {})
    });
  }

  // Apply a partial update to the persisted mate defaults (null clears a key).
  // Throws on invalid values; the caller maps that to a 400. `resolveEfforts`
  // narrows the accepted effort to the SELECTED model's supported set.
  updateMateDefaults(
    update: MateDefaultsUpdate,
    resolveEfforts?: CodexEffortResolver,
    resolveAgents?: ModelAgentResolver
  ): MateDefaults {
    const next: MateDefaults = { ...(this.load().mateDefaults ?? {}) };
    let providerChanged = false;
    if (update.agent !== undefined) {
      if (update.agent === null) {
        providerChanged = next.agent !== undefined;
        delete next.agent;
        delete next.model;
        delete next.effort;
      } else if (!DISPATCH_AGENTS.has(update.agent)) {
        throw new Error(
          `invalid mate agent "${update.agent}" (expected ${[...DISPATCH_AGENTS].join(" | ")})`
        );
      } else {
        if (next.agent !== update.agent) {
          providerChanged = true;
          delete next.model;
          delete next.effort;
        }
        next.agent = update.agent as MateDefaults["agent"];
      }
    }
    validateEffortUpdate("mate", update.effort);
    const applyScopedUpdate =
      !providerChanged || hasCompleteScopedUpdate(next.agent, update.model, update.effort);
    if (applyScopedUpdate && update.model !== undefined) {
      if (update.model === null || update.model.trim().length === 0) {
        delete next.model;
      } else {
        next.model = update.model.trim();
      }
    }
    if (applyScopedUpdate && update.effort !== undefined) {
      if (update.effort === null) {
        delete next.effort;
      } else {
        next.effort = update.effort as MateDefaults["effort"];
      }
    }
    const completed = completeCodexDefaults("mate", next);
    next.agent = completed.agent;
    next.model = completed.model;
    next.effort = completed.effort;
    assertModelSupported("mate", next, resolveAgents);
    assertEffortSupported("mate", next, resolveEfforts);
    this.persist({ ...this.load(), mateDefaults: next });
    return this.mateDefaults();
  }

  private load(): SettingsFile {
    let file: SettingsFile;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.path).mtimeMs;
      if (this.cache && this.cache.mtimeMs === mtimeMs) {
        return this.cache.file;
      }
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as SettingsFile;
      file = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return this.cache?.file ?? {};
    }
    const repaired = repairKnownCrossProviderSettings(file);
    if (repaired !== file) {
      this.persist(repaired);
      return repaired;
    }
    this.cache = { file, mtimeMs };
    return file;
  }

  private persist(file: SettingsFile): void {
    const repaired = repairKnownCrossProviderSettings(file);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(repaired, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
    if (existsSync(this.path)) {
      this.cache = { file: repaired, mtimeMs: statSync(this.path).mtimeMs };
    }
  }
}

function repairKnownCrossProviderSettings(file: SettingsFile): SettingsFile {
  const dispatchDefaults = repairKnownCrossProviderDefaults(file.dispatchDefaults);
  const mateDefaults = repairKnownCrossProviderDefaults(file.mateDefaults);
  if (dispatchDefaults === file.dispatchDefaults && mateDefaults === file.mateDefaults) return file;
  return {
    ...file,
    ...(dispatchDefaults ? { dispatchDefaults } : {}),
    ...(mateDefaults ? { mateDefaults } : {})
  };
}

function repairKnownCrossProviderDefaults<T extends DispatchDefaults | MateDefaults>(
  defaults: T | undefined
): T | undefined {
  if (!defaults?.agent) return defaults;
  let repaired: DispatchDefaults | MateDefaults = defaults;
  if (defaults.agent !== "codex" && defaults.effort !== undefined) {
    const { effort: _effort, ...withoutEffort } = repaired;
    repaired = withoutEffort;
  }
  const model = defaults.model?.trim();
  if (model && model.toLowerCase() !== MATE_MODEL_AUTO) {
    const knownAgents = modelAgentsForIdentifier(STORED_MODEL_REGISTRY, model);
    if (knownAgents.length > 0 && !knownAgents.includes(defaults.agent)) {
      const { model: _model, ...withoutModel } = repaired;
      repaired = withoutModel;
    }
  }
  return repaired === defaults ? defaults : repaired as T;
}

function compactDefaults(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])));
}

function validateEffortUpdate(layer: "default" | "mate", effort: string | null | undefined): void {
  if (effort === undefined || effort === null || DISPATCH_EFFORTS.has(effort)) return;
  throw new Error(
    `invalid ${layer} effort "${effort}" (expected ${[...DISPATCH_EFFORTS].join(" | ")})`
  );
}

function hasCompleteScopedUpdate(
  agent: DispatchDefaults["agent"] | MateDefaults["agent"] | undefined,
  model: string | null | undefined,
  effort: string | null | undefined
): boolean {
  const hasModel = typeof model === "string" && model.trim().length > 0;
  if (!agent || !hasModel) return false;
  return agent === "codex" ? typeof effort === "string" : true;
}

// Reject an effort the SELECTED codex model does not support. Only applies to
// codex (Claude has no reasoning effort) and only when the resolver classifies
// the model - an unknown/"auto" model leaves the baseline DISPATCH_EFFORTS
// check as the only gate. The model default filled in by completeCodexDefaults
// is always supported, so this never rejects a value the user did not choose.
function assertEffortSupported(
  layer: "dispatch" | "mate",
  defaults: DispatchDefaults | MateDefaults,
  resolveEfforts?: CodexEffortResolver
): void {
  if (!resolveEfforts || defaults.agent !== "codex" || !defaults.effort) return;
  const allowed = resolveEfforts(defaults.model);
  if (!allowed || allowed.includes(defaults.effort)) return;
  const noun = layer === "mate" ? "mate" : "default";
  throw new Error(
    `invalid ${noun} effort "${defaults.effort}" for model "${defaults.model}" (expected ${allowed.join(" | ")})`
  );
}

function assertModelSupported(
  layer: "dispatch" | "mate",
  defaults: DispatchDefaults | MateDefaults,
  resolveAgents?: ModelAgentResolver
): void {
  if (!resolveAgents || !defaults.agent || !defaults.model || defaults.model === MATE_MODEL_AUTO) return;
  const knownAgents = resolveAgents(defaults.model);
  if (knownAgents.length === 0 || knownAgents.includes(defaults.agent)) return;
  const noun = layer === "mate" ? "mate" : "default";
  throw new Error(
    `invalid ${noun} model "${defaults.model}" for agent "${defaults.agent}" (model belongs to ${knownAgents.join(" | ")})`
  );
}

function completeCodexDefaults(layer: "dispatch", defaults: DispatchDefaults): DispatchDefaults;
function completeCodexDefaults(layer: "mate", defaults: MateDefaults): MateDefaults;
function completeCodexDefaults(
  layer: "dispatch" | "mate",
  defaults: DispatchDefaults | MateDefaults
): DispatchDefaults | MateDefaults {
  if (defaults.agent !== "codex") {
    return defaults;
  }
  const fallback = layer === "mate" ? MATE_CODEX_FALLBACK : DISPATCH_CODEX_FALLBACK;
  return {
    agent: "codex",
    model: defaults.model ?? (layer === "mate" ? MATE_MODEL_AUTO : fallback.model),
    effort: defaults.effort ?? fallback.effort
  };
}
