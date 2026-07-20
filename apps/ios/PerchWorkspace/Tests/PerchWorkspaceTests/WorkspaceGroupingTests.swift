import XCTest
@testable import PerchWorkspace

private struct FixtureTask: WorkspaceTaskLike, Codable {
    let id: String
    let title: String
    let workerName: String?
    let project: String
    let state: String
    let updatedAt: String
    let sessionId: String?

    init(
        id: String = "task",
        title: String = "work",
        workerName: String? = nil,
        project: String,
        state: String,
        updatedAt: String,
        sessionId: String?
    ) {
        self.id = id
        self.title = title
        self.workerName = workerName
        self.project = project
        self.state = state
        self.updatedAt = updatedAt
        self.sessionId = sessionId
    }
}

private struct FixtureSession: WorkspaceSessionLike, Codable {
    let id: String
    let workerName: String?
    let labels: [String: String]?
    var status: String

    var taskId: String? { labels?["task"] }
    var parentSessionId: String? { labels?["parent"] }

    init(
        id: String,
        workerName: String?,
        taskId: String?,
        parentSessionId: String?,
        status: String = "idle"
    ) {
        self.id = id
        self.workerName = workerName
        labels = ["task": taskId, "parent": parentSessionId]
            .compactMapValues { $0 }
        self.status = status
    }
}

final class WorkspaceGroupingTests: XCTestCase {
    func testWorkerIdentityDecodesNewAndHistoricalTaskRecords() throws {
        let named = try JSONDecoder().decode(
            FixtureTask.self,
            from: Data(#"{"id":"named","title":"fix auth","workerName":"Wren","project":"/p","state":"working","updatedAt":"t","sessionId":"pty:a"}"#.utf8)
        )
        XCTAssertEqual(WorkspaceGrouping.workerIdentity(workerName: named.workerName, title: named.title), "Wren")
        XCTAssertEqual(named.title, "fix auth")

        let historical = try JSONDecoder().decode(
            FixtureTask.self,
            from: Data(#"{"id":"historical","title":"old work","project":"/p","state":"closed","updatedAt":"t","sessionId":null}"#.utf8)
        )
        XCTAssertNil(historical.workerName)
        XCTAssertEqual(WorkspaceGrouping.workerIdentity(workerName: historical.workerName, title: historical.title), "old work")
    }

    func testTasksGroupByProjectWithAttentionFirst() {
        let tasks = [
            FixtureTask(project: "/Users/example/Projects/perch", state: "working", updatedAt: "2026-07-06T10:00:00Z", sessionId: "pty:a"),
            FixtureTask(project: "/Users/example/Projects/perch", state: "completion_requested", updatedAt: "2026-07-06T12:30:00Z", sessionId: "pty:verify"),
            FixtureTask(project: "/Users/example/Projects/sample-app", state: "needs_you", updatedAt: "2026-07-06T08:00:00Z", sessionId: "pty:b"),
            FixtureTask(project: "/Users/example/Projects/perch", state: "done", updatedAt: "2026-07-06T11:00:00Z", sessionId: "pty:c"),
            FixtureTask(project: "/Users/example/Projects/perch", state: "working", updatedAt: "2026-07-06T12:00:00Z", sessionId: "pty:d"),
            FixtureTask(project: "/Users/example/Projects/perch", state: "closed", updatedAt: "2026-07-06T13:00:00Z", sessionId: "pty:e")
        ]

        let groups = WorkspaceGrouping.projectGroups(tasks)
        XCTAssertEqual(groups.count, 2)

        // Both projects hold attention. The newer completion request puts
        // perch first, and the closed task never renders.
        XCTAssertEqual(groups[0].project, "/Users/example/Projects/perch")
        XCTAssertEqual(groups[0].name, "perch")
        XCTAssertEqual(groups[0].tasks.map(\.sessionId), ["pty:verify", "pty:d", "pty:a", "pty:c"])

        XCTAssertEqual(groups[1].project, "/Users/example/Projects/sample-app")
        XCTAssertEqual(groups[1].tasks.map(\.sessionId), ["pty:b"])
    }

    func testQuietProjectsOrderByRecency() {
        let tasks = [
            FixtureTask(project: "/p/old", state: "working", updatedAt: "2026-07-01T00:00:00Z", sessionId: nil),
            FixtureTask(project: "/p/new", state: "done", updatedAt: "2026-07-06T00:00:00Z", sessionId: nil)
        ]
        let groups = WorkspaceGrouping.projectGroups(tasks)
        XCTAssertEqual(groups.map(\.project), ["/p/new", "/p/old"])
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
            from: Data(#"{"id":"pty:worker","workerName":"Alder","labels":{"task":"fix-ios-regression-crew-d242","parent":"pty:mate"},"status":"running"}"#.utf8)
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

    func testStatusPayloadUpdatesSessionRowIndicator() throws {
        let session = try JSONDecoder().decode(
            FixtureSession.self,
            from: Data(#"{"id":"pty:worker","workerName":"Birch","labels":{"task":"task","parent":"pty:mate"},"status":"idle"}"#.utf8)
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
