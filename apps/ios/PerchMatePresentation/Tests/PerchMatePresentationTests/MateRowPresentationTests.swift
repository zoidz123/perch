import XCTest
@testable import PerchMatePresentation

final class MateRowPresentationTests: XCTestCase {
    func testPromptDeliveryWarningCannotReplaceMateSubtitle() {
        XCTAssertEqual(
            MateRowPresentation.subtitle(
                promptDeliveryWarning: "Claude prompt delivery is unknown; Perch did not resend it",
                promptDeliveryResolution: nil
            ),
            "Runs the crew for you"
        )
    }

    func testPromptDeliveryResolutionCannotReplaceMateSubtitle() {
        XCTAssertEqual(
            MateRowPresentation.subtitle(
                promptDeliveryWarning: nil,
                promptDeliveryResolution: "Claude prompt delivery confirmed"
            ),
            "Runs the crew for you"
        )
    }
}
