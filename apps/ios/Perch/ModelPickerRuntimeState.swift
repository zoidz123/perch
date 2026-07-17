import Foundation

// A model picker belongs to one runtime. Other sessions may be actively
// generating at the same time, but only the target runtime can lock its chip.
struct ModelPickerRuntimeState: Equatable {
    let sessionId: String
    let isRunning: Bool
}

func modelPickerIsDisabled(
    for sessionId: String,
    runtimes: [ModelPickerRuntimeState]
) -> Bool {
    runtimes.first { $0.sessionId == sessionId }?.isRunning == true
}
