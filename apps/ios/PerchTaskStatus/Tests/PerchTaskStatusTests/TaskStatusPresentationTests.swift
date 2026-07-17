import XCTest
@testable import PerchTaskStatus

final class TaskStatusPresentationTests: XCTestCase {
    func testQueuedAndWorkingBeforePrUsePlainState() {
        XCTAssertEqual(TaskStatusPresentation.chips(taskState: "queued", pr: nil).map(\.label), ["Queued"])
        XCTAssertEqual(TaskStatusPresentation.chips(taskState: "working", pr: nil).map(\.label), ["Working"])
    }

    func testCompletionRequestStaysVisibleEvenWhenPrExists() {
        let chips = TaskStatusPresentation.chips(
            taskState: "completion_requested",
            pr: TaskStatusPr(url: "https://github.com/o/r/pull/77", checks: "passing")
        )

        XCTAssertEqual(chips.map(\.label), ["Awaiting verification"])
        XCTAssertEqual(chips.map(\.tone), [.attention])
    }

    func testPrNumberIsThePrimaryStatusOncePrExists() {
        let chips = TaskStatusPresentation.chips(
            taskState: "done",
            pr: TaskStatusPr(url: "https://github.com/o/r/pull/77")
        )

        XCTAssertEqual(chips.map(\.label), ["PR #77"])
        XCTAssertTrue(chips[0].isLink)
        XCTAssertEqual(TaskStatusPresentation.metadata(taskState: "done", pr: TaskStatusPr(url: "https://github.com/o/r/pull/77")), [])
    }

    func testPassingChecksKeepPrNumberInPrimaryStatus() {
        let chips = TaskStatusPresentation.chips(
            taskState: "working",
            pr: TaskStatusPr(url: "https://github.com/o/r/pull/12", checks: "passing")
        )

        XCTAssertEqual(chips.map(\.label), ["PR #12 checks passed"])
        XCTAssertEqual(chips.map(\.tone), [.success])
    }

    func testMergeReadyWinsOverChecksAsThePrimaryStatus() {
        let chips = TaskStatusPresentation.chips(
            taskState: "done",
            pr: TaskStatusPr(
                url: "https://github.com/o/r/pull/27",
                checks: "passing",
                mergeReady: true
            )
        )

        XCTAssertEqual(chips.map(\.label), ["PR #27 ready to merge"])
        XCTAssertEqual(chips.last?.tone, .success)
    }

    func testMergedAndClosedStayLinear() {
        XCTAssertEqual(
            TaskStatusPresentation.chips(
                taskState: "landed",
                pr: TaskStatusPr(url: "https://github.com/o/r/pull/155", checks: "passing", merged: true)
            ).map(\.label),
            ["PR #155 merged"]
        )

        XCTAssertEqual(
            TaskStatusPresentation.chips(
                taskState: "closed",
                pr: TaskStatusPr(url: "https://github.com/o/r/pull/155", checks: "passing", merged: true)
            ).map(\.label),
            ["PR #155 closed"]
        )
    }

    func testNamedDocsGateFailureUsesDocsGateCopy() {
        let chips = TaskStatusPresentation.chips(
            taskState: "done",
            pr: TaskStatusPr(
                url: "https://github.com/o/r/pull/9",
                checks: "failing",
                checkDetails: [TaskStatusCheck(name: "docs-gate", state: "failing")]
            )
        )

        XCTAssertEqual(chips.map(\.label), ["PR #9 docs gate failed"])
        XCTAssertEqual(chips.last?.tone, .error)
    }

    func testPassingChecksCanStillShowMergeBlockers() {
        let chips = TaskStatusPresentation.chips(
            taskState: "done",
            pr: TaskStatusPr(
                url: "https://github.com/o/r/pull/21",
                checks: "passing",
                mergeReady: false,
                reviewDecision: "REVIEW_REQUIRED"
            )
        )

        XCTAssertEqual(chips.map(\.label), ["PR #21 review required"])
        XCTAssertEqual(chips.last?.tone, .attention)
    }

    func testUnknownMergeabilityReadsAsUnknownNotBlocked() {
        let chips = TaskStatusPresentation.chips(
            taskState: "done",
            pr: TaskStatusPr(
                url: "https://github.com/o/r/pull/33",
                checks: "passing",
                mergeReady: false,
                mergeable: "UNKNOWN"
            )
        )

        XCTAssertEqual(chips.map(\.label), ["PR #33 merge unknown"])
        XCTAssertEqual(chips.last?.tone, .attention)
    }
}
