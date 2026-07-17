import SwiftUI

// The Charts hub: the browsable home for every chart and committed plan, opened
// from the "Charts" button on the mate composer row. One read source -
// GET /charts/hub - grouped by project, Draft/Finalized status within each
// group; charts that
// resolve to no tracked project get their own section. Tapping a chart opens the
// existing chart review room (store.openChart), so charts no longer need to
// stack in the transcript to stay reachable.
struct ChartsHubView: View {
    @EnvironmentObject private var store: PerchStore
    @Environment(\.dismiss) private var dismiss

    @State private var hub: ChartsHubResponse?
    @State private var loadError: String?
    @State private var loading = false
    // Project rootPaths whose plans disclosure is open. Plans collapse by
    // default so a fleet with many plans reads as a short, scannable list of
    // projects; the boss expands the one he wants.
    @State private var expandedPlans: Set<String> = []

    var body: some View {
        NavigationStack {
            ZStack {
                Style.canvas.ignoresSafeArea()
                content
            }
            .navigationTitle("Charts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .tint(Style.accent)
                }
            }
            .toolbarBackground(Style.canvas, for: .navigationBar)
        }
        .task { await load() }
    }

    @ViewBuilder
    private var content: some View {
        if let hub {
            if hub.projects.isEmpty && hub.ungrouped.isEmpty {
                emptyState
            } else {
                list(hub)
            }
        } else if let loadError {
            errorState(loadError)
        } else {
            ProgressView()
                .tint(Style.accent)
        }
    }

    private func list(_ hub: ChartsHubResponse) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                ForEach(hub.projects) { project in
                    projectSection(project)
                }
                if !hub.ungrouped.isEmpty {
                    ungroupedSection(hub.ungrouped)
                }
            }
            .padding(.horizontal, Style.pageInset)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .scrollIndicators(.hidden)
    }

    // MARK: - Sections

    private func projectSection(_ project: ChartsHubProject) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader(project.name.isEmpty ? shortRoot(project.rootPath) : project.name)
            // Charts stay visible inline (finalized first, then drafts); the
            // plans fold into a per-project disclosure so a long tail of plans
            // no longer buries the charts.
            ForEach(project.charts.sorted(by: chartOrder)) { chart in
                chartRow(chart)
            }
            if !project.plans.isEmpty {
                plansDisclosure(project)
            }
        }
    }

    // The collapsible "Plans" group for one project: a tappable header row
    // (count + rotating chevron) that expands to reveal the project's plan
    // rows, following the timeline's expand idiom.
    @ViewBuilder
    private func plansDisclosure(_ project: ChartsHubProject) -> some View {
        let expanded = expandedPlans.contains(project.id)
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) {
                    if expanded {
                        expandedPlans.remove(project.id)
                    } else {
                        expandedPlans.insert(project.id)
                    }
                }
            } label: {
                HStack(spacing: 12) {
                    RowIcon(systemName: "doc.on.doc")

                    VStack(alignment: .leading, spacing: 3) {
                        Text("Plans")
                            .font(.system(size: 16, weight: .semibold, design: .serif))
                            .foregroundStyle(Style.textPrimary)
                            .lineLimit(1)
                        Text(planCountLabel(project.plans.count))
                            .font(.system(size: 12))
                            .foregroundStyle(Style.textSecondary)
                            .lineLimit(1)
                    }

                    Spacer(minLength: 8)

                    Image(systemName: "chevron.down")
                        .font(.system(size: 12, weight: .semibold))
                        .rotationEffect(.degrees(expanded ? 180 : 0))
                        .foregroundStyle(Style.textFaint)
                }
                .padding(14)
                .background(Style.panel)
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(Style.hairline, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .buttonStyle(.plain)

            if expanded {
                // Indent the revealed rows so they read as contained by the
                // disclosure above them.
                ForEach(project.plans) { plan in
                    planRow(plan)
                }
                .padding(.leading, 14)
            }
        }
    }

    private func ungroupedSection(_ charts: [ChartModel]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader("Other charts")
            Text("Drawn outside a task, so not yet tied to a project.")
                .font(.system(size: 12))
                .foregroundStyle(Style.textFaint)
                .padding(.bottom, 2)
            ForEach(charts.sorted(by: chartOrder)) { chart in
                chartRow(chart)
            }
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 12, weight: .semibold))
            .tracking(1.2)
            .textCase(.uppercase)
            .foregroundStyle(Style.textSecondary)
            .lineLimit(1)
    }

    // MARK: - Rows

    private func chartRow(_ chart: ChartModel) -> some View {
        Button {
            // Reuse the existing chart room (fullScreenCover keyed on
            // store.openChart at the app root). Dismiss the hub first so the
            // room rises over the home surface, not stacked atop the sheet.
            dismiss()
            store.openChart = chart
        } label: {
            HStack(spacing: 12) {
                RowIcon(systemName: "doc.richtext")

                VStack(alignment: .leading, spacing: 3) {
                    Text(chartDisplayName(chart))
                        .font(.system(size: 16, weight: .semibold, design: .serif))
                        .foregroundStyle(Style.textPrimary)
                        .lineLimit(1)
                    HStack(spacing: 6) {
                        StatusChip(finalized: chart.isFinalized)
                        if let title = chart.taskTitle, !title.isEmpty {
                            Text(title)
                                .font(.system(size: 12))
                                .foregroundStyle(Style.textSecondary)
                                .lineLimit(1)
                        }
                    }
                }

                Spacer(minLength: 8)

                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Style.textFaint)
            }
            .padding(14)
            .background(Style.panel)
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(rowBorder(finalized: chart.isFinalized), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    // A committed implementation plan. Tapping opens the read-only plan room,
    // which renders the plan's markdown in the same chart styling
    // (GET /charts/plan?path=, server-rendered). Grouped under its project with
    // title + date.
    private func planRow(_ plan: ChartPlanDoc) -> some View {
        Button {
            dismiss()
            store.openPlan = plan
        } label: {
            HStack(spacing: 12) {
                RowIcon(systemName: "doc.plaintext")

                VStack(alignment: .leading, spacing: 3) {
                    Text(plan.title)
                        .font(.system(size: 16, weight: .semibold, design: .serif))
                        .foregroundStyle(Style.textPrimary)
                        .lineLimit(1)
                    HStack(spacing: 6) {
                        Text("Plan")
                            .font(.system(size: 11, weight: .semibold))
                            .tracking(0.4)
                            .foregroundStyle(Style.accent)
                        if let date = plan.date, let pretty = prettyDate(date) {
                            Text(pretty)
                                .font(.system(size: 12))
                                .foregroundStyle(Style.textSecondary)
                                .lineLimit(1)
                        }
                    }
                }

                Spacer(minLength: 8)

                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Style.textFaint)
            }
            .padding(14)
            .background(Style.panel)
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Style.hairline, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    // MARK: - States

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "doc.richtext")
                .font(.system(size: 34, weight: .regular))
                .foregroundStyle(Style.textFaint)
            Text("No charts yet")
                .font(.system(size: 19, weight: .semibold, design: .serif))
                .foregroundStyle(Style.textPrimary)
            Text("Charts the crew draws for review, and the plans they become, land here.")
                .font(.system(size: 14))
                .foregroundStyle(Style.textSecondary)
                .multilineTextAlignment(.center)
                .lineSpacing(2)
                .frame(maxWidth: 300)
        }
        .padding(.horizontal, Style.pageInset)
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 12) {
            Text("Couldn't load charts")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Style.textPrimary)
            Text(message)
                .font(.system(size: 13))
                .foregroundStyle(Style.textSecondary)
                .multilineTextAlignment(.center)
            Button("Retry") { Task { await load() } }
                .buttonStyle(.glass)
                .tint(Style.accent)
        }
        .padding(.horizontal, Style.pageInset)
    }

    // MARK: - Data

    private func load() async {
        guard !loading else { return }
        loading = true
        loadError = nil
        do {
            hub = try await store.fetchChartsHub()
        } catch {
            if hub == nil { loadError = error.localizedDescription }
        }
        loading = false
    }

    private func planCountLabel(_ count: Int) -> String {
        count == 1 ? "1 plan" : "\(count) plans"
    }

    // Finalized before draft; within a tier, most recently updated first.
    private func chartOrder(_ a: ChartModel, _ b: ChartModel) -> Bool {
        if a.isFinalized != b.isFinalized { return a.isFinalized }
        return a.updatedAt > b.updatedAt
    }
}

// A rounded accent-tinted glyph tile, shared by the hub's chart and plan rows
// (matches the transcript ChartCardRow's leading tile).
private struct RowIcon: View {
    let systemName: String

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Style.accent.opacity(0.12))
            Image(systemName: systemName)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(Style.accent)
        }
        .frame(width: 40, height: 40)
    }
}

// Draft vs Finalized pill. Finalized wears the gold; draft stays quiet.
private struct StatusChip: View {
    let finalized: Bool

    var body: some View {
        Text(finalized ? "Finalized" : "Draft")
            .font(.system(size: 11, weight: .semibold))
            .tracking(0.3)
            .foregroundStyle(finalized ? Style.accent : Style.textSecondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(
                Capsule().fill(finalized ? Style.accent.opacity(0.14) : Style.bubbleFill)
            )
            .overlay(
                Capsule().strokeBorder(
                    finalized ? Style.accent.opacity(0.4) : Style.hairline,
                    lineWidth: 1
                )
            )
    }
}

private func rowBorder(finalized: Bool) -> Color {
    finalized ? Style.accent.opacity(0.3) : Style.hairline
}

// "/Users/example/Desktop/perch" -> "perch": the trailing path component, so an
// unnamed project still reads sensibly in a section header.
private func shortRoot(_ rootPath: String) -> String {
    let trimmed = rootPath.hasSuffix("/") ? String(rootPath.dropLast()) : rootPath
    return trimmed.split(separator: "/").last.map(String.init) ?? rootPath
}

// "2026-07-08" -> "Jul 8, 2026". Falls back to the raw string on a parse miss.
private func prettyDate(_ iso: String) -> String? {
    let parser = DateFormatter()
    parser.locale = Locale(identifier: "en_US_POSIX")
    parser.dateFormat = "yyyy-MM-dd"
    guard let date = parser.date(from: iso) else { return iso }
    let out = DateFormatter()
    out.locale = Locale.current
    out.dateFormat = "MMM d, yyyy"
    return out.string(from: date)
}
