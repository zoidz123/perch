import assert from "node:assert/strict";
import { test } from "node:test";
import type { Chart, ChartsHubResponse } from "@perch/shared";
import { renderChartsGalleryHtml } from "./chartsGallery.js";

function chart(overrides: Partial<Chart> & Pick<Chart, "id" | "name">): Chart {
  return {
    file: `/tmp/${overrides.id}.html`,
    sessionId: "sess-1",
    registeredAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-08T12:30:00.000Z",
    ...overrides
  };
}

test("renderChartsGalleryHtml groups by project, keeps chart links tokenless, and carries plan auth", () => {
  const hub: ChartsHubResponse = {
    projects: [
      {
        rootPath: "/workspace/project",
        name: "perch",
        charts: [
          chart({ id: "abc123", name: "pipeline-sketch", status: "draft", taskTitle: "Charts phase 2" }),
          chart({ id: "def456", name: "hub-model", status: "finalized" })
        ],
        plans: [
          {
            path: "/workspace/project/docs/plans/2026-01-02-example.md",
            relativePath: "docs/plans/2026-01-02-example.md",
            title: "Example plan",
            date: "2026-01-02"
          }
        ]
      }
    ],
    ungrouped: []
  };

  const html = renderChartsGalleryHtml(hub, "secret-token");

  // A real page in the fixed chart look: links the perch-owned stylesheet, no
  // <style> blocks, no inline styles.
  assert.match(html, /<link rel="stylesheet" href="\/charts\/chart\.css">/);
  assert.doesNotMatch(html, /<style/);
  assert.doesNotMatch(html, /style=/);

  // Project grouping: name as an <h2>, root path in the count line.
  assert.match(html, /<h2>perch<\/h2>/);
  assert.match(html, /\/workspace\/project/);

  // A chart links to its existing review room without carrying a bearer token.
  assert.match(html, /href="\/charts\/abc123\/review"/);
  assert.doesNotMatch(html, /href="\/charts\/abc123\/review\?token=secret-token"/);
  assert.match(html, /pipeline-sketch/);
  // Status badges use the documented .badge vocabulary.
  assert.match(html, /<span class="badge good">Finalized<\/span>/);
  assert.match(html, /<span class="badge">Draft<\/span>/);
  // The owning task title surfaces in the meta line.
  assert.match(html, /Charts phase 2/);

  // A plan links to the plan-render endpoint with auth because it is server-rendered, read-only HTML.
  assert.match(
    html,
    /href="\/charts\/plan\?path=docs%2Fplans%2F2026-01-02-example\.md&amp;token=secret-token"/
  );
  assert.match(html, /<span class="badge info">Plan<\/span>/);
  assert.match(html, /Example plan/);

  // Header totals.
  assert.match(html, /2 charts/);
  assert.match(html, /1 plan\b/);
  assert.match(html, /1 project\b/);
});

test("renderChartsGalleryHtml surfaces ungrouped charts under their own section", () => {
  const hub: ChartsHubResponse = {
    projects: [],
    ungrouped: [chart({ id: "solo9", name: "mate-scratch", status: "draft" })]
  };

  const html = renderChartsGalleryHtml(hub);

  assert.match(html, /<h2>Ungrouped<\/h2>/);
  assert.match(html, /href="\/charts\/solo9\/review"/);
  assert.doesNotMatch(html, /token=tok/);
  assert.match(html, /mate-scratch/);
});

test("renderChartsGalleryHtml shows an empty state when nothing is registered", () => {
  const html = renderChartsGalleryHtml({ projects: [], ungrouped: [] });
  assert.match(html, /class="gallery-empty"/);
  assert.match(html, /No charts or plans yet/);
  // Empty page still carries no stray link with a dangling token separator.
  assert.doesNotMatch(html, /token=tok/);
});

test("renderChartsGalleryHtml omits the token from links when none is supplied", () => {
  const hub: ChartsHubResponse = {
    projects: [],
    ungrouped: [chart({ id: "x1", name: "n" })]
  };
  const html = renderChartsGalleryHtml(hub);
  assert.match(html, /href="\/charts\/x1\/review"/);
  assert.doesNotMatch(html, /token=/);
});

test("renderChartsGalleryHtml escapes chart names and marks archived charts", () => {
  const hub: ChartsHubResponse = {
    projects: [],
    ungrouped: [chart({ id: "y2", name: "<b>xss</b> & co", archived: true, status: "draft" })]
  };
  const html = renderChartsGalleryHtml(hub);
  assert.match(html, /&lt;b&gt;xss&lt;\/b&gt; &amp; co/);
  assert.doesNotMatch(html, /<b>xss<\/b>/);
  assert.match(html, /<span class="badge">Archived<\/span>/);
});
