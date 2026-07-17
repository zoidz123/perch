import SwiftUI
import UIKit
import UserNotifications

// Remote-notification plumbing: registers with APNs once paired, forwards the
// device token to the perch server, and turns lock-screen actions into real
// approve/deny calls. The server pushes by conversation: mate messages (one
// "mate" thread across mate restarts), needs-approval (actionable buttons,
// threaded per session), and solo turn-done/error moments (one thread per
// session) - the thread-id rides in the APNs payload, so grouping is
// server-driven and needs no client work beyond the declared categories.
// Main-actor bound: the SwiftUI adaptor installs it on the main thread and
// UNUserNotificationCenter delivers on the main queue (set as delegate there).
@MainActor
final class PushCoordinator: NSObject, UIApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {
    // Set by PerchApp at launch; used to route actions and suppress banners
    // for the session the user is already looking at.
    weak var store: PerchStore?

    static let approvalCategory = "PERCH_APPROVAL"
    static let approvalChoicesCategory = "PERCH_APPROVAL_CHOICES"
    static let infoCategory = "PERCH_INFO"
    // Mate messages: no custom actions yet (a tap deep-opens the mate chat,
    // same as info), declared so lock-screen reply actions can attach later
    // without a server change.
    static let mateCategory = "PERCH_MATE"

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self

        let approveAction = UNNotificationAction(
            identifier: "PERCH_APPROVE", title: "Approve", options: [.authenticationRequired]
        )
        let deny = UNNotificationAction(
            identifier: "PERCH_DENY", title: "Deny", options: [.destructive, .authenticationRequired]
        )
        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: Self.approvalCategory,
                actions: [approveAction, deny],
                intentIdentifiers: [],
                options: []
            ),
            UNNotificationCategory(
                identifier: Self.approvalChoicesCategory, actions: [], intentIdentifiers: [], options: []
            ),
            UNNotificationCategory(
                identifier: Self.infoCategory, actions: [], intentIdentifiers: [], options: []
            ),
            UNNotificationCategory(
                identifier: Self.mateCategory, actions: [], intentIdentifiers: [], options: []
            )
        ])
        return true
    }

    // Called by the store once pairing exists (asking for notification
    // permission before the app is even paired would be noise).
    static func registerIfAuthorizedOrAsk() {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .notDetermined:
                center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
                    if granted {
                        Task { @MainActor in
                            UIApplication.shared.registerForRemoteNotifications()
                        }
                    }
                }
            case .authorized, .provisional, .ephemeral:
                Task { @MainActor in
                    UIApplication.shared.registerForRemoteNotifications()
                }
            default:
                break
            }
        }
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor [weak self] in
            await self?.store?.registerPushToken(token)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        print("push: APNs registration failed: \(error.localizedDescription)")
    }

    // Foreground delivery: stay quiet only for the session already on screen.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let sessionId = notification.request.content.userInfo["sessionId"] as? String
        Task { @MainActor [weak self] in
            if let sessionId, self?.store?.openSessionRef?.id == sessionId {
                completionHandler([])
            } else {
                completionHandler([.banner, .sound])
            }
        }
    }

    // Taps open the session; Approve/Deny act without opening the app.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let sessionId = userInfo["sessionId"] as? String
        let action = response.actionIdentifier

        Task { @MainActor [weak self] in
            guard let store = self?.store, let sessionId else {
                completionHandler()
                return
            }
            switch action {
            case "PERCH_APPROVE":
                await store.approve(sessionId, decision: "allow", approvalId: nil)
            case "PERCH_DENY":
                await store.approve(sessionId, decision: "deny", approvalId: nil)
            default:
                // Plain tap: deep-open the session.
                await store.openSession(sessionId)
            }
            completionHandler()
        }
    }
}
