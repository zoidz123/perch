import XCTest
@testable import Perch

@MainActor
final class ConnectionReadinessTests: XCTestCase {
    func testDirectFleetSnapshotSettlesConnectionBeforeOptionalRefreshWork() {
        let store = PerchStore()

        store.acceptDirectFleetSnapshot([])

        XCTAssertTrue(store.hasUsableFleetSnapshot)
        XCTAssertTrue(store.isServerLive)
        XCTAssertEqual(store.workspaceContentPresentation.mode, .interactive)
    }
}
