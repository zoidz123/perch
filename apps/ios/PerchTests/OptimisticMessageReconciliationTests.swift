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

    private func reconcile(
        optimisticTexts: [String],
        canonicalText: String
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
        let canonical = TimelineItem(
            seq: 1,
            id: "canonical-1",
            sessionId: sessionId,
            kind: .user,
            text: canonicalText,
            tool: nil,
            at: "2026-08-13T13:00:01.000Z"
        )
        store.timelinesBySession[sessionId] = [canonical]

        let before = store.chatItems(sessionId)
        store.reconcileOptimistic(sessionId, [canonical])
        return (before, store.chatItems(sessionId))
    }
}
