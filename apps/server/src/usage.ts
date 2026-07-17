import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pty from "node-pty";
import type { ProviderUsage, UsageResponse, UsageWindow } from "@perch/shared";

const execFileAsync = promisify(execFile);

// Local usage and credit snapshot for the agent providers running on this Mac.
// Both providers reuse the credentials their CLIs already stored:
//  - Claude: the OAuth token Claude Code already stored (keychain / creds
//    file) -> GET api.anthropic.com/api/oauth/usage.
//  - Codex: the OAuth token in ~/.codex/auth.json -> GET
//    chatgpt.com/backend-api/wham/usage, with the rate_limits Codex writes
//    into its rollout JSONL as an offline fallback.
// These are the agents' own private endpoints (reverse-engineered, not
// contractual), so every field is decoded leniently and any failure degrades
// to `available: false` with a `note` rather than faking a number. This path
// is deliberately independent of perch's in-progress codex app-server adapter
// (the app-server RPC is the richer long-term source; see the PR writeup).

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const FETCH_TIMEOUT_MS = 6000;
// The shortest client deadline is direct HTTP at 8s. Finish the entire
// provider collection before that so clients receive partial or stale data
// instead of timing out while a fallback is still running.
const COLLECTION_DEADLINE_MS = 7000;
// Multiple phones plus pull-to-refresh must not hammer the providers' private
// endpoints; one short memo covers a burst of clients.
const CACHE_TTL_MS = 30_000;
// Hard ceiling on driving the Claude CLI's `/usage` panel in a PTY (spawn ->
// trust prompt -> render). Only runs on a failed live read, throttled by the
// 30s memo, and always returns null rather than hanging past this.
const CLI_USAGE_TIMEOUT_MS = 12_000;
const CLAUDE_CLI_BIN = process.env.PERCH_CLAUDE_BIN || "claude";

export type UsageDeps = {
  // Raw Claude Code OAuth JSON blob (the `{ claudeAiOauth: {...} }` object),
  // or null when not logged in. Injected in tests.
  readClaudeCredentials?: () => Promise<string | null>;
  // Raw ~/.codex/auth.json contents, or null when absent.
  readCodexAuth?: () => string | null;
  // Raw rendered text of the Claude CLI `/usage` panel (ANSI ok), or null when
  // the CLI could not be driven. Default drives a real PTY; injected in tests.
  runClaudeUsageCli?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  codexSessionsDir?: string;
  now?: () => number;
  collectionDeadlineMs?: number;
  log?: (message: string) => void;
};

type ProviderKey = "claude" | "codex";

let cache: { at: number; value: UsageResponse } | null = null;
let inFlight: Promise<UsageResponse> | null = null;
// The last SUCCESSFUL snapshot per provider, retained for the process lifetime.
// A failed refresh degrades to this (flagged stale) instead of dropping to
// unavailable, so a flaky live read does not make the meter disappear.
const lastGood = new Map<ProviderKey, { at: number; value: ProviderUsage }>();

export async function collectUsage(deps: UsageDeps = {}): Promise<UsageResponse> {
  const now = deps.now ?? Date.now;
  if (cache && now() - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }
  if (inFlight) return inFlight;

  const collection = collectUsageFresh(deps, now);
  inFlight = collection;
  try {
    return await collection;
  } finally {
    if (inFlight === collection) inFlight = null;
  }
}

async function collectUsageFresh(deps: UsageDeps, now: () => number): Promise<UsageResponse> {
  const deadlineMs = deps.collectionDeadlineMs ?? COLLECTION_DEADLINE_MS;
  const [claude, codex] = await Promise.all([
    providerBeforeDeadline("claude", claudeUsage(deps), deadlineMs, deps),
    providerBeforeDeadline("codex", codexUsage(deps), deadlineMs, deps)
  ]);
  const value: UsageResponse = {
    at: new Date(now()).toISOString(),
    providers: [degrade("claude", claude, now), degrade("codex", codex, now)]
  };
  cache = { at: now(), value };
  return value;
}

// Record a live success as the provider's last-good snapshot; on a failure,
// serve that snapshot flagged stale (with the age of the data) so the panel
// keeps its meters. Only when there is no prior success do we report the
// honest gap.
function degrade(key: ProviderKey, fresh: ProviderUsage, now: () => number): ProviderUsage {
  if (fresh.available) {
    const at = now();
    lastGood.set(key, { at, value: fresh });
    return { ...fresh, asOf: new Date(at).toISOString() };
  }
  const prev = lastGood.get(key);
  if (prev) {
    return { ...prev.value, stale: true, asOf: new Date(prev.at).toISOString() };
  }
  return fresh;
}

// Exposed for tests: drop the memo AND the retained snapshots so injected deps
// take effect immediately and stale state does not leak between tests.
export function clearUsageCache(): void {
  cache = null;
  inFlight = null;
  lastGood.clear();
}

async function providerBeforeDeadline(
  provider: ProviderKey,
  work: Promise<ProviderUsage>,
  deadlineMs: number,
  deps: UsageDeps
): Promise<ProviderUsage> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<ProviderUsage>((_, reject) => {
        timer = setTimeout(() => reject(new Error("collection deadline exceeded")), deadlineMs);
        timer.unref?.();
      })
    ]);
  } catch (error) {
    diagnose(deps, provider, error);
    return unavailable(provider, `Could not refresh ${provider === "claude" ? "Claude Code" : "Codex"} usage.`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function diagnose(deps: UsageDeps, provider: ProviderKey, error: unknown): void {
  const message = `[usage] ${provider} collection failed: ${errText(error)}`;
  if (deps.log) {
    deps.log(message);
  } else {
    console.warn(message);
  }
}

function unavailable(provider: "claude" | "codex", note: string): ProviderUsage {
  return { provider, available: false, note, windows: [] };
}

function isoFromEpochSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

async function timedFetch(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>
): Promise<Response> {
  return fetchImpl(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

// --- Claude ----------------------------------------------------------------

// Ordered chain: the OAuth usage API, then - only when
// that failed in a way the CLI could plausibly cover (network/endpoint/auth
// hiccup, not "logged out") - the Claude CLI's own `/usage` panel driven in a
// PTY. A "logged out" / "expired" / "no windows" gap short-circuits the CLI so
// we neither spawn `claude` pointlessly nor hang on its login screen.
async function claudeUsage(deps: UsageDeps): Promise<ProviderUsage> {
  const api = await claudeUsageFromApi(deps);
  if (api.usage.available) return api.usage;
  if (api.tryCli) {
    const cli = await claudeUsageFromCli(deps);
    if (cli) return cli;
  }
  return api.usage;
}

// `tryCli` marks failures the CLI fallback might still recover (the OAuth token
// perch read is stale/rejected but the interactive CLI session is fine, or the
// endpoint transiently failed) vs. gaps it cannot (no login at all, a token
// the user already knows is expired, an org with no windows).
async function claudeUsageFromApi(deps: UsageDeps): Promise<{ usage: ProviderUsage; tryCli: boolean }> {
  try {
    const raw = deps.readClaudeCredentials
      ? await deps.readClaudeCredentials()
      : await readClaudeCredentialsFromSystem();
    if (!raw) {
      return { usage: unavailable("claude", "Not logged into Claude Code on this Mac."), tryCli: false };
    }
    const oauth = safeParse(raw)?.claudeAiOauth;
    const token = typeof oauth?.accessToken === "string" ? oauth.accessToken : undefined;
    if (!token) {
      return { usage: unavailable("claude", "Claude Code credentials found but no access token."), tryCli: false };
    }
    // A token missing the profile scope cannot read the usage endpoint; say so
    // instead of surfacing a bare 401.
    const scopes: unknown = oauth?.scopes;
    if (Array.isArray(scopes) && !scopes.includes("user:profile")) {
      return { usage: unavailable("claude", "Claude Code token lacks profile scope for usage."), tryCli: false };
    }
    if (typeof oauth?.expiresAt === "number" && oauth.expiresAt < (deps.now ?? Date.now)()) {
      return { usage: unavailable("claude", "Claude Code login expired - run `claude` on the Mac."), tryCli: false };
    }

    const fetchImpl = deps.fetchImpl ?? fetch;
    const res = await timedFetch(fetchImpl, CLAUDE_USAGE_URL, {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      Accept: "application/json",
      "User-Agent": "perch"
    });
    if (res.status === 401 || res.status === 403) {
      // The token perch pulled may just be stale; the live CLI session can
      // still render /usage, so let the fallback try.
      return { usage: unavailable("claude", "Claude Code login expired - run `claude` on the Mac."), tryCli: true };
    }
    if (!res.ok) {
      return { usage: unavailable("claude", `Claude usage endpoint returned ${res.status}.`), tryCli: true };
    }
    const body = (await res.json()) as Record<string, any>;
    const windows: UsageWindow[] = [];
    const session = body.five_hour;
    if (session && typeof session.utilization === "number") {
      windows.push({
        kind: "session",
        percentUsed: session.utilization,
        resetsAt: String(session.resets_at ?? ""),
        windowMinutes: 300
      });
    }
    const week = body.seven_day;
    if (week && typeof week.utilization === "number") {
      windows.push({
        kind: "week",
        percentUsed: week.utilization,
        resetsAt: String(week.resets_at ?? ""),
        windowMinutes: 10_080
      });
    }
    if (windows.length === 0) {
      return { usage: unavailable("claude", "Claude account has no usage windows (managed org?)."), tryCli: false };
    }
    const plan = typeof oauth?.subscriptionType === "string" ? oauth.subscriptionType : undefined;
    // Overage credits only when the user actually enabled extra usage; a
    // disabled $0/$50 pool is not real spend and must not read like it.
    const credits = claudeCredits(body.extra_usage);
    return {
      usage: {
        provider: "claude",
        available: true,
        windows,
        source: "oauth-usage-api",
        ...(plan ? { plan } : {}),
        ...(credits ? { credits } : {})
      },
      tryCli: false
    };
  } catch (error) {
    diagnose(deps, "claude", error);
    return { usage: unavailable("claude", "Could not refresh Claude Code usage."), tryCli: true };
  }
}

// Fallback source: parse the Claude CLI's own `/usage` panel. The CLI is
// already installed and logged in on this Mac, so it covers the case where the
// OAuth token perch scraped is stale but the CLI session is not.
async function claudeUsageFromCli(deps: UsageDeps): Promise<ProviderUsage | null> {
  try {
    const raw = deps.runClaudeUsageCli ? await deps.runClaudeUsageCli() : await runClaudeUsageCliDefault();
    if (!raw) return null;
    const windows = parseClaudeUsagePanel(raw);
    if (windows.length === 0) return null;
    return {
      provider: "claude",
      available: true,
      windows,
      source: "cli-usage",
      note: "Read from the Claude CLI /usage panel."
    };
  } catch (error) {
    diagnose(deps, "claude", error);
    return null;
  }
}

// Parse the rendered `/usage` panel. After stripping ANSI and the meter bar
// glyphs, the panel reads like:
//   Current session               6%used   Resets 1:10pm (America/New_York)
//   Current week (all models)     57%used  Resets Jul 12 at 4:59pm (...)
//   Current week (Fable)          100%used ...
// We take the "Current session" percent and the "(all models)" week percent -
// deliberately ignoring per-model sub-limits. The panel re-renders as it loads,
// so we use the LAST occurrence of each (the settled values). The reset text is
// a localized wall-clock string, not ISO, so we leave resetsAt empty rather
// than emit an unparseable instant; the percentage meters are the value here.
export function parseClaudeUsagePanel(text: string): UsageWindow[] {
  const clean = text
    // ANSI CSI + OSC sequences.
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    // Meter bar block-drawing glyphs -> space, so header and percent are only
    // whitespace apart.
    .replace(/[▀-▟]+/g, " ");
  const windows: UsageWindow[] = [];
  const session = lastPercent(clean, /current session\D*?(\d{1,3})\s*%/gi);
  if (session !== null) {
    windows.push({ kind: "session", percentUsed: session, resetsAt: "", windowMinutes: 300 });
  }
  const week =
    lastPercent(clean, /current week \(all models\)\D*?(\d{1,3})\s*%/gi) ??
    lastPercent(clean, /current week\D*?(\d{1,3})\s*%/gi);
  if (week !== null) {
    windows.push({ kind: "week", percentUsed: week, resetsAt: "", windowMinutes: 10_080 });
  }
  return windows;
}

// Last capture-group match of a global regex, as a clamped 0-100 number.
function lastPercent(text: string, re: RegExp): number | null {
  let value: number | null = null;
  for (const m of text.matchAll(re)) {
    const n = Number(m[1]);
    if (!Number.isNaN(n)) value = Math.max(0, Math.min(100, n));
  }
  return value;
}

// Default CLI driver: spawn `claude` in a PTY, clear the first-run trust
// prompt, send `/usage`, and capture the rendered panel. Best-effort and fully
// bounded - any spawn/render problem resolves to null so the chain falls back
// to the API's honest gap. Nested-agent env is scrubbed so the child persists a
// normal session, matching the nested-agent spawn guardrail.
function runClaudeUsageCliDefault(): Promise<string | null> {
  return new Promise((resolve) => {
    let child: pty.IPty;
    try {
      child = pty.spawn(CLAUDE_CLI_BIN, ["--allowedTools", ""], {
        name: "xterm-color",
        cols: 120,
        rows: 40,
        cwd: homedir(),
        env: scrubbedClaudeEnv()
      });
    } catch {
      resolve(null);
      return;
    }
    let buf = "";
    let sentUsage = false;
    let settleAt = 0;
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(buf.includes("%") ? buf : null), CLI_USAGE_TIMEOUT_MS);
    child.onData((d) => {
      buf += d;
      // Clear the first-run "trust this folder" gate.
      if (!sentUsage && /trust this folder/i.test(buf)) child.write("\r");
      // The footer hint ("shift+tab", "for shortcuts") only draws once the
      // prompt is ready - a safe moment to send the slash command.
      if (!sentUsage && /(shift\+tab|for shortcuts)/i.test(buf)) {
        sentUsage = true;
        child.write("/usage\r");
      }
    });
    // Once the panel has both headers and a percent, let it settle a beat then
    // capture the settled render.
    const poll = setInterval(() => {
      if (sentUsage && /current (session|week)/i.test(buf) && buf.includes("%")) {
        if (settleAt === 0) settleAt = Date.now();
        else if (Date.now() - settleAt > 800) finish(buf);
      }
    }, 200);
    child.onExit(() => finish(buf.includes("%") ? buf : null));
  });
}

function scrubbedClaudeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")) continue;
    env[key] = value;
  }
  return env;
}

function claudeCredits(extra: unknown): ProviderUsage["credits"] | undefined {
  if (!extra || typeof extra !== "object") return undefined;
  const e = extra as Record<string, any>;
  if (e.is_enabled !== true) return undefined;
  const limit = typeof e.monthly_limit === "number" ? e.monthly_limit / 100 : undefined;
  const used = typeof e.used_credits === "number" ? e.used_credits : undefined;
  if (limit === undefined && used === undefined) return undefined;
  return {
    ...(used !== undefined ? { usedDollars: used } : {}),
    ...(limit !== undefined ? { limitDollars: limit } : {}),
    ...(limit !== undefined && used !== undefined ? { remainingDollars: Math.max(0, limit - used) } : {})
  };
}

// The Claude Code CLI writes its OAuth blob to a creds file (no prompt) and/or
// the login keychain. Prefer the file; fall back to the keychain item.
async function readClaudeCredentialsFromSystem(): Promise<string | null> {
  const file = join(homedir(), ".claude", ".credentials.json");
  try {
    return readFileSync(file, "utf8");
  } catch {
    // No creds file; try the keychain.
  }
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: 4000 }
    );
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

// --- Codex -----------------------------------------------------------------

async function codexUsage(deps: UsageDeps): Promise<ProviderUsage> {
  const live = await codexUsageFromApi(deps);
  if (live) return live;
  // Offline / stale token: fall back to the rate_limits Codex last wrote to a
  // rollout JSONL. Stable-by-construction (pure file read), but only as fresh
  // as the last time a Codex session ran.
  const offline = codexUsageFromRollout(deps);
  if (offline) return offline;
  return unavailable("codex", "No Codex usage available (log in with `codex`).");
}

async function codexUsageFromApi(deps: UsageDeps): Promise<ProviderUsage | null> {
  try {
    const raw = deps.readCodexAuth ? deps.readCodexAuth() : readCodexAuthFromDisk(deps);
    if (!raw) return null;
    const auth = safeParse(raw);
    const token = auth?.tokens?.access_token;
    if (typeof token !== "string" || token.length === 0) return null;
    const accountId = typeof auth?.tokens?.account_id === "string" ? auth.tokens.account_id : "";

    const fetchImpl = deps.fetchImpl ?? fetch;
    const res = await timedFetch(fetchImpl, CODEX_USAGE_URL, {
      Authorization: `Bearer ${token}`,
      "ChatGPT-Account-Id": accountId,
      Accept: "application/json",
      "User-Agent": "perch"
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, any>;
    const windows = codexWindows(body.rate_limit);
    if (windows.length === 0) return null;
    const plan = typeof body.plan_type === "string" ? body.plan_type : undefined;
    const credits = codexCredits(body.credits);
    return {
      provider: "codex",
      available: true,
      windows,
      source: "backend-usage-api",
      ...(plan ? { plan } : {}),
      ...(credits ? { credits } : {})
    };
  } catch (error) {
    diagnose(deps, "codex", error);
    return null;
  }
}

// wham/usage: reset_at is epoch seconds, windows in seconds. Rollout JSONL:
// resets_at is epoch seconds, window_minutes. Normalize both to UsageWindow.
function codexWindows(rateLimit: unknown): UsageWindow[] {
  if (!rateLimit || typeof rateLimit !== "object") return [];
  const rl = rateLimit as Record<string, any>;
  const windows: UsageWindow[] = [];
  const primary = rl.primary_window ?? rl.primary;
  const secondary = rl.secondary_window ?? rl.secondary;
  const append = (window: Record<string, any> | undefined, fallbackKind: "session" | "week") => {
    if (!window || typeof window.used_percent !== "number") return;
    const minutes = codexWindowMinutes(window);
    const kind = minutes === 300 ? "session" : minutes === 10_080 ? "week" : fallbackKind;
    if (windows.some((entry) => entry.kind === kind)) return;
    windows.push({
      kind,
      percentUsed: window.used_percent,
      resetsAt: codexResetIso(window),
      windowMinutes: minutes ?? (kind === "session" ? 300 : 10_080)
    });
  };
  append(primary, "session");
  append(secondary, "week");
  return windows;
}

function codexResetIso(window: Record<string, any>): string {
  const resetAt = window.reset_at ?? window.resets_at;
  return typeof resetAt === "number" ? isoFromEpochSeconds(resetAt) : "";
}

function codexWindowMinutes(window: Record<string, any>): number | undefined {
  if (typeof window.limit_window_seconds === "number") return Math.round(window.limit_window_seconds / 60);
  if (typeof window.window_minutes === "number") return window.window_minutes;
  return undefined;
}

function codexCredits(credits: unknown): ProviderUsage["credits"] | undefined {
  if (!credits || typeof credits !== "object") return undefined;
  const c = credits as Record<string, any>;
  if (c.has_credits !== true) return undefined;
  const balance = typeof c.balance === "string" ? Number(c.balance) : c.balance;
  if (typeof balance !== "number" || Number.isNaN(balance)) return undefined;
  return { remainingDollars: balance };
}

function readCodexAuthFromDisk(deps: UsageDeps): string | null {
  const dir = deps.codexSessionsDir ? join(deps.codexSessionsDir, "..") : join(homedir(), ".codex");
  try {
    return readFileSync(join(dir, "auth.json"), "utf8");
  } catch {
    return null;
  }
}

function codexSessionsRoot(deps: UsageDeps): string {
  return deps.codexSessionsDir ?? join(homedir(), ".codex", "sessions");
}

// Walk the most recent rollout files (newest day dirs first) and return the
// last rate_limits event found - Codex writes one on every token_count.
function codexUsageFromRollout(deps: UsageDeps): ProviderUsage | null {
  const root = codexSessionsRoot(deps);
  const now = deps.now ?? Date.now;
  const files: { path: string; day: number }[] = [];
  for (let offset = 0; offset <= 14; offset += 1) {
    const d = new Date(now() - offset * 86_400_000);
    const dir = join(
      root,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0")
    );
    try {
      for (const name of readdirSync(dir)) {
        if (name.startsWith("rollout-") && name.endsWith(".jsonl")) {
          files.push({ path: join(dir, name), day: offset });
        }
      }
    } catch {
      // Day dir absent.
    }
  }
  // Newest day first; within a day, later filenames sort later (ISO stamped).
  files.sort((a, b) => (a.day - b.day) || (a.path < b.path ? 1 : -1));
  for (const { path } of files.slice(0, 60)) {
    const rateLimit = lastRateLimitInFile(path);
    if (rateLimit) {
      const windows = codexWindows(rateLimit);
      if (windows.length > 0) {
        const plan = typeof rateLimit.plan_type === "string" ? rateLimit.plan_type : undefined;
        return {
          provider: "codex",
          available: true,
          windows,
          source: "rollout-jsonl",
          note: "Offline snapshot from the last Codex session.",
          ...(plan ? { plan } : {})
        };
      }
    }
  }
  return null;
}

function lastRateLimitInFile(path: string): Record<string, any> | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || !line.includes('"rate_limits"')) continue;
    const row = safeParse(line);
    const rl = row?.payload?.rate_limits;
    if (rl && typeof rl === "object") return rl as Record<string, any>;
  }
  return null;
}

// --- shared ----------------------------------------------------------------

function safeParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
