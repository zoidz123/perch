import SwiftUI

// The solo-agent flow: pick where the agent works (a recent project or a
// live-searched directory), which agent, whether to isolate it in a fresh
// worktree, and the kickoff prompt. Always a plain session - tracked work
// goes through the mate, never through this sheet.
struct NewAgentSheet: View {
    @EnvironmentObject private var store: PerchStore
    @Environment(\.dismiss) private var dismiss

    // Prefill (the prompt the user already typed into the home composer).
    let initialPrompt: String

    @State private var agent: AgentKind = .claude
    @State private var model: String?
    @State private var query = ""
    @State private var selectedPath: String?
    @State private var suggestions: [String] = []
    @State private var recents: [Project] = []
    @State private var worktree = false
    @State private var prompt: String
    @State private var starting = false
    @State private var searchTask: Task<Void, Never>?

    @FocusState private var searchFocused: Bool
    @FocusState private var promptFocused: Bool
    @StateObject private var dictation = VoiceDictation()

    init(initialPrompt: String) {
        self.initialPrompt = initialPrompt
        _prompt = State(initialValue: initialPrompt)
    }

    private let agents: [AgentKind] = [.claude, .codex]

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        agentPicker
                        modelPicker
                        projectPicker
                        isolationToggle
                        promptField
                            .id("prompt")
                    }
                    .padding(20)
                }
                .background(Style.canvas)
                .scrollDismissesKeyboard(.interactively)
                .navigationTitle("New agent")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(action: start) {
                            if starting {
                                ProgressView().controlSize(.small)
                            } else {
                                Text("Start").fontWeight(.semibold)
                            }
                        }
                        .disabled(!canStart || starting || !store.isServerLive)
                    }
                    ToolbarItemGroup(placement: .keyboard) {
                        Spacer()
                        Button("Done") {
                            searchFocused = false
                            promptFocused = false
                        }
                    }
                }
                .task {
                    // E2E hook: -PerchNewAgentKind preselects the agent so the sheet
                    // (and its per-agent model tiers) can be screenshotted under sim
                    // automation, which cannot tap the agent buttons.
                    if let raw = UserDefaults.standard.string(forKey: "PerchNewAgentKind"),
                       let kind = AgentKind(rawValue: raw), agents.contains(kind) {
                        agent = kind
                    }
                    model = resolvedModel(for: agent)
                    guard store.isServerLive else { return }
                    recents = await store.fetchProjects()
                    // Default the destination to the most recent project.
                    if selectedPath == nil { selectedPath = recents.first?.rootPath }
                    // E2E hook: -PerchDictationDemo drives one scripted record -> stop
                    // pass on the kickoff prompt (it implies the fake engine) so the
                    // recording UI and the committed transcript can be captured under
                    // sim automation, which cannot tap the mic or scroll.
                    if UserDefaults.standard.bool(forKey: "PerchDictationDemo") {
                        try? await Task.sleep(for: .seconds(1))
                        proxy.scrollTo("prompt", anchor: .bottom)
                        dictation.begin(currentText: prompt) { prompt = $0 }
                        try? await Task.sleep(for: .seconds(4))
                        dictation.finishRecording()
                    }
                }
            }
        }
    }

    // MARK: - Agent

    private var agentPicker: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionLabel("Agent")
            HStack(spacing: 10) {
                ForEach(agents, id: \.self) { kind in
                    agentButton(kind)
                }
            }
        }
    }

    private func agentButton(_ kind: AgentKind) -> some View {
        let selected = agent == kind
        return Button {
            agent = kind
            // Model lists differ per agent, so select that provider's concrete
            // current registry default.
            model = resolvedModel(for: kind)
        } label: {
            HStack(spacing: 8) {
                AgentGlyph(agent: kind)
                Text(kind.displayName)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Style.textPrimary)
            }
            .padding(.vertical, 8)
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(selected ? Style.secondaryFill : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(selected ? Style.textPrimary.opacity(0.25) : Style.hairline, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Model

    // Launch-time choices come from the registry's newest-first visible list.
    // The initial selection is always a concrete runtime id, so the checked
    // row and the model sent at launch agree.
    @ViewBuilder
    private var modelPicker: some View {
        let rows = modelRows
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                sectionLabel("Model")
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        modelRow(id: row.id, label: row.label, detail: row.detail, removed: row.isRemoved)
                        if index != rows.count - 1 { Divider().overlay(Style.hairline) }
                    }
                }
            }
        }
    }

    // Newest visible models, plus the current selection when it falls outside
    // them so a saved/default pick is never silently dropped (a still-offered
    // model kept normally, a removed one flagged).
    private var modelRows: [ModelPickerRow] {
        let selected = model ?? resolvedModel(for: agent)
        let label = selected.map { store.modelLabel(for: $0) } ?? ""
        if let catalog = store.models?.providers.first(where: { $0.provider == agent }) {
            return catalog.pickerRows(selectedId: selected, selectedLabel: label, selectedDetail: nil)
        }
        let compact = agent.pickerModelOptions.map {
            ModelPickerRow(id: $0.id, label: $0.label, detail: $0.detail, isRemoved: false)
        }
        return compactModelPickerRows(
            compact: compact,
            offeredIds: Set(agent.modelOptions.map(\.id)),
            selectedId: selected,
            selectedLabel: label,
            selectedDetail: nil
        )
    }

    private func resolvedModel(for agent: AgentKind) -> String? {
        let catalog = store.models?.providers.first { $0.provider == agent }
        let options = catalog?.agentOptions ?? agent.pickerModelOptions
        let configured = catalog?.defaultId
        return options.first(where: { $0.id == configured })?.id ?? options.first?.id
    }

    private func modelRow(id: String, label: String, detail: String?, removed: Bool = false) -> some View {
        let selected = (model ?? resolvedModel(for: agent)) == id
        return Button {
            model = id
        } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(label)
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(removed ? Style.textSecondary : Style.textPrimary)
                        if removed {
                            Text("Removed")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(Style.textFaint)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Capsule().fill(Style.secondaryFill))
                        }
                    }
                    if let detail, !detail.isEmpty {
                        Text(detail)
                            .font(.system(size: 12))
                            .foregroundStyle(removed ? Style.textFaint : Style.textSecondary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 8)
                if selected {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 17))
                        .foregroundStyle(Style.textPrimary)
                }
            }
            .padding(.vertical, 10)
            .padding(.horizontal, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Project

    private var projectPicker: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionLabel("Project")

            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 14))
                    .foregroundStyle(Style.textSecondary)
                TextField("Search directories…", text: $query)
                    .font(.system(size: 15))
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .focused($searchFocused)
                    .onChange(of: query) { _, value in scheduleSearch(value) }
                    .disabled(!store.isServerLive)
            }
            .padding(.vertical, 10)
            .padding(.horizontal, 12)
            .background(Style.secondaryFill)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

            // Live suggestions while searching, recents otherwise.
            let rows = query.trimmingCharacters(in: .whitespaces).isEmpty
                ? recents.map(\.rootPath)
                : suggestions
            VStack(spacing: 0) {
                ForEach(rows, id: \.self) { path in
                    projectRow(path)
                    if path != rows.last { Divider().overlay(Style.hairline) }
                }
                if rows.isEmpty {
                    Text(query.isEmpty ? "No recent projects yet" : "No matches")
                        .font(.system(size: 14))
                        .foregroundStyle(Style.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 12)
                        .padding(.horizontal, 4)
                }
            }
        }
    }

    private func projectRow(_ path: String) -> some View {
        Button {
            selectedPath = path
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "folder")
                    .font(.system(size: 14))
                    .foregroundStyle(Style.textSecondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text((path as NSString).lastPathComponent)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Style.textPrimary)
                    Text(shortenHome(path))
                        .font(.system(size: 12))
                        .foregroundStyle(Style.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
                Spacer(minLength: 8)
                if selectedPath == path {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 17))
                        .foregroundStyle(Style.textPrimary)
                }
            }
            .padding(.vertical, 10)
            .padding(.horizontal, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Isolation

    private var isolationToggle: some View {
        Toggle(isOn: $worktree) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Fresh worktree")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Style.textPrimary)
                Text(worktree
                     ? "Isolated checkout; your working tree is untouched"
                     : "Runs in place in the project directory")
                    .font(.system(size: 12))
                    .foregroundStyle(Style.textSecondary)
            }
        }
        .tint(Style.accent)
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        .background(Style.secondaryFill)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    // MARK: - Prompt

    private var promptField: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionLabel("Kickoff prompt")
            HStack(alignment: .bottom, spacing: 10) {
                if dictation.isActive {
                    DictationRecordingRow(dictation: dictation)
                } else {
                    TextField("What should it work on?", text: $prompt, axis: .vertical)
                        .lineLimit(3...8)
                        .font(.system(size: 15))
                        .focused($promptFocused)

                    VoiceDictationButton(dictation: dictation, text: $prompt) {
                        promptFocused = true
                    }
                }
            }
            .padding(12)
            .background(Style.secondaryFill)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .animation(.snappy(duration: 0.22, extraBounce: 0.02), value: dictation.isActive)
            .dictationLifecycle(dictation)
        }
    }

    // MARK: - Helpers

    private func sectionLabel(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(Style.textSecondary)
            .kerning(0.5)
    }

    private var canStart: Bool {
        selectedPath != nil
    }

    private func scheduleSearch(_ value: String) {
        searchTask?.cancel()
        guard store.isServerLive else {
            suggestions = []
            return
        }
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else {
            suggestions = []
            return
        }
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(180))
            if Task.isCancelled { return }
            let results = await store.suggestDirectories(trimmed)
            if Task.isCancelled { return }
            suggestions = results
        }
    }

    private func start() {
        guard let path = selectedPath, !starting, store.isServerLive else { return }
        starting = true
        Task {
            let ok = await store.startAgent(
                project: path,
                agent: agent.rawValue,
                prompt: prompt,
                worktree: worktree,
                model: model ?? resolvedModel(for: agent)
            )
            starting = false
            if ok { dismiss() }
        }
    }
}

private func shortenHome(_ path: String) -> String {
    let home = NSHomeDirectory()
    if path == home { return "~" }
    if path.hasPrefix(home + "/") { return "~" + path.dropFirst(home.count) }
    return path
}

extension AgentKind {
    var displayName: String {
        switch self {
        case .claude: "Claude"
        case .codex: "Codex"
        case .shell: "Shell"
        case .unknown: "Agent"
        }
    }
}
