import Foundation

public struct ChartCardDismissalIdentity: Hashable {
    public let id: String
    public let registeredAt: String
    public let updatedAt: String
    public let snapshotAt: String?

    public init(id: String, registeredAt: String, updatedAt: String, snapshotAt: String?) {
        self.id = id
        self.registeredAt = registeredAt
        self.updatedAt = updatedAt
        self.snapshotAt = snapshotAt
    }

    public var key: String {
        [
            id,
            registeredAt,
            updatedAt,
            snapshotAt ?? "-"
        ].joined(separator: "|")
    }
}
