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

    func testForegroundRefreshKeepsCachedWorkspaceVisibleAndReadOnly() {
        var status = ConnectionStatusHysteresis(initialAvailability: .online, readinessTimeout: 8)

        XCTAssertTrue(status.beginConnecting(at: 20))
        XCTAssertEqual(status.presentedAvailability, .connecting)
        let presentation = ConnectionContentPresentation(
            availability: status.presentedAvailability,
            hasCachedContent: true
        )

        XCTAssertEqual(presentation.mode, .cachedReadOnly)
        XCTAssertFalse(presentation.usesBlockingPlaceholder)
        XCTAssertTrue(presentation.showsConnectionIndicator)
        XCTAssertFalse(presentation.permitsOutboundActions)
    }

    func testTransientRelayLossKeepsCachedHomeAndSessionContentReadable() {
        let home = ConnectionContentPresentation(availability: .connecting, hasCachedContent: true)
        let session = ConnectionContentPresentation(availability: .offline, hasCachedContent: true)

        XCTAssertEqual(home.mode, .cachedReadOnly)
        XCTAssertEqual(session.mode, .cachedReadOnly)
        XCTAssertTrue(home.showsConnectionIndicator)
        XCTAssertTrue(session.showsConnectionIndicator)
        XCTAssertFalse(home.permitsOutboundActions)
        XCTAssertFalse(session.permitsOutboundActions)
    }

    func testColdStartWithoutCacheUsesBlockingBootstrap() {
        let presentation = ConnectionContentPresentation(availability: .connecting, hasCachedContent: false)

        XCTAssertEqual(presentation.mode, .blockingBootstrap)
        XCTAssertTrue(presentation.usesBlockingPlaceholder)
        XCTAssertFalse(presentation.showsConnectionIndicator)
        XCTAssertFalse(presentation.permitsOutboundActions)
    }

    func testReadinessDeadlineOfflineKeepsCachedContentReadOnly() {
        var status = ConnectionStatusHysteresis(readinessTimeout: 8)

        status.beginConnecting(at: 10)
        XCTAssertTrue(status.advance(to: 18))
        let presentation = ConnectionContentPresentation(
            availability: status.presentedAvailability,
            hasCachedContent: true
        )

        XCTAssertEqual(status.presentedAvailability, .offline)
        XCTAssertEqual(presentation.mode, .cachedReadOnly)
        XCTAssertTrue(presentation.showsConnectionIndicator)
        XCTAssertFalse(presentation.permitsOutboundActions)
    }

    func testOutboundControlsRequireOnlinePresentation() {
        let connecting = ConnectionContentPresentation(availability: .connecting, hasCachedContent: true)
        let offline = ConnectionContentPresentation(availability: .offline, hasCachedContent: true)
        let online = ConnectionContentPresentation(availability: .online, hasCachedContent: true)

        XCTAssertFalse(connecting.permitsOutboundActions)
        XCTAssertFalse(offline.permitsOutboundActions)
        XCTAssertTrue(online.permitsOutboundActions)
    }

    func testCachedTimelineRetryAndWorkspaceMutationsWaitForFreshReadiness() {
        var status = ConnectionStatusHysteresis(initialAvailability: .online, readinessTimeout: 8)

        status.beginConnecting(at: 20)
        var presentation = ConnectionContentPresentation(
            availability: status.presentedAvailability,
            hasCachedContent: true
        )

        XCTAssertEqual(presentation.mode, .cachedReadOnly)
        XCTAssertFalse(presentation.permitsOutboundActions)

        XCTAssertTrue(status.observe(.directBootstrap))
        presentation = ConnectionContentPresentation(
            availability: status.presentedAvailability,
            hasCachedContent: true
        )

        XCTAssertEqual(presentation.mode, .interactive)
        XCTAssertTrue(presentation.permitsOutboundActions)
    }

    func testCachedContentStaysVisibleButBlocksWritesUntilFreshReadiness() {
        var status = ConnectionStatusHysteresis(initialAvailability: .online, readinessTimeout: 8)

        status.beginConnecting(at: 20)
        var presentation = ConnectionContentPresentation(
            availability: status.presentedAvailability,
            hasCachedContent: true
        )

        XCTAssertEqual(presentation.mode, .cachedReadOnly)
        XCTAssertFalse(presentation.usesBlockingPlaceholder)
        XCTAssertFalse(presentation.permitsOutboundActions)

        XCTAssertTrue(status.observe(.authenticatedFleetSnapshot))
        presentation = ConnectionContentPresentation(
            availability: status.presentedAvailability,
            hasCachedContent: true
        )

        XCTAssertEqual(presentation.mode, .interactive)
        XCTAssertTrue(presentation.permitsOutboundActions)
    }

    func testRecoveryRestoresInteractiveContentWithoutChangingCachedSessionOrTimeline() {
        let selectedSessionID = "pty:cached-session"
        let cachedTimelineSequences = [41, 42]
        let reconnecting = ConnectionContentPresentation(availability: .connecting, hasCachedContent: true)
        let recovered = ConnectionContentPresentation(availability: .online, hasCachedContent: true)

        XCTAssertEqual(reconnecting.mode, .cachedReadOnly)
        XCTAssertEqual(recovered.mode, .interactive)
        XCTAssertFalse(recovered.showsConnectionIndicator)
        XCTAssertTrue(recovered.permitsOutboundActions)
        XCTAssertEqual(selectedSessionID, "pty:cached-session")
        XCTAssertEqual(cachedTimelineSequences, [41, 42])
    }

    func testUnpairResetClearsPriorReadinessDeadline() {
        var status = ConnectionStatusHysteresis(readinessTimeout: 8)

        status.beginConnecting(at: 20)
        XCTAssertEqual(status.readinessDeadline, 28)
        XCTAssertTrue(status.reset())
        XCTAssertEqual(status.presentedAvailability, .connecting)
        XCTAssertNil(status.readinessDeadline)
        XCTAssertFalse(status.advance(to: 100))
    }

    func testQueuedFullRelayReconciliationRetainsTimelineRecoveryScope() {
        var queue = FleetReconciliationQueue()

        XCTAssertTrue(queue.request(.partial))
        XCTAssertFalse(queue.request(.full))
        XCTAssertEqual(queue.active, .partial)
        XCTAssertEqual(queue.pending, .full)
        XCTAssertEqual(queue.complete(), .full)
    }

    func testForegroundRequestDuringFullRefreshQueuesTrailingFullRefresh() {
        var queue = FleetReconciliationQueue()

        XCTAssertTrue(queue.request(.full))
        XCTAssertFalse(queue.request(.full))
        XCTAssertEqual(queue.active, .full)
        XCTAssertEqual(queue.pending, .full)
        XCTAssertEqual(queue.complete(), .full)
    }

    func testFleetRequestAfterTaskSnapshotQueuesTrailingPartialRefresh() {
        var queue = FleetReconciliationQueue()

        XCTAssertTrue(queue.request(.partial))
        XCTAssertFalse(queue.request(.partial))
        XCTAssertEqual(queue.active, .partial)
        XCTAssertEqual(queue.pending, .partial)
        XCTAssertEqual(queue.complete(), .partial)
    }

    func testTrailingReconciliationRetainsMaximumRequestedScope() {
        var queue = FleetReconciliationQueue()

        XCTAssertTrue(queue.request(.full))
        XCTAssertFalse(queue.request(.partial))
        XCTAssertFalse(queue.request(.full))
        XCTAssertEqual(queue.pending, .full)
    }

    func testTrailingPartialReconciliationWaitsForThrottleWindow() {
        let throttle = FleetReconciliationThrottle(minimumInterval: 2)
        let lastStart = Date(timeIntervalSinceReferenceDate: 100)

        XCTAssertEqual(
            throttle.delaySinceLastStart(
                lastStart,
                now: Date(timeIntervalSinceReferenceDate: 100.5)
            ),
            1.5
        )
        XCTAssertEqual(
            throttle.delaySinceLastStart(
                lastStart,
                now: Date(timeIntervalSinceReferenceDate: 102)
            ),
            0
        )
    }

    func testPairingReplacementRejectsOldHostRefresh() {
        var gate = ConnectionRefreshGate()
        let oldGeneration = gate.beginRefresh()

        gate.beginPairingReplacement()

        XCTAssertTrue(gate.isReplacingPairing)
        XCTAssertNil(gate.beginRefresh())
        XCTAssertFalse(gate.owns(oldGeneration ?? -1))
    }

    func testNewPairingRefreshOwnsCompletionAfterReplacement() {
        var gate = ConnectionRefreshGate()

        gate.beginPairingReplacement()
        gate.finishPairingReplacement()
        let newGeneration = gate.beginRefresh()

        XCTAssertFalse(gate.isReplacingPairing)
        XCTAssertNotNil(newGeneration)
        XCTAssertTrue(gate.owns(newGeneration ?? -1))
    }

    func testReconnectResultRequiresMatchingPairingAndActiveTask() {
        let oldPairing = PairingIdentity(serverID: "old")

        XCTAssertFalse(
            oldPairing.acceptsReconnectResult(currentServerID: "new", isCancelled: false)
        )
        XCTAssertFalse(
            oldPairing.acceptsReconnectResult(currentServerID: "old", isCancelled: true)
        )
        XCTAssertTrue(
            oldPairing.acceptsReconnectResult(currentServerID: "old", isCancelled: false)
        )
    }

    func testOnlyCrossHostPairingClearsServerSnapshots() {
        let pairing = PairingIdentity(serverID: "new")

        XCTAssertTrue(pairing.replaces("old"))
        XCTAssertFalse(pairing.replaces("new"))
        XCTAssertFalse(pairing.replaces(nil))
    }
}
