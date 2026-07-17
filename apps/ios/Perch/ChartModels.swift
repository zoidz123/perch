import Foundation

// A chart: an HTML document an agent drew up for boss review, bound to its
// owning session. Mirrors the server's
// Chart shape; decoded leniently by riding the usual append-only wire rules.
struct ChartModel: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    // Canonical path on the Mac - shown nowhere prominent, but useful context.
    let file: String
    // Pipeline stage: "draft" (brainstorm) or "finalized" (approved). Absent on
    // charts registered before the two-state model shipped; read as "draft".
    let status: String?
    // When the chart was marked finalized (approved). Absent while a draft.
    let finalizedAt: String?
    let sessionId: String
    let taskId: String?
    // The owning task's title at registration - tags a crew chart's card when
    // it surfaces outside its own session's chat. Absent on older servers.
    let taskTitle: String?
    // Crew parentage (normally the mate session): the chart also surfaces in
    // this session's timeline. Absent on older servers / solo charts.
    let parentSessionId: String?
    // Set when the owning task closed: still viewable, no longer "latest".
    let archived: Bool?
    // Durable chart snapshot version. The server serves from this copy, and it
    // changes when the chart file is rewritten.
    let snapshotAt: String?
    let registeredAt: String
    let updatedAt: String

    // Finalized (approved into a plan) vs draft (brainstorm). Charts from older
    // servers carry no status and read as draft.
    var isFinalized: Bool { status == "finalized" }

    var cardDismissalIdentity: ChartCardDismissalIdentity {
        ChartCardDismissalIdentity(
            id: id,
            registeredAt: registeredAt,
            updatedAt: updatedAt,
            snapshotAt: snapshotAt
        )
    }
}

struct ChartsResult: Decodable {
    let charts: [ChartModel]
}

// GET /charts/hub: the unified listing both front-ends consume. Charts and
// committed plans grouped by their owning project, plus charts that resolve to
// no tracked project (drawn outside a task). Mirrors the server's
// ChartsHubResponse.
struct ChartsHubResponse: Decodable {
    let projects: [ChartsHubProject]
    let ungrouped: [ChartModel]
}

// One tracked project's slice of the hub: its registered charts (with
// Draft/Finalized status) and its committed implementation plans.
struct ChartsHubProject: Decodable, Identifiable {
    let rootPath: String
    let name: String
    let charts: [ChartModel]
    let plans: [ChartPlanDoc]

    var id: String { rootPath }
}

// A committed implementation plan discovered by scanning a project's
// docs/plans/*.md. Every committed plan doc is a finalized plan; the doc's own
// `Status:` header is a separate axis and is deliberately not read here.
struct ChartPlanDoc: Decodable, Identifiable, Hashable {
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

// GET /charts/:id/html over the relay RPC surface: the SDK-injected document
// as JSON (the relay cannot carry raw HTML responses).
struct ChartHtmlResult: Decodable {
    let chart: ChartModel
    let html: String
}

// GET /charts/plan?path=<relativePath> over the relay RPC surface: a committed
// plan rendered as chart-styled HTML, returned as JSON since the relay cannot
// carry raw HTML responses.
struct ChartPlanHtmlResult: Decodable {
    let html: String
}

// GET /charts/:id/asset64 over the relay RPC surface.
struct ChartAssetResult: Decodable {
    let base64: String
    let contentType: String
}

struct ChartFeedbackResult: Decodable {
    let ok: Bool
    // True when the block was queued server-side (permission prompt open).
    let queued: Bool?
}

// One annotation captured from the injected SDK (which computes the canonical
// selector / text-range / Mermaid target). `payload` is forwarded verbatim to
// POST /charts/:id/feedback; the display fields drive the pending-note chips.
struct ChartAnnotationDraft: Identifiable, Equatable {
    let id = UUID()
    let prompt: String
    let tag: String
    let text: String
    let payload: [String: AnyCodableValue]

    static func == (lhs: ChartAnnotationDraft, rhs: ChartAnnotationDraft) -> Bool {
        lhs.id == rhs.id
    }

    // Built from the raw WKScriptMessageHandler dictionary; the SDK's internal
    // queue key never leaves the page.
    init?(raw: Any?) {
        guard var dict = raw as? [String: Any] else { return nil }
        dict.removeValue(forKey: "_lavishQueueKey")
        prompt = dict["prompt"] as? String ?? ""
        tag = dict["tag"] as? String ?? "element"
        text = dict["text"] as? String ?? ""
        payload = dict.compactMapValues(AnyCodableValue.init(any:))
        if prompt.isEmpty { return nil }
    }
}

// Minimal JSON-value box so annotation payloads (arbitrary SDK shapes) can be
// held Sendable-ish and re-serialized without losing nested structure.
enum AnyCodableValue: Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case array([AnyCodableValue])
    case object([String: AnyCodableValue])
    case null

    init?(any: Any) {
        switch any {
        case let value as String: self = .string(value)
        case let value as Bool: self = .bool(value)
        case let value as NSNumber:
            // NSNumber bridges bools too, but the Bool case above catches the
            // Swift-typed ones; JS booleans arrive as NSNumber with bool type.
            if CFGetTypeID(value) == CFBooleanGetTypeID() {
                self = .bool(value.boolValue)
            } else {
                self = .number(value.doubleValue)
            }
        case let value as [Any]: self = .array(value.compactMap(AnyCodableValue.init(any:)))
        case let value as [String: Any]: self = .object(value.compactMapValues(AnyCodableValue.init(any:)))
        case is NSNull: self = .null
        default: return nil
        }
    }

    // Back to a JSONSerialization-friendly value for the request body.
    var jsonObject: Any {
        switch self {
        case let .string(value): value
        case let .number(value): value
        case let .bool(value): value
        case let .array(value): value.map(\.jsonObject)
        case let .object(value): value.mapValues(\.jsonObject)
        case .null: NSNull()
        }
    }
}
