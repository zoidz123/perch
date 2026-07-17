import Foundation

struct ChartCardDismissalIdentity: Hashable {
    let id: String
    let registeredAt: String
    let updatedAt: String
    let snapshotAt: String?

    var key: String {
        [
            id,
            registeredAt,
            updatedAt,
            snapshotAt ?? "-"
        ].joined(separator: "|")
    }
}
