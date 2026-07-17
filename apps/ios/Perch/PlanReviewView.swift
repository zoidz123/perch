import SwiftUI
import WebKit

// The plan room: a read-only render of a committed implementation plan in the
// same fixed Oro Nero chart styling as the chart room. The server renders the
// plan's markdown to chart-styled HTML (GET /charts/plan?path=); the phone
// loads that one self-contained document. Read-only by design: a committed plan has no
// owning agent session to route feedback to, so there is no annotation chrome -
// brainstorm-to-build, one continuous look, minus the send bar.
struct PlanReviewView: View {
    @EnvironmentObject private var store: PerchStore
    @Environment(\.dismiss) private var dismiss
    let plan: ChartPlanDoc

    @State private var html: String?
    @State private var loadFailed: String?
    @State private var loading = false

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, 12)
                .padding(.top, 6)
                .padding(.bottom, 10)

            ZStack {
                if let html {
                    PlanWebView(html: html)
                        .ignoresSafeArea(.container, edges: .horizontal)
                } else if let loadFailed {
                    loadFailedCard(loadFailed)
                } else {
                    ProgressView()
                        .tint(Style.accent)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Style.canvas.ignoresSafeArea())
        .task { await load() }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Button {
                dismiss()
            } label: {
                RoundIcon(systemName: "chevron.down")
            }

            Spacer()

            VStack(spacing: 1) {
                Text("PLAN")
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(1.6)
                    .foregroundStyle(Style.accent)
                Text(plan.title)
                    .font(.system(size: 18, weight: .semibold, design: .serif))
                    .lineLimit(1)
                    .foregroundStyle(Style.textPrimary)
            }

            Spacer()

            // Balance the leading close button so the title stays centered.
            Color.clear.frame(width: 44, height: 44)
        }
    }

    private func loadFailedCard(_ message: String) -> some View {
        VStack(spacing: 8) {
            Text("Couldn't load this plan")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Style.textPrimary)
            Text(message)
                .font(.system(size: 13))
                .foregroundStyle(Style.textSecondary)
                .multilineTextAlignment(.center)
            Button("Retry") { Task { await load() } }
                .buttonStyle(.glass)
                .tint(Style.accent)
        }
        .padding(20)
        .frame(maxWidth: 320)
        .background(Style.panel)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Style.hairline, lineWidth: 1)
        )
    }

    private func load() async {
        guard !loading else { return }
        loading = true
        loadFailed = nil
        do {
            html = try await store.planHtml(plan.relativePath)
        } catch {
            if html == nil { loadFailed = error.localizedDescription }
        }
        loading = false
    }
}

// The plan document surface: a WKWebView loading the server-rendered,
// self-contained chart-styled HTML string directly (no scheme handler - the
// document inlines its styling, so there are no sibling-asset fetches). External
// links open in Safari; everything else is a static read.
struct PlanWebView: UIViewRepresentable {
    let html: String

    func makeUIView(context: Context) -> WKWebView {
        let webView = WKWebView(frame: .zero)
        webView.isOpaque = false
        webView.backgroundColor = UIColor(Style.canvas)
        webView.scrollView.backgroundColor = UIColor(Style.canvas)
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.navigationDelegate = context.coordinator
        #if DEBUG
        webView.isInspectable = true
        #endif
        webView.loadHTMLString(html, baseURL: nil)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // A retry (or a fresh plan reusing the view) swaps the document.
        if context.coordinator.lastHTML != html {
            context.coordinator.lastHTML = html
            webView.loadHTMLString(html, baseURL: nil)
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(html: html)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var lastHTML: String

        init(html: String) {
            self.lastHTML = html
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            if navigationAction.navigationType == .linkActivated,
               let url = navigationAction.request.url,
               url.scheme == "http" || url.scheme == "https" {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
    }
}
