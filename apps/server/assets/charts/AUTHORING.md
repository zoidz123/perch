# Drawing charts

A chart is a single HTML file the boss reviews and annotates.
Every chart renders in one fixed look - the app's own Oro Nero styling: warm near-black canvas, cream text, serif display titles, gold accents - defined by `chart.css`.
You write content against the small class vocabulary below and nothing else.

## Hard rules

- **No `<style>` blocks.** Ever.
- **No `style=` attributes.** Ever.
- **No external design systems.** No Tailwind, no DaisyUI, no font CDNs, no icon sets.
- Do not invent classes; if the vocabulary below cannot express something, use the closest semantic HTML element instead.
- Gold is rationed.
  The stylesheet already spends it (title rule, links); never add more gold yourself.
  If a chart shows more than a few gold elements, something is wrong.

## File setup

Start every chart like this:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Short chart title</title>
<link rel="stylesheet" href="chart.css">
</head>
<body>
```

When the chart is served by perch, the relative `chart.css` link resolves to the server's own copy automatically.
Copy `apps/server/assets/charts/chart.css` next to your chart file only if the file must also open directly from disk.

`reference.html` in this directory is a complete terse example; read it once before writing your first chart.

## Register and iterate

Write the file to `.charts/<slug>.html` in your workspace (keep it out of commits; the mate uses `~/.perch/mate/charts/`), then register it once with your session's hook token (already in your provider-session environment):

```sh
curl -sf -X POST "${PERCH_HOOK_URL%/hooks}/charts" \
  -H "x-perch-session: $PERCH_SESSION_ID" -H "x-perch-token: $PERCH_HOOK_TOKEN" \
  -H "content-type: application/json" -d '{"file":"<absolute path to the .html file>"}'
```

Registration notifies the boss, and edits to the file refresh the open review live.
Register each chart once.
Re-registering the same path starts a new review identity so old worktree-slot charts keep their owner, snapshot, and status.
Boss feedback arrives in your composer as a `[perch chart]` block.
Layout-audit warnings arrive the same way, marked as machine feedback - fix those before the boss is asked to review.

## Where charts live

A chart is a working document, not repo content.
On registration the server keeps the canonical copy under `~/.perch/charts/` - per-install state, like the task ledger, that survives worktree teardown.
When the boss approves a chart as a plan, approval is the promotion: the worker implementing it converts the approved chart's content into a markdown plan doc committed to the target project's repo (`docs/plans/<date>-<name>.md`, or that project's docs convention) as the first commit of the implementation branch, then builds against it.
Scratchpad centrally, canon per-repo.
(Perch's own `docs/plans/*.md` is one such convention, not a product mechanism.)

## Title block

Open the body with a `.chart-header`:

```html
<header class="chart-header">
  <h1>One decisive verdict</h1>
  <p class="meta">
    <span class="badge good">Active</span>
    <span>One supporting fact</span>
  </p>
</header>
```

- The `<h1>` is the chart's required decisive top line.
- `.eyebrow` - optional small uppercase kicker when the boss asks for one.
- `.subtitle` - optional italic serif line when the boss asks for framing.
- `.meta` - optional wrapping row of short facts or badges, separated visually by gaps.

## Prose

Plain elements are already styled; no classes needed.

- `<h2>` starts a new section (it draws its own hairline rule above).
- `<h3>` is a subsection heading; `<h4>` is a small uppercase label heading.
- `<p>` only for a required single-line decision or open question; never use it for narrative.
- `<ul>`, `<ol>`, `<strong>`, `<em>`, `<a>` as usual.
- `<blockquote>` for the one line you want the reader to remember.
- `<hr>` is a short centered divider for a hard break in the document.

## Cards

A responsive grid of bordered panel cards.
Use for facts that read side by side: components, risks, options.

```html
<div class="cards">
  <div class="card">
    <h4>Registry</h4>
    <ul><li>One short finding.</li></ul>
  </div>
  <div class="card warn">
    <h4>A risk</h4>
    <ul><li>One short recommendation.</li></ul>
  </div>
</div>
```

Tone modifiers on `.card`: `good`, `warn`, `risk`, `info` (tinted background plus a colored left edge).

## Comparison columns

Side-by-side columns for before/after or option A/option B.
Each column opens with an `<h3>` and gets a heavy top rule; tones recolor the rule.

```html
<div class="columns">
  <div class="col">
    <h3>Today</h3>
    <ul><li>...</li></ul>
  </div>
  <div class="col good">
    <h3>With charts</h3>
    <ul><li>...</li></ul>
  </div>
</div>
```

Columns stack on narrow screens automatically.

## Tables

Plain `<table>` with `<thead>`/`<tbody>` is fully styled.
Wrap any table that could be wide in `.table-wrap` so it scrolls sideways instead of breaking the page:

```html
<div class="table-wrap">
  <table>
    <thead><tr><th>Task</th><th>State</th></tr></thead>
    <tbody><tr><td>T1</td><td><span class="badge warn">In review</span></td></tr></tbody>
  </table>
</div>
```

## Badges

Small uppercase status labels, inline anywhere (meta rows, table cells, prose).

```html
<span class="badge">Queued</span>
<span class="badge good">Done</span>
<span class="badge warn">In review</span>
<span class="badge risk">Blocked</span>
<span class="badge info">Working</span>
```

## Code

Inline `<code>` and block `<pre><code>...</code></pre>` are styled.
Block code scrolls horizontally; never let it force the page wider.
Remember to HTML-escape `<` and `&` inside code.

## Diagrams (Mermaid)

Put Mermaid source in `<pre class="mermaid">` inside a `figure.figure`, with an optional `<figcaption>`:

```html
<figure class="figure">
  <pre class="mermaid">
flowchart LR
  a["Crew"] --> b["Boss"]
  </pre>
  <figcaption>One line saying what the diagram shows.</figcaption>
</figure>
```

The `.figure` frame scrolls horizontally if the diagram is wide.
Until the diagram is rendered, the source displays as a quiet code block.

To render, include this snippet once at the end of `<body>` (this exact snippet is the only script a chart may carry; the theme variables keep the diagram on palette):

```html
<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
  mermaid.initialize({
    startOnLoad: true,
    securityLevel: "strict",
    flowchart: { useMaxWidth: false },
    theme: "base",
    themeVariables: {
      darkMode: true,
      background: "transparent",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif",
      fontSize: "14px",
      primaryColor: "#211d18",
      primaryTextColor: "#e9e2d0",
      primaryBorderColor: "#6f685a",
      lineColor: "#a89f8c",
      secondaryColor: "#191613",
      tertiaryColor: "#141210",
      clusterBkg: "#141210",
      edgeLabelBackground: "#0a0908"
    }
  });
</script>
```

## Content shapes

A chart is a 15-second review surface.
Make the answer obvious without scrolling.

Use this order:

1. **Verdict / Answer** - put one decisive line at the very top.
2. **Problem / Findings** - use at most four short bullets.
3. **Fix / Recommendation** - use at most four short bullets.
4. **Open question / Decision** - optionally end with one short line.

Keep the entire chart to one screen.
Cut content until a reader can get the point in about 15 seconds.

Do not include:

- Narrative prose paragraphs.
- Restated background or context.
- Evidence dumps; link the evidence or drop it.
- ELI5 explanations or analogies unless the boss explicitly asks for them.

Prefer bullets, short cards, and tables over paragraphs.
Reserve `<blockquote>` for one key line only.

## Layout discipline

- The page must never scroll horizontally; wide things (tables, code, diagrams) scroll inside their own wrapper.
- Keep charts one column and to one screen of content; a chart is a review surface, not documentation.
- Use tone colors to mean something (state, risk), never for decoration.
