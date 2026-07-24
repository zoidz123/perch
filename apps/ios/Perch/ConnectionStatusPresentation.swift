import Foundation

enum PresentedServerAvailability: Equatable {
    case connecting
    case online
    case offline

    var showsFreshServerData: Bool {
        self == .online
    }

    var permitsServerActions: Bool {
        self == .online
    }
}

enum ServerSnapshotSurfaceState: Equatable {
    case placeholders
    case content
    case offlineRetry
}

extension PresentedServerAvailability {
    var snapshotSurfaceState: ServerSnapshotSurfaceState {
        switch self {
        case .connecting: .placeholders
        case .online: .content
        case .offline: .offlineRetry
        }
    }
}

enum FleetReconciliationScope: Int, Equatable {
    case partial
    case full
}

struct FleetReconciliationQueue {
    private(set) var active: FleetReconciliationScope?
    private(set) var pending: FleetReconciliationScope?

    mutating func request(_ scope: FleetReconciliationScope) -> Bool {
        guard active != nil else {
            self.active = scope
            return true
        }
        if scope.rawValue > (pending?.rawValue ?? -1) {
            pending = scope
        }
        return false
    }

    mutating func complete() -> FleetReconciliationScope? {
        active = pending
        pending = nil
        return active
    }

    mutating func reset() {
        active = nil
        pending = nil
    }
}

struct FleetReconciliationThrottle {
    let minimumInterval: TimeInterval

    func delaySinceLastStart(_ lastStart: Date, now: Date) -> TimeInterval {
        max(0, minimumInterval - now.timeIntervalSince(lastStart))
    }
}

enum ConnectionReadinessEvidence: Equatable {
    case directBootstrap
    case encryptedChannel
    case authenticatedFleetSnapshot
}

// The transport is not the product readiness signal. In particular, a relay
// socket and its E2EE ack can both exist before the server has authenticated
// the client and supplied an authoritative fleet snapshot.
struct ConnectionStatusHysteresis {
    private(set) var presentedAvailability: PresentedServerAvailability
    private(set) var readinessDeadline: TimeInterval?
    let readinessTimeout: TimeInterval

    init(
        initialAvailability: PresentedServerAvailability = .connecting,
        readinessTimeout: TimeInterval = 8
    ) {
        presentedAvailability = initialAvailability
        self.readinessTimeout = readinessTimeout
    }

    @discardableResult
    mutating func beginConnecting(at now: TimeInterval) -> Bool {
        // The cold-launch and foreground paths can overlap. They share the
        // same pending readiness window instead of pushing its deadline out or
        // replacing a socket that is already connecting.
        if presentedAvailability == .connecting, readinessDeadline != nil {
            return false
        }

        let changed = presentedAvailability != .connecting
        presentedAvailability = .connecting
        readinessDeadline = now + readinessTimeout
        return changed
    }

    @discardableResult
    mutating func observe(_ evidence: ConnectionReadinessEvidence) -> Bool {
        switch evidence {
        case .encryptedChannel:
            // An e2ee_ready ack proves only that the relay handshake reached
            // the Mac. It is not authenticated fleet data.
            return false
        case .directBootstrap, .authenticatedFleetSnapshot:
            readinessDeadline = nil
            guard presentedAvailability != .online else { return false }
            presentedAvailability = .online
            return true
        }
    }

    @discardableResult
    mutating func advance(to now: TimeInterval) -> Bool {
        guard let readinessDeadline, now >= readinessDeadline else { return false }
        self.readinessDeadline = nil
        guard presentedAvailability == .connecting else { return false }
        guard presentedAvailability != .offline else { return false }
        presentedAvailability = .offline
        return true
    }
}
