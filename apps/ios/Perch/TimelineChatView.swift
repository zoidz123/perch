import MarkdownUI
import SwiftUI
import UIKit

// Chat-first session surface, styled after minimal dark chat apps: the user's
// messages are compact right-aligned bubbles; the agent's replies are plain
// full-width markdown on the canvas (no bubble); tool activity collapses into
// quiet single-line summaries.
struct TimelineChatView: View {
    @EnvironmentObject private var store: PerchStore
    let sessionId: String
    private let bottomID = "chat-bottom"

    // Sticky-bottom state machine: follow
    // new messages only while the user is at the bottom; a deliberate scroll
    // up detaches; the pill re-attaches. Content growth never detaches.
    @State private var sticky = true
    @State private var unseenWhileDetached = false
    // Seq high-water mark captured after the initial load: only items that
    // arrive AFTER it get the typewriter reveal; history renders instantly.
    @State private var revealAfterSeq = Int.max

    private var items: [TimelineItem] {
        store.chatItems(sessionId)
    }

    // Show the thinking indicator only while a reply is actually pending:
    // a message still in flight (optimistic and not yet timed out) or a running
    // turn whose last timeline item is not yet the assistant's text. A freshly
    // spawned agent idling at its own composer reports "running" before its
    // first hook - dots there would be lying (seen with codex). An undelivered
    // message is invisible to both tests: it is not in flight, and it must not
    // count as the trailing "unanswered" row that keeps a running session's
    // dots alive - that is the infinite spinner by another route.
    private var isWorking: Bool {
        if store.hasPendingOptimistic(sessionId) {
            return true
        }
        guard store.session(for: sessionId)?.status == .running else {
            return false
        }
        guard let last = items.last(where: { !store.isOptimisticFailed(sessionId, $0.id) }) else {
            return false
        }
        return last.kind != .assistant
    }

    @State private var visibleChartCardId: String?
    private let chartCardFreshness: TimeInterval = 60 * 60

    private var latestChart: ChartModel? {
        store.chartsFor(sessionId).last
    }

    private var chartCardIdentities: Set<String> {
        Set(store.chartsFor(sessionId).map { $0.cardDismissalIdentity.key })
    }

    private var visibleChartCard: ChartModel? {
        guard let chart = latestChart,
              chart.id == visibleChartCardId,
              !store.isChartCardDismissed(chart) else {
            return nil
        }
        return chart
    }

    private var freshChartReadyItemId: String? {
        items.last { item in
            item.seq > revealAfterSeq && (item.text?.contains("· chart_ready:") ?? false)
        }?.id
    }

    var body: some View {
        ScrollViewReader { proxy in
            ZStack(alignment: .bottomTrailing) {
                // List, not ScrollView+LazyVStack: rows are virtualized by the
                // UICollectionView backing, and scrollTo is a cheap
                // scroll-to-item instead of a full-content measure. With
                // markdown rows, ScrollViewReader.scrollTo inside a LazyVStack
                // re-measured (and re-parsed) the entire transcript on the
                // main thread every time - the chat-freeze bug class.
                List {
                    Group {
                        ForEach(items) { item in
                            let undelivered = store.isOptimisticFailed(sessionId, item.id)
                            TimelineRow(
                                item: item,
                                reveal: item.kind == .assistant && item.seq > revealAfterSeq,
                                undelivered: undelivered,
                                onRetry: {
                                    Task { await store.retryOptimistic(sessionId, item.id) }
                                },
                                onGrow: {
                                    if sticky {
                                        proxy.scrollTo(bottomID, anchor: .bottom)
                                    }
                                }
                            )
                            .opacity(item.id.hasPrefix("optimistic-") && !undelivered ? 0.55 : 1)
                            .padding(.vertical, 8)
                        }
                        // Chart cards are a heads-up only. The Charts hub is
                        // the durable home, so this row expires after a short
                        // hold or a manual dismiss.
                        if let chart = visibleChartCard {
                            ChartCardRow(
                                chart: chart,
                                crewTaskTitle: chart.sessionId == sessionId ? nil : chart.taskTitle,
                                action: {
                                    store.openChart = chart
                                },
                                onDismiss: {
                                    dismissChartCard(chart)
                                }
                            )
                            .padding(.vertical, 8)
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                        }
                        if isWorking {
                            ThinkingIndicator()
                                .padding(.vertical, 8)
                        }
                        Color.clear
                            .frame(height: 1)
                            .id(bottomID)
                    }
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 0, leading: Style.pageInset, bottom: 0, trailing: Style.pageInset))
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .scrollIndicators(.hidden)
                .scrollDismissesKeyboard(.interactively)
                // NO geometry observation at all: onScrollGeometryChange
                // (even Bool-derived) kept re-entering layout via the
                // AttributeGraph during streaming + scrollTo + keyboard moves,
                // pegging the main thread (three separate freezes, confirmed
                // by sampling). Drag-phase is the only scroll signal we use:
                // any deliberate drag detaches; sending or the pill re-sticks.
                .onScrollPhaseChange { _, newPhase in
                    if newPhase == .interacting {
                        sticky = false
                    }
                }

                if !sticky, unseenWhileDetached {
                    Button {
                        sticky = true
                        unseenWhileDetached = false
                        proxy.scrollTo(bottomID, anchor: .bottom)
                    } label: {
                        Image(systemName: "arrow.down")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Style.textPrimary)
                            .frame(width: 38, height: 38)
                            .background(Style.bubbleFill)
                            .clipShape(Circle())
                            .shadow(color: .black.opacity(0.4), radius: 8, y: 2)
                    }
                    .padding(.trailing, 16)
                    .padding(.bottom, 10)
                    .transition(.scale.combined(with: .opacity))
                }
            }
            .onAppear {
                proxy.scrollTo(bottomID, anchor: .bottom)
            }
            .onChange(of: isWorking) { _, working in
                if working, sticky {
                    withAnimation(.easeOut(duration: 0.15)) {
                        proxy.scrollTo(bottomID, anchor: .bottom)
                    }
                }
            }
            .onChange(of: items.count) {
                if sticky {
                    // No animation: streamed items arrive in bursts, and
                    // overlapping animated scrolls fed the layout storm.
                    proxy.scrollTo(bottomID, anchor: .bottom)
                } else {
                    unseenWhileDetached = true
                }
            }
            // Sending always returns to the bottom.
            .onChange(of: store.optimisticBySession[sessionId]?.count ?? 0) { old, new in
                if new > old {
                    sticky = true
                    unseenWhileDetached = false
                    proxy.scrollTo(bottomID, anchor: .bottom)
                }
            }
            .onChange(of: chartCardIdentities) { oldKeys, newKeys in
                guard !newKeys.subtracting(oldKeys).isEmpty else { return }
                presentLatestChartIfReady(proxy)
            }
            .onChange(of: freshChartReadyItemId) { _, itemId in
                guard itemId != nil else { return }
                Task {
                    await store.fetchCharts()
                    await MainActor.run {
                        presentLatestChartIfReady(proxy)
                    }
                }
            }
            .task {
                await store.loadTimeline(sessionId)
                await store.fetchCharts()
                revealAfterSeq = items.last(where: { $0.seq > 0 })?.seq ?? 0
                presentLatestChartIfReady(proxy, requireFresh: true)
            }
        }
        // Belt-and-suspenders: while the session
        // is running, reconcile against the authoritative timeline every few
        // seconds so ANY missed live frame self-heals instead of freezing
        // the view forever.
        .task(id: sessionId) {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                if store.session(for: sessionId)?.status == .running {
                    await store.loadTimeline(sessionId)
                }
            }
        }
    }

    private func presentLatestChartIfReady(_ proxy: ScrollViewProxy, requireFresh: Bool = false) {
        guard let chart = latestChart,
              visibleChartCardId != chart.id,
              !store.isChartCardDismissed(chart),
              !requireFresh || isFreshChart(chart) else {
            return
        }

        let shouldFollow = sticky
        withAnimation(.snappy(duration: 0.22)) {
            visibleChartCardId = chart.id
        }
        if shouldFollow {
            proxy.scrollTo(bottomID, anchor: .bottom)
        } else {
            unseenWhileDetached = true
        }
    }

    private func dismissChartCard(_ chart: ChartModel) {
        store.dismissChartCard(chart)
        guard visibleChartCardId == chart.id else { return }
        withAnimation(.easeOut(duration: 0.16)) {
            visibleChartCardId = nil
        }
    }

    private func isFreshChart(_ chart: ChartModel) -> Bool {
        guard let registeredAt = parseIsoDate(chart.registeredAt) else { return false }
        return Date().timeIntervalSince(registeredAt) <= chartCardFreshness
    }

    private func parseIsoDate(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) {
            return date
        }
        return ISO8601DateFormatter().date(from: value)
    }

}

// Three pulsing dots while the agent works, matching the muted canvas style.
private struct ThinkingIndicator: View {
    @State private var pulsing = false

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(Style.textSecondary)
                    .frame(width: 7, height: 7)
                    .opacity(pulsing ? 1 : 0.25)
                    .animation(
                        .easeInOut(duration: 0.55)
                            .repeatForever(autoreverses: true)
                            .delay(Double(index) * 0.18),
                        value: pulsing
                    )
            }
        }
        .padding(.vertical, 4)
        .onAppear { pulsing = true }
        .accessibilityLabel("Agent is working")
    }
}

// The message left the phone but the agent never echoed it back (a CLI dialog
// can swallow injected text). Sits under its own bubble, right-aligned, with
// the one action that helps.
private struct UndeliveredNotice: View {
    var onRetry: (() -> Void)?

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.circle")
                .font(.system(size: 11, weight: .semibold))
            Text("Not delivered")
                .font(.system(size: 12, weight: .medium))
            if let onRetry {
                Button("Retry", action: onRetry)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Style.accent)
                    .buttonStyle(.plain)
            }
        }
        .foregroundStyle(Style.warningText)
        .padding(.trailing, 4)
    }
}

// Human phrasing for tool activity, agent-agnostic on unknown names.
private func toolVerb(_ name: String?) -> String {
    switch (name ?? "").lowercased() {
    case "bash": "Ran a command"
    case "read": "Read a file"
    case "edit", "write", "multiedit", "notebookedit": "Edited a file"
    case "grep", "glob": "Searched the code"
    case "webfetch", "websearch": "Searched the web"
    case "task", "agent": "Delegated to an agent"
    case "askuserquestion": "Asked a question"
    case "": "Used a tool"
    default: "Used \(name ?? "a tool")"
    }
}

// Matching SF Symbol for each tool verb, so activity lines carry a small,
// consistent affordance instead of bare text (terminal glyph for commands, etc).
private func toolGlyph(_ name: String?) -> String {
    switch (name ?? "").lowercased() {
    case "bash": "terminal"
    case "read": "doc.text"
    case "edit", "write", "multiedit", "notebookedit": "pencil"
    case "grep", "glob": "magnifyingglass"
    case "webfetch", "websearch": "globe"
    case "task", "agent": "sparkles"
    case "askuserquestion": "questionmark.bubble"
    default: "wrench.and.screwdriver"
    }
}

private struct TimelineRow: View {
    let item: TimelineItem
    var reveal = false
    // An optimistic message whose canonical row never arrived. The bubble stays
    // (never eat the boss's words) but stops pretending to be in flight.
    var undelivered = false
    var onRetry: (() -> Void)?
    var onGrow: (() -> Void)?
    @State private var expanded = false

    var body: some View {
        switch item.kind {
        case .user:
            VStack(alignment: .trailing, spacing: 4) {
                HStack {
                    Spacer(minLength: 40)
                    Text(item.text ?? "")
                        .font(.system(size: 17))
                        .foregroundStyle(Style.textPrimary)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 11)
                        .background(Style.bubbleFill)
                        .overlay {
                            if undelivered {
                                RoundedRectangle(cornerRadius: 22, style: .continuous)
                                    .strokeBorder(Style.warningText.opacity(0.5), lineWidth: 1)
                            }
                        }
                        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                }
                if undelivered {
                    UndeliveredNotice(onRetry: onRetry)
                }
            }
        case .assistant:
            RevealingMarkdown(
                itemId: item.id,
                text: item.text ?? "",
                reveal: reveal,
                onGrow: onGrow
            )
        case .toolCall:
            activityLine(
                glyph: toolGlyph(item.tool?.name),
                label: toolVerb(item.tool?.name),
                detail: item.tool?.input,
                isCommand: (item.tool?.name ?? "").lowercased() == "bash"
            )
        case .toolResult:
            activityLine(
                glyph: "arrow.turn.down.right",
                label: "Result",
                detail: item.text,
                isCommand: false
            )
        case .system:
            Text(item.text ?? "")
                .font(.system(size: 12))
                .foregroundStyle(Style.textFaint)
                .frame(maxWidth: .infinity, alignment: .center)
        }
    }

    // Prose-style activity summary ("Ran a command  npm test"), like the
    // reference's "Explored 11 files, 1 search": a small verb glyph, the verb,
    // and a one-line mono preview; taps expand the full detail into the same
    // code surface used for fenced code blocks (a terminal chip for commands).
    @ViewBuilder
    private func activityLine(glyph: String, label: String, detail: String?, isCommand: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                if detail != nil {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        expanded.toggle()
                    }
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: glyph)
                        .font(.system(size: 12, weight: .semibold))
                        .frame(width: 16)
                        .opacity(0.75)
                    Text(label)
                        .font(.system(size: 15, weight: .medium))
                    if let detail, !expanded {
                        Text(detail.replacingOccurrences(of: "\n", with: " "))
                            .font(.system(size: 13, design: .monospaced))
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .foregroundStyle(Style.textSecondary)
                    }
                    if detail != nil {
                        Image(systemName: "chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                            .rotationEffect(.degrees(expanded ? 180 : 0))
                            .opacity(0.4)
                    }
                    Spacer(minLength: 0)
                }
                .foregroundStyle(Style.textSecondary)
            }
            .buttonStyle(.plain)

            if expanded, let detail {
                CodeSurface(
                    title: isCommand ? "shell" : nil,
                    content: detail,
                    glyph: isCommand ? "terminal" : "text.alignleft"
                )
            }
        }
    }
}

// Typewriter reveal for freshly-arrived assistant text: the transcript only
// carries whole messages (the no-SDK tradeoff), so intra-message streaming is
// simulated client-side by revealing the text progressively. History and
// re-encountered rows render instantly (the ledger survives List cell reuse).
@MainActor
private final class RevealLedger {
    static let shared = RevealLedger()
    // Progress survives List cell churn: rows are recreated ~50ms after
    // appearing (next store publish reflows), which cancels the animating
    // task - the successor resumes from here instead of bailing.
    var progress = [String: Int]()
    var completed = Set<String>()
}

private struct RevealingMarkdown: View {
    let itemId: String
    let text: String
    let reveal: Bool
    var onGrow: (() -> Void)?

    @State private var visibleCount: Int?

    private var shouldAnimate: Bool {
        reveal && !RevealLedger.shared.completed.contains(itemId) && text.count <= 6000
    }

    var body: some View {
        StyledMarkdown(text: visibleCount.map { String(text.prefix($0)) } ?? text)
            .task(id: itemId) {
                guard shouldAnimate else { return }
                let ledger = RevealLedger.shared
                let total = text.count
                // ~1.6s total regardless of length; chunked, not per-char.
                let step = max(2, total / 50)
                var shown = ledger.progress[itemId] ?? 0
                visibleCount = shown
                while shown < total, !Task.isCancelled {
                    shown = min(total, shown + step)
                    visibleCount = shown
                    ledger.progress[itemId] = shown
                    if shown % (step * 5) < step {
                        onGrow?()
                    }
                    try? await Task.sleep(for: .milliseconds(32))
                }
                if shown >= total {
                    ledger.completed.insert(itemId)
                    ledger.progress[itemId] = nil
                    visibleCount = nil
                    onGrow?()
                }
            }
    }
}

private struct StyledMarkdown: View {
    let text: String

    var body: some View {
            Markdown(text)
                .markdownTextStyle {
                    FontSize(17)
                    ForegroundColor(Style.textPrimary)
                }
                // Inline code: a calm chip rather than a loud blue tint.
                .markdownTextStyle(\.code) {
                    FontFamilyVariant(.monospaced)
                    FontSize(15)
                    ForegroundColor(Style.inlineCodeText)
                    BackgroundColor(Style.inlineCodeFill)
                }
                // Links: visibly tappable in the dark theme.
                .markdownTextStyle(\.link) {
                    ForegroundColor(Style.accent)
                    UnderlineStyle(.single)
                }
                // Blockquotes: an accent rail + quiet italic instead of a bare
                // indented paragraph (the basic theme's default).
                .markdownBlockStyle(\.blockquote) { configuration in
                    HStack(spacing: 0) {
                        RoundedRectangle(cornerRadius: 2, style: .continuous)
                            .fill(Style.textPrimary.opacity(0.25))
                            .frame(width: 3)
                        configuration.label
                            .markdownTextStyle {
                                FontStyle(.italic)
                                ForegroundColor(Style.textSecondary)
                            }
                            .relativePadding(.leading, length: .em(0.9))
                            .padding(.vertical, 2)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .markdownMargin(top: .em(0.4), bottom: .em(0.8))
                }
                // Fenced code: a real code surface (header chrome + language +
                // copy, horizontal scroll so wide lines stay readable).
                .markdownBlockStyle(\.codeBlock) { configuration in
                    CodeSurface(
                        title: configuration.language,
                        content: configuration.content
                    )
                    .markdownMargin(top: .em(0.4), bottom: .em(0.8))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
    }
}

// A first-class code/terminal surface: a header strip (verb or language glyph,
// a label, and a copy button) over a horizontally scrolling monospaced body, so
// long lines scroll rather than wrap or truncate. Shared by fenced code blocks
// and expanded tool detail so code and commands read as one treatment.
private struct CodeSurface: View {
    let title: String?
    let content: String
    var glyph: String? = nil

    @State private var copied = false

    // Fenced content carries a trailing newline; trim it so the body doesn't
    // render a dangling blank line inside the panel.
    private var trimmed: String {
        var text = content
        while text.hasSuffix("\n") || text.hasSuffix("\r") {
            text.removeLast()
        }
        return text
    }

    private var headerLabel: String {
        if let title, !title.isEmpty {
            return title.lowercased()
        }
        return "code"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                if let glyph {
                    Image(systemName: glyph)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Style.textSecondary)
                }
                Text(headerLabel)
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .tracking(0.5)
                    .foregroundStyle(Style.textSecondary)
                Spacer(minLength: 8)
                Button {
                    UIPasteboard.general.string = trimmed
                    copied = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.4))
                        copied = false
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        if copied {
                            Text("Copied")
                        }
                    }
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(copied ? Style.accent : Style.textSecondary)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(Style.codeHeader)

            Rectangle()
                .fill(Style.hairline)
                .frame(height: 1)

            ScrollView(.horizontal, showsIndicators: false) {
                Text(trimmed)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(Style.codeText)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
            }
        }
        .background(Style.codeSurface)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Style.hairline)
        }
    }
}
