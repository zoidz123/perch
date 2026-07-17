import Foundation

// Pairing offer v1, mirrored from packages/shared (PairingOffer). Encoded as
// base64url JSON in perch://pair#offer=... QR codes printed by `perch pair`.
// `pk` is reserved for the v2 end-to-end encrypted channel.
struct PairingOffer: Codable, Equatable {
    let v: Int
    let serverId: String
    let name: String
    let endpoints: [String]
    let token: String
    let pk: String?
}

enum PairingError: LocalizedError {
    case unrecognizedOffer
    case unsupportedVersion(Int)
    case noReachableEndpoint([String])

    var errorDescription: String? {
        switch self {
        case .unrecognizedOffer:
            "That doesn't look like a Perch pairing code. Run `perch pair` on your Mac and scan the QR."
        case let .unsupportedVersion(version):
            "This pairing code is version \(version); update the Perch app to use it."
        case let .noReachableEndpoint(endpoints):
            "Couldn't reach your Mac at \(endpoints.joined(separator: ", ")). Make sure the phone and Mac share a network."
        }
    }
}

enum PairingOfferParser {
    // Accepts the QR/URL text in any of the shapes a user might paste:
    // perch://pair#offer=..., a bare offer=... fragment, or raw base64url JSON.
    static func parse(_ text: String) throws -> PairingOffer {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw PairingError.unrecognizedOffer
        }

        var candidate = trimmed
        if let range = candidate.range(of: "offer=") {
            candidate = String(candidate[range.upperBound...])
        }
        if let ampersand = candidate.firstIndex(of: "&") {
            candidate = String(candidate[..<ampersand])
        }

        guard let data = decodeBase64URL(candidate) else {
            throw PairingError.unrecognizedOffer
        }
        guard let offer = try? JSONDecoder().decode(PairingOffer.self, from: data) else {
            throw PairingError.unrecognizedOffer
        }
        guard offer.v == 1 else {
            throw PairingError.unsupportedVersion(offer.v)
        }
        // A structurally valid but unusable offer must fail here rather than
        // half-pair: it needs a token and at least one http(s) endpoint.
        guard !offer.token.isEmpty, !offer.endpoints.isEmpty else {
            throw PairingError.unrecognizedOffer
        }
        guard offer.endpoints.allSatisfy(isHTTPEndpoint) else {
            throw PairingError.unrecognizedOffer
        }
        return offer
    }

    private static func isHTTPEndpoint(_ endpoint: String) -> Bool {
        guard let url = URL(string: endpoint), let scheme = url.scheme?.lowercased() else {
            return false
        }
        return scheme == "http" || scheme == "https"
    }

    private static func decodeBase64URL(_ text: String) -> Data? {
        var base64 = text
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 {
            base64.append("=")
        }
        return Data(base64Encoded: base64)
    }
}

// Probes every offered endpoint in parallel and returns them fastest-first,
// with directly reachable endpoints preferred over relay endpoints when both
// are reachable. The relay is reachability fallback, not a REST base.
enum EndpointProber {
    static func reachableEndpoints(_ endpoints: [SavedEndpoint], timeout: TimeInterval = 3) async -> [SavedEndpoint] {
        await withTaskGroup(of: (SavedEndpoint, TimeInterval)?.self) { group in
            for endpoint in endpoints {
                group.addTask {
                    await probe(endpoint, timeout: timeout)
                }
            }

            var results: [(SavedEndpoint, TimeInterval)] = []
            for await result in group {
                if let result {
                    results.append(result)
                }
            }
            let sorted = results.sorted { $0.1 < $1.1 }.map(\.0)
            let direct = sorted.filter { !$0.isRelay }
            let relay = sorted.filter(\.isRelay)
            return direct.isEmpty ? relay : direct + relay
        }
    }

    private static func probe(_ endpoint: SavedEndpoint, timeout: TimeInterval) async -> (SavedEndpoint, TimeInterval)? {
        guard let base = URL(string: endpoint.url), let url = URL(string: "/health", relativeTo: base) else {
            return nil
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        let started = Date()

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                return nil
            }
            return (endpoint, Date().timeIntervalSince(started))
        } catch {
            return nil
        }
    }
}
