import Foundation

// Pure grouping for the Workspace home screen: live tasks nest under their
// project; attention sorts first; untasked sessions fall to "Solo agents".
// Foundation-only, no SwiftUI - the app compiles this same file, and the
// PerchWorkspace package runs its unit tests under `swift test` on macOS
// (single source of truth lives in apps/ios/PerchWorkspace).

protocol WorkspaceTaskLike {
    var project: String { get }
    var state: String { get }
    var updatedAt: String { get }
    var sessionId: String? { get }
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

    // Orphans: sessions owned by no live task and not the mate itself. These
    // render under "Solo agents".
    static func otherSessionIds<T: WorkspaceTaskLike>(
        sessionIds: [String],
        tasks: [T],
        mateSessionId: String?
    ) -> [String] {
        let taskSessionIds = Set(tasks.filter { $0.state != "closed" }.compactMap(\.sessionId))
        return sessionIds.filter { !taskSessionIds.contains($0) && $0 != mateSessionId }
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
