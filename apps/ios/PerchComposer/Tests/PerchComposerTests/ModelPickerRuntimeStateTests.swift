import XCTest
@testable import PerchComposer

final class ModelPickerRuntimeStateTests: XCTestCase {
    func testRunningWorkerDoesNotDisableIdleMatePicker() {
        let runtimes = [
            ModelPickerRuntimeState(sessionId: "mate", isRunning: false),
            ModelPickerRuntimeState(sessionId: "worker", isRunning: true)
        ]

        XCTAssertFalse(modelPickerIsDisabled(for: "mate", runtimes: runtimes))
    }

    func testEachPickerUsesOnlyItsOwnRuntime() {
        let runtimes = [
            ModelPickerRuntimeState(sessionId: "mate", isRunning: true),
            ModelPickerRuntimeState(sessionId: "worker", isRunning: false)
        ]

        XCTAssertTrue(modelPickerIsDisabled(for: "mate", runtimes: runtimes))
        XCTAssertFalse(modelPickerIsDisabled(for: "worker", runtimes: runtimes))
    }

    func testRunningWorkerDisablesItsOwnPicker() {
        let runtimes = [
            ModelPickerRuntimeState(sessionId: "mate", isRunning: false),
            ModelPickerRuntimeState(sessionId: "worker", isRunning: true)
        ]

        XCTAssertTrue(modelPickerIsDisabled(for: "worker", runtimes: runtimes))
    }
}
