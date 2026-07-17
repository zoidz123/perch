import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectModelRegistry,
  collectModels,
  labelForClaudeModelId,
  MATE_CLAUDE_FALLBACK_MODEL,
  MATE_CODEX_FALLBACK,
  resolveMateLaunch,
  resolveSessionModel,
  supportedEffortsForModel
} from "./models.js";
import type { ProviderModelCatalog } from "@perch/shared";

function providerOf(res: { providers: ProviderModelCatalog[] }, provider: string): ProviderModelCatalog {
  const found = res.providers.find((p) => p.provider === provider);
  assert.ok(found, `expected a ${provider} catalog`);
  return found;
}

const LIVE_CODEX_MODELS = {
  data: [
    {
      id: "gpt-5.6-sol",
      model: "gpt-5.6-sol",
      displayName: "GPT 5.6 Sol",
      description: "Sol description",
      isDefault: true,
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast responses with lighter reasoning" },
        { reasoningEffort: "medium", description: "Balances speed and reasoning depth" },
        { reasoningEffort: "high", description: "Greater reasoning depth" },
        { reasoningEffort: "xhigh", description: "Extra high reasoning depth" },
        { reasoningEffort: "max", description: "Maximum reasoning depth" },
        { reasoningEffort: "ultra", description: "Maximum reasoning with delegation" }
      ],
      defaultReasoningEffort: "low",
      serviceTiers: [{ id: "priority", name: "Fast" }],
      additionalSpeedTiers: ["fast"]
    },
    {
      id: "gpt-5.6-terra",
      model: "gpt-5.6-terra",
      displayName: "GPT 5.6 Terra",
      description: "Terra description",
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "Balances speed and reasoning depth" },
        { reasoningEffort: "high", description: "Greater reasoning depth" },
        { reasoningEffort: "xhigh", description: "Extra high reasoning depth" }
      ],
      defaultReasoningEffort: "high",
      serviceTiers: [{ id: "priority", name: "Fast" }]
    }
  ]
};

test("claude options carry versioned names + context windows", () => {
  const res = collectModels({ readClaudeSettings: () => null, readCodexConfig: () => null });
  const claude = providerOf(res, "claude");
  assert.deepEqual(
    claude.options.map((o) => [o.id, o.label, o.detail]),
    [
      ["claude-fable-5", "Fable 5", "1M context"],
      ["opus", "Opus 4.8", "1M context"],
      ["sonnet", "Sonnet 5", "1M context"],
      ["haiku", "Haiku 4.5", "200K context"]
    ]
  );
});

test("claude CLI /model output supplies the live runtime catalog", () => {
  const claude = providerOf(
    collectModels({
      readClaudeSettings: () => null,
      readCodexConfig: () => null,
      claudeModelList: {
        result: "Current model: Fable 5\nUsage: /model <name>. Available: sonnet, opus, haiku, fable, best, nebula, default, or a full model ID."
      }
    }),
    "claude"
  );
  assert.equal(claude.runtimeSource, "claude-cli");
  assert.equal(claude.status, "available");
  assert.deepEqual(claude.options.map((option) => option.runtimeId), ["sonnet", "opus", "haiku", "fable", "best", "nebula"]);
  assert.equal(claude.roleDefaults?.orchestrator?.model, "best");
  assert.equal(claude.roleDefaults?.crew?.model, "opus");
});

test("mate fallback uses Claude's frontier-tracking best alias (bin/perch.mjs mirrors it)", () => {
  // The literal matters: bin/perch.mjs carries a mirrored copy that cannot
  // import this constant, so a catalog reorder must update both.
  assert.equal(MATE_CLAUDE_FALLBACK_MODEL, "best");
});

test("codex options carry versioned names + grounded descriptions (no fabricated context)", () => {
  const res = collectModels({ readClaudeSettings: () => null, readCodexConfig: () => null });
  const codex = providerOf(res, "codex");
  assert.deepEqual(
    codex.options.map((o) => [o.id, o.label]),
    [
      ["gpt-5.6-sol", "GPT 5.6 Sol"],
      ["gpt-5.6-terra", "GPT 5.6 Terra"],
      ["gpt-5.6-luna", "GPT 5.6 Luna"],
      ["gpt-5.5", "GPT 5.5"],
      ["gpt-5.4", "GPT 5.4"],
      ["gpt-5.4-mini", "GPT 5.4 Mini"],
      ["gpt-5.3-codex-spark", "GPT 5.3 Codex Spark"]
    ]
  );
  // Grounded in the app-server model/list descriptions; never a token count.
  for (const o of codex.options) {
    assert.ok(o.detail && o.detail.length > 0, `codex ${o.id} should carry a description`);
    assert.ok(!/context/i.test(o.detail), `codex ${o.id} must not fake a context window`);
  }
});

test("static fallback carries per-model reasoning-effort ladders, not a shared four-tier", () => {
  const res = collectModels({ readClaudeSettings: () => null, readCodexConfig: () => null });
  const codex = providerOf(res, "codex");
  const efforts = (id: string) =>
    codex.options.find((o) => o.id === id)?.supportedReasoningEfforts;
  // gpt-5.6 sol/terra reach ultra; luna reaches max; older families top at xhigh.
  assert.deepEqual(efforts("gpt-5.6-sol"), ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.deepEqual(efforts("gpt-5.6-terra"), ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.deepEqual(efforts("gpt-5.6-luna"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(efforts("gpt-5.5"), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(efforts("gpt-5.4"), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(efforts("gpt-5.4-mini"), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(efforts("gpt-5.3-codex-spark"), ["low", "medium", "high", "xhigh"]);
  // The spark family defaults to high; everything else to medium.
  assert.equal(codex.options.find((o) => o.id === "gpt-5.3-codex-spark")?.defaultReasoningEffort, "high");
  assert.equal(codex.options.find((o) => o.id === "gpt-5.6-sol")?.defaultReasoningEffort, "medium");
});

test("supportedEffortsForModel resolves the selected codex model's ladder for validation", () => {
  const live = collectModels({
    readClaudeSettings: () => null,
    readCodexConfig: () => null,
    codexModelList: LIVE_CODEX_MODELS
  });
  assert.deepEqual(
    supportedEffortsForModel(live, "codex", "gpt-5.6-sol"),
    ["low", "medium", "high", "xhigh", "max", "ultra"]
  );
  // Matches by runtimeId too, and returns undefined for unknown / non-codex.
  assert.equal(supportedEffortsForModel(live, "codex", "not-a-model"), undefined);
  assert.equal(supportedEffortsForModel(live, "claude", "opus"), undefined);
  assert.equal(supportedEffortsForModel(undefined, "codex", "gpt-5.6-sol"), undefined);
});

test("codex app-server model/list maps runtime ids and effort metadata", () => {
  const res = collectModels({
    readClaudeSettings: () => null,
    readCodexConfig: () => null,
    codexModelList: LIVE_CODEX_MODELS
  });
  const codex = providerOf(res, "codex");
  assert.equal(codex.defaultId, "gpt-5.6-sol");
  assert.equal(codex.defaultSource, "codex-app-server");
  assert.equal(codex.defaultReasoningEffort, "low");
  assert.equal(codex.runtimeSource, "codex-app-server");
  assert.equal(res.sources?.find((source) => source.name === "codex-app-server")?.ok, true);
  assert.deepEqual(codex.roleDefaults, {
    orchestrator: { model: "gpt-5.6-sol", effort: "medium" },
    crew: { model: "gpt-5.6-terra", effort: "medium" }
  });
  assert.deepEqual(
    codex.options.map((o) => ({
      id: o.id,
      runtimeId: o.runtimeId,
      label: o.label,
      detail: o.detail,
      supportedReasoningEfforts: o.supportedReasoningEfforts,
      defaultReasoningEffort: o.defaultReasoningEffort,
      serviceTiers: o.serviceTiers,
      isDefault: o.isDefault,
      hidden: o.hidden
    })),
    [
      {
        id: "gpt-5.6-sol",
        runtimeId: "gpt-5.6-sol",
        label: "GPT 5.6 Sol",
        detail: "Sol description",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultReasoningEffort: "low",
        serviceTiers: ["priority", "fast"],
        isDefault: true,
        hidden: false
      },
      {
        id: "gpt-5.6-terra",
        runtimeId: "gpt-5.6-terra",
        label: "GPT 5.6 Terra",
        detail: "Terra description",
        supportedReasoningEfforts: ["medium", "high", "xhigh"],
        defaultReasoningEffort: "high",
        serviceTiers: ["priority"],
        isDefault: undefined,
        hidden: undefined
      }
    ]
  );
});

test("Perch role defaults ignore a provider CLI default", () => {
  const registry = collectModels({
    readClaudeSettings: () => JSON.stringify({ model: "haiku" }),
    readCodexConfig: () => 'model = "gpt-5.6-terra"',
    codexModelList: LIVE_CODEX_MODELS
  });
  const claude = providerOf(registry, "claude");
  const codex = providerOf(registry, "codex");
  assert.equal(claude.defaultId, "haiku");
  assert.equal(claude.roleDefaults?.orchestrator?.model, "claude-fable-5");
  assert.equal(codex.defaultId, "gpt-5.6-terra");
  assert.equal(codex.roleDefaults?.orchestrator?.model, "gpt-5.6-sol");
});

test("mate auto resolves through the registry orchestrator role default", () => {
  const registry = collectModels({
    readClaudeSettings: () => JSON.stringify({ model: "haiku" }),
    readCodexConfig: () => 'model = "gpt-5.6-terra"',
    codexModelList: LIVE_CODEX_MODELS
  });
  assert.deepEqual(resolveMateLaunch({ agent: "codex", model: "auto" }, registry), {
    agent: "codex",
    model: "gpt-5.6-sol",
    effort: "medium",
    modelSource: "auto"
  });
  assert.deepEqual(resolveMateLaunch({ agent: "claude", model: "auto" }, registry), {
    agent: "claude",
    model: "claude-fable-5",
    modelSource: "auto"
  });
  assert.equal(resolveMateLaunch({ agent: "codex", model: "auto" }, undefined).model, MATE_CODEX_FALLBACK.model);
});

test("model registry serves stale cache when codex runtime refresh fails", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-model-registry-"));
  const cachePath = join(home, "model-registry.json");
  try {
    const fresh = await collectModelRegistry({
      cachePath,
      now: () => 1_000,
      readClaudeSettings: () => null,
      readCodexConfig: () => null,
      listCodexModels: async () => LIVE_CODEX_MODELS
    });
    assert.equal(fresh.cache?.stale, false);
    assert.equal(providerOf(fresh, "codex").options[0]?.id, "gpt-5.6-sol");

    const stale = await collectModelRegistry({
      cachePath,
      now: () => 4_000,
      readClaudeSettings: () => null,
      readCodexConfig: () => null,
      listCodexModels: async () => {
        throw new Error("offline");
      }
    });
    assert.equal(stale.cache?.hit, true);
    assert.equal(stale.cache?.stale, true);
    assert.match(stale.sources?.[0]?.reason ?? "", /offline/);
    const codex = providerOf(stale, "codex");
    assert.equal(codex.options[0]?.id, "gpt-5.6-sol");
    assert.equal(codex.options[0]?.stale, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("model registry serves static fallback when runtime and cache both fail", async () => {
  const home = mkdtempSync(join(tmpdir(), "perch-model-registry-empty-"));
  const cachePath = join(home, "model-registry.json");
  try {
    const res = await collectModelRegistry({
      cachePath,
      readClaudeSettings: () => null,
      readCodexConfig: () => null,
      listCodexModels: async () => {
        throw new Error("offline");
      }
    });
    assert.equal(res.cache?.hit, false);
    assert.match(res.cache?.reason ?? "", /static fallback/);
    const codex = providerOf(res, "codex");
    assert.equal(codex.defaultId, "gpt-5.6-sol");
    assert.equal(codex.options[0]?.runtimeSource, "static-fallback");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("claude default resolves from settings.json and honors the [1m] opt-in", () => {
  const res = collectModels({
    readClaudeSettings: () => JSON.stringify({ model: "opus[1m]" }),
    readCodexConfig: () => null
  });
  const claude = providerOf(res, "claude");
  assert.equal(claude.defaultId, "opus[1m]");
  assert.equal(claude.defaultLabel, "Opus 4.8");
  assert.equal(claude.defaultDetail, "1M context");
  assert.equal(claude.defaultSource, "claude-settings");
  assert.equal(claude.options.filter((option) => option.label === "Opus 4.8").length, 1);
  assert.ok(claude.options.every((option) => !/\b1M\b/.test(option.label)));
});

test("claude default maps a bare alias and a full model id", () => {
  const bare = providerOf(
    collectModels({ readClaudeSettings: () => JSON.stringify({ model: "sonnet" }), readCodexConfig: () => null }),
    "claude"
  );
  assert.equal(bare.defaultLabel, "Sonnet 5");
  assert.equal(bare.defaultDetail, "1M context");

  const full = providerOf(
    collectModels({
      readClaudeSettings: () => JSON.stringify({ model: "claude-haiku-4-5" }),
      readCodexConfig: () => null
    }),
    "claude"
  );
  assert.equal(full.defaultLabel, "Haiku 4.5");
  assert.equal(full.defaultDetail, "200K context");
});

test("claude default is absent when nothing is configured", () => {
  const claude = providerOf(
    collectModels({ readClaudeSettings: () => null, readCodexConfig: () => null }),
    "claude"
  );
  assert.equal(claude.defaultLabel, undefined);
  assert.equal(claude.defaultId, undefined);
});

test("codex default reads the top-level model from config.toml, ignoring [projects] tables", () => {
  const toml = [
    'model = "gpt-5.4"',
    'model_reasoning_effort = "medium"',
    '[projects."/Users/x/other"]',
    'model = "gpt-5.5"'
  ].join("\n");
  const codex = providerOf(
    collectModels({ readClaudeSettings: () => null, readCodexConfig: () => toml }),
    "codex"
  );
  assert.equal(codex.defaultId, "gpt-5.4");
  assert.equal(codex.defaultLabel, "GPT 5.4");
  assert.equal(codex.defaultSource, "codex-config");
});

test("codex default falls back to the catalog default when config is absent", () => {
  const codex = providerOf(
    collectModels({ readClaudeSettings: () => null, readCodexConfig: () => null }),
    "codex"
  );
  assert.equal(codex.defaultId, "gpt-5.6-sol");
  assert.equal(codex.defaultLabel, "GPT 5.6 Sol");
  assert.equal(codex.defaultSource, "catalog-default");
});

test("unknown configured codex model remains visible with readable metadata", () => {
  const codex = providerOf(
    collectModels({
      readClaudeSettings: () => null,
      readCodexConfig: () => 'model = "gpt-6-zed"',
      codexModelList: LIVE_CODEX_MODELS
    }),
    "codex"
  );
  assert.equal(codex.defaultId, "gpt-6-zed");
  assert.equal(codex.defaultLabel, "GPT 6 Zed");
  assert.equal(codex.defaultSource, "codex-config");
  const unknown = codex.options.find((option) => option.id === "gpt-6-zed");
  assert.equal(unknown?.label, "GPT 6 Zed");
  assert.equal(unknown?.status, "unknown");
});

test("resolveSessionModel: explicit codex model + effort win and carry the versioned label", () => {
  const resolved = resolveSessionModel(
    "codex",
    { model: "gpt-5.4", effort: "high" },
    { readCodexConfig: () => 'model = "gpt-5.5"\nmodel_reasoning_effort = "xhigh"' }
  );
  assert.deepEqual(resolved, { model: "gpt-5.4", modelLabel: "GPT 5.4", effort: "high" });
});

test("resolveSessionModel: codex with no explicit effort honors config.toml, not the model default", () => {
  const resolved = resolveSessionModel(
    "codex",
    {},
    { readCodexConfig: () => 'model = "gpt-5.5"\nmodel_reasoning_effort = "xhigh"' }
  );
  assert.equal(resolved.model, "gpt-5.5");
  assert.equal(resolved.modelLabel, "GPT 5.5");
  assert.equal(resolved.effort, "xhigh");
});

test("resolveSessionModel: codex falls back to the catalog default model when nothing is configured", () => {
  const resolved = resolveSessionModel("codex", {}, { readCodexConfig: () => null });
  assert.equal(resolved.model, "gpt-5.6-sol");
  assert.equal(resolved.modelLabel, "GPT 5.6 Sol");
  assert.equal(resolved.effort, undefined);
});

test("resolveSessionModel: claude resolves the settings default label and carries no effort", () => {
  const resolved = resolveSessionModel(
    "claude",
    {},
    { readClaudeSettings: () => JSON.stringify({ model: "opus[1m]" }) }
  );
  assert.equal(resolved.model, "opus[1m]");
  assert.equal(resolved.modelLabel, "Opus 4.8");
  assert.equal(resolved.effort, undefined);
});

test("resolveSessionModel: explicit claude models use friendly labels and never carry effort", () => {
  const cases = [
    ["claude-fable-5", "Fable 5"],
    ["opus[1m]", "Opus 4.8"],
    ["claude-opus-4-8", "Opus 4.8"],
    ["sonnet", "Sonnet 5"],
    ["claude-sonnet-5", "Sonnet 5"],
    ["haiku", "Haiku 4.5"],
    ["claude-haiku-4-5", "Haiku 4.5"]
  ] as const;
  for (const [model, label] of cases) {
    const resolved = resolveSessionModel(
      "claude",
      { model, effort: "xhigh" },
      { readClaudeSettings: () => JSON.stringify({ model: "opus" }) }
    );
    assert.equal(resolved.model, model);
    assert.equal(resolved.modelLabel, label);
    assert.equal(resolved.effort, undefined, `${model} must not expose a Codex effort`);
  }
});

test("labelForClaudeModelId maps transcript ids, stripping window/date suffixes", () => {
  assert.equal(labelForClaudeModelId("claude-fable-5"), "Fable 5");
  assert.equal(labelForClaudeModelId("claude-fable-5[1m]"), "Fable 5");
  assert.equal(labelForClaudeModelId("claude-opus-4-8"), "Opus 4.8");
  assert.equal(labelForClaudeModelId("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(labelForClaudeModelId("claude-unheard-of-9"), undefined);
});
