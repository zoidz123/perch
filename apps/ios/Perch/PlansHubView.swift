import SwiftUI

// The committed implementation plans grouped by project. The server response
// also carries deprecated chart data, which PlanModels intentionally ignores.
struct PlansHubView: View {
    @EnvironmentObject private var store: PerchStore
    @Environment(\.dismiss) private var dismiss

    @State private var hub: PlansHubResponse?
    @State private var loadError: String?
    @State private var loading = false

    var body: some View {
        NavigationStack {
            ZStack {
                Style.canvas.ignoresSafeArea()
                content
            }
            .navigationTitle("Plans")
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
            let projects = hub.projects.filter { !$0.plans.isEmpty }
            if projects.isEmpty {
                emptyState
            } else {
                list(projects)
            }
        } else if let loadError {
            errorState(loadError)
        } else {
            ProgressView()
                .tint(Style.accent)
        }
    }

    private func list(_ projects: [PlansHubProject]) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                ForEach(projects) { project in
                    projectSection(project)
                }
            }
            .padding(.horizontal, Style.pageInset)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .scrollIndicators(.hidden)
    }

    private func projectSection(_ project: PlansHubProject) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(project.name.isEmpty ? shortRoot(project.rootPath) : project.name)
                .font(.system(size: 12, weight: .semibold))
                .tracking(1.2)
                .textCase(.uppercase)
                .foregroundStyle(Style.textSecondary)
                .lineLimit(1)

            ForEach(project.plans) { plan in
                planRow(plan)
            }
        }
    }

    private func planRow(_ plan: PlanDocument) -> some View {
        Button {
            dismiss()
            store.openPlan = plan
        } label: {
            HStack(spacing: 12) {
                PlanRowIcon(systemName: "doc.plaintext")

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

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "doc.plaintext")
                .font(.system(size: 34, weight: .regular))
                .foregroundStyle(Style.textFaint)
            Text("No plans yet")
                .font(.system(size: 19, weight: .semibold, design: .serif))
                .foregroundStyle(Style.textPrimary)
            Text("Committed implementation plans will appear here.")
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
            Text("Couldn't load plans")
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

    private func load() async {
        guard !loading else { return }
        loading = true
        loadError = nil
        do {
            hub = try await store.fetchPlansHub()
        } catch {
            if hub == nil { loadError = error.localizedDescription }
        }
        loading = false
    }
}

private struct PlanRowIcon: View {
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

private func shortRoot(_ rootPath: String) -> String {
    let trimmed = rootPath.hasSuffix("/") ? String(rootPath.dropLast()) : rootPath
    return trimmed.split(separator: "/").last.map(String.init) ?? rootPath
}

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
