import XCTest
@testable import PerchComposer

final class ChartCardDismissalIdentityTests: XCTestCase {
    func testSameChartRefreshKeepsDismissalKeyStable() {
        let first = ChartCardDismissalIdentity(
            id: "chart-a",
            registeredAt: "2026-07-09T10:00:00.000Z",
            updatedAt: "2026-07-09T10:00:00.000Z",
            snapshotAt: "2026-07-09T10:00:00.000Z"
        )
        let refreshed = ChartCardDismissalIdentity(
            id: "chart-a",
            registeredAt: "2026-07-09T10:00:00.000Z",
            updatedAt: "2026-07-09T10:00:00.000Z",
            snapshotAt: "2026-07-09T10:00:00.000Z"
        )

        XCTAssertEqual(first.key, refreshed.key)
    }

    func testNewRegistrationDoesNotReuseDismissalKey() {
        let dismissed = ChartCardDismissalIdentity(
            id: "chart-a",
            registeredAt: "2026-07-09T10:00:00.000Z",
            updatedAt: "2026-07-09T10:00:00.000Z",
            snapshotAt: "2026-07-09T10:00:00.000Z"
        )
        let registeredAgain = ChartCardDismissalIdentity(
            id: "chart-b",
            registeredAt: "2026-07-09T10:05:00.000Z",
            updatedAt: "2026-07-09T10:05:00.000Z",
            snapshotAt: "2026-07-09T10:05:00.000Z"
        )

        XCTAssertNotEqual(dismissed.key, registeredAgain.key)
    }

    func testUpdatedChartDoesNotReuseDismissalKey() {
        let dismissed = ChartCardDismissalIdentity(
            id: "chart-a",
            registeredAt: "2026-07-09T10:00:00.000Z",
            updatedAt: "2026-07-09T10:00:00.000Z",
            snapshotAt: "2026-07-09T10:00:00.000Z"
        )
        let updated = ChartCardDismissalIdentity(
            id: "chart-a",
            registeredAt: "2026-07-09T10:00:00.000Z",
            updatedAt: "2026-07-09T10:06:00.000Z",
            snapshotAt: "2026-07-09T10:06:00.000Z"
        )

        XCTAssertNotEqual(dismissed.key, updated.key)
    }
}
