import type { AgentKind } from "@perch/shared";

// A provider usage-limit / quota-exhaustion condition read off the rendered
// screen. A worker CLI that runs out of credits prints its own limit line and
// then just sits there: no hook fires, no tool call is attempted, the PTY goes
// quiet, and the session reads as a plain "idle" - so the task ledger keeps it
// "working" forever and the orchestrator is blind to a dead-on-arrival worker.
// This is the net for that: recognizing the CLI's own limit line on screen lets
// perch flip the session out of idle and block the task with an actionable note
// (which needs the owner to add credits, not the worker to keep trying).
export type UsageLimit = {
  // The provider whose quota is exhausted (openai/codex, anthropic/claude).
  provider: string;
  // The CLI's limit line, verbatim (clipped), so the block note the owner sees
  // carries the exact wording the terminal showed.
  message: string;
  // The retry/reset time the CLI named, when it named one ("3:28 PM", "3pm").
  // Absent when the CLI printed no time (e.g. a hard "purchase credits" stop).
  retryAt?: string;
  // Where Perch learned it. Structured provider events always win over the
  // rendered-terminal safety net.
  source?: "app_server" | "hook" | "terminal";
};

// Only the bottom of the screen is inspected. The CLI prints its limit line at
// the end of output and then the session sits there, so the line lives in the
// last handful of rendered rows. Windowing here is also the main guard against
// a false positive: a worker merely quoting or discussing usage limits earlier
// in its output scrolls up out of this window, while the CLI's own stuck line
// stays pinned to the bottom.
const WINDOW_LINES = 20;

// Per-agent detection. `phrase` must match a windowed line at its START (the `m`
// flag, so it recognizes the CLI's own error line rather than the same words
// embedded mid-sentence in prose). A line-leading run of non-alphanumeric marker
// glyphs is allowed before the phrase (`^[^a-z0-9]*`): codex renders the limit
// as a notice bullet - `■ You've hit your usage limit.` - and trimming the row
// leaves the glyph, so a bare `^you've` anchor silently misses the real line
// (observed in the wild at session startup, out of credits). The marker run is
// still non-alphabetic, so prose like "As you've hit your usage limit" - which
// has a letter before the phrase - does not match. `also`, when present, must
// additionally match somewhere in the window (a settings URL / product marker), a
// second anchor on the CLI's exact formatting. `retry` optionally pulls the named
// retry/reset time out; capture group 1 is the time text. Together these are
// deliberately narrow - a false positive blocks a healthy task on a phantom
// limit, strictly worse than missing one - which is why recognition is pinned to
// formatting a worker merely discussing limits would not reproduce, not to the
// bare words "usage limit".
//
// Adding an agent means adding one entry here after verifying the CLI's real
// limit line.
type UsageLimitRule = {
  provider: string;
  phrase: RegExp;
  also?: RegExp;
  retry?: RegExp;
};

const RULES: Partial<Record<AgentKind, UsageLimitRule>> = {
  // Codex prints, verbatim:
  //   You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage
  //   to purchase more credits or try again at 3:28 PM.
  codex: {
    provider: "codex",
    phrase: /^[^a-z0-9]*you'?ve hit your usage limit/im,
    also: /chatgpt\.com\/codex\/settings\/usage/i,
    retry: /try again at\s+([0-9]{1,2}:[0-9]{2}\s*(?:[AP]\.?M\.?)?)/i
  },
  // Claude prints its hard limit as, e.g.:
  //   Claude usage limit reached ∙ resets 3pm
  //   Claude AI usage limit reached. Your limit will reset at 3pm (America/New_York).
  // Anchored to "usage limit reached" so the "Approaching usage limit" warning
  // (a soft heads-up the worker can keep running through) never trips it.
  claude: {
    provider: "claude",
    phrase: /^[^a-z0-9]*claude(?:\s+ai)?\s+usage limit reached/im,
    retry: /reset(?:s)?(?:\s+at)?\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:[ap]\.?m\.?)?(?:\s*\([^)]+\))?)/i
  }
};

// Recognize a provider usage-limit condition on `screen` (the rendered PTY text,
// terminal control sequences already stripped). Pure: no I/O, no clock.
export function detectUsageLimit(
  screen: string,
  agent: AgentKind | undefined
): UsageLimit | undefined {
  const rule = agent ? RULES[agent] : undefined;
  if (!rule) {
    return undefined;
  }

  const windowed = screen
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-WINDOW_LINES)
    .join("\n");

  if (!rule.phrase.test(windowed) || (rule.also && !rule.also.test(windowed))) {
    return undefined;
  }

  // The line the phrase anchors on is the CLI's limit message; report that
  // rather than the whole window so the note is the sentence, not a screen.
  const message =
    windowed
      .split("\n")
      .find((line) => new RegExp(rule.phrase.source, "i").test(line))
      // Drop the leading TUI marker run so the note reads as the CLI sentence.
      ?.replace(/^[^a-z0-9]*/i, "")
      .slice(0, 300) ?? windowed.slice(0, 300);
  const retryMatch = rule.retry?.exec(windowed);
  // Trailing sentence punctuation is not part of the time ("3:28 PM." -> "3:28 PM").
  const retryAt = retryMatch?.[1]
    ?.replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;]+$/, "");

  return {
    provider: rule.provider,
    message,
    source: "terminal",
    ...(retryAt ? { retryAt } : {})
  };
}

// Codex app-server reports ordinary quota-window telemetry and actual
// exhaustion through the same rate-limit notification. Only semantic payload
// fields prove exhaustion: a non-null rateLimitReachedType, or the documented
// usageLimitExceeded error code. Notification method names and prose do not.
export function usageLimitFromCodexAppServer(value: unknown): UsageLimit | undefined {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  if (!record) return undefined;

  const nestedError = record.error && typeof record.error === "object"
    ? (record.error as Record<string, unknown>)
    : undefined;
  const rateLimits = record.rateLimits && typeof record.rateLimits === "object"
    ? (record.rateLimits as Record<string, unknown>)
    : undefined;
  const reachedType = [record.rateLimitReachedType, rateLimits?.rateLimitReachedType]
    .find((part): part is string => typeof part === "string" && part.trim().length > 0);
  const kind = [
    record.type,
    record.code,
    record.errorCode,
    record.reason,
    record.codexErrorInfo,
    nestedError?.type,
    nestedError?.code,
    nestedError?.errorCode,
    nestedError?.reason,
    nestedError?.codexErrorInfo
  ]
    .filter((part): part is string => typeof part === "string")
    .find((part) => /^(?:usageLimitExceeded|rateLimitReached|rateLimitExceeded|quotaExceeded)$/i.test(part.replace(/[^a-z]/gi, "")));
  if (!reachedType && !kind) return undefined;

  const message = [record.message, record.detail, nestedError?.message, nestedError?.detail]
    .find((part): part is string => typeof part === "string" && part.trim().length > 0) ?? "Codex provider usage limit reached";
  const retryAt = [
    record.retryAt,
    record.retry_at,
    record.resetAt,
    record.reset_at,
    nestedError?.retryAt,
    nestedError?.retry_at,
    nestedError?.resetAt,
    nestedError?.reset_at
  ]
    .find((part): part is string => typeof part === "string" && part.trim().length > 0);
  return { provider: "codex", message: message.slice(0, 300), source: "app_server", ...(retryAt ? { retryAt } : {}) };
}

// Claude Code's interactive TUI has no app-server. Its authoritative surface
// is the JSON hook payload, specifically an explicit usage/rate-limit
// notification type or error code. A Notification message alone is not enough
// to block work: terminal detection remains the narrowly anchored fallback.
export function usageLimitFromClaudeHook(value: unknown): UsageLimit | undefined {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  if (!record) return undefined;
  const kind = [record.notification_type, record.error_type, record.error_code, record.code]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
  if (!/(usage.?limit|rate.?limit|quota.?exceeded)/i.test(kind)) return undefined;
  const message = typeof record.message === "string" ? record.message : "Claude provider usage limit reached";
  const retryAt = [record.retry_at, record.retryAt, record.reset_at, record.resetAt]
    .find((part): part is string => typeof part === "string" && part.trim().length > 0);
  return { provider: "claude", message: message.slice(0, 300), source: "hook", ...(retryAt ? { retryAt } : {}) };
}
