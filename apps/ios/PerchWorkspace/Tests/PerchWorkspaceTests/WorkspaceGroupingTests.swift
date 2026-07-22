import XCTest
@testable import PerchWorkspace

private struct FixtureTask: WorkspaceTaskLike, Codable {
    let id: String
    let title: String
    let workerName: String?
    let project: String
    let state: String
    let createdAt: String
    let updatedAt: String
    let sessionId: String?

    init(
        id: String = "task",
        title: String = "work",
        workerName: String? = nil,
        project: String,
        state: String,
        createdAt: String = "2026-07-06T00:00:00Z",
        updatedAt: String,
        sessionId: String?
    ) {
        self.id = id
        self.title = title
        self.workerName = workerName
        self.project = project
        self.state = state
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.sessionId = sessionId
    }
}

private struct FixtureSession: WorkspaceSessionLike, Codable {
    let id: String
    let title: String
    let workerName: String?
    let cwd: String?
    let labels: [String: String]?
    let lastActivityAt: String
    var status: String

    var taskId: String? { labels?["task"] }
    var parentSessionId: String? { labels?["parent"] }
    var statusValue: String { status }

    init(
        id: String,
        title: String = "agent",
        workerName: String?,
        cwd: String? = nil,
        taskId: String?,
        parentSessionId: String?,
        lastActivityAt: String = "t",
        status: String = "idle"
    ) {
        self.id = id
        self.title = title
        self.workerName = workerName
        self.cwd = cwd
        labels = ["task": taskId, "parent": parentSessionId]
            .compactMapValues { $0 }
        self.lastActivityAt = lastActivityAt
        self.status = status
    }
}

private enum TestError: Error {
    case offline
}

final class WorkspaceGroupingTests: XCTestCase {
    func testTaskRefreshFailureRetainsSnapshotAndSurfacesActionableError() {
        let stale = [FixtureTask(id: "closed", project: "/tmp/repo", state: "closed", updatedAt: "t", sessionId: nil)]
        let result: Result<[FixtureTask], Error> = .failure(TestError.offline)

        let refresh = WorkspaceGrouping.taskRefreshResult(current: stale, result: result)

        XCTAssertEqual(refresh.tasks.map(\.id), ["closed"])
        XCTAssertEqual(refresh.errorMessage, "Couldn’t refresh tasks. Pull to refresh or reconnect.")
    }

    func testSuccessfulTaskRefreshReplacesSnapshotAndRemovesStaleClosedTasks() {
        let stale = [FixtureTask(id: "closed", project: "/tmp/repo", state: "closed", updatedAt: "t", sessionId: nil)]
        let live = FixtureTask(id: "live", project: "/tmp/repo", state: "working", updatedAt: "t", sessionId: nil)

        let refresh = WorkspaceGrouping.taskRefreshResult(current: stale, result: .success([live]))

        XCTAssertEqual(refresh.tasks.map(\.id), ["live"])
        XCTAssertNil(refresh.errorMessage)
    }

    func testWorkerIdentityDecodesNewAndHistoricalTaskRecords() throws {
        let named = try JSONDecoder().decode(
            FixtureTask.self,
            from: Data(#"{"id":"named","title":"fix auth","workerName":"Wren","project":"/p","state":"working","createdAt":"t","updatedAt":"t","sessionId":"pty:a"}"#.utf8)
        )
        XCTAssertEqual(WorkspaceGrouping.workerIdentity(workerName: named.workerName, title: named.title), "Wren")
        XCTAssertEqual(named.title, "fix auth")

        let historical = try JSONDecoder().decode(
            FixtureTask.self,
            from: Data(#"{"id":"historical","title":"old work","project":"/p","state":"closed","createdAt":"t","updatedAt":"t","sessionId":null}"#.utf8)
        )
        XCTAssertNil(historical.workerName)
        XCTAssertEqual(WorkspaceGrouping.workerIdentity(workerName: historical.workerName, title: historical.title), "old work")
    }

    func testTasksGroupByProjectInStableDispatchOrder() {
        let tasks = [
            FixtureTask(id: "t-a", project: "/Users/example/Projects/perch", state: "working", createdAt: "2026-07-06T07:00:00Z", updatedAt: "2026-07-06T10:00:00Z", sessionId: "pty:a"),
            FixtureTask(id: "t-verify", project: "/Users/example/Projects/perch", state: "completion_requested", createdAt: "2026-07-06T11:00:00Z", updatedAt: "2026-07-06T12:30:00Z", sessionId: "pty:verify"),
            FixtureTask(id: "t-b", project: "/Users/example/Projects/sample-app", state: "needs_you", createdAt: "2026-07-06T09:30:00Z", updatedAt: "2026-07-06T12:45:00Z", sessionId: "pty:b"),
            FixtureTask(id: "t-c", project: "/Users/example/Projects/perch", state: "done", createdAt: "2026-07-06T10:00:00Z", updatedAt: "2026-07-06T11:00:00Z", sessionId: "pty:c"),
            FixtureTask(id: "t-d", project: "/Users/example/Projects/perch", state: "working", createdAt: "2026-07-06T07:00:00Z", updatedAt: "2026-07-06T12:00:00Z", sessionId: "pty:d"),
            FixtureTask(id: "t-e", project: "/Users/example/Projects/perch", state: "closed", createdAt: "2026-07-06T06:00:00Z", updatedAt: "2026-07-06T13:00:00Z", sessionId: "pty:e")
        ]

        let groups = WorkspaceGrouping.projectGroups(tasks)
        XCTAssertEqual(groups.count, 2)

        // Rows sit in dispatch order (createdAt, id tiebreak); neither
        // attention state nor fresher activity moves a row, and the closed
        // task never renders. perch leads because its oldest live task
        // predates sample-app's, even though sample-app holds attention.
        XCTAssertEqual(groups[0].project, "/Users/example/Projects/perch")
        XCTAssertEqual(groups[0].name, "perch")
        XCTAssertEqual(groups[0].tasks.map(\.sessionId), ["pty:a", "pty:d", "pty:c", "pty:verify"])

        XCTAssertEqual(groups[1].project, "/Users/example/Projects/sample-app")
        XCTAssertEqual(groups[1].tasks.map(\.sessionId), ["pty:b"])
    }

    func testOrderHoldsWhileConcurrentWorkersChurn() {
        let before = [
            FixtureTask(id: "w-1", project: "/p/app", state: "working", createdAt: "2026-07-06T09:00:00Z", updatedAt: "2026-07-06T09:00:00Z", sessionId: "pty:1"),
            FixtureTask(id: "w-2", project: "/p/app", state: "working", createdAt: "2026-07-06T09:05:00Z", updatedAt: "2026-07-06T09:05:00Z", sessionId: "pty:2"),
            FixtureTask(id: "w-3", project: "/p/lib", state: "working", createdAt: "2026-07-06T09:10:00Z", updatedAt: "2026-07-06T09:10:00Z", sessionId: "pty:3")
        ]
        // Activity bumps updatedAt and flips states (the bug: recency/state
        // sorting swapped concurrent workers on every update).
        let after = [
            FixtureTask(id: "w-1", project: "/p/app", state: "needs_you", createdAt: "2026-07-06T09:00:00Z", updatedAt: "2026-07-06T09:31:00Z", sessionId: "pty:1"),
            FixtureTask(id: "w-2", project: "/p/app", state: "working", createdAt: "2026-07-06T09:05:00Z", updatedAt: "2026-07-06T09:30:00Z", sessionId: "pty:2"),
            FixtureTask(id: "w-3", project: "/p/lib", state: "done", createdAt: "2026-07-06T09:10:00Z", updatedAt: "2026-07-06T09:32:00Z", sessionId: "pty:3")
        ]

        let rows = { (tasks: [FixtureTask]) -> [[String]] in
            WorkspaceGrouping.projectGroups(tasks).map { $0.tasks.map(\.id) }
        }
        XCTAssertEqual(rows(before), [["w-1", "w-2"], ["w-3"]])
        XCTAssertEqual(rows(after), rows(before))
    }

    func testGroupsOrderByOldestTaskThenProjectPath() {
        let tasks = [
            FixtureTask(id: "young", project: "/p/newer", state: "working", createdAt: "2026-07-06T00:00:00Z", updatedAt: "2026-07-07T00:00:00Z", sessionId: nil),
            FixtureTask(id: "old", project: "/p/older", state: "done", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z", sessionId: nil),
            FixtureTask(id: "tie", project: "/p/a-tied", state: "working", createdAt: "2026-07-06T00:00:00Z", updatedAt: "2026-07-06T00:00:00Z", sessionId: nil)
        ]
        let groups = WorkspaceGrouping.projectGroups(tasks)
        XCTAssertEqual(groups.map(\.project), ["/p/older", "/p/a-tied", "/p/newer"])
    }

    func testScopedGroupsAppendIdleKnownProjectsAsBareHeaders() {
        let tasks = [
            FixtureTask(project: "/p/busy", state: "working", updatedAt: "2026-07-06T00:00:00Z", sessionId: "pty:a")
        ]
        // Known projects arrive in server recency order; /p/busy is already
        // covered by its live group and must not duplicate.
        let groups = WorkspaceGrouping.scopedProjectGroups(
            tasks,
            knownProjects: ["/p/idle-recent", "/p/busy", "/p/idle-old"]
        )
        XCTAssertEqual(groups.map(\.project), ["/p/busy", "/p/idle-recent", "/p/idle-old"])
        XCTAssertEqual(groups[0].tasks.map(\.sessionId), ["pty:a"])
        XCTAssertTrue(groups[1].tasks.isEmpty)
        XCTAssertTrue(groups[2].tasks.isEmpty)
    }

    func testScopedGroupsWithNoLiveTasksAreAllBare() {
        let groups = WorkspaceGrouping.scopedProjectGroups(
            [FixtureTask](),
            knownProjects: ["/p/one", "/p/two"]
        )
        XCTAssertEqual(groups.map(\.project), ["/p/one", "/p/two"])
        XCTAssertTrue(groups.allSatisfy(\.tasks.isEmpty))
    }

    func testOrphanSessionsFallToSoloAgents() {
        let tasks = [
            FixtureTask(id: "live", project: "/p", state: "working", updatedAt: "t", sessionId: "pty:tasked"),
            FixtureTask(id: "closed", project: "/p", state: "closed", updatedAt: "t", sessionId: "pty:closed-worker")
        ]
        let sessions = [
            FixtureSession(id: "pty:tasked", workerName: nil, taskId: "live", parentSessionId: "pty:mate"),
            FixtureSession(id: "pty:closed-worker", workerName: nil, taskId: "closed", parentSessionId: "pty:mate"),
            FixtureSession(id: "pty:manual", workerName: nil, taskId: nil, parentSessionId: nil),
            FixtureSession(id: "pty:mate", workerName: nil, taskId: nil, parentSessionId: nil)
        ]
        let others = WorkspaceGrouping.otherSessionIds(
            sessions: sessions,
            tasks: tasks,
            mateSessionId: "pty:mate"
        )
        // The tasked worker nests under its project and the mate is pinned
        // above everything; a closed task no longer owns its session.
        XCTAssertEqual(others, ["pty:closed-worker", "pty:manual"])
    }

    func testCrewSessionMetadataKeepsWorkerOutOfSoloAndLinksItToTask() throws {
        let tasks = [
            FixtureTask(
                id: "fix-ios-regression-crew-d242",
                project: "/Users/example/Desktop/perch",
                state: "working",
                updatedAt: "t",
                sessionId: nil
            )
        ]
        let worker = try JSONDecoder().decode(
            FixtureSession.self,
            from: Data(#"{"id":"pty:worker","title":"codex - Fix iOS regression","workerName":"Alder","cwd":"/work/perch","labels":{"task":"fix-ios-regression-crew-d242","parent":"pty:mate"},"lastActivityAt":"t","status":"running"}"#.utf8)
        )
        let sessions = [
            FixtureSession(id: "pty:mate", workerName: nil, taskId: nil, parentSessionId: nil),
            worker,
            FixtureSession(id: "pty:manual", workerName: nil, taskId: nil, parentSessionId: nil)
        ]

        XCTAssertEqual(
            WorkspaceGrouping.sessionId(forTaskId: tasks[0].id, linkedSessionId: tasks[0].sessionId, sessions: sessions),
            "pty:worker"
        )
        XCTAssertEqual(
            WorkspaceGrouping.otherSessionIds(sessions: sessions, tasks: tasks, mateSessionId: "pty:mate"),
            ["pty:manual"]
        )
        XCTAssertEqual(WorkspaceGrouping.projectGroups(tasks).first?.name, "perch")
        XCTAssertEqual(WorkspaceGrouping.workerIdentity(workerName: sessions[1].workerName, title: "Fix iOS regression"), "Alder")
    }

    func testCrewSessionPayloadProducesVisibleWorkspaceRowWithoutTaskSnapshot() throws {
        let worker = try JSONDecoder().decode(
            FixtureSession.self,
            from: Data(#"{"id":"pty:worker","title":"codex - Render check: count files","workerName":"Alder","cwd":"/Users/example/.perch/worktrees/company-research-fd0e/1/company-research","labels":{"task":"render-check-count-files-fd0e","parent":"pty:mate"},"lastActivityAt":"2026-07-20T19:04:23Z","status":"needs_approval"}"#.utf8)
        )
        let mate = FixtureSession(id: "pty:mate", title: "mate", workerName: nil, taskId: nil, parentSessionId: nil)

        let sections = WorkspaceGrouping.projectSections(
            tasks: [FixtureTask](),
            sessions: [mate, worker],
            mateSessionId: mate.id,
            knownProjects: ["/Users/example/Desktop/company-research"]
        )

        XCTAssertEqual(sections.count, 1)
        XCTAssertEqual(sections[0].name, "company-research")
        XCTAssertEqual(sections[0].project, "/Users/example/Desktop/company-research")
        XCTAssertEqual(sections[0].rows, [WorkspaceCrewRowModel(
            id: "session:pty:worker",
            source: .session("pty:worker"),
            workerName: "Alder",
            taskTitle: "Render check: count files",
            projectName: "company-research",
            state: "needs_you",
            sessionStatus: "needs_approval",
            createdAt: nil,
            updatedAt: "2026-07-20T19:04:23Z"
        )])
    }

    func testProjectSectionRowsHoldDispatchOrderWhileWorkersChurn() {
        let sessions = [
            FixtureSession(id: "pty:mate", title: "mate", workerName: nil, taskId: nil, parentSessionId: nil)
        ]
        let before = [
            FixtureTask(id: "w-1", project: "/p/app", state: "working", createdAt: "2026-07-06T09:00:00Z", updatedAt: "2026-07-06T09:00:00Z", sessionId: "pty:1"),
            FixtureTask(id: "w-2", project: "/p/app", state: "working", createdAt: "2026-07-06T09:05:00Z", updatedAt: "2026-07-06T09:05:00Z", sessionId: "pty:2")
        ]
        // Activity flips states and bumps updatedAt (the bug: recency/state
        // sorting swapped the two concurrent workers on every update).
        let after = [
            FixtureTask(id: "w-1", project: "/p/app", state: "needs_you", createdAt: "2026-07-06T09:00:00Z", updatedAt: "2026-07-06T09:31:00Z", sessionId: "pty:1"),
            FixtureTask(id: "w-2", project: "/p/app", state: "working", createdAt: "2026-07-06T09:05:00Z", updatedAt: "2026-07-06T09:30:00Z", sessionId: "pty:2")
        ]

        let rowIds = { (tasks: [FixtureTask]) -> [[String]] in
            WorkspaceGrouping.projectSections(
                tasks: tasks,
                sessions: sessions,
                mateSessionId: "pty:mate",
                knownProjects: []
            ).map { $0.rows.map(\.id) }
        }
        XCTAssertEqual(rowIds(before), [["task:w-1", "task:w-2"]])
        XCTAssertEqual(rowIds(after), rowIds(before))
    }

    func testStatusPayloadUpdatesSessionRowIndicator() throws {
        let session = try JSONDecoder().decode(
            FixtureSession.self,
            from: Data(#"{"id":"pty:worker","title":"codex - task","workerName":"Birch","cwd":"/work/project","labels":{"task":"task","parent":"pty:mate"},"lastActivityAt":"t","status":"idle"}"#.utf8)
        )

        let updated = WorkspaceGrouping.applyingStatus("needs_approval", to: session.id, in: [session])

        XCTAssertEqual(updated?.first?.status, "needs_approval")
        XCTAssertEqual(WorkspaceGrouping.statusIndicator(for: updated?.first?.status), .attention)
        XCTAssertNil(WorkspaceGrouping.applyingStatus("needs_approval", to: session.id, in: updated ?? []))
    }

    func testHomeRelativePath() {
        // Mac paths shown on the phone: any macOS user home shortens to ~
        // (the app sandbox home can never match a Mac path).
        XCTAssertEqual(WorkspaceGrouping.homeRelative("/Users/example/Projects/perch"), "~/Projects/perch")
        XCTAssertEqual(WorkspaceGrouping.homeRelative("/Users/example"), "~")
        XCTAssertEqual(WorkspaceGrouping.homeRelative("/opt/work"), "/opt/work")
    }
}
