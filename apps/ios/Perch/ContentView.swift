import SwiftUI
import PhotosUI

// Design language (reference: minimal dark chat apps): near-black canvas,
// plain rows with hairline separators instead of heavy cards, one big bold
// title, round icon buttons, and a pill composer. The phone is chat-only:
// the real terminal stays on the desktop.
//
// "Oro Nero" palette: warm near-black surfaces, cream text, one sparing gold
// accent (the mate row, the running dot, primary interactive tint), olive for
// success, amber for attention, a deep warm red for errors. Every color in
// the app resolves through these tokens.
enum Style {
    // Surfaces.
    static let canvas = Color(red: 0.039, green: 0.035, blue: 0.031)          // #0A0908
    static let panel = Color(red: 0.078, green: 0.071, blue: 0.063)           // #141210
    static let hairline = Color(red: 0.165, green: 0.145, blue: 0.122)        // #2A251F
    static let secondaryFill = panel
    static let bubbleFill = Color(red: 0.129, green: 0.114, blue: 0.094)      // #211D18
    static let pageInset: CGFloat = 20

    // Text. Cream primary, warm dim secondary, warm faint tertiary - the
    // system grays read cold against the warm canvas.
    static let textPrimary = Color(red: 0.914, green: 0.886, blue: 0.816)     // #E9E2D0
    static let textSecondary = Color(red: 0.659, green: 0.624, blue: 0.549)   // #A89F8C
    static let textFaint = Color(red: 0.435, green: 0.408, blue: 0.353)       // #6F685A

    // Composer chrome: a softer rounded-rect (not a full pill) with a hairline
    // border that brightens on focus. Shared by both composers so they read
    // as the same control.
    static let composerRadius: CGFloat = 20
    static let composerFill = panel
    static let composerBorder = hairline
    static let composerBorderFocused = Color(red: 0.243, green: 0.216, blue: 0.176) // #3E372D

    // Gold accent - used SPARINGLY: the mate row highlight, the worker-liveness
    // "running" dot, and the primary interactive tint (links, question card,
    // copy confirmation). If a screen shows more than a couple of gold
    // elements, something is mis-tokened.
    static let accent = Color(red: 0.788, green: 0.635, blue: 0.153)          // #C9A227
    // The mate row's tile: a dark gold ground under the gold glyph.
    static let mateFill = Color(red: 0.169, green: 0.137, blue: 0.063)        // #2B2310

    // Status hues. Base colors carry chips/fills; the *Text variants keep chip
    // labels and small text readable on the dark ground.
    static let success = Color(red: 0.353, green: 0.478, blue: 0.290)         // #5A7A4A
    static let successText = Color(red: 0.616, green: 0.741, blue: 0.541)     // #9DBD8A
    static let warning = Color(red: 0.788, green: 0.541, blue: 0.153)         // #C98A27
    static let warningText = Color(red: 0.878, green: 0.675, blue: 0.333)     // #E0AC55
    static let error = Color(red: 0.557, green: 0.184, blue: 0.133)           // #8E2F22
    static let errorText = Color(red: 0.855, green: 0.478, blue: 0.400)       // #DA7A66
    // Idle/waiting liveness dot: present but quiet.
    static let dotIdle = Color(red: 0.231, green: 0.204, blue: 0.165)         // #3B342A

    // Dictation level meter: the bars live inside the composer capsule where
    // the text would be, so they stay in the same quiet cream/dim family as
    // the type around them (opacity carries the loudness).
    static let meterBar = textPrimary

    // Code + terminal surfaces in the chat timeline: a slightly elevated panel
    // (body) with a faintly brighter header strip, hairline chrome, and calm
    // cream mono text. Shared by fenced code blocks and expanded tool
    // detail so code and commands read consistently.
    static let codeSurface = panel
    static let codeHeader = Color(red: 0.098, green: 0.086, blue: 0.075)      // #191613
    static let codeText = textPrimary
    // Inline code: a calm chip (subtle fill + cream) instead of a loud tint,
    // so it reads as distinct-but-quiet in running prose.
    static let inlineCodeFill = Color(red: 0.149, green: 0.125, blue: 0.098)  // #262019
    static let inlineCodeText = textPrimary
}

struct ContentView: View {
    let pushCoordinator: PushCoordinator
    @StateObject private var store = PerchStore()
    @State private var showPairSheet = false
    @State private var showRepairConfirm = false
    @State private var repairOfferText = ""
    @State private var repairOfferName = ""
    @State private var showUsageSheet = false
    @Environment(\.scenePhase) private var scenePhase

    // E2E affordances (mirror -PerchPairOffer / -PerchOpenSession). A capture
    // run stays clear of the one-time push-permission prompt so screenshots are
    // clean; -PerchOpenUsage additionally deep-opens the usage sheet.
    private var screenshotRun: Bool {
        UserDefaults.standard.bool(forKey: "PerchScreenshots")
            || UserDefaults.standard.bool(forKey: "PerchOpenUsage")
    }
    private var openUsageOnLaunch: Bool {
        UserDefaults.standard.bool(forKey: "PerchOpenUsage")
    }

    var body: some View {
        NavigationStack {
            HomeView(showPairSheet: $showPairSheet, showUsageSheet: $showUsageSheet)
                .environmentObject(store)
                // Item-based: at most ONE session view can ever exist, so
                // duplicate/raced pushes (the navigation-wedge class of bugs:
                // rapid back -> open-other, repeated deep links) are
                // impossible by construction. Row taps and deep links both
                // just set store.openSessionRef.
                .navigationDestination(item: $store.openSessionRef) { ref in
                    SessionDetailView(sessionId: ref.id)
                        .environmentObject(store)
                }
        }
        .tint(Style.accent)
        .sheet(isPresented: $showPairSheet) {
            PairView()
                .environmentObject(store)
        }
        // The chart room rides above whatever is open (home or a session):
        // card taps and future deep links both just set store.openChart.
        .fullScreenCover(item: $store.openChart) { chart in
            ChartReviewView(chart: chart)
                .environmentObject(store)
                .preferredColorScheme(.dark)
        }
        // A committed plan opened from the Charts hub: the same chart styling,
        // read-only (a plan has no owning session to send feedback to).
        .fullScreenCover(item: $store.openPlan) { plan in
            PlanReviewView(plan: plan)
                .environmentObject(store)
                .preferredColorScheme(.dark)
        }
        .task {
                pushCoordinator.store = store
                if store.isPaired && !screenshotRun {
                    PushCoordinator.registerIfAuthorizedOrAsk()
                }
            }
            .sheet(isPresented: $showUsageSheet) {
                // The sheet stands on its own even before a snapshot lands: it
                // renders an "unavailable right now" state rather than the whole
                // surface (button included) blinking out on a flaky read.
                UsageSheet()
                    .environmentObject(store)
                    .preferredColorScheme(.dark)
            }
            .onChange(of: showUsageSheet) { _, isPresented in
                guard isPresented else { return }
                Task { await store.fetchUsage(trigger: .sheetOpened) }
            }
            .onOpenURL { url in
            // perch://session/<id> routes straight into a session (push
            // notification taps); anything else is a pairing offer.
            if url.host == "session" {
                let sessionId = String(url.path.dropFirst())
                if !sessionId.isEmpty {
                    Task { await store.openSession(sessionId) }
                }
                return
            }
            // Already paired: a stray offer link must not silently replace the
            // stored host and token, so confirm before re-pairing.
            if store.isPaired {
                do {
                    let offer = try PairingOfferParser.parse(url.absoluteString)
                    repairOfferText = url.absoluteString
                    repairOfferName = offer.name
                    showRepairConfirm = true
                } catch {
                    store.errorMessage = error.localizedDescription
                }
                return
            }
            Task {
                do {
                    try await store.pair(offerText: url.absoluteString)
                    showPairSheet = false
                } catch {
                    store.errorMessage = error.localizedDescription
                }
            }
        }
        .alert("Replace pairing with \(repairOfferName)?", isPresented: $showRepairConfirm) {
            Button("Replace", role: .destructive) {
                let offerText = repairOfferText
                Task {
                    do {
                        try await store.pair(offerText: offerText)
                        showPairSheet = false
                    } catch {
                        store.errorMessage = error.localizedDescription
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This phone is paired with \(store.savedHost?.name ?? "another Mac"). Pairing again replaces that connection.")
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background:
                store.sceneDidBackground()
            case .active:
                Task { await store.sceneDidActivate() }
            default:
                break
            }
        }
        .task {
            if !store.isPaired,
               let offer = UserDefaults.standard.string(forKey: "PerchPairOffer") {
                try? await store.pair(offerText: offer)
            }
            await store.refresh()
            if let sessionId = UserDefaults.standard.string(forKey: "PerchOpenSession") {
                await store.openSession(sessionId)
            }
            // -PerchOpenChart <id> deep-opens the chart room (E2E/screenshots).
            if let chartId = UserDefaults.standard.string(forKey: "PerchOpenChart") {
                await store.fetchCharts()
                if let chart = store.charts.first(where: { $0.id == chartId }) {
                    store.openChart = chart
                }
            }
            if openUsageOnLaunch {
                showUsageSheet = true
            }
        }
    }
}

// MARK: - Home

// The project header a long-press picked for removal.
struct RemoveProjectCandidate: Identifiable {
    let name: String
    let path: String
    var id: String { path }
}

struct HomeView: View {
    @EnvironmentObject private var store: PerchStore
    @Binding var showPairSheet: Bool
    @Binding var showUsageSheet: Bool
    @FocusState private var composerFocused: Bool
    @State private var showNewAgent = false
    @State private var showAddProject = false
    // Long-press remove flow: the header's project, then the confirm, then
    // (only if the server refuses - live tasks) its message verbatim.
    @State private var removeCandidate: RemoveProjectCandidate?
    @State private var showRemoveConfirm = false
    @State private var removeRefusedMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Before pairing there is nothing to act on, so the header
            // controls (host menu, new session) only appear once connected.
            if store.isPaired {
                topBar
                    .padding(.horizontal, Style.pageInset)
                    .padding(.top, 16)
            }

            // The title labels the list; before pairing there is no list, so
            // the centered pairing hero owns the screen on its own.
            if store.isPaired {
                Text("Workspace")
                    .font(.system(size: 30, weight: .bold, design: .serif))
                    .padding(.horizontal, Style.pageInset)
                    .padding(.top, 30)
                    .padding(.bottom, 14)
            }

            if !store.isPaired {
                PairPrompt(showPairSheet: $showPairSheet)
            } else if !store.isServerLive && store.agentSessions.isEmpty && liveTasks.isEmpty {
                offlineState
            } else if store.agentSessions.isEmpty && liveTasks.isEmpty {
                emptyState
            } else {
                sessionList
            }

            footer
        }
        .background(Style.canvas.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $showNewAgent) {
            NewAgentSheet(initialPrompt: "")
                .environmentObject(store)
                .preferredColorScheme(.dark)
        }
        .sheet(isPresented: $showAddProject) {
            AddProjectSheet()
                .environmentObject(store)
                .preferredColorScheme(.dark)
        }
        .alert(
            "Remove \(removeCandidate?.name ?? "project")?",
            isPresented: $showRemoveConfirm,
            presenting: removeCandidate
        ) { candidate in
            Button("Remove", role: .destructive) {
                Task {
                    if let message = await store.removeProject(candidate.path) {
                        removeRefusedMessage = message
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("This only takes the project off Perch's list. The repo on disk is untouched.")
        }
        .alert(
            "Can't remove yet",
            isPresented: Binding(
                get: { removeRefusedMessage != nil },
                set: { if !$0 { removeRefusedMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(removeRefusedMessage ?? "")
        }
        .onAppear {
            // E2E hook (simulator has no way to tap into the sheet under
            // automation): -PerchOpenNewAgent auto-presents the New Agent sheet.
            if UserDefaults.standard.bool(forKey: "PerchOpenNewAgent") {
                showNewAgent = true
            }
            // Same hook for the Add project sheet.
            if UserDefaults.standard.bool(forKey: "PerchOpenAddProject") {
                showAddProject = true
            }
        }
    }

    private var topBar: some View {
        HStack(spacing: 12) {
            // Host avatar: tap for host actions; the tiny dot is connection
            // state so no text competes with the title.
            Menu {
                Button {
                    showPairSheet = true
                } label: {
                    Label(store.isPaired ? "Re-pair" : "Pair with Mac", systemImage: "qrcode.viewfinder")
                }
                Button {
                    Task { await store.refresh() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                if store.isPaired {
                    // Secondary path to the demoted one-off agent launcher
                    // (the primary one sits on the Solo agents header).
                    Button {
                        showNewAgent = true
                    } label: {
                        Label("New agent", systemImage: "plus")
                    }
                    Button(role: .destructive) {
                        store.unpair()
                    } label: {
                        Label("Unpair", systemImage: "xmark.circle")
                    }
                }
            } label: {
                // Warm avatar: a nero-to-warm gradient with a soft inner
                // shadow for depth, the cream initial in the serif display
                // face, and a restrained hairline gold ring - the row's one
                // accent (the gauge stays quiet).
                ZStack {
                    Circle()
                        .fill(
                            LinearGradient(
                                colors: [Style.bubbleFill, Style.canvas],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                            .shadow(.inner(color: .black.opacity(0.45), radius: 3, y: 1))
                        )
                    Circle()
                        .strokeBorder(Style.accent.opacity(0.55), lineWidth: 1)
                    Text(hostInitial)
                        .font(.system(size: 18, weight: .semibold, design: .serif))
                        // The Menu label inherits the gold tint; the avatar
                        // initial is identity, not an accent - keep it cream.
                        .foregroundStyle(Style.textPrimary)
                }
                .frame(width: 44, height: 44)
            }

            Spacer()

            // Host presence: a quiet capsule (panel fill, hairline border)
            // carrying the liveness dot and the Mac's name. Connected reads
            // calm; disconnected turns the dot amber.
            if store.isPaired {
                HStack(spacing: 7) {
                    Circle()
                        .fill(isLive ? Style.successText : Style.warningText)
                        .frame(width: 7, height: 7)
                    Text(store.savedHost?.name ?? "")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Style.textSecondary)
                }
                .padding(.horizontal, 13)
                .padding(.vertical, 8)
                .background(Style.panel, in: Capsule())
                .overlay(Capsule().strokeBorder(Style.hairline, lineWidth: 1))
            }

            // Plan headroom (Claude + Codex) is one tap away, not a card taking
            // up the home screen: a small gauge in the top-right opens the
            // detail. Present whenever paired - it must NOT depend on a live
            // snapshot, or a transient read failure makes the button vanish. The
            // panel itself conveys freshness/unavailability. Sized and chromed to
            // match the host capsule so the row reads as one bar.
            if store.isPaired {
                Button {
                    showUsageSheet = true
                } label: {
                    Image(systemName: "gauge.with.dots.needle.33percent")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Style.textSecondary)
                        .frame(width: 36, height: 36)
                        .background(Style.panel, in: Circle())
                        .overlay(Circle().strokeBorder(Style.hairline, lineWidth: 1))
                }
                .accessibilityLabel("Usage")
                .disabled(!store.isServerLive)
                .opacity(store.isServerLive ? 1 : 0.45)
            }
        }
    }

    private var hostInitial: String {
        String(store.savedHost?.name.prefix(1) ?? "P").uppercased()
    }

    private var isLive: Bool {
        store.isServerLive
    }

    // The crew: live tasks (ledger 1) joined with their worker sessions.
    private var liveTasks: [AgentTask] {
        store.tasks.filter { $0.state != "closed" }
    }

    // Sessions not owned by a live task keep their plain rows; the mate is
    // pinned above everything, never listed here.
    private var otherSessions: [AgentSession] {
        let otherIds = Set(WorkspaceGrouping.otherSessionIds(
            sessionIds: store.agentSessions.map(\.id),
            tasks: liveTasks,
            mateSessionId: store.mateSession?.id
        ))
        return store.agentSessions.filter { otherIds.contains($0.id) }
    }

    // The mate's scope, grouped by project: mate -> project -> tasks. Live
    // tasks nest as rows; known-but-idle projects (GET /projects, recency
    // order) render as bare headers - no counts, no roll-ups, no placeholder
    // copy; the list is the information.
    private var projectGroups: [WorkspaceProjectGroup<AgentTask>] {
        guard store.mateSession != nil else { return [] }
        return WorkspaceGrouping.scopedProjectGroups(
            liveTasks,
            knownProjects: store.projects.map(\.rootPath)
        )
    }

    // With no mate on deck the crew has nothing to nest under; those tasks
    // ride in Solo agents instead of vanishing.
    private var orphanTasks: [AgentTask] {
        store.mateSession == nil ? liveTasks : []
    }

    private var sessionList: some View {
        ScrollView {
            LazyVStack(spacing: 2) {
                if !store.isServerLive {
                    transportBanner
                }
                if let mate = store.mateSession {
                    Button {
                        store.openSessionRef = SessionRef(id: mate.id)
                    } label: {
                        MateRow(session: mate, hasUnseen: store.hasUnseenActivity(mate))
                    }
                    .buttonStyle(RowButtonStyle())
                    // The mate manages its scope: long-press to register a new
                    // project under it (each project header removes itself).
                    .contextMenu {
                        Button {
                            showAddProject = true
                        } label: {
                            Label("Add project", systemImage: "folder.badge.plus")
                        }
                    }

                    ForEach(projectGroups, id: \.project) { group in
                        projectHeader(group)
                        ForEach(group.tasks) { task in
                            nestedTaskRow(task)
                        }
                    }
                }

                // One-off agents for quick Q&A plus desktop/CLI-started
                // sessions: legitimate crew, just outside the mate flow. The
                // app is a window onto the fleet, not a filter. The header
                // always renders - it carries the "+" launcher, so with zero
                // solo agents it is the only way to start one.
                soloSectionHeader
                ForEach(orphanTasks) { task in
                    TaskRow(task: task, session: session(for: task))
                        .environmentObject(store)
                }
                ForEach(otherSessions) { session in
                    Button {
                        store.openSessionRef = SessionRef(id: session.id)
                    } label: {
                        SessionRow(session: session, hasUnseen: store.hasUnseenActivity(session))
                    }
                    .buttonStyle(RowButtonStyle())
                }
            }
            .padding(.top, 6)
            .padding(.horizontal, 8)
        }
        .refreshable {
            await store.refresh()
        }
        .scrollDismissesKeyboard(.interactively)
    }

    // Project sub-header: name + dim home-relative path. Nothing derived - no
    // task counts, no "N need you" chips (boss's constraint).
    private func projectHeader(_ group: WorkspaceProjectGroup<AgentTask>) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(group.name.uppercased())
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Style.textSecondary)
                .kerning(0.5)
            Text(WorkspaceGrouping.homeRelative(group.project))
                .font(.system(size: 11.5))
                .foregroundStyle(Style.textFaint)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 0)
        }
        .padding(.leading, 16)
        .padding(.trailing, 12)
        .padding(.top, 10)
        .padding(.bottom, 4)
        .contentShape(Rectangle())
        .contextMenu {
            Button(role: .destructive) {
                removeCandidate = RemoveProjectCandidate(name: group.name, path: group.project)
                showRemoveConfirm = true
            } label: {
                Label("Remove project", systemImage: "folder.badge.minus")
            }
        }
    }

    // A crew row nested under its project header, tied back to it with a
    // thread line in the leading gutter.
    private func nestedTaskRow(_ task: AgentTask) -> some View {
        TaskRow(task: task, session: session(for: task), showsProject: false)
            .environmentObject(store)
            .padding(.leading, 22)
            .overlay(alignment: .leading) {
                TaskThreadLine()
                    .stroke(Style.hairline, lineWidth: 1.5)
                    .frame(width: 13)
                    .padding(.leading, 16)
            }
    }

    private func session(for task: AgentTask) -> AgentSession? {
        if let runtimeSessionId = task.runtime?.ptySessionId, let session = store.sessionsById[runtimeSessionId] {
            return session
        }
        return task.sessionId.flatMap { store.sessionsById[$0] }
    }

    private var transportBanner: some View {
        HStack(spacing: 9) {
            ProgressView()
                .controlSize(.small)
                .tint(Style.warningText)
            VStack(alignment: .leading, spacing: 1) {
                Text(store.connectionState.hasPrefix("Reconnecting") ? "Reconnecting" : "Mac offline")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Style.textPrimary)
                Text("Showing the last server snapshot")
                    .font(.system(size: 11.5))
                    .foregroundStyle(Style.textFaint)
            }
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Style.warning.opacity(0.09), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Style.warning.opacity(0.28), lineWidth: 1))
        .padding(.horizontal, 4)
        .padding(.bottom, 4)
        .accessibilityElement(children: .combine)
    }

    // "Solo agents" carries the demoted one-off agent launcher: the mate
    // flow is the product, solo agents are for quick Q&A alongside it.
    // Serif display + cream marks it as a section of a different KIND than
    // the uppercase project sub-headers, so it stops blending in.
    private var soloSectionHeader: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Text("Solo agents")
                    .font(.system(size: 17, weight: .semibold, design: .serif))
                    .foregroundStyle(Style.textPrimary)
                Spacer()
                Button {
                    showNewAgent = true
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Style.textSecondary)
                        .frame(width: 24, height: 24)
                        .background(Style.secondaryFill, in: Circle())
                }
                .accessibilityLabel("New agent")
            }
            Text("Run an agent directly for one-off or exploratory tasks.")
                .font(.system(size: 12.5))
                .foregroundStyle(Style.textFaint)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 12)
        .padding(.top, 12)
        .padding(.bottom, 4)
    }

    // The no-mate empty state: the mate is the front door, so an empty fleet
    // asks for a mate (the Start-mate button rides in the footer below).
    private var emptyState: some View {
        VStack(spacing: 18) {
            Spacer()
            ZStack {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Style.secondaryFill)
                    .frame(width: 66, height: 66)
                Image(systemName: "sailboat.fill")
                    .font(.system(size: 26, weight: .regular))
                    .foregroundStyle(Style.textSecondary)
            }
            VStack(spacing: 7) {
                Text("No mate running")
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(Style.textPrimary)
                Text("The mate runs the crew for you. Start it below, or run `perch mate` on \(store.savedHost?.name ?? "your Mac").")
                    .font(.system(size: 14))
                    .foregroundStyle(Style.textFaint)
                    .multilineTextAlignment(.center)
                    .lineSpacing(2)
            }
            .frame(maxWidth: 300)
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, Style.pageInset)
    }

    private var offlineState: some View {
        VStack(spacing: 18) {
            Spacer()
            ZStack {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Style.secondaryFill)
                    .frame(width: 66, height: 66)
                Image(systemName: "wifi.exclamationmark")
                    .font(.system(size: 26, weight: .regular))
                    .foregroundStyle(Style.warningText)
            }
            VStack(spacing: 7) {
                Text("Mac offline")
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(Style.textPrimary)
                Text("Perch server is not running. Start Perch on your computer, then refresh.")
                    .font(.system(size: 14))
                    .foregroundStyle(Style.textFaint)
                    .multilineTextAlignment(.center)
                    .lineSpacing(2)
            }
            .frame(maxWidth: 300)
            Button {
                Task { await store.refresh() }
            } label: {
                HStack(spacing: 8) {
                    if store.isLoading {
                        ProgressView()
                            .controlSize(.small)
                            .tint(.black)
                    } else {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 14, weight: .semibold))
                    }
                    Text(store.isLoading ? "Checking…" : "Refresh")
                        .font(.system(size: 16, weight: .semibold))
                }
                .frame(maxWidth: 240)
                .padding(.vertical, 13)
                .background(Style.textPrimary)
                .foregroundStyle(.black)
                .clipShape(Capsule())
            }
            .disabled(store.isLoading)
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, Style.pageInset)
    }

    @ViewBuilder
    private var footer: some View {
        VStack(spacing: 8) {
            // Errors ride above the composer, which only exists once paired.
            // Before pairing, pairing problems surface inside the pair sheet.
            if store.isPaired {
                if let error = store.errorMessage, !error.isEmpty {
                    Text(error)
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(Style.warningText)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, Style.pageInset)
                }
                // The composer has exactly one target: the mate. Without a
                // live one there is nothing to message, so the slot becomes
                // the Start-mate action instead.
                if !store.isServerLive {
                    EmptyView()
                } else if store.mateSession != nil {
                    HomeComposer(focused: $composerFocused)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 8)
                } else {
                    StartMateButton()
                        .padding(.horizontal, 12)
                        .padding(.bottom, 8)
                }
            }
        }
    }
}

// The L-shaped connector from a project header down into a nested crew row.
struct TaskThreadLine: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: 0, y: 0))
        path.addLine(to: CGPoint(x: 0, y: rect.midY - 7))
        path.addQuadCurve(
            to: CGPoint(x: 7, y: rect.midY),
            control: CGPoint(x: 0, y: rect.midY)
        )
        path.addLine(to: CGPoint(x: rect.width, y: rect.midY))
        return path
    }
}

// The no-mate footer action: start the fleet's one mate on the Mac. While
// starting: disabled + spinner; success surfaces the mate row via the normal
// refresh path.
struct StartMateButton: View {
    @EnvironmentObject private var store: PerchStore
    @State private var starting = false

    var body: some View {
        Button {
            guard !starting, store.isServerLive else { return }
            starting = true
            Task {
                _ = await store.startMate()
                starting = false
            }
        } label: {
            HStack(spacing: 8) {
                if starting {
                    ProgressView()
                        .controlSize(.small)
                        .tint(.black)
                } else {
                    Image(systemName: "sailboat.fill")
                        .font(.system(size: 15, weight: .semibold))
                }
                Text(starting ? "Starting mate…" : "Start mate")
                    .font(.system(size: 17, weight: .semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background(Style.textPrimary)
            .foregroundStyle(.black)
            .clipShape(Capsule())
        }
        .disabled(starting || !store.isServerLive)
        .opacity(store.isServerLive ? 1 : 0.55)
    }
}

// The boss's channel: home messages go to the mate, which dispatches crew
// itself. The composer only renders with a live mate (the footer swaps in the
// Start-mate action otherwise), so it has exactly one target.
struct HomeComposer: View {
    @EnvironmentObject private var store: PerchStore
    var focused: FocusState<Bool>.Binding
    @State private var text = ""
    @State private var sending = false
    @State private var showChartsHub = false
    @StateObject private var dictation = VoiceDictation()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Controls row: the mate's model picker sits at the left (parity with
            // the session composer), the Charts hub button is right-aligned.
            HStack(spacing: 10) {
                if let mate = store.mateSession {
                    ModelChip(sessionId: mate.id, agent: mate.agent)
                        .padding(.leading, 8)
                }

                Spacer(minLength: 8)

                Button {
                    showChartsHub = true
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "chart.bar.doc.horizontal")
                            .font(.system(size: 13, weight: .semibold))
                        Text("Charts")
                            .font(.system(size: 13, weight: .medium))
                    }
                    .foregroundStyle(Style.textSecondary)
                }
                .buttonStyle(.plain)
                .padding(.trailing, 8)
            }

            HStack(spacing: 10) {
                if dictation.isActive {
                    DictationRecordingRow(dictation: dictation)
                } else {
                    TextField("Message the mate…", text: $text, axis: .vertical)
                        .textFieldStyle(.plain)
                        .lineLimit(1...7)
                        .font(.system(size: 17))
                        .tint(Style.accent)
                        .focused(focused)

                    if focused.wrappedValue {
                        Button {
                            focused.wrappedValue = false
                        } label: {
                            ZStack {
                                Circle()
                                    .fill(Style.secondaryFill)
                                Image(systemName: "keyboard.chevron.compact.down")
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(Style.textSecondary)
                            }
                            .frame(width: 38, height: 38)
                        }
                        .accessibilityLabel("Dismiss keyboard")
                    } else {
                        VoiceDictationButton(dictation: dictation, text: $text) {
                            focused.wrappedValue = true
                        }
                    }

                    Button(action: send) {
                        ZStack {
                            Circle()
                                .fill(canSend ? Style.textPrimary : Style.secondaryFill)
                            if sending {
                                ProgressView()
                                    .controlSize(.small)
                            } else {
                                Image(systemName: "arrow.up")
                                    .font(.system(size: 16, weight: .bold))
                                    .foregroundStyle(canSend ? Color.black : Style.textSecondary)
                            }
                        }
                        .frame(width: 38, height: 38)
                    }
                    .disabled(!canSend || sending)
                }
            }
            .padding(.leading, 18)
            .padding(.trailing, 7)
            .padding(.vertical, 8)
            .background(Style.composerFill, in: RoundedRectangle(cornerRadius: Style.composerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Style.composerRadius, style: .continuous)
                    .strokeBorder(focused.wrappedValue ? Style.composerBorderFocused : Style.composerBorder, lineWidth: 1)
            )
            .animation(.snappy(duration: 0.22, extraBounce: 0.02), value: text)
            .animation(.snappy(duration: 0.22, extraBounce: 0.02), value: dictation.isActive)
            .animation(.easeOut(duration: 0.16), value: focused.wrappedValue)
            .dictationLifecycle(dictation)
        }
        .sheet(isPresented: $showChartsHub) {
            ChartsHubView()
                .environmentObject(store)
                .preferredColorScheme(.dark)
        }
    }

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        guard canSend, !sending else { return }
        sending = true
        let prompt = text
        Task {
            let ok = await store.sendToMate(prompt)
            // Keep the typed prompt when the send failed (Mac unreachable):
            // clearing it would destroy the user's kickoff message.
            if ok {
                text = ""
            }
            sending = false
        }
    }
}

struct PairPrompt: View {
    @Binding var showPairSheet: Bool

    var body: some View {
        VStack(spacing: 20) {
            Spacer()

            ZStack {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Style.secondaryFill)
                    .frame(width: 66, height: 66)
                Image(systemName: "laptopcomputer.and.iphone")
                    .font(.system(size: 26, weight: .regular))
                    .foregroundStyle(Style.textSecondary)
            }

            VStack(spacing: 8) {
                Text("Run a fleet of agents from your pocket")
                    .font(.system(size: 22, weight: .semibold, design: .serif))
                    .foregroundStyle(Style.textPrimary)
                    .multilineTextAlignment(.center)
                Text("Talk to one mate - it runs agents across all your projects.")
                    .font(.system(size: 15))
                    .foregroundStyle(Style.textSecondary)
                    .multilineTextAlignment(.center)
                    .lineSpacing(2)
            }
            .frame(maxWidth: 320)

            Button {
                showPairSheet = true
            } label: {
                Text("Pair with your Mac")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(Style.textPrimary)
                    .foregroundStyle(.black)
                    .clipShape(Capsule())
            }
            .padding(.top, 4)

            Text("Run `perch pair` on your Mac to get started.")
                .font(.system(size: 13))
                .foregroundStyle(Style.textFaint)

            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, Style.pageInset)
    }
}

// Where the agent is working: "branch · path". Treehouse pool worktrees
// shorten to their slot; home-relative paths shorten to ~.
func sessionWorkContext(_ session: AgentSession) -> String? {
    let parts = [session.branch, sessionShortPath(session)].compactMap { $0 }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
}

private func sessionShortPath(_ session: AgentSession) -> String? {
    guard let cwd = session.cwd, !cwd.isEmpty else { return nil }
    if let range = cwd.range(of: "/.treehouse/") {
        let tail = cwd[range.upperBound...].split(separator: "/")
        if tail.count >= 3 {
            return "treehouse/\(tail[1])/\(tail[2...].joined(separator: "/"))"
        }
    }
    var path = cwd
    if let match = path.range(of: "^/Users/[^/]+", options: .regularExpression) {
        path = "~" + path[match.upperBound...]
    }
    let components = path.split(separator: "/")
    if components.count > 4 {
        return "…/" + components.suffix(3).joined(separator: "/")
    }
    return path
}

struct SessionRow: View {
    let session: AgentSession
    var hasUnseen = false

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            AgentGlyph(agent: session.agent)

            VStack(alignment: .leading, spacing: 2) {
                Text(displayTitle)
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(isEnded ? Style.textSecondary : Style.textPrimary)
                    .lineLimit(1)
                if let context = workContext {
                    Text(context)
                        .font(.system(size: 12.5))
                        .foregroundStyle(Style.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }

            Spacer(minLength: 8)

            statusLabel

            Image(systemName: "chevron.right")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Style.textFaint)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 15)
        .contentShape(Rectangle())
    }

    private var isEnded: Bool {
        session.status == .done || session.status == .error
    }

    private var displayTitle: String {
        sessionDisplayTitle(session)
    }

    private var workContext: String? {
        sessionWorkContext(session)
    }

    // The shared dot vocabulary; liveness wins the channel here, unseen shows
    // only while the session is quiet.
    @ViewBuilder
    private var statusLabel: some View {
        switch session.status {
        case .needsApproval, .running, .error:
            WorkerStatusDot(status: session.status)
        case .waiting, .idle, .done, .unknown:
            if hasUnseen {
                UnseenDot()
            } else {
                WorkerStatusDot(status: session.status)
            }
        }
    }
}

// The mate's pinned row: the fleet's front door. Distinct from plain agents
// so the boss always knows where the helm is.
struct MateRow: View {
    let session: AgentSession
    let hasUnseen: Bool

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Style.mateFill)
                Image(systemName: "sailboat.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Style.accent)
            }
            .frame(width: 30, height: 30)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 7) {
                    Text("Mate")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Style.textPrimary)

                    if let badge = mateModelBadgeLabel(for: session) {
                        MateModelBadge(label: badge)
                    }
                }
                Text("Runs the crew for you")
                    .font(.system(size: 12.5))
                    .foregroundStyle(Style.textSecondary)
            }

            Spacer(minLength: 8)

            // Same dot vocabulary; an approval gate is attention and always
            // surfaces, then unseen wins over plain liveness on the mate row.
            if session.status == .needsApproval {
                WorkerStatusDot(status: .needsApproval)
            } else if hasUnseen {
                UnseenDot()
            } else {
                WorkerStatusDot(status: session.status)
            }

            Image(systemName: "chevron.right")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Style.textFaint)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 15)
        .contentShape(Rectangle())
    }
}

private struct MateModelBadge: View {
    let label: String

    var body: some View {
        Text(label)
            .font(.system(size: 11, weight: .semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.86)
            .truncationMode(.tail)
            .foregroundStyle(Style.accent)
            .padding(.horizontal, 7)
            .frame(height: 21)
            .background(
                Capsule(style: .continuous)
                    .fill(Style.accent.opacity(0.11))
                    .overlay(
                        Capsule(style: .continuous)
                            .stroke(Style.accent.opacity(0.23), lineWidth: 1)
                    )
            )
            .accessibilityLabel("Mate model \(label)")
    }
}

private func mateModelBadgeLabel(for session: AgentSession) -> String? {
    guard let model = session.model, !model.isEmpty else { return nil }
    let label = (session.modelLabel?.isEmpty == false ? session.modelLabel : nil) ?? friendlyModelName(model)
    guard session.agent == .codex, let effort = session.effort, !effort.isEmpty else {
        return label
    }
    return "\(label) \(friendlyCodexEffortName(effort))"
}

private func friendlyCodexEffortName(_ effort: String) -> String {
    switch effort.lowercased() {
    case "xhigh":
        return "Extra High"
    case "none":
        return "No Effort"
    case "minimal":
        return "Minimal"
    case "low":
        return "Low"
    case "medium":
        return "Medium"
    case "high":
        return "High"
    default:
        return effort
            .split { $0 == "-" || $0 == "_" || $0 == " " }
            .map { $0.capitalized }
            .joined(separator: " ")
    }
}

// One dot vocabulary for worker liveness across the whole app (task rows,
// mate row, Solo agents): running = bright pulsing blue, needs_approval =
// amber, error = red, idle/waiting = faint, done/none = nothing. Never text -
// the badge says task state, the dot says worker liveness.
struct WorkerStatusDot: View {
    let status: AgentSessionStatus?

    var body: some View {
        switch status {
        case .needsApproval:
            dot(Style.warning)
        case .running:
            PulsingDot()
        case .error:
            dot(Style.errorText)
        case .idle, .waiting, .unknown:
            dot(Style.dotIdle)
        case .done, nil:
            EmptyView()
        }
    }

    private func dot(_ color: Color) -> some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
    }
}

// "Actively running": a bright dot with a subtle pulse.
private struct PulsingDot: View {
    @State private var pulsing = false

    var body: some View {
        Circle()
            .fill(Style.accent)
            .frame(width: 8, height: 8)
            .opacity(pulsing ? 1 : 0.5)
            .animation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: pulsing)
            .onAppear { pulsing = true }
    }
}

// Unseen-activity indicator: a distinct channel from worker liveness.
struct UnseenDot: View {
    var body: some View {
        Circle()
            .fill(Style.successText)
            .frame(width: 8, height: 8)
    }
}

struct AgentGlyph: View {
    let agent: AgentKind

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Style.secondaryFill)
            if let asset = assetName {
                Image(asset)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 19, height: 19)
            } else {
                Text(letter)
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                    .foregroundStyle(tint.opacity(0.9))
            }
        }
        .frame(width: 30, height: 30)
    }

    // Brand marks where we have them; letter tiles for the rest.
    private var assetName: String? {
        switch agent {
        case .claude: "claude-icon"
        case .codex: "codex-icon"
        default: nil
        }
    }

    private var letter: String {
        switch agent {
        case .claude: "C"
        case .codex: "X"
        case .shell: ">"
        case .unknown: "•"
        }
    }

    private var tint: Color {
        switch agent {
        case .claude: Color(red: 0.86, green: 0.58, blue: 0.35)
        case .codex: Style.textSecondary
        case .shell, .unknown: Style.textFaint
        }
    }
}

// Clean full-row press feedback: no dividers, the whole row lifts on a soft
// rounded highlight instead. Matches the list's 8pt side inset.
struct RowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Style.textPrimary.opacity(configuration.isPressed ? 0.05 : 0))
            )
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct RoundIcon: View {
    let systemName: String

    var body: some View {
        ZStack {
            Circle()
                .fill(Style.bubbleFill)
            Image(systemName: systemName)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(Style.textPrimary)
        }
        .frame(width: 44, height: 44)
    }
}

// MARK: - Session detail (chat-first)

struct SessionDetailView: View {
    @EnvironmentObject private var store: PerchStore
    @Environment(\.dismiss) private var dismiss
    let sessionId: String

    @State private var selectionToken = UUID()
    @State private var pickedPhotos: [PhotosPickerItem] = []
    @State private var uploadingPhoto = false
    @State private var showChartsHub = false
    @FocusState private var composerFocused: Bool
    @StateObject private var dictation = VoiceDictation()
    // The no-mistakes gate this session's task is parked on, if any (resolved
    // from the task's event log while the task is in needs_you).
    @State private var pendingGate: PendingGate?

    private var session: AgentSession? {
        store.session(for: sessionId)
    }

    // The task this session is the worker for (dispatched crew work).
    private var sessionTask: AgentTask? {
        store.tasks.first { $0.sessionId == sessionId }
    }

    // The mate's own chat: the Charts hub button lives on this composer, where
    // the boss actually chats with the mate.
    private var isMate: Bool {
        session?.labels?["role"] == "mate"
    }

    // Structured timeline recovery exists for claude (hooks + transcript
    // JSONL) and codex (hooks.json + rollout tailing); the remaining agents
    // get an honest placeholder until theirs land.
    private var hasChatSource: Bool {
        session.map { $0.agent == .claude || $0.agent == .codex } ?? true
    }

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, 12)
                .padding(.top, 6)
                .padding(.bottom, 10)
                .background(Style.canvas)

            if hasChatSource {
                TimelineChatView(sessionId: sessionId)
                    .environmentObject(store)
            } else {
                AgentChatPlaceholder(agent: session?.agent ?? .unknown)
            }

            bottomArea
        }
        .background(Style.canvas.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .task {
            await store.select(sessionId, token: selectionToken)
        }
        // Re-resolve the parked gate whenever the task's ledger moves (every
        // event bumps updatedAt, so re-parked gates and decisions recorded
        // elsewhere both retrigger through the tasks poll).
        .task(id: "\(sessionTask?.id ?? "none"):\(sessionTask?.updatedAt ?? "-")") {
            await refreshPendingGate()
        }
        .onDisappear {
            store.closeDetail(sessionId, token: selectionToken)
        }
    }

    // Resolve the gate this session's task is parked on: the latest
    // needs_decision event carrying findings, plus whether a decision note
    // already answers it on the ledger.
    private func refreshPendingGate() async {
        guard let task = sessionTask, task.state == "needs_you" else {
            pendingGate = nil
            return
        }
        let events = await store.taskEvents(task.id)
        guard let gateEvent = events.last(where: { $0.kind == "needs_decision" && $0.data?.noMistakes != nil }),
              let gate = gateEvent.data?.noMistakes else {
            pendingGate = nil
            return
        }
        let answered = events.contains { $0.seq > gateEvent.seq && $0.data?.noMistakesDecision != nil }
        pendingGate = PendingGate(taskId: task.id, gate: gate, eventSeq: gateEvent.seq, answered: answered)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Button {
                // Resign the composer before popping: a text field that keeps
                // first-responder through a pop transition can wedge
                // hit-testing (found via lldb on a frozen session).
                composerFocused = false
                dismiss()
            } label: {
                RoundIcon(systemName: "chevron.left")
            }

            Spacer()

            VStack(spacing: 1) {
                Text(session.map { titleFor($0) } ?? "Agent")
                    .font(.system(size: 18, weight: .semibold))
                    .lineLimit(1)
                if let session, let description = workDescriptionFor(session) {
                    Text(description)
                        .font(.system(size: 12))
                        .foregroundStyle(Style.textSecondary)
                        .lineLimit(1)
                }
                if let session, let context = sessionWorkContext(session) {
                    Text(context)
                        .font(.system(size: 12))
                        .foregroundStyle(Style.textFaint)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }

            Spacer()

            Menu {
                Button {
                    Task { await store.interrupt(sessionId) }
                } label: {
                    Label("Interrupt (Ctrl+C)", systemImage: "stop.circle")
                }
                Button(role: .destructive) {
                    Task {
                        if await store.stopSession(sessionId) {
                            dismiss()
                        }
                    }
                } label: {
                    Label("Stop session", systemImage: "xmark.octagon")
                }
            } label: {
                RoundIcon(systemName: "ellipsis")
            }
        }
    }

    private func titleFor(_ session: AgentSession) -> String {
        sessionTask?.workerName ?? session.workerName ?? sessionDisplayTitle(session)
    }

    // When the worker name takes the title slot, the task title moves here so
    // the header keeps the work description; title-led sessions need nothing.
    private func workDescriptionFor(_ session: AgentSession) -> String? {
        if let task = sessionTask, task.workerName != nil {
            return task.title
        }
        if session.workerName != nil {
            return sessionDisplayTitle(session)
        }
        return nil
    }

    @ViewBuilder
    private var bottomArea: some View {
        VStack(spacing: 8) {
            if let request = session?.pendingServerRequest {
                StructuredRequestCard(request: request) { decision, content in
                    await store.respondToServerRequest(
                        sessionId,
                        request: request,
                        decision: decision,
                        content: content
                    )
                }
                .padding(.horizontal, 12)
            } else if let approval = session?.pendingApproval {
                ApprovalCard(approval: approval) { decision in
                    await store.approve(sessionId, decision: decision, approvalId: approval.id)
                }
                .padding(.horizontal, 12)
            }

            // A parked no-mistakes gate renders as a native decision card while
            // the task needs the boss; answered from this phone, it collapses
            // to what was sent until the worker resumes; answered elsewhere
            // (the mate, another phone), no card. Non-no-mistakes
            // needs_decision moments keep today's rendering (no gate data,
            // no card).
            if let task = sessionTask, task.state == "needs_you",
               let pending = pendingGate, pending.taskId == task.id {
                if let summary = store.sentDecisions[pending.sentKey] {
                    SentDecisionChip(summary: summary)
                        .padding(.horizontal, 12)
                } else if !pending.answered {
                    DecisionChip(pending: pending) { action, findingIds, instructions in
                        let error = await store.decideTask(
                            task.id,
                            action: action,
                            findingIds: findingIds,
                            instructions: instructions
                        )
                        if error == nil {
                            store.sentDecisions[pending.sentKey] = decisionSummaryLabel(
                                action: action,
                                findingIds: findingIds
                            )
                        }
                        return error
                    }
                    .padding(.horizontal, 12)
                }
            }

            if let question = session?.pendingQuestion {
                QuestionChip(question: question) { selections in
                    await store.answer(sessionId, questionId: question.id, selections: selections)
                }
                .padding(.horizontal, 12)
            } else if let answered = store.answeredQuestions[sessionId],
                      (store.chatItems(sessionId).last(where: { $0.seq > 0 })?.seq ?? 0) <= answered.anchorSeq {
                // Just answered: the chip collapses to the chosen answers and
                // retires once the agent moves the conversation on.
                AnsweredQuestionChip(answered: answered)
                    .padding(.horizontal, 12)
            }

            if store.lastSubmitQueued || (session?.queuedCount ?? 0) > 0 {
                HStack(spacing: 6) {
                    Image(systemName: "clock")
                        .font(.system(size: 11, weight: .semibold))
                    Text("Queued - sends when the agent is free")
                        .font(.system(size: 12, weight: .medium))
                }
                .foregroundStyle(Style.warningText)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Style.pageInset)
            }

            // The switch already happened; this only warns that the agent is
            // reloading its context. Advisory, self-retiring, never a gate.
            if let hint = store.modelSwitchHintBySession[sessionId] {
                HStack(spacing: 6) {
                    Image(systemName: "hourglass")
                        .font(.system(size: 11, weight: .semibold))
                    Text(hint)
                        .font(.system(size: 12, weight: .medium))
                }
                .foregroundStyle(Style.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Style.pageInset)
                .transition(.opacity)
            }

            composer
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
        }
        .padding(.top, 6)
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            AttachmentBar(picked: $pickedPhotos, uploading: $uploadingPhoto)

            // Controls row: the model picker at the left; for the mate's own
            // chat the Charts hub button is right-aligned (parity with the home
            // composer, where the boss also reaches the mate).
            if (session?.agent == .claude || session?.agent == .codex) || isMate {
                HStack(spacing: 10) {
                    if let agent = session?.agent, agent == .claude || agent == .codex {
                        ModelChip(sessionId: sessionId, agent: agent)
                            .padding(.leading, 8)
                    }
                    if isMate {
                        Spacer(minLength: 8)
                        Button {
                            showChartsHub = true
                        } label: {
                            HStack(spacing: 5) {
                                Image(systemName: "chart.bar.doc.horizontal")
                                    .font(.system(size: 13, weight: .semibold))
                                Text("Charts")
                                    .font(.system(size: 13, weight: .medium))
                            }
                            .foregroundStyle(Style.textSecondary)
                        }
                        .buttonStyle(.plain)
                        .padding(.trailing, 8)
                    }
                }
            }

            HStack(spacing: 10) {
                if dictation.isActive {
                    DictationRecordingRow(dictation: dictation)
                } else {
                    AttachmentPickerButton(picked: $pickedPhotos, uploading: $uploadingPhoto)

                    TextField("Follow up…", text: $store.draft, axis: .vertical)
                        .textFieldStyle(.plain)
                        .lineLimit(1...7)
                        .font(.system(size: 17))
                        .tint(Style.accent)
                        .focused($composerFocused)
                        .onChange(of: composerFocused) { _, focused in
                            if focused {
                                store.markSeen(sessionId)
                            }
                        }
                        .onSubmit(sendDraft)

                    VoiceDictationButton(dictation: dictation, text: $store.draft) {
                        composerFocused = true
                    }

                    Button(action: sendDraft) {
                        ZStack {
                            Circle()
                                .fill(canSend ? Style.textPrimary : Style.secondaryFill)
                            Image(systemName: "arrow.up")
                                .font(.system(size: 15, weight: .bold))
                                .foregroundStyle(canSend ? Color.black : Style.textSecondary)
                        }
                        .frame(width: 38, height: 38)
                    }
                    .disabled(!canSend)
                }
            }
            .padding(.leading, 18)
            .padding(.trailing, 7)
            .padding(.vertical, 8)
            .background(Style.composerFill, in: RoundedRectangle(cornerRadius: Style.composerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Style.composerRadius, style: .continuous)
                    .strokeBorder(composerFocused ? Style.composerBorderFocused : Style.composerBorder, lineWidth: 1)
            )
            .animation(.snappy(duration: 0.22, extraBounce: 0.02), value: store.draft)
            .animation(.snappy(duration: 0.22, extraBounce: 0.02), value: dictation.isActive)
            .animation(.easeOut(duration: 0.16), value: composerFocused)
            .dictationLifecycle(dictation)
        }
        .sheet(isPresented: $showChartsHub) {
            ChartsHubView()
                .environmentObject(store)
                .preferredColorScheme(.dark)
        }
    }

    private var hasDraft: Bool {
        !store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var canSend: Bool {
        hasDraft || !store.pendingAttachments.isEmpty
    }

    private func sendDraft() {
        guard canSend else { return }
        Task { await store.sendDraftAndEnter() }
    }
}

// Honest placeholder for agents without structured chat recovery yet: no
// empty list, no thinking dots. The composer below stays live - text is
// still injected into the real TUI on the desktop.
struct AgentChatPlaceholder: View {
    let agent: AgentKind

    var body: some View {
        VStack {
            Spacer()
            VStack(alignment: .leading, spacing: 8) {
                Text("Chat for \(agentName) is coming soon")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Style.textSecondary)
                Text("This session keeps running in your terminal on the Mac. Messages you send below are typed straight into it.")
                    .font(.system(size: 13))
                    .foregroundStyle(Style.textFaint)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(Style.secondaryFill)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .padding(.horizontal, Style.pageInset)
            Spacer()
        }
    }

    private var agentName: String {
        switch agent {
        case .claude: "Claude"
        case .codex: "Codex"
        case .shell: "shell sessions"
        case .unknown: "this agent"
        }
    }
}

// "Claude - perch" -> "perch": the agent is already shown by the glyph.
func sessionDisplayTitle(_ session: AgentSession) -> String {
    let parts = session.title.split(separator: "-", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
    if parts.count == 2, parts[0].lowercased().contains(session.agent.rawValue) {
        return parts[1]
    }
    return session.title
}
