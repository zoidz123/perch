import Foundation

// The Mate's pinned-row subtitle is stable product identity. Prompt-delivery
// diagnostics belong to their dedicated surfaces and never replace this copy.
public enum MateRowPresentation {
    public static func subtitle(
        promptDeliveryWarning _: String?,
        promptDeliveryResolution _: String?
    ) -> String {
        "Runs the crew for you"
    }
}
