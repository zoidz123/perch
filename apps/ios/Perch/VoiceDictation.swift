import AVFoundation
import Speech
import SwiftUI

/// Drives the composer's record -> stop -> review dictation flow. The
/// transcription itself is fully on-device via `SpeechTranscriberEngine`
/// (iOS 26 SpeechAnalyzer); this type owns the UX around it: permissions, the
/// phase machine (`DictationFlow`), the level-meter history, and committing the
/// finished transcript back into the composer exactly once. Nothing is rendered
/// while recording - the transcript accumulates silently and lands on STOP.
@MainActor
final class VoiceDictation: ObservableObject {
    /// Mirrors `flow.phase` for SwiftUI. `.idle` shows the normal composer row;
    /// anything else swaps in the recording row.
    @Published private(set) var phase: DictationPhase = .idle
    /// Scrolling level history (newest last), already normalized to 0...1.
    @Published private(set) var levels: [Float] = []
    @Published var errorMessage: String?

    /// More history than any composer is wide, so rotation never starves the meter.
    static let levelHistoryCapacity = 120

    private var flow = DictationFlow()
    private let engine: DictationAudioEngine
    private var sessionTask: Task<Void, Never>?
    private var commitText: ((String) -> Void)?

    init(engine: DictationAudioEngine? = nil) {
        let arguments = ProcessInfo.processInfo.arguments
        if let engine {
            self.engine = engine
        } else if arguments.contains("-PerchFakeDictation") || arguments.contains("-PerchDictationDemo") {
            // E2E hooks: the simulator has no usable mic/speech model, so a
            // scripted engine drives the full flow for walkthroughs.
            self.engine = FakeDictationEngine()
        } else {
            self.engine = SpeechTranscriberEngine()
        }
    }

    var isActive: Bool { phase != .idle }

    /// Mic tapped. `commit` receives the merged text exactly once, on STOP.
    func begin(currentText: String, commit: @escaping (String) -> Void) {
        guard flow.begin(baseText: currentText) else { return }
        errorMessage = nil
        commitText = commit
        levels = []
        phase = flow.phase
        sessionTask = Task { [weak self] in await self?.run() }
    }

    /// STOP tapped: freeze the meter, let the recognizer finalize, land the
    /// transcript. A stop while still preparing has captured nothing - cancel.
    func finishRecording() {
        if phase == .preparing {
            cancel()
            return
        }
        guard flow.requestStop() else { return }
        phase = flow.phase
        sessionTask = Task { [weak self] in await self?.finalize() }
    }

    /// CANCEL tapped (or the composer left the screen): discard everything.
    func cancel() {
        guard isActive else { return }
        flow.cancel()
        phase = flow.phase
        levels = []
        commitText = nil
        sessionTask?.cancel()
        sessionTask = nil
        let engine = self.engine
        Task { await engine.stop() }
    }

    private func run() async {
        if engine.needsPermissions {
            guard await requestPermissions() else {
                fail(errorMessage ?? "Dictation permissions are required.")
                return
            }
        }
        if Task.isCancelled { return }

        do {
            try await engine.prepare()
            if Task.isCancelled || flow.phase != .preparing {
                // Cancelled while the model was downloading/spinning up.
                await engine.stop()
                return
            }

            try await engine.start(
                onLevel: { [weak self] rms in self?.consume(rms: rms) },
                onTranscript: { [weak self] text in self?.flow.observe(transcript: text) }
            )
            guard flow.phase == .preparing else {
                await engine.stop()
                return
            }
            flow.engineDidStart()
            phase = flow.phase
        } catch {
            fail(error.localizedDescription)
        }
    }

    private func finalize() async {
        // Graceful: the engine returns only after the final transcript has
        // been observed, so the commit below has everything that was said.
        await engine.finish()
        if let text = flow.commit() {
            commitText?(text)
        }
        commitText = nil
        levels = []
        phase = flow.phase
    }

    private func consume(rms: Float) {
        guard phase == .recording else { return }
        levels = DictationLevelMeter.appended(
            DictationLevelMeter.displayLevel(rms: rms),
            to: levels,
            capacity: Self.levelHistoryCapacity
        )
    }

    private func fail(_ message: String) {
        errorMessage = message
        flow.cancel()
        phase = flow.phase
        levels = []
        commitText = nil
        sessionTask = nil
        let engine = self.engine
        Task { await engine.stop() }
    }

    private func requestPermissions() async -> Bool {
        guard await requestSpeechAuthorization() else {
            errorMessage = "Speech recognition permission is required for dictation."
            return false
        }
        guard await requestMicrophoneAuthorization() else {
            errorMessage = "Microphone permission is required for dictation."
            return false
        }
        return true
    }
}

private func requestSpeechAuthorization() async -> Bool {
    await withCheckedContinuation { continuation in
        SFSpeechRecognizer.requestAuthorization { status in
            continuation.resume(returning: status == .authorized)
        }
    }
}

private func requestMicrophoneAuthorization() async -> Bool {
    switch AVAudioApplication.shared.recordPermission {
    case .granted:
        return true
    case .denied:
        return false
    case .undetermined:
        return await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    @unknown default:
        return false
    }
}

/// The idle-state mic button. Tapping it flips the composer into its recording
/// row; committed text lands through the binding on STOP (never auto-sent).
struct VoiceDictationButton: View {
    @ObservedObject var dictation: VoiceDictation
    @Binding var text: String
    /// Runs after the transcript lands, so the composer can focus its field
    /// (cursor at the end) for review.
    var onCommit: (() -> Void)? = nil

    var body: some View {
        Button {
            dictation.begin(currentText: text) { committed in
                text = committed
                onCommit?()
            }
        } label: {
            ZStack {
                Circle()
                    .fill(Style.secondaryFill)
                Image(systemName: "mic.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Style.textSecondary)
            }
            .frame(width: 38, height: 38)
        }
        .accessibilityLabel("Start dictation")
    }
}

/// The composer row while recording: cancel - live level bars (inline, where
/// the text would be) - stop. No text, no timer; the bars are the whole state.
struct DictationRecordingRow: View {
    @ObservedObject var dictation: VoiceDictation

    private var finalizing: Bool { dictation.phase == .finishing }

    var body: some View {
        HStack(spacing: 10) {
            Button(action: { dictation.cancel() }) {
                ZStack {
                    Circle()
                        .fill(Style.secondaryFill)
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Style.textSecondary)
                }
                .frame(width: 38, height: 38)
            }
            .accessibilityLabel("Cancel dictation")

            DictationLevelBars(levels: dictation.levels, finalizing: finalizing)
                .frame(maxWidth: .infinity)
                .frame(height: 38)
                .accessibilityLabel(finalizing ? "Finishing dictation" : "Recording")

            Button(action: { dictation.finishRecording() }) {
                ZStack {
                    Circle()
                        .fill(Style.textPrimary)
                    if finalizing {
                        ProgressView()
                            .controlSize(.small)
                            .tint(.black)
                    } else {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Color.black)
                    }
                }
                .frame(width: 38, height: 38)
            }
            .disabled(finalizing)
            .accessibilityLabel("Stop dictation")
        }
    }
}

/// The inline meter: a row of vertical capsules driven by mic level. Newest
/// sample at the right edge, history marching left; silence rests at a dot.
/// While finalizing the bars freeze and shimmer softly (no blocking UI).
struct DictationLevelBars: View {
    let levels: [Float]
    var finalizing = false

    private static let barWidth: CGFloat = 3
    private static let barSpacing: CGFloat = 3
    private static let minHeight: CGFloat = 3
    private static let maxHeight: CGFloat = 26

    @State private var shimmer = false

    var body: some View {
        GeometryReader { geo in
            let slots = max(Int(geo.size.width / (Self.barWidth + Self.barSpacing)), 1)
            let shown = Self.displayLevels(levels, slots: slots)
            HStack(spacing: Self.barSpacing) {
                ForEach(shown.indices, id: \.self) { index in
                    Capsule()
                        .fill(Style.meterBar.opacity(0.3 + 0.6 * Double(shown[index])))
                        .frame(
                            width: Self.barWidth,
                            height: Self.minHeight + (Self.maxHeight - Self.minHeight) * CGFloat(shown[index])
                        )
                }
            }
            .animation(.linear(duration: 0.08), value: levels)
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .opacity(finalizing && shimmer ? 0.35 : 1)
        .onChange(of: finalizing) { _, now in
            if now {
                withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) {
                    shimmer = true
                }
            } else {
                shimmer = false
            }
        }
    }

    /// Rightmost slot is the newest sample; slots with no history yet render
    /// as resting dots so the meter reads as a full track from the first frame.
    static func displayLevels(_ levels: [Float], slots: Int) -> [Float] {
        let tail = Array(levels.suffix(slots))
        guard tail.count < slots else { return tail }
        return Array(repeating: 0, count: slots - tail.count) + tail
    }
}

/// One per composer surface, attached at the capsule container so the alert
/// exists in every phase and an off-screen composer discards its recording.
private struct DictationLifecycle: ViewModifier {
    @ObservedObject var dictation: VoiceDictation

    func body(content: Content) -> some View {
        content
            .onDisappear { dictation.cancel() }
            .alert("Dictation unavailable", isPresented: errorBinding) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(dictation.errorMessage ?? "")
            }
    }

    private var errorBinding: Binding<Bool> {
        Binding {
            dictation.errorMessage != nil
        } set: { showing in
            if !showing { dictation.errorMessage = nil }
        }
    }
}

extension View {
    func dictationLifecycle(_ dictation: VoiceDictation) -> some View {
        modifier(DictationLifecycle(dictation: dictation))
    }
}
