import XCTest
@testable import PerchConnectivity

final class ConnectionStatusPresentationTests: XCTestCase {
    func testFlappingNeverPresentsOffline() {
        var status = ConnectionStatusHysteresis(offlineDelay: 2)

        XCTAssertFalse(status.observe(isLive: false, at: 0))
        XCTAssertFalse(status.observe(isLive: false, at: 1))
        XCTAssertFalse(status.observe(isLive: true, at: 1.5))
        XCTAssertFalse(status.advance(to: 10))
        XCTAssertEqual(status.presentedAvailability, .online)
    }

    func testOfflineMustRemainStableForFullDelay() {
        var status = ConnectionStatusHysteresis(offlineDelay: 2)

        XCTAssertFalse(status.observe(isLive: false, at: 10))
        XCTAssertFalse(status.advance(to: 11.99))
        XCTAssertEqual(status.presentedAvailability, .online)
        XCTAssertTrue(status.advance(to: 12))
        XCTAssertEqual(status.presentedAvailability, .offline)
    }

    func testRecoveryPresentsOnlineImmediately() {
        var status = ConnectionStatusHysteresis(
            initialAvailability: .offline,
            offlineDelay: 2
        )

        XCTAssertTrue(status.observe(isLive: true, at: 20))
        XCTAssertEqual(status.presentedAvailability, .online)
    }
}
