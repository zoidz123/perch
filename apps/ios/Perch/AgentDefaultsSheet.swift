import SwiftUI

// The fleet's agent/model defaults, opened from the mate's model chip.
//
// Two sections, because the two things it configures behave differently:
//
// - MATE: the running mate's agent was fixed when it launched (there is no
//   mid-conversation agent switch), so the agent is shown read-only and only
//   the model is editable. Picking a model both switches the live mate
//   (POST /sessions/:id/model) and persists it as the mate default for the
//   next launch (PATCH /config mateDefaults).
// - CREW: the defaults a dispatched worker launches on. Nothing is running, so
//   agent, model, and effort are all freely editable and only persisted
//   (PATCH /config dispatchDefaults).
//
// Both model lists are scoped to their section's agent - a claude mate never
// offers GPT models - by filtering the server's per-provider catalog.
struct AgentDefaultsSheet: View {
    @EnvironmentObject private var store: PerchStore
    @Environment(\.dismiss) private var dismiss

    let mateSessionId: String
    let mateAgent: AgentKind

    @State private var mateModel: String?
    @State private var crewAgent: AgentKind = .claude
    @State private var crewModel: String?
    @State private var crewEffort: String?
    @State private var saving = false

    private let agents: [AgentKind] = [.claude, .codex]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    mateSection
                    Divider().overlay(Style.hairline)
                    crewSection
                }
                .padding(20)
            }
            .background(Style.canvas)
            .navigationTitle("Defaults")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                await store.loadConfig()
                applyCrewFromConfig()
                mateModel = resolvedMateModel()
            }
        }
    }

    // MARK: - Mate

    private var mateSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionLabel("Mate")

            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    AgentGlyph(agent: mateAgent)
                    Text(mateAgent.displayName)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Style.textPrimary)
                    Spacer(minLength: 8)
                    Image(systemName: "lock.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(Style.textFaint)
                }
                .padding(.vertical, 10)
                .padding(.horizontal, 12)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Style.secondaryFill)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(Style.hairline, lineWidth: 1)
                )

                Text("Set when you start a mate")
                    .font(.system(size: 12))
                    .foregroundStyle(Style.textFaint)
            }

            VStack(alignment: .leading, spacing: 8) {
                subLabel("Model")
                modelList(for: mateAgent, selected: mateModel) { selectMateModel($0) }
                Text("Switches the running mate and becomes its default next launch.")
                    .font(.system(size: 12))
                    .foregroundStyle(Style.textFaint)
            }
        }
    }

    // The live mate is the truth for what it is running right now; the registry
    // only says what the NEXT mate launches on. Resolve the running model back
    // to the catalog id the rows are keyed by, so the running model is ticked
    // even though the CLI reports it with launch plumbing ("opus[1m]" -> "opus").
    private func resolvedMateModel() -> String? {
        let session = store.session(for: mateSessionId)
        if let live = session?.model {
            let match = options(for: mateAgent).first {
                modelOptionMatches($0, id: live, label: session?.modelLabel)
            }
            return match?.id ?? live
        }
        let configured = store.config?.mateDefaults.model
        if let configured, configured != "auto" { return configured }
        return store.models?.providers
            .first { $0.provider == mateAgent }?
            .roleDefault(for: "orchestrator")?.model
    }

    // Applying to the live mate first means a failed switch never persists a
    // default the boss would then see the mate contradict.
    private func selectMateModel(_ id: String) {
        guard !saving, id != mateModel else { return }
        let previous = mateModel
        mateModel = id
        saving = true
        Task {
            if await store.switchModel(sessionId: mateSessionId, to: id) {
                await store.updateConfig(mateDefaults: ["model": id])
            } else {
                mateModel = previous
            }
            saving = false
        }
    }

    // MARK: - Crew

    private var crewSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                sectionLabel("Crew")
                Text("What a dispatched worker launches on.")
                    .font(.system(size: 12))
                    .foregroundStyle(Style.textFaint)
                Text(crewLaunchSummary)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Style.textPrimary)
            }

            VStack(alignment: .leading, spacing: 8) {
                subLabel("Agent")
                HStack(spacing: 10) {
                    ForEach(agents, id: \.self) { kind in
                        crewAgentButton(kind)
                    }
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                subLabel("Model")
                modelList(for: crewAgent, selected: crewModel) { id in
                    guard !saving, id != crewModel else { return }
                    let effort = resolvedEffort(for: id, agent: crewAgent, preferred: crewEffort)
                    saveCrew(model: id, effort: effort) {
                        crewModel = id
                        crewEffort = effort
                    }
                }
            }

            // Reasoning effort is a Codex knob; Claude has none.
            if crewAgent == .codex {
                VStack(alignment: .leading, spacing: 8) {
                    subLabel("Reasoning effort")
                    Menu {
                        ForEach(effortLevels(for: crewAgent), id: \.self) { level in
                            Button {
                                guard !saving, crewEffort != level else { return }
                                saveCrew(effort: level) {
                                    crewEffort = level
                                }
                            } label: {
                                if crewEffort == level {
                                    Label(level.capitalized, systemImage: "checkmark")
                                } else {
                                    Text(level.capitalized)
                                }
                            }
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Text(crewEffort?.capitalized ?? "Medium")
                            Image(systemName: "chevron.up.chevron.down")
                                .font(.system(size: 11, weight: .semibold))
                        }
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Style.textPrimary)
                        .padding(.vertical, 8)
                        .padding(.horizontal, 10)
                        .background(Style.secondaryFill)
                        .clipShape(Capsule())
                    }
                }
            }
        }
    }

    private var crewLaunchSummary: String {
        var parts = [crewAgent.displayName, crewModelLabel]
        if crewAgent == .codex, let effort = crewEffort {
            parts.append(effort.capitalized)
        }
        return parts.joined(separator: " · ")
    }

    private var crewModelLabel: String {
        guard let model = crewModel else { return "No model available" }
        return options(for: crewAgent).first { $0.id == model }?.label ?? store.modelLabel(for: model)
    }

    private func crewAgentButton(_ kind: AgentKind) -> some View {
        let selected = crewAgent == kind
        return Button {
            guard !saving, kind != crewAgent else { return }
            // Model lists are per-agent, so a carried-over model would name a
            // model the new agent cannot run; effort is Codex-only.
            let clearEffort = kind != .codex
            let catalog = store.models?.providers.first { $0.provider == kind }
            let roleDefault = catalog?.roleDefault(for: "crew")
            let nextModel = roleDefault?.model ?? options(for: kind).first?.id
            let nextEffort = kind == .codex ? roleDefault?.effort ?? catalog?.defaultReasoningEffort : nil
            saveCrew(agent: kind.rawValue, model: nextModel, effort: clearEffort ? NSNull() : nextEffort) {
                crewAgent = kind
                crewModel = nextModel
                crewEffort = resolvedEffort(for: nextModel, agent: kind, preferred: nextEffort)
            }
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

    // `nil` leaves a key untouched; `NSNull()` clears it. The server returns the
    // effective config it settled on, so re-reading it afterwards keeps the rows
    // honest whether the write landed, was overridden by env, or failed.
    private func saveCrew(agent: Any? = nil, model: Any? = nil, effort: Any? = nil, applyLocal: @escaping () -> Void) {
        var body: [String: Any] = [:]
        if let agent { body["agent"] = agent }
        if let model { body["model"] = model }
        if let effort { body["effort"] = effort }
        guard !body.isEmpty else { return }
        saving = true
        Task {
            let saved = await store.updateConfig(dispatchDefaults: body)
            if saved {
                applyLocal()
            }
            applyCrewFromConfig()
            saving = false
        }
    }

    private func applyCrewFromConfig() {
        let defaults = store.config?.dispatchDefaults
        let resolved = store.config?.dispatchResolved
        // Nothing configured means the current Perch crew role policy.
        let agent = defaults?.agent ?? resolved?.agent ?? .claude
        crewAgent = agents.contains(agent) ? agent : .claude
        let catalog = store.models?.providers.first { $0.provider == crewAgent }
        let roleDefault = catalog?.roleDefault(for: "crew")
        crewModel = defaults?.model ?? resolved?.model ?? roleDefault?.model ?? options(for: crewAgent).first?.id
        crewEffort = resolvedEffort(
            for: crewModel,
            agent: crewAgent,
            preferred: defaults?.effort ?? resolved?.effort ?? roleDefault?.effort ?? catalog?.defaultReasoningEffort
        )
    }

    // MARK: - Shared rows

    // The server catalog is the single source of truth for which models an
    // agent can run; the static per-agent catalog covers an older server.
    private func options(for agent: AgentKind) -> [AgentModelOption] {
        let catalog = store.models?.providers.first { $0.provider == agent }
        return catalog?.agentOptions ?? agent.pickerModelOptions
    }

    // Effort ladder for the crew's selected concrete model, so
    // the buttons match that model's ceiling instead of a union across models.
    private func effortLevels(for agent: AgentKind) -> [String] {
        guard agent == .codex else { return [] }
        guard let catalog = store.models?.providers.first(where: { $0.provider == agent }) else {
            return fallbackCodexEffortLevels
        }
        return catalog.effortLevels(forModel: crewModel)
    }

    private func resolvedEffort(for model: String?, agent: AgentKind, preferred: String?) -> String? {
        guard agent == .codex else { return nil }
        let levels: [String]
        if let catalog = store.models?.providers.first(where: { $0.provider == .codex }) {
            levels = catalog.effortLevels(forModel: model)
        } else {
            levels = fallbackCodexEffortLevels
        }
        if let preferred, levels.contains(preferred) { return preferred }
        let advertised = store.models?.providers
            .first { $0.provider == .codex }?
            .options
            .first { $0.id == model || $0.runtimeId == model }?
            .defaultReasoningEffort
        return advertised.flatMap { levels.contains($0) ? $0 : nil } ?? levels.first
    }

    @ViewBuilder
    private func modelList(
        for agent: AgentKind,
        selected: String?,
        select: @escaping (String) -> Void
    ) -> some View {
        let rows = options(for: agent)
        if rows.isEmpty {
            Text("No models available for \(agent.displayName)")
                .font(.system(size: 13))
                .foregroundStyle(Style.textFaint)
        } else {
            optionCard {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, option in
                    optionRow(label: option.label, detail: option.detail, selected: selected == option.id) {
                        select(option.id)
                    }
                    if index != rows.count - 1 { Divider().overlay(Style.hairline) }
                }
            }
        }
    }

    private func optionCard<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0, content: content)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Style.secondaryFill)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Style.hairline, lineWidth: 1)
            )
    }

    private func optionRow(label: String, detail: String?, selected: Bool, tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(label)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Style.textPrimary)
                    if let detail, !detail.isEmpty {
                        Text(detail)
                            .font(.system(size: 12))
                            .foregroundStyle(Style.textSecondary)
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
            .padding(.horizontal, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(Style.textSecondary)
            .kerning(0.5)
    }

    private func subLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(Style.textSecondary)
    }
}
