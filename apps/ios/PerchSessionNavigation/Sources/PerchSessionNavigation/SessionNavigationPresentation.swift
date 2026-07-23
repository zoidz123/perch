import Foundation

public enum SessionDetailPresentation: Equatable, Sendable {
    case interactive
    case launching
    case unavailable

    public var permitsActions: Bool {
        self == .interactive
    }
}

public enum SessionNavigationPresentation {
    public static func navigationTarget(
        taskState: String?,
        runtimeState: String?,
        runtimeSessionId: String?,
        taskSessionId: String?,
        visibleSessionId: String?,
        cachedSessionIds: Set<String>
    ) -> String? {
        let candidates = [runtimeSessionId, taskSessionId, visibleSessionId]
            .compactMap { $0 }
        if let cachedTarget = candidates.first(where: { cachedSessionIds.contains($0) }) {
            return cachedTarget
        }

        guard taskState != "failed", runtimeState == "starting" || runtimeState == "live" else {
            return nil
        }
        return runtimeSessionId ?? taskSessionId
    }

    public static func detailPresentation(
        hasSessionSnapshot: Bool,
        taskState: String?,
        runtimeState: String?
    ) -> SessionDetailPresentation {
        if hasSessionSnapshot {
            return .interactive
        }
        if taskState == "failed" {
            return .unavailable
        }
        if runtimeState == "starting" || runtimeState == "live" {
            return .launching
        }
        return .unavailable
    }
}
