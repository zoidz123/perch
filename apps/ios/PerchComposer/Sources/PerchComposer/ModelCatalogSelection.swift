import Foundation

// Pure model-catalog selection logic, mirrored verbatim from the iOS app
// (Models.swift, ModelPickerRuntimeState.swift, ComposerControls.swift) so it
// can be exercised under `swift test` without a simulator. The app owns the
// shipped copies; keep this in sync when they change.
//
// The server (apps/server/src/models.ts) is the source of truth for WHICH
// Claude models exist and their order (newest-first) - it queries the installed
// Claude CLI's `/model` aliases. This client-side logic only decides which of
// those the compact picker shows and how a saved selection maps onto them.

// A minimal picker option: the launch id plus its display fields.
public struct PickerCatalogOption: Equatable {
    public let id: String
    public let label: String
    public let detail: String?
    public let hidden: Bool

    public init(id: String, label: String, detail: String? = nil, hidden: Bool = false) {
        self.id = id
        self.label = label
        self.detail = detail
        self.hidden = hidden
    }
}

// The compact picker window: the catalog's newest-first visible entries capped
// at `limit`. Ordering is the server's; the client only trims.
public func compactVisibleOptions(_ options: [PickerCatalogOption], limit: Int = 3) -> [PickerCatalogOption] {
    Array(options.filter { !$0.hidden }.prefix(limit))
}

// Strip the launch plumbing a CLI reports but the catalog omits: the "[1m]"
// context-window opt-in and "-YYYYMMDD" date pins.
public func normalizedModelId(_ rawId: String) -> String {
    rawId
        .replacingOccurrences(of: #"\[[^\]]*\]"#, with: "", options: .regularExpression)
        .trimmingCharacters(in: .whitespaces)
        .replacingOccurrences(of: #"-\d{8}$"#, with: "", options: .regularExpression)
        .lowercased()
}

// Does `option` name the model a session is actually running? Matches by exact
// id, then normalized id (so "opus[1m]" ticks "opus"), then the server-resolved
// live label (so a full id like "claude-fable-5" ticks the "fable" row).
public func modelOptionMatches(id optionId: String, label optionLabel: String, liveId: String?, liveLabel: String?) -> Bool {
    guard let liveId else { return false }
    if optionId == liveId { return true }
    if normalizedModelId(optionId) == normalizedModelId(liveId) { return true }
    if let liveLabel, !liveLabel.isEmpty, optionLabel == liveLabel { return true }
    return false
}

// One row rendered by a compact model picker. `isRemoved` marks a saved
// selection the CLI no longer offers.
public struct ModelPickerRow: Equatable, Identifiable {
    public let id: String
    public let label: String
    public let detail: String?
    public let isRemoved: Bool

    public init(id: String, label: String, detail: String?, isRemoved: Bool) {
        self.id = id
        self.label = label
        self.detail = detail
        self.isRemoved = isRemoved
    }
}

// Rows a compact model picker shows for one provider.
//
// A selection already in `compact` changes nothing. A selection the CLI still
// offers but that sits outside the compact window is appended as a normal row
// so a valid saved choice stays visible and checkmarkable. A selection the CLI
// no longer offers is appended flagged `isRemoved` so it is surfaced rather
// than silently replaced by the default.
public func compactModelPickerRows(
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
