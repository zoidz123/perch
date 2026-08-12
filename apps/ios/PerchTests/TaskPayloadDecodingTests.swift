import XCTest
@testable import Perch

// Wire compatibility for `GET /tasks`. The server retired delivery modes: new
// ship/scout/operate records serialize no `mode` at all, while the 700-odd
// historical records still carry one. A required `mode` on the phone made the
// whole list decode throw, and every refresh surfaced "Couldn't refresh tasks."
// These payloads are the real current-server shapes, trimmed to one record.
@MainActor
final class TaskPayloadDecodingTests: XCTestCase {
    private static let modelessTask = """
    {
      "id": "diagnose-ios-task-refresh-25a1",
      "title": "Diagnose the iOS task refresh failure",
      "project": "/Users/example/Desktop/perch",
      "kind": "ship",
      "state": "working",
      "createdAt": "2026-08-12T20:56:10.294Z",
      "updatedAt": "2026-08-12T20:58:11.649Z",
      "workerName": "Birch",
      "sessionId": "pty:f7d60d02-1392-479a-be0e-e40e9a045edf",
      "worktreeId": "wt:perch-7a6d3e/4",
      "branch": "perch/diagnose-ios-task-refresh-25a1",
      "parentSessionId": "pty:20dbe0a7-eb93-4c1d-84f1-59c1cae75a25",
      "runtime": {
        "id": "c7f971b4-c08e-4b4c-b6d7-a9b56c3faf6c",
        "workerId": "diagnose-ios-task-refresh-25a1",
        "generation": 0,
        "state": "live",
        "provider": "claude",
        "agent": "claude",
        "model": "opus",
        "workerName": "Birch",
        "ptySessionId": "pty:f7d60d02-1392-479a-be0e-e40e9a045edf",
        "recoveryAvailable": false,
        "recoveryUnavailableReason": "runtime_not_recoverable",
        "createdAt": "2026-08-12T20:56:10.294Z",
        "updatedAt": "2026-08-12T20:56:10.995Z"
      },
      "presentation": { "state": "working" }
    }
    """

    private static let legacyModeTask = """
    {
      "id": "enable-native-codex-multi-e988",
      "title": "Enable native Codex multi-agent v2",
      "project": "/Users/example/Desktop/perch",
      "kind": "ship",
      "mode": "no-mistakes",
      "state": "closed",
      "createdAt": "2026-08-06T22:06:37.692Z",
      "updatedAt": "2026-08-07T16:47:48.597Z",
      "workerName": "Alder",
      "sessionId": "pty:9bdcdb77-e2ba-48d4-a189-078f4b0c75b0",
      "worktreeId": "wt:perch-7a6d3e/1",
      "branch": "perch/enable-native-codex-multi-e988",
      "pr": {
        "url": "https://github.com/example/perch/pull/87",
        "number": 87,
        "repo": "example/perch",
        "head": "perch/enable-native-codex-multi-e988",
        "checks": "passing",
        "checkDetails": [{ "name": "Build, tests, package, and iOS", "state": "passing" }],
        "isDraft": false,
        "mergeable": "UNKNOWN",
        "mergeStateStatus": "UNKNOWN",
        "mergeReady": false,
        "merged": true
      },
      "presentation": { "state": "closed" }
    }
    """

    private func decodeTasks(_ records: [String]) throws -> [AgentTask] {
        let json = "{\"tasks\": [\(records.joined(separator: ","))]}"
        return try JSONDecoder().decode(TasksResult.self, from: Data(json.utf8)).tasks
    }

    func testModelessTaskDecodes() throws {
        let tasks = try decodeTasks([Self.modelessTask])

        XCTAssertEqual(tasks.count, 1)
        XCTAssertNil(tasks[0].mode)
        XCTAssertEqual(tasks[0].kind, "ship")
        XCTAssertEqual(tasks[0].workerName, "Birch")
        XCTAssertEqual(tasks[0].runtimeSessionId, "pty:f7d60d02-1392-479a-be0e-e40e9a045edf")
    }

    func testLegacyModeTaskStillDecodes() throws {
        let tasks = try decodeTasks([Self.legacyModeTask])

        XCTAssertEqual(tasks[0].mode, "no-mistakes")
        XCTAssertEqual(tasks[0].pr?.checks, "passing")
        XCTAssertEqual(tasks[0].presentationState, "closed")
    }

    // A single modeless record must not take the whole snapshot down: the
    // ledger mixes historical mode-bearing tasks with new modeless ones.
    func testMixedSnapshotDecodesAndGroups() throws {
        let tasks = try decodeTasks([Self.legacyModeTask, Self.modelessTask])

        XCTAssertEqual(tasks.count, 2)
        let groups = WorkspaceGrouping.projectGroups(tasks)
        XCTAssertEqual(groups.count, 1)
        // The closed legacy record is not live; only the modeless task renders.
        XCTAssertEqual(groups[0].tasks.map(\.id), ["diagnose-ios-task-refresh-25a1"])
    }

    // The user-visible failure: a thrown snapshot decode becomes the refresh
    // banner, which is exactly what a required `mode` produced on build 10.
    func testDecodeFailureProducesTheRefreshBanner() {
        let json = "{\"tasks\": [\(Self.modelessTask)]}"
        var decodeError: Error?
        do {
            _ = try JSONDecoder().decode(BuildTenTasksResult.self, from: Data(json.utf8))
        } catch {
            decodeError = error
        }
        XCTAssertNotNil(decodeError, "build 10 must reject the modeless record")

        let refresh = WorkspaceGrouping.taskRefreshResult(
            current: [AgentTask](),
            result: Result<[AgentTask], Error>.failure(
                decodeError ?? NSError(domain: "decode", code: 1)
            )
        )

        XCTAssertEqual(refresh.errorMessage, "Couldn’t refresh tasks. Pull to refresh or reconnect.")
    }
}

// The build-10 (0.2.1/10, ffcd65c) shape of the decoded task record, kept only
// to pin the regression: `mode` was required, so a modeless server record threw
// and took the whole `GET /tasks` snapshot with it.
private struct BuildTenTask: Decodable {
    let id: String
    let title: String
    let workerName: String?
    let project: String
    let kind: String
    let mode: String
    let state: String
    let createdAt: String
    let updatedAt: String
}

private struct BuildTenTasksResult: Decodable { let tasks: [BuildTenTask] }
