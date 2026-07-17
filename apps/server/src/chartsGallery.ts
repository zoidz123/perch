import type { Chart, ChartPlanDoc, ChartsHubProject, ChartsHubResponse } from "@perch/shared";

// The desktop Charts gallery: a server-rendered browse page over the
// same unified hub listing the mobile sheet consumes. Everything across every
// tracked project in one place, grouped by project, each entry a link to its
// existing chart-review room or the plan-render page. Rendered in the one fixed
// perch chart look via chart.css and its documented classes (plus the
// clearly-scoped `.gallery-*` layout classes) - no <style> blocks, no inline
// styles, matching planRender.ts's approach.

// Build a gallery page for the whole hub. Chart review links stay tokenless:
// local desktop review GETs remain easy, and bearer tokens never reach
// chart-authored documents through query strings, iframe URLs, or referrers.
// Plan links may carry the gallery token because they render read-only,
// server-authored HTML and do not host chart-authored JavaScript.
export function renderChartsGalleryHtml(hub: ChartsHubResponse, token = ""): string {
  const projects = hub.projects ?? [];
  const ungrouped = hub.ungrouped ?? [];
  const totalCharts =
    projects.reduce((sum, project) => sum + project.charts.length, 0) + ungrouped.length;
  const totalPlans = projects.reduce((sum, project) => sum + project.plans.length, 0);

  const sections: string[] = [];
  for (const project of projects) {
    sections.push(renderProject(project, token));
  }
  if (ungrouped.length > 0) {
    sections.push(renderUngrouped(ungrouped));
  }
  const bodyContent =
    sections.length > 0
      ? sections.join("\n")
      : `<p class="gallery-empty">No charts or plans yet. An agent registers a chart with the <code>chart</code> verb; a committed <code>docs/plans/*.md</code> shows up as a plan.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Charts · Perch</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='38' fill='%23c9a227'/></svg>">
<link rel="stylesheet" href="/charts/chart.css">
</head>
<body>
<header class="chart-header">
<span class="eyebrow">Perch · Charts</span>
<h1>Charts gallery</h1>
<p class="subtitle">Every chart and plan across your projects, in one place.</p>
<p class="meta"><span>${count(totalCharts, "chart", "charts")}</span><span>${count(totalPlans, "plan", "plans")}</span><span>${count(projects.length, "project", "projects")}</span></p>
</header>
${bodyContent}
</body>
</html>`;
}

function renderProject(project: ChartsHubProject, token: string): string {
  const entries: string[] = [];
  for (const chart of project.charts) {
    entries.push(chartEntry(chart));
  }
  for (const plan of project.plans) {
    entries.push(planEntry(plan, token));
  }
  const list =
    entries.length > 0
      ? `<ul class="gallery-list">${entries.join("")}</ul>`
      : `<p class="gallery-empty">No charts or plans in this project.</p>`;
  return `<h2>${escapeHtml(project.name)}</h2>
<p class="gallery-count">${escapeHtml(project.rootPath)} · ${count(project.charts.length, "chart", "charts")} · ${count(project.plans.length, "plan", "plans")}</p>
${list}`;
}

// Charts that resolve to no tracked project (the mate's solo charts, drawn
// outside a task) - surfaced separately, exactly as the mobile hub does.
function renderUngrouped(charts: Chart[]): string {
  const entries = charts.map((chart) => chartEntry(chart)).join("");
  return `<h2>Ungrouped</h2>
<p class="gallery-count">Charts not linked to a tracked project · ${count(charts.length, "chart", "charts")}</p>
<ul class="gallery-list">${entries}</ul>`;
}

function chartEntry(chart: Chart): string {
  const href = `/charts/${encodeURIComponent(chart.id)}/review`;
  const badges: string[] = [];
  badges.push(
    chart.status === "finalized"
      ? `<span class="badge good">Finalized</span>`
      : `<span class="badge">Draft</span>`
  );
  if (chart.archived) {
    badges.push(`<span class="badge">Archived</span>`);
  }
  const meta: string[] = [];
  if (chart.taskTitle) {
    meta.push(escapeHtml(chart.taskTitle));
  }
  const updated = dateOnly(chart.updatedAt);
  if (updated) {
    meta.push(`updated ${updated}`);
  }
  return item(href, chart.name, meta.join(" · "), badges.join(""));
}

function planEntry(plan: ChartPlanDoc, token: string): string {
  const href = withToken(`/charts/plan?path=${encodeURIComponent(plan.relativePath)}`, token);
  const meta: string[] = [plan.relativePath];
  if (plan.date) {
    meta.push(plan.date);
  }
  return item(href, plan.title, meta.join(" · "), `<span class="badge info">Plan</span>`);
}

// One clickable row: title + a muted meta line on the left, status badges on
// the right. The whole row is the anchor (the `.gallery-item` class resets the
// gold link styling so rows stay quiet - gold stays rationed to the title rule).
function item(href: string, title: string, meta: string, badges: string): string {
  const metaHtml = meta ? `<div class="gallery-item-meta">${escapeHtml(meta)}</div>` : "";
  return `<li><a class="gallery-item" href="${escapeAttr(href)}"><span class="gallery-item-main"><span class="gallery-item-title">${escapeHtml(
    title
  )}</span>${metaHtml}</span><span class="gallery-item-aside">${badges}</span></a></li>`;
}

function withToken(path: string, token: string): string {
  if (!token) {
    return path;
  }
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}token=${encodeURIComponent(token)}`;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ISO timestamp -> YYYY-MM-DD (the gallery shows the day, not the clock, so it
// reads the same regardless of the viewer's locale). Empty for a missing or
// unparseable value.
function dateOnly(iso: string | undefined): string {
  if (!iso) {
    return "";
  }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return match ? match[1] ?? "" : "";
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
