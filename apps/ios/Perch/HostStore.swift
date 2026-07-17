import Foundation
import Security

enum SavedEndpointKind: String, Codable {
    case direct
    case relay
}

struct SavedEndpoint: Codable, Equatable {
    var kind: SavedEndpointKind
    var url: String
    var serverId: String?
    var pk: String?

    var isRelay: Bool { kind == .relay }

    static func fromOffer(_ endpoint: String, serverId: String, pk: String?) -> SavedEndpoint? {
        guard let url = URL(string: endpoint), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            return nil
        }
        if isRelayURL(url) {
            return SavedEndpoint(kind: .relay, url: endpoint, serverId: serverId, pk: pk)
        }
        return SavedEndpoint(kind: .direct, url: endpoint, serverId: nil, pk: nil)
    }

    static func legacy(_ endpoint: String, serverId: String? = nil, pk: String? = nil) -> SavedEndpoint {
        if let url = URL(string: endpoint), isRelayURL(url) {
            return SavedEndpoint(kind: .relay, url: endpoint, serverId: serverId, pk: pk)
        }
        return SavedEndpoint(kind: .direct, url: endpoint, serverId: nil, pk: nil)
    }

    private static func isRelayURL(_ url: URL) -> Bool {
        guard url.path == "/ws", let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return false
        }
        let items = components.queryItems ?? []
        return items.contains { $0.name == "role" && $0.value == "client" }
            && items.contains { $0.name == "serverId" && !($0.value ?? "").isEmpty }
    }
}

// A paired Mac. Metadata lives in UserDefaults; the device token lives in the
// Keychain, keyed by serverId.
struct SavedHost: Codable, Equatable {
    let serverId: String
    var name: String
    var endpoints: [SavedEndpoint]
    var activeEndpoint: SavedEndpoint
    // The server's long-term box public key (base64), from the pairing offer's
    // `pk`. Optional and decoded leniently so hosts paired before the encrypted
    // transport existed keep loading; its presence switches the socket to E2E.
    var pk: String?

    private enum CodingKeys: String, CodingKey {
        case serverId
        case name
        case endpoints
        case activeEndpoint
        case pk
    }

    init(serverId: String, name: String, endpoints: [SavedEndpoint], activeEndpoint: SavedEndpoint, pk: String?) {
        self.serverId = serverId
        self.name = name
        self.endpoints = endpoints
        self.activeEndpoint = activeEndpoint
        self.pk = pk
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let decodedServerId = try container.decode(String.self, forKey: .serverId)
        let decodedName = try container.decode(String.self, forKey: .name)
        let decodedPk = try container.decodeIfPresent(String.self, forKey: .pk)

        var decodedEndpoints: [SavedEndpoint]
        if let typed = try? container.decode([SavedEndpoint].self, forKey: .endpoints) {
            decodedEndpoints = typed
        } else {
            let legacy = try container.decode([String].self, forKey: .endpoints)
            decodedEndpoints = legacy.map { SavedEndpoint.legacy($0, serverId: decodedServerId, pk: decodedPk) }
        }

        let decodedActive: SavedEndpoint
        if let typed = try? container.decode(SavedEndpoint.self, forKey: .activeEndpoint) {
            decodedActive = typed
        } else {
            let legacy = try container.decode(String.self, forKey: .activeEndpoint)
            decodedActive = SavedEndpoint.legacy(legacy, serverId: decodedServerId, pk: decodedPk)
        }

        if !decodedEndpoints.contains(decodedActive) {
            decodedEndpoints.insert(decodedActive, at: 0)
        }

        serverId = decodedServerId
        name = decodedName
        endpoints = decodedEndpoints
        activeEndpoint = decodedActive
        pk = decodedPk
    }
}

enum HostStore {
    private static let hostKey = "perch.savedHost.v1"

    static func load() -> SavedHost? {
        guard
            let data = UserDefaults.standard.data(forKey: hostKey),
            let host = try? JSONDecoder().decode(SavedHost.self, from: data)
        else {
            return nil
        }
        return host
    }

    static func save(_ host: SavedHost) {
        if let data = try? JSONEncoder().encode(host) {
            UserDefaults.standard.set(data, forKey: hostKey)
        }
    }

    static func clear(serverId: String?) {
        UserDefaults.standard.removeObject(forKey: hostKey)
        if let serverId {
            Keychain.delete(account: serverId)
        }
    }
}

enum Keychain {
    private static let service = "sh.perch.device-token"

    static func saveToken(_ token: String, account: String) {
        let data = Data(token.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let attributes: [String: Any] = [kSecValueData as String: data]

        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert[kSecValueData as String] = data
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(insert as CFDictionary, nil)
        }
    }

    static func token(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    static func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
    }
}
