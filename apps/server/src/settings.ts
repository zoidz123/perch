import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DispatchDefaults, MateDefaults } from "@perch/shared";
import { DISPATCH_CODEX_FALLBACK, MATE_CODEX_FALLBACK, MATE_MODEL_AUTO } from "./models.js";

// Fleet-level user settings, persisted in $PERCH_HOME/settings.json. Same
// conventions as the other config surfaces: env overrides win over the
// persisted file (mirroring PERCH_TOKEN vs the token file), the file is
// mtime-cached and written atomically (mirroring the project registry).
//
// Two things live here: the dispatch defaults (`perch config default-*`) -
// the agent/model/effort POST /tasks falls back to when a dispatch omits
// them - and the mate defaults (`perch config mate-*`) - the model/effort
// `perch mate` launches with. An explicit per-call value always wins;
// nothing configured means the built-in behavior (claude, CLI-default model)
// is unchanged.

// Agents a dispatch can spawn; the whitelist for `default-agent`. "shell" and
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

type SettingsFile = {
  dispatchDefaults?: DispatchDefaults;
  mateDefaults?: MateDefaults;
};

export class FleetSettings {
  private readonly path: string;
  private readonly env: NodeJS.ProcessEnv;
  private cache?: { file: SettingsFile; mtimeMs: number };

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
    this.path = join(env.PERCH_HOME ?? join(homedir(), ".perch"), "settings.json");
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
    resolveEfforts?: CodexEffortResolver
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
      } else if (!DISPATCH_EFFORTS.has(update.effort)) {
        throw new Error(
          `invalid default effort "${update.effort}" (expected ${[...DISPATCH_EFFORTS].join(" | ")})`
        );
      } else {
        next.effort = update.effort as DispatchDefaults["effort"];
      }
    }
    const completed = completeCodexDefaults("dispatch", next);
    next.agent = completed.agent;
    next.model = completed.model;
    next.effort = completed.effort;
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
    resolveEfforts?: CodexEffortResolver
  ): MateDefaults {
    const next: MateDefaults = { ...(this.load().mateDefaults ?? {}) };
    if (update.agent !== undefined) {
      if (update.agent === null) {
        delete next.agent;
        delete next.model;
        delete next.effort;
      } else if (!DISPATCH_AGENTS.has(update.agent)) {
        throw new Error(
          `invalid mate agent "${update.agent}" (expected ${[...DISPATCH_AGENTS].join(" | ")})`
        );
      } else {
        next.agent = update.agent as MateDefaults["agent"];
      }
    }
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
      } else if (!DISPATCH_EFFORTS.has(update.effort)) {
        throw new Error(
          `invalid mate effort "${update.effort}" (expected ${[...DISPATCH_EFFORTS].join(" | ")})`
        );
      } else {
        next.effort = update.effort as MateDefaults["effort"];
      }
    }
    const completed = completeCodexDefaults("mate", next);
    next.agent = completed.agent;
    next.model = completed.model;
    next.effort = completed.effort;
    assertEffortSupported("mate", next, resolveEfforts);
    this.persist({ ...this.load(), mateDefaults: next });
    return this.mateDefaults();
  }

  private load(): SettingsFile {
    try {
      const mtimeMs = statSync(this.path).mtimeMs;
      if (this.cache && this.cache.mtimeMs === mtimeMs) {
        return this.cache.file;
      }
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as SettingsFile;
      const file = parsed && typeof parsed === "object" ? parsed : {};
      this.cache = { file, mtimeMs };
      return file;
    } catch {
      return this.cache?.file ?? {};
    }
  }

  private persist(file: SettingsFile): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
    if (existsSync(this.path)) {
      this.cache = { file, mtimeMs: statSync(this.path).mtimeMs };
    }
  }
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
