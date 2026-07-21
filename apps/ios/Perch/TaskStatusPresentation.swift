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
    public static func chips(taskState: String, pr: TaskStatusPr?) -> [TaskStatusChip] {
        [primaryChip(taskState: taskState, pr: pr)]
    }

    public static func primaryChip(taskState: String, pr: TaskStatusPr?, presentationState: String? = nil, mode: String? = nil) -> TaskStatusChip {
        let state = presentationState ?? taskState
        if state == "completion_requested" || state == "awaiting_verification" {
            return stateChip(state)
        }
        if state == "ready_to_merge" {
            return TaskStatusChip(kind: .agent, label: "Ready to merge", tone: .success)
        }
        if state == "ready_to_apply" {
            return TaskStatusChip(kind: .agent, label: "Ready to apply", tone: .success)
        }
        guard let pr, presentationState == nil else { return stateChip(state) }
        if taskState == "closed" {
            return prStatusChip(pr, suffix: "closed", tone: .neutral)
        }
        if let merge = mergeChip(pr) {
            return merge
        }
        if let checks = checksChip(pr), pr.checks != "passing" {
            return checks
        }
        if pr.checks == "passing" {
            return prStatusChip(pr, suffix: "checks passed", tone: .success, kind: .checks)
        }
        return prStatusChip(pr, suffix: nil, tone: .neutral)
    }

    public static func prChip(_ pr: TaskStatusPr?) -> TaskStatusChip? {
        guard let pr else { return nil }
        return TaskStatusChip(kind: .pullRequest, label: prLabel(pr), tone: .neutral, isLink: true)
    }

    public static func metadata(taskState: String, pr: TaskStatusPr?) -> [String] {
        []
    }

    public static func stateChip(_ state: String) -> TaskStatusChip {
        switch state {
        case "queued":
            return TaskStatusChip(kind: .agent, label: "Queued", tone: .attention)
        case "working":
            return TaskStatusChip(kind: .agent, label: "Working", tone: .attention)
        case "needs_you":
            return TaskStatusChip(kind: .agent, label: "Needs you", tone: .attention)
        case "blocked":
            return TaskStatusChip(kind: .agent, label: "Blocked", tone: .error)
        case "completion_requested":
            return TaskStatusChip(kind: .agent, label: "Awaiting verification", tone: .attention)
        case "awaiting_verification":
            return TaskStatusChip(kind: .agent, label: "Awaiting verification", tone: .attention)
        case "done":
            return TaskStatusChip(kind: .agent, label: "Done", tone: .neutral)
        case "landed":
            return TaskStatusChip(kind: .agent, label: "Landed", tone: .success)
        case "failed":
            return TaskStatusChip(kind: .agent, label: "Failed", tone: .error)
        default:
            return TaskStatusChip(kind: .agent, label: state, tone: .neutral)
        }
    }

    private static func prLabel(_ pr: TaskStatusPr) -> String {
        guard let number = prNumber(pr.url) else { return "PR" }
        return "PR #\(number)"
    }

    private static func prNumber(_ url: String) -> Int? {
        Int((URL(string: url)?.lastPathComponent) ?? "")
    }

    private static func prStatusChip(
        _ pr: TaskStatusPr,
        suffix: String?,
        tone: TaskStatusTone,
        kind: TaskStatusChipKind = .pullRequest
    ) -> TaskStatusChip {
        let label = [prLabel(pr), suffix].compactMap { $0 }.joined(separator: " ")
        return TaskStatusChip(kind: kind, label: label, tone: tone, isLink: true)
    }

    private static func checksChip(_ pr: TaskStatusPr) -> TaskStatusChip? {
        switch pr.checks {
        case "passing":
            return prStatusChip(pr, suffix: "checks passed", tone: .success, kind: .checks)
        case "failing":
            return prStatusChip(pr, suffix: namedCheckLabel(pr, state: "failing") ?? "checks failed", tone: .error, kind: .checks)
        case "pending":
            return prStatusChip(pr, suffix: namedCheckLabel(pr, state: "pending") ?? "checks pending", tone: .attention, kind: .checks)
        default:
            return nil
        }
    }

    private static func namedCheckLabel(_ pr: TaskStatusPr, state: String) -> String? {
        let matches = pr.checkDetails.filter { $0.state == state }
        guard !matches.isEmpty else { return nil }
        let verb = state == "failing" ? "failed" : "pending"
        if let docs = matches.first(where: { isDocsGate($0.name) }) {
            return "\(friendlyCheckName(docs.name)) \(verb)"
        }
        if matches.count == 1 {
            return "check \(verb)"
        }
        return "\(matches.count) checks \(verb)"
    }

    private static func friendlyCheckName(_ name: String) -> String {
        isDocsGate(name) ? "docs gate" : "check"
    }

    private static func isDocsGate(_ name: String) -> Bool {
        let normalized = name.lowercased().replacingOccurrences(of: "_", with: "-")
        return normalized.contains("docs-gate") || (normalized.contains("docs") && normalized.contains("gate"))
    }

    private static func mergeChip(_ pr: TaskStatusPr) -> TaskStatusChip? {
        if pr.merged == true {
            return prStatusChip(pr, suffix: "merged", tone: .success, kind: .merge)
        }
        if pr.mergeReady == true {
            return prStatusChip(pr, suffix: "ready to merge", tone: .success, kind: .merge)
        }
        guard pr.checks == "passing" else {
            return nil
        }
        if let blocker = mergeBlocker(pr) {
            return prStatusChip(pr, suffix: blocker.label, tone: blocker.tone, kind: .merge)
        }
        if pr.mergeReady == false && hasReadinessEvidence(pr) {
            return prStatusChip(pr, suffix: "not merge ready", tone: .attention, kind: .merge)
        }
        return nil
    }

    private static func mergeBlocker(_ pr: TaskStatusPr) -> (label: String, tone: TaskStatusTone)? {
        if pr.isDraft == true {
            return ("draft PR", .attention)
        }

        switch pr.reviewDecision?.uppercased() {
        case "CHANGES_REQUESTED":
            return ("changes requested", .attention)
        case "REVIEW_REQUIRED":
            return ("review required", .attention)
        default:
            break
        }

        switch pr.mergeStateStatus?.uppercased() {
        case "DIRTY":
            return ("merge conflict", .error)
        case "BLOCKED":
            return ("merge blocked", .attention)
        case "BEHIND":
            return ("branch behind", .attention)
        case "UNKNOWN":
            return ("merge unknown", .attention)
        case "UNSTABLE":
            return ("checks unstable", .attention)
        default:
            break
        }

        if let mergeable = pr.mergeable?.uppercased(), mergeable == "UNKNOWN" {
            return ("merge unknown", .attention)
        }

        if let mergeable = pr.mergeable?.uppercased(), mergeable != "MERGEABLE" {
            return ("not mergeable", .attention)
        }

        return nil
    }

    private static func hasReadinessEvidence(_ pr: TaskStatusPr) -> Bool {
        pr.isDraft != nil ||
        pr.mergeable != nil ||
        pr.mergeStateStatus != nil ||
        pr.reviewDecision != nil
    }

}
