import XCTest
@testable import PerchConnectivity

final class ConnectionStatusPresentationTests: XCTestCase {
    func testColdLaunchBeginsConnectingAndHidesStaleServerData() {
        var status = ConnectionStatusHysteresis(readinessTimeout: 8)

        XCTAssertEqual(status.presentedAvailability, .connecting)
        XCTAssertFalse(status.presentedAvailability.showsFreshServerData)
        XCTAssertFalse(status.presentedAvailability.permitsServerActions)
        XCTAssertFalse(status.beginConnecting(at: 0))
        XCTAssertEqual(status.readinessDeadline, 8)
    }

    func testRelayRemainsConnectingThroughE2EEReadyUntilFleetSnapshot() {
        var status = ConnectionStatusHysteresis(readinessTimeout: 8)

        status.beginConnecting(at: 0)
        XCTAssertFalse(status.observe(.encryptedChannel))
        XCTAssertEqual(status.presentedAvailability, .connecting)

        XCTAssertTrue(status.observe(.authenticatedFleetSnapshot))
        XCTAssertEqual(status.presentedAvailability, .online)
        XCTAssertTrue(status.presentedAvailability.showsFreshServerData)
        XCTAssertTrue(status.presentedAvailability.permitsServerActions)
    }

    func testDelayedDirectBootstrapDoesNotFlashOfflineBeforeReadinessDeadline() {
        var status = ConnectionStatusHysteresis(readinessTimeout: 8)

        status.beginConnecting(at: 0)
        XCTAssertFalse(status.advance(to: 7.99))
        XCTAssertEqual(status.presentedAvailability, .connecting)
        XCTAssertTrue(status.observe(.directBootstrap))
        XCTAssertFalse(status.advance(to: 20))
        XCTAssertEqual(status.presentedAvailability, .online)
    }

    func testReadinessTimeoutBecomesOffline() {
        var status = ConnectionStatusHysteresis(readinessTimeout: 8)

        status.beginConnecting(at: 10)
        XCTAssertFalse(status.advance(to: 17.99))
        XCTAssertTrue(status.advance(to: 18))
        XCTAssertEqual(status.presentedAvailability, .offline)
    }

    func testOverlappingRefreshDoesNotExtendPendingReadinessWindow() {
        var status = ConnectionStatusHysteresis(readinessTimeout: 8)

        status.beginConnecting(at: 10)
        XCTAssertFalse(status.beginConnecting(at: 15))
        XCTAssertEqual(status.readinessDeadline, 18)
        XCTAssertTrue(status.advance(to: 18))
    }

    func testForegroundReconnectRequiresFreshEvidenceBeforeOnline() {
        var status = ConnectionStatusHysteresis(initialAvailability: .online, readinessTimeout: 8)

        XCTAssertTrue(status.beginConnecting(at: 20))
        XCTAssertEqual(status.presentedAvailability, .connecting)
        XCTAssertTrue(status.observe(.directBootstrap))
        XCTAssertEqual(status.presentedAvailability, .online)
    }
}
