import SwiftUI
import UIKit
import WebKit

// The chart document surface: a WKWebView loading the SDK-injected chart over
// a custom scheme so EVERY request (document, chart.css, sibling assets) is
// fetched natively through PerchStore - plain authed HTTP on LAN, tunneled
// RPC JSON on the relay. The phone never needs the server to be a browsable
// HTTP origin, which is exactly the relay constraint.
//
// Touch targeting: the desktop SDK's hover + in-page annotation card is
// switched off; an injected script owns tap-to-select and forwards the SDK's
// canonical annotation payloads (selector, text-range, Mermaid node) to the
// native chrome over WKScriptMessageHandler.

// What the boss currently has selected in the page, mirrored natively for the
// confirm pill.
struct ChartSelection: Equatable {
    enum Kind { case element, text }
    let kind: Kind
    let tag: String
    let text: String

    var label: String {
        switch kind {
        case .text:
            return "Text"
        case .element:
            switch tag {
            case "mermaid-node": return "Diagram node"
            case "table", "thead", "tbody", "tr": return "Table"
            case "figure": return "Figure"
            case "ul", "ol", "dl": return "List"
            case "pre": return "Code block"
            case "header": return "Header"
            case "section", "div": return "Section"
            default: return "Component"
            }
        }
    }
}

// Owns the WKWebView plumbing shared between the representable and the review
// screen: script messages in, evaluateJavaScript out.
@MainActor
final class ChartBridge: NSObject, ObservableObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    var onLayoutWarnings: (([Any]) -> Void)?

    // The target of the current press-and-hold, mirrored for the composer.
    @Published var selection: ChartSelection?
    // Bumped when a hold lands on a target: the view opens the note composer
    // right there (no intermediate pill - the hold IS the intent).
    @Published var composeToken: UUID?
    @Published var pendingNotes: [ChartAnnotationDraft] = []
    @Published var loadFailed = false

    // The gesture layer is always live (taps stay inert, so it is safe); this
    // is re-asserted after every load to beat the load/evaluate race.
    private var activeState = true
    private let hold = UIImpactFeedbackGenerator(style: .medium)

    nonisolated func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        let body = message.body
        Task { @MainActor [weak self] in
            self?.handle(body)
        }
    }

    private func handle(_ body: Any) {
        guard let dict = body as? [String: Any], let type = dict["type"] as? String else {
            return
        }
        switch type {
        case "holdTargeted":
            let kind: ChartSelection.Kind = dict["kind"] as? String == "text" ? .text : .element
            selection = ChartSelection(
                kind: kind,
                tag: dict["tag"] as? String ?? "element",
                text: dict["text"] as? String ?? ""
            )
            hold.impactOccurred()
            composeToken = UUID()
        case "cleared":
            selection = nil
        case "annotation":
            if let draft = ChartAnnotationDraft(raw: dict["annotation"]) {
                pendingNotes.append(draft)
            }
        case "layoutWarnings":
            if let warnings = dict["warnings"] as? [Any] {
                onLayoutWarnings?(warnings)
            }
        default:
            break
        }
    }

    func setAnnotate(_ enabled: Bool) {
        activeState = enabled
        evaluate("window.__perchChart && window.__perchChart.setAnnotate(\(enabled))")
    }

    // Re-assert the gesture state once the document (and its injected script)
    // has actually loaded: the review view's initial setAnnotate can run
    // before window.__perchChart exists, and every live reload starts fresh.
    func reapplyState() {
        evaluate("window.__perchChart && window.__perchChart.setAnnotate(\(activeState))")
    }

    func submitNote(_ prompt: String) {
        // JSON-encode through an array so the prompt is always a safe JS
        // string literal, whatever the boss typed.
        guard
            let data = try? JSONSerialization.data(withJSONObject: [prompt]),
            let literal = String(data: data, encoding: .utf8)
        else {
            return
        }
        evaluate("window.__perchChart && window.__perchChart.submitNote(\(literal)[0])")
    }

    func clearSelection() {
        evaluate("window.__perchChart && window.__perchChart.clearSelection()")
    }

    func reload() {
        webView?.reload()
    }

    // The user content controller retains its message handler, and the web
    // view retains the controller; break the cycle when the screen closes.
    func teardown() {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "perch")
        webView = nil
    }

    private func evaluate(_ script: String) {
        webView?.evaluateJavaScript(script) { _, _ in }
    }
}

struct ChartWebView: UIViewRepresentable {
    let chart: ChartModel
    @ObservedObject var bridge: ChartBridge
    let store: PerchStore

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(
            ChartSchemeHandler(store: store, chartId: chart.id),
            forURLScheme: "perch-chart"
        )
        configuration.userContentController.add(bridge, name: "perch")
        configuration.userContentController.addUserScript(
            WKUserScript(source: ChartTouchScript.source, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        )

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = UIColor(Style.canvas)
        webView.scrollView.backgroundColor = UIColor(Style.canvas)
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        webView.isInspectable = true
        #endif
        webView.navigationDelegate = context.coordinator
        bridge.webView = webView

        if let url = URL(string: "perch-chart://charts/\(chart.id)/index.html") {
            webView.load(URLRequest(url: url))
        }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(bridge: bridge)
    }

    // Keep the surface a document viewer: the chart itself navigates only
    // within its own scheme; external links open in Safari.
    final class Coordinator: NSObject, WKNavigationDelegate {
        let bridge: ChartBridge

        init(bridge: ChartBridge) {
            self.bridge = bridge
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }
            if url.scheme == "perch-chart" {
                decisionHandler(.allow)
                return
            }
            if navigationAction.navigationType == .linkActivated,
               url.scheme == "http" || url.scheme == "https" {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            // The injected script now exists: arm the gesture layer to match
            // the view's state (fixes the initial no-op setAnnotate race).
            Task { @MainActor in
                self.bridge.loadFailed = false
                self.bridge.reapplyState()
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            Task { @MainActor in
                self.bridge.loadFailed = true
            }
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            Task { @MainActor in
                self.bridge.loadFailed = true
            }
        }
    }
}

// Serves perch-chart://charts/<id>/<resource> by fetching through the store,
// so the document works identically on LAN and over the relay. WebKit calls
// the handler on the main thread; all state stays MainActor-bound.
@MainActor
private final class ChartSchemeHandler: NSObject, @preconcurrency WKURLSchemeHandler {
    private let store: PerchStore
    private let chartId: String
    // Live tasks keyed by scheme task identity: a stopped task must never be
    // touched again (WebKit crashes on didReceive-after-stop).
    private var live: [ObjectIdentifier: Task<Void, Never>] = [:]

    init(store: PerchStore, chartId: String) {
        self.store = store
        self.chartId = chartId
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let key = ObjectIdentifier(urlSchemeTask)
        live[key] = Task { [weak self] in
            await self?.serve(urlSchemeTask, key: key)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        live.removeValue(forKey: ObjectIdentifier(urlSchemeTask))?.cancel()
    }

    private func serve(_ task: WKURLSchemeTask, key: ObjectIdentifier) async {
        guard let url = task.request.url else {
            finish(task, key: key) { $0.didFailWithError(URLError(.badURL)) }
            return
        }
        // Path shape: /<chartId>/<resource...>; the document is index.html.
        let parts = url.path.split(separator: "/", maxSplits: 1).map(String.init)
        let requestedChart = parts.first ?? chartId
        let resource = parts.count > 1 ? parts[1] : "index.html"
        do {
            let data: Data
            let mime: String
            if resource == "index.html" || resource.isEmpty {
                let html = try await store.chartHtml(requestedChart)
                data = Data(html.utf8)
                mime = "text/html"
            } else {
                let asset = try await store.chartAsset(requestedChart, path: resource)
                data = asset.data
                mime = String(asset.contentType.split(separator: ";").first ?? "application/octet-stream")
                    .trimmingCharacters(in: .whitespaces)
            }
            let response = URLResponse(
                url: url,
                mimeType: mime,
                expectedContentLength: data.count,
                textEncodingName: mime.hasPrefix("text/") ? "utf-8" : nil
            )
            finish(task, key: key) {
                $0.didReceive(response)
                $0.didReceive(data)
                $0.didFinish()
            }
        } catch {
            finish(task, key: key) { $0.didFailWithError(error) }
        }
    }

    private func finish(_ task: WKURLSchemeTask, key: ObjectIdentifier, _ complete: (WKURLSchemeTask) -> Void) {
        guard live[key] != nil else {
            return
        }
        live.removeValue(forKey: key)
        complete(task)
    }
}

// The injected gesture layer. Press-and-hold is the single annotation gesture:
// hold on prose text targets that text as a range; hold on a card, table,
// heading container, or Mermaid node targets that component. Normal taps and
// drags are left to the page (read, scroll, follow links) so nothing is
// annotated by accident. The vendored SDK (injected server-side) still owns
// the canonical annotation payload - window.lavish.queuePrompt computes the
// selector / text-range / Mermaid target - but its hover+card UI stays off;
// the note composer is native SwiftUI. Native iOS text selection + callout are
// disabled so a hold is deterministic (never a copy menu or stray selection).
enum ChartTouchScript {
    static let source = #"""
(() => {
  if (window.__perchChart) { return; }
  const post = (msg) => {
    try { window.webkit.messageHandlers.perch.postMessage(msg); } catch (e) {}
  };

  const sdkOff = () => window.postMessage({ type: "lavish:setAnnotationMode", enabled: false }, "*");
  // Own the gesture end to end: no native selection, no callout, no tap delay.
  const style = document.createElement("style");
  style.textContent = "*{-webkit-user-select:none!important;user-select:none!important;-webkit-touch-callout:none!important}";
  (document.head || document.documentElement).appendChild(style);
  sdkOff();

  // Armed by default so the review opens ready to annotate even before the
  // host's setAnnotate lands (the load/evaluate race); taps stay inert, so
  // "always armed" is safe.
  let active = true;
  let selectedEl = null;
  let selectedText = null; // { range, text }
  let textMarks = [];

  // Forward SDK -> host messages. queuePrompt carries the canonical
  // annotation payload; layoutWarnings is the automated audit.
  window.addEventListener("message", (event) => {
    const msg = (event && event.data) || {};
    if (msg.type === "lavish:queuePrompt") { post({ type: "annotation", annotation: msg.prompt }); }
    if (msg.type === "lavish:layoutWarnings") { post({ type: "layoutWarnings", warnings: msg.layout_warnings || [] }); }
  });

  const OUTLINE = "2px solid #C9A227";

  function clearElement() {
    if (selectedEl) {
      selectedEl.style.outline = "";
      selectedEl.style.outlineOffset = "";
      selectedEl = null;
    }
  }

  function clearTextMarks() {
    for (const mark of textMarks) { mark.remove(); }
    textMarks = [];
  }

  function clearAll() {
    clearElement();
    clearTextMarks();
    selectedText = null;
  }

  // Persistent highlight for a held text range: absolute overlays in page
  // coordinates, so they scroll with the content and survive the native
  // keyboard opening under them.
  function markTextRange(range) {
    clearTextMarks();
    for (const rect of range.getClientRects()) {
      if (rect.width <= 0 || rect.height <= 0) { continue; }
      const mark = document.createElement("div");
      mark.setAttribute("data-lavish-ui", "perch-text-mark");
      mark.style.cssText = "position:absolute;pointer-events:none;z-index:2147483646;" +
        "background:rgba(201,162,39,.28);border-radius:2px;box-shadow:0 0 0 1px rgba(201,162,39,.45);" +
        "left:" + (rect.left + window.scrollX) + "px;top:" + (rect.top + window.scrollY) + "px;" +
        "width:" + rect.width + "px;height:" + rect.height + "px;";
      document.body.appendChild(mark);
      textMarks.push(mark);
    }
  }

  // Mirror of the vendored SDK's Mermaid node resolution, so a hold highlights
  // the exact <g> the annotation will target.
  function mermaidNodeEl(el) {
    if (!el || !el.closest) { return null; }
    const node = el.closest("g.node, g.nodes > g");
    if (!node) { return null; }
    const svg = node.closest("svg");
    if (!svg) { return null; }
    const id = svg.id || "";
    const isMermaid = id.startsWith("mermaid-") || id.startsWith("mermaid_") ||
      !!svg.getAttribute("aria-roledescription") || !!svg.closest(".mermaid, [data-lavish-mermaid]");
    return isMermaid ? node : null;
  }

  function mermaidLabel(node) {
    const labelEl = node.querySelector(".nodeLabel, .label, foreignObject span, text");
    return labelEl ? (labelEl.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120) : "";
  }

  // A hold landed on a component: outline it and open the composer for it.
  function targetElement(el, tag, label) {
    clearAll();
    selectedEl = el;
    el.style.outline = OUTLINE;
    el.style.outlineOffset = "2px";
    post({ type: "holdTargeted", kind: "element", tag: tag, text: label });
  }

  // A hold landed on prose: target that element's text as a range (no reliance
  // on iOS native selection - the range is built directly over the element).
  function targetText(prose) {
    clearAll();
    const range = document.createRange();
    range.selectNodeContents(prose);
    selectedText = { range: range, text: (prose.innerText || prose.textContent || "").trim().replace(/\s+/g, " ") };
    markTextRange(range);
    post({ type: "holdTargeted", kind: "text", tag: "text", text: selectedText.text.slice(0, 120) });
  }

  // Prose leaves become text-range targets; everything else (cards, tables,
  // figures, sections, Mermaid nodes) becomes a component target.
  const PROSE = "p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,figcaption,dt,dd,code,em,strong,a";
  const STRUCT = "div,section,figure,table,thead,tbody,tr,pre,header,ul,ol,dl";

  function fireHold(x, y) {
    if (!active) { return; }
    const raw = document.elementFromPoint(x, y);
    if (!raw || (raw.closest && raw.closest("[data-lavish-ui]"))) { return; }
    const node = mermaidNodeEl(raw);
    if (node) { targetElement(node, "mermaid-node", mermaidLabel(node)); return; }
    const prose = raw.closest(PROSE);
    if (prose && (prose.innerText || "").trim()) { targetText(prose); return; }
    const el = raw.closest(STRUCT) || (raw instanceof Element ? raw : null);
    if (el) {
      targetElement(el, (el.tagName || "").toLowerCase(),
        (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120));
    }
  }

  // Long-press recognizer: a stationary hold fires after HOLD_MS; any real
  // movement (a scroll/drag) or an early release cancels it, so scrolling and
  // reading are never interrupted.
  const HOLD_MS = 500;
  const MOVE_CANCEL = 12;
  let holdTimer = 0;
  let holdX = 0;
  let holdY = 0;

  function startHold(x, y) {
    cancelHold();
    holdX = x;
    holdY = y;
    holdTimer = setTimeout(() => { holdTimer = 0; fireHold(holdX, holdY); }, HOLD_MS);
  }

  function cancelHold() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; }
  }

  document.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) { cancelHold(); return; }
    const touch = event.touches[0];
    startHold(touch.clientX, touch.clientY);
  }, { passive: true });

  document.addEventListener("touchmove", (event) => {
    if (!holdTimer) { return; }
    const touch = event.touches[0];
    if (Math.abs(touch.clientX - holdX) > MOVE_CANCEL || Math.abs(touch.clientY - holdY) > MOVE_CANCEL) {
      cancelHold();
    }
  }, { passive: true });

  document.addEventListener("touchend", cancelHold, { passive: true });
  document.addEventListener("touchcancel", cancelHold, { passive: true });
  window.addEventListener("scroll", cancelHold, { passive: true });

  // --- Text-range target construction (kept compatible with the vendored SDK's
  // selector()/nodePath()/rangeBoundary(), which live in its closure) -----
  function cssPath(el) {
    if (!el || !el.tagName) { return ""; }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += "#" + CSS.escape(node.id);
        parts.unshift(part);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((x) => x.tagName === node.tagName);
        if (same.length > 1) { part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")"; }
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }

  function closestElement(node) {
    if (!node) { return document.body; }
    if (node.nodeType === 1) { return node; }
    return node.parentElement || document.body;
  }

  function nodePath(node, root) {
    const path = [];
    let current = node;
    while (current && current !== root) {
      const parentNode = current.parentNode;
      if (!parentNode) { break; }
      path.unshift([...parentNode.childNodes].indexOf(current));
      current = parentNode;
    }
    return path;
  }

  function rangeBoundary(node, offset) {
    const el = closestElement(node);
    return { selector: cssPath(el), path: nodePath(node, el), offset: Number(offset) || 0 };
  }

  function queueTextNote(prompt) {
    const range = selectedText.range;
    const ancestor = closestElement(range.commonAncestorContainer);
    const selector = cssPath(ancestor);
    const target = {
      type: "text-range",
      text: selectedText.text,
      selector: selector,
      commonAncestorSelector: selector,
      start: rangeBoundary(range.startContainer, range.startOffset),
      end: rangeBoundary(range.endContainer, range.endOffset)
    };
    if (window.lavish && window.lavish.queuePrompt) {
      window.lavish.queuePrompt(prompt, {
        selector: selector, tag: "text", text: selectedText.text.slice(0, 240), target: target, queueKey: ""
      });
    } else {
      post({ type: "annotation", annotation: { prompt: prompt, selector: selector, tag: "text", text: selectedText.text.slice(0, 240), target: target } });
    }
  }

  window.__perchChart = {
    setAnnotate(enabled) {
      active = !!enabled;
      sdkOff();
      if (!active) {
        cancelHold();
        clearAll();
        post({ type: "cleared" });
      }
    },
    submitNote(prompt) {
      const text = String(prompt == null ? "" : prompt).trim();
      if (!text) { return; }
      if (selectedText) {
        queueTextNote(text);
      } else if (selectedEl && window.lavish && window.lavish.queuePrompt) {
        window.lavish.queuePrompt(text, { element: selectedEl, queueKey: "" });
      } else if (window.lavish && window.lavish.queuePrompt) {
        window.lavish.queuePrompt(text, { element: document.body, queueKey: "" });
      } else {
        post({ type: "annotation", annotation: { prompt: text, selector: "", tag: "element", text: "" } });
      }
      clearAll();
      post({ type: "cleared" });
    },
    clearSelection() {
      cancelHold();
      clearAll();
      post({ type: "cleared" });
    }
  };
})();
"""#
}
