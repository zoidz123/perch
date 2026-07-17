import Foundation

// Durable runtime facts stay separate from task status and transport state.
// This file is Foundation-only so the focused PerchRecovery package can test
// the exact model and presentation logic used by the iOS app.
struct RuntimeSnapshotModel: Codable, Equatable {
    let id: String
    let workerId: String
    let generation: Int
    let state: String
    let provider: String?
    let providerSessionId: String?
    let agent: String
    let model: String?
    let workerName: String?
    let parentSessionId: String?
    let worktreeId: String?
    let worktreePath: String?
    let leaseId: String?
    let ptySessionId: String?
    let recoveryAvailable: Bool
    let recoveryUnavailableReason: String?
    let createdAt: String
    let updatedAt: String
    let endedAt: String?
}

enum RecoveryActionState: Equatable {
    case inProgress
    case success
    case conflict(String)
    case unavailable(String)
    case failure(String)

    var preventsDuplicateRequest: Bool {
        switch self {
        case .failure:
            return false
        case .inProgress, .success, .conflict, .unavailable:
            return true
        }
    }
}

enum RecoveryRequestDisposition: Equatable {
    case conflict
    case unavailable
    case failure

    static func classify(httpStatus: Int) -> Self {
        switch httpStatus {
        case 409:
            return .conflict
        case 404, 410, 412, 422:
            return .unavailable
        default:
            return .failure
        }
    }
}

enum RuntimePresentationTone: Equatable {
    case neutral
    case attention
    case active
    case success
}

struct RuntimePresentation: Equatable {
    let label: String?
    let detail: String?
    let tone: RuntimePresentationTone
    let showsProgress: Bool
    let canRecover: Bool

    static func make(runtime: RuntimeSnapshotModel?, action: RecoveryActionState?) -> Self {
        if let action {
            switch action {
            case .inProgress:
                return Self(label: "Recovering", detail: "Starting a new runtime", tone: .active, showsProgress: true, canRecover: false)
            case .success:
                return Self(label: "Recovering", detail: "Recovery requested", tone: .success, showsProgress: true, canRecover: false)
            case let .conflict(message):
                return Self(label: "Recovering", detail: message, tone: .active, showsProgress: true, canRecover: false)
            case let .unavailable(message):
                return Self(label: "Interrupted", detail: message, tone: .attention, showsProgress: false, canRecover: false)
            case .failure:
                break
            }
        }

        guard let runtime else {
            return Self(label: nil, detail: nil, tone: .neutral, showsProgress: false, canRecover: false)
        }

        switch runtime.state {
        case "starting":
            return Self(label: "Starting", detail: nil, tone: .active, showsProgress: true, canRecover: false)
        case "live":
            return Self(label: "Live", detail: nil, tone: .success, showsProgress: false, canRecover: false)
        case "recovering":
            return Self(label: "Recovering", detail: "Starting a new runtime", tone: .active, showsProgress: true, canRecover: false)
        case "recoverable" where runtime.recoveryAvailable:
            return Self(label: "Recoverable", detail: nil, tone: .attention, showsProgress: false, canRecover: true)
        case "recoverable":
            return Self(
                label: "Interrupted",
                detail: unavailableDetail(runtime.recoveryUnavailableReason),
                tone: .attention,
                showsProgress: false,
                canRecover: false
            )
        case "ended":
            return Self(label: "Ended", detail: nil, tone: .neutral, showsProgress: false, canRecover: false)
        default:
            return Self(label: nil, detail: nil, tone: .neutral, showsProgress: false, canRecover: false)
        }
    }

    private static func unavailableDetail(_ reason: String?) -> String {
        switch reason {
        case "provider_session_unknown":
            return "Recovery unavailable - provider identity was not recorded"
        default:
            return "Recovery unavailable"
        }
    }
}

enum RecoveryIdentity {
    static func workerName(taskName: String?, runtimeName: String?, sessionName: String?, title: String) -> String {
        taskName ?? runtimeName ?? sessionName ?? title
    }

    static func provider(runtime: RuntimeSnapshotModel?, sessionAgent: String?) -> String? {
        let raw = normalized(runtime?.provider) ?? normalized(runtime?.agent) ?? normalized(sessionAgent)
        guard let raw else { return nil }
        switch raw.lowercased() {
        case "claude": return "Claude"
        case "codex": return "Codex"
        case "shell": return "Shell"
        default: return raw.capitalized
        }
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value, !value.isEmpty, value != "unknown" else { return nil }
        return value
    }
}
