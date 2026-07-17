import XCTest
@testable import PerchTaskStatus

final class ApprovalPresentationTests: XCTestCase {
    func testComputerUseContextKeepsToolAndAppDistinct() {
        XCTAssertEqual(ApprovalPresentation.contextLine(tool: "Computer Use", app: "Xcode"), "Computer Use · Xcode")
        XCTAssertEqual(ApprovalPresentation.contextLine(tool: nil, app: "Simulator"), "Simulator")
    }

    func testEveryPersistenceChoiceHasTruthfulCopy() {
        XCTAssertEqual(ApprovalPresentation.persistenceHint("turn"), "This request only")
        XCTAssertEqual(ApprovalPresentation.persistenceHint("session"), "Remember for this session")
        XCTAssertEqual(ApprovalPresentation.persistenceHint("always"), "Remember for future calls")
        XCTAssertNil(ApprovalPresentation.persistenceHint(nil))
    }

    func testSubmittedLabelsCoverExactAndGenericApprovals() {
        let advertised = [("allow_session", "Allow for this session")]
        XCTAssertEqual(ApprovalPresentation.submittedLabel("allow_session", advertised: advertised), "Allow for this session")
        XCTAssertEqual(ApprovalPresentation.submittedLabel("allow", advertised: []), "Allow")
        XCTAssertEqual(ApprovalPresentation.submittedLabel("deny", advertised: []), "Deny")
        XCTAssertEqual(ApprovalPresentation.submittedLabel("unknown", advertised: []), "Response")
    }
}
