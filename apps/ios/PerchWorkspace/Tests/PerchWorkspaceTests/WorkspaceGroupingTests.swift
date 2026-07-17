import XCTest
@testable import PerchWorkspace

private struct FixtureTask: WorkspaceTaskLike, Codable {
    let title: String
    let workerName: String?
    let project: String
    let state: String
    let updatedAt: String
    let sessionId: String?

    init(
        title: String = "work",
        workerName: String? = nil,
        project: String,
        state: String,
        updatedAt: String,
        sessionId: String?
    ) {
        self.title = title
        self.workerName = workerName
        self.project = project
        self.state = state
        self.updatedAt = updatedAt
        self.sessionId = sessionId
    }
}

final class WorkspaceGroupingTests: XCTestCase {
    func testWorkerIdentityDecodesNewAndHistoricalTaskRecords() throws {
        let named = try JSONDecoder().decode(
            FixtureTask.self,
            from: Data(#"{"title":"fix auth","workerName":"Wren","project":"/p","state":"working","updatedAt":"t","sessionId":"pty:a"}"#.utf8)
        )
        XCTAssertEqual(WorkspaceGrouping.workerIdentity(workerName: named.workerName, title: named.title), "Wren")
        XCTAssertEqual(named.title, "fix auth")

        let historical = try JSONDecoder().decode(
            FixtureTask.self,
            from: Data(#"{"title":"old work","project":"/p","state":"closed","updatedAt":"t","sessionId":null}"#.utf8)
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
            FixtureTask(project: "/p", state: "working", updatedAt: "t", sessionId: "pty:tasked"),
            FixtureTask(project: "/p", state: "closed", updatedAt: "t", sessionId: "pty:closed-worker")
        ]
        let others = WorkspaceGrouping.otherSessionIds(
            sessionIds: ["pty:tasked", "pty:closed-worker", "pty:manual", "pty:mate"],
            tasks: tasks,
            mateSessionId: "pty:mate"
        )
        // The tasked worker nests under its project and the mate is pinned
        // above everything; a closed task no longer owns its session.
        XCTAssertEqual(others, ["pty:closed-worker", "pty:manual"])
    }

    func testHomeRelativePath() {
        // Mac paths shown on the phone: any macOS user home shortens to ~
        // (the app sandbox home can never match a Mac path).
        XCTAssertEqual(WorkspaceGrouping.homeRelative("/Users/example/Projects/perch"), "~/Projects/perch")
        XCTAssertEqual(WorkspaceGrouping.homeRelative("/Users/example"), "~")
        XCTAssertEqual(WorkspaceGrouping.homeRelative("/opt/work"), "/opt/work")
    }
}
