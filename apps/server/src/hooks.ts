import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { AgentSessionStatus, QuestionItem } from "@perch/shared";
import { ASK_USER_QUESTION_TOOL, extractQuestions, questionId } from "./askQuestion.js";

// Perch recovers agent structure without owning provider SDKs: every managed
// provider process carries PERCH_SESSION_ID / PERCH_HOOK_URL /
// PERCH_HOOK_TOKEN in its environment, and a globally-installed Claude hook
// (gated on that env, inert everywhere else) POSTs each hook event back to
// the local server. Fail-open by design: a dead server must never break the
// user's Claude session.

const HOOK_MARKER = "$PERCH_HOOK_URL";
const HOOK_SHIM_NAME = "perch-hook";
const HOOK_SHIM_MARKER = "/.perch/bin/perch-hook";
const HOOK_OWNERSHIP_MARKER = "# perch-managed-hook";
// One command serves every event: the payload on stdin carries
// hook_event_name. Gated on PERCH_SESSION_ID so it is a no-op outside perch
// terminals, capped at 3s, and always exits 0.
const HOOK_COMMAND = (
  '[ -z "$PERCH_SESSION_ID" ] || curl -sf --max-time 3 -X POST "$PERCH_HOOK_URL" ' +
  '-H "content-type: application/json" -H "x-perch-session: $PERCH_SESSION_ID" ' +
  '-H "x-perch-token: $PERCH_HOOK_TOKEN" --data-binary @- >/dev/null 2>&1; exit 0'
) + ` ${HOOK_OWNERSHIP_MARKER}`;
export function perchHookPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.PERCH_HOME ?? join(homedir(), ".perch");
  return join(home, "bin", HOOK_SHIM_NAME);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function perchHookShimContent(): string {
  return `#!/bin/sh
event="$1"
[ -n "$PERCH_SESSION_ID" ] || exit 0

post_telemetry() {
  curl -sf --max-time 3 -X POST "$PERCH_HOOK_URL" \\
    -H "content-type: application/json" \\
    -H "x-perch-session: $PERCH_SESSION_ID" \\
    -H "x-perch-token: $PERCH_HOOK_TOKEN" \\
    --data-binary @- >/dev/null 2>&1
  exit 0
}

post_echo() {
  curl -sf --max-time 3 -X POST "$PERCH_HOOK_URL" \\
    -H "content-type: application/json" \\
    -H "x-perch-session: $PERCH_SESSION_ID" \\
    -H "x-perch-token: $PERCH_HOOK_TOKEN" \\
    --data-binary @- 2>/dev/null
  exit 0
}

post_observer() {
  curl -sf --max-time 3 -X POST "$PERCH_HOOK_URL" \\
    -H "content-type: application/json" \\
    -H "x-perch-observe-only: 1" \\
    -H "x-perch-session: $PERCH_SESSION_ID" \\
    -H "x-perch-token: $PERCH_HOOK_TOKEN" \\
    --data-binary @- >/dev/null 2>&1
  exit 0
}

post_blocking() {
  unavailable="$1"
  expired="$2"
  response="$(curl -sf --max-time 570 -X POST "$PERCH_HOOK_URL" \\
    -H "content-type: application/json" \\
    -H "x-perch-session: $PERCH_SESSION_ID" \\
    -H "x-perch-token: $PERCH_HOOK_TOKEN" \\
    --data-binary @- 2>/dev/null)" || {
      printf "%s\\n" "$unavailable" >&2
      exit 0
    }
  if [ -z "$response" ]; then
    printf "%s\\n" "$expired" >&2
    exit 0
  fi
  printf "%s" "$response"
  exit 0
}

case "$event" in
  session-start|stop)
    post_echo
    ;;
  pre-tool-observer)
    post_observer
    ;;
  permission-request)
    post_blocking \
      "Perch remote approval unavailable; use Claude native dialog." \
      "Perch remote approval expired; use Claude native dialog."
    ;;
  question)
    post_blocking \
      "Perch remote question unavailable; use Claude native question UI." \
      "Perch remote question expired; use Claude native question UI."
    ;;
  plan-decision)
    post_blocking \
      "Perch remote plan decision unavailable; use Claude native plan decision UI." \
      "Perch remote plan decision expired; use Claude native plan decision UI."
    ;;
  elicitation|elicitation-result)
    post_blocking \
      "Perch remote MCP interaction unavailable; use Claude native MCP interaction UI." \
      "Perch remote MCP interaction expired; use Claude native MCP interaction UI."
    ;;
  user-prompt-submit|post-tool-use|post-tool-use-failure|permission-denied|notification|session-end)
    post_telemetry
    ;;
  *)
    exit 0
    ;;
esac
`;
}

function installPerchHookShim(env: NodeJS.ProcessEnv): void {
  const path = perchHookPath(env);
  const content = perchHookShimContent();
  if (existsSync(path) && readFileSync(path, "utf8") === content) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, content, 0o700);
}

// The capability note delivered to every perch session that needs it: Claude
// receives it as SessionStart additionalContext through the hook above; codex
// receives it the same way in solo sessions and keeps it in task-worker briefs.
// Lives server-side so it versions with the server, and points at the served
// authoring guide - external users have no perch repo checkout to read.
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

function writeFileAtomic(path: string, content: string, defaultMode?: number): void {
  const tmp = `${path}.perch-tmp`;
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : defaultMode;
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

  installPerchHookShim(env);

  const hooks: Record<string, HookEntry[]> = { ...(settings.hooks ?? {}) };
  let changed = false;

  // Strip perch entries from events we no longer install (e.g. names dropped
  // because Claude rejected them); user entries always survive.
  const wanted = new Set<string>(CLAUDE_HOOK_EVENTS);
  for (const [event, entries] of Object.entries(hooks)) {
    if (wanted.has(event)) {
      continue;
    }
    const withoutPerch = entries.filter((entry) => !isInstallReplaceablePerchEntry(entry, env));
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
    const withoutPerch = entries.filter((entry) => !isInstallReplaceablePerchEntry(entry, env));
    // Replacing marker-matched entries also UPGRADES an older installed perch
    // command in place (e.g. SessionStart gaining the echo variant).
    const shim = shellQuote(perchHookPath(env));
    const eventArgument = event.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    const command = `${shim} ${eventArgument} ${HOOK_OWNERSHIP_MARKER}`;
    const synchronous = event === "PermissionRequest" || event === "PreToolUse" || event === "Elicitation" || event === "ElicitationResult";
    const perchEntries: HookEntry[] = event === "PreToolUse"
      ? [
          { hooks: [{ type: "command", command: `${shim} pre-tool-observer ${HOOK_OWNERSHIP_MARKER}`, timeout: 10 }] },
          { matcher: ASK_USER_QUESTION_TOOL, hooks: [{ type: "command", command: `${shim} question ${HOOK_OWNERSHIP_MARKER}`, timeout: 600 }] },
          { matcher: "ExitPlanMode", hooks: [{ type: "command", command: `${shim} plan-decision ${HOOK_OWNERSHIP_MARKER}`, timeout: 600 }] }
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

function perchHookTarget(command: string): string | undefined {
  const quoted = command.match(/^'((?:[^']|'"'"')*)'\s/);
  if (quoted?.[1]) {
    const target = quoted[1].replaceAll(`'"'"'`, "'");
    return target.endsWith(`/${HOOK_SHIM_NAME}`) ? target : undefined;
  }
  const bare = command.match(/^(\/\S*\/perch-hook)(?:\s|$)/);
  return bare?.[1];
}

function isEphemeralHookTarget(path: string): boolean {
  if (/\/(?:\.perch|\.perch-dev)\/bin\/perch-hook$/.test(path)) {
    return false;
  }
  return /^\/(?:private\/)?tmp\//.test(path) ||
    /^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T\//.test(path);
}

function isStaleLegacyPerchEntry(entry: HookEntry): boolean {
  return entry.hooks?.some((hook) => {
    const target = perchHookTarget(hook.command ?? "");
    return target !== undefined && (isEphemeralHookTarget(target) || !existsSync(target));
  }) ?? false;
}

function isCurrentPerchEntry(entry: HookEntry, env: NodeJS.ProcessEnv = process.env): boolean {
  const shimPath = perchHookPath(env);
  return entry.hooks?.some((hook) =>
    hook.command?.includes(HOOK_MARKER) || perchHookTarget(hook.command ?? "") === shimPath
  ) ?? false;
}

function isInstallReplaceablePerchEntry(entry: HookEntry, env: NodeJS.ProcessEnv): boolean {
  return isCurrentPerchEntry(entry, env) || isStaleLegacyPerchEntry(entry);
}

function isPerchEntry(entry: HookEntry, env: NodeJS.ProcessEnv = process.env): boolean {
  return entry.hooks?.some((hook) =>
    hook.command?.includes(HOOK_OWNERSHIP_MARKER) ||
    hook.command?.includes(HOOK_MARKER) ||
    hook.command?.includes(perchHookPath(env)) ||
    hook.command?.includes(HOOK_SHIM_MARKER)
  ) ?? false;
}

export type UninstallChange = {
  path: string;
  before: string | null;
  after: string | null;
};

function readJsonConfig(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`refusing to uninstall: ${path} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`refusing to uninstall: ${path} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function withoutPerchHooks(
  file: Record<string, unknown>,
  path: string,
  env: NodeJS.ProcessEnv
): Record<string, unknown> {
  if (file.hooks === undefined) {
    return file;
  }
  if (!file.hooks || typeof file.hooks !== "object" || Array.isArray(file.hooks)) {
    throw new Error(`refusing to uninstall: ${path} has an invalid hooks object`);
  }
  const hooks = { ...(file.hooks as Record<string, unknown>) };
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) {
      throw new Error(`refusing to uninstall: ${path} has invalid hook entries for ${event}`);
    }
    const entries = value as HookEntry[];
    const remaining = entries.filter((entry) => !isPerchEntry(entry, env));
    if (remaining.length > 0) {
      hooks[event] = remaining;
    } else {
      delete hooks[event];
    }
  }
  const next = { ...file };
  if (Object.keys(hooks).length > 0) {
    next.hooks = hooks;
  } else {
    delete next.hooks;
  }
  return next;
}

function removeMarkedBlock(content: string, beginMarker: string, endMarker: string): string {
  let next = content;
  while (true) {
    const begin = next.indexOf(beginMarker);
    if (begin < 0) {
      return next;
    }
    const end = next.indexOf(endMarker, begin + beginMarker.length);
    if (end < 0) {
      return next;
    }
    let prefix = next.slice(0, begin);
    let suffix = next.slice(end + endMarker.length);
    if (prefix.endsWith("\n\n")) {
      prefix = prefix.slice(0, -1);
    }
    if (suffix.startsWith("\n")) {
      suffix = suffix.slice(1);
    }
    next = prefix + suffix;
  }
}

function removeCodexAgentsBlocks(content: string): string {
  let next = content;
  let begin = next.indexOf(CODEX_AGENTS_BEGIN);
  while (begin >= 0) {
    const end = next.indexOf(CODEX_AGENTS_END, begin + CODEX_AGENTS_BEGIN.length);
    if (end < 0) {
      break;
    }
    next = next.slice(0, begin) + next.slice(end + CODEX_AGENTS_END.length);
    begin = next.indexOf(CODEX_AGENTS_BEGIN, begin);
  }
  return next;
}

function withoutCodexTrust(config: string): string {
  let next = removeMarkedBlock(config, CODEX_TRUST_BEGIN, CODEX_TRUST_END);
  next = next.replace(/(?:^|\n)\[features\] # perch-codex\nhooks = true(?:\n|$)/, (match) =>
    match.startsWith("\n") && match.endsWith("\n") ? "\n" : ""
  );
  next = next.replace(/^hooks = true # perch-codex\n/m, "");
  return next.trim().length === 0 ? "" : next;
}

function addTextChange(changes: UninstallChange[], path: string, after: string): void {
  const before = readFileSync(path, "utf8");
  if (before !== after) {
    changes.push({ path, before, after });
  }
}

export function planPerchUninstall(env: NodeJS.ProcessEnv = process.env): UninstallChange[] {
  const claudePath = claudeSettingsPath(env);
  const codexRoot = codexHome(env);
  const codexHooksPath = join(codexRoot, "hooks.json");

  // Parse and validate every JSON surface before planning any write so one bad
  // file makes the entire uninstall a no-op.
  const claude = readJsonConfig(claudePath);
  const codex = readJsonConfig(codexHooksPath);
  const claudeNext = claude ? withoutPerchHooks(claude, claudePath, env) : undefined;
  const codexNext = codex ? withoutPerchHooks(codex, codexHooksPath, env) : undefined;

  const changes: UninstallChange[] = [];
  if (claudeNext) {
    addTextChange(changes, claudePath, `${JSON.stringify(claudeNext, null, 2)}\n`);
  }
  if (codexNext) {
    addTextChange(changes, codexHooksPath, `${JSON.stringify(codexNext, null, 2)}\n`);
  }

  const configPath = join(codexRoot, "config.toml");
  if (existsSync(configPath)) {
    addTextChange(changes, configPath, withoutCodexTrust(readFileSync(configPath, "utf8")));
  }

  const agentsPath = join(codexRoot, "AGENTS.md");
  if (existsSync(agentsPath)) {
    addTextChange(
      changes,
      agentsPath,
      removeCodexAgentsBlocks(readFileSync(agentsPath, "utf8"))
    );
  }

  const shimPath = perchHookPath(env);
  if (existsSync(shimPath)) {
    changes.push({ path: shimPath, before: readFileSync(shimPath, "utf8"), after: null });
  }
  return changes;
}

function removeFileAtomic(path: string): void {
  const tmp = `${path}.perch-remove`;
  renameSync(path, tmp);
  rmSync(tmp, { force: true });
}

export function applyPerchUninstall(changes: UninstallChange[]): void {
  for (const change of changes) {
    if (change.after === null) {
      removeFileAtomic(change.path);
    } else {
      writeFileAtomic(change.path, change.after);
    }
  }
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

function codexHookCommand(event: (typeof CODEX_HOOK_EVENTS)[number], env: NodeJS.ProcessEnv): string {
  return event === "SessionStart"
    ? `${shellQuote(perchHookPath(env))} session-start ${HOOK_OWNERSHIP_MARKER}`
    : HOOK_COMMAND;
}

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

  installPerchHookShim(env);

  const hooks: Record<string, HookEntry[]> = { ...(file.hooks ?? {}) };
  let changed = false;
  const wanted = new Set<string>(CODEX_HOOK_EVENTS);
  for (const [event, entries] of Object.entries(hooks)) {
    if (wanted.has(event)) {
      continue;
    }
    const withoutPerch = entries.filter((entry) => !isInstallReplaceablePerchEntry(entry, env));
    if (withoutPerch.length !== entries.length) {
      changed = true;
      if (withoutPerch.length > 0) {
        hooks[event] = withoutPerch;
      } else {
        delete hooks[event];
      }
    }
  }
  for (const event of CODEX_HOOK_EVENTS) {
    const entries = [...(hooks[event] ?? [])];
    const withoutPerch = entries.filter((entry) => !isInstallReplaceablePerchEntry(entry, env));
    const command = codexHookCommand(event, env);
    const perchEntry: HookEntry = {
      hooks: [{ type: "command", command, timeout: CODEX_HOOK_TIMEOUT_SEC }]
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

  // Clean up the instructions block installed by older perch versions. This is
  // best-effort: a failed migration must never block hook installation or
  // trust persistence.
  removeCodexAgentsNote(home);

  return writeCodexTrust(home, hooksPath, hooks, env);
}

// Removes blocks installed by older perch versions from ~/.codex/AGENTS.md.
// Text outside complete marker pairs remains byte-identical. A file without a
// complete perch block is never written.
function removeCodexAgentsNote(home: string): void {
  const path = join(home, "AGENTS.md");
  if (!existsSync(path)) {
    return;
  }

  let current: string;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    return;
  }

  const next = removeCodexAgentsBlocks(current);

  if (next !== current) {
    try {
      writeFileAtomic(path, next);
    } catch {
      // Migration is advisory. Hook installation and trust persistence must
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
  hooks: Record<string, HookEntry[]>,
  env: NodeJS.ProcessEnv
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
    const groupIndex = entries.findIndex((entry) => isCurrentPerchEntry(entry, env));
    if (groupIndex < 0) {
      continue;
    }
    const label = CODEX_EVENT_LABELS[event];
    const command = codexHookCommand(event, env);
    const hash = codexHookHash(label, command, CODEX_HOOK_TIMEOUT_SEC);
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
    next = `${config.length > 0 ? config.replace(/\n*$/, "\n\n") : ""}${block}\n`;
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
      next = `${next.length > 0 ? next.replace(/\n*$/, "\n\n") : ""}[features] # perch-codex\nhooks = true\n`;
    }
  }

  if (next !== config) {
    writeFileAtomic(configPath, next);
  }
  return true;
}

// The transcript Claude Code will write for a session launched with
// `--session-id <uuid>` in `cwd`: <config>/projects/<munged cwd>/<uuid>.jsonl,
// where the project dir is the session's working directory with every
// non-alphanumeric byte replaced by "-". Claude munges its own process cwd,
// which the kernel resolves to the physical path, so symlinked launch dirs
// (e.g. /tmp on macOS) must be realpathed before munging. Knowing this path at
// launch is what makes timeline tailing hook-independent: the tailer polls for
// the file's creation and backfills it from the start, so attachment survives
// lost or uninstalled hooks entirely.
export function claudeTranscriptPath(
  cwd: string,
  claudeSessionId: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const configDir = env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  let physical: string;
  try {
    physical = realpathSync(resolve(cwd));
  } catch {
    physical = resolve(cwd);
  }
  return join(configDir, "projects", physical.replace(/[^a-zA-Z0-9]/g, "-"), `${claudeSessionId}.jsonl`);
}

// Maps Perch sessions to their hook tokens and, once SessionStart arrives, to
// the agent's own session id + transcript path.
export type HookCorrelation = {
  sessionId: string;
  agentSessionId?: string;
  transcriptPath?: string;
};

export class HookRegistry {
  private readonly tokens = new Map<string, string>(); // token -> perch session id
  private readonly correlations = new Map<string, HookCorrelation>();
  // A rebound codex daemon's environment still carries the previous server
  // life's PERCH_SESSION_ID/PERCH_HOOK_TOKEN (env is fixed at spawn), so the
  // recovery bind aliases that stale identity to the live session. The alias
  // lives only while the live session's registration does.
  private readonly aliases = new Map<string, string>(); // previous session id -> live session id
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
  // token for the session. Launch paths must use ensure() instead because
  // multiple setup paths can request credentials for the same live session.
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
  // minting only for a new session. Every setup path for the same live session
  // shares one credential this way.
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
    const revoked = new Set([sessionId]);
    this.aliases.delete(sessionId);
    for (const [previous, live] of this.aliases) {
      if (live === sessionId) {
        this.aliases.delete(previous);
        revoked.add(previous);
      }
    }
    for (const [token, id] of this.tokens) {
      if (revoked.has(id)) {
        this.tokens.delete(token);
      }
    }
    for (const id of revoked) this.correlations.delete(id);
    this.persist();
  }

  prune(activeSessionIds: Set<string>): void {
    let changed = false;
    for (const [previous, live] of this.aliases) {
      if (!activeSessionIds.has(live)) this.aliases.delete(previous);
    }
    for (const [token, sessionId] of this.tokens) {
      const live = this.aliases.get(sessionId) ?? sessionId;
      if (!activeSessionIds.has(sessionId) && !activeSessionIds.has(live)) {
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

  // Bind a previous life's session identity (still baked into a surviving
  // daemon's env) to the live session that adopted its daemon. Verification
  // stays against the previous id's own durable token; resolveAlias maps the
  // authenticated id to the live session for everything downstream.
  aliasSession(previousSessionId: string, liveSessionId: string): void {
    if (!previousSessionId || !liveSessionId || previousSessionId === liveSessionId) return;
    this.aliases.set(previousSessionId, liveSessionId);
  }

  resolveAlias(sessionId: string): string {
    return this.aliases.get(sessionId) ?? sessionId;
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
