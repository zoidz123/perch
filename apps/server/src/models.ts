import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AgentKind,
  CodexReasoningEffort,
  ModelCatalogEntry,
  ModelRegistrySourceStatus,
  MateLaunchResolution,
  ModelsResponse,
  PerchModelRoleDefault,
  ProviderModelCatalog
} from "@perch/shared";
import { perchHome } from "./home.js";

const execFile = promisify(execFileCallback);

// Single source of truth for the launch-time model catalog the New Agent picker
// renders. Kept server-side (not in the app) so the versioned names and the
// resolved CLI default live in one place on the machine that actually runs the
// CLIs; the app consumes this over `GET /models` and only carries a small
// fallback for older servers.
//
// The spawn mechanism is unchanged: an entry's `id` is passed verbatim to the
// CLI's model flag (`claude --model <id>`, `codex -m <id>`). This file only
// governs the LABELS and the DEFAULT, not the spawn plumbing.
//
// Runtime identity rules:
//  - Claude launch/switch ids are CLI-compatible aliases/full ids.
//  - Codex launch/switch ids come from local Codex app-server `model/list`
//    when available. Static rows are only offline fallback.
//  - Gateway/provider ids are enrichment metadata. They are never local launch
//    ids unless a runtime source maps them to `runtimeId`.

// Versioned discovery adapter for the Claude CLI's `/model` alias vocabulary.
//
// The installed CLI is authoritative for WHICH aliases are selectable: the
// live catalog is built purely from the aliases `claude /model` reports (see
// `claudeCatalogFromCli`), and this table never adds or withholds an alias the
// CLI does not list. It only supplies, for the aliases we recognize, a
// friendly versioned LABEL and a recency RANK so the picker surfaces the newest
// models first - the CLI emits them in a legacy order (`sonnet, opus, haiku,
// fable, ...`) that would otherwise bury Fable behind the picker's 3-row limit.
//
// Unrecognized aliases still appear (labeled from the raw id, sorted after
// known ones), so a newly shipped model is never hidden. `[1m]` context-window
// variants inherit their base alias's label with a "1M context" detail. The
// `nativeProviderId` is the full id the CLI stamps on transcripts for that
// alias, used only for enrichment.
//
// Verified against `claude` 2.1.x (`claude /model` -> "Available: sonnet, opus,
// haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan, default, or a
// full model ID.") on 2026-07-18. Update this table when the CLI's alias set or
// versioned names change; it is label/order metadata, not a source of truth for
// which models exist.
// Perch-central Claude catalog. The installed Claude CLI remains the authority
// for the app picker's live aliases, while this table is the only Claude source
// for `perch models`. It also supplies the versioned label, recency rank, and
// context detail the CLI does not report.
// The current frontier models carry a 1M context window as their model context,
// so base `fable`/`opus`/`sonnet` accurately read "1M context" - they are already
// 1M, not a smaller window that only the `[1m]` alias upgrades.
// Haiku 4.5 is 200K.
// The `[1m]` aliases are the CLI's explicit 1M opt-in; they rank after the base
// entries and so never enter the compact three-row picker, keeping a distinct
// "X (1M)" label only for the edge case of a saved `[1m]` selection.
type ClaudeAliasMeta = { label: string; detail?: string; rank: number; nativeProviderId?: string };
const CLAUDE_ALIAS_CATALOG: Record<string, ClaudeAliasMeta> = {
  fable: { label: "Fable 5", detail: "1M context", rank: 0, nativeProviderId: "claude-fable-5" },
  opus: { label: "Opus 4.8", detail: "1M context", rank: 1, nativeProviderId: "claude-opus-4-8" },
  sonnet: { label: "Sonnet 5", detail: "1M context", rank: 2, nativeProviderId: "claude-sonnet-5" },
  haiku: { label: "Haiku 4.5", detail: "200K context", rank: 3, nativeProviderId: "claude-haiku-4-5" },
  best: { label: "Best available", detail: "Latest highest-capability Claude model", rank: 4 },
  opusplan: { label: "Opus Plan", detail: "Uses Opus in plan mode, Sonnet otherwise", rank: 5 }
};

// The concrete aliases surfaced in the offline/fallback catalog, in picker
// order. A subset of the adapter above (the meta-aliases `best`/`opusplan` and
// the `[1m]` opt-ins are live-only). Only used when the CLI query is
// unavailable or errors - never as normal behavior.
const CLAUDE_FALLBACK_ALIASES = ["fable", "opus", "sonnet", "haiku"];

const CLAUDE_MODELS: ModelCatalogEntry[] = CLAUDE_FALLBACK_ALIASES.map((alias) => {
  const meta = CLAUDE_ALIAS_CATALOG[alias];
  return {
    id: alias,
    runtimeId: alias,
    label: meta.label,
    ...(meta.detail ? { detail: meta.detail } : {}),
    ...(meta.nativeProviderId ? { nativeProviderId: meta.nativeProviderId } : {}),
    runtimeSource: "claude-cli-fallback",
    source: ["static-fallback"],
    status: "fallback"
  };
});

const CLAUDE_BUNDLED_MODELS: ModelCatalogEntry[] = Object.entries(CLAUDE_ALIAS_CATALOG).map(([alias, meta]) => ({
  id: alias,
  runtimeId: alias,
  label: meta.label,
  ...(meta.detail ? { detail: meta.detail } : {}),
  ...(meta.nativeProviderId ? { nativeProviderId: meta.nativeProviderId } : {}),
  runtimeSource: "bundled",
  source: ["bundled"],
  status: "available"
}));

// The model a fresh Claude MATE launches with when neither the start request
// nor the configured mate defaults (settings mateDefaults / PERCH_MATE_MODEL)
// name one. The mate must never inherit the Claude CLI's global default
// (~/.claude/settings.json `model`): the CLI's /model command saves any
// per-session switch as that global default, so one session switched to a
// cheap model would silently downgrade the next fresh mate. Pinned to the
// catalog's top-tier entry so the catalog stays the one source of truth.
// Mirrored in bin/perch.mjs (MATE_CLAUDE_FALLBACK_MODEL); keep them in sync.
export const MATE_CLAUDE_FALLBACK_MODEL = "best";

// Codex reasoning-effort ladders. Reasoning efforts are PER-MODEL, not a shared
// constant: newer models raise the ceiling. These arrays are ONLY the offline
// fallback (used when the codex app-server catalog is unavailable) and mirror
// what `codex app-server` `model/list` reports today for each family - the live
// catalog's `supportedReasoningEfforts` always wins when it is reachable. Kept
// in sync with the iOS last-resort ladders in apps/ios/Perch/Models.swift.
const CODEX_EFFORTS_TO_XHIGH: CodexReasoningEffort[] = ["low", "medium", "high", "xhigh"];
const CODEX_EFFORTS_TO_MAX: CodexReasoningEffort[] = [...CODEX_EFFORTS_TO_XHIGH, "max"];
const CODEX_EFFORTS_TO_ULTRA: CodexReasoningEffort[] = [...CODEX_EFFORTS_TO_MAX, "ultra"];

const CODEX_MODELS: ModelCatalogEntry[] = [
  codexFallbackModel(
    "gpt-5.6-sol",
    "GPT 5.6 Sol",
    "Default frontier Codex model for complex coding, research, and real-world work.",
    { efforts: CODEX_EFFORTS_TO_ULTRA, isDefault: true }
  ),
  codexFallbackModel(
    "gpt-5.6-terra",
    "GPT 5.6 Terra",
    "High-capability Codex model for larger implementation and review tasks.",
    { efforts: CODEX_EFFORTS_TO_ULTRA }
  ),
  codexFallbackModel(
    "gpt-5.6-luna",
    "GPT 5.6 Luna",
    "Efficient Codex model for everyday coding tasks.",
    { efforts: CODEX_EFFORTS_TO_MAX }
  ),
  codexFallbackModel(
    "gpt-5.5",
    "GPT 5.5",
    "Frontier model for complex coding, research, and real-world work.",
    { efforts: CODEX_EFFORTS_TO_XHIGH }
  ),
  codexFallbackModel("gpt-5.4", "GPT 5.4", "Strong model for everyday coding.", {
    efforts: CODEX_EFFORTS_TO_XHIGH
  }),
  codexFallbackModel(
    "gpt-5.4-mini",
    "GPT 5.4 Mini",
    "Small, fast, and cost-efficient model for simpler coding tasks.",
    { efforts: CODEX_EFFORTS_TO_XHIGH }
  ),
  codexFallbackModel(
    "gpt-5.3-codex-spark",
    "GPT 5.3 Codex Spark",
    "Older Codex model retained for compatibility with pinned defaults.",
    { efforts: CODEX_EFFORTS_TO_XHIGH, defaultEffort: "high" }
  )
];

// The public built-in crew dispatch fallback on a fresh install: if no
// per-task override, PERCH_DEFAULT_* value, or persisted dispatchDefaults
// exists, and the codex CLI is resolvable on PATH, workers launch as Codex on
// the catalog's second model at medium effort. If Codex is missing, dispatch
// keeps the historical Claude/CLI-default launch.
export const DISPATCH_CODEX_FALLBACK = {
  agent: "codex" as AgentKind,
  model: CODEX_MODELS[1].id,
  effort: "medium" as CodexReasoningEffort
};

// The Codex mate/orchestrator fallback is deliberately separate from crew
// dispatch: the mate is one judgment session, so its built-in Codex fallback
// uses xhigh effort when no applicable configured model/effort exists.
// Mirrored in bin/perch.mjs; keep them in sync.
export const MATE_CODEX_FALLBACK = {
  model: CODEX_MODELS[0].id,
  effort: "medium" as CodexReasoningEffort
};

// Full Claude model ids the CLI also accepts (`claude --model claude-opus-4-8`)
// mapped back onto a catalog entry, so a settings.json pinned to a full id
// still resolves to a versioned label.
const CLAUDE_FULL_ID_ALIASES: Record<string, string> = {
  "claude-fable-5": "fable",
  "claude-opus-4-8": "opus",
  "claude-sonnet-5": "sonnet",
  "claude-haiku-4-5": "haiku"
};

// Friendly labels for the full model ids claude stamps on transcript assistant
// rows (a superset of the launch catalog: transcripts also report models the
// picker does not offer, e.g. the Mythos-tier ids). Unknown ids return
// undefined so callers surface the raw id plainly rather than guessing.
const CLAUDE_ID_LABELS: Record<string, string> = {
  "claude-fable-5": "Fable 5",
  "claude-mythos-5": "Mythos 5",
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-4-7": "Opus 4.7",
  "claude-sonnet-5": "Sonnet 5",
  "claude-haiku-4-5": "Haiku 4.5"
};

export function labelForClaudeModelId(id: string): string | undefined {
  // `claude-fable-5[1m]` -> `claude-fable-5`; `claude-haiku-4-5-20251001`
  // (date-pinned) -> `claude-haiku-4-5`.
  const bare = id
    .replace(/\[[^\]]*\]/g, "")
    .trim()
    .replace(/-\d{8}$/, "");
  return CLAUDE_ID_LABELS[bare];
}

export type ModelsDeps = {
  // Raw ~/.claude/settings.json contents, or null when absent. Injected in tests.
  readClaudeSettings?: () => string | null;
  // Raw ~/.codex/config.toml contents, or null when absent.
  readCodexConfig?: () => string | null;
  // Raw Codex app-server model/list response. Injected in tests; production
  // uses collectModelRegistry() so the live RPC can be async and cached.
  codexModelList?: unknown;
  // The zero-token `claude -p /model --output-format json` result. The CLI
  // handles this slash command locally and returns its currently allowed
  // aliases, so it is a real runtime catalog rather than a Perch list.
  claudeModelList?: unknown;
  now?: () => number;
};

export type ModelRegistryDeps = ModelsDeps & {
  listCodexModels?: () => Promise<unknown>;
  listClaudeModels?: () => Promise<unknown>;
  cachePath?: string;
  env?: NodeJS.ProcessEnv;
};

export function collectModels(deps: ModelsDeps = {}): ModelsResponse {
  const now = deps.now ?? Date.now;
  const at = new Date(now()).toISOString();
  const claudeResult = claudeCatalog(deps);
  const codex = codexCatalog(deps);
  return {
    at,
    generatedAt: at,
    sources: [
      ...claudeResult.sourceStatuses,
      ...codex.sourceStatuses,
      ...deferredEnrichmentSources()
    ],
    providers: [claudeResult.catalog, codex.catalog]
  };
}

export async function collectModelRegistry(deps: ModelRegistryDeps = {}): Promise<ModelsResponse> {
  const now = deps.now ?? Date.now;
  const cachePath = deps.cachePath ?? modelRegistryCachePath(deps.env);

  if (!deps.listCodexModels && !deps.listClaudeModels) {
    const fallback = collectModels(deps);
    return {
      ...fallback,
      cache: { path: cachePath, hit: false, stale: false, reason: "no async runtime source configured" }
    };
  }

  try {
    const [codexResult, claudeResult] = await Promise.allSettled([
      deps.listCodexModels ? deps.listCodexModels() : Promise.resolve(undefined),
      deps.listClaudeModels ? deps.listClaudeModels() : Promise.resolve(undefined)
    ]);
    const response = collectModels({
      ...deps,
      ...(codexResult.status === "fulfilled" ? { codexModelList: codexResult.value } : {}),
      ...(claudeResult.status === "fulfilled" ? { claudeModelList: claudeResult.value } : {})
    });
    const failed = [
      ...(codexResult.status === "rejected" ? [runtimeFailure("codex-app-server", codexResult.reason)] : []),
      ...(claudeResult.status === "rejected" ? [runtimeFailure("claude-cli", claudeResult.reason)] : [])
    ];
    if (failed.length) {
      response.sources = [...failed, ...(response.sources ?? [])];
      const anyConfiguredSourceSucceeded =
        (Boolean(deps.listCodexModels) && codexResult.status === "fulfilled") ||
        (Boolean(deps.listClaudeModels) && claudeResult.status === "fulfilled");
      if (!anyConfiguredSourceSucceeded) {
        if (codexResult.status === "rejected") throw codexResult.reason;
        if (claudeResult.status === "rejected") throw claudeResult.reason;
        throw new Error("model discovery failed");
      }
      response.cache = {
        path: cachePath,
        hit: false,
        stale: false,
        reason: "partial runtime discovery; unavailable providers use fallback"
      };
      return response;
    }
    response.cache = { path: cachePath, hit: false, stale: false };
    writeModelRegistryCache(cachePath, response);
    return response;
  } catch (error) {
    const failure: ModelRegistrySourceStatus = {
      name: "codex-app-server",
      role: "runtime",
      ok: false,
      status: "failed",
      reason: error instanceof Error ? error.message : String(error)
    };
    const cached = readModelRegistryCache(cachePath, now());
    if (cached) {
      return staleCachedResponse(cached.response, {
        now: now(),
        cachePath,
        cacheMtimeMs: cached.mtimeMs,
        failure
      });
    }
    const fallback = collectModels(deps);
    return {
      ...fallback,
      cache: { path: cachePath, hit: false, stale: false, reason: "runtime refresh failed; served static fallback" },
      sources: [failure, ...(fallback.sources ?? [])]
    };
  }
}

export async function collectCliModelRegistry(deps: ModelRegistryDeps = {}): Promise<ModelsResponse> {
  const response = await collectModelRegistry({
    ...deps,
    readClaudeSettings: () => null,
    listClaudeModels: undefined,
    claudeModelList: undefined
  });
  const claude: ProviderModelCatalog = {
    provider: "claude",
    label: "Claude",
    options: CLAUDE_BUNDLED_MODELS,
    roleDefaults: roleDefaultsFor("claude", CLAUDE_BUNDLED_MODELS),
    runtimeSource: "bundled",
    source: ["bundled"],
    status: "available"
  };
  return {
    ...response,
    sources: [
      ...(response.sources ?? []).filter((source) => source.name === "codex-app-server" || source.role === "cache"),
      {
        name: "claude-bundled",
        role: "runtime",
        ok: true,
        status: "ok",
        reason: "bundled CLAUDE_ALIAS_CATALOG"
      }
    ],
    providers: response.providers.map((provider) => provider.provider === "claude" ? claude : provider)
  };
}

function claudeCatalog(deps: ModelsDeps): { catalog: ProviderModelCatalog; sourceStatuses: ModelRegistrySourceStatus[] } {
  if (deps.claudeModelList !== undefined) {
    const fromRuntime = claudeCatalogFromCli(deps, deps.claudeModelList);
    if (fromRuntime) return fromRuntime;
  }
  const catalog: ProviderModelCatalog = {
    provider: "claude",
    label: "Claude",
    options: CLAUDE_MODELS,
    runtimeSource: "claude-cli-fallback",
    source: ["static-fallback"],
    status: "fallback",
    roleDefaults: roleDefaultsFor("claude", CLAUDE_MODELS)
  };
  const raw = deps.readClaudeSettings ? deps.readClaudeSettings() : readClaudeSettingsFromDisk();
  const configured = raw ? stringField(safeParse(raw), "model") : undefined;
  if (!configured) return { catalog, sourceStatuses: [claudeFallbackSource()] };

  // `opus[1m]` -> alias `opus`, with the 1M window opt-in noted separately.
  const wants1m = /\[1m\]/i.test(configured);
  const bare = configured.replace(/\[[^\]]*\]/g, "").trim();
  const aliasId = CLAUDE_FULL_ID_ALIASES[bare] ?? bare;
  const entry = CLAUDE_MODELS.find((m) => m.id === aliasId);

  catalog.defaultId = configured;
  catalog.defaultSource = "claude-settings";
  if (entry) {
    catalog.defaultLabel = entry.label;
    catalog.defaultDetail = wants1m ? "1M context" : entry.detail;
  } else {
    // Unknown/pinned model string: surface it plainly rather than guessing.
    catalog.defaultLabel = configured;
    if (wants1m) catalog.defaultDetail = "1M context";
  }
  return { catalog, sourceStatuses: [claudeFallbackSource()] };
}

function claudeCatalogFromCli(deps: ModelsDeps, raw: unknown): { catalog: ProviderModelCatalog; sourceStatuses: ModelRegistrySourceStatus[] } | null {
  const result = typeof raw === "string" ? raw : stringField(raw, "result");
  if (!result) return null;
  const match = result.match(/Available:\s*([^\n.]+)(?:\.|$)/i);
  if (!match) return null;
  // The CLI is authoritative for the alias list; dedupe repeats and drop the
  // non-model sentinels (`default`, "or a full model ID") it appends.
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const value of match[1].split(",")) {
    const alias = value.trim();
    if (!alias || alias === "default" || /^or a full model id$/i.test(alias) || seen.has(alias)) continue;
    seen.add(alias);
    aliases.push(alias);
  }
  if (!aliases.length) return null;
  // Order frontier-first via the versioned adapter's rank (unknown aliases keep
  // their CLI order after known ones) so the picker's 3-row limit surfaces the
  // newest models (Fable 5) rather than the CLI's legacy sonnet-first order.
  const options = aliases
    .map((runtimeId, index) => ({ entry: claudeRuntimeEntry(runtimeId), rank: claudeAliasRank(runtimeId, index) }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ entry }) => entry);
  const catalog: ProviderModelCatalog = {
    provider: "claude", label: "Claude", options, roleDefaults: roleDefaultsFor("claude", options), runtimeSource: "claude-cli", source: ["claude-cli"], status: "available"
  };
  const current = result.match(/Current model:\s*([^\n]+)/i)?.[1]?.trim();
  if (current) {
    catalog.defaultLabel = current;
    catalog.defaultSource = "claude-cli";
  }
  return { catalog, sourceStatuses: [{ name: "claude-cli", role: "runtime", ok: true, status: "ok" }] };
}

// Rank a live CLI alias for picker ordering: known base aliases sort by their
// adapter rank, their `[1m]` opt-ins sort just after every base alias, and
// unrecognized aliases keep CLI order at the end so a newly shipped model still
// appears (just not ahead of the versioned models we know).
function claudeAliasRank(runtimeId: string, cliIndex: number): number {
  const bare = runtimeId.replace(/\[[^\]]*\]/g, "").trim();
  const meta = CLAUDE_ALIAS_CATALOG[bare];
  if (!meta) return 1000 + cliIndex;
  return /\[1m\]/i.test(runtimeId) ? 100 + meta.rank : meta.rank;
}

function claudeRuntimeEntry(runtimeId: string): ModelCatalogEntry {
  // Preserve the exact CLI alias as the launch id; resolve its label/detail
  // from the versioned adapter, honoring the `[1m]` context opt-in. The `[1m]`
  // variants get a "(1M)" label suffix so they read as distinct rows from their
  // base alias when the whole offered set is shown.
  const wants1m = /\[1m\]/i.test(runtimeId);
  const bare = runtimeId.replace(/\[[^\]]*\]/g, "").trim();
  const meta = CLAUDE_ALIAS_CATALOG[bare];
  const baseLabel = meta?.label ?? readableModelId(runtimeId);
  const label = wants1m ? `${baseLabel} (1M)` : baseLabel;
  const detail = wants1m ? "1M context" : meta?.detail;
  return {
    id: runtimeId,
    runtimeId,
    label,
    ...(detail ? { detail } : {}),
    ...(meta?.nativeProviderId
      ? { nativeProviderId: wants1m ? `${meta.nativeProviderId}[1m]` : meta.nativeProviderId }
      : {}),
    runtimeSource: "claude-cli",
    source: ["claude-cli"],
    status: "available"
  };
}

function claudeFallbackSource(): ModelRegistrySourceStatus {
  return { name: "claude-cli", role: "runtime", ok: false, status: "fallback", reason: "Claude CLI catalog query unavailable; using static fallback" };
}

function runtimeFailure(name: string, error: unknown): ModelRegistrySourceStatus {
  return { name, role: "runtime", ok: false, status: "failed", reason: error instanceof Error ? error.message : String(error) };
}

function codexCatalog(deps: ModelsDeps): { catalog: ProviderModelCatalog; sourceStatuses: ModelRegistrySourceStatus[] } {
  if (deps.codexModelList !== undefined) {
    const fromRuntime = codexCatalogFromModelList(deps, deps.codexModelList);
    if (fromRuntime) return fromRuntime;
  }
  const catalog: ProviderModelCatalog = {
    provider: "codex",
    label: "Codex",
    options: CODEX_MODELS,
    runtimeSource: "static-fallback",
    source: ["static-fallback"],
    status: "fallback",
    roleDefaults: roleDefaultsFor("codex", CODEX_MODELS)
  };
  const raw = deps.readCodexConfig ? deps.readCodexConfig() : readCodexConfigFromDisk();
  const configured = raw ? tomlTopLevelString(raw, "model") : undefined;
  if (!configured) {
    // No explicit config: fall back to the catalog's current default.
    const fallback = CODEX_MODELS[0];
    catalog.defaultId = fallback.id;
    catalog.defaultLabel = fallback.label;
    catalog.defaultDetail = fallback.detail;
    catalog.defaultSource = "catalog-default";
    catalog.defaultReasoningEffort = fallback.defaultReasoningEffort;
    return {
      catalog,
      sourceStatuses: [
        {
          name: "codex-app-server",
          role: "runtime",
          ok: false,
          status: "fallback",
          reason: "using static fallback catalog"
        }
      ]
    };
  }
  const entry = findModelEntry(CODEX_MODELS, configured);
  if (!entry) {
    catalog.options = [...catalog.options, unknownModelEntry(configured, "codex-config")];
  }
  catalog.defaultId = configured;
  catalog.defaultSource = "codex-config";
  catalog.defaultLabel = entry?.label ?? readableModelId(configured);
  catalog.defaultDetail = entry?.detail;
  catalog.defaultReasoningEffort = entry?.defaultReasoningEffort;
  return {
    catalog,
    sourceStatuses: [
      {
        name: "codex-app-server",
        role: "runtime",
        ok: false,
        status: "fallback",
        reason: "using static fallback catalog"
      }
    ]
  };
}

function codexCatalogFromModelList(
  deps: ModelsDeps,
  rawList: unknown
): { catalog: ProviderModelCatalog; sourceStatuses: ModelRegistrySourceStatus[] } | null {
  const options = normalizeCodexModelList(rawList);
  if (options.length === 0) return null;
  const raw = deps.readCodexConfig ? deps.readCodexConfig() : readCodexConfigFromDisk();
  const configured = raw ? tomlTopLevelString(raw, "model") : undefined;
  const runtimeDefault = options.find((entry) => entry.isDefault) ?? options[0];
  const configuredEntry = configured ? findModelEntry(options, configured) : undefined;
  const catalog: ProviderModelCatalog = {
    provider: "codex",
    label: "Codex",
    options,
    runtimeSource: "codex-app-server",
    source: ["codex-app-server"],
    status: "available",
    roleDefaults: roleDefaultsFor("codex", options)
  };

  if (configured) {
    if (!configuredEntry) {
      catalog.options = [...catalog.options, unknownModelEntry(configured, "codex-config")];
    }
    catalog.defaultId = configured;
    catalog.defaultLabel = configuredEntry?.label ?? readableModelId(configured);
    catalog.defaultDetail = configuredEntry?.detail;
    catalog.defaultSource = "codex-config";
    catalog.defaultReasoningEffort = configuredEntry?.defaultReasoningEffort;
  } else if (runtimeDefault) {
    catalog.defaultId = runtimeDefault.runtimeId ?? runtimeDefault.id;
    catalog.defaultLabel = runtimeDefault.label;
    catalog.defaultDetail = runtimeDefault.detail;
    catalog.defaultSource = "codex-app-server";
    catalog.defaultReasoningEffort = runtimeDefault.defaultReasoningEffort;
  }

  return {
    catalog,
    sourceStatuses: [
      { name: "codex-app-server", role: "runtime", ok: true, status: "ok" }
    ]
  };
}

// Product policy, not provider CLI configuration: the mate needs the most
// capable current model at medium reasoning, while workers use the second
// newest visible model at medium reasoning. Runtime catalog ordering is the
// recency signal, intentionally distinct from `defaultId`, which may be a
// local ~/.codex/config.toml choice. The static Claude catalog keeps its
// highest-capability entry first and its worker entry is Opus.
function roleDefaultsFor(agent: AgentKind, options: ModelCatalogEntry[]): Partial<Record<"orchestrator" | "crew", PerchModelRoleDefault>> {
  if (agent === "claude") {
    const orchestrator = options.find((option) => option.id === "best") ?? options.find((option) => option.id === "fable") ?? options[0];
    const crew = options.find((option) => option.id === "opus") ?? options[0];
    return {
      ...(orchestrator ? { orchestrator: { model: orchestrator.runtimeId ?? orchestrator.id } } : {}),
      ...(crew ? { crew: { model: crew.runtimeId ?? crew.id } } : {})
    };
  }
  const visible = options.filter((option) => !option.hidden && !option.deprecated);
  const frontier = visible[0] ?? options[0];
  const crew = visible[1] ?? frontier;
  if (!frontier) return {};
  const model = frontier.runtimeId ?? frontier.id;
  return {
    orchestrator: { model, effort: "medium" },
    ...(crew ? { crew: { model: crew.runtimeId ?? crew.id, effort: "medium" } } : {})
  };
}

export async function listClaudeModels(): Promise<unknown> {
  const { stdout } = await execFile("claude", ["--print", "--output-format", "json", "--no-session-persistence", "/model"], {
    timeout: 5_000,
    maxBuffer: 128 * 1024,
    windowsHide: true
  });
  const parsed = safeParse(stdout);
  if (!parsed) throw new Error("Claude CLI returned invalid JSON for /model");
  return parsed;
}
function normalizeCodexModelList(rawList: unknown): ModelCatalogEntry[] {
  const rawModels = Array.isArray((rawList as any)?.models)
    ? (rawList as any).models
    : Array.isArray((rawList as any)?.data)
      ? (rawList as any).data
    : Array.isArray(rawList)
      ? rawList
      : [];
  const models: ModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const row of rawModels) {
    const raw = row as any;
    const runtimeId = stringField(raw, "id") ?? stringField(raw, "model");
    if (!runtimeId || seen.has(runtimeId)) continue;
    seen.add(runtimeId);
    const supportedReasoningEfforts = codexEffortArray(raw?.supportedReasoningEfforts);
    const defaultReasoningEffort = codexEffort(raw?.defaultReasoningEffort);
    const serviceTiers = uniqueStrings([
      ...idArray(raw?.serviceTiers ?? raw?.supportedServiceTiers),
      ...idArray(raw?.additionalSpeedTiers)
    ]);
    models.push({
      id: runtimeId,
      runtimeId,
      label: stringField(raw, "displayName") ?? readableModelId(runtimeId),
      detail: stringField(raw, "description"),
      nativeProviderId: stringField(raw, "model") ?? runtimeId,
      apiId: stringField(raw, "apiId") ?? runtimeId,
      runtimeSource: "codex-app-server",
      source: ["codex-app-server"],
      status: "available",
      ...(supportedReasoningEfforts.length > 0 ? { supportedReasoningEfforts } : {}),
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      ...(serviceTiers.length > 0 ? { serviceTiers } : {}),
      ...(typeof raw?.isDefault === "boolean" ? { isDefault: raw.isDefault } : {}),
      ...(typeof raw?.hidden === "boolean" ? { hidden: raw.hidden } : {}),
      ...(typeof raw?.deprecated === "boolean" ? { deprecated: raw.deprecated } : {})
    });
  }
  return models;
}

function codexFallbackModel(
  id: string,
  label: string,
  detail: string,
  opts: { efforts: CodexReasoningEffort[]; defaultEffort?: CodexReasoningEffort; isDefault?: boolean }
): ModelCatalogEntry {
  return {
    id,
    runtimeId: id,
    label,
    detail,
    nativeProviderId: id,
    apiId: id,
    runtimeSource: "static-fallback",
    source: ["static-fallback"],
    status: "fallback",
    supportedReasoningEfforts: opts.efforts,
    defaultReasoningEffort: opts.defaultEffort ?? "medium",
    ...(opts.isDefault ? { isDefault: opts.isDefault } : {})
  };
}

function unknownModelEntry(id: string, source: string): ModelCatalogEntry {
  return {
    id,
    runtimeId: id,
    label: readableModelId(id),
    detail: "Configured model not in the current runtime catalog",
    runtimeSource: source,
    source: [source],
    status: "unknown"
  };
}

function findModelEntry(options: ModelCatalogEntry[], id: string): ModelCatalogEntry | undefined {
  return options.find((entry) => entry.id === id || entry.runtimeId === id);
}

export type ModelIdentifierMatch = {
  agent: AgentKind;
  model: string;
  aliases: string[];
  supportedEfforts: CodexReasoningEffort[];
  defaultEffort?: CodexReasoningEffort;
};

export function resolveModelIdentifier(
  registry: ModelsResponse,
  identifier: string,
  agent?: AgentKind
): ModelIdentifierMatch[] {
  const direct: ModelIdentifierMatch[] = [];
  const aliases: ModelIdentifierMatch[] = [];
  for (const provider of registry.providers) {
    if (agent && provider.provider !== agent) continue;
    for (const entry of provider.options) {
      const model = entry.runtimeId ?? entry.id;
      const entryAliases = uniqueStrings(
        [entry.id, entry.runtimeId, entry.nativeProviderId, entry.apiId]
          .filter((value): value is string => typeof value === "string")
      )
        .filter((value) => value !== model);
      const match: ModelIdentifierMatch = {
        agent: provider.provider,
        model,
        aliases: entryAliases,
        supportedEfforts: entry.supportedReasoningEfforts ?? [],
        ...(entry.defaultReasoningEffort ? { defaultEffort: entry.defaultReasoningEffort } : {})
      };
      if (identifier === entry.id || identifier === entry.runtimeId) direct.push(match);
      else if (entryAliases.includes(identifier)) aliases.push(match);
    }
  }
  const agents = new Set([...direct, ...aliases].map((match) => match.agent));
  const matches = [...agents].flatMap((matchAgent) => {
    const agentDirect = direct.filter((match) => match.agent === matchAgent);
    return agentDirect.length ? agentDirect : aliases.filter((match) => match.agent === matchAgent);
  });
  return [...new Map(matches.map((match) => [`${match.agent}:${match.model}`, match])).values()];
}

// The reasoning efforts a given model supports, resolved from a model registry
// response. This is the single source of truth config validation uses to reject
// an effort the selected model does not offer (e.g. `ultra` on gpt-5.5).
// Returns undefined when the model is not enumerated in the catalog (an unknown
// or freshly-pinned id) so callers can fall back to append-only tolerance
// rather than rejecting a model the catalog simply has not described yet.
export function supportedEffortsForModel(
  registry: ModelsResponse | undefined,
  agent: AgentKind,
  modelId: string | undefined
): CodexReasoningEffort[] | undefined {
  if (agent !== "codex" || !modelId) return undefined;
  const catalog = registry?.providers.find((provider) => provider.provider === "codex");
  if (!catalog) return undefined;
  const entry = findModelEntry(catalog.options, modelId);
  const efforts = entry?.supportedReasoningEfforts;
  return efforts && efforts.length > 0 ? efforts : undefined;
}

function deferredEnrichmentSources(): ModelRegistrySourceStatus[] {
  return [
    {
      name: "vercel-gateway",
      role: "enrichment",
      ok: true,
      status: "skipped",
      reason: "schema-ready enrichment source; not a local runtime source"
    },
    {
      name: "openai",
      role: "enrichment",
      ok: true,
      status: "skipped",
      reason: "schema-ready enrichment source; not a Codex CLI availability source"
    },
    {
      name: "anthropic",
      role: "enrichment",
      ok: true,
      status: "skipped",
      reason: "schema-ready enrichment source; not a Claude CLI availability source"
    }
  ];
}

// The exact model + reasoning effort a session is running, resolved from the
// launch overrides falling back to the CLI's own configured default. This is
// the single source of truth GET /sessions reports so the boss always sees
// what an agent is actually using - never null when it can be resolved. Reuses
// the same catalog/default resolution as `collectModels` so labels and the
// resolved default stay consistent between the picker and the live readout.
export type ResolvedSessionModel = {
  model?: string;
  modelLabel?: string;
  effort?: CodexReasoningEffort;
};

export function resolveSessionModel(
  agent: AgentKind,
  overrides: { model?: string; effort?: CodexReasoningEffort } = {},
  deps: ModelsDeps = {}
): ResolvedSessionModel {
  const catalog =
    agent === "claude" ? claudeCatalog(deps).catalog : agent === "codex" ? codexCatalog(deps).catalog : null;
  const requested = overrides.model?.trim();
  const model = requested || catalog?.defaultId;
  const modelLabel = model ? labelForModel(model, catalog) : undefined;
  if (agent === "codex") {
    // Explicit override wins; otherwise honor the CLI's own config default
    // (~/.codex/config.toml `model_reasoning_effort`) rather than silently
    // falling back to the model's built-in medium.
    const effort = overrides.effort ?? codexConfigEffort(deps);
    return { model, modelLabel, effort };
  }
  return { model, modelLabel };
}

export const MATE_MODEL_AUTO = "auto";

export function resolveMateLaunch(
  input: { agent: AgentKind; model?: string; effort?: CodexReasoningEffort },
  registry: ModelsResponse | undefined
): MateLaunchResolution {
  const configured = input.model?.trim();
  if (configured && configured.toLowerCase() !== MATE_MODEL_AUTO) {
    return { agent: input.agent, model: configured, effort: input.effort, modelSource: "pinned" };
  }

  const roleDefault = registry?.providers
    .find((provider) => provider.provider === input.agent)
    ?.roleDefaults?.orchestrator;
  if (roleDefault) {
    return {
      agent: input.agent,
      model: roleDefault.model,
      ...((input.effort ?? roleDefault.effort) ? { effort: input.effort ?? roleDefault.effort } : {}),
      modelSource: "auto"
    };
  }

  if (input.agent === "codex") {
    return {
      agent: "codex",
      model: MATE_CODEX_FALLBACK.model,
      effort: input.effort ?? MATE_CODEX_FALLBACK.effort,
      modelSource: "fallback"
    };
  }
  return { agent: "claude", model: MATE_CLAUDE_FALLBACK_MODEL, modelSource: "fallback" };
}

// Map a model id to its versioned label using the resolved catalog: an id
// matching a catalog option takes that option's label; the configured default
// id takes the resolved default label (which honors the claude `[1m]` opt-in);
// anything else surfaces a readable raw id rather than guessing current names.
function labelForModel(model: string, catalog: ProviderModelCatalog | null): string {
  if (!catalog) return readableModelId(model);
  const option = findModelEntry(catalog.options, model);
  if (option) return option.label;
  if (catalog.defaultId === model && catalog.defaultLabel) return catalog.defaultLabel;
  if (catalog.provider === "claude") {
    const bare = model.replace(/\[[^\]]*\]/g, "").trim();
    const aliasId = CLAUDE_FULL_ID_ALIASES[bare] ?? bare;
    const alias = catalog.options.find((entry) => entry.id === aliasId);
    if (alias) return alias.label;
    const fullIdLabel = labelForClaudeModelId(model);
    if (fullIdLabel) return fullIdLabel;
  }
  return readableModelId(model);
}

// Read the top-level `model_reasoning_effort` from ~/.codex/config.toml, if any.
// Unknown values still flow through (append-only enum) and are surfaced as-is.
function codexConfigEffort(deps: ModelsDeps): CodexReasoningEffort | undefined {
  const raw = deps.readCodexConfig ? deps.readCodexConfig() : readCodexConfigFromDisk();
  if (!raw) return undefined;
  const value = tomlTopLevelString(raw, "model_reasoning_effort");
  return value ? (value as CodexReasoningEffort) : undefined;
}

function modelRegistryCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(perchHome(env), "model-registry.json");
}

function writeModelRegistryCache(path: string, response: ModelsResponse): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(response, null, 2) + "\n", { mode: 0o600 });
  } catch {
    // Best effort: the live response is still valid if the offline cache fails.
  }
}

function readModelRegistryCache(
  path: string,
  nowMs: number
): { response: ModelsResponse; mtimeMs: number } | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = safeParse(raw);
    if (!parsed || !Array.isArray(parsed.providers)) return null;
    const stat = statSync(path);
    return { response: parsed as ModelsResponse, mtimeMs: stat.mtimeMs || nowMs };
  } catch {
    return null;
  }
}

function staleCachedResponse(
  cached: ModelsResponse,
  args: {
    now: number;
    cachePath: string;
    cacheMtimeMs: number;
    failure: ModelRegistrySourceStatus;
  }
): ModelsResponse {
  const at = new Date(args.now).toISOString();
  return {
    ...cached,
    at,
    generatedAt: at,
    cache: {
      path: args.cachePath,
      hit: true,
      stale: true,
      ageMs: Math.max(0, args.now - args.cacheMtimeMs),
      asOf: cached.generatedAt ?? cached.at,
      reason: "runtime refresh failed; served last good registry"
    },
    sources: [
      args.failure,
      { name: "model-registry-cache", role: "cache", ok: true, status: "stale" },
      ...deferredEnrichmentSources()
    ],
    providers: cached.providers.map(markCatalogStale)
  };
}

function markCatalogStale(catalog: ProviderModelCatalog): ProviderModelCatalog {
  return {
    ...catalog,
    status: "stale",
    options: catalog.options.map((entry) => ({
      ...entry,
      stale: true,
      status: entry.status === "deprecated" || entry.status === "hidden" ? entry.status : "stale"
    }))
  };
}

function readableModelId(rawId: string): string {
  const id = rawId
    .replace(/\[[^\]]*\]/g, "")
    .trim()
    .replace(/-\d{8}$/, "")
    .replace(/^[a-z]+\/+/i, "");
  if (!id) return rawId;

  const words = id.toLowerCase().split("-").filter(Boolean);
  if (words.length === 0) return rawId;
  if (words[0] === "claude") words.shift();

  const nameParts: string[] = [];
  const versionParts: string[] = [];
  const suffixParts: string[] = [];
  let seenVersion = false;
  for (const word of words) {
    if (/^[0-9]+(?:\.[0-9]+)*$/.test(word)) {
      seenVersion = true;
      versionParts.push(word);
    } else if (seenVersion) {
      suffixParts.push(formatNameToken(word));
    } else {
      nameParts.push(formatNameToken(word));
    }
  }

  const version = versionParts.join(".");
  const pieces = [...nameParts, version, ...suffixParts].filter(Boolean);
  return pieces.length > 0 ? pieces.join(" ") : rawId;
}

function formatNameToken(token: string): string {
  return token === "gpt" ? "GPT" : token.charAt(0).toUpperCase() + token.slice(1);
}

function codexEffortArray(value: unknown): CodexReasoningEffort[] {
  if (!Array.isArray(value)) return [];
  const efforts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") efforts.push(item);
    else if (item && typeof item === "object") {
      const effort = stringField(item, "reasoningEffort") ?? stringField(item, "id") ?? stringField(item, "name");
      if (effort) efforts.push(effort);
    }
  }
  return uniqueStrings(efforts).map((item) => item as CodexReasoningEffort);
}

function codexEffort(value: unknown): CodexReasoningEffort | undefined {
  return typeof value === "string" && value.length > 0 ? (value as CodexReasoningEffort) : undefined;
}

function idArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) ids.push(item);
    else if (item && typeof item === "object") {
      const id = stringField(item, "id") ?? stringField(item, "name");
      if (id) ids.push(id);
    }
  }
  return ids;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function readClaudeSettingsFromDisk(): string | null {
  try {
    return readFileSync(join(homedir(), ".claude", "settings.json"), "utf8");
  } catch {
    return null;
  }
}

function readCodexConfigFromDisk(): string | null {
  try {
    return readFileSync(join(homedir(), ".codex", "config.toml"), "utf8");
  } catch {
    return null;
  }
}

// Read a top-level `key = "value"` from a TOML file without a TOML dependency.
// Only matches assignments before the first `[table]` header so a per-project
// `[projects."..."]` override can't be mistaken for the global default.
function tomlTopLevelString(toml: string, key: string): string | undefined {
  for (const line of toml.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) break;
    const match = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/);
    if (match && match[1] === key) return match[2];
  }
  return undefined;
}

function stringField(obj: any, key: string): string | undefined {
  const value = obj?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
