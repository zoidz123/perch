import Foundation

// Per-session value buffers for composer-owned state such as staged
// attachments. The app compiles the same file from apps/ios/Perch so navigation
// can switch the selected session without moving unsent state between chats.
public struct SessionScopedValues<Value> {
    private var valuesBySession: [String: [Value]] = [:]

    public init() {}

    public func values(for sessionId: String?) -> [Value] {
        guard let sessionId else { return [] }
        return valuesBySession[sessionId] ?? []
    }

    public mutating func replace(_ values: [Value], for sessionId: String) {
        if values.isEmpty {
            valuesBySession.removeValue(forKey: sessionId)
        } else {
            valuesBySession[sessionId] = values
        }
    }

    public mutating func append(_ value: Value, for sessionId: String) {
        valuesBySession[sessionId, default: []].append(value)
    }

    public mutating func removeAll(for sessionId: String, where shouldRemove: (Value) -> Bool) {
        guard var values = valuesBySession[sessionId] else { return }
        values.removeAll(where: shouldRemove)
        replace(values, for: sessionId)
    }
}
