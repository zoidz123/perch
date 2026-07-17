import SwiftUI

@main
struct PerchApp: App {
    @UIApplicationDelegateAdaptor(PushCoordinator.self) private var pushCoordinator

    var body: some Scene {
        WindowGroup {
            ContentView(pushCoordinator: pushCoordinator)
                .preferredColorScheme(.dark)
        }
    }
}
