import XCTest
@testable import PerchTaskStatus

final class TaskStatusPresentationTests: XCTestCase {
    func testGreenPrFactsDoNotPromoteWorkingTask() {
        let chip = TaskStatusPresentation.primaryChip(
            taskState: "working",
            pr: TaskStatusPr(url: "https://github.com/o/r/pull/12", checks: "passing", mergeReady: true),
            presentationState: "working",
            mode: "direct-PR"
        )
        XCTAssertEqual(chip.label, "Working")
        XCTAssertNotEqual(chip.tone, .success)
    }

    func testDerivedStatesHaveOnlyApprovedPrimaryBadges() {
        XCTAssertEqual(TaskStatusPresentation.primaryChip(taskState: "working", pr: nil, presentationState: "reviewing", mode: "no-mistakes").label, "Reviewing")
        XCTAssertEqual(TaskStatusPresentation.primaryChip(taskState: "done", pr: nil, presentationState: "ready_to_merge").label, "Ready to merge")
        XCTAssertEqual(TaskStatusPresentation.primaryChip(taskState: "done", pr: nil, presentationState: "ready_to_apply", mode: "local-only").label, "Ready to apply")
        XCTAssertEqual(TaskStatusPresentation.primaryChip(taskState: "completion_requested", pr: nil, presentationState: "awaiting_verification").label, "Awaiting verification")
        XCTAssertEqual(TaskStatusPresentation.primaryChip(taskState: "needs_you", pr: nil, presentationState: "needs_you").label, "Needs you")
        XCTAssertEqual(TaskStatusPresentation.primaryChip(taskState: "blocked", pr: nil, presentationState: "blocked").label, "Blocked")
        XCTAssertEqual(TaskStatusPresentation.primaryChip(taskState: "failed", pr: nil, presentationState: "failed").label, "Failed")
    }

    func testOtherModesStayWorkingUntilVerification() {
        XCTAssertEqual(TaskStatusPresentation.primaryChip(taskState: "working", pr: nil, presentationState: "working", mode: "direct-PR").label, "Working")
        XCTAssertEqual(TaskStatusPresentation.primaryChip(taskState: "working", pr: nil, presentationState: "working", mode: "local-only").label, "Working")
        XCTAssertEqual(TaskStatusPresentation.primaryChip(taskState: "completion_requested", pr: nil, presentationState: "awaiting_verification", mode: "no-mistakes").label, "Awaiting verification")
    }

    func testPrChipIsNeutralAndSeparateFromPrimaryState() {
        let pr = TaskStatusPr(url: "https://github.com/o/r/pull/77", checks: "passing", mergeReady: true)
        XCTAssertEqual(TaskStatusPresentation.prChip(pr)?.label, "PR #77")
        XCTAssertEqual(TaskStatusPresentation.prChip(pr)?.tone, .neutral)
        XCTAssertTrue(TaskStatusPresentation.prChip(pr)?.isLink == true)
        XCTAssertEqual(TaskStatusPresentation.primaryChip(taskState: "working", pr: pr, presentationState: "working").label, "Working")
    }
}
