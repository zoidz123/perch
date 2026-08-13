import XCTest
@testable import Perch

@MainActor
final class OptimisticMessageReconciliationTests: XCTestCase {
    private let sessionId = "pty:mate"

    func testSingleMessageCanonicalRowReplacesItsOptimisticBubble() {
        let rendered = reconcile(
            optimisticTexts: ["Hello"],
            canonicalText: "Hello"
        )

        XCTAssertEqual(rendered.before.map(\.text), ["Hello", "Hello"])
        XCTAssertEqual(rendered.after.map(\.text), ["Hello"])
    }

    func testIdleFastPathSingleMessageReplacesItsOptimisticBubble() {
        let rendered = reconcile(
            optimisticTexts: ["Follow up"],
            canonicalText: "Follow up"
        )

        XCTAssertEqual(rendered.after.map(\.text), ["Follow up"])
    }

    func testBatchCanonicalRowReplacesEveryConstituentOptimisticBubble() {
        let rendered = reconcile(
            optimisticTexts: ["Hello2", "Hello3", "Hello4"],
            canonicalText: "Hello2\nHello3\nHello4"
        )

        // This is the visual duplication reported from the phone: one
        // authoritative batched row plus each local send before reconciliation.
        XCTAssertEqual(rendered.before.map(\.text), ["Hello2\nHello3\nHello4", "Hello2", "Hello3", "Hello4"])
        XCTAssertEqual(rendered.after.map(\.text), ["Hello2\nHello3\nHello4"])
    }

    func testBatchWithIdenticalTextsConsumesOnlyItsOwnConstituents() {
        let rendered = reconcile(
            optimisticTexts: ["Hello", "Hello", "later"],
            canonicalText: "Hello\nHello"
        )

        XCTAssertEqual(rendered.after.map(\.text), ["Hello\nHello", "later"])
    }

    func testBatchWithDeliveryRetryEchoDoesNotLeaveAnOptimisticBubbleAfterMateReplies() {
        let rendered = reconcile(
            optimisticTexts: ["Hello", "Hello2"],
            canonicalTexts: ["Hello\nHello2\nHello2"],
            includesMateReply: true
        )

        XCTAssertEqual(
            rendered.after.map(\.text),
            ["Hello\nHello2\nHello2", "Done"]
        )
        XCTAssertFalse(rendered.after.contains(where: { $0.id.hasPrefix("optimistic-") }))
    }

    func testMixedBatchAndRetryEchoLeavesLaterDistinctMessageOptimistic() {
        let rendered = reconcile(
            optimisticTexts: ["Hello", "Hello2", "follow up"],
            canonicalTexts: ["Hello\nHello2\nHello2"]
        )

        XCTAssertEqual(rendered.after.map(\.text), ["Hello\nHello2\nHello2", "follow up"])
    }

    func testIdleQueuedSnapshotUsesNeutralSendingCopy() {
        XCTAssertEqual(
            ComposerSendState.resolve(delivery: nil, queuedCount: 1, agentStatus: .idle),
            .sending
        )
    }

    func testBusyQueuedSnapshotExplicitlySaysAgentIsBusy() {
        XCTAssertEqual(
            ComposerSendState.resolve(delivery: nil, queuedCount: 1, agentStatus: .running),
            .queuedWhileBusy
        )
    }

    func testConfirmedDeliverySettlesPromptly() {
        XCTAssertEqual(
            ComposerSendState.resolve(
                delivery: InputDeliveryState(enqueuedAt: "1", releasedAt: "2", confirmedAt: "3"),
                queuedCount: 0,
                agentStatus: .running
            ),
            .settled
        )
    }

    private func reconcile(
        optimisticTexts: [String],
        canonicalText: String? = nil,
        canonicalTexts: [String] = [],
        includesMateReply: Bool = false
    ) -> (before: [TimelineItem], after: [TimelineItem]) {
        let store = PerchStore()
        store.optimisticBySession[sessionId] = optimisticTexts.enumerated().map { index, text in
            OptimisticMessage(
                item: TimelineItem(
                    seq: 0,
                    id: "optimistic-\(index)",
                    sessionId: sessionId,
                    kind: .user,
                    text: text,
                    tool: nil,
                    at: "2026-08-13T13:00:00.000Z"
                ),
                deadline: .distantFuture
            )
        }
        let texts = canonicalText.map { [$0] } ?? canonicalTexts
        var canonical = texts.enumerated().map { index, text in
            TimelineItem(
                seq: index + 1,
                id: "canonical-\(index + 1)",
                sessionId: sessionId,
                kind: .user,
                text: text,
                tool: nil,
                at: "2026-08-13T13:00:01.000Z"
            )
        }
        if includesMateReply {
            canonical.append(
                TimelineItem(
                    seq: canonical.count + 1,
                    id: "mate-reply",
                    sessionId: sessionId,
                    kind: .assistant,
                    text: "Done",
                    tool: nil,
                    at: "2026-08-13T13:00:02.000Z"
                )
            )
        }
        store.timelinesBySession[sessionId] = canonical

        let before = store.chatItems(sessionId)
        store.reconcileOptimistic(sessionId, canonical)
        return (before, store.chatItems(sessionId))
    }
}
