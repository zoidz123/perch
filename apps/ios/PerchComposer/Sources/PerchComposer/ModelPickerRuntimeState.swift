import Foundation

// A model picker belongs to one runtime. Other sessions may be actively
// generating at the same time, but only the target runtime can lock its chip.
public struct ModelPickerRuntimeState: Equatable {
    public let sessionId: String
    public let isRunning: Bool

    public init(sessionId: String, isRunning: Bool) {
        self.sessionId = sessionId
        self.isRunning = isRunning
    }
}

public func modelPickerIsDisabled(
    for sessionId: String,
    runtimes: [ModelPickerRuntimeState]
) -> Bool {
    runtimes.first { $0.sessionId == sessionId }?.isRunning == true
}
