import XCTest
@testable import PerchRPCQueue

final class RPCSendQueueTests: XCTestCase {
    func testExtractsOnlyRPCIds() {
        XCTAssertEqual(
            RPCSendQueue.rpcId(from: ["type": "rpc", "id": "rpc-1", "method": "POST"]),
            "rpc-1"
        )
        XCTAssertNil(RPCSendQueue.rpcId(from: ["type": "subscribe", "sessionId": "pty:1"]))
        XCTAssertNil(RPCSendQueue.rpcId(from: ["type": "rpc", "method": "POST"]))
    }

    func testExpiredQueuedMutationDoesNotFlushWhenE2EEBecomesReady() {
        let staleSubmit = QueuedSocketSend(
            text: #"{"type":"rpc","id":"submit-1","method":"POST","path":"/sessions/pty%3A1/submit"}"#,
            rpcId: "submit-1"
        )

        let flushed = RPCSendQueue.flushable([staleSubmit], liveRPCIds: [])

        XCTAssertTrue(flushed.isEmpty)
    }

    func testTimeoutPrunesQueuedRPCBeforeE2EEReady() {
        var queued = [
            QueuedSocketSend(
                text: #"{"type":"rpc","id":"submit-1","method":"POST","path":"/sessions/pty%3A1/submit"}"#,
                rpcId: "submit-1"
            ),
            QueuedSocketSend(
                text: #"{"type":"subscribe","sessionId":"pty:1"}"#,
                rpcId: nil
            )
        ]

        RPCSendQueue.removeRPC("submit-1", from: &queued)
        let flushed = RPCSendQueue.flushable(queued, liveRPCIds: [])

        XCTAssertEqual(flushed, [
            QueuedSocketSend(text: #"{"type":"subscribe","sessionId":"pty:1"}"#, rpcId: nil)
        ])
    }

    func testCancelPrunesQueuedRPCBeforeE2EEReady() {
        var queued = [
            QueuedSocketSend(
                text: #"{"type":"rpc","id":"approval-1","method":"POST","path":"/sessions/pty%3A1/approve"}"#,
                rpcId: "approval-1"
            )
        ]

        RPCSendQueue.removeRPC("approval-1", from: &queued)
        let flushed = RPCSendQueue.flushable(queued, liveRPCIds: [])

        XCTAssertTrue(flushed.isEmpty)
    }

    func testLiveQueuedRPCStillFlushesAfterE2EEReady() {
        let liveMutation = QueuedSocketSend(
            text: #"{"type":"rpc","id":"config-1","method":"PATCH","path":"/config"}"#,
            rpcId: "config-1"
        )
        let subscribe = QueuedSocketSend(
            text: #"{"type":"subscribe","sessionId":"pty:1"}"#,
            rpcId: nil
        )

        let flushed = RPCSendQueue.flushable([liveMutation, subscribe], liveRPCIds: ["config-1"])

        XCTAssertEqual(flushed, [liveMutation, subscribe])
    }
}
