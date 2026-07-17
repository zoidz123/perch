import Foundation

// Per-session composer drafts:
// drafts are scoped to one session (never leak between chats), survive app
// restarts, are cleared on successful send, and restored on send failure.
// UserDefaults is plenty at this scale; writes are debounced by the caller
// (SwiftUI binding cadence) and the map is pruned to a small cap.
enum DraftStore {
    private static let key = "perch.drafts.v1"
    private static let maxEntries = 50

    static func draft(for sessionId: String) -> String {
        load()[sessionId] ?? ""
    }

    static func save(_ text: String, for sessionId: String) {
        var drafts = load()
        if text.isEmpty {
            drafts.removeValue(forKey: sessionId)
        } else {
            drafts[sessionId] = text
        }
        // Cap growth: drop arbitrary overflow entries (ended sessions).
        while drafts.count > maxEntries, let victim = drafts.keys.first {
            drafts.removeValue(forKey: victim)
        }
        UserDefaults.standard.set(drafts, forKey: key)
    }

    static func clear(for sessionId: String) {
        save("", for: sessionId)
    }

    private static func load() -> [String: String] {
        UserDefaults.standard.dictionary(forKey: key) as? [String: String] ?? [:]
    }
}

// Client-side attention tracking:
// a session that finished working since the user last looked shows a green
// attention dot until one of the clearing triggers fires (opening the
// session, focusing the composer, sending). Permission attention is NOT
// tracked here - it clears only when the prompt resolves.
enum SeenStore {
    private static let key = "perch.lastSeen.v1"
    private static let maxEntries = 100

    static func lastSeen(_ sessionId: String) -> Date? {
        (UserDefaults.standard.dictionary(forKey: key) as? [String: Double])
            .flatMap { $0[sessionId] }
            .map { Date(timeIntervalSince1970: $0) }
    }

    static func markSeen(_ sessionId: String) {
        var seen = (UserDefaults.standard.dictionary(forKey: key) as? [String: Double]) ?? [:]
        seen[sessionId] = Date().timeIntervalSince1970
        while seen.count > maxEntries, let victim = seen.keys.first {
            seen.removeValue(forKey: victim)
        }
        UserDefaults.standard.set(seen, forKey: key)
    }
}
