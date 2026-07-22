import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  watch,
  type FSWatcher
} from "node:fs";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { CodexReasoningEffort, TimelineItem, TimelineItemKind, TimelineItemSource } from "@perch/shared";

// Structured timeline recovered by tailing the agent's own session file
// (Claude writes ~/.claude/projects/{cwd}/{session-id}.jsonl live during the
// session). The tailer is deliberately tolerant: unknown or malformed rows
// are skipped, never fatal - the raw terminal mirror is always the fallback.

const MAX_ITEMS_PER_SESSION = 2000;
const MAX_SEEN_IDS_PER_SESSION = MAX_ITEMS_PER_SESSION * 2;
const MAX_TEXT_LENGTH = 20_000;
const POLL_MS = 1000;
// How long a recorded injection stays eligible to claim a tailed user row.
// The transcript row lands within milliseconds-to-seconds of injection; a
// stale entry that never matched simply expires (and its turn defaults to
// human) rather than mislabeling a much later, unrelated turn.
const SOURCE_TTL_MS = 60_000;

export type TimelineListener = (item: TimelineItem) => void;

// Observed live model for a session, read off the transcript itself: claude
// stamps every assistant row with the model that produced it, which is the
// ground truth even for sessions launched with no explicit model (CLI default)
// and for `/model` switches typed into the desktop TUI that never cross the
// server. Fed into FleetMonitor.setSessionModel by the wiring in index.ts.
export type ModelListener = (sessionId: string, model: string) => void;

export type CodexThreadSettings = {
  model?: string;
  effort?: CodexReasoningEffort;
};

export type CodexThreadSettingsListener = (
  sessionId: string,
  threadId: string,
  settings: CodexThreadSettings
) => void;

const CODEX_REASONING_EFFORTS = new Set<CodexReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
]);

export function codexSessionMetaThreadId(row: Record<string, unknown>): string | undefined {
  if (row.type !== "session_meta") return undefined;
  const id = (row.payload as Record<string, unknown> | undefined)?.id;
  if (typeof id !== "string" || id.trim().length === 0) return undefined;
  return id.trim();
}

// Codex 0.144.4 writes effective per-thread runtime settings in two rollout
// shapes. Native TUI turns emit event_msg/thread_settings_applied, while turns
// submitted through the remote app-server can emit only turn_context. Keep
// model and reasoning effort independent so a partial or forward-compatible
// row never clears the other live field.
export function codexRowThreadSettings(row: Record<string, unknown>): CodexThreadSettings | undefined {
  const payload = row.payload as Record<string, unknown> | undefined;
  const raw =
    row.type === "event_msg" && payload?.type === "thread_settings_applied"
      ? (payload.thread_settings as Record<string, unknown> | undefined)
      : row.type === "turn_context"
        ? payload
        : undefined;
  if (!raw) return undefined;

  const model = typeof raw.model === "string" && raw.model.trim().length > 0 ? raw.model.trim() : undefined;
  const rawEffort = row.type === "turn_context" ? raw.effort : raw.reasoning_effort;
  const effort =
    typeof rawEffort === "string" && CODEX_REASONING_EFFORTS.has(rawEffort as CodexReasoningEffort)
      ? (rawEffort as CodexReasoningEffort)
      : undefined;
  if (!model && !effort) return undefined;
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {})
  };
}

// The model an assistant transcript row reports, if any. Synthetic rows
// (error placeholders) carry "<synthetic>" - never a real model id.
export function claudeRowModel(row: Record<string, unknown>): string | undefined {
  if (row.type !== "assistant") return undefined;
  const model = (row.message as Record<string, unknown> | undefined)?.model;
  if (typeof model !== "string") return undefined;
  const trimmed = model.trim();
  if (trimmed.length === 0 || trimmed.startsWith("<")) return undefined;
  return trimmed;
}

// A non-human prompt the server injected at its submission boundary, buffered
// until the sender-blind transcript row it produces tails back in and can be
// stamped with this origin. See resolveSource for the correlation.
type PendingSource = { text: string; source: TimelineItemSource; at: number };

// Resolve the origin of a user turn by its text, consuming the matching
// buffered injection. Undefined means "not positively an agent turn" - the
// caller leaves source absent, which renders as human (the safe default).
export type SourceResolver = (text: string) => TimelineItemSource | undefined;

// Match key: collapse whitespace runs and trim, and drop a trailing ellipsis
// left by truncate(), so a truncated transcript row still prefix-matches the
// full injected string.
function normalizeForMatch(text: string): string {
  return text.replace(/…+$/, "").replace(/\s+/g, " ").trim();
}

export type TranscriptFormat = "claude" | "codex";

export class TimelineStore {
  private readonly items = new Map<string, TimelineItem[]>();
  private readonly seenIds = new Map<string, Set<string>>();
  private readonly seqs = new Map<string, number>();
  private readonly tailers = new Map<string, JsonlTailer>();
  // Active transcript re-resolvers for resumed Claude sessions (see
  // followClaudeResume). Keyed by perch session id and stopped alongside the
  // session's tailer in detach/prune/stop.
  private readonly resumeResolvers = new Map<string, ClaudeResumeResolver>();
  private readonly listeners = new Set<TimelineListener>();
  private readonly modelListeners = new Set<ModelListener>();
  private readonly codexThreadSettingsListeners = new Set<CodexThreadSettingsListener>();
  // Per-session buffer of agent injections awaiting their transcript row.
  private readonly pendingSources = new Map<string, PendingSource[]>();

  subscribe(listener: TimelineListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Observe transcript-reported models (see ModelListener). Fires on catch-up
  // rows too - rows arrive in file order, so the last notification is the
  // session's current model even after a tailer re-attach.
  subscribeModel(listener: ModelListener): () => void {
    this.modelListeners.add(listener);
    return () => {
      this.modelListeners.delete(listener);
    };
  }

  subscribeCodexThreadSettings(listener: CodexThreadSettingsListener): () => void {
    this.codexThreadSettingsListeners.add(listener);
    return () => {
      this.codexThreadSettingsListeners.delete(listener);
    };
  }

  // Ingest a protocol-native timeline item directly (app-server-owned Codex
  // sessions: thread/turn/item notifications own the timeline, no transcript
  // tailer). Dedupe by item id makes resume-history replays idempotent
  // against rows already ingested live. `live: false` (catch-up replay)
  // populates the store without notifying listeners, mirroring the tailer's
  // catch-up read - clients page history via GET /timeline instead. A user
  // item without provenance resolves against recorded injections exactly like
  // a tailed row, so mate steers and kickoffs keep their agent attribution.
  ingest(item: TimelineItem, opts: { live?: boolean } = {}): void {
    let resolved = item;
    if (item.kind === "user" && !item.source && item.text) {
      const source = this.resolveSource(item.sessionId, item.text);
      if (source) resolved = { ...item, source };
    }
    this.append(resolved.sessionId, resolved, opts.live !== false);
  }

  // Begin (or re-point) tailing a session's transcript. Called when the
  // SessionStart hook correlates a perch session to its transcript path.
  // `isPathAllowed` re-verifies containment every time the tailer opens the
  // file: the attach-time check alone is a TOCTOU window (a symlink swapped
  // in after attach would stream an outside file to phones).
  attach(
    sessionId: string,
    transcriptPath: string,
    isPathAllowed?: (path: string) => boolean,
    format: TranscriptFormat = "claude",
    expectedCodexThreadId?: string
  ): void {
    const existing = this.tailers.get(sessionId);
    if (existing?.path === transcriptPath) {
      return;
    }
    existing?.stop();

    const normalizeRow = format === "codex" ? normalizeCodexRow : normalizeClaudeRow;
    const resolveSource: SourceResolver = (text) => this.resolveSource(sessionId, text);
    let matchedCodexThreadId: string | undefined;
    // Seqs are assigned in append (after id dedupe) so a truncation-recovery
    // re-read of the file never burns seqs or re-emits rows already delivered.
    // The tailer's catch-up read populates items without notifying listeners:
    // an already-large transcript would otherwise replay thousands of rows as
    // live WS frames (clients fetch history via GET /timeline instead).
    const tailer = new JsonlTailer(
      transcriptPath,
      (row, live) => {
        // Claude transcripts stamp assistant rows with the producing model;
        // surface it so the fleet's model readout tracks the session's own
        // truth (codex model/effort already flows via the app-server control).
        if (format === "claude") {
          const model = claudeRowModel(row);
          if (model) {
            for (const listener of this.modelListeners) {
              listener(sessionId, model);
            }
          }
        } else {
          const observedThreadId = codexSessionMetaThreadId(row);
          if (observedThreadId) {
            matchedCodexThreadId = observedThreadId === expectedCodexThreadId ? observedThreadId : undefined;
          }
          const settings = codexRowThreadSettings(row);
          if (settings && matchedCodexThreadId) {
            for (const listener of this.codexThreadSettingsListeners) {
              listener(sessionId, matchedCodexThreadId, settings);
            }
          }
        }
        for (const item of normalizeRow(sessionId, row, () => 0, resolveSource)) {
          this.append(sessionId, item, live);
        }
      },
      isPathAllowed
    );
    this.tailers.set(sessionId, tailer);
    tailer.start();
  }

  // Keep a resumed Claude session's tailer pointed at its newest transcript.
  // `claude --resume` forks the conversation into a fresh jsonl (new uuid) in
  // the same project dir and abandons the resumed-from file, often only at the
  // first post-resume turn (which for an idle mate can be hours later). No
  // further SessionStart hook names the fork, so this active re-resolution is
  // the only way to follow it. Lineage is confirmed by the shared root message
  // uuid, so a concurrent unrelated session in the same dir is never adopted.
  // Idempotent per session;
  // the resolver reads whatever transcript the SessionStart hook attaches, so
  // calling this before the first attach is safe (it waits).
  followClaudeResume(sessionId: string, isPathAllowed?: (path: string) => boolean): void {
    if (this.resumeResolvers.has(sessionId)) {
      return;
    }
    const resolver = new ClaudeResumeResolver(
      () => this.tailers.get(sessionId)?.path,
      (path) => this.attach(sessionId, path, isPathAllowed, "claude"),
      isPathAllowed
    );
    this.resumeResolvers.set(sessionId, resolver);
    resolver.start();
  }

  detach(sessionId: string): void {
    this.resumeResolvers.get(sessionId)?.stop();
    this.resumeResolvers.delete(sessionId);
    this.tailers.get(sessionId)?.stop();
    this.tailers.delete(sessionId);
  }

  // Record a non-human prompt at the moment the server injects it, so the
  // sender-blind transcript row it later produces can be attributed. Called at
  // the mate's steer path (POST /sessions/:id/input) and the task dispatch
  // kickoff. Human submissions (device composer, desktop keystrokes) are never
  // recorded - they fall through to the human default.
  recordSource(sessionId: string, text: string, source: TimelineItemSource): void {
    const normalized = normalizeForMatch(text);
    if (!normalized) {
      return;
    }
    const list = this.pendingSources.get(sessionId) ?? [];
    const now = Date.now();
    // Opportunistically drop expired entries so the buffer cannot grow
    // unbounded for a session that keeps injecting but never tails a match.
    const alive = list.filter((entry) => now - entry.at <= SOURCE_TTL_MS);
    alive.push({ text: normalized, source, at: now });
    this.pendingSources.set(sessionId, alive);
  }

  // Correlate a tailed user row to a buffered injection. Matches only when the
  // injected text starts with the row's text (the row is a possibly-truncated
  // prefix of what was injected), never the reverse - so a short injection can
  // never claim a longer, unrelated human turn. On a match the entry is
  // consumed and its source returned; otherwise undefined, biasing every
  // uncertainty to the human default.
  private resolveSource(sessionId: string, text: string): TimelineItemSource | undefined {
    const list = this.pendingSources.get(sessionId);
    if (!list || list.length === 0) {
      return undefined;
    }
    const now = Date.now();
    const alive = list.filter((entry) => now - entry.at <= SOURCE_TTL_MS);
    const itemText = normalizeForMatch(text);
    if (!itemText) {
      this.pendingSources.set(sessionId, alive);
      return undefined;
    }
    // Oldest matching entry wins, so ordered injections claim rows in order.
    const index = alive.findIndex((entry) => entry.text.startsWith(itemText));
    if (index === -1) {
      this.pendingSources.set(sessionId, alive);
      return undefined;
    }
    const [matched] = alive.splice(index, 1);
    this.pendingSources.set(sessionId, alive);
    return matched.source;
  }

  // Drop everything held for sessions that no longer exist (purged from the
  // fleet), so a long-running server does not accumulate per-session state.
  prune(activeSessionIds: Set<string>): void {
    for (const sessionId of this.items.keys()) {
      if (!activeSessionIds.has(sessionId)) {
        this.detach(sessionId);
        this.items.delete(sessionId);
        this.seenIds.delete(sessionId);
        this.seqs.delete(sessionId);
        this.pendingSources.delete(sessionId);
      }
    }
    for (const sessionId of this.tailers.keys()) {
      if (!activeSessionIds.has(sessionId)) {
        this.detach(sessionId);
      }
    }
    for (const sessionId of this.resumeResolvers.keys()) {
      if (!activeSessionIds.has(sessionId)) {
        this.detach(sessionId);
      }
    }
  }

  // The worker's most recent assistant reply, so a watchdog stall note can
  // carry enough context for the mate to adjudicate without opening the
  // session.
  lastAssistantText(sessionId: string): string | undefined {
    const all = this.items.get(sessionId);
    if (!all) {
      return undefined;
    }
    for (let index = all.length - 1; index >= 0; index -= 1) {
      const item = all[index];
      if (item?.kind === "assistant" && item.text?.trim()) {
        return item.text;
      }
    }
    return undefined;
  }

  // Latest worker-produced conversation row for watchdog classification. User
  // rows are excluded: the server injects the kickoff prompt itself (both
  // agents write it to the transcript at submission), so a user row proves the
  // prompt was submitted, not that the worker ever answered. Assistant and
  // tool rows prove real post-launch activity - unlike a transcript file
  // mtime, which merely creating the rollout file also bumps.
  lastActivityAt(sessionId: string): number | undefined {
    const all = this.items.get(sessionId);
    if (!all) return undefined;
    for (let index = all.length - 1; index >= 0; index -= 1) {
      const item = all[index];
      if (!item || item.kind === "user") continue;
      const at = Date.parse(item.at);
      return Number.isFinite(at) ? at : undefined;
    }
    return undefined;
  }

  fetch(sessionId: string, afterSeq: number, limit: number): { items: TimelineItem[]; lastSeq: number } {
    const all = this.items.get(sessionId) ?? [];
    const after = Number.isFinite(afterSeq) ? afterSeq : 0;
    const count = Number.isFinite(limit) ? limit : 200;
    const items = all.filter((item) => item.seq > after).slice(0, Math.max(1, Math.min(count, 500)));
    return { items, lastSeq: this.seqs.get(sessionId) ?? 0 };
  }

  stop(): void {
    for (const resolver of this.resumeResolvers.values()) {
      resolver.stop();
    }
    this.resumeResolvers.clear();
    for (const tailer of this.tailers.values()) {
      tailer.stop();
    }
    this.tailers.clear();
  }

  private nextSeq(sessionId: string): number {
    const next = (this.seqs.get(sessionId) ?? 0) + 1;
    this.seqs.set(sessionId, next);
    return next;
  }

  private append(sessionId: string, item: TimelineItem, notify = true): void {
    const seen = this.seenIds.get(sessionId) ?? new Set<string>();
    if (seen.has(item.id)) {
      return;
    }
    seen.add(item.id);
    for (const id of seen) {
      if (seen.size <= MAX_SEEN_IDS_PER_SESSION) {
        break;
      }
      seen.delete(id);
    }
    this.seenIds.set(sessionId, seen);

    const sequenced: TimelineItem = { ...item, seq: this.nextSeq(sessionId) };
    const list = this.items.get(sessionId) ?? [];
    list.push(sequenced);
    if (list.length > MAX_ITEMS_PER_SESSION) {
      list.splice(0, list.length - MAX_ITEMS_PER_SESSION);
    }
    this.items.set(sessionId, list);
    if (!notify) {
      return;
    }
    for (const listener of this.listeners) {
      listener(sequenced);
    }
  }
}

// Incremental JSONL reader: consumes appended bytes only, carries partial
// lines across reads, survives the file not existing yet.
class JsonlTailer {
  private offset = 0;
  private partial = "";
  // Carries multibyte characters split across read boundaries; a plain
  // buffer.toString would decode the halves into replacement characters.
  private decoder = new StringDecoder("utf8");
  private watcher?: FSWatcher;
  private pollTimer?: ReturnType<typeof setInterval>;
  private reading = false;
  private stopped = false;
  // False until the first read that reaches the file's current end. Rows seen
  // before that are backfill (live=false), even when the file only appears
  // after start() - a resumed session's transcript can be written moments
  // after the SessionStart hook, and its full history must not fan out as
  // live frames.
  private caughtUp = false;

  constructor(
    readonly path: string,
    private readonly onRow: (row: Record<string, unknown>, live: boolean) => void,
    private readonly isPathAllowed?: (path: string) => boolean
  ) {}

  start(): void {
    this.readNew();
    try {
      this.watcher = watch(this.path, () => {
        this.readNew();
      });
    } catch {
      // File may not exist yet; polling below covers creation.
    }
    // fs.watch on macOS can miss events; a slow poll is the safety net.
    this.pollTimer = setInterval(() => {
      this.readNew();
      if (!this.watcher) {
        try {
          this.watcher = watch(this.path, () => this.readNew());
        } catch {
          // Still absent.
        }
      }
    }, POLL_MS);
    this.pollTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private readNew(): void {
    if (this.reading || this.stopped || !existsSync(this.path)) {
      return;
    }
    // Resolve symlinks once and stat/open the RESOLVED path: verifying the
    // raw path and then opening it leaves a check-then-open window where a
    // symlink swapped in between streams an outside file.
    let target: string;
    try {
      target = realpathSync(this.path);
    } catch {
      return;
    }
    if (this.isPathAllowed && !this.isPathAllowed(target)) {
      // The path no longer resolves inside the allowed root (e.g. it was
      // swapped for a symlink after attach): stop streaming for good.
      this.stop();
      return;
    }
    this.reading = true;
    // Rows parsed during this pass are live only once an earlier pass already
    // reached the end of the file.
    const live = this.caughtUp;
    try {
      const size = statSync(target).size;
      if (size < this.offset) {
        // Truncated/rotated: start over.
        this.offset = 0;
        this.partial = "";
        this.decoder = new StringDecoder("utf8");
      }
      if (size === this.offset) {
        this.caughtUp = true;
        return;
      }

      const fd = openSync(target, "r");
      try {
        while (this.offset < size) {
          const length = size - this.offset;
          const buffer = Buffer.alloc(Math.min(length, 4 * 1024 * 1024));
          const bytesRead = readSync(fd, buffer, 0, buffer.length, this.offset);
          if (bytesRead <= 0) {
            break;
          }
          this.offset += bytesRead;
          const chunk = this.partial + this.decoder.write(buffer.subarray(0, bytesRead));
          const lines = chunk.split("\n");
          this.partial = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
              continue;
            }
            try {
              this.onRow(JSON.parse(trimmed) as Record<string, unknown>, live);
            } catch {
              // Skip malformed rows; never crash the tailer.
            }
          }
        }
      } finally {
        closeSync(fd);
      }
      this.caughtUp = true;
    } catch {
      // Transient fs errors: the next poll retries.
    } finally {
      this.reading = false;
    }
  }
}

// --- Claude resume-fork re-resolution ---------------------------------------
// `claude --resume <id>` forks: it replays the resumed-from transcript into a
// fresh <newId>.jsonl in the same project dir and writes every new turn there,
// abandoning the old file. Only one SessionStart hook fires (naming the
// resumed-from file), so without active re-resolution the tailer follows a
// frozen file. This resolver polls the project dir for the newest transcript
// in the same conversation lineage and re-points the tailer to it.

const RESUME_SCAN_MS = 2500;
function resumeScanMs(): number {
  const value = Number(process.env.PERCH_RESUME_SCAN_MS);
  return Number.isFinite(value) && value >= 20 ? value : RESUME_SCAN_MS;
}
// The fork replays from the conversation root, so the lineage anchor (the first
// message-row uuid) lands in the first handful of rows; a bounded head read is
// enough to identify a candidate's lineage and never grows with transcript size.
const LINEAGE_PROBE_BYTES = 256 * 1024;

class ClaudeResumeResolver {
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private anchorUuid?: string;
  private anchorDir?: string;
  // Files positively identified as a different lineage. A transcript's first
  // message-row uuid is immutable once written, so a non-match is permanent.
  private readonly rejected = new Set<string>();

  constructor(
    private readonly currentPath: () => string | undefined,
    private readonly repoint: (path: string) => void,
    private readonly isPathAllowed?: (path: string) => boolean
  ) {}

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), resumeScanMs());
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private tick(): void {
    if (this.stopped) {
      return;
    }
    const current = this.currentPath();
    if (!current) {
      // The SessionStart hook has not attached the resumed-from transcript yet.
      return;
    }
    if (!this.anchorUuid) {
      // Establish the lineage anchor from the resumed-from transcript once. The
      // root message uuid is replayed into every fork descendant, so it is a
      // stable identity for the whole conversation lineage.
      const uuid = firstMessageUuid(current);
      if (!uuid) {
        // Transcript empty or not readable yet; retry on the next tick.
        return;
      }
      this.anchorUuid = uuid;
      this.anchorDir = dirname(current);
    }
    let currentMtime: number;
    try {
      currentMtime = statSync(current).mtimeMs;
    } catch {
      return;
    }
    const newest = newestLineageDescendant(
      this.anchorDir!,
      this.anchorUuid,
      current,
      currentMtime,
      this.rejected,
      this.isPathAllowed
    );
    if (newest && newest !== current) {
      this.repoint(newest);
    }
  }
}

// Read the first bytes of a transcript, tolerant of the file not existing yet.
function readTranscriptHead(path: string, maxBytes: number): string | undefined {
  try {
    const fd = openSync(path, "r");
    try {
      const size = statSync(path).size;
      const length = Math.min(size, maxBytes);
      if (length <= 0) {
        return "";
      }
      const buffer = Buffer.alloc(length);
      const bytesRead = readSync(fd, buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

// The uuid of a transcript's first user/assistant row, which is the stable
// identity of its conversation lineage: a resume fork replays this row verbatim
// (rewriting sessionId but preserving uuid). Undefined until such a row exists.
function firstMessageUuid(path: string): string | undefined {
  const head = readTranscriptHead(path, LINEAGE_PROBE_BYTES);
  if (!head) {
    return undefined;
  }
  for (const line of head.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // A partial trailing line from the bounded read; earlier lines already
      // covered the head, so stop looking here.
      continue;
    }
    if ((row.type === "user" || row.type === "assistant") && typeof row.uuid === "string") {
      return row.uuid;
    }
  }
  return undefined;
}

// The newest transcript in `dir` that belongs to the same conversation lineage
// as `anchorUuid` and is strictly newer than the currently-tailed file - i.e.
// the live fork after a resume. Lineage is confirmed by the shared root uuid, so
// an unrelated concurrent session in the same dir is never adopted; a file whose
// root uuid differs is remembered so its head is read at most once.
function newestLineageDescendant(
  dir: string,
  anchorUuid: string,
  currentPath: string,
  currentMtime: number,
  rejected: Set<string>,
  isPathAllowed?: (path: string) => boolean
): string | undefined {
  let best: string | undefined;
  let bestMtime = currentMtime;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }
    const candidate = join(dir, name);
    if (candidate === currentPath || rejected.has(candidate)) {
      continue;
    }
    let mtime: number;
    try {
      mtime = statSync(candidate).mtimeMs;
    } catch {
      continue;
    }
    if (mtime <= bestMtime) {
      continue;
    }
    if (isPathAllowed && !isPathAllowed(candidate)) {
      continue;
    }
    const root = firstMessageUuid(candidate);
    if (root === undefined) {
      // No complete message row yet (a fork mid-creation); re-check next tick.
      continue;
    }
    if (root !== anchorUuid) {
      rejected.add(candidate);
      continue;
    }
    best = candidate;
    bestMtime = mtime;
  }
  return best;
}

// --- Claude transcript row normalization ------------------------------------
// Rows are Claude Code's internal format and can drift between releases, so
// every access is defensive. Unknown shapes yield no items.

type ContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
};

export function normalizeClaudeRow(
  sessionId: string,
  row: Record<string, unknown>,
  nextSeq: () => number,
  resolveSource?: SourceResolver
): TimelineItem[] {
  const rowType = typeof row.type === "string" ? row.type : "";
  if (rowType !== "user" && rowType !== "assistant") {
    return [];
  }
  if (row.isMeta === true) {
    return [];
  }

  const message = (row.message ?? {}) as Record<string, unknown>;
  const at = typeof row.timestamp === "string" ? row.timestamp : new Date().toISOString();
  // Deterministic fallback id: dedupe must survive truncation-recovery
  // re-reads, so rows without a uuid hash to the same id every time.
  const uuid =
    typeof row.uuid === "string"
      ? row.uuid
      : `${at}-${createHash("sha256").update(JSON.stringify(message)).digest("hex").slice(0, 12)}`;
  const content = message.content;

  // String content: plain user prompt.
  if (typeof content === "string") {
    if (rowType !== "user" || content.trim().length === 0 || isSyntheticUserText(content)) {
      return [];
    }
    return [
      makeItem(sessionId, uuid, "user", truncate(content), undefined, at, nextSeq, resolveSource?.(content))
    ];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const items: TimelineItem[] = [];
  for (const [index, blockRaw] of content.entries()) {
    const block = blockRaw as ContentBlock;
    const id = `${uuid}-${index}`;

    if (rowType === "user" && block.type === "text" && typeof block.text === "string") {
      if (block.text.trim().length > 0 && !isSyntheticUserText(block.text)) {
        items.push(
          makeItem(sessionId, id, "user", truncate(block.text), undefined, at, nextSeq, resolveSource?.(block.text))
        );
      }
    } else if (rowType === "user" && block.type === "tool_result") {
      const text = renderToolResult(block.content);
      if (text) {
        items.push(makeItem(sessionId, id, "tool_result", truncate(text), undefined, at, nextSeq));
      }
    } else if (rowType === "assistant" && block.type === "text" && typeof block.text === "string") {
      if (block.text.trim().length > 0) {
        items.push(makeItem(sessionId, id, "assistant", truncate(block.text), undefined, at, nextSeq));
      }
    } else if (rowType === "assistant" && block.type === "tool_use" && typeof block.name === "string") {
      items.push(
        makeItem(
          sessionId,
          id,
          "tool_call",
          undefined,
          { name: block.name, input: summarizeToolInput(block.input) },
          at,
          nextSeq
        )
      );
    }
  }
  return items;
}

function makeItem(
  sessionId: string,
  id: string,
  kind: TimelineItemKind,
  text: string | undefined,
  tool: { name: string; input?: string } | undefined,
  at: string,
  nextSeq: () => number,
  source?: TimelineItemSource
): TimelineItem {
  return {
    seq: nextSeq(),
    id,
    sessionId,
    kind,
    ...(text !== undefined ? { text } : {}),
    ...(tool !== undefined ? { tool } : {}),
    at,
    ...(source !== undefined ? { source } : {})
  };
}

// Claude injects synthetic user rows (command output wrappers, reminders);
// they would read as messages the human never typed.
function isSyntheticUserText(text: string): boolean {
  return (
    text.startsWith("<command-name>") ||
    text.startsWith("<local-command-stdout>") ||
    text.startsWith("<system-reminder>") ||
    text.startsWith("Caveat: ")
  );
}

function renderToolResult(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((block) => {
        const record = block as ContentBlock;
        return record.type === "text" && typeof record.text === "string" ? record.text : "";
      })
      .filter(Boolean)
      .join("\n");
    return text || undefined;
  }
  return undefined;
}

function summarizeToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  // AskUserQuestion's input is {questions:[...]}; surface the question text(s)
  // so the historical row reads "Asked: ..." instead of a truncated JSON blob.
  if (Array.isArray(record.questions)) {
    const texts = record.questions
      .map((entry) => {
        const question = (entry as Record<string, unknown>)?.question;
        return typeof question === "string" ? question : "";
      })
      .filter(Boolean);
    if (texts.length > 0) {
      return truncate(texts.join(" · "), 300);
    }
  }
  // Prefer the human-meaningful field per common tools.
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"]) {
    if (typeof record[key] === "string" && (record[key] as string).length > 0) {
      return truncate(record[key] as string, 300);
    }
  }
  const json = JSON.stringify(record);
  return json === "{}" ? undefined : truncate(json, 300);
}

function truncate(text: string, max = MAX_TEXT_LENGTH): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// --- Codex rollout row normalization -----------------------------------------
// Rollout rows: {timestamp, type, payload}. Chat text comes from event_msg
// user_message/agent_message (the display messages, free of the developer/
// context noise in response_item messages); tool activity comes from
// response_item function_call / function_call_output / custom_tool_call rows.
// Rows carry no uuid, so ids are content hashes - stable across the
// truncation-recovery re-read, which is what the store dedupes on.

export function normalizeCodexRow(
  sessionId: string,
  row: Record<string, unknown>,
  _nextSeq: () => number,
  resolveSource?: SourceResolver
): TimelineItem[] {
  const rowType = typeof row.type === "string" ? row.type : "";
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const payloadType = typeof payload.type === "string" ? payload.type : "";
  const at = typeof row.timestamp === "string" ? row.timestamp : new Date().toISOString();

  const make = (
    kind: TimelineItemKind,
    text?: string,
    tool?: TimelineItem["tool"],
    source?: TimelineItemSource
  ): TimelineItem[] => [
    {
      seq: 0,
      id: `cx-${rowHash(row)}`,
      sessionId,
      kind,
      text: text === undefined ? undefined : truncate(text),
      tool,
      at,
      ...(source !== undefined ? { source } : {})
    }
  ];

  if (rowType === "event_msg") {
    const message = typeof payload.message === "string" ? payload.message : "";
    if (!message) {
      return [];
    }
    if (payloadType === "user_message") {
      return make("user", message, undefined, resolveSource?.(message));
    }
    if (payloadType === "agent_message") {
      return make("assistant", message);
    }
    return [];
  }

  if (rowType !== "response_item") {
    return [];
  }

  if (payloadType === "function_call" || payloadType === "custom_tool_call") {
    const name = typeof payload.name === "string" ? payload.name : "tool";
    const rawInput = payload.arguments ?? payload.input;
    return make("tool_call", undefined, { name, input: summarizeCodexToolInput(rawInput) });
  }

  if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
    const output = payload.output;
    const text =
      typeof output === "string"
        ? output
        : typeof (output as Record<string, unknown> | undefined)?.content === "string"
          ? ((output as Record<string, unknown>).content as string)
          : JSON.stringify(output ?? "");
    return make("tool_result", truncate(stripCodexOutputHeader(text), 2000));
  }

  return [];
}

// exec_command arguments arrive as a JSON string ({"cmd": ...}); surface the
// command itself, mirroring how Claude tool_use input is summarized.
function summarizeCodexToolInput(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return summarizeToolInput(raw);
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ["cmd", "command", "path", "file_path", "pattern", "input"]) {
      if (typeof parsed[key] === "string" && (parsed[key] as string).length > 0) {
        return truncate(parsed[key] as string, 300);
      }
    }
    return truncate(raw, 300);
  } catch {
    return truncate(raw, 300);
  }
}

// exec_command outputs carry a bookkeeping preamble (Chunk ID / Wall time /
// token counts) before the real output; drop it for the chat surface.
function stripCodexOutputHeader(text: string): string {
  const marker = "\nOutput:\n";
  const index = text.indexOf(marker);
  return index >= 0 && index < 400 ? text.slice(index + marker.length) : text;
}

function rowHash(row: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(row)).digest("hex").slice(0, 20);
}
