import Foundation

// Pure grouping for the Workspace home screen: live tasks nest under their
// project in stable dispatch order; untasked sessions fall to "Solo agents".
// Foundation-only, no SwiftUI - the app compiles this same file, and the
// PerchWorkspace package runs its unit tests under `swift test` on macOS
// (single source of truth lives in apps/ios/PerchWorkspace).

protocol WorkspaceTaskLike {
    var id: String { get }
    var title: String { get }
    var workerName: String? { get }
    var project: String { get }
    var state: String { get }
    var createdAt: String { get }
    var updatedAt: String { get }
    var sessionId: String? { get }
    var runtimeSessionId: String? { get }
    var presentationState: String? { get }
}

protocol WorkspaceSessionLike {
    associatedtype Status: Equatable
    var id: String { get }
    var title: String { get }
    var workerName: String? { get }
    var cwd: String? { get }
    var taskId: String? { get }
    var parentSessionId: String? { get }
    var lastActivityAt: String { get }
    var statusValue: String { get }
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

enum WorkspaceCrewRowSource: Equatable {
    case task(String)
    case session(String)
}

struct WorkspaceCrewRowModel: Identifiable, Equatable {
    let id: String
    let source: WorkspaceCrewRowSource
    let workerName: String
    let taskTitle: String
    let projectName: String
    let state: String
    let sessionStatus: String?
    // Ledger dispatch time - the stable ordering key. Nil for session-backed
    // rows, whose task record has not landed yet.
    let createdAt: String?
    let updatedAt: String
}

struct WorkspaceProjectSectionModel: Identifiable, Equatable {
    var id: String { project }
    let project: String
    let name: String
    let rows: [WorkspaceCrewRowModel]
}

struct WorkspaceTerminalTaskLink: Equatable {
    let taskId: String
    let sessionIds: Set<String>
}

enum WorkspaceGrouping {
    static func taskRefreshResult<Task>(
        current: [Task],
        result: Result<[Task], Error>
    ) -> (tasks: [Task], errorMessage: String?) {
        switch result {
        case let .success(tasks):
            return (tasks, nil)
        case .failure:
            return (current, "Couldn’t refresh tasks. Pull to refresh or reconnect.")
        }
    }

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

    // Stable ordering for live task lists: creation time then id - keys that
    // never change during a task's lifetime, so concurrent workers hold their
    // positions while state and activity updates stream in. Live status is
    // conveyed by each row's status indicator, never by reordering. ISO
    // timestamps compare lexicographically.
    static func stableOrder<T: WorkspaceTaskLike>(_ tasks: [T]) -> [T] {
        tasks.sorted { a, b in
            a.createdAt != b.createdAt ? a.createdAt < b.createdAt : a.id < b.id
        }
    }

    // A landed worker is closed presentation even while its live runtime is
    // still stopping. Use ledger/session identity only - never session text.
    private static func isClosedForPresentation<T: WorkspaceTaskLike>(_ task: T) -> Bool {
        task.state == "landed" || task.state == "closed" || task.presentationState == "closed"
    }

    private static func linkedSessionIds<T: WorkspaceTaskLike>(for tasks: [T]) -> Set<String> {
        Set(tasks.compactMap(\.sessionId) + tasks.compactMap(\.runtimeSessionId))
    }

    static func terminalTaskLinks<T: WorkspaceTaskLike>(
        existing: [WorkspaceTerminalTaskLink],
        previousTasks: [T],
        refreshedTasks: [T],
        limit: Int = 128
    ) -> [WorkspaceTerminalTaskLink] {
        guard limit > 0 else { return [] }

        let refreshedLiveTaskIds = Set(
            refreshedTasks.filter { !isClosedForPresentation($0) }.map(\.id)
        )
        var links = existing.filter { !refreshedLiveTaskIds.contains($0.taskId) }
        for task in previousTasks + refreshedTasks where isClosedForPresentation(task) {
            links.removeAll { $0.taskId == task.id }
            links.append(WorkspaceTerminalTaskLink(
                taskId: task.id,
                sessionIds: Set([task.sessionId, task.runtimeSessionId].compactMap { $0 })
            ))
        }
        return Array(links.suffix(limit))
    }

    static func activeTerminalTaskLinks<S: WorkspaceSessionLike>(
        _ links: [WorkspaceTerminalTaskLink],
        sessions: [S]
    ) -> [WorkspaceTerminalTaskLink] {
        links.filter { link in
            sessions.contains { session in
                session.taskId == link.taskId || link.sessionIds.contains(session.id)
            }
        }
    }

    // Live tasks define the project groups (a task-less project never
    // renders). Rows within a group and the groups themselves use the stable
    // order above: a group sits at the position of its oldest live task
    // (project path as tiebreaker), so nothing reshuffles the home screen
    // while workers run.
    static func projectGroups<T: WorkspaceTaskLike>(_ tasks: [T]) -> [WorkspaceProjectGroup<T>] {
        var byProject: [String: [T]] = [:]
        for task in tasks where !isClosedForPresentation(task) {
            byProject[task.project, default: []].append(task)
        }
        let groups = byProject.map { project, grouped in
            WorkspaceProjectGroup(project: project, tasks: stableOrder(grouped))
        }
        return groups.sorted { a, b in
            let ca = a.tasks.first?.createdAt ?? ""
            let cb = b.tasks.first?.createdAt ?? ""
            if ca != cb { return ca < cb }
            return a.project < b.project
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

    // The exact render model for the mate's Workspace section. Task-backed
    // rows preserve the durable ledger presentation. A labeled child session
    // without a matching live task still becomes a crew row instead of being
    // classified out of Solo agents and then disappearing from the screen.
    static func projectSections<T: WorkspaceTaskLike, S: WorkspaceSessionLike>(
        tasks: [T],
        sessions: [S],
        mateSessionId: String?,
        knownProjects: [String],
        terminalTaskLinks: [WorkspaceTerminalTaskLink] = []
    ) -> [WorkspaceProjectSectionModel] {
        guard let mateSessionId else { return [] }

        let liveTasks = tasks.filter { !isClosedForPresentation($0) }
        let liveTaskIds = Set(liveTasks.map(\.id))
        let liveTaskSessionIds = linkedSessionIds(for: liveTasks)
        let closedTaskIds = Set(tasks.filter(isClosedForPresentation).map(\.id))
            .union(terminalTaskLinks.map(\.taskId))
        let closedTaskSessionIds = linkedSessionIds(for: tasks.filter(isClosedForPresentation))
            .union(terminalTaskLinks.flatMap(\.sessionIds))
        var rowsByProject: [String: [WorkspaceCrewRowModel]] = [:]

        for task in liveTasks {
            let linkedSession = sessions.first { session in
                session.taskId == task.id
                    || session.id == task.sessionId
                    || session.id == task.runtimeSessionId
            }
            let projectName = displayName(forProject: task.project)
            rowsByProject[task.project, default: []].append(WorkspaceCrewRowModel(
                id: "task:\(task.id)",
                source: .task(task.id),
                workerName: task.workerName ?? linkedSession?.workerName ?? task.title,
                taskTitle: task.title,
                projectName: projectName,
                state: task.state,
                sessionStatus: linkedSession?.statusValue,
                createdAt: task.createdAt,
                updatedAt: task.updatedAt
            ))
        }

        for session in sessions {
            guard session.parentSessionId == mateSessionId, let taskId = session.taskId else { continue }
            guard !liveTaskIds.contains(taskId), !liveTaskSessionIds.contains(session.id) else { continue }
            guard !closedTaskIds.contains(taskId), !closedTaskSessionIds.contains(session.id) else { continue }
            let project = projectForCrewSession(session.cwd, knownProjects: knownProjects)
            let taskTitle = taskTitle(fromSessionTitle: session.title)
            rowsByProject[project, default: []].append(WorkspaceCrewRowModel(
                id: "session:\(session.id)",
                source: .session(session.id),
                workerName: session.workerName ?? taskTitle,
                taskTitle: taskTitle,
                projectName: displayName(forProject: project),
                state: stateForSessionStatus(session.statusValue),
                sessionStatus: session.statusValue,
                createdAt: nil,
                updatedAt: session.lastActivityAt
            ))
        }

        // Stable section order: a section sits at the position of its oldest
        // dispatched row (its first row after rowComesFirst); sections holding
        // only session-backed rows sort after, and the project path breaks
        // every tie. Attention never reorders - the row indicators carry it.
        let activeSections = rowsByProject.map { project, rows in
            WorkspaceProjectSectionModel(
                project: project,
                name: displayName(forProject: project),
                rows: rows.sorted(by: rowComesFirst)
            )
        }.sorted { a, b in
            let ca = a.rows.first?.createdAt
            let cb = b.rows.first?.createdAt
            if ca != cb {
                guard let ca else { return false }
                guard let cb else { return true }
                return ca < cb
            }
            return a.project < b.project
        }

        let covered = Set(activeSections.map(\.project))
        let idleSections = knownProjects.compactMap { project -> WorkspaceProjectSectionModel? in
            guard !covered.contains(project) else { return nil }
            return WorkspaceProjectSectionModel(
                project: project,
                name: displayName(forProject: project),
                rows: []
            )
        }
        return activeSections + idleSections
    }

    // Stable row order within a section: ledger dispatch order (createdAt,
    // then row id - keys that never change while a worker runs), so
    // concurrent workers hold their positions while state and activity
    // updates stream in. Live status is conveyed by each row's status
    // indicator, never by reordering. Session-backed rows carry no ledger
    // createdAt yet and sort after task rows by their stable row id.
    private static func rowComesFirst(_ a: WorkspaceCrewRowModel, _ b: WorkspaceCrewRowModel) -> Bool {
        switch (a.createdAt, b.createdAt) {
        case let (ca?, cb?): ca != cb ? ca < cb : a.id < b.id
        case (.some, nil): true
        case (nil, .some): false
        case (nil, nil): a.id < b.id
        }
    }

    private static func stateForSessionStatus(_ status: String) -> String {
        switch status {
        case "needs_approval": "needs_you"
        case "error": "blocked"
        case "done": "done"
        case "running", "working": "working"
        default: "queued"
        }
    }

    private static func projectForCrewSession(_ cwd: String?, knownProjects: [String]) -> String {
        guard let cwd, !cwd.isEmpty else { return "Unknown project" }
        let name = displayName(forProject: cwd)
        return knownProjects.first { displayName(forProject: $0) == name } ?? name
    }

    private static func taskTitle(fromSessionTitle title: String) -> String {
        let parts = title.split(separator: "-", maxSplits: 1).map {
            $0.trimmingCharacters(in: .whitespaces)
        }
        guard parts.count == 2 else { return title }
        switch parts[0].lowercased() {
        case "claude", "codex", "shell": return parts[1]
        default: return title
        }
    }

    private static func displayName(forProject project: String) -> String {
        (project as NSString).lastPathComponent
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
    // A terminal durable task also keeps its still-stopping session out of
    // every fallback list. Crew labels keep an active worker out of "Solo
    // agents" while the task snapshot catches up to the fleet snapshot.
    static func otherSessionIds<T: WorkspaceTaskLike, S: WorkspaceSessionLike>(
        sessions: [S],
        tasks: [T],
        mateSessionId: String?,
        terminalTaskLinks: [WorkspaceTerminalTaskLink] = []
    ) -> [String] {
        let liveTasks = tasks.filter { !isClosedForPresentation($0) }
        let taskSessionIds = linkedSessionIds(for: liveTasks)
        let taskIds = Set(liveTasks.map(\.id))
        let closedTaskIds = Set(tasks.filter(isClosedForPresentation).map(\.id))
            .union(terminalTaskLinks.map(\.taskId))
        let closedTaskSessionIds = linkedSessionIds(for: tasks.filter(isClosedForPresentation))
            .union(terminalTaskLinks.flatMap(\.sessionIds))
        return sessions.compactMap { session in
            let isTaskWorker = taskSessionIds.contains(session.id)
                || session.taskId.map(taskIds.contains) == true
            let belongsToClosedTask = session.taskId.map(closedTaskIds.contains) == true
                || closedTaskSessionIds.contains(session.id)
            let isMateChild = mateSessionId != nil
                && session.parentSessionId == mateSessionId
                && !belongsToClosedTask
            return !isTaskWorker && !belongsToClosedTask && !isMateChild && session.id != mateSessionId ? session.id : nil
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
