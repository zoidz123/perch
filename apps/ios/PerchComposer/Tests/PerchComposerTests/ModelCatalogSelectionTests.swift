import XCTest
@testable import PerchComposer

// Mirrors the server's live Claude catalog (frontier-first, versioned labels)
// so the client picker logic is exercised against the exact shape it receives.
private let liveClaudeCatalog: [PickerCatalogOption] = [
    PickerCatalogOption(id: "fable", label: "Fable 5", detail: "1M context"),
    PickerCatalogOption(id: "opus", label: "Opus 4.8", detail: "1M context"),
    PickerCatalogOption(id: "sonnet", label: "Sonnet 5", detail: "1M context"),
    PickerCatalogOption(id: "haiku", label: "Haiku 4.5", detail: "200K context"),
    PickerCatalogOption(id: "best", label: "Best available", detail: nil),
    PickerCatalogOption(id: "opusplan", label: "Opus Plan", detail: nil),
    PickerCatalogOption(id: "fable[1m]", label: "Fable 5", detail: "1M context"),
    PickerCatalogOption(id: "opus[1m]", label: "Opus 4.8", detail: "1M context"),
    PickerCatalogOption(id: "sonnet[1m]", label: "Sonnet 5", detail: "1M context")
]

private func offeredIds(_ options: [PickerCatalogOption]) -> Set<String> {
    Set(options.map(\.id))
}

private func compactRows(_ options: [PickerCatalogOption]) -> [ModelPickerRow] {
    compactVisibleOptions(options).map {
        ModelPickerRow(id: $0.id, label: $0.label, detail: $0.detail, isRemoved: false)
    }
}

final class ModelCatalogSelectionTests: XCTestCase {
    // MARK: - Ordering + labels

    func testCompactPickerSurfacesFableFirstWithVersionedLabels() {
        let visible = compactVisibleOptions(liveClaudeCatalog)
        XCTAssertEqual(visible.map(\.id), ["fable", "opus", "sonnet"])
        XCTAssertEqual(visible.map(\.label), ["Fable 5", "Opus 4.8", "Sonnet 5"])
        // The regression guard: the top row is Fable 5, not "Fable" and not
        // buried behind sonnet.
        XCTAssertEqual(visible.first?.label, "Fable 5")
    }

    func testCompactPickerSkipsHiddenEntries() {
        let options = [
            PickerCatalogOption(id: "fable", label: "Fable 5", hidden: true),
            PickerCatalogOption(id: "opus", label: "Opus 4.8"),
            PickerCatalogOption(id: "sonnet", label: "Sonnet 5"),
            PickerCatalogOption(id: "haiku", label: "Haiku 4.5")
        ]
        XCTAssertEqual(compactVisibleOptions(options).map(\.id), ["opus", "sonnet", "haiku"])
    }

    // MARK: - Selection matching

    func testSelectionMatchesByExactAndNormalizedIdAndLabel() {
        // Exact alias.
        XCTAssertTrue(modelOptionMatches(id: "fable", label: "Fable 5", liveId: "fable", liveLabel: nil))
        // The CLI reports the running model with launch plumbing; "opus[1m]"
        // must still tick the "opus" row.
        XCTAssertTrue(modelOptionMatches(id: "opus", label: "Opus 4.8", liveId: "opus[1m]", liveLabel: nil))
        // A full model id ticks the alias row via the server-resolved label.
        XCTAssertTrue(modelOptionMatches(id: "fable", label: "Fable 5", liveId: "claude-fable-5", liveLabel: "Fable 5"))
        // A genuinely different model does not match.
        XCTAssertFalse(modelOptionMatches(id: "opus", label: "Opus 4.8", liveId: "sonnet", liveLabel: "Sonnet 5"))
    }

    // MARK: - Removed / retained saved selections

    func testSelectionInsideCompactAddsNoRow() {
        let rows = compactModelPickerRows(
            compact: compactRows(liveClaudeCatalog),
            offeredIds: offeredIds(liveClaudeCatalog),
            selectedId: "fable",
            selectedLabel: "Fable 5",
            selectedDetail: "1M context"
        )
        XCTAssertEqual(rows.map(\.id), ["fable", "opus", "sonnet"])
        XCTAssertFalse(rows.contains { $0.isRemoved })
    }

    func testOfferedSelectionOutsideCompactIsRetainedAsNormalRow() {
        // "haiku" is offered but ranks below the top-3; selecting it must keep
        // it visible and un-flagged so the saved choice is preserved.
        let rows = compactModelPickerRows(
            compact: compactRows(liveClaudeCatalog),
            offeredIds: offeredIds(liveClaudeCatalog),
            selectedId: "haiku",
            selectedLabel: "Haiku 4.5",
            selectedDetail: "200K context"
        )
        XCTAssertEqual(rows.map(\.id), ["fable", "opus", "sonnet", "haiku"])
        let haiku = rows.last
        XCTAssertEqual(haiku?.label, "Haiku 4.5")
        XCTAssertEqual(haiku?.detail, "200K context")
        XCTAssertFalse(haiku?.isRemoved ?? true)
    }

    func testRemovedSelectionIsSurfacedAndFlagged() {
        // A saved model the current CLI no longer offers is shown, flagged, with
        // a note - never silently replaced by the default.
        let rows = compactModelPickerRows(
            compact: compactRows(liveClaudeCatalog),
            offeredIds: offeredIds(liveClaudeCatalog),
            selectedId: "claude-legacy-3",
            selectedLabel: "Legacy 3",
            selectedDetail: nil
        )
        XCTAssertEqual(rows.map(\.id), ["fable", "opus", "sonnet", "claude-legacy-3"])
        let removed = rows.last
        XCTAssertEqual(removed?.label, "Legacy 3")
        XCTAssertTrue(removed?.isRemoved ?? false)
        XCTAssertEqual(removed?.detail, "No longer offered by the Claude CLI")
    }

    func testNoSelectionLeavesCompactUnchanged() {
        let rows = compactModelPickerRows(
            compact: compactRows(liveClaudeCatalog),
            offeredIds: offeredIds(liveClaudeCatalog),
            selectedId: nil,
            selectedLabel: "",
            selectedDetail: nil
        )
        XCTAssertEqual(rows.map(\.id), ["fable", "opus", "sonnet"])
    }
}
