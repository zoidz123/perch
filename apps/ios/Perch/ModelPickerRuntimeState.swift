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

// One row rendered by a compact model picker. `isRemoved` marks a saved
// selection the CLI no longer offers, so it is shown (never silently dropped)
// but visibly flagged.
struct ModelPickerRow: Equatable, Identifiable {
    let id: String
    let label: String
    let detail: String?
    let isRemoved: Bool
}

// Rows a compact model picker shows for one provider.
//
// `compact` is the catalog's newest-first visible window (the picker's top-N).
// `offeredIds` is every id the CLI currently offers (the full catalog, id and
// runtimeId). `selectedId` is the saved/queued selection with its resolved
// display label/detail.
//
// A selection already in `compact` changes nothing. A selection the CLI still
// offers but that sits outside the compact window is appended as a normal row
// so a valid saved choice stays visible and checkmarkable. A selection the CLI
// no longer offers is appended flagged `isRemoved` with a "no longer offered"
// note, so it is surfaced rather than silently replaced by the default.
func compactModelPickerRows(
    compact: [ModelPickerRow],
    offeredIds: Set<String>,
    selectedId: String?,
    selectedLabel: String,
    selectedDetail: String?
) -> [ModelPickerRow] {
    guard let selectedId, !selectedId.isEmpty else { return compact }
    if compact.contains(where: { $0.id == selectedId }) { return compact }
    let offered = offeredIds.contains(selectedId)
    let row = ModelPickerRow(
        id: selectedId,
        label: selectedLabel,
        detail: offered ? selectedDetail : "No longer offered by the Claude CLI",
        isRemoved: !offered
    )
    return compact + [row]
}
