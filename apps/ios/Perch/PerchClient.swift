import Foundation
import PerchUsage

@MainActor
final class PerchStore: ObservableObject {
    @Published var serverURL = "http://127.0.0.1:8787"
    @Published var token = ""
    @Published var savedHost: SavedHost?
    @Published var sessions: [AgentSession] = [] {
        didSet {
            sessionsById = Dictionary(sessions.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        }
    }
    @Published private(set) var sessionsById: [String: AgentSession] = [:]
    @Published var tasks: [AgentTask] = [] {
        didSet {
            // A live authoritative generation settles any local recovery
            // affordance. Transport loss never enters this path.
            for task in tasks where task.runtime?.state == "live" {
                recoveryActions.removeValue(forKey: task.id)
            }
        }
    }
    @Published private(set) var recoveryActions: [String: RecoveryActionState] = [:]
    // The mate's known projects (GET /projects, server recency order): the
    // Workspace panel renders these as the mate's scope even when idle.
    @Published var projects: [Project] = []
    // Freshly answered questions by session, so the chat's question chip can
    // collapse to the chosen answers until the conversation moves on.
    @Published var answeredQuestions: [String: AnsweredQuestion] = [:]
    // Freshly answered no-mistakes gates by task id, so the decision chip can
    // collapse to what was sent until the worker resumes (state leaves
    // needs_you). Local by design, like answeredQuestions.
    @Published var sentDecisions: [String: String] = [:]
    // The session whose detail view is open (chat subscription).
    @Published var selectedSessionId: String?
    // The open session (item-based navigation): rows, deep links, and push
    // taps all set this; nil pops back to home.
    @Published var openSessionRef: SessionRef?
    // Structured chat timeline per session, deduped by seq.
    @Published var timelinesBySession: [String: [TimelineItem]] = [:]
    // Live, incremental assistant reply for an in-flight turn (codex streams
    // its response via assistant_stream frames the rollout never records). The
    // preview renders as a transient assistant bubble until the finished
    // message lands as a real timeline item and supersedes it.
    @Published var streamingBySession: [String: StreamingReply] = [:]
    // Optimistic user messages awaiting their canonical JSONL row, per
    // session, in send order. Each carries a
    // deadline; expiry marks it failed rather than leaving it pending forever.
    @Published var optimisticBySession: [String: [OptimisticMessage]] = [:]
    // A just-applied model switch, per session: the agent reloads its context
    // on the next turn, so the composer notes that the first reply may lag.
    // Cleared on a timer - purely advisory, never blocks input.
    @Published var modelSwitchHintBySession: [String: String] = [:]
    // Composer text for the OPEN session; loaded from / persisted to
    // DraftStore so drafts never leak between sessions.
    @Published var draft = "" {
        didSet {
            if let selectedSessionId, draft != oldValue {
                DraftStore.save(draft, for: selectedSessionId)
            }
        }
    }
    // Bumped when lastSeen changes so attention dots re-derive.
    @Published private(set) var seenVersion = 0
    // Raw socket state changes can arrive several times per second when a
    // relay registration flaps. Do not publish those changes through the
    // shared store: doing so invalidates the entire home screen. Only the
    // hysteresis-filtered availability below is UI state.
    private(set) var connectionState = "Disconnected" {
        didSet { observeConnectionState() }
    }
    @Published private(set) var presentedServerAvailability: PresentedServerAvailability = .online
    @Published var errorMessage: String?
    @Published var isLoading = false
    // Local usage/credit snapshot (Claude + Codex), read on the Mac.
    @Published private(set) var usage: UsageResponse?
    @Published private(set) var usageIsLoading = false
    @Published private(set) var usageErrorMessage: String?
    @Published private(set) var usageLastUpdatedAt: String?
    @Published private(set) var usageIsShowingStaleData = false
    // Launch-time model catalog (versioned names + resolved CLI default),
    // resolved server-side on the Mac. Absent on older servers.
    @Published var models: ModelsResponse?
    // Fleet defaults (GET /config). nil until loaded, or on a server too old
    // to serve /config - the settings popup then shows what it can and its
    // writes fail loudly rather than silently doing nothing.
    @Published var config: ConfigResponse?
    // Registered charts (GET /charts). Older servers 404 and leave this empty,
    // which must never break anything else.
    @Published var charts: [ChartModel] = []
    // Dismissed timeline chart-card identities. Kept in the shared store so a
    // dismissed Mate chat heads-up survives navigation, chart fetch refreshes,
    // and app restarts without hiding a later chart version.
    @Published private var dismissedChartCardKeys: Set<String> = []
    // Bumped per chart when its file changes on disk (WS "chart" message);
    // an open review screen reloads on the bump.
    @Published var chartVersions: [String: Int] = [:]
    // The chart whose review screen is open (card taps set this; nil closes).
    @Published var openChart: ChartModel?
    // The committed plan whose read-only render is open (hub taps set this).
    @Published var openPlan: ChartPlanDoc?
    // In-flight timeline hole fetches (gap detection), per session.
    private var timelineCatchUps = Set<String>()

    private var webSocketTask: URLSessionWebSocketTask?
    private let decoder = JSONDecoder()
    private lazy var usageRefresh = UsageRefreshCoordinator { [weak self] in
        guard let self else { throw CancellationError() }
        return try await self.request(path: "/usage")
    }
    private var reconnectTask: Task<Void, Never>?
    private var reconnectAttempts = 0
    private var keepaliveTask: Task<Void, Never>?
    private var connectionPresentationTask: Task<Void, Never>?
    private var connectionStatusHysteresis = ConnectionStatusHysteresis()
    private var selectionToken: UUID?
    // Encrypted transport state (nil on the legacy plaintext path). The channel
    // is recreated per socket; e2eeRetryTask re-sends e2ee_hello until the
    // server acks; pendingSends holds app frames until the channel opens.
    private var channel: EncryptedChannel?
    private var e2eeRetryTask: Task<Void, Never>?
    private var pendingSends: [QueuedSocketSend] = []
    private struct PendingRPC {
        let continuation: CheckedContinuation<Data, Error>
        let timeoutTask: Task<Void, Never>
    }
    private var pendingRPC: [String: PendingRPC] = [:]

    private static let dismissedChartCardKeysKey = "Perch.dismissedChartCardKeys.v1"

    init() {
        dismissedChartCardKeys = Set(UserDefaults.standard.stringArray(forKey: Self.dismissedChartCardKeysKey) ?? [])
        if let host = HostStore.load() {
            savedHost = host
            serverURL = host.activeEndpoint.url
            token = Keychain.token(account: host.serverId) ?? ""
        }
    }

    var isPaired: Bool {
        savedHost != nil && !token.isEmpty
    }

    var isServerLive: Bool {
        presentedServerAvailability == .online
    }

    private func observeConnectionState() {
        let now = ProcessInfo.processInfo.systemUptime
        if connectionStatusHysteresis.observe(isLive: connectionState == "Live", at: now) {
            presentedServerAvailability = connectionStatusHysteresis.presentedAvailability
        }

        connectionPresentationTask?.cancel()
        guard let deadline = connectionStatusHysteresis.offlineDeadline else {
            connectionPresentationTask = nil
            return
        }
        let delay = max(0, deadline - now)
        connectionPresentationTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled else { return }
            if self.connectionStatusHysteresis.advance(to: ProcessInfo.processInfo.systemUptime) {
                self.presentedServerAvailability = self.connectionStatusHysteresis.presentedAvailability
            }
            self.connectionPresentationTask = nil
        }
    }

    private var activeEndpoint: SavedEndpoint? {
        savedHost?.activeEndpoint
    }

    private var isRelayActive: Bool {
        activeEndpoint?.isRelay == true
    }

    // The home screen shows only perch-owned agent sessions (`perch claude`,
    // `perch codex`, ...), attention first, then most recent activity.
    var agentSessions: [AgentSession] {
        sessions
            .filter { $0.id.hasPrefix("pty:") }
            .sorted { a, b in
                let pa = statusPriority(a.status)
                let pb = statusPriority(b.status)
                if pa != pb {
                    return pa < pb
                }
                return a.lastActivityAt > b.lastActivityAt
            }
    }

    private func statusPriority(_ status: AgentSessionStatus) -> Int {
        switch status {
        case .needsApproval: 0
        case .running: 1
        case .waiting: 2
        case .idle: 3
        case .unknown: 4
        case .done: 5
        case .error: 6
        }
    }

    // Parses a pairing offer, finds the fastest reachable endpoint, and
    // persists the host (metadata in UserDefaults, token in Keychain).
    func pair(offerText: String) async throws {
        let offer = try PairingOfferParser.parse(offerText)
        let endpoints = offer.endpoints.compactMap {
            SavedEndpoint.fromOffer($0, serverId: offer.serverId, pk: offer.pk)
        }
        guard !endpoints.isEmpty else {
            throw PairingError.unrecognizedOffer
        }
        let reachable = await EndpointProber.reachableEndpoints(endpoints)

        guard let active = reachable.first else {
            throw PairingError.noReachableEndpoint(offer.endpoints)
        }

        let host = SavedHost(
            serverId: offer.serverId,
            name: offer.name,
            endpoints: endpoints,
            activeEndpoint: active,
            pk: offer.pk
        )
        Keychain.saveToken(offer.token, account: offer.serverId)
        HostStore.save(host)

        savedHost = host
        serverURL = active.url
        token = offer.token
        reconnectAttempts = 0
        await refresh()
        // Now that a server exists to receive the token, ask for notification
        // permission and register with APNs. Screenshot/E2E runs skip the
        // one-time system prompt so captures stay clean.
        let screenshotRun = UserDefaults.standard.bool(forKey: "PerchScreenshots")
            || UserDefaults.standard.bool(forKey: "PerchOpenUsage")
        if !screenshotRun {
            PushCoordinator.registerIfAuthorizedOrAsk()
        }
    }

    func unpair() {
        HostStore.clear(serverId: savedHost?.serverId)
        savedHost = nil
        token = ""
        sessions = []
        usageRefresh.reset()
        applyUsageState()
        selectedSessionId = nil
        reconnectTask?.cancel()
        // Leaving a cancelled task in place would block every future
        // scheduleReconnect (it guards on reconnectTask == nil).
        reconnectTask = nil
        keepaliveTask?.cancel()
        keepaliveTask = nil
        e2eeRetryTask?.cancel()
        e2eeRetryTask = nil
        channel = nil
        pendingSends = []
        failPendingRPCs(PerchClientError.connectionReset)
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        connectionState = "Not paired"
    }

    // Exponential backoff reconnect with endpoint failover: after a couple of
    // failures on the active endpoint, re-probe every stored endpoint and
    // switch to whichever answers fastest (for example, a direct endpoint at home).
    private func scheduleReconnect() {
        guard isPaired, reconnectTask == nil else {
            return
        }

        reconnectAttempts += 1
        let delay = min(pow(2, Double(min(reconnectAttempts, 5))), 30)
        connectionState = "Reconnecting in \(Int(delay))s"

        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled else { return }
            self.reconnectTask = nil

            // Re-probe every stored endpoint on the first failure already:
            // the common cause is the Mac changing networks since pairing
            // (LAN IP moved; the .local name usually still resolves).
            if let host = self.savedHost {
                let reachable = await EndpointProber.reachableEndpoints(host.endpoints)
                if let best = reachable.first, best != host.activeEndpoint {
                    var updated = host
                    updated.activeEndpoint = best
                    HostStore.save(updated)
                    self.savedHost = updated
                    self.serverURL = best.url
                }
            }

            await self.refresh()
        }
    }

    private func noteConnected() {
        let wasReconnecting = reconnectAttempts > 0
        reconnectAttempts = 0
        reconnectTask?.cancel()
        reconnectTask = nil
        // Missed live items during the outage: the authoritative fetch is
        // the catch-up path (live stream = immediacy, fetch = truth).
        if wasReconnecting {
            Task {
                await self.refetchAuthoritativeFleet()
                if let selectedSessionId = self.selectedSessionId {
                    await self.loadTimeline(selectedSessionId)
                }
            }
        }
    }

    // Scene-phase resume: revalidate on foreground and perform a full resync when
    // away for a while). Called from the root view.
    private var backgroundedAt: Date?

    func sceneDidBackground() {
        backgroundedAt = Date()
    }

    func sceneDidActivate() async {
        guard isPaired else { return }
        backgroundedAt = nil
        await refresh()
        if let selectedSessionId {
            await loadTimeline(selectedSessionId)
        }
    }

    func session(for sessionId: String) -> AgentSession? {
        sessionsById[sessionId]
    }

    // Authoritative timeline fetch: live stream is for immediacy, this pages
    // catch-up from the last seen seq. An
    // explicit `after` fetches from a known-good point instead of the tail.
    func loadTimeline(_ sessionId: String, after explicitAfter: Int? = nil) async {
        var after = explicitAfter ?? timelinesBySession[sessionId]?.last?.seq ?? 0
        let limit = 200
        do {
            while true {
                let response: TimelineResponse = try await request(
                    path: "/sessions/\(escapePath(sessionId))/timeline?after=\(after)&limit=\(limit)"
                )
                if !response.items.isEmpty {
                    mergeTimelineItems(sessionId, response.items)
                }
                // The server returns the OLDEST `limit` items after `after`:
                // keep paging until the page is short or the tail is reached.
                guard
                    let pageTail = response.items.last?.seq,
                    pageTail > after,
                    response.items.count >= limit,
                    pageTail < response.lastSeq
                else {
                    break
                }
                after = pageTail
            }
        } catch {
            // Chat view falls back to whatever streamed in live.
        }
    }

    // Live-stream classification: contiguous
    // items apply directly; a hole triggers an authoritative catch-up fetch;
    // stale duplicates drop.
    private func handleLiveTimelineItem(_ sessionId: String, _ item: TimelineItem) {
        let last = timelinesBySession[sessionId]?.last?.seq ?? 0
        if item.seq <= last {
            return
        }
        if item.seq > last + 1, !timelineCatchUps.contains(sessionId) {
            timelineCatchUps.insert(sessionId)
            // Fetch from the pre-gap seq: merging the gapped item first would
            // move the tail past the hole and lose the missed items forever.
            Task { [weak self] in
                await self?.loadTimeline(sessionId, after: last)
                self?.timelineCatchUps.remove(sessionId)
            }
        }
        mergeTimelineItems(sessionId, [item])
    }

    private func mergeTimelineItems(_ sessionId: String, _ items: [TimelineItem]) {
        var list = timelinesBySession[sessionId, default: []]
        let known = Set(list.map(\.seq))
        let fresh = items.filter { !known.contains($0.seq) }
        guard !fresh.isEmpty else {
            return
        }
        list.append(contentsOf: fresh)
        list.sort { $0.seq < $1.seq }
        if list.count > 500 {
            list.removeFirst(list.count - 500)
        }
        timelinesBySession[sessionId] = list
        // The finished assistant message has now persisted from the transcript
        // tailer; drop any live preview so the real bubble takes over (identical
        // text, so the swap is seamless). The in-flight message never appears in
        // the tail, so this only fires once a reply actually completes.
        if streamingBySession[sessionId] != nil, fresh.contains(where: { $0.kind == .assistant }) {
            streamingBySession[sessionId] = nil
        }
        reconcileOptimistic(sessionId, fresh)
    }

    // Ordinal reconciliation for whole-row arrival: each
    // fresh canonical user row absorbs the oldest pending optimistic message.
    // Unmatched optimistic items stay visible - never eat the user's message.
    // A row with nothing pending left to absorb belongs to a message we already
    // gave up on (a queued send that landed after its deadline), so it retires
    // the oldest failed row instead of stranding a duplicate bubble.
    private func reconcileOptimistic(_ sessionId: String, _ fresh: [TimelineItem]) {
        var pending = optimisticBySession[sessionId, default: []]
        guard !pending.isEmpty else {
            return
        }
        var absorb = fresh.filter { $0.kind == .user }.count
        guard absorb > 0 else {
            return
        }
        while absorb > 0, !pending.isEmpty {
            pending.remove(at: pending.firstIndex { !$0.failed } ?? 0)
            absorb -= 1
        }
        optimisticBySession[sessionId] = pending
    }

    // How long an optimistic message waits for its canonical row before it is
    // declared undelivered. A server-side queued send waits behind a permission
    // prompt the boss has to answer, so it gets a much longer - but still
    // finite - leash. An infinite spinner is never a legal state.
    private static let optimisticTimeout: TimeInterval = 45
    private static let optimisticQueuedTimeout: TimeInterval = 300

    // True while at least one message is genuinely in flight. Failed rows are
    // done: they carry their own retry affordance and must not keep the
    // thinking indicator alive.
    func hasPendingOptimistic(_ sessionId: String) -> Bool {
        // An acknowledged message is delivered (server 202), so it no longer
        // keeps the thinking indicator alive on its own - the running-session
        // path in the view does that while the agent works. This also keeps a
        // delivered-but-not-yet-reconciled bubble from becoming an infinite
        // spinner if its canonical row is delayed.
        optimisticBySession[sessionId]?.contains { !$0.failed && !$0.acknowledged } ?? false
    }

    func isOptimisticFailed(_ sessionId: String, _ itemId: String) -> Bool {
        optimisticBySession[sessionId]?.first { $0.id == itemId }?.failed ?? false
    }

    // Waits out the message's deadline, then declares it undelivered. Re-reads
    // the deadline each pass so a send that turns out to be server-queued (a
    // longer leash) is honored without a second task.
    private func armOptimisticExpiry(_ sessionId: String, _ itemId: String) {
        Task { [weak self] in
            while true {
                guard let self,
                      let message = self.optimisticBySession[sessionId]?.first(where: { $0.id == itemId }),
                      !message.failed else {
                    return
                }
                // Server-accepted (202): delivered. Stop waiting - a delayed or
                // missing canonical row must never turn it into "Not delivered".
                if message.acknowledged {
                    return
                }
                let remaining = message.deadline.timeIntervalSinceNow
                guard remaining > 0 else {
                    self.setOptimistic(sessionId, itemId) { $0.failed = true }
                    return
                }
                do {
                    try await Task.sleep(for: .seconds(remaining))
                } catch {
                    return
                }
            }
        }
    }

    private func setOptimistic(_ sessionId: String, _ itemId: String, _ mutate: (inout OptimisticMessage) -> Void) {
        guard let index = optimisticBySession[sessionId]?.firstIndex(where: { $0.id == itemId }) else {
            return
        }
        mutate(&optimisticBySession[sessionId]![index])
    }

    // Re-send a message the agent never acknowledged. The bubble returns to
    // pending in place (no draft round-trip, so whatever is in the composer
    // now is untouched) and re-arms its deadline.
    func retryOptimistic(_ sessionId: String, _ itemId: String) async {
        guard let message = optimisticBySession[sessionId]?.first(where: { $0.id == itemId }),
              let text = message.item.text, !text.isEmpty else {
            return
        }
        setOptimistic(sessionId, itemId) {
            $0.failed = false
            $0.acknowledged = false
            $0.deadline = Date().addingTimeInterval(Self.optimisticTimeout)
        }
        armOptimisticExpiry(sessionId, itemId)
        do {
            let result: SubmitResult = try await postDecoding(
                path: "/sessions/\(escapePath(sessionId))/submit",
                body: ["text": text]
            )
            errorMessage = nil
            noteSubmitResult(result, sessionId: sessionId, itemId: itemId)
        } catch {
            // A retry has no draft to restore (the composer moved on), so the
            // bubble simply returns to its failed state, retryable again.
            setOptimistic(sessionId, itemId) { $0.failed = true }
            connectionState = error.localizedDescription
            errorMessage = error.localizedDescription
        }
    }

    // The server accepted and injected the input (202). That is the
    // authoritative delivery signal, so mark the row acknowledged - the
    // canonical timeline row now only confirms it and can never turn a
    // delivered message into a false "Not delivered". A server-queued send
    // additionally waits behind a permission prompt, so it keeps the longer
    // leash rather than expiring while the boss decides.
    private func noteSubmitResult(_ result: SubmitResult, sessionId: String, itemId: String) {
        setOptimistic(sessionId, itemId) { $0.acknowledged = true }
        guard result.queued ?? false else {
            return
        }
        lastSubmitQueued = true
        setOptimistic(sessionId, itemId) {
            $0.deadline = Date().addingTimeInterval(Self.optimisticQueuedTimeout)
        }
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            self?.lastSubmitQueued = false
        }
    }

    // Navigate straight to a session's detail view (deep links, push taps,
    // E2E launch args). Retries briefly while the fleet loads at launch.
    func openSession(_ sessionId: String) async {
        for _ in 0..<20 {
            if sessionsById[sessionId] != nil {
                if openSessionRef?.id != sessionId {
                    openSessionRef = SessionRef(id: sessionId)
                }
                await select(sessionId)
                return
            }
            try? await Task.sleep(for: .milliseconds(250))
        }
    }

    func refresh() async {
        guard isPaired else {
            connectionState = "Not paired"
            return
        }

        isLoading = true
        defer { isLoading = false }

        if isRelayActive {
            if webSocketTask?.state != .running {
                connectWebSocket()
                connectionState = "Connecting"
            }
            errorMessage = nil
            Task { [weak self] in
                await self?.fetchUsage(trigger: .automatic)
            }
            return
        }

        do {
            let response: SessionsResponse = try await request(path: "/sessions")
            sessions = response.sessions
            // The crew ledger rides the same refresh; its absence (older
            // server) must never break the fleet.
            if let taskResult: TasksResult = try? await request(path: "/tasks") {
                tasks = taskResult.tasks
            }
            // The project registry rides along: it draws the mate panel's
            // scope headers, so its absence (older server) leaves them empty
            // but never breaks the fleet.
            if let projectsResult: ProjectsResult = try? await request(path: "/projects") {
                projects = projectsResult.projects
            }
            // Usage has its own state and error handling, while still riding
            // direct bootstrap and foreground refresh.
            await fetchUsage(trigger: .automatic)
            // Model catalog rides along too; an older server without /models
            // leaves this nil and the picker falls back to its static catalog.
            if let modelsResult: ModelsResponse = try? await request(path: "/models") {
                models = modelsResult
            }
            // Charts ride the same refresh; absent on older servers.
            if let chartsResult: ChartsResult = try? await request(path: "/charts") {
                charts = chartsResult.charts
            }
            connectionState = "Live"
            errorMessage = nil
            // Never tear down a healthy socket (foreground/pull-to-refresh
            // call this constantly); reconnect only when it is gone or dead.
            if webSocketTask?.state != .running {
                connectWebSocket()
            }
        } catch {
            if isCancellation(error) {
                return
            }
            connectionState = error.localizedDescription
            errorMessage = error.localizedDescription
            scheduleReconnect()
        }
    }

    func fetchUsage(trigger: UsageFetchTrigger) async {
        let transport: UsageTransportReadiness
        if !isRelayActive {
            transport = .direct
        } else if channel?.isOpen == true {
            transport = .relayReady
        } else {
            transport = .relayWaitingForEncryptedChannel
        }

        if transport != .relayWaitingForEncryptedChannel {
            usageIsLoading = true
            usageErrorMessage = nil
        }
        await usageRefresh.refresh(trigger: trigger, transport: transport)
        applyUsageState()
    }

    private func applyUsageState() {
        let state = usageRefresh.state
        usage = state.usage
        usageIsLoading = state.isLoading
        usageErrorMessage = state.errorMessage
        usageLastUpdatedAt = state.lastUpdatedAt
        usageIsShowingStaleData = state.isShowingStaleData
    }

    // Open the detail tier for a session: additive subscription on the
    // always-on fleet socket, plus the authoritative timeline fetch.
    // Entering a session clears its client-side attention marker.
    func select(_ sessionId: String, token: UUID? = nil) async {
        if let token {
            selectionToken = token
        }
        selectedSessionId = sessionId
        draft = DraftStore.draft(for: sessionId)
        markSeen(sessionId)

        if webSocketTask == nil {
            connectWebSocket()
        }
        subscribe(sessionId)
        await loadTimeline(sessionId)
    }

    func markSeen(_ sessionId: String) {
        SeenStore.markSeen(sessionId)
        seenVersion += 1
    }

    // Green "review me" dot: the session stopped working after the user last
    // looked. Permission attention is separate and never cleared by viewing.
    func hasUnseenActivity(_ session: AgentSession) -> Bool {
        _ = seenVersion
        guard session.status == .idle || session.status == .done || session.status == .waiting else {
            return false
        }
        guard let activity = ISO8601DateFormatter.perchDate(from: session.lastActivityAt) else {
            return false
        }
        guard let seen = SeenStore.lastSeen(session.id) else {
            return true
        }
        return activity > seen
    }

    // Stop streaming a session's full output when its detail view closes. The
    // fleet overview keeps flowing for every session.
    func closeDetail(_ sessionId: String, token: UUID) {
        guard selectionToken == token else {
            return
        }
        selectionToken = nil
        unsubscribe(sessionId)
        if selectedSessionId == sessionId {
            selectedSessionId = nil
        }
    }

    private func subscribe(_ sessionId: String) {
        _ = sendSocket(["type": "subscribe", "sessionId": sessionId])
    }

    private func unsubscribe(_ sessionId: String) {
        _ = sendSocket(["type": "unsubscribe", "sessionId": sessionId])
    }

    private func sendSocket(_ message: [String: Any]) -> Bool {
        guard
            let task = webSocketTask,
            let data = try? JSONSerialization.data(withJSONObject: message),
            let text = String(data: data, encoding: .utf8)
        else {
            return false
        }

        // Encrypted transport: seal once the channel is open, otherwise queue
        // until the handshake completes so no app frame is sent in cleartext.
        if let channel {
            if channel.isOpen, let sealed = channel.seal(text) {
                task.send(.string(sealed)) { _ in }
            } else {
                pendingSends.append(QueuedSocketSend(text: text, rpcId: RPCSendQueue.rpcId(from: message)))
            }
            return true
        }

        task.send(.string(text)) { _ in }
        return true
    }


    // Set briefly after a submit that the server queued (session was blocked
    // on a permission prompt); drives the "queued" chip on the composer.
    @Published var lastSubmitQueued = false

    // Images staged in the composer, already uploaded to the server (so send
    // just references their stored paths). Foundation-only so this store stays
    // free of UIKit; the view builds a UIImage from `imageData` for the thumb.
    struct PendingAttachment: Identifiable {
        let id = UUID()
        let imageData: Data
        let serverPath: String
    }

    @Published private var pendingAttachmentsBySession = SessionScopedValues<PendingAttachment>()

    var pendingAttachments: [PendingAttachment] {
        get {
            pendingAttachmentsBySession.values(for: selectedSessionId)
        }
        set {
            guard let selectedSessionId else { return }
            pendingAttachmentsBySession.replace(newValue, for: selectedSessionId)
        }
    }

    func appendPendingAttachment(_ attachment: PendingAttachment, for sessionId: String) {
        pendingAttachmentsBySession.append(attachment, for: sessionId)
    }

    func removePendingAttachment(id: UUID, for sessionId: String) {
        pendingAttachmentsBySession.removeAll(for: sessionId) { $0.id == id }
    }

    // The model + reasoning effort the NEXT message will run on, when the user
    // has queued a change. Compared against the session's live model/effort (the
    // server reports what it is actually running) to decide whether a switch is
    // needed; cleared once applied. Keyed by sessionId.
    @Published var pendingModelBySession: [String: String] = [:]
    @Published var pendingEffortBySession: [String: String] = [:]

    // Upload image bytes to the session's scratch dir; returns the absolute
    // server path the injected prompt will reference.
    func uploadAttachment(_ data: Data, filename: String, contentType: String, sessionId: String? = nil) async throws -> String {
        guard let sid = sessionId ?? selectedSessionId else { throw PerchClientError.invalidURL }
        let encoded = filename.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "image"
        if isRelayActive {
            let response: AttachmentResponse = try await rpcDecoding(
                method: "POST",
                path: "/sessions/\(escapePath(sid))/attachments?filename=\(encoded)",
                bodyBase64: data.base64EncodedString(),
                contentType: contentType
            )
            return response.path
        }

        var request = try makeRequest(path: "/sessions/\(escapePath(sid))/attachments?filename=\(encoded)")
        request.httpMethod = "POST"
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        let (respData, response) = try await URLSession.shared.data(for: request)
        try validate(response, data: respData)
        return try decoder.decode(AttachmentResponse.self, from: respData).path
    }

    // Switch the running agent to the pending model/effort before the next turn.
    // Returns false if a needed switch failed, so the caller aborts the send
    // rather than silently running the turn on the wrong model. Compares against
    // the session's live values (server-reported) so a no-op switch is skipped,
    // and an effort-only change reuses the live model since the route needs one.
    func switchModelIfNeeded() async -> Bool {
        guard let sid = selectedSessionId else { return true }
        let live = session(for: sid)
        let pendingModel = pendingModelBySession[sid]
        let pendingEffort = pendingEffortBySession[sid]
        if pendingModel == nil, pendingEffort == nil { return true }
        let modelUnchanged = pendingModel == nil || pendingModel == live?.model
        let effortUnchanged = pendingEffort == nil || pendingEffort == live?.effort
        if modelUnchanged, effortUnchanged {
            pendingModelBySession[sid] = nil
            pendingEffortBySession[sid] = nil
            return true
        }
        guard let modelToSend = pendingModel ?? live?.model else { return true }
        return await switchModel(sessionId: sid, to: modelToSend, effort: pendingEffort)
    }

    // Switch one session's running model/effort immediately. The composer chip
    // reaches this through `switchModelIfNeeded` (queued until the next send);
    // the mate settings popup calls it directly, because a default the boss
    // just picked should take on the running mate without waiting for a turn.
    @discardableResult
    func switchModel(sessionId: String, to model: String, effort: String? = nil) async -> Bool {
        do {
            var body: [String: Any] = ["model": model]
            if let effort { body["effort"] = effort }
            try await postAny(path: "/sessions/\(escapePath(sessionId))/model", body: body)
            noteModelSwitched(sessionId, to: model)
            return true
        } catch {
            errorMessage = "Could not switch model: \(error.localizedDescription)"
            return false
        }
    }

    // The switch itself is seamless (the server auto-confirms the agent's own
    // dialog), but the agent reloads its context under the new model, so the
    // first reply of the next turn can lag. Say so once, quietly, then retire.
    private func noteModelSwitched(_ sessionId: String, to model: String) {
        pendingModelBySession[sessionId] = nil
        pendingEffortBySession[sessionId] = nil
        let hint = "Switched to \(modelLabel(for: model)) - first reply may be slower"
        modelSwitchHintBySession[sessionId] = hint
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(8))
            guard let self, self.modelSwitchHintBySession[sessionId] == hint else { return }
            self.modelSwitchHintBySession[sessionId] = nil
        }
    }

    // Fleet defaults, read fresh when the settings popup opens so it never
    // edits a stale snapshot.
    func loadConfig() async {
        config = try? await request(path: "/config")
    }

    // Write fleet defaults. PATCH /config merges: a key present sets it, an
    // explicit null clears it, an absent key is left untouched - so the mate
    // section can save `model` alone without disturbing the mate's agent.
    // Returns the effective config the server settled on.
    @discardableResult
    func updateConfig(dispatchDefaults: [String: Any]? = nil, mateDefaults: [String: Any]? = nil) async -> Bool {
        var body: [String: Any] = [:]
        if let dispatchDefaults { body["dispatchDefaults"] = dispatchDefaults }
        if let mateDefaults { body["mateDefaults"] = mateDefaults }
        guard !body.isEmpty else { return true }
        do {
            config = try await patchDecodingAny(path: "/config", body: body)
            return true
        } catch {
            errorMessage = "Could not save defaults: \(error.localizedDescription)"
            return false
        }
    }

    // The name the boss picked in the model menu. The server catalog is the
    // source of truth for a versioned label ("Haiku 4.5"); a raw id from an
    // older server falls back to the local prettifier.
    func modelLabel(for id: String) -> String {
        let option = models?.providers
            .flatMap(\.options)
            .first { $0.id == id || $0.runtimeId == id }
        return option?.label ?? friendlyModelName(id)
    }

    func sendDraftAndEnter() async {
        guard let selectedSessionId else {
            return
        }
        let attachments = pendingAttachmentsBySession.values(for: selectedSessionId)
        let draftText = draft
        guard !(draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty) else {
            return
        }

        // Apply a pending model switch first; abort the send if it fails so the
        // turn never runs on the wrong model.
        if await switchModelIfNeeded() == false {
            return
        }

        pendingAttachmentsBySession.replace([], for: selectedSessionId)

        var text = draftText
        if !attachments.isEmpty {
            let paths = attachments.map { $0.serverPath }.joined(separator: " ")
            let prefix = draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : "\(draftText)\n\n"
            text = "\(prefix)View the image(s): \(paths)"
        }
        draft = ""
        DraftStore.clear(for: selectedSessionId)
        markSeen(selectedSessionId)

        // Optimistic append: the message shows instantly and reconciles when
        // its canonical JSONL row lands (on failure, restore
        // the composer text AND remove the optimistic copy). Sessions without
        // a chat source render the placeholder instead of the chat list, so
        // an optimistic row there would be invisible and never reconcile.
        let optimistic = TimelineItem(
            seq: 0,
            id: "optimistic-\(UUID().uuidString)",
            sessionId: selectedSessionId,
            kind: .user,
            text: text,
            tool: nil,
            at: ISO8601DateFormatter().string(from: Date())
        )
        let tracked = session(for: selectedSessionId).map { $0.agent == .claude || $0.agent == .codex } ?? true
        if tracked {
            optimisticBySession[selectedSessionId, default: []].append(
                OptimisticMessage(item: optimistic, deadline: Date().addingTimeInterval(Self.optimisticTimeout))
            )
            armOptimisticExpiry(selectedSessionId, optimistic.id)
        }

        do {
            let result: SubmitResult = try await postDecoding(
                path: "/sessions/\(escapePath(selectedSessionId))/submit",
                body: ["text": text]
            )
            errorMessage = nil
            noteSubmitResult(result, sessionId: selectedSessionId, itemId: optimistic.id)
        } catch {
            pendingAttachmentsBySession.replace(attachments, for: selectedSessionId)
            optimisticBySession[selectedSessionId]?.removeAll { $0.id == optimistic.id }
            // The user may have switched sessions during the request: restore
            // the failed draft to the session it was written for, never into
            // whichever composer happens to be open now.
            if self.selectedSessionId == selectedSessionId {
                draft = draftText
            } else {
                DraftStore.save(draftText, for: selectedSessionId)
            }
            connectionState = error.localizedDescription
            errorMessage = error.localizedDescription
        }
    }

    // Rendered chat = canonical items + optimistic overlay at the end.
    func chatItems(_ sessionId: String) -> [TimelineItem] {
        var items = (timelinesBySession[sessionId] ?? []) + (optimisticBySession[sessionId] ?? []).map(\.item)
        // Append the live streaming reply (codex) as a synthetic assistant
        // bubble at the tail. seq 0 keeps it out of the typewriter-reveal path
        // (that animates seq > revealAfterSeq); the streaming itself is the
        // animation. Cleared once the finished message persists.
        if let reply = streamingBySession[sessionId], !reply.text.isEmpty {
            items.append(reply.asTimelineItem(sessionId: sessionId))
        }
        return items
    }

    // Answer a permission prompt from the phone. The server injects the
    // matching keystroke into the real TUI, so the desktop sees it resolve.
    // The approval id pins the decision to this exact prompt: the server
    // rejects it if the prompt was already answered or replaced.
    // Forwards the APNs device token to the server (device-token auth); the
    // server pushes approvals/attention moments to it from then on.
    func registerPushToken(_ token: String) async {
        do {
            try await post(path: "/devices/push-token", body: ["pushToken": token])
        } catch {
            print("push: token registration failed: \(error.localizedDescription)")
        }
    }

    func approve(_ sessionId: String, decision: String, approvalId: String? = nil) async {
        var body: [String: Any] = ["decision": decision]
        if let approvalId {
            body["id"] = approvalId
        }
        if let approval = session(for: sessionId)?.pendingApproval, approval.requestVersion == 1 {
            body["requestVersion"] = 1
            body["runtimeGeneration"] = approval.runtimeGeneration ?? NSNull()
        }
        do {
            try await postAny(path: "/sessions/\(escapePath(sessionId))/approve", body: body)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func respondToServerRequest(
        _ sessionId: String,
        request: PendingServerRequest,
        decision: String?,
        content: [String: Any]?
    ) async {
        var body: [String: Any] = ["requestId": request.requestId.jsonObject]
        if let decision { body["decision"] = decision }
        if let content { body["content"] = content }
        do {
            try await postAny(path: "/sessions/\(escapePath(sessionId))/server-request", body: body)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // Answer an interactive AskUserQuestion prompt from the phone. The server
    // translates the chosen option indices into the widget's own keystrokes and
    // injects them, so the desktop TUI resolves too. `selections` is
    // per-question: chosen option indices (one for single-select). The question
    // id pins the answer to this exact prompt (rejected if already resolved).
    func answer(_ sessionId: String, questionId: String, selections: [[Int]], customAnswers: [String: String] = [:]) async {
        let question = session(for: sessionId)?.pendingQuestion
        var body: [String: Any] = ["id": questionId, "selections": selections, "customAnswers": customAnswers]
        if question?.requestVersion == 1 {
            body["requestVersion"] = 1
            body["runtimeGeneration"] = question?.runtimeGeneration ?? NSNull()
        }
        do {
            try await postAny(path: "/sessions/\(escapePath(sessionId))/answer", body: body)
            errorMessage = nil
            // Collapse the chat's question chip to what was chosen. Local by
            // design: the agent's transcript records the exchange itself, so
            // this only bridges the moments until the conversation moves on.
            if let question, question.id == questionId {
                let answers = zip(question.questions, selections).flatMap { item, picks in
                    let selected = picks.compactMap { item.options[safe: $0]?.label }
                    return selected + (customAnswers[item.question].map { [$0] } ?? [])
                }
                answeredQuestions[sessionId] = AnsweredQuestion(
                    questionId: questionId,
                    answers: answers,
                    anchorSeq: chatItems(sessionId).last(where: { $0.seq > 0 })?.seq ?? 0
                )
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func respondToClaudeInteraction(_ sessionId: String, interactionId: String, action: String, content: [String: Any]?) async {
        var body: [String: Any] = ["id": interactionId, "action": action]
        if let interaction = session(for: sessionId)?.pendingClaudeInteraction {
            body["requestVersion"] = interaction.requestVersion
            body["runtimeGeneration"] = interaction.runtimeGeneration ?? NSNull()
        }
        if let content { body["content"] = content }
        do {
            try await postAny(path: "/sessions/\(escapePath(sessionId))/claude-interaction", body: body)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func interrupt(_ sessionId: String) async {
        do {
            try await post(path: "/sessions/\(escapePath(sessionId))/interrupt", body: [:])
            errorMessage = nil
        } catch {
            connectionState = error.localizedDescription
            errorMessage = error.localizedDescription
        }
    }

    @discardableResult
    func fetchProjects() async -> [Project] {
        do {
            let result: ProjectsResult = try await request(path: "/projects")
            return result.projects
        } catch {
            return []
        }
    }

    // Register a directory as a project. Returns the server's message on
    // failure (nil on success); the workspace list refreshes in place.
    func addProject(_ rootPath: String) async -> String? {
        do {
            try await postAny(path: "/projects", body: ["rootPath": rootPath])
            projects = await fetchProjects()
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    // Unregister a project (the repo on disk is untouched). The server refuses
    // with a 409 while live tasks reference it; that message returns verbatim.
    func removeProject(_ rootPath: String) async -> String? {
        do {
            try await deleteAny(path: "/projects", body: ["rootPath": rootPath])
            projects = await fetchProjects()
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    func suggestDirectories(_ query: String) async -> [String] {
        let q = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query
        do {
            let result: SuggestResult = try await request(path: "/fs/suggest?q=\(q)")
            return result.paths
        } catch {
            return []
        }
    }

    // The running mate, if any: the fleet's front door.
    var mateSession: AgentSession? {
        agentSessions.first {
            $0.labels?["role"] == "mate" && $0.status != .done && $0.status != .error
        }
    }

    // Route a home-composer message to the mate: open its chat and submit
    // through the normal (queue-gated, optimistic) path.
    func sendToMate(_ text: String) async -> Bool {
        guard let mate = mateSession else { return false }
        await openSession(mate.id)
        draft = text
        await sendDraftAndEnter()
        return true
    }

    // The full event log behind one task (GET /tasks/:id): the decision card
    // reads the latest parked gate and any recorded answer from it.
    func taskEvents(_ id: String) async -> [TaskEventModel] {
        do {
            let result: TaskDetailResult = try await request(path: "/tasks/\(id)")
            return result.events
        } catch {
            return []
        }
    }

    // Answer a parked no-mistakes gate (POST /tasks/:id/decision). The server
    // translates the answer into the matching `no-mistakes axi respond ...`
    // line, injects it into the worker's composer, and FYIs the mate so it
    // never double-answers. Returns the server's message on failure.
    func decideTask(_ id: String, action: String, findingIds: [String] = [], instructions: String? = nil) async -> String? {
        var body: [String: Any] = ["action": action]
        if !findingIds.isEmpty {
            body["findingIds"] = findingIds
        }
        if let instructions, !instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            body["instructions"] = instructions
        }
        do {
            try await postAny(path: "/tasks/\(id)/decision", body: body)
            await refresh()
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    // Teardown runs the server's landed-gate; a 409 surfaces its reason.
    func teardownTask(_ id: String, force: Bool = false) async -> String? {
        do {
            let _: TaskCreateResult = try await postDecodingAny(
                path: "/tasks/\(id)/teardown",
                body: force ? ["force": true] : [:]
            )
            await refresh()
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    func recoveryAction(for taskId: String) -> RecoveryActionState? {
        recoveryActions[taskId]
    }

    func clearRecoveryAction(for taskId: String) {
        recoveryActions.removeValue(forKey: taskId)
    }

    // Recovery is server-owned. The phone submits one intent, disables
    // duplicate taps, then replaces local presentation with fresh snapshots.
    func recoverTask(_ id: String) async {
        if recoveryActions[id]?.preventsDuplicateRequest == true {
            return
        }
        guard let task = tasks.first(where: { $0.id == id }), task.runtime?.recoveryAvailable == true else {
            recoveryActions[id] = .unavailable("Recovery unavailable")
            return
        }

        recoveryActions[id] = .inProgress
        do {
            try await postAny(path: "/tasks/\(id)/recover", body: [:])
            recoveryActions[id] = .success
            await refetchAuthoritativeFleet()
        } catch {
            let message = error.localizedDescription
            if let status = (error as? PerchClientError)?.httpStatusCode {
                switch RecoveryRequestDisposition.classify(httpStatus: status) {
                case .conflict:
                    recoveryActions[id] = .conflict("Recovery already in progress")
                case .unavailable:
                    recoveryActions[id] = .unavailable("Recovery unavailable")
                case .failure:
                    recoveryActions[id] = .failure(message)
                }
            } else {
                recoveryActions[id] = .failure(message)
            }
            await refetchAuthoritativeFleet()
        }
    }

    // Reconnect and recovery both converge through full server snapshots.
    // Neither path derives task/runtime state from socket presence.
    private func refetchAuthoritativeFleet() async {
        if let response: SessionsResponse = try? await request(path: "/sessions") {
            sessions = response.sessions
        }
        if let response: TasksResult = try? await request(path: "/tasks") {
            tasks = response.tasks
        }
        if let response: ProjectsResult = try? await request(path: "/projects") {
            projects = response.projects
        }
    }

    // Start an agent in a chosen directory, optionally in a fresh worktree.
    func startAgent(project: String, agent: String, prompt: String, worktree: Bool, model: String? = nil) async -> Bool {
        var body: [String: Any] = [
            "command": agent,
            "agent": agent,
            "cwd": project,
            "title": "\(agent.capitalized) - \(URL(fileURLWithPath: project).lastPathComponent)"
        ]
        if !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            body["initialPrompt"] = prompt
        }
        if worktree {
            body["worktree"] = true
        }
        if let model, !model.isEmpty {
            body["model"] = model
        }
        do {
            let response: StartAgentResult = try await postDecodingAny(path: "/agents/pty", body: body)
            errorMessage = nil
            await refresh()
            await openSession(response.session.id)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    // Start the fleet's one mate on the Mac: the server seeds ~/.perch/mate
    // (neutral by design - there is no directory to pick) and spawns exactly
    // what `perch mate` does. A 409 means one is already live; the refresh
    // surfaces it either way, so that counts as success.
    func startMate() async -> Bool {
        do {
            let _: StartAgentResult = try await postDecodingAny(path: "/mate/start", body: [:])
            errorMessage = nil
            await refresh()
            return true
        } catch {
            if isServerUnavailable(error) {
                connectionState = "Server offline"
                errorMessage = Self.serverOfflineMessage
                scheduleReconnect()
                return false
            }
            await refresh()
            if mateSession != nil {
                errorMessage = nil
                return true
            }
            errorMessage = isServerLive ? error.localizedDescription : Self.serverOfflineMessage
            return false
        }
    }

    // Kill a session's process (or dismiss an ended one) from the phone.
    // Returns whether the server accepted the stop, so callers only navigate
    // away from a session that actually stopped.
    func stopSession(_ sessionId: String) async -> Bool {
        do {
            if isRelayActive {
                _ = try await rpc(method: "DELETE", path: "/sessions/\(escapePath(sessionId))")
                errorMessage = nil
                return true
            }

            var request = try makeRequest(path: "/sessions/\(escapePath(sessionId))")
            request.httpMethod = "DELETE"
            let (data, response) = try await URLSession.shared.data(for: request)
            try validate(response, data: data)
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func connectWebSocket() {
        let endpoint = activeEndpoint ?? SavedEndpoint.legacy(serverURL, serverId: savedHost?.serverId, pk: savedHost?.pk)
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        failPendingRPCs(PerchClientError.connectionReset)
        // A new socket means a fresh handshake: tear down any prior channel state.
        e2eeRetryTask?.cancel()
        e2eeRetryTask = nil
        channel = nil
        pendingSends = []

        guard var components = URLComponents(string: endpoint.url) else {
            connectionState = "Invalid server URL"
            return
        }

        components.scheme = components.scheme == "https" ? "wss" : "ws"

        // Preserve any query the endpoint already carries. A LAN endpoint has
        // none; a relay endpoint carries ?serverId=...&role=client (the room the
        // relay pairs us into), and dropping it would misroute the socket. We
        // only ever APPEND the transport marker below.
        var query = components.queryItems ?? []
        if endpoint.isRelay && !query.contains(where: { $0.name == "v" }) {
            query.append(URLQueryItem(name: "v", value: "2"))
        }

        // Encrypted transport when the paired server published a box public key
        // (offer.pk): the device token moves inside the ciphertext, so it is NOT
        // a query param here. Hosts paired before the encrypted transport (no pk)
        // keep the legacy ?token= path, so the wire stays append-only. The relay
        // path always has a pk (the offer only advertises a relay alongside one),
        // so relayed traffic is always end-to-end encrypted and opaque to the relay.
        if let pk = endpoint.pk ?? savedHost?.pk, let e2ee = EncryptedChannel(serverPublicKeyBase64: pk, token: token) {
            channel = e2ee
            query.append(URLQueryItem(name: "e2ee", value: "1"))
        } else if endpoint.isRelay {
            connectionState = "Relay requires encrypted pairing"
            errorMessage = connectionState
            return
        } else {
            // One persistent connection carries the always-on fleet overview.
            // Focused panes are opened with subscribe messages, not a query.
            query.append(URLQueryItem(name: "token", value: token))
        }
        components.queryItems = query

        guard let url = components.url else {
            connectionState = "Invalid socket URL"
            return
        }

        let task = URLSession.shared.webSocketTask(with: url)
        webSocketTask = task
        task.resume()
        connectionState = "Connecting"
        receiveSocketMessage()
        startKeepalive(for: task)

        if let channel {
            startE2eeHandshake(for: task, channel: channel)
        }

        // Re-arm focused detail for the open session after a reconnect. On the
        // encrypted path this queues until the channel opens, then flushes.
        if let selectedSessionId {
            subscribe(selectedSessionId)
        }
    }

    // Sends e2ee_hello immediately and re-sends it every second until the server
    // acknowledges with e2ee_ready. URLSession
    // queues the first send until the socket actually connects.
    private func startE2eeHandshake(for task: URLSessionWebSocketTask, channel: EncryptedChannel) {
        let hello = channel.helloMessage()
        e2eeRetryTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, task === self.webSocketTask, !channel.isOpen else { return }
                task.send(.string(hello)) { _ in }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    // The server acked the handshake: send the device token as the first
    // encrypted frame, then flush any app frames queued while handshaking.
    private func onE2eeReady() {
        guard let task = webSocketTask, let channel else { return }
        e2eeRetryTask?.cancel()
        e2eeRetryTask = nil
        if let auth = channel.authFrame() {
            task.send(.string(auth)) { _ in }
        }
        let queued = RPCSendQueue.flushable(pendingSends, liveRPCIds: Set(pendingRPC.keys))
        pendingSends = []
        for send in queued {
            if let sealed = channel.seal(send.text) {
                task.send(.string(sealed)) { _ in }
            }
        }
        Task { [weak self] in
            guard let self else { return }
            if self.usageRefresh.hasPendingRequest {
                self.usageIsLoading = true
                self.usageErrorMessage = nil
            }
            await self.usageRefresh.encryptedChannelDidBecomeReady()
            self.applyUsageState()
        }
    }

    // Periodic pings keep NAT/proxy paths open and detect a half-open socket
    // that would otherwise show a stale "Live" fleet forever.
    private func startKeepalive(for task: URLSessionWebSocketTask) {
        keepaliveTask?.cancel()
        keepaliveTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(25))
                guard let self, !Task.isCancelled, task === self.webSocketTask else {
                    return
                }
                task.sendPing { error in
                    guard error != nil else { return }
                    Task { @MainActor [weak self] in
                        guard let self, task === self.webSocketTask else { return }
                        self.keepaliveTask?.cancel()
                        self.keepaliveTask = nil
                        self.webSocketTask?.cancel(with: .goingAway, reason: nil)
                        self.webSocketTask = nil
                        self.connectionState = "Connection lost"
                        self.scheduleReconnect()
                    }
                }
            }
        }
    }

    private func rpcDecoding<T: Decodable>(
        method: String,
        path: String,
        body: [String: Any]? = nil,
        bodyBase64: String? = nil,
        contentType: String? = nil
    ) async throws -> T {
        let data = try await rpc(
            method: method,
            path: path,
            body: body,
            bodyBase64: bodyBase64,
            contentType: contentType
        )
        return try decoder.decode(T.self, from: data)
    }

    private func rpc(
        method: String,
        path: String,
        body: [String: Any]? = nil,
        bodyBase64: String? = nil,
        contentType: String? = nil
    ) async throws -> Data {
        guard isRelayActive else {
            throw PerchClientError.invalidURL
        }
        if webSocketTask?.state != .running {
            connectWebSocket()
        }

        let id = UUID().uuidString
        var message: [String: Any] = [
            "type": "rpc",
            "id": id,
            "method": method,
            "path": path
        ]
        if let body { message["body"] = body }
        if let bodyBase64 { message["bodyBase64"] = bodyBase64 }
        if let contentType { message["contentType"] = contentType }

        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard !Task.isCancelled else {
                    continuation.resume(throwing: CancellationError())
                    return
                }
                let timeoutTask = Task { [weak self] in
                    do {
                        try await Task.sleep(for: .seconds(12))
                    } catch {
                        return
                    }
                    await MainActor.run {
                        guard let self, let pending = self.pendingRPC.removeValue(forKey: id) else { return }
                        self.dropQueuedRPC(id)
                        pending.continuation.resume(throwing: PerchClientError.rpcTimeout)
                    }
                }
                pendingRPC[id] = PendingRPC(continuation: continuation, timeoutTask: timeoutTask)
                guard sendSocket(message) else {
                    timeoutTask.cancel()
                    pendingRPC.removeValue(forKey: id)
                    dropQueuedRPC(id)
                    continuation.resume(throwing: PerchClientError.connectionReset)
                    return
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.cancelPendingRPC(id, throwing: CancellationError())
            }
        }
    }

    private func dropQueuedRPC(_ id: String) {
        RPCSendQueue.removeRPC(id, from: &pendingSends)
    }

    private func cancelPendingRPC(_ id: String, throwing error: Error) {
        dropQueuedRPC(id)
        guard let pending = pendingRPC.removeValue(forKey: id) else {
            return
        }
        pending.timeoutTask.cancel()
        pending.continuation.resume(throwing: error)
    }

    private func failPendingRPCs(_ error: Error) {
        let pending = pendingRPC
        pendingRPC.removeAll()
        pendingSends.removeAll { send in
            guard let rpcId = send.rpcId else {
                return false
            }
            return pending.keys.contains(rpcId)
        }
        for entry in pending.values {
            entry.timeoutTask.cancel()
            entry.continuation.resume(throwing: error)
        }
    }

    private func request<T: Decodable>(path: String) async throws -> T {
        if isRelayActive {
            let data = try await rpc(method: "GET", path: path)
            return try decoder.decode(T.self, from: data)
        }

        var request = try makeRequest(path: path)
        request.httpMethod = "GET"

        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response, data: data)
        return try decoder.decode(T.self, from: data)
    }

    private func post(path: String, body: [String: String]) async throws {
        if isRelayActive {
            _ = try await rpc(method: "POST", path: path, body: body)
            return
        }

        var request = try makeRequest(path: path)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response, data: data)
    }

    private func postAny(path: String, body: [String: Any]) async throws {
        if isRelayActive {
            _ = try await rpc(method: "POST", path: path, body: body)
            return
        }

        var request = try makeRequest(path: path)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response, data: data)
    }

    private func deleteAny(path: String, body: [String: Any]) async throws {
        if isRelayActive {
            _ = try await rpc(method: "DELETE", path: path, body: body)
            return
        }

        var request = try makeRequest(path: path)
        request.httpMethod = "DELETE"
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response, data: data)
    }

    private func postDecodingAny<T: Decodable>(path: String, body: [String: Any]) async throws -> T {
        if isRelayActive {
            let data = try await rpc(method: "POST", path: path, body: body)
            return try decoder.decode(T.self, from: data)
        }

        var request = try makeRequest(path: path)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response, data: data)
        return try decoder.decode(T.self, from: data)
    }

    private func patchDecodingAny<T: Decodable>(path: String, body: [String: Any]) async throws -> T {
        if isRelayActive {
            let data = try await rpc(method: "PATCH", path: path, body: body)
            return try decoder.decode(T.self, from: data)
        }

        var request = try makeRequest(path: path)
        request.httpMethod = "PATCH"
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response, data: data)
        return try decoder.decode(T.self, from: data)
    }

    private func postDecoding<T: Decodable>(path: String, body: [String: String]) async throws -> T {
        if isRelayActive {
            let data = try await rpc(method: "POST", path: path, body: body)
            return try decoder.decode(T.self, from: data)
        }

        var request = try makeRequest(path: path)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response, data: data)
        return try decoder.decode(T.self, from: data)
    }

    private func makeRequest(path: String) throws -> URLRequest {
        guard !isRelayActive else {
            throw PerchClientError.relayRequiresWebSocket
        }
        guard let base = URL(string: serverURL), let url = URL(string: path, relativeTo: base) else {
            throw PerchClientError.invalidURL
        }

        var request = URLRequest(url: url)
        // Short timeout so a dead endpoint (network changed since pairing)
        // fails fast into endpoint re-probing instead of hanging 60s.
        request.timeoutInterval = 8
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return request
    }

    private func validate(_ response: URLResponse, data: Data) throws {
        guard let httpResponse = response as? HTTPURLResponse else {
            throw PerchClientError.invalidResponse
        }

        guard (200..<300).contains(httpResponse.statusCode) else {
            let body = try? decoder.decode(ErrorResponse.self, from: data)
            throw PerchClientError.httpStatus(httpResponse.statusCode, body?.error)
        }
    }

    private func receiveSocketMessage() {
        guard let task = webSocketTask else {
            return
        }
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, task === self.webSocketTask else {
                    // A cancelled/replaced socket's in-flight callback must
                    // never tear down or reconnect the current connection.
                    return
                }

                switch result {
                case let .success(message):
                    self.connectionState = "Live"
                    self.noteConnected()
                    self.handle(message)
                    self.receiveSocketMessage()
                case let .failure(error):
                    self.connectionState = error.localizedDescription
                    self.failPendingRPCs(error)
                    self.scheduleReconnect()
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let data: Data?

        switch message {
        case let .data(messageData):
            data = messageData
        case let .string(text):
            data = text.data(using: .utf8)
        @unknown default:
            data = nil
        }

        guard let data else {
            return
        }

        // Encrypted transport: unwrap the frame before decoding. Handshake acks
        // are handled here; only decrypted plaintext reaches the payload decoder.
        if let channel {
            guard let text = String(data: data, encoding: .utf8) else {
                return
            }
            switch channel.receive(text) {
            case .ready:
                onE2eeReady()
            case .ignore:
                break
            case let .plaintext(plain):
                decodePayload(plain)
            case .fatal:
                // A frame we cannot decrypt means the peer is out of sync; drop
                // the socket and reconnect, which renegotiates a fresh channel.
                webSocketTask?.cancel(with: .goingAway, reason: nil)
                webSocketTask = nil
                failPendingRPCs(PerchClientError.connectionReset)
                scheduleReconnect()
            }
            return
        }

        decodePayload(data)
    }

    private func decodePayload(_ data: Data) {
        if handleRPCResponse(data) {
            return
        }

        if let payload = try? decoder.decode(WebSocketPayload.self, from: data) {
            switch payload {
            case let .event(event):
                self.appendEvent(event)
            case let .fleet(sessions):
                self.sessions = sessions
                // The task ledger has no live stream; ride the fleet frame
                // (already coalesced server-side) with a throttled refetch so
                // crew rows appear without a pull-to-refresh.
                self.refreshTasksThrottled()
            case .hello:
                break
            }
        }
    }

    private func handleRPCResponse(_ data: Data) -> Bool {
        guard
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            object["type"] as? String == "rpc_response",
            let id = object["id"] as? String
        else {
            return false
        }

        guard let pending = pendingRPC.removeValue(forKey: id) else {
            return true
        }
        pending.timeoutTask.cancel()

        let status = object["status"] as? Int ?? 500
        let ok = object["ok"] as? Bool ?? false
        if ok {
            let bodyObject = object["body"] ?? [:]
            let bodyData: Data
            if JSONSerialization.isValidJSONObject(bodyObject),
               let encoded = try? JSONSerialization.data(withJSONObject: bodyObject) {
                bodyData = encoded
            } else {
                bodyData = Data("{}".utf8)
            }
            pending.continuation.resume(returning: bodyData)
        } else {
            pending.continuation.resume(
                throwing: PerchClientError.httpStatus(status, object["error"] as? String)
            )
        }
        return true
    }

    private var lastTasksFetch = Date.distantPast

    private func refreshTasksThrottled() {
        guard Date().timeIntervalSince(lastTasksFetch) > 2 else { return }
        lastTasksFetch = Date()
        Task {
            if let result: TasksResult = try? await self.request(path: "/tasks") {
                self.tasks = result.tasks
            }
            // Projects ride the same cadence: on the relay path refresh()
            // never runs its HTTP block, so this is where the mate panel's
            // scope headers get their data.
            if let result: ProjectsResult = try? await self.request(path: "/projects") {
                self.projects = result.projects
            }
            // Charts too - the relay path's only pull besides the WS message.
            if let result: ChartsResult = try? await self.request(path: "/charts") {
                self.charts = result.charts
            }
        }
    }

    private func appendEvent(_ event: AgentEvent) {
        // Raw PTY frames (snapshots and deltas) have no UI on the phone: the
        // chat timeline is the only session surface. They decode and drop.
        switch event {
        case let .timelineItem(sessionId, item, _):
            handleLiveTimelineItem(sessionId, item)
        case let .assistantStream(sessionId, itemId, text, done, _):
            handleAssistantStream(sessionId, itemId: itemId, text: text, done: done)
        case let .status(sessionId, status, _):
            if let updated = WorkspaceGrouping.applyingStatus(status, to: sessionId, in: sessions) {
                sessions = updated
            }
        case let .chart(_, chartId, _, _, _):
            // Registered or file changed: bump so an open review reloads, and
            // refetch the registry so cards appear/update without a pull.
            chartVersions[chartId, default: 0] += 1
            Task { await self.fetchCharts() }
        default:
            break
        }
    }

    // MARK: - Charts

    // Charts in one session's chat, oldest first (their place in the story):
    // the ones it drew, plus its crew's (the mate sees every chart the tasks
    // it dispatched produced).
    func chartsFor(_ sessionId: String) -> [ChartModel] {
        charts
            .filter { $0.sessionId == sessionId || $0.parentSessionId == sessionId }
            .sorted { $0.registeredAt < $1.registeredAt }
    }

    func isChartCardDismissed(_ chart: ChartModel) -> Bool {
        dismissedChartCardKeys.contains(chart.cardDismissalIdentity.key)
    }

    func dismissChartCard(_ chart: ChartModel) {
        dismissedChartCardKeys.insert(chart.cardDismissalIdentity.key)
        UserDefaults.standard.set(
            Array(dismissedChartCardKeys).sorted(),
            forKey: Self.dismissedChartCardKeysKey
        )
    }

    func fetchCharts() async {
        if let result: ChartsResult = try? await request(path: "/charts") {
            charts = result.charts
        }
    }

    // The unified hub listing (GET /charts/hub): charts and committed plans
    // grouped by project, plus ungrouped charts. Read on demand by the Charts
    // hub sheet; throws so the sheet can show an honest error state.
    func fetchChartsHub() async throws -> ChartsHubResponse {
        try await request(path: "/charts/hub")
    }

    // The chart document with the annotation SDK injected server-side. LAN
    // fetches the raw HTML route; the relay carries it as JSON over RPC.
    func chartHtml(_ chartId: String) async throws -> String {
        if isRelayActive {
            let result: ChartHtmlResult = try await rpcDecoding(
                method: "GET",
                path: "/charts/\(escapePath(chartId))/html"
            )
            return result.html
        }
        var request = try makeRequest(path: "/charts/\(escapePath(chartId))")
        request.httpMethod = "GET"
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response, data: data)
        guard let html = String(data: data, encoding: .utf8) else {
            throw PerchClientError.invalidResponse
        }
        return html
    }

    // A committed plan rendered as chart-styled HTML (GET /charts/plan?path=),
    // server-side path-confined to tracked projects' docs/plans. The document is
    // self-contained (chart.css inlined) so the phone loads one string, no
    // sibling-asset round-trips. Mirrors chartHtml: raw HTML on LAN, JSON over
    // the relay. Server endpoint lands in a parallel task; a 404 here means it
    // is not deployed yet.
    func planHtml(_ relativePath: String) async throws -> String {
        let query = relativePath.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? relativePath
        if isRelayActive {
            let result: ChartPlanHtmlResult = try await rpcDecoding(
                method: "GET",
                path: "/charts/plan?path=\(query)"
            )
            return result.html
        }
        var request = try makeRequest(path: "/charts/plan?path=\(query)")
        request.httpMethod = "GET"
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response, data: data)
        guard let html = String(data: data, encoding: .utf8) else {
            throw PerchClientError.invalidResponse
        }
        return html
    }

    // A chart-relative asset (chart.css, images), directory-confined
    // server-side. Base64 JSON on the relay; raw bytes on LAN.
    func chartAsset(_ chartId: String, path: String) async throws -> (data: Data, contentType: String) {
        if isRelayActive {
            let query = path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? path
            let result: ChartAssetResult = try await rpcDecoding(
                method: "GET",
                path: "/charts/\(escapePath(chartId))/asset64?path=\(query)"
            )
            guard let data = Data(base64Encoded: result.base64) else {
                throw PerchClientError.invalidResponse
            }
            return (data, result.contentType)
        }
        var request = try makeRequest(path: "/charts/\(escapePath(chartId))/\(escapePath(path))")
        request.httpMethod = "GET"
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response, data: data)
        let contentType = (response as? HTTPURLResponse)?
            .value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream"
        return (data, contentType)
    }

    // Send-only boss feedback: annotations + message become one composer block
    // in the owning session's PTY. The agent's reply is the chart changing.
    // Returns whether the server queued it behind an open permission prompt.
    func sendChartFeedback(
        _ chartId: String,
        message: String,
        annotations: [ChartAnnotationDraft]
    ) async throws -> Bool {
        var body: [String: Any] = [:]
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            body["message"] = trimmed
        }
        if !annotations.isEmpty {
            body["annotations"] = annotations.map { $0.payload.mapValues(\.jsonObject) }
        }
        let result: ChartFeedbackResult = try await postDecodingAny(
            path: "/charts/\(escapePath(chartId))/feedback",
            body: body
        )
        return result.queued ?? false
    }

    // The SDK's automated layout audit, relayed to the authoring agent as
    // machine feedback (deduped server-side). Best-effort by design.
    func reportChartLayoutWarnings(_ chartId: String, warnings: [Any]) async {
        guard JSONSerialization.isValidJSONObject(["w": warnings]) else { return }
        try? await postAny(
            path: "/charts/\(escapePath(chartId))/layout-warnings",
            body: ["layout_warnings": warnings]
        )
    }

    // Apply a live assistant-reply frame. Each frame carries the full text so
    // far (idempotent replace, so a dropped frame self-heals); a new itemId
    // starts a fresh reply. Empty text is ignored so an early done never paints
    // an empty bubble.
    private func handleAssistantStream(_ sessionId: String, itemId: String, text: String, done: Bool) {
        guard !text.isEmpty else {
            return
        }
        // The finished message may persist from the tail before its `done` frame
        // arrives; if the reply already landed verbatim, don't resurrect a
        // duplicate preview beside it.
        if let last = timelinesBySession[sessionId]?.last(where: { $0.kind == .assistant }),
           last.text == text {
            streamingBySession[sessionId] = nil
            return
        }
        streamingBySession[sessionId] = StreamingReply(itemId: itemId, text: text, done: done)
    }

    private func escapePath(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }

    private static let serverOfflineMessage = "Perch server is not running. Start Perch on your computer."

    private func isServerUnavailable(_ error: Error) -> Bool {
        guard let urlError = error as? URLError else { return false }
        switch urlError.code {
        case .cannotConnectToHost, .networkConnectionLost, .notConnectedToInternet, .timedOut:
            return true
        default:
            return false
        }
    }

    private func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError {
            return true
        }
        if let urlError = error as? URLError {
            return urlError.code == .cancelled
        }
        let nsError = error as NSError
        return nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled
    }
}

enum WebSocketPayload: Decodable {
    case hello
    case event(AgentEvent)
    case fleet([AgentSession])

    private enum CodingKeys: String, CodingKey {
        case type
        case event
        case sessions
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "hello":
            self = .hello
        case "event":
            self = .event(try container.decode(AgentEvent.self, forKey: .event))
        case "fleet":
            // Lossy element decode: one undecodable session (append-only
            // protocol drift, server bug) must not discard the whole fleet.
            var nested = try container.nestedUnkeyedContainer(forKey: .sessions)
            var sessions: [AgentSession] = []
            while !nested.isAtEnd {
                do {
                    sessions.append(try nested.decode(AgentSession.self))
                } catch {
                    #if DEBUG
                    print("Perch: dropped undecodable fleet session: \(error)")
                    #endif
                    let index = nested.currentIndex
                    _ = try? nested.decode(DiscardedElement.self)
                    if nested.currentIndex == index {
                        break
                    }
                }
            }
            self = .fleet(sessions)
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unsupported socket payload: \(type)"
            )
        }
    }
}

// Consumes one unkeyed-container element of any JSON shape so a lossy array
// decode can skip past it.
private struct DiscardedElement: Decodable {
    init(from decoder: Decoder) {}
}

struct ErrorResponse: Decodable {
    let error: String
}

struct AttachmentResponse: Decodable {
    let path: String
    let filename: String
}

enum PerchClientError: LocalizedError {
    case invalidURL
    case invalidResponse
    case httpStatus(Int, String?)
    case relayRequiresWebSocket
    case connectionReset
    case rpcTimeout

    var httpStatusCode: Int? {
        if case let .httpStatus(status, _) = self { return status }
        return nil
    }

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            "Invalid server URL"
        case .invalidResponse:
            "Invalid server response"
        case let .httpStatus(status, message):
            message ?? "Request failed with \(status)"
        case .relayRequiresWebSocket:
            "Relay endpoints are WebSocket-only"
        case .connectionReset:
            "Connection reset"
        case .rpcTimeout:
            "Request timed out"
        }
    }
}


// Hashable navigation payload for programmatic session opens.
struct SessionRef: Identifiable, Hashable {
    let id: String
}


extension ISO8601DateFormatter {
    // Server timestamps carry fractional seconds; some paths do not, and a
    // single ISO8601DateFormatter cannot parse both shapes.
    // MainActor-bound: only the store's attention derivation uses these.
    @MainActor private static let perchFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    @MainActor private static let perchPlain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    @MainActor static func perchDate(from string: String) -> Date? {
        perchFractional.date(from: string) ?? perchPlain.date(from: string)
    }
}
