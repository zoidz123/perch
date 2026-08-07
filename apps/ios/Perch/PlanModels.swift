import Foundation

// GET /charts/hub is the existing server route for committed implementation
// plans grouped by their owning project. The response can also contain legacy
// chart fields; Decodable ignores those fields so the mobile client only keeps
// the supported Plan surface.
struct PlansHubResponse: Decodable {
    let projects: [PlansHubProject]
}

struct PlansHubProject: Decodable, Identifiable {
    let rootPath: String
    let name: String
    let plans: [PlanDocument]

    var id: String { rootPath }
}

// A committed implementation plan discovered by scanning a project's
// docs/plans/*.md. The document's own `Status:` header is a separate axis and
// is deliberately not read here.
struct PlanDocument: Decodable, Identifiable, Hashable {
    // Absolute path of the plan markdown on the Mac.
    let path: String
    // Repo-relative path, e.g. "docs/plans/2026-07-08-foo.md".
    let relativePath: String
    // First `# ` heading, or the filename when the doc has none.
    let title: String
    // YYYY-MM-DD parsed from the filename prefix, when present.
    let date: String?

    var id: String { path }
}

// The relay returns the rendered plan document as JSON because it cannot carry
// raw HTML responses.
struct PlanHtmlResult: Decodable {
    let html: String
}
