import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { markdownToHtml, renderPlanHtml, resolvePlanDocPath } from "./planRender.js";

test("markdownToHtml renders the plan-doc vocabulary into bare chart.css elements", () => {
  const md = [
    "# Title",
    "",
    "## Section",
    "",
    "A paragraph with **bold**, *italic*, `code`, and a [link](https://x.dev/p).",
    "",
    "- one",
    "- two",
    "",
    "1. first",
    "2. second",
    "",
    "> a quote",
    "",
    "```",
    "const x = 1 < 2;",
    "```",
    "",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "---"
  ].join("\n");
  const html = markdownToHtml(md);

  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<h2>Section<\/h2>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/x\.dev\/p" target="_blank" rel="noopener noreferrer">link<\/a>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<blockquote>[\s\S]*a quote[\s\S]*<\/blockquote>/);
  // Code fences are escaped, not interpreted.
  assert.match(html, /<pre><code>const x = 1 &lt; 2;<\/code><\/pre>/);
  // Tables are wrapped for horizontal scroll, like chart.css expects.
  assert.match(html, /<div class="table-wrap"><table><thead><tr><th>A<\/th><th>B<\/th>/);
  assert.match(html, /<tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody>/);
  assert.match(html, /<hr>/);
});

test("inline code protection never collides with real digits in prose", () => {
  // "step 4" must survive verbatim even though the code-span placeholder is
  // digit-based internally.
  const html = markdownToHtml("we are three steps in and step 4 needs `a fix` now");
  assert.match(html, /step 4 needs <code>a fix<\/code> now/);
});

test("markdownToHtml escapes raw HTML in prose", () => {
  const html = markdownToHtml("beware <script>alert(1)</script> & co");
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp; co/);
});

test("renderPlanHtml inlines the perch chart theme and titles from the first H1", () => {
  const page = renderPlanHtml("# My Plan\n\nbody\n", "/x/docs/plans/2026-07-08-my-plan.md");
  // Self-contained: the theme is INLINED, never a relative <link>. The phone
  // loads this string with baseURL nil, so a linked chart.css could not resolve
  // and the doc would render UA-default dark ink on the dark canvas.
  assert.doesNotMatch(page, /<link[^>]+stylesheet/i);
  assert.match(page, /<style>[\s\S]*<\/style>/);
  assert.match(page, /<title>My Plan · Perch<\/title>/);
  // Falls back to the filename (minus date/ext) when the doc has no H1.
  const noHeading = renderPlanHtml("just text\n", "/x/docs/plans/2026-07-08-my-plan.md");
  assert.match(noHeading, /<title>2026-07-08-my-plan · Perch<\/title>/);
});

test("renderPlanHtml is legible on the dark canvas: inlined theme paints its own bg + ink", () => {
  const page = renderPlanHtml("# My Plan\n\n## Section\n\nbody text\n", "/x/docs/plans/2026-07-08-my-plan.md");
  // The Oro Nero tokens ship inline (cream ink + near-black canvas), and the
  // body binds ink to --text over the --canvas background - so heading, body,
  // and lists keep contrast whether the host webview is light or dark. This is
  // the regression guard for the dark-on-dark plan bug.
  assert.match(page, /--text:\s*#e9e2d0/);
  assert.match(page, /--canvas:\s*#0a0908/);
  assert.match(page, /color:\s*var\(--text\)/);
  assert.match(page, /background:\s*var\(--canvas\)/);
  // color-scheme meta keeps UA chrome (scrollbars, form controls) dark to match.
  assert.match(page, /<meta name="color-scheme" content="dark">/);
});

test("resolvePlanDocPath confines reads to tracked projects' docs/plans", () => {
  const home = mkdtempSync(join(tmpdir(), "perch-planpath-"));
  const repo = join(home, "repo");
  const plansDir = join(repo, "docs", "plans");
  mkdirSync(plansDir, { recursive: true });
  const rel = "docs/plans/2026-07-08-hub.md";
  const abs = join(plansDir, "2026-07-08-hub.md");
  writeFileSync(abs, "# Hub\n");
  // A secret outside docs/plans, and a symlink into docs/plans pointing at it.
  const secret = join(home, "secret.md");
  writeFileSync(secret, "# secret\n");
  symlinkSync(secret, join(plansDir, "link.md"));

  const roots = [repo];
  const canonical = realpathSync(abs); // macOS resolves /var -> /private/var
  // The repo-relative form and the absolute form both resolve to the real file.
  assert.equal(resolvePlanDocPath(rel, roots), canonical);
  assert.equal(resolvePlanDocPath(abs, roots), canonical);

  // Traversal, non-.md, nested subdir, and a missing file all refuse.
  assert.equal(resolvePlanDocPath("docs/plans/../../secret.md", roots), null);
  assert.equal(resolvePlanDocPath("docs/plans/nested/x.md", roots), null);
  assert.equal(resolvePlanDocPath("docs/plans/hub.txt", roots), null);
  assert.equal(resolvePlanDocPath("docs/plans/missing.md", roots), null);
  // A symlink out of docs/plans is refused (realpath re-confinement).
  assert.equal(resolvePlanDocPath("docs/plans/link.md", roots), null);
  // An untracked project's own docs/plans is out of reach.
  assert.equal(resolvePlanDocPath(abs, ["/some/other/repo"]), null);

  rmSync(home, { recursive: true, force: true });
});
