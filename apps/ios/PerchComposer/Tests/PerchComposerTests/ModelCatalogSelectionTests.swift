import XCTest
@testable import PerchComposer

// Mirrors the server's live Claude catalog (frontier-first, versioned labels).
// Only the hardcoded fable/opus/sonnet trio is visible; the meta-aliases
// (`best`/`opusplan`), haiku, and the `[1m]` opt-ins arrive marked hidden so
// they stay resolvable but are never offered for selection.
private let liveClaudeCatalog: [PickerCatalogOption] = [
    PickerCatalogOption(id: "fable", label: "Fable 5", detail: "1M context"),
    PickerCatalogOption(id: "opus", label: "Opus 4.8", detail: "1M context"),
    PickerCatalogOption(id: "sonnet", label: "Sonnet 5", detail: "1M context"),
    PickerCatalogOption(id: "haiku", label: "Haiku 4.5", detail: "200K context", hidden: true),
    PickerCatalogOption(id: "best", label: "Best available", detail: "Latest highest-capability Claude model", hidden: true),
    PickerCatalogOption(id: "opusplan", label: "Opus Plan", detail: "Uses Opus in plan mode, Sonnet otherwise", hidden: true),
    PickerCatalogOption(id: "fable[1m]", label: "Fable 5 (1M)", detail: "1M context", hidden: true),
    PickerCatalogOption(id: "opus[1m]", label: "Opus 4.8 (1M)", detail: "1M context", hidden: true),
    PickerCatalogOption(id: "sonnet[1m]", label: "Sonnet 5 (1M)", detail: "1M context", hidden: true)
]

// Codex fixture: frontier-first; models outside the visible gpt-5.6 trio
// arrive hidden, mirroring the server's hardcoded visible set.
private let liveCodexCatalog: [PickerCatalogOption] = [
    PickerCatalogOption(id: "gpt-5.6-sol", label: "GPT 5.6 Sol"),
    PickerCatalogOption(id: "gpt-5.6-terra", label: "GPT 5.6 Terra"),
    PickerCatalogOption(id: "gpt-5.6-luna", label: "GPT 5.6 Luna"),
    PickerCatalogOption(id: "gpt-5.5", label: "GPT 5.5", hidden: true),
    PickerCatalogOption(id: "gpt-5.4", label: "GPT 5.4", hidden: true)
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
    // MARK: - Ordering + labels (compact)

    func testClaudePickerSurfacesFableFirstWithVersionedLabelsAndStaysCompact() {
        let visible = compactVisibleOptions(liveClaudeCatalog)
        // Exactly the three newest, frontier-first: Fable 5 leads (never
        // "Fable" and never buried behind sonnet), with correct 1M-context
        // detail. The `[1m]` variants and meta-aliases are not surfaced.
        XCTAssertEqual(visible.map(\.id), ["fable", "opus", "sonnet"])
        XCTAssertEqual(visible.map(\.label), ["Fable 5", "Opus 4.8", "Sonnet 5"])
        XCTAssertEqual(visible.first?.detail, "1M context")
        XCTAssertFalse(visible.contains { $0.id.contains("[1m]") }, "compact picker must not surface [1m] variants")
    }

    func testCodexPickerAlsoStaysCompactThreeNewest() {
        // Codex behavior is unchanged: still the three newest.
        let visible = compactVisibleOptions(liveCodexCatalog)
        XCTAssertEqual(visible.map(\.id), ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])
    }

    func testPickerSkipsHiddenEntries() {
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
        XCTAssertTrue(modelOptionMatches(id: "fable", label: "Fable 5", liveId: "fable", liveLabel: nil))
        // The CLI reports the running model with launch plumbing; "opus[1m]"
        // must still tick the "opus" row.
        XCTAssertTrue(modelOptionMatches(id: "opus", label: "Opus 4.8", liveId: "opus[1m]", liveLabel: nil))
        // A full model id ticks the alias row via the server-resolved label.
        XCTAssertTrue(modelOptionMatches(id: "fable", label: "Fable 5", liveId: "claude-fable-5", liveLabel: "Fable 5"))
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
        // "haiku" is offered but ranks below the compact three; selecting it
        // must keep it visible and un-flagged so the saved choice is preserved.
        let rows = compactModelPickerRows(
            compact: compactRows(liveClaudeCatalog),
            offeredIds: offeredIds(liveClaudeCatalog),
            selectedId: "haiku",
            selectedLabel: "Haiku 4.5",
            selectedDetail: "200K context"
        )
        XCTAssertEqual(rows.map(\.id), ["fable", "opus", "sonnet", "haiku"])
        XCTAssertFalse(rows.last?.isRemoved ?? true)
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
