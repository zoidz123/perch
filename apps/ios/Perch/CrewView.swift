import SwiftUI

// A crew row: one tracked task joined with its worker session. The task
// carries the meaning (verb state, PR progress); the session carries the
// liveness (running / needs approval). Tap opens the worker's chat; the
// context menu runs teardown through the server's landed-gate.
struct TaskRow: View {
    @EnvironmentObject private var store: PerchStore
    @Environment(\.openURL) private var openURL
    let task: AgentTask
    let session: AgentSession?
    // Nested under a project header, the project is already said once.
    var showsProject = true

    @State private var tearingDown = false
    @State private var teardownError: String?
    @State private var confirmForce = false

    var body: some View {
        rowContent
        .contentShape(Rectangle())
        .onTapGesture { openLiveSession() }
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "Open \(workerIdentity)") { openLiveSession() }
        .contextMenu {
            Button {
                teardown(force: false)
            } label: {
                Label("Tear down", systemImage: "checkmark.seal")
            }
            Button(role: .destructive) {
                confirmForce = true
            } label: {
                Label("Force tear down", systemImage: "exclamationmark.triangle")
            }
        }
        .confirmationDialog(
            "Force teardown discards any unlanded work in the task's worktree.",
            isPresented: $confirmForce,
            titleVisibility: .visible
        ) {
            Button("Discard and tear down", role: .destructive) {
                teardown(force: true)
            }
        }
        .alert("Teardown refused", isPresented: .init(
            get: { teardownError != nil },
            set: { if !$0 { teardownError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(teardownError ?? "")
        }
        .alert("Recovery failed", isPresented: .init(
            get: { recoveryError != nil },
            set: { if !$0 { store.clearRecoveryAction(for: task.id) } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(recoveryError ?? "")
        }
    }

    private var rowContent: some View {
        HStack(spacing: 12) {
            AgentGlyph(agent: workerAgent)

            VStack(alignment: .leading, spacing: 3) {
                Text(workerIdentity)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(Style.textPrimary)
                    .lineLimit(1)

                if workerIdentity != task.title {
                    Text(task.title)
                        .font(.system(size: 13))
                        .foregroundStyle(Style.textSecondary)
                        .lineLimit(1)
                }

                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        taskChip(primaryStatusChip)
                        if let label = runtimePresentation.label, label != "Live" {
                            runtimeChip(label, tone: runtimePresentation.tone)
                        }
                    }
                    if !statusMetadata.isEmpty {
                        Text(statusMetadata.joined(separator: " · "))
                            .font(.system(size: 12))
                            .foregroundStyle(Style.textSecondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    if let detail = runtimePresentation.detail {
                        Text(detail)
                            .font(.system(size: 12))
                            .foregroundStyle(runtimePresentation.tone == .attention ? Style.warningText : Style.textSecondary)
                            .lineLimit(2)
                    }
                    if showsProject {
                        Text(projectName)
                            .font(.system(size: 12.5))
                            .foregroundStyle(Style.textSecondary)
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                }
            }

            Spacer(minLength: 8)

            // The badge leads with TASK state; the worker's live session
            // status is only ever this dot (shared vocabulary, never text).
            if runtimePresentation.canRecover {
                Button {
                    Task { await store.recoverTask(task.id) }
                } label: {
                    Label("Recover", systemImage: "arrow.clockwise")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Style.textPrimary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .background(Style.secondaryFill, in: Capsule())
                        .overlay(Capsule().strokeBorder(Style.hairline, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .disabled(!store.isServerLive)
                .opacity(store.isServerLive ? 1 : 0.45)
                .accessibilityLabel("Recover \(workerIdentity)")
                .accessibilityHint(store.isServerLive ? "Starts a new runtime for this task" : "Reconnect to the Mac to recover")
            } else if tearingDown || runtimePresentation.showsProgress {
                ProgressView().controlSize(.small)
            } else if runtimePresentation.label == "Live" {
                WorkerStatusDot(status: session?.status)
                    .accessibilityLabel("Live")
            } else {
                WorkerStatusDot(status: session?.status)
            }

            if liveSessionId != nil {
                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Style.textFaint)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 15)
        .contentShape(Rectangle())
    }

    private var projectName: String {
        (task.project as NSString).lastPathComponent
    }

    private var workerIdentity: String {
        RecoveryIdentity.workerName(
            taskName: task.workerName,
            runtimeName: task.runtime?.workerName,
            sessionName: session?.workerName,
            title: task.title
        )
    }

    private var liveSessionId: String? {
        [task.runtime?.ptySessionId, task.sessionId].compactMap { $0 }.first { store.sessionsById[$0] != nil }
    }

    private var workerAgent: AgentKind {
        if let session { return session.agent }
        let raw = task.runtime?.provider ?? task.runtime?.agent
        return raw.flatMap(AgentKind.init(rawValue:)) ?? .unknown
    }

    private var runtimePresentation: RuntimePresentation {
        RuntimePresentation.make(runtime: task.runtime, action: store.recoveryAction(for: task.id))
    }

    private var recoveryError: String? {
        guard case let .failure(message) = store.recoveryAction(for: task.id) else { return nil }
        return message
    }

    private var primaryStatusChip: TaskStatusChip {
        TaskStatusPresentation.primaryChip(taskState: task.state, pr: task.pr.map(presentationPr))
    }

    private var statusMetadata: [String] {
        TaskStatusPresentation.metadata(taskState: task.state, pr: task.pr.map(presentationPr))
    }

    private func runtimeChip(_ label: String, tone: RuntimePresentationTone) -> some View {
        let color: Color = switch tone {
        case .neutral: Style.textSecondary
        case .attention: Style.warningText
        case .active: Style.accent
        case .success: Style.successText
        }
        return Text(label)
            .font(.system(size: 11, weight: .semibold))
            .lineLimit(1)
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 2.5)
            .background(color.opacity(0.14))
            .clipShape(Capsule())
    }

    @ViewBuilder
    private func taskChip(_ chip: TaskStatusChip) -> some View {
        if chip.isLink, let pr = task.pr, let url = URL(string: pr.url) {
            Button {
                openURL(url)
            } label: {
                chipLabel(chip)
            }
            .buttonStyle(.plain)
        } else {
            chipLabel(chip)
        }
    }

    private func chipLabel(_ chip: TaskStatusChip) -> some View {
        let color = chipColor(chip.tone)
        return Text(chip.label)
            .font(.system(size: 11, weight: .semibold))
            .lineLimit(1)
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 2.5)
            .background(color.opacity(0.14))
            .clipShape(Capsule())
    }

    private func chipColor(_ tone: TaskStatusTone) -> Color {
        switch tone {
        case .active:
            return Style.textPrimary
        case .neutral:
            return Style.textSecondary
        case .attention:
            return Style.warningText
        case .success:
            return Style.successText
        case .error:
            return Style.errorText
        }
    }

    private func presentationPr(_ pr: TaskPrModel) -> TaskStatusPr {
        TaskStatusPr(
            url: pr.url,
            checks: pr.checks,
            checkDetails: (pr.checkDetails ?? []).map { TaskStatusCheck(name: $0.name, state: $0.state) },
            mergeReady: pr.mergeReady,
            isDraft: pr.isDraft,
            mergeable: pr.mergeable,
            mergeStateStatus: pr.mergeStateStatus,
            reviewDecision: pr.reviewDecision,
            merged: pr.merged
        )
    }

    private func teardown(force: Bool) {
        guard !tearingDown else { return }
        tearingDown = true
        Task {
            let error = await store.teardownTask(task.id, force: force)
            tearingDown = false
            if let error {
                teardownError = error
            }
        }
    }

    private func openLiveSession() {
        if let liveSessionId {
            store.openSessionRef = SessionRef(id: liveSessionId)
        }
    }
}
