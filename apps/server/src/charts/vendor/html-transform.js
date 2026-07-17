// Vendored from lavish-axi v0.1.37 src/html-transform.js (MIT, (c) 2026 Kun Chen - see LICENSE
// in this directory). Perch-owned since 2026-07-07; do not track upstream.
export function injectLavishSdk(html, key) {
  const script = `<script src="/sdk.js?key=${encodeURIComponent(key)}"></script>`;
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${script}</body>`);
  }
  return `${html}\n${script}`;
}
