import Foundation
import PerchUsage

// Enum decoding is tolerant across the wire protocol: the server may add
// values before the app updates (append-only protocol), and one unknown value
// must never fail the whole fleet/timeline decode.
enum AgentKind: String, Codable {
    case codex
    case claude
    case shell
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AgentKind(rawValue: raw) ?? .unknown
    }
}

// A launch-time model choice offered in the New Agent sheet. `id` is the value
// handed to the spawned CLI's model flag (claude `--model`, codex `-m`); the
// server maps agent + id to the right flag. A nil selection omits the flag so
// the CLI/config default is used. This is spawn-time only, unrelated to
// switching a running session's model. `detail` is the secondary line: the
// context window for Claude, the model's own description for Codex.
struct AgentModelOption: Identifiable, Hashable {
    let id: String
    let label: String
    var detail: String?
    var supportedReasoningEfforts: [String]?
    var defaultReasoningEffort: String?
}

extension AgentKind {
    // Fallback catalog used only when the server's `/models` endpoint is
    // unavailable (older server, offline). The server (models.ts) is the single
    // source of truth - it queries the installed Claude CLI's `/model` aliases
    // and also resolves the CLI's configured default, which can't be known
    // client-side. These ids are the CLI's aliases (`fable`, `opus`, `sonnet`,
    // `haiku`) so a fallback selection launches the same model the live catalog
    // would; labels/context match models.ts, kept in sync by hand. Verified
    // against claude 2.1.x on 2026-07-18.
    var modelOptions: [AgentModelOption] {
        switch self {
        case .claude:
            return [
                AgentModelOption(id: "fable", label: "Fable 5", detail: "1M context"),
                AgentModelOption(id: "opus", label: "Opus 4.8", detail: "1M context"),
                AgentModelOption(id: "sonnet", label: "Sonnet 5", detail: "1M context"),
                AgentModelOption(id: "haiku", label: "Haiku 4.5", detail: "200K context")
            ]
        case .codex:
            return [
                AgentModelOption(id: "gpt-5.6-sol", label: "GPT 5.6 Sol",
                                 detail: "Default frontier Codex model for complex coding, research, and real-world work.",
                                 supportedReasoningEfforts: codexEffortLevelsToUltra),
                AgentModelOption(id: "gpt-5.6-terra", label: "GPT 5.6 Terra",
                                 detail: "High-capability Codex model for larger implementation and review tasks.",
                                 supportedReasoningEfforts: codexEffortLevelsToUltra),
                AgentModelOption(id: "gpt-5.6-luna", label: "GPT 5.6 Luna",
                                 detail: "Efficient Codex model for everyday coding tasks.",
                                 supportedReasoningEfforts: codexEffortLevelsToMax),
                AgentModelOption(id: "gpt-5.5", label: "GPT 5.5",
                                 detail: "Frontier model for complex coding, research, and real-world work.",
                                 supportedReasoningEfforts: fallbackCodexEffortLevels),
                AgentModelOption(id: "gpt-5.4", label: "GPT 5.4",
                                 detail: "Strong model for everyday coding.",
                                 supportedReasoningEfforts: fallbackCodexEffortLevels),
                AgentModelOption(id: "gpt-5.4-mini", label: "GPT 5.4 Mini",
                                 detail: "Small, fast, and cost-efficient model for simpler coding tasks.",
                                 supportedReasoningEfforts: fallbackCodexEffortLevels),
                AgentModelOption(id: "gpt-5.3-codex-spark", label: "GPT 5.3 Codex Spark",
                                 detail: "Older Codex model retained for compatibility with pinned defaults.",
                                 supportedReasoningEfforts: fallbackCodexEffortLevels)
            ]
        default:
            return []
        }
    }

    // Offline fallback for the picker (older server / catalog not yet loaded):
    // the compact three-newest window, matching the live behavior.
    var pickerModelOptions: [AgentModelOption] {
        Array(modelOptions.prefix(3))
    }
}

// Codex reasoning-effort ladders. Newer models raise the ceiling: sol/terra
// reach ultra, luna reaches max, and older models top out at xhigh. Used only
// by the static offline fallback; the live catalog carries each model's own
// `supportedReasoningEfforts` from the server.
let fallbackCodexEffortLevels = ["low", "medium", "high", "xhigh"]
let codexEffortLevelsToMax = fallbackCodexEffortLevels + ["max"]
let codexEffortLevelsToUltra = codexEffortLevelsToMax + ["ultra"]

// Server-provided launch-time model catalog (GET /models). Append-only and
// tolerant: an older server that omits this simply leaves `store.models` nil,
// and the picker falls back to `AgentKind.modelOptions`.
struct ModelCatalogEntry: Codable, Hashable, Identifiable {
    let id: String
    let label: String
    var detail: String?
    var runtimeId: String?
    var gatewayId: String?
    var apiId: String?
    var nativeProviderId: String?
    var runtimeSource: String?
    var source: [String]?
    var status: String?
    var stale: Bool?
    var hidden: Bool?
    var deprecated: Bool?
    var supportedReasoningEfforts: [String]?
    var defaultReasoningEffort: String?
    var serviceTiers: [String]?
    var isDefault: Bool?

    var agentOption: AgentModelOption {
        AgentModelOption(
            id: runtimeId ?? id,
            label: label,
            detail: detail,
            supportedReasoningEfforts: supportedReasoningEfforts,
            defaultReasoningEffort: defaultReasoningEffort
        )
    }
}

struct ProviderModelCatalog: Codable, Hashable {
    let provider: AgentKind
    var label: String?
    var options: [ModelCatalogEntry] = []
    var defaultId: String?
    var defaultLabel: String?
    var defaultDetail: String?
    var defaultSource: String?
    var defaultReasoningEffort: String?
    var roleDefaults: [String: PerchModelRoleDefault]?
    var runtimeSource: String?
    var source: [String]?
    var status: String?

    // The server orders the catalog newest-first. Pickers stay compact - the
    // three newest visible entries - rather than exposing the full CLI alias
    // list; the same limit applies to Claude and Codex.
    var agentOptions: [AgentModelOption] {
        options.filter { $0.hidden != true }.prefix(3).map(\.agentOption)
    }

    // Every id the CLI currently offers (id and runtimeId), used to tell a saved
    // selection the CLI still offers from one it no longer does.
    var offeredModelIds: Set<String> {
        var ids = Set<String>()
        for option in options {
            ids.insert(option.id)
            if let runtimeId = option.runtimeId { ids.insert(runtimeId) }
        }
        return ids
    }

    // The compact picker rows for a saved/queued selection: the three newest
    // visible models, plus the selection itself when it falls outside them - a
    // still-offered model kept as a normal row, or a removed one flagged so it
    // is never silently dropped. `selectedLabel`/`selectedDetail` resolve the
    // selection's display when it is not one of the compact rows.
    func pickerRows(
        selectedId: String?,
        selectedLabel: String,
        selectedDetail: String?
    ) -> [ModelPickerRow] {
        let compact = agentOptions.map {
            ModelPickerRow(id: $0.id, label: $0.label, detail: $0.detail, isRemoved: false)
        }
        return compactModelPickerRows(
            compact: compact,
            offeredIds: offeredModelIds,
            selectedId: selectedId,
            selectedLabel: selectedLabel,
            selectedDetail: selectedDetail
        )
    }

    func roleDefault(for role: String) -> PerchModelRoleDefault? {
        roleDefaults?[role]
    }

    // The reasoning-effort ladder for one model selection. Codex efforts are
    // per-model - sol/terra reach ultra, luna reaches max, older models top out
    // at xhigh - so the picker must reflect the SELECTED model's ceiling, never
    // a union across every model. `modelId` nil resolves to the provider
    // default; an unknown id (or a model with no advertised efforts) falls back
    // to the static ladder so the picker is never empty.
    func effortLevels(forModel modelId: String?) -> [String] {
        let targetId = modelId ?? defaultId
        let entry = targetId.flatMap { id in
            options.first { $0.id == id || $0.runtimeId == id }
        }
        let levels = entry?.supportedReasoningEfforts ?? []
        return levels.isEmpty ? fallbackCodexEffortLevels : levels
    }
}

struct PerchModelRoleDefault: Codable, Hashable {
    let model: String
    var effort: String?
}

struct ModelsResponse: Codable {
    let at: String
    let providers: [ProviderModelCatalog]
}

// Fleet-level defaults (GET/PATCH /config): `dispatchDefaults` is what a
// dispatched worker launches on when the task omits agent/model/effort;
// `mateDefaults` is what `perch mate` launches the next mate with. The
// settings popup reads both on open and writes its edits back. Every field is
// optional - "unset" means the built-in behavior (claude, CLI-default model).
struct AgentDefaults: Codable, Hashable {
    var agent: AgentKind?
    var model: String?
    var effort: String?
}

// Tolerant of an older server that omits either key (both read as unset).
struct ConfigResponse: Codable {
    var dispatchDefaults = AgentDefaults()
    var dispatchResolved = AgentDefaults()
    var mateDefaults = AgentDefaults()

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        dispatchDefaults = (try? container.decode(AgentDefaults.self, forKey: .dispatchDefaults)) ?? AgentDefaults()
        dispatchResolved = (try? container.decode(AgentDefaults.self, forKey: .dispatchResolved)) ?? AgentDefaults()
        mateDefaults = (try? container.decode(AgentDefaults.self, forKey: .mateDefaults)) ?? AgentDefaults()
    }
}

enum AgentSessionStatus: String, Codable {
    case idle
    case running
    case waiting
    case needsApproval = "needs_approval"
    case done
    case error
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AgentSessionStatus(rawValue: raw) ?? .unknown
    }
}

struct AgentSession: Identifiable, Codable, Equatable {
    let id: String
    let title: String
    // Temporary server-assigned identity for a dispatched worker.
    let workerName: String?
    let agent: AgentKind
    let cwd: String?
    // Git branch of cwd at spawn (best-effort, server-provided).
    var branch: String?
    // Grouping labels (role: mate, task linkage, crew parentage).
    let labels: [String: String]?
    let workspaceId: String?
    let paneId: String?
    let surfaceId: String?
    let kind: SurfaceKind
    var status: AgentSessionStatus
    // The exact model + reasoning effort the session is running right now,
    // resolved server-side and kept live as it changes. `model` is the CLI id
    // (e.g. "gpt-5.5", "opus"); `modelLabel` is the versioned display name
    // (e.g. "GPT-5.5", "Opus 4.8"); `effort` is the Codex reasoning tier
    // (Claude has none). Absent only when it can't be resolved.
    let model: String?
    let modelLabel: String?
    let effort: String?
    let lastActivityAt: String
    // Small last-lines preview from the fleet overview tier (terminal surfaces only).
    let tail: String?
    // Durable Claude prompt-delivery uncertainty, replayed on every fleet snapshot.
    let promptDeliveryWarning: PromptDeliveryWarning?
    let promptDeliveryResolution: PromptDeliveryResolution?
    let desktop: DesktopContext?
    // Set while the agent is blocked on a permission prompt.
    let pendingApproval: PendingApproval?
    // Authoritative Codex app-server request, answered by JSON-RPC id.
    let pendingServerRequest: PendingServerRequest?
    // Set while the agent is blocked on an interactive AskUserQuestion prompt.
    let pendingQuestion: PendingQuestion?
    let pendingClaudeInteraction: PendingClaudeInteraction?
    // Composer messages held server-side until the session can accept input.
    let queuedCount: Int?
    // Durable logical-worker identity. This remains meaningful when its PTY
    // session is absent and is never inferred from WebSocket connectivity.
    let runtime: RuntimeSnapshotModel?
}

struct PromptDeliveryWarning: Codable, Equatable {
    let deliveryId: String
    let message: String
    let at: String
}

struct PromptDeliveryResolution: Codable, Equatable {
    let deliveryId: String
    let message: String
    let at: String
}

struct PendingApproval: Codable, Equatable {
    let id: String
    let summary: String
    let command: String?
    let at: String
    let remoteResolutionUnavailable: Bool?
    let decisions: [PendingApprovalDecision]?
    let context: PendingApprovalContext?
    let source: String?
    let submittedDecision: String?
    let requestVersion: Int?
    let state: String?
    let decisionPolicy: String?
    let expiresAt: String?
    let claudeSessionId: String?
    let runtimeGeneration: Int?
    let taskId: String?
    let workerSessionId: String?
    let toolInputHash: String?
    let cwd: String?
    let interactionKind: String?
}

struct PendingApprovalDecision: Codable, Equatable, Identifiable {
    let id: String
    let label: String
    let destructive: Bool?
    let persistence: String?
}

struct PendingApprovalContext: Codable, Equatable {
    let app: String?
    let tool: String?
}

enum JSONRPCID: Codable, Equatable {
    case string(String)
    case number(Double)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(Double.self) { self = .number(value); return }
        self = .string(try container.decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        }
    }

    var jsonObject: Any {
        switch self {
        case let .string(value): value
        case let .number(value): value
        }
    }
}

enum JSONValue: Codable, Equatable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
        else { self = .array(try container.decode([JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .bool(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var jsonObject: Any {
        switch self {
        case let .string(value): value
        case let .number(value): value
        case let .bool(value): value
        case let .object(value): value.mapValues(\.jsonObject)
        case let .array(value): value.map(\.jsonObject)
        case .null: NSNull()
        }
    }
}

struct ServerRequestDecision: Codable, Equatable, Identifiable {
    let id: String
    let label: String
    let destructive: Bool?
    let persistence: String?
}

struct PendingServerRequest: Codable, Equatable {
    let requestId: JSONRPCID
    let threadId: String
    let turnId: String?
    let itemId: String?
    let callId: String?
    let family: String
    let summary: String
    let content: [String: JSONValue]
    let decisions: [ServerRequestDecision]
    let persistence: ServerRequestPersistence?
    let at: String
}

struct ServerRequestPersistence: Codable, Equatable {
    let source: String
    let session: Bool?
    let always: Bool?
    let metadata: [String: JSONValue]?
}

struct QuestionOption: Codable, Equatable {
    let label: String
    let description: String?
}

struct QuestionItem: Codable, Equatable {
    let header: String?
    let question: String
    let multiSelect: Bool?
    let options: [QuestionOption]
}

struct PendingQuestion: Codable, Equatable {
    let id: String
    let questions: [QuestionItem]
    let at: String
    let requestVersion: Int?
    let state: String?
    let answerPolicy: String?
    let remoteResolutionUnavailable: Bool?
    let submittedAnswers: [String: String]?
    let expiresAt: String?
    let claudeSessionId: String?
    let toolUseId: String?
    let runtimeGeneration: Int?
    let taskId: String?
    let workerSessionId: String?
    let questionsHash: String?
    let cwd: String?
}

struct PendingClaudeInteraction: Codable, Equatable {
    let id: String
    let requestVersion: Int
    let kind: String
    let state: String
    let summary: String
    let at: String
    let providerRequestId: String
    let mode: String?
    let message: String?
    let url: String?
    let requestedSchema: [String: JSONValue]?
    let proposedAction: String?
    let proposedContent: [String: JSONValue]?
    let responseAction: String?
    let allowedActions: [String]
    let remoteResolutionUnavailable: Bool?
    let runtimeGeneration: Int?
    let taskId: String?
    let failureReason: String?
}

struct DesktopContext: Codable, Equatable {
    let sessionId: String?
    let workspaceId: String?
    let paneId: String?
    let surfaceId: String?
    let terminal: String?
    let cols: Int?
    let rows: Int?
}

struct SessionsResponse: Codable {
    let sessions: [AgentSession]
}

enum SurfaceKind: String, Codable {
    case terminal
    case browser
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SurfaceKind(rawValue: raw) ?? .unknown
    }
}

enum AgentEvent: Identifiable, Equatable {
    case message(sessionId: String, role: MessageRole, text: String, at: String)
    // Live delta: raw carries PTY bytes for the emulator; text is the rendered
    // fallback used by legacy capture paths. seq detects gaps.
    case terminalOutput(sessionId: String, text: String?, raw: String?, seq: Int?, at: String)
    // Full serialized screen (ANSI) sent when the detail tier opens/resyncs.
    case terminalSnapshot(sessionId: String, data: String, cols: Int, rows: Int, seq: Int, at: String)
    // Structured timeline entry recovered from the agent's session file.
    case timelineItem(sessionId: String, item: TimelineItem, at: String)
    // Live, incremental assistant text for an in-flight turn (codex). `text` is
    // the full accumulated reply so far for `itemId`; `done` marks the last
    // frame. Ephemeral preview - the finished message still arrives as a
    // timelineItem, which supersedes it.
    case assistantStream(sessionId: String, itemId: String, text: String, done: Bool, at: String)
    case approvalRequest(sessionId: String, id: String, summary: String, command: String?, at: String)
    case status(sessionId: String, status: AgentSessionStatus, at: String)
    // A registered chart appeared or its HTML changed on disk (append-only
    // wire message; older servers never send it). Clients showing the chart
    // refetch it.
    case chart(sessionId: String, chartId: String, name: String, reason: String, at: String)

    var id: String {
        switch self {
        case let .message(sessionId, _, text, at):
            "\(sessionId)-message-\(at)-\(text.hashValue)"
        case let .terminalOutput(sessionId, text, raw, seq, at):
            "\(sessionId)-terminal-\(at)-\(seq ?? (text ?? raw ?? "").hashValue)"
        case let .terminalSnapshot(sessionId, _, _, _, seq, at):
            "\(sessionId)-snapshot-\(at)-\(seq)"
        case let .timelineItem(sessionId, item, _):
            "\(sessionId)-timeline-\(item.seq)"
        case let .assistantStream(sessionId, itemId, text, done, _):
            "\(sessionId)-stream-\(itemId)-\(done ? "done" : "\(text.count)")"
        case let .approvalRequest(sessionId, id, _, _, at):
            "\(sessionId)-approval-\(id)-\(at)"
        case let .status(sessionId, status, at):
            "\(sessionId)-status-\(status.rawValue)-\(at)"
        case let .chart(sessionId, chartId, _, reason, at):
            "\(sessionId)-chart-\(chartId)-\(reason)-\(at)"
        }
    }

    var sessionId: String {
        switch self {
        case let .message(sessionId, _, _, _),
             let .terminalOutput(sessionId, _, _, _, _),
             let .terminalSnapshot(sessionId, _, _, _, _, _),
             let .timelineItem(sessionId, _, _),
             let .assistantStream(sessionId, _, _, _, _),
             let .approvalRequest(sessionId, _, _, _, _),
             let .status(sessionId, _, _),
             let .chart(sessionId, _, _, _, _):
            sessionId
        }
    }

}

enum MessageRole: String, Codable {
    case user
    case agent
    case system

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = MessageRole(rawValue: raw) ?? .system
    }
}

extension AgentEvent: Decodable {
    private enum CodingKeys: String, CodingKey {
        case type
        case sessionId
        case role
        case text
        case raw
        case seq
        case data
        case cols
        case rows
        case at
        case id
        case summary
        case command
        case status
        case item
        case itemId
        case done
        case chartId
        case name
        case reason
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "message":
            self = .message(
                sessionId: try container.decode(String.self, forKey: .sessionId),
                role: try container.decode(MessageRole.self, forKey: .role),
                text: try container.decode(String.self, forKey: .text),
                at: try container.decode(String.self, forKey: .at)
            )
        case "terminal_output":
            self = .terminalOutput(
                sessionId: try container.decode(String.self, forKey: .sessionId),
                text: try container.decodeIfPresent(String.self, forKey: .text),
                raw: try container.decodeIfPresent(String.self, forKey: .raw),
                seq: try container.decodeIfPresent(Int.self, forKey: .seq),
                at: try container.decode(String.self, forKey: .at)
            )
        case "terminal_snapshot":
            self = .terminalSnapshot(
                sessionId: try container.decode(String.self, forKey: .sessionId),
                data: try container.decode(String.self, forKey: .data),
                cols: try container.decode(Int.self, forKey: .cols),
                rows: try container.decode(Int.self, forKey: .rows),
                seq: try container.decode(Int.self, forKey: .seq),
                at: try container.decode(String.self, forKey: .at)
            )
        case "timeline_item":
            self = .timelineItem(
                sessionId: try container.decode(String.self, forKey: .sessionId),
                item: try container.decode(TimelineItem.self, forKey: .item),
                at: try container.decode(String.self, forKey: .at)
            )
        case "assistant_stream":
            self = .assistantStream(
                sessionId: try container.decode(String.self, forKey: .sessionId),
                itemId: try container.decode(String.self, forKey: .itemId),
                text: try container.decode(String.self, forKey: .text),
                done: try container.decodeIfPresent(Bool.self, forKey: .done) ?? false,
                at: try container.decode(String.self, forKey: .at)
            )
        case "approval_request":
            self = .approvalRequest(
                sessionId: try container.decode(String.self, forKey: .sessionId),
                id: try container.decode(String.self, forKey: .id),
                summary: try container.decode(String.self, forKey: .summary),
                command: try container.decodeIfPresent(String.self, forKey: .command),
                at: try container.decode(String.self, forKey: .at)
            )
        case "status":
            self = .status(
                sessionId: try container.decode(String.self, forKey: .sessionId),
                status: try container.decode(AgentSessionStatus.self, forKey: .status),
                at: try container.decode(String.self, forKey: .at)
            )
        case "chart":
            self = .chart(
                sessionId: try container.decode(String.self, forKey: .sessionId),
                chartId: try container.decode(String.self, forKey: .chartId),
                name: try container.decode(String.self, forKey: .name),
                reason: try container.decodeIfPresent(String.self, forKey: .reason) ?? "updated",
                at: try container.decode(String.self, forKey: .at)
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unsupported event type: \(type)"
            )
        }
    }
}

// One entry in a session's structured timeline, recovered server-side by
// tailing the agent's own session file. Mirrors @perch/shared TimelineItem.
struct Project: Codable, Identifiable, Equatable {
    var id: String { rootPath }
    let rootPath: String
    let name: String
    let mode: String?
    let lastUsedAt: String
}

// Ledger 1: a tracked unit of work (named AgentTask because Swift's
// Concurrency owns `Task`).
struct AgentTask: Codable, Identifiable, Equatable {
    let id: String
    let title: String
    // Optional keeps older ledger records and servers wire-compatible.
    let workerName: String?
    let project: String
    let kind: String
    let mode: String
    let state: String
    let sessionId: String?
    let worktreeId: String?
    let branch: String?
    let pr: TaskPrModel?
    let presentation: TaskPresentationModel?
    // Derived by the server from its authoritative runtime ledger. Optional
    // keeps older task records and servers wire-compatible.
    let runtime: RuntimeSnapshotModel?
    let createdAt: String
    let updatedAt: String
}

struct TaskPresentationModel: Codable, Equatable {
    let state: String
}

struct TaskPrModel: Codable, Equatable {
    let url: String
    let checks: String?
    let checkDetails: [TaskPrCheckModel]?
    let mergeReady: Bool?
    let isDraft: Bool?
    let mergeable: String?
    let mergeStateStatus: String?
    let reviewDecision: String?
    let merged: Bool?
}

struct TaskPrCheckModel: Codable, Equatable {
    let name: String
    let state: String?
}

// Workspace home grouping (WorkspaceGrouping.swift): tasks nest under their
// project header; the fields it reads are already on every task record.
extension AgentTask: WorkspaceTaskLike {}

extension AgentSession: WorkspaceSessionLike {
    var taskId: String? { labels?["task"] }
    var parentSessionId: String? { labels?["parent"] }
    var statusValue: String { status.rawValue }
}

typealias UsageWindow = PerchUsage.UsageWindow
typealias UsageCredits = PerchUsage.UsageCredits
typealias ProviderUsage = PerchUsage.ProviderUsage
typealias UsageResponse = PerchUsage.UsageResponse

extension ProviderUsage {
    var agent: AgentKind { AgentKind(rawValue: provider) ?? .unknown }
}

struct TasksResult: Codable { let tasks: [AgentTask] }
struct TaskCreateResult: Codable { let task: AgentTask }

// One row of a task's event log (GET /tasks/:id). Only the no-mistakes
// shapes inside `data` are modeled; anything else in there is ignored.
struct TaskEventModel: Codable, Equatable {
    let seq: Int
    let at: String
    let kind: String
    let message: String?
    let data: TaskEventDataModel?
}

// Decoded leniently: a malformed gate or decision fails only its own field,
// so the event (and the whole log) still decodes and the chat keeps its
// plain-text rendering instead of losing the timeline to one bad row.
struct TaskEventDataModel: Codable, Equatable {
    let noMistakes: NoMistakesGateModel?
    let noMistakesDecision: NoMistakesDecisionModel?

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        noMistakes = (try? container.decodeIfPresent(NoMistakesGateModel.self, forKey: .noMistakes)) ?? nil
        noMistakesDecision =
            (try? container.decodeIfPresent(NoMistakesDecisionModel.self, forKey: .noMistakesDecision)) ?? nil
    }
}

// The gate a worker's no-mistakes pipeline parked on (data.noMistakes on a
// needs_decision event): the findings table verbatim, as the worker copied it
// from the gate. Severity/action are upstream's words, not an enum.
struct NoMistakesFindingModel: Codable, Equatable, Identifiable {
    let id: String
    let severity: String?
    let file: String?
    let line: Int?
    let action: String?
    let description: String
}

struct NoMistakesGateModel: Codable, Equatable {
    let step: String
    let runId: String?
    let findings: [NoMistakesFindingModel]
}

// A decision recorded back onto the ledger (data.noMistakesDecision on a
// note event): its presence after the gate means the gate is answered.
struct NoMistakesDecisionModel: Codable, Equatable {
    let step: String?
    let action: String
    let findingIds: [String]?
    let instructions: String?
}

struct TaskDetailResult: Codable {
    let task: AgentTask
    let events: [TaskEventModel]
}

struct ProjectsResult: Codable { let projects: [Project] }
struct SuggestResult: Codable { let paths: [String] }

struct TimelineItem: Identifiable, Codable, Equatable {
    struct Tool: Codable, Equatable {
        let name: String
        let input: String?
    }

    let seq: Int
    let id: String
    let sessionId: String
    let kind: Kind
    let text: String?
    let tool: Tool?
    let at: String
    // Provenance of a user turn. Absent on legacy items and older servers, and
    // any unrecognized value decodes to .human - the safe default that renders
    // as the boss's own bubble.
    var source: Source = .human

    enum Kind: String, Codable {
        case user
        case assistant
        case toolCall = "tool_call"
        case toolResult = "tool_result"
        case system

        init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Kind(rawValue: raw) ?? .system
        }
    }

    // "human" is the boss; "agent" is a mate/orchestrator-driven turn issued
    // on his behalf. Forward-compatible: an unknown future value decodes to
    // .human so an un-upgraded client simply loses the distinction.
    enum Source: String, Codable {
        case human
        case agent

        init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Source(rawValue: raw) ?? .human
        }
    }

    enum CodingKeys: String, CodingKey {
        case seq, id, sessionId, kind, text, tool, at, source
    }
}

// Custom decoding lives in an extension so the synthesized memberwise
// initializer (used for optimistic composer rows) is preserved.
extension TimelineItem {
    // source is optional on the wire; absent decodes to .human.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            seq: try c.decode(Int.self, forKey: .seq),
            id: try c.decode(String.self, forKey: .id),
            sessionId: try c.decode(String.self, forKey: .sessionId),
            kind: try c.decode(Kind.self, forKey: .kind),
            text: try c.decodeIfPresent(String.self, forKey: .text),
            tool: try c.decodeIfPresent(Tool.self, forKey: .tool),
            at: try c.decode(String.self, forKey: .at),
            source: try c.decodeIfPresent(Source.self, forKey: .source) ?? .human
        )
    }
}

// Live assistant reply being streamed for an in-flight turn. Rendered as a
// transient assistant bubble via a synthetic TimelineItem until the finished
// message persists from the transcript tailer. Not Codable - purely local UI
// state driven by assistant_stream frames.
struct StreamingReply: Equatable {
    let itemId: String
    var text: String
    var done: Bool

    // Synthetic timeline row for the preview. Stable id (keyed on itemId) so the
    // row updates in place as text grows; seq 0 keeps it clear of the
    // typewriter-reveal path (which only animates seq > revealAfterSeq).
    func asTimelineItem(sessionId: String) -> TimelineItem {
        TimelineItem(
            seq: 0,
            id: "stream-\(itemId)",
            sessionId: sessionId,
            kind: .assistant,
            text: text,
            tool: nil,
            at: "",
            source: .agent
        )
    }
}

// A composer message rendered immediately, before its canonical transcript row
// exists. Nothing on the server is obliged to produce that row - a CLI dialog
// can swallow the injected text - so the wait is bounded: past `deadline` the
// message flips to `failed` and offers a retry instead of spinning forever.
struct OptimisticMessage: Identifiable, Equatable {
    let item: TimelineItem
    var deadline: Date
    var failed = false
    // The server returned 202 (input accepted + injected). That is the
    // authoritative delivery signal; the canonical timeline row only confirms
    // it. An acknowledged message is never declared "Not delivered", even if
    // its row is delayed (e.g. a resumed session's timeline briefly behind).
    var acknowledged = false

    var id: String { item.id }
}

struct TimelineResponse: Decodable {
    let items: [TimelineItem]
    let lastSeq: Int
}

struct SubmitResult: Decodable {
    let ok: Bool
    // Older servers omit it; treated as sent immediately.
    let queued: Bool?
}

struct StartAgentResult: Decodable {
    let session: AgentSession
}
