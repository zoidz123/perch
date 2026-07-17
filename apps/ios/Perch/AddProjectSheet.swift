import SwiftUI

// Register a directory as a project from the phone: search the Mac's
// filesystem (GET /fs/suggest), pick a path, confirm. Deliberately minimal -
// a search field, the results, one button - matching the New Agent sheet's
// project picker so the two read as the same control.
struct AddProjectSheet: View {
    @EnvironmentObject private var store: PerchStore
    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @State private var selectedPath: String?
    @State private var suggestions: [String] = []
    @State private var adding = false
    @State private var addError: String?
    @State private var searchTask: Task<Void, Never>?
    @FocusState private var searchFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 14))
                            .foregroundStyle(Style.textSecondary)
                        TextField("Search directories…", text: $query)
                            .font(.system(size: 15))
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .focused($searchFocused)
                            .onChange(of: query) { _, value in scheduleSearch(value) }
                    }
                    .padding(.vertical, 10)
                    .padding(.horizontal, 12)
                    .background(Style.secondaryFill)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                    VStack(spacing: 0) {
                        ForEach(suggestions, id: \.self) { path in
                            directoryRow(path)
                            if path != suggestions.last { Divider().overlay(Style.hairline) }
                        }
                        if suggestions.isEmpty {
                            Text(query.trimmingCharacters(in: .whitespaces).isEmpty
                                 ? "Search for a directory on your Mac."
                                 : "No matches")
                                .font(.system(size: 14))
                                .foregroundStyle(Style.textSecondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.vertical, 12)
                                .padding(.horizontal, 4)
                        }
                    }

                    if let addError {
                        Text(addError)
                            .font(.system(size: 13))
                            .foregroundStyle(Style.errorText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(20)
            }
            .background(Style.canvas)
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Add project")
            .navigationBarTitleDisplayMode(.inline)
            .task {
                // E2E hook (sim automation cannot type): -PerchAddProjectQuery
                // prefills the search so the results list can be captured.
                if let seed = UserDefaults.standard.string(forKey: "PerchAddProjectQuery"), query.isEmpty {
                    query = seed
                    scheduleSearch(seed)
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action: add) {
                        if adding {
                            ProgressView().controlSize(.small)
                        } else {
                            Text("Add").fontWeight(.semibold)
                        }
                    }
                    .disabled(selectedPath == nil || adding)
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") {
                        searchFocused = false
                    }
                }
            }
        }
    }

    private func directoryRow(_ path: String) -> some View {
        Button {
            selectedPath = path
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "folder")
                    .font(.system(size: 14))
                    .foregroundStyle(Style.textSecondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text((path as NSString).lastPathComponent)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Style.textPrimary)
                    Text(WorkspaceGrouping.homeRelative(path))
                        .font(.system(size: 12))
                        .foregroundStyle(Style.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
                Spacer(minLength: 8)
                if selectedPath == path {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 17))
                        .foregroundStyle(Style.textPrimary)
                }
            }
            .padding(.vertical, 10)
            .padding(.horizontal, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func scheduleSearch(_ value: String) {
        searchTask?.cancel()
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else {
            suggestions = []
            return
        }
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(180))
            if Task.isCancelled { return }
            let results = await store.suggestDirectories(trimmed)
            if Task.isCancelled { return }
            suggestions = results
        }
    }

    private func add() {
        guard let path = selectedPath, !adding else { return }
        adding = true
        addError = nil
        Task {
            let error = await store.addProject(path)
            adding = false
            if let error {
                addError = error
            } else {
                dismiss()
            }
        }
    }
}
