import Foundation

enum PresentedServerAvailability: Equatable {
    case online
    case offline
}

struct ConnectionStatusHysteresis {
    private(set) var presentedAvailability: PresentedServerAvailability
    private(set) var offlineDeadline: TimeInterval?
    let offlineDelay: TimeInterval

    init(
        initialAvailability: PresentedServerAvailability = .online,
        offlineDelay: TimeInterval = 2
    ) {
        presentedAvailability = initialAvailability
        self.offlineDelay = offlineDelay
    }

    @discardableResult
    mutating func observe(isLive: Bool, at now: TimeInterval) -> Bool {
        if isLive {
            offlineDeadline = nil
            guard presentedAvailability != .online else { return false }
            presentedAvailability = .online
            return true
        }

        guard presentedAvailability == .online else {
            offlineDeadline = nil
            return false
        }
        if offlineDeadline == nil {
            offlineDeadline = now + offlineDelay
        }
        return false
    }

    @discardableResult
    mutating func advance(to now: TimeInterval) -> Bool {
        guard let offlineDeadline, now >= offlineDeadline else { return false }
        self.offlineDeadline = nil
        guard presentedAvailability != .offline else { return false }
        presentedAvailability = .offline
        return true
    }
}
