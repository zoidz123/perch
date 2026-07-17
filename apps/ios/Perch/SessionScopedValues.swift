import Foundation

// Per-session value buffers for composer-owned state such as staged
// attachments. The app compiles this same helper directly; PerchComposer runs
// focused unit tests for the ownership rules under `swift test` on macOS.
struct SessionScopedValues<Value> {
    private var valuesBySession: [String: [Value]] = [:]

    func values(for sessionId: String?) -> [Value] {
        guard let sessionId else { return [] }
        return valuesBySession[sessionId] ?? []
    }

    mutating func replace(_ values: [Value], for sessionId: String) {
        if values.isEmpty {
            valuesBySession.removeValue(forKey: sessionId)
        } else {
            valuesBySession[sessionId] = values
        }
    }

    mutating func append(_ value: Value, for sessionId: String) {
        valuesBySession[sessionId, default: []].append(value)
    }

    mutating func removeAll(for sessionId: String, where shouldRemove: (Value) -> Bool) {
        guard var values = valuesBySession[sessionId] else { return }
        values.removeAll(where: shouldRemove)
        replace(values, for: sessionId)
    }
}
