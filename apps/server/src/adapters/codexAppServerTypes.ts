// Protocol types for `codex app-server` (JSON-RPC 2.0 over newline-delimited
// stdio). Cherry-picked from happy's hand-rolled client and the live schema
// emitted by `codex app-server generate-json-schema` (verified on codex-cli
// 0.142.5). Kept deliberately small: only the surface perch drives (initialize,
// thread start/resume, turn start/interrupt, approvals, notifications).
//
// The protocol is marked [experimental] and has drifted once already, so the
// runtime code auto-detects the notification protocol and tolerates missing
// fields rather than trusting these shapes strictly.

export type ThreadId = string;

// Codex reasoning effort levels (turn/start `effort`). "none" is a real value.
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

// Codex approval/sandbox policy enums (thread defaults).
export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

// Perch's internal approval decision, mapped to the wire format per-method.
// (Codex uses accept/decline/cancel on v2 item/* methods and
// approved/denied/abort on the legacy exec/patch methods.)
export type ReviewDecision = "approved" | "approved_for_session" | "denied" | "abort";

export type InputItem =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string };

export type InitializeParams = {
  clientInfo: { name: string; title: string | null; version: string };
  capabilities: { experimentalApi: boolean } | null;
};

export type NewConversationParams = {
  model: string | null;
  cwd: string | null;
  approvalPolicy: ApprovalPolicy | null;
  sandbox: SandboxMode | null;
  config: Record<string, unknown> | null;
  persistExtendedHistory: boolean;
};

export type ThreadResult = {
  thread: { id: ThreadId; path?: string; [key: string]: unknown };
  model: string;
  [key: string]: unknown;
};

export type ResumeConversationParams = {
  threadId: ThreadId;
  model: string | null;
  cwd: string | null;
  approvalPolicy: ApprovalPolicy | null;
  sandbox: SandboxMode | null;
  persistExtendedHistory: boolean;
};

// turn/start params. Only `threadId` + `input` are required; every override is
// "for this turn and subsequent turns". `model` MUST be omitted (never sent as
// "") - an empty model string errors ("model '' not supported").
export type TurnStartParams = {
  threadId: ThreadId;
  input: InputItem[];
  model?: string;
  effort?: ReasoningEffort;
  cwd?: string;
  approvalPolicy?: ApprovalPolicy;
  sandboxPolicy?: { type: string };
};

export type InterruptConversationParams = {
  threadId: ThreadId;
  turnId: string;
};

// A model catalog entry from `model/list`.
export type CodexModel = {
  id: string;
  displayName?: string;
  [key: string]: unknown;
};

// --- JSON-RPC 2.0 wire types ---

export type JsonRpcMessage = {
  jsonrpc?: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};
