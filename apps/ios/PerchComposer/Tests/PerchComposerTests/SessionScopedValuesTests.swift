import XCTest
@testable import PerchComposer

final class SessionScopedValuesTests: XCTestCase {
    func testValuesStayScopedToTheirSession() {
        var store = SessionScopedValues<String>()

        store.append("a-image", for: "session-a")
        store.append("b-image", for: "session-b")

        XCTAssertEqual(store.values(for: "session-a"), ["a-image"])
        XCTAssertEqual(store.values(for: "session-b"), ["b-image"])
        XCTAssertEqual(store.values(for: nil), [])
    }

    func testClearingOneSessionDoesNotClearAnother() {
        var store = SessionScopedValues<String>()
        store.append("a-image", for: "session-a")
        store.append("b-image", for: "session-b")

        store.replace([], for: "session-a")

        XCTAssertEqual(store.values(for: "session-a"), [])
        XCTAssertEqual(store.values(for: "session-b"), ["b-image"])
    }

    func testLateUploadCanAppendToOriginalSession() {
        var store = SessionScopedValues<String>()
        let uploadStartedIn = "session-a"
        let currentlySelected = "session-b"

        store.append("uploaded-after-navigation", for: uploadStartedIn)

        XCTAssertEqual(store.values(for: uploadStartedIn), ["uploaded-after-navigation"])
        XCTAssertEqual(store.values(for: currentlySelected), [])
    }
}
