import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clearUsageCache, collectUsage, parseClaudeUsagePanel } from "./usage.js";

// A fixed clock so window/day math is deterministic.
const NOW = Date.UTC(2026, 6, 4, 12, 0, 0); // 2026-07-04T12:00:00Z
const now = () => NOW;

function fakeFetch(routes: Record<string, { status: number; body?: unknown }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const match = routes[url];
    if (!match) return new Response("not found", { status: 404 });
    return new Response(match.body === undefined ? "" : JSON.stringify(match.body), {
      status: match.status,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
}

const CLAUDE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_URL = "https://chatgpt.com/backend-api/wham/usage";

test("collectUsage maps live Claude and Codex windows", async () => {
  clearUsageCache();
  const result = await collectUsage({
    now,
    readClaudeCredentials: async () =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "tok",
          scopes: ["user:profile", "user:inference"],
          subscriptionType: "max",
          expiresAt: NOW + 3_600_000
        }
      }),
    readCodexAuth: () => JSON.stringify({ tokens: { access_token: "ctok", account_id: "acct" } }),
    fetchImpl: fakeFetch({
      [CLAUDE_URL]: {
        status: 200,
        body: {
          five_hour: { utilization: 11, resets_at: "2026-07-04T17:50:00Z" },
          seven_day: { utilization: 63, resets_at: "2026-07-05T21:00:00Z" },
          extra_usage: { is_enabled: false }
        }
      },
      [CODEX_URL]: {
        status: 200,
        body: {
          plan_type: "pro",
          rate_limit: {
            primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: 1783198197 },
            secondary_window: { used_percent: 8, limit_window_seconds: 604800, reset_at: 1783717388 }
          },
          credits: { has_credits: true, balance: "12.5" }
        }
      }
    })
  });

  const claude = result.providers.find((p) => p.provider === "claude");
  assert.ok(claude?.available, "claude available");
  assert.equal(claude?.plan, "max");
  assert.equal(claude?.source, "oauth-usage-api");
  assert.equal(claude?.windows.find((w) => w.kind === "session")?.percentUsed, 11);
  assert.equal(claude?.windows.find((w) => w.kind === "week")?.percentUsed, 63);
  assert.equal(claude?.credits, undefined, "disabled overage yields no credits");

  const codex = result.providers.find((p) => p.provider === "codex");
  assert.ok(codex?.available, "codex available");
  assert.equal(codex?.plan, "pro");
  assert.equal(codex?.source, "backend-usage-api");
  assert.equal(codex?.windows.find((w) => w.kind === "session")?.percentUsed, 20);
  assert.equal(codex?.windows.find((w) => w.kind === "week")?.windowMinutes, 10_080);
  assert.equal(codex?.credits?.remainingDollars, 12.5);
});

test("collectUsage coalesces concurrent in-flight provider reads", async () => {
  clearUsageCache();
  let reads = 0;
  let releaseCredentials: (() => void) | undefined;
  const credentialsReady = new Promise<void>((resolve) => {
    releaseCredentials = resolve;
  });
  const deps = {
    now,
    readClaudeCredentials: async () => {
      reads += 1;
      await credentialsReady;
      return null;
    },
    readCodexAuth: () => null,
    codexSessionsDir: join(mkdtempSync(join(tmpdir(), "perch-usage-coalesce-")), "sessions"),
    fetchImpl: fakeFetch({})
  };

  const first = collectUsage(deps);
  const second = collectUsage(deps);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1, "one provider collection serves both callers");
  releaseCredentials?.();
  assert.deepEqual(await first, await second);
});

test("collection deadline returns partial provider results before a fallback hangs", async () => {
  clearUsageCache();
  const started = Date.now();
  const result = await collectUsage({
    now,
    collectionDeadlineMs: 25,
    log: () => {},
    readClaudeCredentials: async () =>
      JSON.stringify({ claudeAiOauth: { accessToken: "tok", scopes: ["user:profile"], expiresAt: NOW + 3_600_000 } }),
    runClaudeUsageCli: () => new Promise<string | null>(() => {}),
    readCodexAuth: () => JSON.stringify({ tokens: { access_token: "ctok" } }),
    fetchImpl: fakeFetch({
      [CLAUDE_URL]: { status: 500 },
      [CODEX_URL]: {
        status: 200,
        body: {
          rate_limit: {
            primary_window: { used_percent: 17, limit_window_seconds: 18000 }
          }
        }
      }
    })
  });

  assert.ok(Date.now() - started < 500, "server deadline wins before client deadlines");
  assert.equal(result.providers.find((p) => p.provider === "claude")?.available, false);
  assert.equal(result.providers.find((p) => p.provider === "codex")?.available, true);
});

test("one provider failure preserves the other provider result", async () => {
  clearUsageCache();
  const result = await collectUsage({
    now,
    log: () => {},
    readClaudeCredentials: async () => null,
    readCodexAuth: () => JSON.stringify({ tokens: { access_token: "ctok" } }),
    fetchImpl: fakeFetch({
      [CODEX_URL]: {
        status: 200,
        body: {
          rate_limit: {
            secondary_window: { used_percent: 33, limit_window_seconds: 604800 }
          }
        }
      }
    })
  });

  assert.equal(result.providers.find((p) => p.provider === "claude")?.available, false);
  assert.equal(result.providers.find((p) => p.provider === "codex")?.available, true);
  assert.equal(result.providers.find((p) => p.provider === "codex")?.windows[0]?.kind, "week");
});

test("Codex weekly-only primary window is normalized by duration", async () => {
  clearUsageCache();
  const result = await collectUsage({
    now,
    readClaudeCredentials: async () => null,
    readCodexAuth: () => JSON.stringify({ tokens: { access_token: "ctok" } }),
    fetchImpl: fakeFetch({
      [CODEX_URL]: {
        status: 200,
        body: {
          rate_limit: {
            primary_window: { used_percent: 61, limit_window_seconds: 604800 }
          }
        }
      }
    })
  });

  const codex = result.providers.find((p) => p.provider === "codex");
  assert.equal(codex?.windows.length, 1);
  assert.equal(codex?.windows[0]?.kind, "week");
  assert.equal(codex?.windows[0]?.windowMinutes, 10_080);
  assert.equal(codex?.windows.find((window) => window.kind === "session"), undefined);
});

test("collectUsage reports honest gaps instead of faking numbers", async () => {
  clearUsageCache();
  const result = await collectUsage({
    now,
    readClaudeCredentials: async () => null,
    readCodexAuth: () => null,
    codexSessionsDir: join(mkdtempSync(join(tmpdir(), "perch-usage-empty-")), "sessions"),
    fetchImpl: fakeFetch({})
  });
  const claude = result.providers.find((p) => p.provider === "claude");
  const codex = result.providers.find((p) => p.provider === "codex");
  assert.equal(claude?.available, false);
  assert.match(claude?.note ?? "", /Not logged into Claude Code/);
  assert.equal(codex?.available, false);
  assert.equal(codex?.windows.length, 0);
});

test("collectUsage expired Claude token does not hit the network", async () => {
  clearUsageCache();
  let fetched = false;
  const result = await collectUsage({
    now,
    readClaudeCredentials: async () =>
      JSON.stringify({ claudeAiOauth: { accessToken: "tok", scopes: ["user:profile"], expiresAt: NOW - 1 } }),
    readCodexAuth: () => null,
    codexSessionsDir: join(mkdtempSync(join(tmpdir(), "perch-usage-exp-")), "sessions"),
    fetchImpl: (async () => {
      fetched = true;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch
  });
  const claude = result.providers.find((p) => p.provider === "claude");
  assert.equal(claude?.available, false);
  assert.match(claude?.note ?? "", /expired/);
  assert.equal(fetched, false, "no request for a known-expired token");
});

test("collectUsage falls back to Codex rollout rate_limits when the API is down", async () => {
  clearUsageCache();
  const home = mkdtempSync(join(tmpdir(), "perch-usage-roll-"));
  // NOW = 2026-07-04 -> today's day dir.
  const dir = join(home, "sessions", "2026", "07", "04");
  mkdirSync(dir, { recursive: true });
  const rows = [
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: null } }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          plan_type: "pro",
          primary: { used_percent: 5, window_minutes: 300, resets_at: 1783150244 },
          secondary: { used_percent: 42, window_minutes: 10080, resets_at: 1783717388 }
        }
      }
    })
  ].join("\n");
  writeFileSync(join(dir, "rollout-2026-07-04T02-30-32-abc.jsonl"), rows);

  const result = await collectUsage({
    now,
    readClaudeCredentials: async () => null,
    // A token exists but the endpoint 500s -> exercise the offline fallback.
    readCodexAuth: () => JSON.stringify({ tokens: { access_token: "ctok" } }),
    codexSessionsDir: join(home, "sessions"),
    fetchImpl: fakeFetch({ [CODEX_URL]: { status: 500 } })
  });
  const codex = result.providers.find((p) => p.provider === "codex");
  assert.ok(codex?.available, "codex from rollout");
  assert.equal(codex?.source, "rollout-jsonl");
  assert.equal(codex?.plan, "pro");
  assert.equal(codex?.windows.find((w) => w.kind === "week")?.percentUsed, 42);

  rmSync(home, { recursive: true, force: true });
});

test("a fresh read is stamped with asOf and is not stale", async () => {
  clearUsageCache();
  const result = await collectUsage({
    now,
    readClaudeCredentials: async () =>
      JSON.stringify({ claudeAiOauth: { accessToken: "tok", scopes: ["user:profile"], expiresAt: NOW + 3_600_000 } }),
    readCodexAuth: () => null,
    codexSessionsDir: join(mkdtempSync(join(tmpdir(), "perch-usage-fresh-")), "sessions"),
    fetchImpl: fakeFetch({
      [CLAUDE_URL]: { status: 200, body: { five_hour: { utilization: 20 }, seven_day: { utilization: 40 } } }
    })
  });
  const claude = result.providers.find((p) => p.provider === "claude");
  assert.ok(claude?.available);
  assert.equal(claude?.stale ?? false, false, "a live read is not stale");
  assert.equal(claude?.asOf, new Date(NOW).toISOString(), "asOf stamps the capture time");
});

test("a failed refresh degrades to the last good snapshot flagged stale", async () => {
  clearUsageCache();
  // A mutable clock so the second call falls outside the 30s memo but keeps the
  // retained snapshot from the first.
  let clock = NOW;
  const claudeCreds = async () =>
    JSON.stringify({ claudeAiOauth: { accessToken: "tok", scopes: ["user:profile"], expiresAt: clock + 3_600_000 } });
  const emptySessions = join(mkdtempSync(join(tmpdir(), "perch-usage-stale-")), "sessions");

  const good = await collectUsage({
    now: () => clock,
    readClaudeCredentials: claudeCreds,
    readCodexAuth: () => null,
    codexSessionsDir: emptySessions,
    fetchImpl: fakeFetch({
      [CLAUDE_URL]: { status: 200, body: { five_hour: { utilization: 12 }, seven_day: { utilization: 55 } } }
    })
  });
  const goodClaude = good.providers.find((p) => p.provider === "claude");
  assert.equal(goodClaude?.windows.find((w) => w.kind === "week")?.percentUsed, 55);
  assert.equal(goodClaude?.stale ?? false, false);

  // Move past the memo window; the live endpoint now 500s and the CLI fallback
  // yields nothing.
  clock = NOW + CACHE_TTL_MS + 1;
  const degraded = await collectUsage({
    now: () => clock,
    readClaudeCredentials: claudeCreds,
    readCodexAuth: () => null,
    codexSessionsDir: emptySessions,
    runClaudeUsageCli: async () => null,
    fetchImpl: fakeFetch({ [CLAUDE_URL]: { status: 500 } })
  });
  const staleClaude = degraded.providers.find((p) => p.provider === "claude");
  assert.equal(staleClaude?.available, true, "meter stays up on a transient failure");
  assert.equal(staleClaude?.stale, true, "flagged stale");
  assert.equal(staleClaude?.windows.find((w) => w.kind === "week")?.percentUsed, 55, "serves last good numbers");
  assert.equal(staleClaude?.asOf, new Date(NOW).toISOString(), "asOf is the age of the retained snapshot");
});

// The 30s memo constant, mirrored so the stale test can step past it.
const CACHE_TTL_MS = 30_000;

test("Claude CLI /usage panel is the live-API fallback", async () => {
  clearUsageCache();
  let cliCalls = 0;
  const result = await collectUsage({
    now,
    // A valid, unexpired, scoped token so we reach the network - which 500s,
    // arming the CLI fallback.
    readClaudeCredentials: async () =>
      JSON.stringify({ claudeAiOauth: { accessToken: "tok", scopes: ["user:profile"], expiresAt: NOW + 3_600_000 } }),
    readCodexAuth: () => null,
    codexSessionsDir: join(mkdtempSync(join(tmpdir(), "perch-usage-cli-")), "sessions"),
    runClaudeUsageCli: async () => {
      cliCalls += 1;
      return CLAUDE_PANEL_FIXTURE;
    },
    fetchImpl: fakeFetch({ [CLAUDE_URL]: { status: 500 } })
  });
  const claude = result.providers.find((p) => p.provider === "claude");
  assert.equal(cliCalls, 1, "the CLI fallback ran once");
  assert.ok(claude?.available, "recovered via the CLI panel");
  assert.equal(claude?.source, "cli-usage");
  assert.equal(claude?.windows.find((w) => w.kind === "session")?.percentUsed, 6);
  assert.equal(claude?.windows.find((w) => w.kind === "week")?.percentUsed, 57);
});

test("a logged-out gap does not spawn the CLI", async () => {
  clearUsageCache();
  let cliCalls = 0;
  await collectUsage({
    now,
    readClaudeCredentials: async () => null,
    readCodexAuth: () => null,
    codexSessionsDir: join(mkdtempSync(join(tmpdir(), "perch-usage-nocli-")), "sessions"),
    runClaudeUsageCli: async () => {
      cliCalls += 1;
      return CLAUDE_PANEL_FIXTURE;
    },
    fetchImpl: fakeFetch({})
  });
  assert.equal(cliCalls, 0, "no CLI spawn when the user is simply not logged in");
});

test("parseClaudeUsagePanel reads settled session + all-models week percents", () => {
  const windows = parseClaudeUsagePanel(CLAUDE_PANEL_FIXTURE);
  const session = windows.find((w) => w.kind === "session");
  const week = windows.find((w) => w.kind === "week");
  assert.equal(session?.percentUsed, 6, "last settled session render");
  assert.equal(week?.percentUsed, 57, "the (all models) week, not the per-model 100%");
  // Not the localized wall-clock reset string.
  assert.equal(week?.resetsAt, "");
});

// A trimmed capture of a real `claude` + `/usage` render (ANSI + bar glyphs
// intact, re-render frames included). The session drifts 5% -> 6% across
// frames; the parser must take the settled last value and must not mistake the
// per-model "Current week (Fable) 100%" sub-limit for the week window.
const CLAUDE_PANEL_FIXTURE = [
  "\x1b[2mCurrent session\x1b[0m██▌                    5%used  Resets 1:10pm (America/New_York)",
  "Current week (all models)████████████████████████████▍  56%used  Resets Jul 12 at 5pm (America/New_York)",
  "\x1b[38;5;1mCurrent session\x1b[0m███                   6%used",
  "Current week (all models)████████████████████████████▍  57%used  Resets Jul 12 at 4:59pm (America/New_York)",
  "Current week (Fable)██████████████████████████████████████████████████100%used"
].join("\n");
