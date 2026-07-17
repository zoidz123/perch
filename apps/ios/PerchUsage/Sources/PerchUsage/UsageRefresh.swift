import Foundation

public struct UsageWindow: Codable, Equatable, Sendable {
    public let kind: String
    public let percentUsed: Double
    public let resetsAt: String
    public let windowMinutes: Int?

    public init(kind: String, percentUsed: Double, resetsAt: String, windowMinutes: Int?) {
        self.kind = kind
        self.percentUsed = percentUsed
        self.resetsAt = resetsAt
        self.windowMinutes = windowMinutes
    }

    public var percentRemaining: Double { max(0, min(100, 100 - percentUsed)) }

    public var normalizedKind: String {
        if windowMinutes == 300 { return "session" }
        if windowMinutes == 10_080 { return "week" }
        return kind
    }
}

public struct UsageCredits: Codable, Equatable, Sendable {
    public let usedDollars: Double?
    public let limitDollars: Double?
    public let remainingDollars: Double?

    public init(usedDollars: Double?, limitDollars: Double?, remainingDollars: Double?) {
        self.usedDollars = usedDollars
        self.limitDollars = limitDollars
        self.remainingDollars = remainingDollars
    }
}

public struct ProviderUsage: Codable, Equatable, Identifiable, Sendable {
    public var id: String { provider }
    public let provider: String
    public let available: Bool
    public let note: String?
    public let plan: String?
    public let windows: [UsageWindow]
    public let credits: UsageCredits?
    public let source: String?
    public let stale: Bool?
    public let asOf: String?

    public init(
        provider: String,
        available: Bool,
        note: String? = nil,
        plan: String? = nil,
        windows: [UsageWindow],
        credits: UsageCredits? = nil,
        source: String? = nil,
        stale: Bool? = nil,
        asOf: String? = nil
    ) {
        self.provider = provider
        self.available = available
        self.note = note
        self.plan = plan
        self.windows = windows
        self.credits = credits
        self.source = source
        self.stale = stale
        self.asOf = asOf
    }

    public func window(_ kind: String) -> UsageWindow? {
        windows.first { $0.normalizedKind == kind }
    }
}

public struct UsageResponse: Codable, Equatable, Sendable {
    public let at: String
    public let providers: [ProviderUsage]

    public init(at: String, providers: [ProviderUsage]) {
        self.at = at
        self.providers = providers
    }
}

public enum UsageFetchTrigger: Equatable, Sendable {
    case automatic
    case sheetOpened
    case manualRefresh
}

public enum UsageTransportReadiness: Equatable, Sendable {
    case direct
    case relayWaitingForEncryptedChannel
    case relayReady
}

public struct UsageLoadState: Equatable, Sendable {
    public var usage: UsageResponse?
    public var isLoading = false
    public var errorMessage: String?
    public var lastUpdatedAt: String?
    public var isShowingStaleData = false

    public init(usage: UsageResponse? = nil) {
        self.usage = usage
        self.lastUpdatedAt = usage.map(Self.displayTimestamp)
        self.isShowingStaleData = usage?.providers.contains { $0.stale == true } ?? false
    }

    private static func displayTimestamp(for usage: UsageResponse) -> String {
        let staleProviderTimestamps = usage.providers.compactMap { provider in
            provider.stale == true ? provider.asOf : nil
        }
        return staleProviderTimestamps.min() ?? usage.at
    }
}

@MainActor
public final class UsageRefreshCoordinator {
    public typealias Request = () async throws -> UsageResponse

    public private(set) var state: UsageLoadState
    public private(set) var requestCount = 0
    public var hasPendingRequest: Bool { pendingTrigger != nil }
    private let request: Request
    private var pendingTrigger: UsageFetchTrigger?

    public init(initialUsage: UsageResponse? = nil, request: @escaping Request) {
        state = UsageLoadState(usage: initialUsage)
        self.request = request
    }

    public func refresh(trigger: UsageFetchTrigger, transport: UsageTransportReadiness) async {
        if transport == .relayWaitingForEncryptedChannel {
            pendingTrigger = trigger
            return
        }
        await performRequest()
    }

    public func encryptedChannelDidBecomeReady() async {
        guard pendingTrigger != nil else { return }
        pendingTrigger = nil
        await performRequest()
    }

    public func reset() {
        state = UsageLoadState()
        pendingTrigger = nil
    }

    private func performRequest() async {
        guard !state.isLoading else { return }
        state.isLoading = true
        state.errorMessage = nil
        defer { state.isLoading = false }
        requestCount += 1

        do {
            let response = try await request()
            state.usage = response
            state.lastUpdatedAt = UsageLoadState(usage: response).lastUpdatedAt
            state.isShowingStaleData = response.providers.contains { $0.stale == true }
        } catch is CancellationError {
            return
        } catch {
            state.errorMessage = "Couldn’t refresh usage. Check your connection and try again."
            state.isShowingStaleData = state.usage != nil
        }
    }
}
