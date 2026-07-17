import Accelerate
import AVFoundation
import Speech

/// What the dictation flow needs from an audio + speech engine. The real
/// implementation is `SpeechTranscriberEngine`; the simulator/E2E path swaps in
/// a scripted `FakeDictationEngine` (launch argument `-PerchFakeDictation`) so
/// the record -> stop -> review flow is exercisable without a microphone or
/// on-device speech model.
@MainActor
protocol DictationAudioEngine: AnyObject {
    /// False for fakes so the flow skips the speech/mic permission prompts.
    var needsPermissions: Bool { get }
    func prepare() async throws
    /// Start capturing. `onLevel` receives a raw linear RMS per mic buffer
    /// (~12 Hz); `onTranscript` the full running transcript each time it changes.
    func start(
        onLevel: @escaping @MainActor (Float) -> Void,
        onTranscript: @escaping @MainActor (String) -> Void
    ) async throws
    /// Graceful stop for the commit path: returns only after the final
    /// transcript has been delivered through `onTranscript`.
    func finish() async
    /// Hard stop for the cancel path: discard everything as fast as possible.
    func stop() async
}

/// On-device streaming speech-to-text built on the iOS 26 `SpeechAnalyzer` /
/// `SpeechTranscriber` stack.
///
/// Audio is transcribed entirely on the device - it never routes to a server -
/// and there is no ~1-minute cap (the legacy `SFSpeechRecognizer` had both
/// problems). All of the SpeechAnalyzer plumbing lives behind the small
/// `DictationAudioEngine` surface so a different on-device engine - e.g.
/// WhisperKit - could later replace this class without touching
/// `VoiceDictation` or any of its call sites.
@MainActor
final class SpeechTranscriberEngine: DictationAudioEngine {
    enum EngineError: LocalizedError {
        case localeUnavailable
        case notPrepared
        case audioFormatUnavailable
        case microphoneUnavailable

        var errorDescription: String? {
            switch self {
            case .localeUnavailable:
                "Dictation isn't available for this language yet."
            case .notPrepared:
                "The on-device speech engine wasn't ready."
            case .audioFormatUnavailable:
                "Couldn't start the on-device speech engine."
            case .microphoneUnavailable:
                "No usable microphone input is available."
            }
        }
    }

    let needsPermissions = true

    private let audioEngine = AVAudioEngine()
    private var analyzer: SpeechAnalyzer?
    private var transcriber: SpeechTranscriber?
    private var analyzerFormat: AVAudioFormat?
    private var inputBuilder: AsyncStream<AnalyzerInput>.Continuation?
    private var levelBuilder: AsyncStream<Float>.Continuation?
    private var resultsTask: Task<Void, Never>?
    private var levelTask: Task<Void, Never>?
    private var resolvedLocale: Locale?

    /// Pick the best locale to transcribe in: the user's current locale if the
    /// on-device model supports it, otherwise the closest same-language match,
    /// then any English variant, else the first supported locale. `nil` only when
    /// SpeechTranscriber advertises no supported locales at all.
    static func resolveLocale(preferred: Locale) async -> Locale? {
        let supported = await SpeechTranscriber.supportedLocales
        guard !supported.isEmpty else { return nil }

        let wanted = preferred.identifier(.bcp47)
        if let exact = supported.first(where: { $0.identifier(.bcp47) == wanted }) {
            return exact
        }
        if let language = preferred.language.languageCode?.identifier,
           let sameLanguage = supported.first(where: { $0.language.languageCode?.identifier == language }) {
            return sameLanguage
        }
        if let english = supported.first(where: { $0.identifier(.bcp47).hasPrefix("en") }) {
            return english
        }
        return supported.first
    }

    /// Build the transcriber + analyzer and make sure the on-device model asset
    /// is present, downloading it if this is the first use on the device. The
    /// download is awaited, so the caller shows a "preparing" state for the
    /// duration rather than failing. The resolved locale is cached across
    /// sessions - only the first recording pays for resolution.
    func prepare() async throws {
        let locale: Locale
        if let resolvedLocale {
            locale = resolvedLocale
        } else if let resolved = await Self.resolveLocale(preferred: Locale.current) {
            locale = resolved
        } else {
            throw EngineError.localeUnavailable
        }
        resolvedLocale = locale

        let transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults],
            attributeOptions: []
        )
        self.transcriber = transcriber

        if let installation = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await installation.downloadAndInstall()
        }

        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw EngineError.audioFormatUnavailable
        }
        analyzerFormat = format
        analyzer = SpeechAnalyzer(modules: [transcriber])
    }

    /// Start capturing from the microphone and analyzing it. Both callbacks are
    /// called on the main actor: `onLevel` with the raw RMS of each mic buffer,
    /// `onTranscript` with the full running transcript (finalized text plus the
    /// current volatile tail) each time it changes. Call `prepare()` first.
    func start(
        onLevel: @escaping @MainActor (Float) -> Void,
        onTranscript: @escaping @MainActor (String) -> Void
    ) async throws {
        guard let transcriber, let analyzer, let analyzerFormat else {
            throw EngineError.notPrepared
        }

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let (inputSequence, inputBuilder) = AsyncStream<AnalyzerInput>.makeStream()
        self.inputBuilder = inputBuilder

        // Levels ride their own stream so the meter can't backpressure the
        // analyzer: only the newest sample is kept if the UI falls behind.
        let (levelSequence, levelBuilder) = AsyncStream<Float>.makeStream(
            bufferingPolicy: .bufferingNewest(1)
        )
        self.levelBuilder = levelBuilder

        let inputNode = audioEngine.inputNode
        let tapFormat = inputNode.outputFormat(forBus: 0)
        guard tapFormat.sampleRate > 0, tapFormat.channelCount > 0 else {
            throw EngineError.microphoneUnavailable
        }

        // The tap fires on a realtime audio thread. It measures the buffer's
        // level, converts it into the format the analyzer wants, and hands it
        // to the input stream. The converter is touched only from this single
        // serial thread.
        //
        // The block MUST be built by a nonisolated free function and typed
        // `@Sendable`: a closure formed inline here would inherit this method's
        // `@MainActor` isolation, so the Swift runtime inserts an executor check
        // at its prologue. AVFAudio calls the tap on `RealtimeMessenger`'s audio
        // queue, not the main actor, so that check trips `_dispatch_assert_queue_fail`
        // and traps (EXC_BREAKPOINT). Keeping it `@Sendable`/nonisolated removes the
        // check and makes any future re-isolation a compile error, not a crash.
        let converter = BufferConverter()
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(
            onBus: 0,
            bufferSize: 4096,
            format: tapFormat,
            block: makeAnalyzerTap(
                converter: converter,
                format: analyzerFormat,
                into: inputBuilder,
                levels: levelBuilder
            )
        )

        audioEngine.prepare()
        try audioEngine.start()

        try await analyzer.start(inputSequence: inputSequence)

        levelTask = Task {
            for await rms in levelSequence {
                onLevel(rms)
            }
        }

        resultsTask = Task { [transcriber] in
            var finalized = AttributedString()
            do {
                for try await result in transcriber.results {
                    var running = finalized
                    if result.isFinal {
                        finalized.append(result.text)
                        running = finalized
                    } else {
                        // Volatile tail: the best current guess for text not yet
                        // finalized. Accumulated on top of what's already committed.
                        running.append(result.text)
                    }
                    onTranscript(String(running.characters))
                }
            } catch {
                // Iteration ends on stop/cancel or a mid-stream error; nothing to
                // surface here - `stop()`/`finish()` own teardown.
            }
        }
    }

    /// Graceful stop: stop the mic, then let the analyzer finalize everything
    /// it heard so the last (final) result flows through `onTranscript` before
    /// this returns. Bounded so a pathological finalization can't pin the
    /// composer in its finishing state forever.
    func finish() async {
        inputBuilder?.finish()
        inputBuilder = nil
        levelBuilder?.finish()
        levelBuilder = nil

        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)

        if let analyzer {
            try? await analyzer.finalizeAndFinishThroughEndOfInput()
        }
        if let resultsTask {
            let bound = Task {
                try? await Task.sleep(for: .seconds(4))
                resultsTask.cancel()
            }
            await resultsTask.value
            bound.cancel()
        }
        resultsTask = nil
        levelTask?.cancel()
        levelTask = nil

        tearDownAnalyzer()
    }

    /// Hard stop for the cancel path: tear the session down fully and drop
    /// every reference so the next start is clean. No result is awaited.
    func stop() async {
        inputBuilder?.finish()
        inputBuilder = nil
        levelBuilder?.finish()
        levelBuilder = nil

        resultsTask?.cancel()
        resultsTask = nil
        levelTask?.cancel()
        levelTask = nil

        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)

        if let analyzer {
            try? await analyzer.finalizeAndFinishThroughEndOfInput()
        }
        tearDownAnalyzer()
    }

    private func tearDownAnalyzer() {
        analyzer = nil
        transcriber = nil
        analyzerFormat = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

/// Builds the microphone tap block. Declared as a nonisolated free function
/// returning a `@Sendable` closure so the block never inherits a caller's actor
/// isolation - AVFAudio invokes it on a realtime audio thread, and an isolated
/// block would trap there on the Swift executor-isolation check. Everything it
/// captures is `Sendable`: the converter is used only from this single serial
/// tap thread, and both continuations are thread-safe.
private func makeAnalyzerTap(
    converter: BufferConverter,
    format: AVAudioFormat,
    into builder: AsyncStream<AnalyzerInput>.Continuation,
    levels: AsyncStream<Float>.Continuation
) -> AVAudioNodeTapBlock {
    { @Sendable buffer, _ in
        levels.yield(bufferRMS(buffer))
        guard let converted = try? converter.convert(buffer, to: format) else { return }
        builder.yield(AnalyzerInput(buffer: converted))
    }
}

/// RMS of one mic buffer, on the realtime tap thread (vDSP, allocation-free).
/// Feeds the level meter; `DictationLevelMeter.displayLevel` maps it to bars.
private func bufferRMS(_ buffer: AVAudioPCMBuffer) -> Float {
    guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
    var rms: Float = 0
    vDSP_rmsqv(channel, 1, &rms, vDSP_Length(buffer.frameLength))
    return rms
}

/// Converts microphone buffers into the sample format the SpeechAnalyzer expects.
/// Accessed only from the single audio-tap thread, so the retained
/// `AVAudioConverter` is used serially despite the `@unchecked Sendable`.
private final class BufferConverter: @unchecked Sendable {
    enum Failure: Error {
        case cannotCreateConverter
        case cannotAllocateBuffer
        case conversionFailed(NSError?)
    }

    private var converter: AVAudioConverter?

    func convert(_ buffer: AVAudioPCMBuffer, to format: AVAudioFormat) throws -> AVAudioPCMBuffer {
        let inputFormat = buffer.format
        guard !inputFormat.isEqual(format) else { return buffer }

        if converter == nil || converter?.outputFormat.isEqual(format) == false {
            converter = AVAudioConverter(from: inputFormat, to: format)
            converter?.primeMethod = .none
        }
        guard let converter else { throw Failure.cannotCreateConverter }

        let ratio = format.sampleRate / inputFormat.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up))
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
            throw Failure.cannotAllocateBuffer
        }

        var nsError: NSError?
        // Hand the single input buffer over exactly once, then report end-of-data.
        // A holder keeps the "already consumed" flag out of a var captured by the
        // (Sendable) input block, which Swift 6 concurrency rejects.
        let provider = SingleBufferProvider(buffer)
        let status = converter.convert(to: output, error: &nsError) { _, statusPointer in
            provider.next(statusPointer)
        }
        guard status != .error else { throw Failure.conversionFailed(nsError) }
        return output
    }
}

/// Supplies one buffer to `AVAudioConverter` then signals end-of-data. Accessed
/// only synchronously inside a single `convert` call, so the `@unchecked Sendable`
/// holds.
private final class SingleBufferProvider: @unchecked Sendable {
    private var buffer: AVAudioPCMBuffer?

    init(_ buffer: AVAudioPCMBuffer) {
        self.buffer = buffer
    }

    func next(_ statusPointer: UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioPCMBuffer? {
        if let buffer {
            self.buffer = nil
            statusPointer.pointee = .haveData
            return buffer
        }
        statusPointer.pointee = .noDataNow
        return nil
    }
}

/// Scripted engine for the simulator and UI walkthroughs (`-PerchFakeDictation`):
/// no microphone, permissions, or on-device speech model needed. Emits a
/// speech-like level pattern (bursts separated by silence, so the meter's
/// speech-vs-silence response is visible) and a canned growing transcript.
@MainActor
final class FakeDictationEngine: DictationAudioEngine {
    let needsPermissions = false

    private static let script = [
        "Ship",
        "Ship the dictation",
        "Ship the dictation redesign",
        "Ship the dictation redesign today.",
    ]

    private var feed: Task<Void, Never>?
    private var lastEmitted: String?
    private var onTranscript: (@MainActor (String) -> Void)?

    func prepare() async throws {}

    func start(
        onLevel: @escaping @MainActor (Float) -> Void,
        onTranscript: @escaping @MainActor (String) -> Void
    ) async throws {
        self.onTranscript = onTranscript
        lastEmitted = nil
        feed = Task { [weak self] in
            var tick = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(80))
                if Task.isCancelled { break }
                tick += 1
                // ~1.2s of "speech" then ~0.6s of silence, with a wobble so
                // adjacent bars differ like real speech.
                let speaking = tick % 22 < 15
                let wobble = Float((1 + sin(Double(tick) * 1.7)) / 2)
                onLevel(speaking ? 0.02 + 0.06 * wobble : 0.001)
                if tick % 9 == 0 {
                    let index = min(tick / 9 - 1, Self.script.count - 1)
                    let text = Self.script[index]
                    self?.lastEmitted = text
                    onTranscript(text)
                }
            }
        }
    }

    func finish() async {
        feed?.cancel()
        feed = nil
        // Re-deliver the last words as the "final" result; stopping before the
        // first word leaves the transcript empty, like a real silent recording.
        if let lastEmitted {
            onTranscript?(lastEmitted)
        }
        onTranscript = nil
    }

    func stop() async {
        feed?.cancel()
        feed = nil
        onTranscript = nil
    }
}
