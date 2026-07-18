import SwiftUI

// The killer moment of the product: the agent is blocked on a permission
// prompt and one tap from anywhere resumes it. Structured Claude requests are
// answered through the waiting hook; only degraded prompts use local UI.
struct ApprovalCard: View {
    let approval: PendingApproval
    let onDecision: (String) async -> Void

    @State private var deciding = false

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.shield.fill")
                    .font(.system(size: 11, weight: .bold))
                Text("PERMISSION")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .tracking(1.2)
            }
            .foregroundStyle(Style.warningText)

            Text(approval.summary)
                .font(.system(size: 13.5, weight: .medium))
                .foregroundStyle(Style.textPrimary)

            if let context = ApprovalPresentation.contextLine(tool: approval.context?.tool, app: approval.context?.app) {
                Text(context)
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Style.textSecondary)
            }

            if approval.decisions?.isEmpty != false, let command = approval.command {
                Text(command)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(Style.textPrimary)
                    .lineLimit(4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(Color.black.opacity(0.4))
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }

            if approval.remoteResolutionUnavailable == true {
                Text(approval.requestVersion == 1
                    ? "Remote approval expired or disconnected. Answer Claude's native dialog on the desktop."
                    : "Structured remote resolution is unavailable. Answer this prompt in the desktop Codex session.")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Style.warningText)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let decisions = approval.decisions, !decisions.isEmpty {
                VStack(spacing: 7) {
                    ForEach(decisions) { decision in
                        Button {
                            decide(decision.id)
                        } label: {
                            VStack(spacing: 2) {
                                Text(decision.label)
                                    .font(.system(size: 14, weight: .semibold))
                                if let hint = ApprovalPresentation.persistenceHint(decision.persistence) {
                                    Text(hint)
                                        .font(.system(size: 10.5, weight: .medium))
                                        .foregroundStyle(Style.textSecondary)
                                }
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                        }
                        .buttonStyle(.glass)
                        .tint(decision.destructive == true ? Style.errorText : Style.success)
                        .disabled(deciding || approval.submittedDecision != nil)
                    }
                }
            } else {
                HStack(spacing: 8) {
                    Button {
                        decide("deny")
                    } label: {
                        Text("Deny")
                            .font(.system(size: 14, weight: .semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 9)
                    }
                    .buttonStyle(.glass)
                    .tint(Style.errorText)

                    Button {
                        decide("allow")
                    } label: {
                        Text("Allow")
                            .font(.system(size: 14, weight: .semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 9)
                    }
                    .buttonStyle(.glassProminent)
                    .tint(Style.success)
                }
                .disabled(deciding || approval.submittedDecision != nil)
            }

            if let submitted = approval.submittedDecision {
                let label = ApprovalPresentation.submittedLabel(
                    submitted,
                    advertised: approval.decisions?.map { ($0.id, $0.label) } ?? []
                )
                Text(approval.requestVersion == 1
                    ? "Sent \(label). Waiting for later Claude activity to confirm it…"
                    : "Sent \(label). Waiting for the terminal to confirm resolution…")
                    .font(.system(size: 11))
                    .foregroundStyle(Style.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(13)
        .background(Style.warning.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Style.warning.opacity(0.4))
        }
        // A new prompt can reuse this card's SwiftUI identity; its buttons
        // must not inherit the previous prompt's in-flight state.
        .onChange(of: approval.id) {
            deciding = false
        }
    }

    private func decide(_ decision: String) {
        guard !deciding else { return }
        deciding = true
        Task {
            await onDecision(decision)
            // On success the card disappears with the next fleet snapshot; if
            // the request failed the buttons come back for a retry.
            deciding = false
        }
    }
}

// Codex app-server requests are not terminal dialogs. The server supplies the
// exact valid choices and this card posts a structured response pinned to the
// JSON-RPC request id; it never guesses a PTY key.
struct StructuredRequestCard: View {
    let request: PendingServerRequest
    let onResponse: (_ decision: String?, _ content: [String: Any]?) async -> Void

    @State private var deciding = false
    @State private var answers: [String: String] = [:]

    private var questions: [StructuredQuestion] {
        guard case let .array(values) = request.content["questions"] else { return [] }
        return values.compactMap(StructuredQuestion.init)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("CODEX REQUEST", systemImage: "exclamationmark.shield.fill")
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .tracking(1.1)
                .foregroundStyle(Style.warningText)

            Text(request.summary)
                .font(.system(size: 13.5, weight: .medium))
                .foregroundStyle(Style.textPrimary)

            if case let .string(command) = request.content["command"] {
                Text(command)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(Style.textPrimary)
                    .lineLimit(4)
                    .padding(9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.black.opacity(0.4))
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }

            if request.family == "request_user_input" {
                ForEach(questions) { question in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(question.question)
                            .font(.system(size: 13, weight: .medium))
                        if question.options.isEmpty {
                            if question.isSecret {
                                SecureField("Answer", text: binding(for: question.id))
                                    .textFieldStyle(.roundedBorder)
                            } else {
                                TextField("Answer", text: binding(for: question.id))
                                    .textFieldStyle(.roundedBorder)
                            }
                        } else {
                            ForEach(question.options, id: \.self) { option in
                                Button {
                                    answers[question.id] = option
                                } label: {
                                    HStack {
                                        Image(systemName: answers[question.id] == option ? "largecircle.fill.circle" : "circle")
                                        Text(option)
                                        Spacer()
                                    }
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                Button("Submit") { submitAnswers() }
                    .buttonStyle(.glassProminent)
                    .tint(Style.accent)
                    .disabled(deciding || questions.contains { (answers[$0.id] ?? "").isEmpty })
            } else {
                VStack(spacing: 7) {
                    ForEach(request.decisions) { decision in
                        Button {
                            respond(decision.id)
                        } label: {
                            Text(decision.label)
                                .font(.system(size: 14, weight: .semibold))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                        }
                        .buttonStyle(.glass)
                        .tint(decision.destructive == true ? Style.errorText : Style.success)
                        .disabled(deciding)
                    }
                }
            }

            if deciding {
                Text("Waiting for Codex to confirm resolution…")
                    .font(.system(size: 11))
                    .foregroundStyle(Style.textSecondary)
            }
        }
        .padding(13)
        .background(Style.warning.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 14).stroke(Style.warning.opacity(0.4)) }
        .onChange(of: request.requestId) { deciding = false; answers = [:] }
    }

    private func binding(for id: String) -> Binding<String> {
        Binding(get: { answers[id] ?? "" }, set: { answers[id] = $0 })
    }

    private func respond(_ decision: String) {
        guard !deciding else { return }
        deciding = true
        Task { await onResponse(decision, nil) }
    }

    private func submitAnswers() {
        guard !deciding else { return }
        deciding = true
        let payload = Dictionary(uniqueKeysWithValues: questions.map { question in
            (question.id, ["answers": [answers[question.id] ?? ""]])
        })
        Task { await onResponse(nil, ["answers": payload]) }
    }
}

private struct StructuredQuestion: Identifiable {
    let id: String
    let question: String
    let isSecret: Bool
    let options: [String]

    init?(_ value: JSONValue) {
        guard case let .object(object) = value,
              case let .string(id) = object["id"],
              case let .string(question) = object["question"] else { return nil }
        self.id = id
        self.question = question
        if case let .bool(secret) = object["isSecret"] { isSecret = secret } else { isSecret = false }
        if case let .array(values) = object["options"] {
            options = values.compactMap { value in
                guard case let .object(option) = value, case let .string(label) = option["label"] else { return nil }
                return label
            }
        } else {
            options = []
        }
    }
}
