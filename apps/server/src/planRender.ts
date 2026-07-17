import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Rendering a committed plan doc in the fixed chart styling.
// A plan is markdown, not an HTML file like a chart, so the server converts it
// to the same bare-element vocabulary chart.css styles (h1-h4, p, ul/ol, li,
// strong/em, code, pre, blockquote, hr, and .table-wrap around tables) and
// wraps it in a page that links the perch-owned chart.css. Read-only: this
// never writes anywhere, and the resolver confines reads to tracked projects.

// Resolve a requested plan path to a real .md file that lives directly under
// some tracked project's docs/plans/. Accepts the absolute path the hub lists
// (ChartPlanDoc.path) or a repo-relative docs/plans/<name>.md. Returns the
// canonical path, or null when it escapes every tracked project's docs/plans,
// is not a flat child of it, does not exist, or is not a .md file. realpath
// collapses symlink games before and after, so a link out of docs/plans cannot
// smuggle a read.
export function resolvePlanDocPath(requested: string, projectRoots: string[]): string | null {
  const wanted = requested.trim();
  if (!wanted || wanted.includes("\0")) {
    return null;
  }
  for (const root of projectRoots) {
    const plansDir = resolve(root, "docs", "plans");
    const candidate = isAbsolute(wanted) ? resolve(wanted) : resolve(root, wanted);
    if (!isFlatChild(plansDir, candidate) || !/\.md$/i.test(candidate)) {
      continue;
    }
    let canonical: string;
    try {
      canonical = realpathSync(candidate);
      if (!statSync(canonical).isFile()) {
        continue;
      }
    } catch {
      continue;
    }
    // Re-confine after realpath: a symlink inside docs/plans pointing elsewhere
    // must not resolve to a file outside the real docs/plans dir.
    let realDir: string;
    try {
      realDir = realpathSync(plansDir);
    } catch {
      continue;
    }
    if (!isFlatChild(realDir, canonical)) {
      continue;
    }
    return canonical;
  }
  return null;
}

// candidate is a direct child of dir (docs/plans is flat by convention): no
// traversal, no nested subdirectory.
function isFlatChild(dir: string, candidate: string): boolean {
  const rel = relative(dir, candidate);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel) && !rel.includes(sep);
}

// A plan doc's markdown as a standalone chart-styled HTML page. The title is
// the first `# ` heading, else the filename.
//
// The theme CSS is INLINED (not a `<link href="chart.css">`), because the phone
// loads this document as a bare string with no base URL (PlanReviewView's
// WKWebView: `loadHTMLString(html, baseURL: nil)`), so a relative stylesheet
// href can never resolve there - it would render UA-default black ink on the
// dark canvas, unreadable. Inlining the same Oro Nero tokens chart.css uses
// makes the page self-contained: it paints its own `--canvas` background and
// `--text` ink, so it reads correctly regardless of the host webview's light or
// dark scheme (the `color-scheme` meta keeps UA chrome like scrollbars dark to
// match). This is the plan twin of injectChartSdk's self-containment for charts.
export function renderPlanHtml(markdown: string, file: string): string {
  const title = planTitle(markdown) ?? basename(file).replace(/\.md$/i, "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(title)} · Perch</title>
<style>
${planStyles()}
</style>
</head>
<body>
${markdownToHtml(markdown)}
</body>
</html>`;
}

// The chart stylesheet, read once and cached, for inlining into the plan page.
// It is the very stylesheet http serves at /charts/chart.css (charts.ts'
// chartCssPath resolves the same asset the same way), so a plan looks pixel-for-
// pixel like a chart. If the asset is somehow unreadable we fall back to a
// minimal themed block rather than shipping an unstyled (dark-on-dark) page -
// legibility must never depend on an optional file read.
let cachedPlanStyles: string | undefined;
function planStyles(): string {
  if (cachedPlanStyles !== undefined) {
    return cachedPlanStyles;
  }
  try {
    const cssPath = fileURLToPath(new URL("../assets/charts/chart.css", import.meta.url));
    cachedPlanStyles = readFileSync(cssPath, "utf8");
  } catch {
    cachedPlanStyles = FALLBACK_PLAN_STYLES;
  }
  return cachedPlanStyles;
}

// Last-resort theme if chart.css cannot be read: the essential Oro Nero tokens
// and prose colors so heading + body + lists keep contrast on the dark canvas.
// Matches chart.css' palette (apps/server/assets/charts/chart.css); it is a
// safety net, not the primary look.
const FALLBACK_PLAN_STYLES = `:root {
  --canvas: #0a0908;
  --text: #e9e2d0;
  --text-2: #a89f8c;
  --text-3: #6f685a;
  --gold: #c9a227;
  --hairline: #2a251f;
  --inline-code: #262019;
}
html, body { background: var(--canvas); }
body {
  margin: 0 auto;
  max-width: 46rem;
  padding: 2rem 1.4rem 4rem;
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.65;
}
h1, h2, h3, h4 { color: var(--text); }
a { color: var(--gold); }
strong { color: var(--text); }
li::marker { color: var(--text-3); }
code, pre { background: var(--inline-code); color: var(--text); }
blockquote { color: var(--text-2); border-left: 3px solid var(--hairline); padding-left: 1.1em; }`;

function planTitle(markdown: string): string | undefined {
  for (const line of markdown.split("\n")) {
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    if (heading) {
      return heading[1];
    }
  }
  return undefined;
}

// A small, dependency-free Markdown renderer covering exactly what plan docs
// use: ATX headings, paragraphs, unordered/ordered lists, fenced code, inline
// code, bold/italic, links, blockquotes, horizontal rules, and GFM pipe
// tables. Everything is HTML-escaped; unrecognized syntax degrades to text.
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    const fence = /^(```|~~~)/.exec(line);
    if (fence) {
      const marker = fence[1] ?? "```";
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").startsWith(marker)) {
        code.push(lines[i] ?? "");
        i++;
      }
      if (i < lines.length) {
        i++; // closing fence
      }
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min((heading[1] ?? "#").length, 4);
      out.push(`<h${level}>${inline((heading[2] ?? "").trim())}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? "")) {
        quote.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${markdownToHtml(quote.join("\n"))}</blockquote>`);
      continue;
    }
    if (line.includes("|") && isTableSeparator(lines[i + 1] ?? "")) {
      const headers = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (
        i < lines.length &&
        (lines[i] ?? "").includes("|") &&
        !/^\s*$/.test(lines[i] ?? "") &&
        !isBlockStart(lines[i] ?? "")
      ) {
        rows.push(splitTableRow(lines[i] ?? ""));
        i++;
      }
      const thead = `<thead><tr>${headers.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody>`;
      out.push(`<div class="table-wrap"><table>${thead}${tbody}</table></div>`);
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i] ?? "")) {
        items.push(`<li>${inline((lines[i] ?? "").replace(/^\s*([-*+]|\d+\.)\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i] ?? "") && !isBlockStart(lines[i] ?? "")) {
      para.push(lines[i] ?? "");
      i++;
    }
    out.push(`<p>${inline(para.join(" ").trim())}</p>`);
  }
  return out.join("\n");
}

function isBlockStart(line: string): boolean {
  return (
    /^(#{1,6})\s+/.test(line) ||
    /^(```|~~~)/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*([-*+]|\d+\.)\s+/.test(line) ||
    /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)
  );
}

function isTableSeparator(line: string): boolean {
  return line.includes("-") && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
}

function splitTableRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

// Inline formatting on one text run. Code spans are pulled out first (into a
// U+0000-delimited placeholder that never appears in a plan doc, so restoring
// it cannot collide with real digits in the prose like "step 4") so their
// contents are never treated as bold/italic/link markup; the rest is then
// escaped and formatted, and finally the code spans are restored.
function inline(text: string): string {
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, label: string, href: string) =>
      `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, idx: string) => codes[Number(idx)] ?? "");
  return s;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
