import SwiftUI

// The interactive-question counterpart of ApprovalCard, sized for the chat:
// the agent called AskUserQuestion and is blocked on a choice. Pending, it is
// a COMPACT chip naming the question with an "Answer…" affordance - never a
// full-bleed card fighting the timeline for space. Tapping presents a proper
// scrollable sheet with the full question text, every option (with
// descriptions), and Submit. Answered, the chip collapses to the chosen
// answers. The keystroke submission driving the real TUI widget on the
// desktop is unchanged - only the presentation moved into the sheet.

// What the boss chose, kept locally so the chip can collapse to it (the
// agent's transcript records the exchange separately). anchorSeq pins the
// collapsed chip to the conversation point it answered at; once the agent
// moves on, the timeline's own record takes over and the chip retires.
struct AnsweredQuestion: Equatable {
    let questionId: String
    let answers: [String]
    let anchorSeq: Int
}

private let questionAccent = Style.accent

// The pending chip: question title + "Answer…", a couple of lines max.
struct QuestionChip: View {
    let question: PendingQuestion
    let onSubmit: (_ selections: [[Int]], _ customAnswers: [String: String]) async -> Void

    @State private var showSheet = false

    var body: some View {
        Button {
            showSheet = true
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "questionmark.bubble.fill")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(questionAccent)
                VStack(alignment: .leading, spacing: 1) {
                    Text(question.questions.first?.question ?? "The agent has a question")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Style.textPrimary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    if question.questions.count > 1 {
                        Text("\(question.questions.count) questions")
                            .font(.system(size: 12))
                            .foregroundStyle(Style.textSecondary)
                    }
                    if question.remoteResolutionUnavailable == true {
                        Text("Answer in Claude on the desktop")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(Style.warningText)
                    } else if question.submittedAnswers != nil {
                        Text("Sent - waiting for Claude to continue")
                            .font(.system(size: 11))
                            .foregroundStyle(Style.textSecondary)
                    }
                }
                Spacer(minLength: 8)
                HStack(spacing: 3) {
                    Text("Answer")
                        .font(.system(size: 13, weight: .semibold))
                    Image(systemName: "chevron.up")
                        .font(.system(size: 10, weight: .semibold))
                }
                .foregroundStyle(questionAccent)
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 11)
            .background(questionAccent.opacity(0.09))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(questionAccent.opacity(0.35))
            }
        }
        .buttonStyle(.plain)
        .disabled(question.remoteResolutionUnavailable == true || question.submittedAnswers != nil)
        .sheet(isPresented: $showSheet) {
            QuestionSheet(question: question, onSubmit: onSubmit)
                .preferredColorScheme(.dark)
        }
    }
}

// The collapsed chip after answering: the chosen answer(s), compactly.
struct AnsweredQuestionChip: View {
    let answered: AnsweredQuestion

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(questionAccent)
            Text(answered.answers.isEmpty ? "Answered" : answered.answers.joined(separator: " · "))
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

// The full question surface, in a standard scrollable sheet: one chip -> one
// sheet, all questions. One tap (lone single-select) or toggle-then-Submit
// (multi-select or several questions) drives the real TUI widget.
struct QuestionSheet: View {
    @Environment(\.dismiss) private var dismiss
    let question: PendingQuestion
    let onSubmit: (_ selections: [[Int]], _ customAnswers: [String: String]) async -> Void

    // selections[qi] = chosen option indices for question qi.
    @State private var selections: [Set<Int>] = []
    @State private var customAnswers: [String: String] = [:]
    @State private var submitting = false

    // A lone single-select question submits on the tap itself; anything with a
    // multi-select question or several questions gathers a Submit press.
    private var isTapToAnswer: Bool {
        question.questions.count == 1 && !(question.questions.first?.multiSelect ?? false)
    }

    private var canSubmit: Bool {
        for (index, item) in question.questions.enumerated() {
            let hasSelection = !(selections[safe: index]?.isEmpty ?? true)
            let hasOther = !(customAnswers[item.question]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
            if !hasSelection && !hasOther {
                return false
            }
        }
        return true
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    ForEach(Array(question.questions.enumerated()), id: \.offset) { qi, item in
                        questionBlock(qi, item)
                    }
                }
                .padding(20)
            }
            .background(Style.canvas)
            .navigationTitle("Question")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if !isTapToAnswer {
                    Button {
                        submit(selections.map { Array($0).sorted() })
                    } label: {
                        Group {
                            if submitting {
                                ProgressView().controlSize(.small)
                            } else {
                                Text("Submit")
                                    .font(.system(size: 15, weight: .semibold))
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                    }
                    .buttonStyle(.glassProminent)
                    .tint(questionAccent)
                    .disabled(!canSubmit || submitting)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 10)
                    .background(Style.canvas.opacity(0.94))
                }
            }
        }
        .onAppear(perform: resetIfNeeded)
    }

    @ViewBuilder
    private func questionBlock(_ qi: Int, _ item: QuestionItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let header = item.header, !header.isEmpty {
                Text(header.uppercased())
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .tracking(1.0)
                    .foregroundStyle(Style.textSecondary)
            }
            Text(item.question)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Style.textPrimary)
                .fixedSize(horizontal: false, vertical: true)

            VStack(spacing: 6) {
                ForEach(Array(item.options.enumerated()), id: \.offset) { oi, option in
                    optionRow(qi: qi, oi: oi, option: option, multiSelect: item.multiSelect ?? false)
                }
                TextField("Other…", text: customBinding(for: item.question))
                    .textFieldStyle(.roundedBorder)
            }
        }
    }

    @ViewBuilder
    private func optionRow(qi: Int, oi: Int, option: QuestionOption, multiSelect: Bool) -> some View {
        let selected = selections[safe: qi]?.contains(oi) ?? false
        Button {
            tap(qi: qi, oi: oi, multiSelect: multiSelect)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: glyph(multiSelect: multiSelect, selected: selected))
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(selected ? questionAccent : Style.textFaint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Style.textPrimary)
                        .multilineTextAlignment(.leading)
                    if let description = option.description, !description.isEmpty {
                        Text(description)
                            .font(.system(size: 12))
                            .foregroundStyle(Style.textSecondary)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? questionAccent.opacity(0.14) : Color.black.opacity(0.25))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(selected ? questionAccent.opacity(0.5) : Style.hairline)
            }
        }
        .buttonStyle(.plain)
        .disabled(submitting)
    }

    private func glyph(multiSelect: Bool, selected: Bool) -> String {
        if multiSelect {
            return selected ? "checkmark.square.fill" : "square"
        }
        return selected ? "largecircle.fill.circle" : "circle"
    }

    private func resetIfNeeded() {
        if selections.count != question.questions.count {
            selections = question.questions.map { _ in [] }
        }
    }

    private func customBinding(for question: String) -> Binding<String> {
        Binding(
            get: { customAnswers[question] ?? "" },
            set: { customAnswers[question] = $0 }
        )
    }

    private func tap(qi: Int, oi: Int, multiSelect: Bool) {
        guard !submitting else { return }
        resetIfNeeded()
        if isTapToAnswer {
            submit([[oi]])
            return
        }
        if multiSelect {
            if selections[qi].contains(oi) {
                selections[qi].remove(oi)
            } else {
                selections[qi].insert(oi)
            }
        } else {
            // Radio behavior: one choice per single-select question.
            selections[qi] = [oi]
        }
    }

    private func submit(_ chosen: [[Int]]) {
        guard !submitting else { return }
        submitting = true
        Task {
            await onSubmit(
                chosen,
                customAnswers.filter { !$0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            )
            submitting = false
            // The chip outside reflects the outcome: it collapses on success
            // and stays pending (for a retry) if the submit did not land.
            dismiss()
        }
    }
}

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
