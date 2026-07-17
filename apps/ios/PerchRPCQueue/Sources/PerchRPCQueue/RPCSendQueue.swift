import Foundation

struct QueuedSocketSend: Equatable {
    let text: String
    let rpcId: String?
}

enum RPCSendQueue {
    static func rpcId(from message: [String: Any]) -> String? {
        guard
            message["type"] as? String == "rpc",
            let id = message["id"] as? String
        else {
            return nil
        }
        return id
    }

    static func flushable(_ queued: [QueuedSocketSend], liveRPCIds: Set<String>) -> [QueuedSocketSend] {
        queued.filter { send in
            guard let rpcId = send.rpcId else {
                return true
            }
            return liveRPCIds.contains(rpcId)
        }
    }

    static func removeRPC(_ rpcId: String, from queued: inout [QueuedSocketSend]) {
        queued.removeAll { $0.rpcId == rpcId }
    }
}
