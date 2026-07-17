import type { NoMistakesFinding, NoMistakesGate, TaskDecisionAction } from "@perch/shared";

// Structured findings relay (v1 phone surface): a worker driving the
// no-mistakes pipeline hits an ask-user gate and POSTs needs_decision with
// data.noMistakes copied verbatim from the gate's findings table. This module
// is the only reader of that shape - tolerant parsing (the worker composed it
// from upstream output that varies by version) plus the two boss-facing
// renderings: the push body and the mate wake line. Descriptions pass through
// verbatim; single-line surfaces only squeeze whitespace.

// Worst-first ordering for picking the headline finding. Upstream severity
// vocabulary is not pinned, so rank the words we know and put everything else
// (info, note, custom tiers) behind them; ties keep table order.
const SEVERITY_ORDER = ["blocker", "critical", "fatal", "error", "high", "warning", "warn", "medium"];

function severityRank(severity: string): number {
  const index = SEVERITY_ORDER.indexOf(severity.toLowerCase());
  return index === -1 ? SEVERITY_ORDER.length : index;
}

// Extract a well-formed gate from event data, or undefined when the event
// carries none. Rows missing an id or description are dropped (nothing to
// relay); every kept field is the worker's string verbatim.
export function parseNoMistakesGate(data: Record<string, unknown> | undefined): NoMistakesGate | undefined {
  const raw = data?.noMistakes;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const gate = raw as Record<string, unknown>;
  const rows = Array.isArray(gate.findings) ? gate.findings : [];
  const findings: NoMistakesFinding[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const finding = row as Record<string, unknown>;
    if (
      typeof finding.id !== "string" ||
      finding.id.trim().length === 0 ||
      typeof finding.description !== "string" ||
      finding.description.trim().length === 0
    ) {
      continue;
    }
    findings.push({
      id: finding.id,
      severity: typeof finding.severity === "string" && finding.severity.trim() ? finding.severity : "unknown",
      ...(typeof finding.file === "string" && finding.file ? { file: finding.file } : {}),
      ...(typeof finding.line === "number" && Number.isFinite(finding.line) ? { line: finding.line } : {}),
      ...(typeof finding.action === "string" && finding.action ? { action: finding.action } : {}),
      description: finding.description
    });
  }
  if (findings.length === 0) {
    return undefined;
  }
  return {
    step: typeof gate.step === "string" && gate.step.trim() ? gate.step : "pipeline",
    ...(typeof gate.runId === "string" && gate.runId ? { runId: gate.runId } : {}),
    findings
  };
}

export function worstFinding(gate: NoMistakesGate): NoMistakesFinding {
  return gate.findings.reduce((worst, finding) =>
    severityRank(finding.severity) < severityRank(worst.severity) ? finding : worst
  );
}

// Push body: "<step> gate: N findings need you - <worst id> (<severity>):
// <description>". The caller applies the existing push truncation rules.
export function findingsPushBody(gate: NoMistakesGate): string {
  const worst = worstFinding(gate);
  const count =
    gate.findings.length === 1 ? "1 finding needs you" : `${gate.findings.length} findings need you`;
  return `${gate.step} gate: ${count} - ${worst.id} (${worst.severity}): ${singleLine(worst.description)}`;
}

// Mate wake rendering: the full table on one line (a newline would submit the
// mate's composer early), each finding's id, severity, file, and description
// verbatim so the mate can relay them without re-fetching the ledger.
export function findingsWakeSummary(gate: NoMistakesGate): string {
  const count = gate.findings.length === 1 ? "1 finding" : `${gate.findings.length} findings`;
  const rows = gate.findings.map((finding) => {
    const where = finding.file ? ` ${finding.file}${finding.line !== undefined ? `:${finding.line}` : ""}` : "";
    const action = finding.action ? ` [${finding.action}]` : "";
    return `${finding.id} (${finding.severity})${where}${action}: ${singleLine(finding.description)}`;
  });
  return `${gate.step} gate parked with ${count}: ${rows.join(" | ")}`;
}

// --- Decision answers (v2 phone surface) ----------------------------------
// The boss answers a parked gate from the native card; the server translates
// the answer into the matching `no-mistakes axi respond ...` line and injects
// it into the worker's composer. The worker runs the command - perch itself
// never drives axi.

export type GateDecision = {
  action: TaskDecisionAction;
  findingIds?: string[];
  instructions?: string;
};

// The exact upstream command that resumes the parked run. Instructions are
// boss-typed free text: squeezed to one line (a newline would submit the
// worker's composer early) and single-quoted for the shell.
export function respondCommand(decision: GateDecision): string {
  const parts = ["no-mistakes axi respond", `--action ${decision.action}`];
  if (decision.action === "fix" && decision.findingIds && decision.findingIds.length > 0) {
    parts.push(`--findings ${decision.findingIds.join(",")}`);
  }
  if (decision.action === "fix" && decision.instructions) {
    parts.push(`--instructions ${shellQuote(singleLine(decision.instructions))}`);
  }
  return parts.join(" ");
}

// Human-readable gist of the decision, shared by the injection line, the
// ledger note, and the mate FYI: "approve", "skip", "fix r2,r3 - <guidance>".
export function decisionSummary(decision: GateDecision): string {
  if (decision.action !== "fix") {
    return decision.action;
  }
  const ids = decision.findingIds && decision.findingIds.length > 0 ? ` ${decision.findingIds.join(",")}` : "";
  const guidance = decision.instructions ? ` - ${singleLine(decision.instructions)}` : "";
  return `fix${ids}${guidance}`;
}

// Worker injection: one line naming the gate and carrying the exact respond
// command, so the worker resumes the run without interpretation.
export function decisionInjectionLine(gate: NoMistakesGate, decision: GateDecision): string {
  return `[perch] boss decision on ${gate.step} gate: ${decisionSummary(decision)} - resume the parked run with: ${respondCommand(decision)}`;
}

// Mate FYI (O3): the boss resolved this gate from the phone; the mate must
// never double-answer it. Same wake-line shape as mateWake's verbs, so the
// caller passes taskWakeIdentity(task).
export function decisionMateFyi(taskIdentity: string, gate: NoMistakesGate, decision: GateDecision): string {
  return `[perch] ${taskIdentity} · boss_decision: the boss answered the ${gate.step} gate from the phone (${decisionSummary(decision)}) - already injected into the worker; do not answer this gate again.`;
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
