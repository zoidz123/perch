import SwiftUI
import PhotosUI

// Attachment button + staged thumbnails for the in-session composer. Images
// only (no video: neither agent CLI accepts video). Uploads immediately on
// pick so send just references the returned server path.
struct AttachmentBar: View {
    @EnvironmentObject private var store: PerchStore
    @Binding var picked: [PhotosPickerItem]
    @Binding var uploading: Bool

    private var sessionId: String? {
        store.selectedSessionId
    }

    var body: some View {
        if !store.pendingAttachments.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(store.pendingAttachments) { att in
                        ZStack(alignment: .topTrailing) {
                            if let image = UIImage(data: att.imageData) {
                                Image(uiImage: image)
                                    .resizable().scaledToFill()
                                    .frame(width: 44, height: 44)
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                            }
                            Button {
                                if let sessionId {
                                    store.removePendingAttachment(id: att.id, for: sessionId)
                                }
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 14))
                                    .foregroundStyle(.white, .black.opacity(0.5))
                            }
                            .offset(x: 4, y: -4)
                        }
                    }
                }
                .padding(.horizontal, 4)
            }
        }
    }
}

// The photo picker button, kept separate so it can sit inside the input
// capsule while the thumbnail bar sits above it. Uploads each pick and stages
// the returned server path.
struct AttachmentPickerButton: View {
    @EnvironmentObject private var store: PerchStore
    @Binding var picked: [PhotosPickerItem]
    @Binding var uploading: Bool

    var body: some View {
        PhotosPicker(selection: $picked, maxSelectionCount: 4, matching: .images) {
            Image(systemName: "photo")
                .font(.system(size: 17))
                .foregroundStyle(uploading ? Style.textSecondary : Style.textPrimary)
        }
        .disabled(uploading)
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            Task { await upload(items) }
        }
    }

    private func upload(_ items: [PhotosPickerItem]) async {
        guard let targetSessionId = store.selectedSessionId else { return }
        uploading = true
        defer { uploading = false; picked = [] }
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let name = "image-\(UUID().uuidString.prefix(8)).png"
            if let path = try? await store.uploadAttachment(
                data,
                filename: name,
                contentType: "image/png",
                sessionId: targetSessionId
            ) {
                store.appendPendingAttachment(
                    .init(imageData: data, serverPath: path),
                    for: targetSessionId
                )
            }
        }
    }
}

// Live model + reasoning-effort readout and per-turn selector. The chip shows
// exactly what the session is running RIGHT NOW (server-resolved, e.g. "GPT-5.5
// - xhigh" / "Opus 4.8"); picking a different model (or, for Codex, a different
// effort) queues it for the next message. Both Claude and Codex support
// switching: Claude submits a `/model` keystroke, Codex sets the model/effort
// over the app-server protocol (no keystrokes). Options come from the server
// catalog (single source of truth), falling back to the static per-agent
// catalog on older servers.
//
// The mate's chip is the exception: it is the fleet's settings entry point, so
// it opens the mate + crew defaults popup instead of a per-turn menu. A mate
// model picked there switches the live mate AND becomes its launch default.
struct ModelChip: View {
    @EnvironmentObject private var store: PerchStore
    let sessionId: String
    let agent: AgentKind

    @State private var showDefaults = false

    private var options: [AgentModelOption] {
        let catalog = store.models?.providers.first { $0.provider == agent }
        return catalog?.agentOptions ?? agent.pickerModelOptions
    }

    // Effort choices for the model the chip currently reflects (queued pick or
    // live model), so switching model re-scopes the ladder to that model's
    // ceiling rather than a union across all Codex models.
    private var effortLevels: [String] {
        guard agent == .codex else { return [] }
        guard let catalog = store.models?.providers.first(where: { $0.provider == agent }) else {
            return fallbackCodexEffortLevels
        }
        return catalog.effortLevels(forModel: selectedModelId)
    }

    private var session: AgentSession? { store.session(for: sessionId) }
    private var switchDisabled: Bool {
        modelPickerIsDisabled(
            for: sessionId,
            runtimes: store.sessions.map {
                ModelPickerRuntimeState(sessionId: $0.id, isRunning: $0.status == .running)
            }
        )
    }
    private var isMate: Bool { store.mateSession?.id == sessionId }

    var body: some View {
        // No known (or queued) model: show nothing. A literal "Model"
        // placeholder is noise the boss flagged; the chip appears once the
        // server resolves what the session is actually running.
        if selectedModelId != nil {
            if isMate {
                defaultsButton
            } else {
                chipMenu
            }
        }
    }

    // The mate's chip: same readout, but a tap opens the defaults popup.
    private var defaultsButton: some View {
        Button {
            showDefaults = true
        } label: {
            chipLabelView
        }
        .buttonStyle(.plain)
        .disabled(switchDisabled)
        .opacity(switchDisabled ? 0.45 : 1)
        .sheet(isPresented: $showDefaults) {
            AgentDefaultsSheet(mateSessionId: sessionId, mateAgent: agent)
                .environmentObject(store)
        }
    }

    private var chipMenu: some View {
        Menu {
            Section("Model") {
                ForEach(options) { option in
                    Button {
                        store.pendingModelBySession[sessionId] = option.id
                    } label: {
                        if isSelected(option) {
                            Label(option.label, systemImage: "checkmark")
                        } else {
                            Text(option.label)
                        }
                    }
                }
            }
            if agent == .codex {
                Section("Reasoning effort") {
                    ForEach(effortLevels, id: \.self) { level in
                        Button {
                            store.pendingEffortBySession[sessionId] = level
                        } label: {
                            if selectedEffort == level {
                                Label(level, systemImage: "checkmark")
                            } else {
                                Text(level)
                            }
                        }
                    }
                }
            }
        } label: {
            chipLabelView
        }
        .disabled(switchDisabled)
        .opacity(switchDisabled ? 0.45 : 1)
    }

    private var chipLabelView: some View {
        HStack(spacing: 4) {
            Image(systemName: "cpu")
            Text(chipLabel)
        }
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(Style.textSecondary)
    }

    // The model/effort the chip reflects: a queued change when present, else the
    // live values the session is actually running.
    private var selectedModelId: String? {
        store.pendingModelBySession[sessionId] ?? session?.model
    }

    private var selectedEffort: String? {
        guard agent == .codex else { return nil }
        return store.pendingEffortBySession[sessionId] ?? session?.effort
    }

    // Exactly what the session is (or will next be) running: friendly model
    // name plus the reasoning tier when known, e.g. "GPT-5.5 · xhigh" /
    // "Fable 5". The body hides the chip when no model id is known, so the
    // empty fallback here is unreachable.
    private var chipLabel: String {
        guard let id = selectedModelId else { return "" }
        let name = modelLabel(for: id)
        if let effort = selectedEffort {
            return "\(name) · \(effort)"
        }
        return name
    }

    // The live model id carries launch plumbing the catalog id omits, so an
    // exact compare would leave the running model unticked.
    private func isSelected(_ option: AgentModelOption) -> Bool {
        guard let selected = selectedModelId else { return false }
        let liveLabel = selected == session?.model ? session?.modelLabel : nil
        return modelOptionMatches(option, id: selected, label: liveLabel)
    }

    private func modelLabel(for id: String) -> String {
        // Prefer the catalog's versioned label; else the server-resolved live
        // label for this exact model; else prettify the raw id locally.
        if let option = options.first(where: { $0.id == id }) { return option.label }
        if id == session?.model, let label = session?.modelLabel, label != id {
            return label
        }
        return friendlyModelName(id)
    }
}

// Strip the launch plumbing a CLI reports but the model catalog omits: the
// "[1m]" context-window opt-in and "-YYYYMMDD" date pins.
func normalizedModelId(_ rawId: String) -> String {
    rawId
        .replacingOccurrences(of: #"\[[^\]]*\]"#, with: "", options: .regularExpression)
        .trimmingCharacters(in: .whitespaces)
        .replacingOccurrences(of: #"-\d{8}$"#, with: "", options: .regularExpression)
        .lowercased()
}

// Does `option` name the model a session is actually running? The server
// reports the id the CLI resolved ("opus[1m]", or the canonical
// "claude-opus-4-8") where the catalog lists the alias it spawns with
// ("opus"), so fall back to the normalized id and then to the server-resolved
// label. `label` must be passed only for the session's live model - a queued
// pick has no label of its own, and reusing the live one would tick the wrong
// row.
func modelOptionMatches(_ option: AgentModelOption, id liveId: String?, label liveLabel: String?) -> Bool {
    guard let liveId else { return false }
    if option.id == liveId { return true }
    if normalizedModelId(option.id) == normalizedModelId(liveId) { return true }
    if let liveLabel, !liveLabel.isEmpty, option.label == liveLabel { return true }
    return false
}

// Friendly display name for a raw provider model id when the server has no
// label for it. This is a generic formatter, not a current-model map:
// "claude-fable-5[1m]" -> "Fable 5", "claude-opus-4-8" -> "Opus 4.8",
// "gpt-5.6-sol" -> "GPT 5.6 Sol".
func friendlyModelName(_ rawId: String) -> String {
    // "[1m]" window opt-in and "-YYYYMMDD" date pins are launch plumbing.
    var id = rawId
        .replacingOccurrences(of: #"\[[^\]]*\]"#, with: "", options: .regularExpression)
        .trimmingCharacters(in: .whitespaces)
    id = id.replacingOccurrences(of: #"-\d{8}$"#, with: "", options: .regularExpression)
    id = id.replacingOccurrences(of: #"^[A-Za-z][A-Za-z0-9-]*/"#, with: "", options: .regularExpression)

    var parts = id.lowercased().split(separator: "-").map(String.init)
    if parts.first == "claude" { parts.removeFirst() }
    guard !parts.isEmpty else { return rawId }
    var nameParts: [String] = []
    var versionParts: [String] = []
    var suffixParts: [String] = []
    var seenVersion = false
    for part in parts {
        if part.range(of: #"^[0-9]+(\.[0-9]+)*$"#, options: .regularExpression) != nil {
            seenVersion = true
            versionParts.append(part)
        } else if seenVersion {
            suffixParts.append(part == "gpt" ? "GPT" : part.capitalized)
        } else {
            nameParts.append(part == "gpt" ? "GPT" : part.capitalized)
        }
    }
    let name = [nameParts.joined(separator: " "), versionParts.joined(separator: "."), suffixParts.joined(separator: " ")]
        .filter { !$0.isEmpty }
        .joined(separator: " ")
    return name.isEmpty ? rawId : name
}
