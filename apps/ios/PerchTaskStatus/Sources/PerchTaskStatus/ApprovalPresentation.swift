import Foundation

public enum ApprovalPresentation {
    public static func contextLine(tool: String?, app: String?) -> String? {
        let values: [String] = [tool, app].compactMap { value -> String? in
            guard let value, !value.isEmpty else { return nil }
            return value
        }
        return values.isEmpty ? nil : values.joined(separator: " · ")
    }

    public static func persistenceHint(_ persistence: String?) -> String? {
        switch persistence {
        case "turn": "This request only"
        case "session": "Remember for this session"
        case "always": "Remember for future calls"
        default: nil
        }
    }

    public static func submittedLabel(_ decision: String, advertised: [(String, String)]) -> String {
        if let label = advertised.first(where: { $0.0 == decision })?.1 { return label }
        switch decision {
        case "allow": return "Allow"
        case "deny": return "Deny"
        default: return "Response"
        }
    }
}
