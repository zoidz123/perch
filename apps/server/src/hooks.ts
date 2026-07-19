import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { AgentSessionStatus, QuestionItem } from "@perch/shared";
import { ASK_USER_QUESTION_TOOL, extractQuestions, questionId } from "./askQuestion.js";

// Perch recovers agent structure without owning provider SDKs: every
// perch-spawned PTY carries PERCH_SESSION_ID / PERCH_HOOK_URL /
// PERCH_HOOK_TOKEN in its environment, and a globally-installed Claude hook
// (gated on that env, inert everywhere else) POSTs each hook event back to
// the local server. Fail-open by design: a dead server must never break the
// user's Claude session.

const HOOK_MARKER = "$PERCH_HOOK_URL";
// One command serves every event: the payload on stdin carries
// hook_event_name. Gated on PERCH_SESSION_ID so it is a no-op outside perch
// terminals, capped at 3s, and always exits 0.
const HOOK_COMMAND =
  '[ -z "$PERCH_SESSION_ID" ] || curl -sf --max-time 3 -X POST "$PERCH_HOOK_URL" ' +
  '-H "content-type: application/json" -H "x-perch-session: $PERCH_SESSION_ID" ' +
  '-H "x-perch-token: $PERCH_HOOK_TOKEN" --data-binary @- >/dev/null 2>&1; exit 0';
// The Claude SessionStart variant echoes the server's response body to stdout:
// the server answers that one event with hookSpecificOutput.additionalContext
// (the chart capability note below), which Claude injects into the session's
// context - solo agents learn charts exist with zero setup. Still fail-silent:
// curl -sf prints nothing on failure, an empty body prints nothing, exit 0.
const HOOK_COMMAND_SESSION_START =
  '[ -z "$PERCH_SESSION_ID" ] || curl -sf --max-time 3 -X POST "$PERCH_HOOK_URL" ' +
  '-H "content-type: application/json" -H "x-perch-session: $PERCH_SESSION_ID" ' +
  '-H "x-perch-token: $PERCH_HOOK_TOKEN" --data-binary @- 2>/dev/null; exit 0';
// Claude Stop hooks support structured stdout that can continue the same
// agentic loop once. The server uses that only when the correlated turn has no
// accepted task outcome. The command still fails open if the server is down.
const HOOK_COMMAND_STOP = HOOK_COMMAND_SESSION_START;
const CLAUDE_PRETOOL_OBSERVER_COMMAND =
  '[ -z "$PERCH_SESSION_ID" ] || curl -sf --max-time 3 -X POST "$PERCH_HOOK_URL" ' +
  '-H "content-type: application/json" -H "x-perch-observe-only: 1" -H "x-perch-session: $PERCH_SESSION_ID" ' +
  '-H "x-perch-token: $PERCH_HOOK_TOKEN" --data-binary @- >/dev/null 2>&1; exit 0';

// Claude blocking interactions use synchronous command hooks. Claude's documented
// command-hook window is ten minutes; the server owns a shorter internal
// deadline and returns either the exact allow/deny JSON or an empty body. An
// empty/error response exits 0 so Claude visibly opens its native dialog.
// Other Claude events and every Codex hook keep their existing behavior.
const CLAUDE_PERMISSION_HOOK_COMMAND =
  'if [ -z "$PERCH_SESSION_ID" ]; then exit 0; fi; ' +
  'response="$(curl -sf --max-time 570 -X POST "$PERCH_HOOK_URL" ' +
  '-H "content-type: application/json" -H "x-perch-session: $PERCH_SESSION_ID" ' +
  '-H "x-perch-token: $PERCH_HOOK_TOKEN" --data-binary @- 2>/dev/null)" || { ' +
  'printf "%s\\n" "Perch remote approval unavailable; use Claude native dialog." >&2; exit 0; }; ' +
  'if [ -z "$response" ]; then printf "%s\\n" "Perch remote approval expired; use Claude native dialog." >&2; exit 0; fi; ' +
  'printf "%s" "$response"; exit 0';

const CLAUDE_QUESTION_HOOK_COMMAND =
  'if [ -z "$PERCH_SESSION_ID" ]; then exit 0; fi; ' +
  'response="$(curl -sf --max-time 570 -X POST "$PERCH_HOOK_URL" ' +
  '-H "content-type: application/json" -H "x-perch-session: $PERCH_SESSION_ID" ' +
  '-H "x-perch-token: $PERCH_HOOK_TOKEN" --data-binary @- 2>/dev/null)" || { ' +
  'printf "%s\\n" "Perch remote question unavailable; use Claude native question UI." >&2; exit 0; }; ' +
  'if [ -z "$response" ]; then printf "%s\\n" "Perch remote question expired; use Claude native question UI." >&2; exit 0; fi; ' +
  'printf "%s" "$response"; exit 0';

const CLAUDE_PLAN_HOOK_COMMAND = CLAUDE_QUESTION_HOOK_COMMAND.replaceAll("question", "plan decision");
const CLAUDE_ELICITATION_HOOK_COMMAND = CLAUDE_QUESTION_HOOK_COMMAND.replaceAll("question", "MCP interaction");

// The capability note delivered to every solo perch session (mate and crew get
// richer chart briefings elsewhere): Claude receives it as SessionStart
// additionalContext through the hook above; codex reads it from the perch-
// managed block in ~/.codex/AGENTS.md. Lives server-side so it versions with
// the server, and points at the served authoring guide - external users have
// no perch repo checkout to read.
export const CHART_CAPABILITY_NOTE = [
  "You are running under perch: the boss watches and steers this session from a phone or another desktop.",
  "When a deliverable is easier reviewed visually than as prose - a plan, a comparison, findings - you can draw a chart: one HTML file the boss reviews and annotates on phone or desktop.",
  "FIRST fetch the authoring guide and follow it strictly (every chart renders in the one fixed perch look via chart.css and its documented classes - no <style> blocks, no style= attributes):",
  '  curl -sf "${PERCH_HOOK_URL%/hooks}/charts/authoring"',
  "Write the file to .charts/<slug>.html in your workspace (scratch, keep it out of commits), then register it once:",
  '  curl -sf -X POST "${PERCH_HOOK_URL%/hooks}/charts" \\',
  '    -H "x-perch-session: $PERCH_SESSION_ID" -H "x-perch-token: $PERCH_HOOK_TOKEN" \\',
  "    -H \"content-type: application/json\" -d '{\"file\":\"<absolute path to the .html file>\"}'",
  "Registration notifies the boss; edits to the file refresh an open review live; boss feedback arrives in this session as a [perch chart] block."
].join("\n");

// Hook events perch listens to. PreToolUse doubles as a cheap "running"
// heartbeat during long turns. Keep this list to events Claude actually
// supports: unknown names make the TUI show a settings warning at startup
// (verified against Claude Code 2.1.198).
const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Elicitation",
  "ElicitationResult",
  "Notification",
  "Stop",
  "SessionEnd"
] as const;

type HookEntry = {
  matcher?: string;
  hooks: Array<{ type: "command"; command: string; timeout?: number }>;
};

type ClaudeSettings = {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
};

export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(configDir, "settings.json");
}

// Hook payloads come from processes inside the agent's PTY, so a
// transcript_path is only honored when it points inside a known agent
// transcript directory (Claude projects, codex sessions) - anything else
// could stream arbitrary readable files to phones.
export function isAllowedTranscriptPath(path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const configDir = env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const roots = [resolve(configDir, "projects"), resolve(codexHome(env), "sessions")];
  const resolved = realpathDeepestExisting(resolve(path));
  if (resolved === null) {
    return false;
  }
  return roots.some((root) => {
    const realRoot = realpathDeepestExisting(root);
    return realRoot !== null && resolved.startsWith(`${realRoot}${sep}`);
  });
}

// Symlink-safe resolution for paths that may not exist yet: realpath the
// deepest existing ancestor, then rejoin the not-yet-created tail. Existence
// is lstat-based so a dangling symlink counts as existing - existsSync would
// peel it into the tail and rejoin its NAME under the resolved root, letting
// a link to a not-yet-created outside target pass containment. Returns null
// when the deepest existing entry cannot be resolved (dangling link): a path
// whose real target is unknowable must never pass a containment check.
function realpathDeepestExisting(path: string): string | null {
  let existing = path;
  const tail: string[] = [];
  while (!lexicallyExists(existing)) {
    const parent = dirname(existing);
    if (parent === existing) {
      break;
    }
    tail.unshift(basename(existing));
    existing = parent;
  }
  try {
    return join(realpathSync(existing), ...tail);
  } catch {
    return null;
  }
}

function lexicallyExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.perch-tmp`;
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : undefined;
  writeFileSync(tmp, content);
  if (mode !== undefined) {
    chmodSync(tmp, mode);
  }
  renameSync(tmp, path);
}

// Marker-based and idempotent: reruns update perch's own entries in place and
// never touch user hooks. Failures are logged by the caller and ignored -
// hook installation must never block server startup.
export function installClaudeHooks(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = claudeSettingsPath(env);

  let settings: ClaudeSettings = {};
  if (existsSync(path)) {
    try {
      settings = JSON.parse(readFileSync(path, "utf8")) as ClaudeSettings;
    } catch {
      // Unparseable settings: leave the user's file alone.
      return false;
    }
  }

  const hooks: Record<string, HookEntry[]> = { ...(settings.hooks ?? {}) };
  let changed = false;

  // Strip perch entries from events we no longer install (e.g. names dropped
  // because Claude rejected them); user entries always survive.
  const wanted = new Set<string>(CLAUDE_HOOK_EVENTS);
  for (const [event, entries] of Object.entries(hooks)) {
    if (wanted.has(event)) {
      continue;
    }
    const withoutPerch = entries.filter((entry) => !isPerchEntry(entry));
    if (withoutPerch.length !== entries.length) {
      changed = true;
      if (withoutPerch.length > 0) {
        hooks[event] = withoutPerch;
      } else {
        delete hooks[event];
      }
    }
  }

  for (const event of CLAUDE_HOOK_EVENTS) {
    const entries = [...(hooks[event] ?? [])];
    const withoutPerch = entries.filter((entry) => !isPerchEntry(entry));
    // Replacing marker-matched entries also UPGRADES an older installed perch
    // command in place (e.g. SessionStart gaining the echo variant).
    const command =
      event === "PermissionRequest"
        ? CLAUDE_PERMISSION_HOOK_COMMAND
        : event === "Elicitation" || event === "ElicitationResult"
          ? CLAUDE_ELICITATION_HOOK_COMMAND
        : event === "PreToolUse"
          ? CLAUDE_QUESTION_HOOK_COMMAND
        : event === "SessionStart"
        ? HOOK_COMMAND_SESSION_START
        : event === "Stop"
          ? HOOK_COMMAND_STOP
          : HOOK_COMMAND;
    const synchronous = event === "PermissionRequest" || event === "PreToolUse" || event === "Elicitation" || event === "ElicitationResult";
    const perchEntries: HookEntry[] = event === "PreToolUse"
      ? [
          { hooks: [{ type: "command", command: CLAUDE_PRETOOL_OBSERVER_COMMAND, timeout: 10 }] },
          { matcher: ASK_USER_QUESTION_TOOL, hooks: [{ type: "command", command, timeout: 600 }] },
          { matcher: "ExitPlanMode", hooks: [{ type: "command", command: CLAUDE_PLAN_HOOK_COMMAND, timeout: 600 }] }
        ]
      : [{ hooks: [{ type: "command", command, timeout: synchronous ? 600 : 10 }] }];
    const next = [...withoutPerch, ...perchEntries];
    if (JSON.stringify(next) !== JSON.stringify(entries)) {
      changed = true;
    }
    hooks[event] = next;
  }

  if (!changed) {
    return true;
  }

  mkdirSync(join(path, ".."), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`);
  return true;
}

function isPerchEntry(entry: HookEntry): boolean {
  return entry.hooks?.some((hook) => hook.command?.includes(HOOK_MARKER)) ?? false;
}

// --- Codex hooks ------------------------------------------------------------
// Codex (>= 0.142) supports a Claude-compatible hooks.json plus a trust model:
// each hook's identity hash must appear as trusted_hash under [hooks.state] in
// config.toml or the TUI prompts the user. The hash formula was verified
// against codex-rs (config/src/fingerprint.rs): sha256 over the key-sorted
// compact JSON of {event_name: <snake label>, hooks: [normalized handler]}.

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME ?? join(homedir(), ".codex");
}

const CODEX_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "Stop"] as const;

const CODEX_EVENT_LABELS: Record<string, string> = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  PreToolUse: "pre_tool_use",
  PermissionRequest: "permission_request",
  Stop: "stop"
};

const CODEX_HOOK_TIMEOUT_SEC = 10;
const CODEX_TRUST_BEGIN = "# perch-codex-trust begin";
const CODEX_TRUST_END = "# perch-codex-trust end";
const CODEX_AGENTS_BEGIN = "<!-- perch begin -->";
const CODEX_AGENTS_END = "<!-- perch end -->";

export function codexHookHash(eventLabel: string, command: string, timeoutSec: number): string {
  // Mirrors NormalizedHookIdentity -> canonical JSON -> sha256. matcher and
  // None-valued handler fields are omitted by the TOML round-trip; async
  // defaults to false and is always present.
  const identity = {
    event_name: eventLabel,
    hooks: [{ async: false, command, timeout: Math.max(1, timeoutSec), type: "command" }]
  };
  const canonical = JSON.stringify(sortKeysDeep(identity));
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeysDeep(v)]));
  }
  return value;
}

// Installs perch entries into ~/.codex/hooks.json and persists their trust
// hashes into config.toml so the codex TUI never prompts. Marker-based and
// idempotent like the Claude installer; returns false (and is logged by the
// caller) when config.toml cannot be edited safely.
export function installCodexHooks(env: NodeJS.ProcessEnv = process.env): boolean {
  const home = codexHome(env);
  if (!existsSync(home)) {
    // No codex on this machine; nothing to do.
    return true;
  }

  const hooksPath = join(home, "hooks.json");
  let file: { hooks?: Record<string, HookEntry[]>; [key: string]: unknown } = {};
  if (existsSync(hooksPath)) {
    try {
      file = JSON.parse(readFileSync(hooksPath, "utf8"));
    } catch {
      return false;
    }
  }

  const hooks: Record<string, HookEntry[]> = { ...(file.hooks ?? {}) };
  let changed = false;
  for (const event of CODEX_HOOK_EVENTS) {
    const entries = [...(hooks[event] ?? [])];
    const withoutPerch = entries.filter((entry) => !isPerchEntry(entry));
    // Codex hooks keep discarding output (including the SessionStart response
    // body meant for Claude); codex gets the capability note through the
    // perch-managed ~/.codex/AGENTS.md block instead.
    const perchEntry: HookEntry = {
      hooks: [{ type: "command", command: HOOK_COMMAND, timeout: CODEX_HOOK_TIMEOUT_SEC }]
    };
    const next = [...withoutPerch, perchEntry];
    if (JSON.stringify(next) !== JSON.stringify(entries)) {
      changed = true;
    }
    hooks[event] = next;
  }

  if (changed) {
    writeFileAtomic(hooksPath, `${JSON.stringify({ ...file, hooks }, null, 2)}\n`);
  }

  // Refresh the instructions block alongside the hooks: best-effort (a failed
  // note write must never block hook installation or trust persistence).
  writeCodexAgentsNote(home);

  return writeCodexTrust(home, hooksPath, hooks);
}

// Maintains the perch-managed block in ~/.codex/AGENTS.md - codex prepends
// that file to any project AGENTS.md, so this is how solo codex sessions learn
// the chart capability. Marker-based like the trust block: replace only
// between the markers, never touch user text outside them, create the file if
// absent. No trust hash needed (instructions, not a hook). The block's first
// line self-gates on PERCH_SESSION_ID so it is inert outside perch terminals.
function writeCodexAgentsNote(home: string): void {
  const path = join(home, "AGENTS.md");
  let current = "";
  if (existsSync(path)) {
    try {
      current = readFileSync(path, "utf8");
    } catch {
      return;
    }
  }

  const block = [
    CODEX_AGENTS_BEGIN,
    "This perch-managed block applies ONLY when PERCH_SESSION_ID is set in your environment; if it is not set, ignore everything up to the perch end marker.",
    CHART_CAPABILITY_NOTE,
    CODEX_AGENTS_END
  ].join("\n");

  let next: string;
  const begin = current.indexOf(CODEX_AGENTS_BEGIN);
  const end = begin >= 0 ? current.indexOf(CODEX_AGENTS_END, begin + CODEX_AGENTS_BEGIN.length) : -1;
  if (begin >= 0 && end >= 0) {
    next = current.slice(0, begin) + block + current.slice(end + CODEX_AGENTS_END.length);
  } else if (begin >= 0) {
    // Best-effort: an orphaned begin marker means appending a second block could
    // make a later run replace user text between the old begin and new end.
    return;
  } else if (current.length > 0) {
    next = `${current.replace(/\n*$/, "\n\n")}${block}\n`;
  } else {
    next = `${block}\n`;
  }

  if (next !== current) {
    try {
      writeFileAtomic(path, next);
    } catch {
      // AGENTS.md is advisory. Hook installation and trust persistence must
      // continue even if this write fails.
    }
  }
}

// Rewrites the perch-managed trust block in config.toml. Trust keys embed the
// entry's index within its event array, so this must run after every
// hooks.json edit (ours or the user's); the server does so at each boot.
function writeCodexTrust(
  home: string,
  hooksPath: string,
  hooks: Record<string, HookEntry[]>
): boolean {
  const configPath = join(home, "config.toml");
  let config = "";
  if (existsSync(configPath)) {
    try {
      config = readFileSync(configPath, "utf8");
    } catch {
      return false;
    }
  }

  const lines: string[] = [CODEX_TRUST_BEGIN];
  for (const event of CODEX_HOOK_EVENTS) {
    const entries = hooks[event] ?? [];
    const groupIndex = entries.findIndex((entry) => isPerchEntry(entry));
    if (groupIndex < 0) {
      continue;
    }
    const label = CODEX_EVENT_LABELS[event];
    const hash = codexHookHash(label, HOOK_COMMAND, CODEX_HOOK_TIMEOUT_SEC);
    lines.push(`[hooks.state."${hooksPath}:${label}:${groupIndex}:0"]`);
    lines.push(`trusted_hash = "${hash}"`);
  }
  lines.push(CODEX_TRUST_END);
  const block = lines.join("\n");

  let next: string;
  const begin = config.indexOf(CODEX_TRUST_BEGIN);
  const end = config.indexOf(CODEX_TRUST_END);
  if (begin >= 0 && end > begin) {
    next = config.slice(0, begin) + block + config.slice(end + CODEX_TRUST_END.length);
  } else {
    // Appending [hooks.state."..."] table headers at EOF is always valid TOML.
    next = `${config.replace(/\n*$/, "\n\n")}${block}\n`;
  }

  // Hooks must also be feature-enabled. Only ever ADD the flag; if the user
  // set hooks = false we respect it and report failure so the caller logs.
  if (!/^\s*hooks\s*=\s*true\b/m.test(next)) {
    if (/^\s*hooks\s*=\s*false\b/m.test(next)) {
      return false;
    }
    // Insert the flag into an existing [features] table (tolerating trailing
    // comments and whitespace variants) rather than ever defining the table a
    // second time - TOML forbids that and codex would fail to parse config.toml.
    const featuresHeader = /^[ \t]*\[[ \t]*features[ \t]*\][^\n]*$/m;
    const anyFeaturesTable = /^[ \t]*\[[ \t]*["']?[ \t]*features[ \t]*["']?[ \t]*\][^\n]*$/m;
    if (featuresHeader.test(next)) {
      next = next.replace(featuresHeader, (header) => `${header}\nhooks = true # perch-codex`);
    } else if (anyFeaturesTable.test(next)) {
      return false;
    } else {
      next = `${next.replace(/\n*$/, "\n\n")}[features] # perch-codex\nhooks = true\n`;
    }
  }

  if (next !== config) {
    writeFileAtomic(configPath, next);
  }
  return true;
}

// Locates the rollout transcript for a codex session id. The filename embeds
// the id (rollout-<timestamp>-<session_id>.jsonl) under date-sharded dirs, so
// this scans the most recent date directories only.
export function findCodexRollout(
  codexSessionId: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const root = join(codexHome(env), "sessions");
  const suffix = `-${codexSessionId}.jsonl`;
  const days: string[] = [];
  for (let offset = -1; offset <= 2; offset += 1) {
    const d = new Date(Date.now() - offset * 86_400_000);
    days.push(
      join(
        root,
        String(d.getFullYear()),
        String(d.getMonth() + 1).padStart(2, "0"),
        String(d.getDate()).padStart(2, "0")
      )
    );
  }
  for (const dir of days) {
    try {
      for (const name of readdirSync(dir)) {
        if (name.startsWith("rollout-") && name.endsWith(suffix)) {
          return join(dir, name);
        }
      }
    } catch {
      // Date dir absent; keep looking.
    }
  }
  return undefined;
}

// Maps perch PTY sessions to their hook tokens and, once SessionStart
// arrives, to the agent's own session id + transcript path.
export type HookCorrelation = {
  sessionId: string;
  agentSessionId?: string;
  transcriptPath?: string;
};

export class HookRegistry {
  private readonly tokens = new Map<string, string>(); // token -> perch session id
  private readonly correlations = new Map<string, HookCorrelation>();
  private readonly durablePath?: string;

  constructor(env?: NodeJS.ProcessEnv) {
    if (!env) return;
    const root = env.PERCH_HOME ?? join(homedir(), ".perch");
    this.durablePath = join(root, "hook-auth.json");
    try {
      const stored = JSON.parse(readFileSync(this.durablePath, "utf8")) as { version?: number; sessions?: Record<string, string> };
      if (stored.version === 1 && stored.sessions) {
        for (const [sessionId, token] of Object.entries(stored.sessions)) {
          if (sessionId && /^[a-f0-9]{32}$/.test(token)) this.tokens.set(token, sessionId);
        }
      }
    } catch {
      // First startup or corrupt legacy state. Fresh registrations replace it.
    }
  }

  // Deliberate credential rotation: mints a fresh token and revokes any prior
  // token for the session. Launch paths must use ensure() instead - a codex
  // `--remote` launch registers the same session twice (daemon env, then PTY
  // env), and re-minting here silently invalidated the daemon's copy.
  register(sessionId: string): { token: string } {
    for (const [token, registered] of this.tokens) {
      if (registered === sessionId) this.tokens.delete(token);
    }
    const token = randomBytes(16).toString("hex");
    this.tokens.set(token, sessionId);
    this.correlations.set(sessionId, { sessionId });
    this.persist();
    return { token };
  }

  // Idempotent registration: returns the session's live token when one exists,
  // minting only for a new session. Every registration path for the same live
  // session (codex daemon env + PTY env) shares one credential this way.
  ensure(sessionId: string): { token: string } {
    for (const [token, registered] of this.tokens) {
      if (registered === sessionId) {
        if (!this.correlations.has(sessionId)) this.correlations.set(sessionId, { sessionId });
        return { token };
      }
    }
    return this.register(sessionId);
  }

  unregister(sessionId: string): void {
    for (const [token, id] of this.tokens) {
      if (id === sessionId) {
        this.tokens.delete(token);
      }
    }
    this.correlations.delete(sessionId);
    this.persist();
  }

  prune(activeSessionIds: Set<string>): void {
    let changed = false;
    for (const [token, sessionId] of this.tokens) {
      if (!activeSessionIds.has(sessionId)) {
        this.tokens.delete(token);
        this.correlations.delete(sessionId);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  verify(sessionId: string, token: string): boolean {
    return this.tokens.get(token) === sessionId;
  }

  correlate(sessionId: string, agentSessionId?: string, transcriptPath?: string): HookCorrelation {
    const existing = this.correlations.get(sessionId) ?? { sessionId };
    const next: HookCorrelation = {
      sessionId,
      agentSessionId: agentSessionId ?? existing.agentSessionId,
      transcriptPath: transcriptPath ?? existing.transcriptPath
    };
    this.correlations.set(sessionId, next);
    return next;
  }

  correlation(sessionId: string): HookCorrelation | undefined {
    return this.correlations.get(sessionId);
  }

  private persist(): void {
    if (!this.durablePath) return;
    mkdirSync(dirname(this.durablePath), { recursive: true });
    const sessions = Object.fromEntries([...this.tokens].map(([token, sessionId]) => [sessionId, token]));
    const tmp = `${this.durablePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.durablePath);
  }
}

export type HookEventPayload = {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  message?: string;
  prompt?: string;
  // Codex wire shape: the event name and its fields arrive nested under
  // hook_event.event_type (snake_case) instead of hook_event_name.
  hook_event?: { event_type?: string; [key: string]: unknown };
  [key: string]: unknown;
};

// True when the payload uses codex's nested hook_event envelope.
export function isCodexHookPayload(payload: HookEventPayload): boolean {
  return typeof payload.hook_event?.event_type === "string";
}

// Resolves the event name across both wire shapes, normalized to PascalCase.
export function hookEventName(payload: HookEventPayload): string {
  if (typeof payload.hook_event_name === "string") {
    return payload.hook_event_name;
  }
  const snake = payload.hook_event?.event_type;
  if (typeof snake !== "string") {
    return "";
  }
  return snake
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export type NormalizedHookEvent = {
  status?: AgentSessionStatus;
  approval?: {
    id: string;
    summary: string;
    command?: string;
  };
  question?: {
    id: string;
    questions: QuestionItem[];
  };
  correlation?: {
    agentSessionId?: string;
    transcriptPath?: string;
  };
};

// Agent-agnostic normalization: hook events become status transitions plus an
// optional approval or question payload. Unknown events are ignored (fail-open).
export function normalizeHookEvent(payload: HookEventPayload): NormalizedHookEvent {
  const event = hookEventName(payload);
  const correlation = {
    agentSessionId: typeof payload.session_id === "string" ? payload.session_id : undefined,
    transcriptPath: typeof payload.transcript_path === "string" ? payload.transcript_path : undefined
  };

  // AskUserQuestion is an interactive selection, not a permission.
  // The official AskUserQuestion path is its narrow PreToolUse matcher.
  // PermissionRequest remains a separate allow/deny interaction.
  // instead of a bare "running" line or a misleading allow/deny approval.
  if (
    event === "PreToolUse" &&
    payload.tool_name === ASK_USER_QUESTION_TOOL
  ) {
    const questions = extractQuestions(payload.tool_input);
    if (questions) {
      return {
        status: "needs_approval",
        question: { id: questionId(questions), questions },
        correlation
      };
    }
  }

  switch (event) {
    case "SessionStart":
      return { status: "idle", correlation };
    case "UserPromptSubmit":
    case "PreToolUse":
      return { status: "running", correlation };
    case "Stop":
    case "SessionEnd":
      return { status: "idle", correlation };
    case "PermissionRequest": {
      const summary = permissionSummary(payload);
      return {
        status: "needs_approval",
        approval: {
          id: `${event}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
          summary: summary.summary,
          command: summary.command
        },
        correlation
      };
    }
    case "Notification": {
      const message = typeof payload.message === "string" ? payload.message : "";
      // Notifications are reference-only. They never create decision authority.
      // "Waiting for your input" is the opposite of blocked: the composer is
      // exactly what the agent wants. Treating it as an approval would queue
      // every subsequent message forever (found the hard way in E2E).
      if (/waiting for (your )?input|idle/i.test(message)) {
        return { status: "waiting", correlation };
      }
      return { correlation };
    }
    default:
      return { correlation };
  }
}

function permissionSummary(payload: HookEventPayload): { summary: string; command?: string } {
  // Codex nests the event fields under hook_event; Claude keeps them flat.
  const source: Record<string, unknown> = isCodexHookPayload(payload)
    ? (payload.hook_event as Record<string, unknown>)
    : payload;
  const tool = typeof source.tool_name === "string" ? source.tool_name : "action";
  const input = source.tool_input ?? source.command ?? source.input;
  let command: string | undefined;
  if (typeof input === "string") {
    command = input.slice(0, 400);
  } else if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    command =
      typeof record.command === "string"
        ? record.command
        : JSON.stringify(record).slice(0, 400);
  }
  return { summary: `${tool} wants to run`, command };
}
