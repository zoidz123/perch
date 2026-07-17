import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DISPATCH_CODEX_FALLBACK, MATE_CODEX_FALLBACK, MATE_MODEL_AUTO } from "./models.js";
import { FleetSettings } from "./settings.js";

function withHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "perch-settings-"));
  try {
    run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("dispatch defaults are empty until configured", () => {
  withHome((home) => {
    const settings = new FleetSettings({ PERCH_HOME: home } as NodeJS.ProcessEnv);
    assert.deepEqual(settings.dispatchDefaults(), {});
  });
});

test("updates persist to settings.json and round-trip through a fresh instance", () => {
  withHome((home) => {
    const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
    const settings = new FleetSettings(env);
    settings.updateDispatchDefaults({ agent: "codex" });
    assert.deepEqual(settings.dispatchDefaults(), {
      agent: "codex",
      model: DISPATCH_CODEX_FALLBACK.model,
      effort: DISPATCH_CODEX_FALLBACK.effort
    });
    // A fresh instance (new server boot) reads the same file.
    assert.deepEqual(new FleetSettings(env).dispatchDefaults(), {
      agent: "codex",
      model: DISPATCH_CODEX_FALLBACK.model,
      effort: DISPATCH_CODEX_FALLBACK.effort
    });
    const raw = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    assert.equal(raw.dispatchDefaults.agent, "codex");
    assert.equal(raw.dispatchDefaults.model, DISPATCH_CODEX_FALLBACK.model);
    assert.equal(raw.dispatchDefaults.effort, DISPATCH_CODEX_FALLBACK.effort);
  });
});

test("partial persisted Codex dispatch defaults read back as the full launch tuple", () => {
  withHome((home) => {
    writeFileSync(join(home, "settings.json"), `${JSON.stringify({ dispatchDefaults: { agent: "codex" } })}\n`);
    const settings = new FleetSettings({ PERCH_HOME: home } as NodeJS.ProcessEnv);
    assert.deepEqual(settings.dispatchDefaults(), {
      agent: "codex",
      model: DISPATCH_CODEX_FALLBACK.model,
      effort: DISPATCH_CODEX_FALLBACK.effort
    });
  });
});

test("null clears a key; untouched keys survive a partial update", () => {
  withHome((home) => {
    const settings = new FleetSettings({ PERCH_HOME: home } as NodeJS.ProcessEnv);
    settings.updateDispatchDefaults({ agent: "codex", model: "gpt-5.5", effort: "high" });
    settings.updateDispatchDefaults({ model: null });
    assert.deepEqual(settings.dispatchDefaults(), { agent: "codex", model: DISPATCH_CODEX_FALLBACK.model, effort: "high" });
    settings.updateDispatchDefaults({ agent: null });
    assert.deepEqual(settings.dispatchDefaults(), {});
  });
});

test("invalid agent and effort values are refused, naming the accepted set", () => {
  withHome((home) => {
    const settings = new FleetSettings({ PERCH_HOME: home } as NodeJS.ProcessEnv);
    assert.throws(
      () => settings.updateDispatchDefaults({ agent: "gemini" }),
      /invalid default agent "gemini".*claude.*codex/
    );
    assert.throws(
      () => settings.updateDispatchDefaults({ effort: "maximum" }),
      /invalid default effort "maximum"/
    );
    // A refused update never persists partial state.
    assert.deepEqual(settings.dispatchDefaults(), {});
  });
});

// A resolver mirroring the codex catalog: gpt-5.6 reaches ultra, gpt-5.5 tops
// out at xhigh, and an unknown model is unclassified (undefined).
const codexEfforts = (model: string | undefined): readonly string[] | undefined => {
  if (model === "gpt-5.6-sol") return ["low", "medium", "high", "xhigh", "max", "ultra"];
  if (model === "gpt-5.5") return ["low", "medium", "high", "xhigh"];
  return undefined;
};

test("per-model resolver accepts an effort the selected model supports (ultra on gpt-5.6)", () => {
  withHome((home) => {
    const settings = new FleetSettings({ PERCH_HOME: home } as NodeJS.ProcessEnv);
    const saved = settings.updateDispatchDefaults(
      { agent: "codex", model: "gpt-5.6-sol", effort: "ultra" },
      codexEfforts
    );
    assert.deepEqual(saved, { agent: "codex", model: "gpt-5.6-sol", effort: "ultra" });
  });
});

test("per-model resolver rejects an effort the selected model does not support (ultra on gpt-5.5)", () => {
  withHome((home) => {
    const settings = new FleetSettings({ PERCH_HOME: home } as NodeJS.ProcessEnv);
    assert.throws(
      () =>
        settings.updateDispatchDefaults(
          { agent: "codex", model: "gpt-5.5", effort: "ultra" },
          codexEfforts
        ),
      /invalid default effort "ultra" for model "gpt-5.5".*low.*medium.*high.*xhigh/
    );
    // A refused update never persists partial state.
    assert.deepEqual(settings.dispatchDefaults(), {});
  });
});

test("per-model resolver leaves unknown models to the baseline effort check", () => {
  withHome((home) => {
    const settings = new FleetSettings({ PERCH_HOME: home } as NodeJS.ProcessEnv);
    // Unknown model -> resolver returns undefined -> ultra passes the baseline.
    const saved = settings.updateDispatchDefaults(
      { agent: "codex", model: "gpt-9-unreleased", effort: "ultra" },
      codexEfforts
    );
    assert.equal(saved.effort, "ultra");
  });
});

test("mate defaults enforce the selected model's effort ceiling too", () => {
  withHome((home) => {
    const settings = new FleetSettings({ PERCH_HOME: home } as NodeJS.ProcessEnv);
    assert.throws(
      () =>
        settings.updateMateDefaults(
          { agent: "codex", model: "gpt-5.5", effort: "ultra" },
          codexEfforts
        ),
      /invalid mate effort "ultra" for model "gpt-5.5"/
    );
    assert.deepEqual(settings.mateDefaults(), {});
  });
});

test("PERCH_DEFAULT_* env overrides win over the persisted file", () => {
  withHome((home) => {
    const env = {
      PERCH_HOME: home,
      PERCH_DEFAULT_AGENT: "claude",
      PERCH_DEFAULT_MODEL: "haiku"
    } as NodeJS.ProcessEnv;
    const settings = new FleetSettings(env);
    settings.updateDispatchDefaults({ agent: "codex", model: "gpt-5.5", effort: "high" });
    // Env wins where set; persisted Codex model/effort do not leak onto Claude.
    assert.deepEqual(settings.dispatchDefaults(), {
      agent: "claude",
      model: "haiku"
    });
  });
});

test("PERCH_DEFAULT_AGENT=codex drops persisted Claude model before completing Codex defaults", () => {
  withHome((home) => {
    const env = {
      PERCH_HOME: home,
      PERCH_DEFAULT_AGENT: "codex"
    } as NodeJS.ProcessEnv;
    const settings = new FleetSettings(env);
    settings.updateDispatchDefaults({ agent: "claude", model: "opus" });
    assert.deepEqual(settings.dispatchDefaults(), {
      agent: "codex",
      model: DISPATCH_CODEX_FALLBACK.model,
      effort: DISPATCH_CODEX_FALLBACK.effort
    });
  });
});

test("mate defaults are empty until configured", () => {
  withHome((home) => {
    const settings = new FleetSettings({ PERCH_HOME: home } as NodeJS.ProcessEnv);
    assert.deepEqual(settings.mateDefaults(), {});
  });
});

test("mate defaults persist to settings.json and round-trip through a fresh instance", () => {
  withHome((home) => {
    const env = { PERCH_HOME: home } as NodeJS.ProcessEnv;
    const settings = new FleetSettings(env);
    settings.updateMateDefaults({ agent: "codex" });
    assert.deepEqual(settings.mateDefaults(), {
      agent: "codex",
      model: MATE_MODEL_AUTO,
      effort: MATE_CODEX_FALLBACK.effort
    });
    // A fresh instance (new server boot) reads the same file.
    assert.deepEqual(new FleetSettings(env).mateDefaults(), {
      agent: "codex",
      model: MATE_MODEL_AUTO,
      effort: MATE_CODEX_FALLBACK.effort
    });
    const raw = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    assert.equal(raw.mateDefaults.agent, "codex");
    assert.equal(raw.mateDefaults.model, MATE_MODEL_AUTO);
    assert.equal(raw.mateDefaults.effort, MATE_CODEX_FALLBACK.effort);
    // The two layers are independent.
    assert.deepEqual(settings.dispatchDefaults(), {});
  });
});

test("partial persisted Codex mate defaults read back as the full launch tuple", () => {
  withHome((home) => {
    writeFileSync(join(home, "settings.json"), `${JSON.stringify({ mateDefaults: { agent: "codex" } })}\n`);
    const settings = new FleetSettings({ PERCH_HOME: home } as NodeJS.ProcessEnv);
    assert.deepEqual(settings.mateDefaults(), {
      agent: "codex",
      model: MATE_MODEL_AUTO,
      effort: MATE_CODEX_FALLBACK.effort
    });
  });
});

test("mate defaults: null clears a key; untouched keys survive a partial update", () => {
  withHome((home) => {
    const settings = new FleetSettings({ PERCH_HOME: home } as NodeJS.ProcessEnv);
    settings.updateMateDefaults({ agent: "codex", model: "opus", effort: "high" });
    settings.updateMateDefaults({ model: null });
    assert.deepEqual(settings.mateDefaults(), { agent: "codex", model: MATE_MODEL_AUTO, effort: "high" });
    settings.updateMateDefaults({ agent: null });
    assert.deepEqual(settings.mateDefaults(), {});
  });
});

test("mate defaults: invalid agent and effort values are refused, naming the accepted set", () => {
  withHome((home) => {
    const settings = new FleetSettings({ PERCH_HOME: home } as NodeJS.ProcessEnv);
    assert.throws(
      () => settings.updateMateDefaults({ agent: "gemini" }),
      /invalid mate agent "gemini".*claude.*codex/
    );
    assert.throws(
      () => settings.updateMateDefaults({ effort: "maximum" }),
      /invalid mate effort "maximum"/
    );
    // A refused update never persists partial state.
    assert.deepEqual(settings.mateDefaults(), {});
  });
});

test("PERCH_MATE_* env overrides win over the persisted file", () => {
  withHome((home) => {
    const env = {
      PERCH_HOME: home,
      PERCH_MATE_AGENT: "claude",
      PERCH_MATE_MODEL: "haiku"
    } as NodeJS.ProcessEnv;
    const settings = new FleetSettings(env);
    settings.updateMateDefaults({ agent: "codex", model: "opus", effort: "high" });
    // Env wins where set; persisted Codex model/effort do not leak onto Claude.
    assert.deepEqual(settings.mateDefaults(), {
      agent: "claude",
      model: "haiku"
    });
  });
});

test("PERCH_MATE_AGENT=codex drops persisted Claude model before completing Codex defaults", () => {
  withHome((home) => {
    const env = {
      PERCH_HOME: home,
      PERCH_MATE_AGENT: "codex"
    } as NodeJS.ProcessEnv;
    const settings = new FleetSettings(env);
    settings.updateMateDefaults({ agent: "claude", model: "opus" });
    assert.deepEqual(settings.mateDefaults(), {
      agent: "codex",
      model: MATE_MODEL_AUTO,
      effort: MATE_CODEX_FALLBACK.effort
    });
  });
});
