import SwiftUI

struct ClaudeInteractionCard: View {
    let interaction: PendingClaudeInteraction
    let onRespond: (_ action: String, _ content: [String: Any]?) async -> Void
    @State private var fields: [String: String] = [:]
    @State private var submitting = false

    private var properties: [String: JSONValue] {
        guard case .object(let properties)? = interaction.requestedSchema?["properties"] else { return [:] }
        return properties
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(interaction.summary, systemImage: interaction.kind == "permission_denied" ? "xmark.octagon.fill" : "list.clipboard.fill")
                .font(.system(size: 14, weight: .semibold))
            if let message = interaction.message { Text(message).font(.system(size: 13)).foregroundStyle(Style.textSecondary) }
            if let raw = interaction.url, let url = URL(string: raw) {
                Link("Open secure MCP page", destination: url).font(.system(size: 13, weight: .semibold))
            }
            ForEach(properties.keys.sorted(), id: \.self) { key in
                TextField(key, text: Binding(get: { fields[key, default: ""] }, set: { fields[key] = $0 }))
                    .textFieldStyle(.roundedBorder)
            }
            if interaction.remoteResolutionUnavailable == true || interaction.kind == "permission_denied" {
                Text(interaction.failureReason ?? "This interaction is visible evidence only and must be handled in Claude locally.")
                    .font(.system(size: 12)).foregroundStyle(Style.warningText)
            } else if interaction.responseAction != nil {
                Text("Sent - waiting for Claude to continue").font(.system(size: 12)).foregroundStyle(Style.textSecondary)
            } else {
                HStack {
                    Button("Decline") { submit("decline") }.buttonStyle(.bordered)
                    Button("Cancel") { submit("cancel") }.buttonStyle(.bordered)
                    Spacer()
                    Button("Accept") { submit("accept") }.buttonStyle(.borderedProminent)
                }.disabled(submitting)
            }
        }
        .padding(13)
        .background(Style.secondaryFill)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func submit(_ action: String) {
        submitting = true
        Task {
            await onRespond(action, action == "accept" && interaction.mode == "form" ? fields : nil)
            submitting = false
        }
    }
}
