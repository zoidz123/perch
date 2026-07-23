import XCTest
@testable import PerchSessionNavigation

final class SessionNavigationPresentationTests: XCTestCase {
    func testStartingRuntimeNavigatesBeforeFleetSnapshotArrives() {
        let target = SessionNavigationPresentation.navigationTarget(
            taskState: "working",
            runtimeState: "starting",
            runtimeSessionId: "pty:new-worker",
            taskSessionId: "pty:new-worker",
            visibleSessionId: nil,
            cachedSessionIds: []
        )

        XCTAssertEqual(target, "pty:new-worker")
    }

    func testLiveRuntimeFallsBackToTaskSessionIdentity() {
        let target = SessionNavigationPresentation.navigationTarget(
            taskState: "working",
            runtimeState: "live",
            runtimeSessionId: nil,
            taskSessionId: "pty:task-session",
            visibleSessionId: nil,
            cachedSessionIds: []
        )

        XCTAssertEqual(target, "pty:task-session")
    }

    func testMissingSessionIdentityDoesNotNavigate() {
        let target = SessionNavigationPresentation.navigationTarget(
            taskState: "working",
            runtimeState: "live",
            runtimeSessionId: nil,
            taskSessionId: nil,
            visibleSessionId: nil,
            cachedSessionIds: []
        )

        XCTAssertNil(target)
    }

    func testFailedAndEndedRuntimeDoNotNavigateWithoutFleetSnapshot() {
        for state in ["failed", "ended"] {
            let target = SessionNavigationPresentation.navigationTarget(
                taskState: "working",
                runtimeState: state,
                runtimeSessionId: "pty:old-worker",
                taskSessionId: "pty:old-worker",
                visibleSessionId: nil,
                cachedSessionIds: []
            )

            XCTAssertNil(target, "\(state) runtimes must not present as launching workers")
        }
    }

    func testFleetSnapshotPreservesExistingNavigationBehavior() {
        let target = SessionNavigationPresentation.navigationTarget(
            taskState: "done",
            runtimeState: "ended",
            runtimeSessionId: "pty:old-worker",
            taskSessionId: "pty:task-session",
            visibleSessionId: "pty:visible-session",
            cachedSessionIds: ["pty:task-session"]
        )

        XCTAssertEqual(target, "pty:task-session")
    }

    func testDetailTransitionsFromLaunchingToInteractiveWhenFleetSnapshotArrives() {
        XCTAssertEqual(
            SessionNavigationPresentation.detailPresentation(
                hasSessionSnapshot: false,
                taskState: "working",
                runtimeState: "live"
            ),
            .launching
        )
        XCTAssertEqual(
            SessionNavigationPresentation.detailPresentation(
                hasSessionSnapshot: true,
                taskState: "working",
                runtimeState: "live"
            ),
            .interactive
        )
    }

    func testOnlyFleetBackedDetailEnablesActions() {
        XCTAssertFalse(SessionDetailPresentation.launching.permitsActions)
        XCTAssertFalse(SessionDetailPresentation.unavailable.permitsActions)
        XCTAssertTrue(SessionDetailPresentation.interactive.permitsActions)
    }

    func testFailedTaskDoesNotLookLikeAnIndefinitelyLaunchingWorker() {
        XCTAssertNil(
            SessionNavigationPresentation.navigationTarget(
                taskState: "failed",
                runtimeState: "live",
                runtimeSessionId: "pty:stale-worker",
                taskSessionId: "pty:stale-worker",
                visibleSessionId: nil,
                cachedSessionIds: []
            )
        )
        XCTAssertEqual(
            SessionNavigationPresentation.detailPresentation(
                hasSessionSnapshot: false,
                taskState: "failed",
                runtimeState: "live"
            ),
            .unavailable
        )
    }
}
