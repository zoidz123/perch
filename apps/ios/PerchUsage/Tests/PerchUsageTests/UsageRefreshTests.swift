import XCTest
@testable import PerchUsage

@MainActor
final class UsageRefreshTests: XCTestCase {
    func testDirectAutomaticRefreshIssuesRequest() async {
        let recorder = RequestRecorder(results: [.success(snapshot(percent: 10))])
        let coordinator = UsageRefreshCoordinator(request: recorder.request)

        await coordinator.refresh(trigger: .automatic, transport: .direct)

        XCTAssertEqual(recorder.count, 1)
        XCTAssertEqual(coordinator.state.usage?.providers[0].windows[0].percentUsed, 10)
        XCTAssertEqual(coordinator.state.lastUpdatedAt, "2026-07-15T12:00:00Z")
    }

    func testRelayAutomaticRefreshWaitsForE2EEReady() async {
        let recorder = RequestRecorder(results: [.success(snapshot(percent: 20))])
        let coordinator = UsageRefreshCoordinator(request: recorder.request)

        await coordinator.refresh(trigger: .automatic, transport: .relayWaitingForEncryptedChannel)
        XCTAssertEqual(recorder.count, 0)

        await coordinator.encryptedChannelDidBecomeReady()
        XCTAssertEqual(recorder.count, 1)
        XCTAssertEqual(coordinator.state.usage?.providers[0].windows[0].percentUsed, 20)
    }

    func testSheetOpenAndManualRefreshEachIssueRequest() async {
        let recorder = RequestRecorder(results: [
            .success(snapshot(percent: 30)),
            .success(snapshot(percent: 40))
        ])
        let coordinator = UsageRefreshCoordinator(request: recorder.request)

        await coordinator.refresh(trigger: .sheetOpened, transport: .relayReady)
        await coordinator.refresh(trigger: .manualRefresh, transport: .relayReady)

        XCTAssertEqual(recorder.count, 2)
        XCTAssertEqual(coordinator.state.usage?.providers[0].windows[0].percentUsed, 40)
    }

    func testLoadingStateIsExplicitWhileRequestRuns() async {
        let gate = RequestGate(response: snapshot(percent: 50))
        let coordinator = UsageRefreshCoordinator(request: gate.request)

        let task = Task { await coordinator.refresh(trigger: .manualRefresh, transport: .direct) }
        await Task.yield()
        XCTAssertTrue(coordinator.state.isLoading)
        gate.release()
        await task.value
        XCTAssertFalse(coordinator.state.isLoading)
    }

    func testFailureRetainsLastGoodAndMarksItStale() async {
        let recorder = RequestRecorder(results: [
            .success(snapshot(percent: 60)),
            .failure(TestError.offline)
        ])
        let coordinator = UsageRefreshCoordinator(request: recorder.request)

        await coordinator.refresh(trigger: .sheetOpened, transport: .direct)
        await coordinator.refresh(trigger: .manualRefresh, transport: .direct)

        XCTAssertEqual(coordinator.state.usage?.providers[0].windows[0].percentUsed, 60)
        XCTAssertTrue(coordinator.state.isShowingStaleData)
        XCTAssertEqual(coordinator.state.errorMessage, "Couldn’t refresh usage. Check your connection and try again.")
        XCTAssertFalse(coordinator.state.errorMessage?.contains("offline") ?? true)
    }

    func testServerLastGoodUsesProviderTimestampForStaleAge() async {
        let response = UsageResponse(
            at: "2026-07-15T12:00:00Z",
            providers: [
                ProviderUsage(
                    provider: "codex",
                    available: true,
                    windows: [],
                    stale: true,
                    asOf: "2026-07-15T10:00:00Z"
                )
            ]
        )
        let recorder = RequestRecorder(results: [.success(response)])
        let coordinator = UsageRefreshCoordinator(request: recorder.request)

        await coordinator.refresh(trigger: .automatic, transport: .direct)

        XCTAssertTrue(coordinator.state.isShowingStaleData)
        XCTAssertEqual(coordinator.state.lastUpdatedAt, "2026-07-15T10:00:00Z")
    }

    func testWeeklyOnlyWindowStaysWeekly() {
        let usage = snapshot(kind: "session", minutes: 10_080, percent: 70)

        XCTAssertNil(usage.providers[0].window("session"))
        XCTAssertEqual(usage.providers[0].window("week")?.windowMinutes, 10_080)
    }
}

private enum TestError: Error {
    case offline
}

@MainActor
private final class RequestRecorder {
    var results: [Result<UsageResponse, Error>]
    private(set) var count = 0

    init(results: [Result<UsageResponse, Error>]) {
        self.results = results
    }

    func request() async throws -> UsageResponse {
        count += 1
        return try results.removeFirst().get()
    }
}

@MainActor
private final class RequestGate {
    let response: UsageResponse
    private var continuation: CheckedContinuation<Void, Never>?

    init(response: UsageResponse) {
        self.response = response
    }

    func request() async throws -> UsageResponse {
        await withCheckedContinuation { continuation = $0 }
        return response
    }

    func release() {
        continuation?.resume()
        continuation = nil
    }
}

private func snapshot(
    kind: String = "session",
    minutes: Int = 300,
    percent: Double
) -> UsageResponse {
    UsageResponse(
        at: "2026-07-15T12:00:00Z",
        providers: [
            ProviderUsage(
                provider: "codex",
                available: true,
                windows: [
                    UsageWindow(
                        kind: kind,
                        percentUsed: percent,
                        resetsAt: "2026-07-15T17:00:00Z",
                        windowMinutes: minutes
                    )
                ]
            )
        ]
    )
}
