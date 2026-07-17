import SwiftUI

// The no-mistakes decision surface: a worker's pipeline parked at a gate with
// findings only the boss can rule on. Pending, it is a compact chip naming
// the gate and finding count - the QuestionChip treatment, never a full-bleed
// card fighting the timeline. Tapping opens a sheet with every finding
// verbatim (id, severity, file, description - expandable, never silently
// truncated) and exactly two actions in the boss's language: Fix (primary;
// the upstream fix verb - the pipeline repairs the selected findings) and
// Skip (the upstream APPROVE verb - continue without fixing these findings).
// Upstream's step-level skip verb has no card UI; terminal users keep
// `axi respond --action skip` and the server verb still accepts it. Labels
// are UI language only: the API call, audit log, ledger note, and mate FYI
// all carry the real verb. Submitting POSTs /tasks/:id/decision; the server
// injects the matching `axi respond` line into the worker and FYIs the mate.

// The gate a session's task is parked on, resolved from the task's event log.
// eventSeq pins the answer to this exact gate (a re-parked task gets a new
// seq, so a stale "sent" chip can never mask a fresh gate); answered means a
// decision note already follows it on the ledger (the mate or another phone
// resolved it), so no active card renders.
struct PendingGate: Equatable {
    let taskId: String
    let gate: NoMistakesGateModel
    let eventSeq: Int
    let answered: Bool

    // sentDecisions key: this exact gate on this exact task.
    var sentKey: String { "\(taskId):\(eventSeq)" }
}

private let decisionAccent = Style.accent

// Short human label for the collapsed chip, in the boss's language ("Skip" =
// the approve verb). UI only - the wire verb stays approve/fix/skip.
func decisionSummaryLabel(action: String, findingIds: [String]) -> String {
    if action == "approve" { return "continue without fixing" }
    if action == "skip" { return "skip this step" }
    return findingIds.isEmpty ? "fix" : "fix \(findingIds.joined(separator: ", "))"
}

// The pending chip: gate step + finding count, with a "Decide…" affordance.
struct DecisionChip: View {
    let pending: PendingGate
    // Returns the server's error message, or nil on success.
    let onSubmit: (_ action: String, _ findingIds: [String], _ instructions: String?) async -> String?

    @State private var showSheet = false

    private var countLabel: String {
        let count = pending.gate.findings.count
        return count == 1 ? "1 finding needs you" : "\(count) findings need you"
    }

    var body: some View {
        Button {
            showSheet = true
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "checkmark.shield.fill")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(decisionAccent)
                VStack(alignment: .leading, spacing: 1) {
                    Text("\(pending.gate.step) gate: \(countLabel)")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Style.textPrimary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    Text("no-mistakes pipeline is parked on your call")
                        .font(.system(size: 12))
                        .foregroundStyle(Style.textSecondary)
                }
                Spacer(minLength: 8)
                Text("Decide")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(decisionAccent)
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 11)
            .background(decisionAccent.opacity(0.09))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(decisionAccent.opacity(0.35))
            }
        }
        .buttonStyle(.plain)
        .sheet(isPresented: $showSheet) {
            DecisionSheet(pending: pending, onSubmit: onSubmit)
                .preferredColorScheme(.dark)
        }
    }
}

// The collapsed chip after answering: what was sent, until the worker resumes.
struct SentDecisionChip: View {
    let summary: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(decisionAccent)
            Text("Decision sent - \(summary)")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Style.textSecondary)
                .lineLimit(2)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 11)
        .background(Style.secondaryFill)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Style.hairline)
        }
    }
}

// The full decision surface: findings verbatim, then the three verbs.
// Approve/Skip submit directly; Fix… switches the list into selection mode
// (all findings preselected) and adds an instructions field.
struct DecisionSheet: View {
    @Environment(\.dismiss) private var dismiss
    let pending: PendingGate
    let onSubmit: (_ action: String, _ findingIds: [String], _ instructions: String?) async -> String?

    @State private var fixMode = false
    @State private var selected: Set<String> = []
    @State private var instructions = ""
    @State private var submitting = false
    @State private var errorMessage: String?
    @FocusState private var instructionsFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("The pipeline parked at the \(pending.gate.step) step. Findings are shown exactly as the gate wrote them.")
                        .font(.system(size: 13))
                        .foregroundStyle(Style.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)

                    ForEach(pending.gate.findings) { finding in
                        FindingRow(
                            finding: finding,
                            selectable: fixMode,
                            selected: selected.contains(finding.id)
                        ) {
                            if selected.contains(finding.id) {
                                selected.remove(finding.id)
                            } else {
                                selected.insert(finding.id)
                            }
                        }
                    }

                    if let errorMessage {
                        Text(errorMessage)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Style.errorText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(20)
            }
            .background(Style.canvas)
            .navigationTitle("\(pending.gate.step) gate")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom) {
                actionBar
                    .padding(.horizontal, 20)
                    .padding(.vertical, 10)
                    .background(Style.canvas.opacity(0.94))
            }
        }
    }

    @ViewBuilder
    private var actionBar: some View {
        if fixMode {
            VStack(spacing: 10) {
                TextField("Instructions for the fix (optional)", text: $instructions, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...4)
                    .font(.system(size: 15))
                    .tint(decisionAccent)
                    .focused($instructionsFocused)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Style.composerFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(instructionsFocused ? Style.composerBorderFocused : Style.composerBorder)
                    }

                HStack(spacing: 10) {
                    Button("Back") {
                        fixMode = false
                    }
                    .buttonStyle(.glass)
                    .disabled(submitting)

                    Button {
                        submit("fix")
                    } label: {
                        Group {
                            if submitting {
                                ProgressView().controlSize(.small)
                            } else {
                                Text(fixLabel)
                                    .font(.system(size: 15, weight: .semibold))
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                    }
                    .buttonStyle(.glassProminent)
                    .tint(decisionAccent)
                    .disabled(submitting || selected.isEmpty)
                }
            }
        } else {
            // Exactly two actions, the boss's labels: Fix (primary) runs the
            // upstream fix verb; Skip runs the upstream APPROVE verb -
            // continue without fixing these findings. Upstream's step-level
            // skip verb has no card UI (terminal users keep
            // `axi respond --action skip`; the server verb still accepts it
            // for API completeness). The wire always carries the real verb.
            VStack(spacing: 7) {
                HStack(spacing: 10) {
                    Button {
                        submit("approve")
                    } label: {
                        Group {
                            if submitting {
                                ProgressView().controlSize(.small)
                            } else {
                                Text("Skip")
                                    .font(.system(size: 15, weight: .semibold))
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                    }
                    .buttonStyle(.glass)
                    .disabled(submitting)

                    Button {
                        // Preselect everything: "fix what the gate found" is
                        // the common answer; deselect to narrow it.
                        selected = Set(pending.gate.findings.map(\.id))
                        fixMode = true
                    } label: {
                        Text("Fix")
                            .font(.system(size: 15, weight: .semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.glassProminent)
                    .tint(decisionAccent)
                    .disabled(submitting)
                }

                Text("Fix - repairs these findings / Skip - continue without fixing")
                    .font(.system(size: 11.5))
                    .foregroundStyle(Style.textFaint)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
            }
        }
    }

    private var fixLabel: String {
        selected.count == pending.gate.findings.count
            ? "Fix all findings"
            : "Fix \(selected.sorted().joined(separator: ", "))"
    }

    private func submit(_ action: String) {
        guard !submitting else { return }
        submitting = true
        errorMessage = nil
        Task {
            // Sending every id when all are selected keeps the respond line
            // explicit about what the boss saw and chose.
            let ids = action == "fix" ? selected.sorted() : []
            let error = await onSubmit(action, ids, action == "fix" ? instructions : nil)
            submitting = false
            if let error {
                errorMessage = error
            } else {
                dismiss()
            }
        }
    }
}

// One finding, verbatim: id + severity + location header over the full
// description. Long descriptions clamp with a visible "Show all" toggle -
// expandable, never silently truncated.
private struct FindingRow: View {
    let finding: NoMistakesFindingModel
    let selectable: Bool
    let selected: Bool
    let onToggle: () -> Void

    @State private var expanded = false

    private var clampable: Bool {
        finding.description.count > 280
    }

    private var severity: String {
        finding.severity ?? "unknown"
    }

    private var severityColor: Color {
        switch severity.lowercased() {
        case "blocker", "critical", "fatal", "error": Style.errorText
        case "high", "warning", "warn", "medium": Style.warningText
        default: Style.textSecondary
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if selectable {
                Button(action: onToggle) {
                    Image(systemName: selected ? "checkmark.square.fill" : "square")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(selected ? decisionAccent : Style.textFaint)
                }
                .buttonStyle(.plain)
                .padding(.top, 1)
            }

            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(finding.id)
                        .font(.system(size: 12, weight: .bold, design: .monospaced))
                        .foregroundStyle(Style.textPrimary)
                    Text(severity)
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(severityColor)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(severityColor.opacity(0.14))
                        .clipShape(Capsule())
                    if let action = finding.action, !action.isEmpty {
                        Text(action)
                            .font(.system(size: 10.5, weight: .semibold))
                            .foregroundStyle(Style.textFaint)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Style.secondaryFill)
                            .clipShape(Capsule())
                    }
                    Spacer(minLength: 0)
                }

                if let file = finding.file, !file.isEmpty {
                    Text(finding.line.map { "\(file):\($0)" } ?? file)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(Style.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }

                Text(finding.description)
                    .font(.system(size: 14))
                    .foregroundStyle(Style.textPrimary)
                    .lineLimit(clampable && !expanded ? 6 : nil)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)

                if clampable {
                    Button(expanded ? "Show less" : "Show all") {
                        withAnimation(.easeInOut(duration: 0.15)) {
                            expanded.toggle()
                        }
                    }
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(decisionAccent)
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(selectable && selected ? decisionAccent.opacity(0.08) : Color.black.opacity(0.25))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(selectable && selected ? decisionAccent.opacity(0.4) : Style.hairline)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            if selectable {
                onToggle()
            }
        }
    }
}
