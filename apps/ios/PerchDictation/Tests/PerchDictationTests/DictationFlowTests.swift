import XCTest
@testable import PerchDictation

final class DictationFlowTests: XCTestCase {
    // idle -> recording -> stop -> commit lands the transcript exactly once.
    func testHappyPathCommitsTranscriptOnce() {
        var flow = DictationFlow()
        XCTAssertTrue(flow.begin(baseText: ""))
        XCTAssertEqual(flow.phase, .preparing)

        flow.engineDidStart()
        XCTAssertEqual(flow.phase, .recording)

        flow.observe(transcript: "ship the")
        flow.observe(transcript: "ship the redesign")
        XCTAssertTrue(flow.requestStop())
        XCTAssertEqual(flow.phase, .finishing)

        // The finalized tail still lands while finishing.
        flow.observe(transcript: "ship the redesign today")
        XCTAssertEqual(flow.commit(), "ship the redesign today")
        XCTAssertEqual(flow.phase, .idle)

        // Commit is one-shot.
        XCTAssertNil(flow.commit())
    }

    func testTranscriptIsNeverRenderedStateOnlyAccumulates() {
        var flow = DictationFlow()
        _ = flow.begin(baseText: "")
        flow.engineDidStart()
        flow.observe(transcript: "hello")
        XCTAssertEqual(flow.transcript, "hello")
        XCTAssertEqual(flow.phase, .recording)
    }

    func testCancelDiscardsEverything() {
        var flow = DictationFlow()
        _ = flow.begin(baseText: "typed")
        flow.engineDidStart()
        flow.observe(transcript: "spoken words")
        flow.cancel()

        XCTAssertEqual(flow.phase, .idle)
        XCTAssertEqual(flow.transcript, "")
        // A cancelled session can't be committed.
        XCTAssertNil(flow.commit())
    }

    func testCancelWhileFinishingSuppressesCommit() {
        var flow = DictationFlow()
        _ = flow.begin(baseText: "")
        flow.engineDidStart()
        flow.observe(transcript: "spoken")
        _ = flow.requestStop()
        flow.cancel()
        XCTAssertNil(flow.commit())
    }

    func testLateTranscriptAfterCancelIsDropped() {
        var flow = DictationFlow()
        _ = flow.begin(baseText: "")
        flow.engineDidStart()
        flow.cancel()

        flow.observe(transcript: "late callback")
        XCTAssertEqual(flow.transcript, "")
    }

    func testStopBeforeRecordingIsRejected() {
        var flow = DictationFlow()
        XCTAssertFalse(flow.requestStop())
        _ = flow.begin(baseText: "")
        // Still preparing: nothing captured, stop is not a transition.
        XCTAssertFalse(flow.requestStop())
    }

    func testBeginWhileActiveIsRejected() {
        var flow = DictationFlow()
        XCTAssertTrue(flow.begin(baseText: ""))
        XCTAssertFalse(flow.begin(baseText: "again"))
    }

    func testEmptyTranscriptCommitsNothing() {
        var flow = DictationFlow()
        _ = flow.begin(baseText: "keep me")
        flow.engineDidStart()
        _ = flow.requestStop()
        // Nothing heard: the field must stay untouched.
        XCTAssertNil(flow.commit())
        XCTAssertEqual(flow.phase, .idle)
    }

    // MARK: - Merge

    func testMergeIntoEmptyBase() {
        XCTAssertEqual(DictationFlow.merged(base: "", transcript: "hello"), "hello")
        XCTAssertEqual(DictationFlow.merged(base: "   ", transcript: "hello"), "hello")
    }

    func testMergeAppendsWithSeparator() {
        XCTAssertEqual(DictationFlow.merged(base: "fix the bug", transcript: "in the composer"),
                       "fix the bug in the composer")
        // Existing trailing whitespace is respected, not doubled.
        XCTAssertEqual(DictationFlow.merged(base: "fix the bug ", transcript: "now"),
                       "fix the bug now")
    }

    func testCommitMergesOntoBaseTextFromBegin() {
        var flow = DictationFlow()
        _ = flow.begin(baseText: "already typed")
        flow.engineDidStart()
        flow.observe(transcript: "and dictated")
        _ = flow.requestStop()
        XCTAssertEqual(flow.commit(), "already typed and dictated")
    }

    // MARK: - Level meter

    func testDisplayLevelClampsAndMapsMonotonically() {
        XCTAssertEqual(DictationLevelMeter.displayLevel(rms: 0), 0)
        XCTAssertEqual(DictationLevelMeter.displayLevel(rms: 1), 1)
        // Louder RMS never yields a smaller bar.
        let quiet = DictationLevelMeter.displayLevel(rms: 0.005)
        let speech = DictationLevelMeter.displayLevel(rms: 0.05)
        let loud = DictationLevelMeter.displayLevel(rms: 0.5)
        XCTAssertLessThan(quiet, speech)
        XCTAssertLessThan(speech, loud)
        // Below the floor pins to zero rather than going negative.
        XCTAssertEqual(DictationLevelMeter.displayLevel(rms: 0.000_01), 0)
    }

    func testAppendedKeepsNewestWithinCapacity() {
        var history: [Float] = []
        for i in 0..<10 {
            history = DictationLevelMeter.appended(Float(i), to: history, capacity: 4)
        }
        XCTAssertEqual(history, [6, 7, 8, 9])
    }
}
