import SwiftUI

// A dispatched worker can have a durable runtime identity before the fleet
// snapshot containing its interactive session reaches the phone. Keep the
// detail truthful and read-only during that short handoff.
struct LaunchingSessionShell: View {
    let task: AgentTask?

    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
                .controlSize(.regular)
                .tint(Style.accent)
            Text("Launching worker")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Style.textPrimary)
            Text(task?.title ?? "Waiting for this worker’s live session.")
                .font(.system(size: 13))
                .foregroundStyle(Style.textSecondary)
                .multilineTextAlignment(.center)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 32)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Launching worker")
    }
}

struct UnavailableSessionShell: View {
    let task: AgentTask?

    private var title: String {
        if task?.state == "failed" {
            return "Worker failed"
        }
        switch task?.runtime?.state {
        case "recoverable":
            return task?.runtime?.recoveryAvailable == true ? "Worker recoverable" : "Worker interrupted"
        case "ended":
            return "Worker ended"
        default:
            return "Session unavailable"
        }
    }

    private var detail: String {
        if task?.runtime?.state == "recoverable", task?.runtime?.recoveryAvailable == true {
            return "Return to the workspace to recover this worker."
        }
        return "This worker is not launching."
    }

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.circle")
                .font(.system(size: 26, weight: .medium))
                .foregroundStyle(Style.warningText)
            Text(title)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Style.textPrimary)
            Text(detail)
                .font(.system(size: 13))
                .foregroundStyle(Style.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 32)
        .accessibilityElement(children: .combine)
    }
}
