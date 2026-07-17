import SwiftUI

// The chart room: full-screen review of one chart. The document renders in
// its fixed Oro Nero look inside the web view; everything around it is native
// chrome. Feedback is send-only by design - the agent's reply is the chart
// changing (the file watch triggers a live reload here).
struct ChartReviewView: View {
    @EnvironmentObject private var store: PerchStore
    @Environment(\.dismiss) private var dismiss
    let chart: ChartModel

    @StateObject private var bridge = ChartBridge()
    @State private var noteDraft = ""
    @State private var noteComposerOpen = false
    @State private var message = ""
    @State private var sending = false
    @State private var sentBanner: String?
    @State private var sessionGoneMessage: String?
    @State private var sendError: String?
    // The "press and hold to mark up" hint retires after the first hold.
    @State private var showHint = true
    @FocusState private var noteFocused: Bool
    @FocusState private var messageFocused: Bool

    private var ownerTitle: String {
        store.session(for: chart.sessionId).map(sessionDisplayTitle) ?? "the agent"
    }

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, 12)
                .padding(.top, 6)
                .padding(.bottom, 10)

            ZStack(alignment: .bottom) {
                ChartWebView(chart: chart, bridge: bridge, store: store)
                    .ignoresSafeArea(.container, edges: .horizontal)

                if bridge.loadFailed {
                    loadFailedCard
                }

                if showHint {
                    hintPill
                        .padding(.bottom, 14)
                        .transition(.opacity)
                }

                // Tap-outside-to-dismiss: an invisible catcher over the chart
                // while the composer is open. Sits below the composer, so
                // composer taps still land; a tap anywhere else closes it.
                if noteComposerOpen {
                    Color.black.opacity(0.001)
                        .ignoresSafeArea()
                        .contentShape(Rectangle())
                        .onTapGesture { dismissComposer() }
                }

                if noteComposerOpen, let selection = bridge.selection {
                    noteComposer(selection)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 10)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(.snappy(duration: 0.22), value: noteComposerOpen)

            bottomBar
        }
        .background(Style.canvas.ignoresSafeArea())
        .task {
            bridge.onLayoutWarnings = { warnings in
                Task { await store.reportChartLayoutWarnings(chart.id, warnings: warnings) }
            }
            // Arm the gesture; the web view re-asserts this on load too, so the
            // review is always ready to annotate whichever order they settle.
            bridge.setAnnotate(true)
        }
        // A hold landed on a target: open the composer for it, right there.
        .onChange(of: bridge.composeToken) { _, token in
            guard token != nil else { return }
            withAnimation { showHint = false }
            noteDraft = ""
            noteComposerOpen = true
            noteFocused = true
        }
        // Another write from the agent landed on disk: reload the document.
        // The scheme handler refetches, so this works on LAN and relay alike.
        .onChange(of: store.chartVersions[chart.id] ?? 0) { _, _ in
            bridge.loadFailed = false
            bridge.reload()
        }
        .onChange(of: bridge.selection) { _, selection in
            if selection == nil {
                noteComposerOpen = false
                noteDraft = ""
            }
        }
        .onDisappear {
            bridge.teardown()
        }
        .alert("This chart's agent is gone", isPresented: .constant(sessionGoneMessage != nil)) {
            if store.mateSession != nil {
                Button("Message the mate") {
                    sessionGoneMessage = nil
                    routeToMate()
                }
            }
            Button("Cancel", role: .cancel) {
                sessionGoneMessage = nil
            }
        } message: {
            Text(sessionGoneMessage ?? "")
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 10) {
            Button {
                dismiss()
            } label: {
                RoundIcon(systemName: "chevron.down")
            }

            Spacer()

            VStack(spacing: 1) {
                Text("CHART")
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(1.6)
                    .foregroundStyle(Style.accent)
                Text(chartDisplayName(chart))
                    .font(.system(size: 18, weight: .semibold, design: .serif))
                    .lineLimit(1)
                    .foregroundStyle(Style.textPrimary)
            }

            Spacer()

            // The gesture is press-and-hold, so there is no mode to toggle; the
            // slot is kept balanced so the title stays centered.
            Color.clear.frame(width: 44, height: 44)
        }
    }

    // MARK: - Hint / note composer

    // The one-time coach: press and hold anything to mark it up. Retires the
    // moment the first hold lands.
    private var hintPill: some View {
        HStack(spacing: 7) {
            Image(systemName: "hand.tap")
                .font(.system(size: 12, weight: .semibold))
            Text("Press and hold any part to mark it up")
                .font(.system(size: 13, weight: .medium))
        }
        .foregroundStyle(Style.textPrimary)
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .glassEffect(.regular, in: Capsule())
    }

    // The note composer for the held target, anchored above the bottom bar.
    private func noteComposer(_ selection: ChartSelection) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(selection.label)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Style.accent)
                if !selection.text.isEmpty {
                    Text(selection.text)
                        .font(.system(size: 11))
                        .foregroundStyle(Style.textFaint)
                        .lineLimit(1)
                }
                Spacer()
                // A full 44pt hit target (HIG minimum): the bare glyph was
                // near-impossible to tap on a phone. contentShape makes the
                // whole frame tappable, negative padding keeps it visually snug.
                Button {
                    dismissComposer()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(Style.textSecondary)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.trailing, -12)
                .padding(.vertical, -10)
            }

            HStack(spacing: 8) {
                TextField("What should change here?", text: $noteDraft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...4)
                    .font(.system(size: 16))
                    .tint(Style.accent)
                    .focused($noteFocused)
                    .onSubmit(queueNote)

                Button(action: queueNote) {
                    Image(systemName: "checkmark")
                        .font(.system(size: 13, weight: .bold))
                        .frame(width: 30, height: 30)
                }
                .buttonStyle(.glassProminent)
                .tint(Style.accent)
                .disabled(noteDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(12)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private func queueNote() {
        let text = noteDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            return
        }
        bridge.submitNote(text)
        noteDraft = ""
        noteComposerOpen = false
        noteFocused = false
    }

    // Close the composer without queuing: also clear the in-page selection so
    // the gold highlight and target are released (X and tap-outside both use it).
    private func dismissComposer() {
        noteComposerOpen = false
        noteDraft = ""
        noteFocused = false
        bridge.clearSelection()
    }

    // MARK: - Bottom bar

    private var bottomBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let sentBanner {
                HStack(spacing: 6) {
                    Image(systemName: "checkmark.circle")
                        .font(.system(size: 12, weight: .semibold))
                    Text(sentBanner)
                        .font(.system(size: 12, weight: .medium))
                }
                .foregroundStyle(Style.successText)
                .padding(.horizontal, Style.pageInset)
            }

            if let sendError {
                Text(sendError)
                    .font(.system(size: 12))
                    .foregroundStyle(Style.errorText)
                    .padding(.horizontal, Style.pageInset)
            }

            if !bridge.pendingNotes.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(bridge.pendingNotes) { note in
                            pendingNoteChip(note)
                        }
                    }
                    .padding(.horizontal, 12)
                }
            }

            HStack(spacing: 10) {
                TextField(
                    bridge.pendingNotes.isEmpty ? "Overall feedback…" : "Anything else?",
                    text: $message,
                    axis: .vertical
                )
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .font(.system(size: 17))
                .tint(Style.accent)
                .focused($messageFocused)

                Button(action: send) {
                    ZStack {
                        Circle()
                            .fill(canSend ? Style.textPrimary : Style.secondaryFill)
                        if sending {
                            ProgressView()
                                .tint(Style.textSecondary)
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 15, weight: .bold))
                                .foregroundStyle(canSend ? Color.black : Style.textSecondary)
                        }
                    }
                    .frame(width: 38, height: 38)
                }
                .disabled(!canSend || sending)
            }
            .padding(.leading, 18)
            .padding(.trailing, 7)
            .padding(.vertical, 8)
            .background(Style.composerFill, in: RoundedRectangle(cornerRadius: Style.composerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Style.composerRadius, style: .continuous)
                    .strokeBorder(messageFocused ? Style.composerBorderFocused : Style.composerBorder, lineWidth: 1)
            )
            .padding(.horizontal, 12)
        }
        .padding(.top, 8)
        .padding(.bottom, 8)
        .animation(.snappy(duration: 0.2), value: bridge.pendingNotes)
        .animation(.easeOut(duration: 0.16), value: sentBanner)
    }

    private func pendingNoteChip(_ note: ChartAnnotationDraft) -> some View {
        HStack(spacing: 6) {
            Text(chipLabel(note))
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Style.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
            Button {
                bridge.pendingNotes.removeAll { $0.id == note.id }
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(Style.textSecondary)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Style.bubbleFill)
        .overlay(
            Capsule().strokeBorder(Style.accent.opacity(0.35), lineWidth: 1)
        )
        .clipShape(Capsule())
        .frame(maxWidth: 220)
    }

    private func chipLabel(_ note: ChartAnnotationDraft) -> String {
        let target = note.tag == "text" ? "“\(note.text)”"
            : note.tag == "mermaid-node" ? "◇ \(note.text)"
            : "‹\(note.tag)›"
        return "\(target)  \(note.prompt)"
    }

    private var canSend: Bool {
        !bridge.pendingNotes.isEmpty
            || !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        guard canSend, !sending else {
            return
        }
        sending = true
        sendError = nil
        let notes = bridge.pendingNotes
        Task {
            do {
                let queued = try await store.sendChartFeedback(chart.id, message: message, annotations: notes)
                bridge.pendingNotes = []
                message = ""
                messageFocused = false
                sentBanner = queued
                    ? "Queued - lands when \(ownerTitle) is free"
                    : "Sent to \(ownerTitle) - the chart refreshes as it changes"
                Task {
                    try? await Task.sleep(for: .seconds(4))
                    sentBanner = nil
                }
            } catch let PerchClientError.httpStatus(status, detail) where status == 409 {
                sessionGoneMessage = detail
                    ?? "The session that drew this chart is gone. Route the feedback to the mate or start a fresh agent."
            } catch {
                sendError = error.localizedDescription
            }
            sending = false
        }
    }

    // Dead owner fallback: hand the same feedback to the mate as plain text,
    // with the chart named so the mate can pick it up with full context.
    private func routeToMate() {
        var lines = ["About the chart \"\(chart.name)\" (\(chart.file)) - its agent is gone:"]
        for (index, note) in bridge.pendingNotes.enumerated() {
            let target = note.tag == "text" || note.tag == "mermaid-node"
                ? "\(note.tag) \"\(note.text)\"" : "<\(note.tag)>"
            lines.append("\(index + 1). \(target) - \(note.prompt)")
        }
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            lines.append(trimmed)
        }
        let text = lines.joined(separator: "\n")
        bridge.pendingNotes = []
        message = ""
        dismiss()
        Task { _ = await store.sendToMate(text) }
    }

    private var loadFailedCard: some View {
        VStack(spacing: 8) {
            Text("Couldn't load this chart")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Style.textPrimary)
            Text("The file may have moved on the Mac, or the connection dropped.")
                .font(.system(size: 13))
                .foregroundStyle(Style.textSecondary)
                .multilineTextAlignment(.center)
            Button("Retry") {
                bridge.loadFailed = false
                bridge.reload()
            }
            .buttonStyle(.glass)
        }
        .padding(20)
        .frame(maxWidth: 320)
        .background(Style.panel)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Style.hairline, lineWidth: 1)
        )
        .padding(.bottom, 120)
    }
}

// "release-plan" -> "Release plan": chart names come from file basenames.
func chartDisplayName(_ chart: ChartModel) -> String {
    let words = chart.name
        .replacingOccurrences(of: "-", with: " ")
        .replacingOccurrences(of: "_", with: " ")
        .trimmingCharacters(in: .whitespaces)
    guard let first = words.first else {
        return chart.name
    }
    return String(first).uppercased() + words.dropFirst()
}

// The timeline card announcing a chart is up for review. Quietly gold: the
// glyph and hairline carry the accent, the title gets the chart room's serif.
struct ChartCardRow: View {
    let chart: ChartModel
    // Set when the card renders outside the drawing session's own chat (the
    // mate's timeline): the originating crew task's title.
    var crewTaskTitle: String?
    let action: () -> Void
    let onDismiss: () -> Void

    private var subtitle: String {
        let origin = crewTaskTitle.map { "From \"\($0)\"" }
        if chart.archived == true {
            return origin.map { "\($0) · archived" } ?? "Archived - task closed"
        }
        return origin ?? "Chart ready for review"
    }

    var body: some View {
        HStack(spacing: 10) {
            Button(action: action) {
                cardContent
            }
            .buttonStyle(.plain)

            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Style.textSecondary)
                    .frame(width: 32, height: 32)
                    .background(Style.bubbleFill.opacity(0.8))
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss chart notification")
        }
        .padding(14)
        .background(Style.panel)
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Style.accent.opacity(0.3), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var cardContent: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Style.accent.opacity(0.12))
                Image(systemName: "doc.richtext")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(Style.accent)
            }
            .frame(width: 40, height: 40)

            VStack(alignment: .leading, spacing: 3) {
                Text(chartDisplayName(chart))
                    .font(.system(size: 17, weight: .semibold, design: .serif))
                    .foregroundStyle(Style.textPrimary)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.system(size: 12))
                    .foregroundStyle(Style.textSecondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Style.textFaint)
        }
        .contentShape(Rectangle())
    }
}
