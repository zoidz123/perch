import Foundation

// Pure core of the dictation record -> stop -> review flow: the phase machine,
// the silently-accumulated transcript, and the level-meter math. Foundation-only,
// no SwiftUI/AVFoundation - the app compiles this same file, and the
// PerchDictation package runs its unit tests under `swift test` on macOS
// (single source of truth lives in apps/ios/PerchDictation).

enum DictationPhase: Equatable {
    case idle
    /// Engine spin-up: permissions, model asset, microphone. Nothing captured yet.
    case preparing
    /// Mic live. The transcript accumulates here but is never rendered.
    case recording
    /// STOP tapped; the recognizer is finalizing its volatile tail.
    case finishing
}

// The state machine itself. Mutations are guarded so late engine callbacks
// (a transcript update after cancel, a second commit) are no-ops instead of
// writing stale text into a field the user has moved on from.
struct DictationFlow: Equatable {
    private(set) var phase: DictationPhase = .idle
    private(set) var transcript = ""
    private var baseText = ""

    // Mic tapped: idle -> preparing. False when a session is already live.
    mutating func begin(baseText: String) -> Bool {
        guard phase == .idle else { return false }
        self.baseText = baseText
        transcript = ""
        phase = .preparing
        return true
    }

    // Engine reports mic + recognizer live: preparing -> recording.
    mutating func engineDidStart() {
        guard phase == .preparing else { return }
        phase = .recording
    }

    // Full running transcript (finalized text + volatile tail). Accumulated,
    // never rendered; dropped outside recording/finishing so a late callback
    // can't resurrect a cancelled session.
    mutating func observe(transcript: String) {
        guard phase == .recording || phase == .finishing else { return }
        self.transcript = transcript
    }

    // STOP tapped: recording -> finishing. During preparing nothing has been
    // captured, so stop is not a meaningful transition (the caller cancels).
    mutating func requestStop() -> Bool {
        guard phase == .recording else { return false }
        phase = .finishing
        return true
    }

    // Recognizer finalized: the text to land in the composer, exactly once.
    // nil when nothing was heard (the field stays untouched) or when the
    // session was cancelled while finishing.
    mutating func commit() -> String? {
        guard phase == .finishing else { return nil }
        let text = transcript.isEmpty ? nil : Self.merged(base: baseText, transcript: transcript)
        reset()
        return text
    }

    // CANCEL (or the composer leaving the screen): discard audio + transcript.
    mutating func cancel() {
        reset()
    }

    private mutating func reset() {
        phase = .idle
        transcript = ""
        baseText = ""
    }

    // Dictation lands after whatever was already typed, separated by a space
    // unless the existing text already ends in whitespace.
    static func merged(base: String, transcript: String) -> String {
        let trimmedBase = base.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedBase.isEmpty else { return transcript }
        if base.last?.isWhitespace == true { return base + transcript }
        return base + " " + transcript
    }
}

// Level-meter math, kept pure so the bars are testable without a microphone.
enum DictationLevelMeter {
    /// Quietest RMS (in dB full scale) that still registers on the meter.
    static let floorDb: Float = -55

    // Raw linear RMS (0...1) -> 0...1 display level on a dB scale, so normal
    // speech visibly moves the bars while silence sits at the floor.
    static func displayLevel(rms: Float) -> Float {
        guard rms > 0 else { return 0 }
        let db = 20 * log10(rms)
        let level = (db - floorDb) / -floorDb
        return min(max(level, 0), 1)
    }

    // Scrolling history: newest sample appended at the end, bounded at
    // `capacity` so the meter holds only what it can draw.
    static func appended(_ level: Float, to history: [Float], capacity: Int) -> [Float] {
        var next = history
        next.append(level)
        if next.count > capacity {
            next.removeFirst(next.count - capacity)
        }
        return next
    }
}
