import Foundation

// Pure grouping for the Workspace home screen: live tasks nest under their
// project; attention sorts first; untasked sessions fall to "Solo agents".
// Foundation-only, no SwiftUI - the app compiles this same file, and the
// PerchWorkspace package runs its unit tests under `swift test` on macOS
// (single source of truth lives in apps/ios/PerchWorkspace).

protocol WorkspaceTaskLike {
    var id: String { get }
    var project: String { get }
    var state: String { get }
    var updatedAt: String { get }
    var sessionId: String? { get }
}

protocol WorkspaceSessionLike {
    associatedtype Status: Equatable
    var id: String { get }
    var taskId: String? { get }
    var parentSessionId: String? { get }
    var status: Status { get set }
}

enum WorkspaceStatusIndicator: Equatable {
    case active
    case attention
    case error
    case idle
    case hidden
}

struct WorkspaceProjectGroup<T: WorkspaceTaskLike> {
    let project: String
    let tasks: [T]

    var name: String {
        (project as NSString).lastPathComponent
    }
}

enum WorkspaceGrouping {
    // Worker identity and work description stay separate. Older task records
    // omit workerName and retain the old title-only presentation.
    static func workerIdentity(workerName: String?, title: String) -> String {
        workerName ?? title
    }

    // Status events are smaller and faster than the next fleet snapshot.
    // Update only the addressed session, and return nil for duplicates so
    // socket traffic does not invalidate the home screen unnecessarily.
    static func applyingStatus<S: WorkspaceSessionLike>(
        _ status: S.Status,
        to sessionId: String,
        in sessions: [S]
    ) -> [S]? {
        guard let index = sessions.firstIndex(where: { $0.id == sessionId }) else { return nil }
        guard sessions[index].status != status else { return nil }
        var updated = sessions
        updated[index].status = status
        return updated
    }

    static func statusIndicator(for status: String?) -> WorkspaceStatusIndicator {
        switch status {
        case "running", "working": .active
        case "needs_approval": .attention
        case "error": .error
        case "idle", "waiting", "unknown": .idle
        default: .hidden
        }
    }

    // Within a project: needs_you/blocked first (that IS the signal - no
    // derived counts anywhere), then working by recency, then done.
    static func stateRank(_ state: String) -> Int {
        switch state {
        case "needs_you", "blocked", "completion_requested": 0
        case "working": 1
        case "queued": 2
        case "done": 3
        case "failed": 4
        case "landed": 5
        default: 6
        }
    }

    // Live tasks define the project groups (a task-less project never
    // renders). Projects holding attention-state tasks sort first, then by
    // most-recent task activity; ISO timestamps compare lexicographically.
    static func projectGroups<T: WorkspaceTaskLike>(_ tasks: [T]) -> [WorkspaceProjectGroup<T>] {
        var byProject: [String: [T]] = [:]
        for task in tasks where task.state != "closed" {
            byProject[task.project, default: []].append(task)
        }
        let groups = byProject.map { project, grouped in
            WorkspaceProjectGroup(project: project, tasks: grouped.sorted { a, b in
                let ra = stateRank(a.state)
                let rb = stateRank(b.state)
                if ra != rb { return ra < rb }
                return a.updatedAt > b.updatedAt
            })
        }
        return groups.sorted { a, b in
            let aAttention = a.tasks.contains { stateRank($0.state) == 0 }
            let bAttention = b.tasks.contains { stateRank($0.state) == 0 }
            if aAttention != bAttention { return aAttention }
            return (a.tasks.map(\.updatedAt).max() ?? "") > (b.tasks.map(\.updatedAt).max() ?? "")
        }
    }


    // The mate panel's project scope: live-task groups first (exactly the
    // projectGroups order), then the remaining known projects (server
    // recency order, GET /projects) as bare task-less groups - an idle mate
    // still shows what it manages, with nothing invented under the headers.
    static func scopedProjectGroups<T: WorkspaceTaskLike>(
        _ tasks: [T],
        knownProjects: [String]
    ) -> [WorkspaceProjectGroup<T>] {
        var groups = projectGroups(tasks)
        let covered = Set(groups.map(\.project))
        for project in knownProjects where !covered.contains(project) {
            groups.append(WorkspaceProjectGroup(project: project, tasks: []))
        }
        return groups
    }

    // Resolve a task's worker through both ledger linkage and the session's
    // authoritative task label. The latter survives stale or delayed task
    // snapshots and is the source of truth for crew parentage.
    static func sessionId<S: WorkspaceSessionLike>(
        forTaskId taskId: String,
        linkedSessionId: String?,
        sessions: [S]
    ) -> String? {
        if let labeledSession = sessions.first(where: { $0.taskId == taskId }) {
            return labeledSession.id
        }
        if let linkedSessionId, sessions.contains(where: { $0.id == linkedSessionId }) {
            return linkedSessionId
        }
        return nil
    }

    // Orphans: sessions owned by no live task and not parented to the mate.
    // Crew labels keep a worker out of "Solo agents" even while the task
    // snapshot catches up to the fleet snapshot.
    static func otherSessionIds<T: WorkspaceTaskLike, S: WorkspaceSessionLike>(
        sessions: [S],
        tasks: [T],
        mateSessionId: String?
    ) -> [String] {
        let liveTasks = tasks.filter { $0.state != "closed" }
        let taskSessionIds = Set(liveTasks.compactMap(\.sessionId))
        let taskIds = Set(liveTasks.map(\.id))
        let closedTaskIds = Set(tasks.filter { $0.state == "closed" }.map(\.id))
        return sessions.compactMap { session in
            let isTaskWorker = taskSessionIds.contains(session.id)
                || session.taskId.map(taskIds.contains) == true
            let belongsToClosedTask = session.taskId.map(closedTaskIds.contains) == true
            let isMateChild = mateSessionId != nil
                && session.parentSessionId == mateSessionId
                && !belongsToClosedTask
            return !isTaskWorker && !isMateChild && session.id != mateSessionId ? session.id : nil
        }
    }

    // "/Users/example/Projects/perch" -> "~/Projects/perch" for the dim path in a
    // project sub-header (middle truncation is the renderer's job). These are
    // Mac paths rendered on the phone, so NSHomeDirectory() (the app sandbox)
    // can never match; shorten any macOS user home, like sessionShortPath.
    static func homeRelative(_ path: String) -> String {
        guard let match = path.range(of: "^/Users/[^/]+", options: .regularExpression) else {
            return path
        }
        let rest = path[match.upperBound...]
        return rest.isEmpty ? "~" : "~" + rest
    }
}
