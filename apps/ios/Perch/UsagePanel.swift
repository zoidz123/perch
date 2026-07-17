import SwiftUI

// A glanceable read of how much of each agent plan is LEFT on the Mac - the
// mobile usage meter for the local Claude and Codex accounts. Reached from an unobtrusive
// gauge button in the top-right of the home screen (see ContentView); tapping
// opens the fuller breakdown below. Numbers are read locally on the Mac; when a
// source is unavailable the row says so rather than faking a level. Meters read
// as remaining, so a fuller bar means more headroom.

// Severity colors track remaining headroom, not brand: calm while there is
// plenty left, then warm, then hot as it runs out. Shared by the sheet meters.
private func severityColor(remaining: Double) -> Color {
    switch remaining {
    case ..<10: return Style.errorText
    case ..<30: return Style.warningText
    default: return Style.successText
    }
}

private func providerName(_ provider: String) -> String {
    switch provider {
    case "claude": return "Claude Code"
    case "codex": return "Codex"
    default: return provider.capitalized
    }
}

// Tolerant ISO parse: the providers hand back fractional seconds and an
// explicit offset ("…055962+00:00"), which the strict internet-date formatter
// rejects, so fall back to a plain-offset parse. Formatters are built locally
// (ISO8601DateFormatter is not Sendable, so no shared global).
private func parseInstant(_ iso: String) -> Date? {
    if iso.isEmpty { return nil }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = fractional.date(from: iso) { return d }
    if let d = plain.date(from: iso) { return d }
    // Trim sub-second precision the formatters can't take, keep the offset.
    if let dot = iso.firstIndex(of: "."),
       let tz = iso[dot...].firstIndex(where: { $0 == "+" || $0 == "-" || $0 == "Z" }) {
        let trimmed = String(iso[..<dot]) + String(iso[tz...])
        return plain.date(from: trimmed)
    }
    return nil
}

// "Resets in 2h", "Resets in 14m", "Resets in 3d" - the time-until the window
// rolls over (which is also when the quota lasts until). Capitalized because it
// leads its own line in the detail.
private func resetRelative(_ iso: String, now: Date = Date()) -> String? {
    guard let date = parseInstant(iso) else { return nil }
    let seconds = date.timeIntervalSince(now)
    if seconds <= 0 { return "Resetting now" }
    let minutes = Int(seconds / 60)
    if minutes < 60 { return "Resets in \(max(1, minutes))m" }
    let hours = minutes / 60
    if hours < 24 {
        let rem = minutes % 60
        return rem > 0 ? "Resets in \(hours)h \(rem)m" : "Resets in \(hours)h"
    }
    let days = hours / 24
    let remH = hours % 24
    return remH > 0 ? "Resets in \(days)d \(remH)h" : "Resets in \(days)d"
}

// The absolute instant the window lasts until, e.g. "4:32 PM" today or
// "Sat 4:32 PM" when it lands on another day. Pairs with the relative label so
// the detail shows both "in 3h 12m" and the wall-clock time.
private func resetAbsolute(_ iso: String, now: Date = Date()) -> String? {
    guard let date = parseInstant(iso) else { return nil }
    let cal = Calendar.current
    let formatter = DateFormatter()
    if cal.isDate(date, inSameDayAs: now) {
        formatter.dateFormat = "h:mm a"
    } else {
        formatter.dateFormat = "EEE h:mm a"
    }
    return formatter.string(from: date)
}

// One human-friendly line combining both: "Resets in 3h 12m · 4:32 PM". Returns
// nil (so the caller omits it) when the provider gave no reset instant.
private func resetLine(_ iso: String, now: Date = Date()) -> String? {
    guard let relative = resetRelative(iso, now: now) else { return nil }
    if let absolute = resetAbsolute(iso, now: now) {
        return "\(relative) · \(absolute)"
    }
    return relative
}

// "just now", "2m ago", "1h ago", "3d ago" - the age of a captured snapshot.
// Drives the honest freshness label when the server serves stale data after a
// failed live refresh. Returns nil when the instant is missing/unparseable.
private func relativeAge(_ iso: String, now: Date = Date()) -> String? {
    guard let date = parseInstant(iso) else { return nil }
    let seconds = max(0, now.timeIntervalSince(date))
    if seconds < 45 { return "just now" }
    let minutes = Int((seconds / 60).rounded())
    if minutes < 60 { return "\(minutes)m ago" }
    let hours = minutes / 60
    if hours < 24 { return "\(hours)h ago" }
    return "\(hours / 24)d ago"
}

// MARK: - Detail sheet

struct UsageSheet: View {
    @EnvironmentObject private var store: PerchStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    if store.usageIsLoading && store.usage == nil {
                        UsageLoadingCard()
                    }

                    if let error = store.usageErrorMessage {
                        UsageErrorCard(
                            message: error,
                            showingLastGood: store.usage != nil,
                            lastUpdatedAt: store.usageLastUpdatedAt
                        )
                    }

                    if let providers = store.usage?.providers, !providers.isEmpty {
                        ForEach(providers) { provider in
                            ProviderUsageCard(provider: provider)
                        }
                    } else if !store.usageIsLoading && store.usageErrorMessage == nil {
                        UsageUnavailableCard()
                    }

                    if let updatedAt = store.usageLastUpdatedAt, let age = relativeAge(updatedAt) {
                        Text(store.usageIsShowingStaleData ? "Showing data from \(age)" : "Updated \(age)")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(store.usageIsShowingStaleData ? Style.warningText : Style.textFaint)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 4)
                    }

                    Text("Read locally on your Mac - no extra login. Claude and Codex report the same plan limits you see in each CLI.")
                        .font(.system(size: 12))
                        .foregroundStyle(Style.textFaint)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 4)
                        .padding(.top, 2)
                }
                .padding(Style.pageInset)
            }
            .background(Style.canvas.ignoresSafeArea())
            .navigationTitle("Usage")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        Task { await store.fetchUsage(trigger: .manualRefresh) }
                    } label: {
                        if store.usageIsLoading {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Label("Refresh", systemImage: "arrow.clockwise")
                        }
                    }
                    .disabled(store.usageIsLoading)
                    .accessibilityLabel(store.usageIsLoading ? "Refreshing usage" : "Refresh usage")
                }
            }
        }
    }
}

private struct UsageLoadingCard: View {
    var body: some View {
        HStack(spacing: 12) {
            ProgressView()
                .controlSize(.small)
            VStack(alignment: .leading, spacing: 3) {
                Text("Refreshing usage")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Style.textPrimary)
                Text("Reading Claude and Codex plan limits from your Mac.")
                    .font(.system(size: 12.5))
                    .foregroundStyle(Style.textFaint)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Style.secondaryFill)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

private struct UsageErrorCard: View {
    let message: String
    let showingLastGood: Bool
    let lastUpdatedAt: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(showingLastGood ? "Refresh failed" : "Usage unavailable", systemImage: "exclamationmark.triangle")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Style.warningText)
            Text(message)
                .font(.system(size: 12.5))
                .foregroundStyle(Style.textSecondary)
            if showingLastGood, let lastUpdatedAt, let age = relativeAge(lastUpdatedAt) {
                Text("Keeping the last update from \(age).")
                    .font(.system(size: 12))
                    .foregroundStyle(Style.textFaint)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Style.secondaryFill)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Style.warningText.opacity(0.3), lineWidth: 1)
        )
    }
}

private struct ProviderUsageCard: View {
    let provider: ProviderUsage

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                AgentGlyph(agent: provider.agent)
                    .opacity(provider.available ? 1 : 0.4)
                VStack(alignment: .leading, spacing: 2) {
                    Text(providerName(provider.provider))
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Style.textPrimary)
                    if let plan = provider.plan {
                        Text("\(plan.capitalized) plan")
                            .font(.system(size: 12.5))
                            .foregroundStyle(Style.textSecondary)
                    }
                }
                Spacer()
                // Honest freshness: a stale serve (last live read failed) wears
                // its age so the numbers are never mistaken for current.
                if provider.stale == true, let asOf = provider.asOf, let age = relativeAge(asOf) {
                    Text("as of \(age)")
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(Style.warningText)
                }
            }

            if provider.available {
                if let session = provider.window("session") {
                    FullMeter(title: "Session", subtitle: "5-hour window", window: session)
                }
                if let week = provider.window("week") {
                    FullMeter(title: "This week", subtitle: "7-day window", window: week)
                }
                if let credits = provider.credits {
                    creditsRow(credits)
                }
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Text(provider.note ?? "Usage unavailable")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Style.textSecondary)
                    Text("Log in on the Mac to see \(providerName(provider.provider)) usage here.")
                        .font(.system(size: 12.5))
                        .foregroundStyle(Style.textFaint)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(16)
        .background(Style.secondaryFill)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    @ViewBuilder
    private func creditsRow(_ credits: UsageCredits) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "creditcard")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Style.textSecondary)
            Text(creditsText(credits))
                .font(.system(size: 13))
                .foregroundStyle(Style.textSecondary)
            Spacer()
        }
    }

    private func creditsText(_ credits: UsageCredits) -> String {
        func money(_ value: Double) -> String { String(format: "$%.2f", value) }
        if let remaining = credits.remainingDollars, let limit = credits.limitDollars {
            return "\(money(remaining)) of \(money(limit)) credits left"
        }
        if let remaining = credits.remainingDollars {
            return "\(money(remaining)) credits left"
        }
        if let used = credits.usedDollars, let limit = credits.limitDollars {
            return "\(money(used)) of \(money(limit)) credits used"
        }
        return "Credits available"
    }
}

// Shown when no snapshot has landed yet (or an older server has no /usage): the
// sheet still opens and explains itself instead of appearing broken.
private struct UsageUnavailableCard: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "gauge.with.dots.needle.33percent")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Style.textSecondary)
                Text("Usage unavailable right now")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Style.textPrimary)
            }
            Text("Couldn't read plan usage from your Mac. Tap Refresh, or check that Claude and Codex are logged in there.")
                .font(.system(size: 12.5))
                .foregroundStyle(Style.textFaint)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Style.secondaryFill)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

private struct FullMeter: View {
    let title: String
    let subtitle: String
    let window: UsageWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Style.textPrimary)
                Text(subtitle)
                    .font(.system(size: 11.5))
                    .foregroundStyle(Style.textFaint)
                Spacer()
                // Reads as headroom: the number is how much of the window is
                // LEFT, so a fuller bar means more remaining.
                Text("\(Int(window.percentRemaining.rounded()))%")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(severityColor(remaining: window.percentRemaining))
                    .monospacedDigit()
                Text("left")
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(Style.textFaint)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Style.textPrimary.opacity(0.10))
                    Capsule()
                        .fill(severityColor(remaining: window.percentRemaining))
                        .frame(width: max(4, geo.size.width * fraction))
                }
            }
            .frame(height: 7)
            if let reset = resetLine(window.resetsAt) {
                Text(reset)
                    .font(.system(size: 11.5))
                    .foregroundStyle(Style.textFaint)
            }
        }
    }

    // Fill tracks remaining headroom, not spend.
    private var fraction: CGFloat {
        CGFloat(window.percentRemaining / 100)
    }
}
