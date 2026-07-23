import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher
} from "node:fs";
import { readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Chart,
  ChartAnnotation,
  ChartLayoutWarning,
  ChartPlanDoc,
  ChartsHubProject,
  ChartsHubResponse
} from "@perch/shared";
import { perchHome } from "./home.js";
import type { TaskStore } from "./tasks.js";

// Chart registry, SDK injection, asset confinement, and feedback normalization
// behind the /charts routes in http.ts. The annotation SDK is vendored from
// lavish-axi v0.1.37 in ./charts/vendor/ (MIT, (c) 2026 Kun Chen). This module
// integrates it with Perch auth, composer injection, and the fleet WebSocket.

export type ChartEventKind = "registered" | "updated" | "archived" | "finalized";

export type ChartListener = (chart: Chart, event: { kind: ChartEventKind }) => void;

const WATCH_DEBOUNCE_MS = 100;
const REVIEW_NONCE_BYTES = 32;
const REVIEW_NONCE_TTL_MS = 12 * 60 * 60 * 1000;
const REVIEW_NONCE_LIMIT = 8;

// Snapshot bound: a chart references a handful of images, not a tree. Refs
// beyond this are skipped (the live-directory fallback still serves them
// while the worktree exists).
const SNAPSHOT_ASSET_LIMIT = 128;

export class ChartRegistry {
  private readonly root: string;
  private readonly file: string;
  private readonly listeners: ChartListener[] = [];
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly watchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Last delivered layout-audit signature per chart, so a reload re-reporting
  // the identical findings never re-injects into the agent's composer.
  private readonly layoutSignatures = new Map<string, string>();

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    this.root = resolve(perchHome(env), "charts");
    this.file = resolve(this.root, "charts.json");
  }

  subscribe(listener: ChartListener): void {
    this.listeners.push(listener);
  }

  // Bind an HTML file to its owning session (and task, when present). Identity
  // is minted per registration, not keyed by the path: reusable worktree slots
  // can draw `.charts/foo.html` for unrelated tasks, and the older review must
  // keep its owner, snapshot, and status. Only the newest registration for a
  // live path keeps watching that path; older reviews serve their snapshot.
  register(
    filePath: string,
    owner: {
      sessionId: string;
      taskId?: string;
      taskTitle?: string;
      parentSessionId?: string;
      projectRoot?: string;
    }
  ): Chart {
    const canonical = canonicalChartFile(filePath);
    const state = this.readState();
    const id = chartId(state.charts);
    const now = new Date().toISOString();
    const chart: Chart = {
      id,
      name: chartName(canonical),
      file: canonical,
      status: "draft",
      sessionId: owner.sessionId,
      ...(owner.taskId ? { taskId: owner.taskId } : {}),
      ...(owner.taskTitle ? { taskTitle: owner.taskTitle } : {}),
      ...(owner.parentSessionId ? { parentSessionId: owner.parentSessionId } : {}),
      ...(owner.projectRoot ? { projectRoot: owner.projectRoot } : {}),
      registeredAt: now,
      updatedAt: now
    };
    if (this.snapshot(chart)) {
      chart.snapshotAt = now;
    }
    state.charts[id] = chart;
    this.writeState(state);
    this.retirePathWatchers(canonical, id);
    this.watchChart(chart);
    this.notify(chart, "registered");
    return chart;
  }

  list(): Chart[] {
    return Object.values(this.readState().charts).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  find(id: string): Chart | undefined {
    return this.readState().charts[id];
  }

  issueReviewNonce(id: string): string | undefined {
    const state = this.readState();
    if (!state.charts[id]) {
      return undefined;
    }
    const now = Date.now();
    const nonce = randomBytes(REVIEW_NONCE_BYTES).toString("base64url");
    const entry = {
      hash: reviewNonceHash(id, nonce),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + REVIEW_NONCE_TTL_MS).toISOString()
    };
    const current = pruneReviewNonces(state.reviewNonces[id] ?? [], now);
    state.reviewNonces[id] = [...current, entry].slice(-REVIEW_NONCE_LIMIT);
    this.writeState(state);
    return nonce;
  }

  verifyReviewNonce(id: string, nonce: string): boolean {
    const presented = nonce.trim();
    if (!presented) {
      return false;
    }
    const state = this.readState();
    const existing = state.reviewNonces[id] ?? [];
    const pruned = pruneReviewNonces(existing, Date.now());
    if (pruned.length !== existing.length) {
      if (pruned.length > 0) {
        state.reviewNonces[id] = pruned;
      } else {
        delete state.reviewNonces[id];
      }
      this.writeState(state);
    }
    const hash = reviewNonceHash(id, presented);
    return pruned.some((entry) => hashesEqual(entry.hash, hash));
  }

  // The owning task closed: flip its charts to archived. Still servable and
  // viewable (the snapshot outlives everything), just marked so "what is
  // latest" stays legible as charts accumulate.
  archiveForTask(taskId: string): Chart[] {
    const state = this.readState();
    const flipped: Chart[] = [];
    const now = new Date().toISOString();
    for (const chart of Object.values(state.charts)) {
      if (chart.taskId === taskId && !chart.archived) {
        chart.archived = true;
        chart.archivedAt = now;
        flipped.push(chart);
      }
    }
    if (flipped.length === 0) {
      return [];
    }
    this.writeState(state);
    for (const chart of flipped) {
      this.notify(chart, "archived");
    }
    return flipped.map((chart) => ({ ...chart }));
  }

  // Approve a chart: flip it to finalized (draft -> finalized). Idempotent - a
  // chart already finalized is returned unchanged without re-notifying. Returns
  // undefined for an unknown id.
  finalize(id: string): Chart | undefined {
    const state = this.readState();
    const chart = state.charts[id];
    if (!chart) {
      return undefined;
    }
    if (chart.status === "finalized") {
      return { ...chart };
    }
    chart.status = "finalized";
    chart.finalizedAt = new Date().toISOString();
    this.writeState(state);
    this.notify(chart, "finalized");
    return { ...chart };
  }

  // --- Snapshots -------------------------------------------------------------
  // The durable copy under ~/.perch/charts/<id>/: written at registration and
  // rewritten on every live-refresh, so the chart outlives its worktree (the
  // author's copy is scratch; teardown never kills a chart).

  private snapshotDir(id: string): string {
    return join(this.root, id);
  }

  // The HTML file to serve: the snapshot when one exists, else the live file
  // (charts registered before snapshots shipped).
  htmlFileFor(chart: Chart): string {
    const snapshot = join(this.snapshotDir(chart.id), "index.html");
    return existsSync(snapshot) ? snapshot : chart.file;
  }

  // A sibling asset, directory-confined against BOTH roots: the snapshot dir
  // first (durable), the live chart dir as fallback (covers assets the
  // snapshot's reference scan missed, while the worktree still exists).
  assetFileFor(chart: Chart, assetPath: string): string | null {
    const fromSnapshot = resolveChartAsset(this.snapshotDir(chart.id), assetPath);
    if (fromSnapshot === null) {
      return null;
    }
    if (existsSync(fromSnapshot)) {
      return fromSnapshot;
    }
    return resolveChartAsset(dirname(chart.file), assetPath);
  }

  // Copy the chart HTML (as index.html) plus its directory-confined referenced
  // siblings into the snapshot dir. Returns false when the live file is
  // unreadable (vanished worktree) - the previous snapshot stays in place.
  private snapshot(chart: Chart): boolean {
    let html: string;
    try {
      html = readFileSync(chart.file, "utf8");
    } catch {
      return false;
    }
    const dir = this.snapshotDir(chart.id);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.html"), html);
    } catch {
      return false;
    }
    const liveDir = dirname(chart.file);
    for (const ref of collectChartAssetRefs(html).slice(0, SNAPSHOT_ASSET_LIMIT)) {
      const source = resolveChartAsset(liveDir, ref);
      const target = resolveChartAsset(dir, ref);
      if (!source || !target) {
        continue;
      }
      try {
        if (!statSync(source).isFile()) {
          continue;
        }
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
      } catch {
        // Missing or unreadable ref: the chart still renders without it.
      }
    }
    return true;
  }

  // Watch fired: refresh the durable copy before telling clients to reload,
  // so what they refetch is what just changed.
  private refreshSnapshot(id: string): Chart | undefined {
    const state = this.readState();
    const chart = state.charts[id];
    if (!chart) {
      return undefined;
    }
    if (this.snapshot(chart)) {
      chart.snapshotAt = new Date().toISOString();
      this.writeState(state);
    }
    return { ...chart };
  }

  // Dedupe layout-audit reports: only a changed, non-empty set of findings is
  // worth the agent's attention. A signature is enough because delivery is
  // push-based and only changed findings need another notification.
  recordLayoutWarnings(id: string, raw: unknown): { changed: boolean; warnings: ChartLayoutWarning[] } {
    const warnings = normalizeLayoutWarnings(raw);
    const signature = JSON.stringify(warnings);
    if (this.layoutSignatures.get(id) === signature) {
      return { changed: false, warnings };
    }
    this.layoutSignatures.set(id, signature);
    return { changed: true, warnings };
  }

  stop(): void {
    for (const timer of this.watchTimers.values()) {
      clearTimeout(timer);
    }
    this.watchTimers.clear();
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }

  // Live refresh: watch the chart file itself, never its directory, and debounce editor
  // write bursts into one "updated" event. Watchers live for this process
  // only; after a restart, stale charts re-arm when their session registers
  // them again.
  private watchChart(chart: Chart): void {
    if (this.watchers.has(chart.id)) {
      return;
    }
    let watcher: FSWatcher;
    try {
      watcher = watch(chart.file, () => {
        clearTimeout(this.watchTimers.get(chart.id));
        const timer = setTimeout(() => {
          this.watchTimers.delete(chart.id);
          const current = this.refreshSnapshot(chart.id);
          if (current) {
            this.notify(current, "updated");
          }
        }, WATCH_DEBOUNCE_MS);
        timer.unref?.();
        this.watchTimers.set(chart.id, timer);
      });
    } catch {
      // File vanished between registration and watch: live refresh is
      // best-effort, serving/feedback still work while the file is recreated.
      return;
    }
    watcher.on("error", () => {
      watcher.close();
      this.watchers.delete(chart.id);
    });
    this.watchers.set(chart.id, watcher);
  }

  private retirePathWatchers(canonicalFile: string, keepId: string): void {
    for (const chart of Object.values(this.readState().charts)) {
      if (chart.id === keepId || chart.file !== canonicalFile) {
        continue;
      }
      const watcher = this.watchers.get(chart.id);
      if (watcher) {
        watcher.close();
        this.watchers.delete(chart.id);
      }
      const timer = this.watchTimers.get(chart.id);
      if (timer) {
        clearTimeout(timer);
        this.watchTimers.delete(chart.id);
      }
    }
  }

  private notify(chart: Chart, kind: ChartEventKind): void {
    for (const listener of this.listeners) {
      try {
        listener({ ...chart }, { kind });
      } catch {
        // Observers never disturb the registry.
      }
    }
  }

  private readState(): ChartRegistryState {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<ChartRegistryState>;
      return { charts: parsed.charts ?? {}, reviewNonces: parsed.reviewNonces ?? {} };
    } catch {
      return { charts: {}, reviewNonces: {} };
    }
  }

  private writeState(state: ChartRegistryState): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

// Chart lifecycle rides the task ledger: when a chart's owning task closes,
// the chart flips to archived (index.ts wires this; tests exercise the same
// function).
export function wireChartArchive(tasks: TaskStore, charts: ChartRegistry): void {
  tasks.subscribe((task, event) => {
    if (task.state === "closed" && event.previousState !== "closed") {
      charts.archiveForTask(task.id);
    }
  });
}

// --- Unified hub listing -----------------------------------------------------
// The read source both front-ends consume:
// registered charts grouped by their owning project, plus each tracked
// project's committed implementation plans scanned from docs/plans/*.md.

const PLAN_DATE = /^(\d{4}-\d{2}-\d{2})-/;

// A project's committed implementation plans (docs/plans/*.md). Every committed
// plan doc is a finalized plan; the doc's own `Status:` header is a separate
// axis (implementation status) and is deliberately not read here.
export function scanPlanDocs(projectRoot: string): ChartPlanDoc[] {
  const dir = join(projectRoot, "docs", "plans");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const docs: ChartPlanDoc[] = [];
  for (const name of names) {
    if (!/\.md$/i.test(name) || name.toLowerCase() === "readme.md") {
      continue;
    }
    const path = join(dir, name);
    let markdown: string;
    try {
      if (!statSync(path).isFile()) {
        continue;
      }
      markdown = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const date = PLAN_DATE.exec(name)?.[1];
    docs.push({
      path,
      relativePath: join("docs", "plans", name),
      title: planTitle(markdown, name),
      ...(date ? { date } : {})
    });
  }
  // Newest first: filenames are date-prefixed, so a lexical descending sort is
  // chronological.
  return docs.sort((a, b) => (a.relativePath < b.relativePath ? 1 : -1));
}

// The first Markdown H1 (`# ...`), or the filename minus its date prefix and
// extension when the doc has none.
function planTitle(markdown: string, filename: string): string {
  for (const line of markdown.split("\n")) {
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    if (heading) {
      return heading[1] ?? filename;
    }
  }
  return filename.replace(/\.md$/i, "").replace(PLAN_DATE, "");
}

// Group charts by their owning project and attach each project's committed
// plans. `resolveProjectRoot` maps a chart to a tracked project's rootPath (in
// http.ts: an explicit `chart.projectRoot` when set, else task linkage); charts
// with no resolvable tracked project land in `ungrouped`. A project appears
// only when it has at least one chart or plan.
export function buildChartsHub(
  charts: Chart[],
  projects: Array<{ rootPath: string; name: string }>,
  resolveProjectRoot: (chart: Chart) => string | undefined
): ChartsHubResponse {
  const byRoot = new Map<string, ChartsHubProject>();
  for (const project of projects) {
    byRoot.set(project.rootPath, {
      rootPath: project.rootPath,
      name: project.name,
      charts: [],
      plans: scanPlanDocs(project.rootPath)
    });
  }
  const ungrouped: Chart[] = [];
  for (const chart of charts) {
    const root = resolveProjectRoot(chart);
    const group = root ? byRoot.get(root) : undefined;
    if (group) {
      group.charts.push(chart);
    } else {
      ungrouped.push(chart);
    }
  }
  const grouped = [...byRoot.values()].filter(
    (project) => project.charts.length > 0 || project.plans.length > 0
  );
  return { projects: grouped, ungrouped };
}

// Relative asset references in a chart's HTML (src/href attributes plus
// url(...) in inline style values), for the snapshot's sibling copy. Scheme'd,
// protocol-relative, fragment, and root-absolute refs are not siblings; the
// perch-served ./chart.css simply never exists next to the chart, so the
// copy's existence check drops it.
export function collectChartAssetRefs(html: string): string[] {
  const refs = new Set<string>();
  const pattern = /(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')|url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]+))\s*\)/gi;
  for (const match of html.matchAll(pattern)) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? "").trim();
    const bare = raw.split(/[?#]/, 1)[0] ?? "";
    if (!bare || /^[a-z][a-z0-9+.-]*:/i.test(bare) || bare.startsWith("//") || bare.startsWith("/")) {
      continue;
    }
    try {
      refs.add(decodeURIComponent(bare));
    } catch {
      refs.add(bare);
    }
  }
  return [...refs];
}

// Canonicalize and validate a chart path: it must be a real, existing .html
// file (realpath collapses symlink games before the path is hashed and served).
export function canonicalChartFile(filePath: string): string {
  const canonical = realpathSync(resolve(filePath));
  if (!statSync(canonical).isFile()) {
    throw new Error(`Not a file: ${canonical}`);
  }
  if (!/\.html?$/i.test(canonical)) {
    throw new Error(`A chart must be an HTML file: ${canonical}`);
  }
  return canonical;
}

type ChartReviewNonce = {
  hash: string;
  issuedAt: string;
  expiresAt: string;
};

type ChartRegistryState = {
  charts: Record<string, Chart>;
  reviewNonces: Record<string, ChartReviewNonce[]>;
};

export function chartId(existing: Record<string, Chart> = {}): string {
  for (;;) {
    const id = randomBytes(8).toString("hex");
    if (!existing[id]) {
      return id;
    }
  }
}

function chartName(canonicalFile: string): string {
  return basename(canonicalFile).replace(/\.html?$/i, "");
}

function reviewNonceHash(chartIdValue: string, nonce: string): string {
  return createHash("sha256").update(chartIdValue).update("\0").update(nonce).digest("hex");
}

function pruneReviewNonces(entries: ChartReviewNonce[], now: number): ChartReviewNonce[] {
  return entries.filter((entry) => Date.parse(entry.expiresAt) > now);
}

function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

// --- Serving ---------------------------------------------------------------

// Sibling assets are confined to the chart's own directory; anything resolving
// outside is rejected.
export function resolveChartAsset(root: string, assetPath: string): string | null {
  const file = resolve(root, assetPath);
  const rel = relative(root, file);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return null;
  }
  return file;
}

// Inline the SDK instead of referencing it by URL: every /charts route sits behind Perch auth,
// and an inline script spares the page a second authenticated fetch.
export function injectChartSdk(html: string, sdkJs: string = chartSdkJs()): string {
  const script = `<script>\n${sdkJs.replace(/<\/script/gi, "<\\/script")}\n</script>`;
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${script}</body>`);
  }
  return `${html}\n${script}`;
}

let cachedSdkJs: string | undefined;

// Assemble the browser bundle from the vendored source
// text instead, because tsc compiles only .ts - the vendored .js is never part
// of the server's module graph, so it is read as an asset (like the mate spec)
// and stripped of module syntax for the browser. The SDK talks to its host
// exclusively via parent.postMessage, so the bundle needs no perch wiring; the
// review chrome (T3) / WKWebView bridge (T4) relays to the /charts routes.
export function chartSdkJs(): string {
  if (cachedSdkJs) {
    return cachedSdkJs;
  }
  const mermaid = stripModuleSyntax(readVendorFile("mermaid-node.js"));
  const sdk = stripModuleSyntax(readVendorFile("artifact-sdk.js"));
  cachedSdkJs = `(() => {
${mermaid}
${sdk}
createArtifactSdk(deriveLavishQueueKey, isNativeInteractiveControl, {
  isMermaidSvg,
  readNodeLabel,
  mermaidNodeElement,
  mermaidNodeFrom,
  normalizeMermaidNodeTarget
});
})();`;
  return cachedSdkJs;
}

// Drop import lines and `export ` prefixes so the vendored ESM source runs as
// one browser script. Safe for these two files by construction: their only
// import is mermaid-node.js (concatenated into the same scope) and every
// export is a top-of-line declaration.
function stripModuleSyntax(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^import\b/.test(line))
    .map((line) => line.replace(/^export /, ""))
    .join("\n");
}

function readVendorFile(name: string): string {
  // From src (tsx/tests) the vendor dir is a sibling; from dist it is not
  // copied by tsc, so fall back to the source tree (always present in this
  // private workspace package, same as ../assets for the mate spec).
  for (const candidate of [
    new URL(`./charts/vendor/${name}`, import.meta.url),
    new URL(`../src/charts/vendor/${name}`, import.meta.url)
  ]) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) {
      return readFileSync(path, "utf8");
    }
  }
  throw new Error(`vendored charts file missing: ${name}`);
}

// The perch-owned chart stylesheet (T1 ships it in assets/charts/).
export function chartCssPath(): string {
  return fileURLToPath(new URL("../assets/charts/chart.css", import.meta.url));
}

// The perch-owned authoring guide, served at GET /charts/authoring so agents
// in any repo can fetch it (external users have no perch checkout to read).
export function chartAuthoringPath(): string {
  return fileURLToPath(new URL("../assets/charts/AUTHORING.md", import.meta.url));
}

// --- Desktop review chrome (T3) ----------------------------------------------

// The review-chrome assets Perch serves from assets/charts/chrome/. A fixed allowlist of exactly these
// files - there is no path for a request to traverse.
const CHROME_ASSETS: Record<string, string> = {
  "chrome.css": "text/css; charset=utf-8",
  "chrome-client.js": "application/javascript; charset=utf-8"
};

export function chartChromeAsset(name: string): { path: string; contentType: string } | undefined {
  const contentType = CHROME_ASSETS[name];
  if (!contentType) {
    return undefined;
  }
  return {
    path: fileURLToPath(new URL(`../assets/charts/chrome/${name}`, import.meta.url)),
    contentType
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// The chart-review page served at GET /charts/:id/review: the chart in a
// sandboxed iframe with the feedback panel beside it. The vendored
// review shell omits features outside Perch's chart workflow:
// no share/export/publish, no presence inference (the chrome shows the owning
// session's real status from the fleet WebSocket when a bearer token is
// present), no session-end etiquette, no layout-gate curtain. Feedback/layout
// POSTs use a scoped review nonce minted into this token-free HTML; the chart
// iframe itself always loads tokenless.
export function chartReviewHtml(chart: Chart, options: { reviewNonce?: string } = {}): string {
  const sessionJson = JSON.stringify({
    id: chart.id,
    name: chart.name,
    file: chart.file,
    sessionId: chart.sessionId,
    reviewNonce: options.reviewNonce ?? ""
  }).replace(/</g, "\\u003c");
  const name = escapeHtml(chart.name);
  const src = `/charts/${encodeURIComponent(chart.id)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} · Perch</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='38' fill='%23c9a227'/></svg>">
<link rel="stylesheet" href="/charts/chrome/chrome.css">
</head>
<body>
<div class="bar"><div class="brand"><span class="brand-mark">Perch</span><span class="brand-support">Chart room</span></div><div class="chart-name" title="${escapeHtml(chart.file)}">${name}</div><div class="spacer" aria-hidden="true"></div><span class="session-chip" id="sessionChip" data-status="unknown"><span class="chip-dot" aria-hidden="true"></span><span id="sessionChipText">Connecting…</span></span><button class="annotate-switch" id="annotation" type="button" aria-pressed="true" title="Toggle annotate/explore mode (⌘E / Ctrl+E)"><span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span><span>Annotate</span></button></div>
<div class="layout"><div class="frame"><iframe id="chart" title="${name}" sandbox="allow-scripts allow-forms allow-popups allow-downloads" referrerpolicy="no-referrer" data-chart-src="${src}"></iframe><div class="layout-issue-banner" id="layoutIssueBanner" hidden>This chart may have layout issues. The drawing agent has been notified.</div></div><aside class="panel"><h2>Feedback</h2><p class="panel-note">Annotate the chart or write a note, then send. The agent's reply is the chart itself - it live-reloads as the file changes.</p><div class="panel-scroll" id="panelScroll"><div class="chat" id="chatLog"></div><div class="annotation-pills" id="annotationPills"></div></div><div class="composer" aria-label="Send chart feedback"><label class="sr-only" for="chatInput">Feedback for the chart author</label><div class="composer-entry"><textarea id="chatInput" aria-label="Feedback for the chart author" placeholder="Write feedback…"></textarea><button class="button" id="send" type="button" aria-keyshortcuts="Meta+Enter Control+Enter"><span>Send</span><kbd aria-hidden="true">⌘↵</kbd></button></div><div class="composer-meta"><span class="send-hint" id="sendHint" aria-live="polite" hidden>Write a note or annotate an element first.</span><span class="composer-guide">⌘/Ctrl ↵ to send</span></div></div></aside></div>
<script id="perch-chart-session" type="application/json">${sessionJson}</script>
<script src="/charts/chrome/chrome-client.js"></script>
</body>
</html>`;
}

// --- Feedback normalization --------------------------------------------------

// Normalize one annotation into a single readable line. Target shapes follow
// the vendored SDK's contract (element selector, text-range, mermaid-node).
// Mermaid targets are normalized server-side, stripping unknown or hostile fields.
function annotationLine(annotation: ChartAnnotation, index: number): string {
  const prompt = String(annotation.prompt ?? "").trim();
  const quoted = String(annotation.text ?? "").trim().replace(/\s+/g, " ").slice(0, 240);
  const target = annotation.target;
  let where: string;
  if (target && target["type"] === "mermaid-node") {
    const label = String(target["label"] ?? "").trim() || quoted || String(target["nodeId"] ?? "");
    where = `diagram node "${label}"`;
  } else if ((target && target["type"] === "text-range") || annotation.tag === "text") {
    where = `text "${quoted}"`;
  } else {
    const selector = String(annotation.selector ?? "").trim() || "(unlocated)";
    where = quoted ? `${selector} "${quoted}"` : selector;
  }
  return `${index}. ${where}${prompt ? ` - ${prompt}` : ""}`;
}

// The boss's annotations as one composer block:
//   [perch chart] <chart> · <n> notes
export function formatChartFeedback(
  chart: Chart,
  feedback: { message?: string; annotations?: ChartAnnotation[] }
): string {
  const annotations = feedback.annotations ?? [];
  const message = String(feedback.message ?? "").trim();
  const count = annotations.length + (message ? 1 : 0);
  const lines = [`[perch chart] ${chart.name} · ${count} ${count === 1 ? "note" : "notes"}`];
  annotations.forEach((annotation, index) => {
    lines.push(annotationLine(annotation, index + 1));
  });
  if (message) {
    lines.push(annotations.length > 0 ? `${annotations.length + 1}. ${message}` : `1. ${message}`);
  }
  lines.push(`Update the chart file in place (${chart.file}); the review surface live-reloads.`);
  return lines.join("\n");
}

// Layout-audit findings as machine feedback, prefixed so the agent knows this
// is the automated audit speaking, never the boss.
export function formatLayoutWarnings(chart: Chart, warnings: ChartLayoutWarning[]): string {
  const lines = [
    `[perch chart layout] ${chart.name} · ${warnings.length} ${warnings.length === 1 ? "finding" : "findings"} (automated layout audit, not the boss)`
  ];
  for (const warning of warnings) {
    lines.push(
      `- ${warning.kind} at ${warning.selector || "(page)"}: ${warning.overflowPx}px overflow at ${warning.viewportWidth}px viewport (${warning.severity})`
    );
  }
  lines.push(`Fix these in ${chart.file} before asking for review.`);
  return lines.join("\n");
}

// Normalize layout warnings by coercing the SDK's
// report to a fixed shape, dropping anything malformed.
export function normalizeLayoutWarnings(raw: unknown): ChartLayoutWarning[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((warning) => warning && typeof warning === "object" && !Array.isArray(warning))
    .map((warning) => {
      const record = warning as Record<string, unknown>;
      return {
        selector: String(record.selector ?? ""),
        kind: String(record.kind ?? "layout-warning"),
        overflowPx: finiteNumber(record.overflowPx),
        viewportWidth: finiteNumber(record.viewportWidth),
        severity: record.severity === "warning" ? ("warning" as const) : ("error" as const)
      };
    });
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
