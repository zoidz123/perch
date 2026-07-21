import Foundation

public enum TaskStatusChipKind: String, Equatable {
    case agent
    case pullRequest
    case checks
    case merge
}

public enum TaskStatusTone: String, Equatable {
    case active
    case neutral
    case attention
    case success
    case error
}

public struct TaskStatusChip: Equatable, Identifiable {
    public let kind: TaskStatusChipKind
    public let label: String
    public let tone: TaskStatusTone
    public let isLink: Bool

    public var id: String { "\(kind.rawValue):\(label)" }

    public init(kind: TaskStatusChipKind, label: String, tone: TaskStatusTone, isLink: Bool = false) {
        self.kind = kind
        self.label = label
        self.tone = tone
        self.isLink = isLink
    }
}

public struct TaskStatusCheck: Equatable {
    public let name: String
    public let state: String?

    public init(name: String, state: String?) {
        self.name = name
        self.state = state
    }
}

public struct TaskStatusPr: Equatable {
    public let url: String
    public let checks: String?
    public let checkDetails: [TaskStatusCheck]
    public let mergeReady: Bool?
    public let isDraft: Bool?
    public let mergeable: String?
    public let mergeStateStatus: String?
    public let reviewDecision: String?
    public let merged: Bool?

    public init(
        url: String,
        checks: String? = nil,
        checkDetails: [TaskStatusCheck] = [],
        mergeReady: Bool? = nil,
        isDraft: Bool? = nil,
        mergeable: String? = nil,
        mergeStateStatus: String? = nil,
        reviewDecision: String? = nil,
        merged: Bool? = nil
    ) {
        self.url = url
        self.checks = checks
        self.checkDetails = checkDetails
        self.mergeReady = mergeReady
        self.isDraft = isDraft
        self.mergeable = mergeable
        self.mergeStateStatus = mergeStateStatus
        self.reviewDecision = reviewDecision
        self.merged = merged
    }
}

public enum TaskStatusPresentation {
    public static func chips(taskState: String, pr: TaskStatusPr?, presentationState: String? = nil, mode: String? = nil) -> [TaskStatusChip] {
        [primaryChip(taskState: taskState, pr: pr, presentationState: presentationState, mode: mode)]
    }

    public static func primaryChip(taskState: String, pr: TaskStatusPr?, presentationState: String? = nil, mode: String? = nil) -> TaskStatusChip {
        stateChip(presentationState ?? taskState, mode: mode)
    }

    public static func prChip(_ pr: TaskStatusPr?) -> TaskStatusChip? {
        guard let pr else { return nil }
        return TaskStatusChip(kind: .pullRequest, label: prLabel(pr), tone: .neutral, isLink: true)
    }

    public static func metadata(taskState: String, pr: TaskStatusPr?) -> [String] {
        []
    }

    public static func stateChip(_ state: String, mode: String? = nil) -> TaskStatusChip {
        switch state {
        case "queued", "working", "done", "landed":
            return TaskStatusChip(kind: .agent, label: "Working", tone: .attention)
        case "needs_you":
            return TaskStatusChip(kind: .agent, label: "Needs you", tone: .attention)
        case "blocked":
            return TaskStatusChip(kind: .agent, label: "Blocked", tone: .error)
        case "completion_requested", "awaiting_verification":
            return TaskStatusChip(kind: .agent, label: "Awaiting verification", tone: .attention)
        case "ready_to_merge":
            return TaskStatusChip(kind: .agent, label: "Ready to merge", tone: .success)
        case "ready_to_apply":
            return TaskStatusChip(kind: .agent, label: "Ready to apply", tone: .success)
        case "failed":
            return TaskStatusChip(kind: .agent, label: "Failed", tone: .error)
        case "closed":
            return TaskStatusChip(kind: .agent, label: "Closed", tone: .neutral)
        default:
            return TaskStatusChip(kind: .agent, label: "Working", tone: .attention)
        }
    }

    private static func prLabel(_ pr: TaskStatusPr) -> String {
        guard let number = prNumber(pr.url) else { return "PR" }
        return "PR #\(number)"
    }

    private static func prNumber(_ url: String) -> Int? {
        Int((URL(string: url)?.lastPathComponent) ?? "")
    }

}
