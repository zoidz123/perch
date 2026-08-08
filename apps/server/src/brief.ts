import type { AgentKind, Task } from "@perch/shared";
import { CHART_CAPABILITY_NOTE } from "./hooks.js";

export const CODEX_NATIVE_CHILD_GUIDANCE = [
  "Native Codex multi-agent guidance:",
  "- If native children are available, they report back only through their native parent result path.",
  "- Native children must not report Perch task lifecycle events.",
  "- Perch accepts lifecycle reports only through the root thread's perch.report_task_event tool.",
  "- Native children share the root worktree by default. Prefer read-only or decomposed work and never perform concurrent writes in that worktree."
].join("\n");

export type PlanBrief = {
  edit?: { relativePath: string; stagedPath: string };
};

// The delivery boundary is server-owned. The brief gives every managed worker
// a provider-native operation, never an HTTP recipe or independent git/gh
// delivery command. A legacy task can still be read and recovered, but no
// newly dispatched brief starts the retired delivery-mode runtime.
export function dispatchBrief(
  task: Task,
  worktreePath: string | undefined,
  plan: PlanBrief = {},
  agent?: AgentKind
): string {
  const codex = agent === "codex";
  const verb = (kind: string, example: string) =>
    codex
      ? `Call perch.report_task_event with {"kind":"${kind}","message":"${example}"}`
      : `Run \`perch task event --task ${task.id} --kind ${kind} --message ${JSON.stringify(example)}\``;
  const doneExample = task.kind === "ship"
    ? "what you delivered; include the PR URL returned by Perch delivery"
    : task.kind === "scout"
      ? "what you found; name the durable report"
      : "what operation was verified and the evidence collected";
  const doneVerb = codex
    ? `${verb("done", doneExample)} and require success=true with task.state=completion_requested in the returned JSON.`
    : `${verb("done", doneExample)} and require task.state=completion_requested in the returned JSON.`;
  const location = worktreePath
    ? `You are working in an isolated worktree at ${worktreePath}. Verify with pwd before changing anything; never cd outside it.`
    : `You are working in ${task.project}.`;
  const planSection = plan.edit
    ? [
        "",
        "PLAN EDIT - your first commit revises the plan and touches nothing else:",
        `- The revised plan markdown is staged at ${plan.edit.stagedPath} outside the repo.`,
        `- Copy it to ${plan.edit.relativePath}, then commit only that file first.`,
        "- Then continue with this task's kind-specific contract."
      ]
    : task.planId
      ? ["", `This task builds from finalized plan \`${task.planId}\`. Commit it first if it is not already in the repository.`]
      : [];
  const autoreview = codex
    ? 'Call perch.autoreview.run with {"idempotencyKey":"review-1","testArgv":["<supported-test-command>","<arg>"]}. It returns the durable attempt identity and structured findings.'
    : `Run \`perch autoreview run --task ${task.id} --idempotency-key review-1 --test-argv-json '["<supported-test-command>","<arg>"]'\`. It returns the durable attempt identity and structured findings.`;
  const delivery = codex
    ? 'Call perch.delivery.create_pr with {"idempotencyKey":"delivery-1"}. It returns the server-created PR identity.'
    : `Run \`perch delivery create-pr --task ${task.id} --idempotency-key delivery-1\`. It returns the server-created PR identity.`;
  const kindContract = task.kind === "ship"
    ? [
        "This is a SHIP task: make the repository change, run focused tests, then obtain a clean AutoReview receipt for the exact final tree before delivery.",
        "- Do not run git push, gh pr create, curl, or any independent delivery command.",
        "- The review test argv must use a supported test launcher such as npm test, node --test, pytest, cargo test, or xcodebuild test. Shell commands are rejected and test arguments are redacted in the receipt.",
        `- ${autoreview}`,
        "- Verify every finding against source. Fix accepted actionable findings, rerun focused tests, then rerun AutoReview. A source change invalidates the prior receipt.",
        `- Only after a clean receipt, ${delivery}`,
        "- The server rejects stale, failed, or finding-bearing receipts and creates at most one PR."
      ]
    : task.kind === "scout"
      ? [
          "This is a SCOUT task: investigate read-only and deliver a durable report.",
          "- Do not change repository files, run AutoReview, push, or create a PR."
        ]
      : [
          "This is an OPERATE task: perform the requested verified runtime or external operation and collect gate-by-gate evidence.",
          "- Do not change repository files, run AutoReview, push, or create a code PR."
        ];
  const chartVerb =
    `curl -sf -X POST "\${PERCH_HOOK_URL%/hooks}/charts" \\\n  -H "x-perch-session: $PERCH_SESSION_ID" -H "x-perch-token: $PERCH_HOOK_TOKEN" \\\n  -H "content-type: application/json" -d '{"file":"<absolute path to the .html file>"}'`;
  const brief = [
    "",
    "---",
    `PERCH TASK BRIEF (task ${task.id})`,
    location,
    `Create and work on branch perch/${task.id}.`,
    ...kindContract,
    ...planSection,
    "",
    codex
      ? "Report status only with the root thread's perch.report_task_event tool:"
      : "Report status with the managed perch task event command:",
    `- started working:\n${verb("working", "short note on your approach")}`,
    `- need a human decision:\n${verb("needs_decision", "the question, with options")}`,
    `- blocked on something external:\n${verb("blocked", "what blocks you")}`,
    `- request completion verification:\n${doneVerb}`,
    `- cannot complete:\n${verb("failed", "why")}`,
    "",
    "Before substantial completion, send the complete worker-authored report and structured evidence to the Mate mailbox:",
    codex
      ? 'Call perch.send_report with {"summary":"<routing summary>","report":"<complete report>","evidence":{}} and require success=true.'
      : `perch report send --task ${task.id} --summary "<routing summary>" --report-file <path-to-full-report.md> [--evidence-file <path.json>]`,
    "",
    "Draw a chart only when it makes findings, a plan, or a comparison easier to review. Fetch the authoring guide first, write .charts/<slug>.html outside commits, then register it:",
    chartVerb,
    "Report sparsely: one working update when you start, then only on real state changes.",
    "Never request completion until this task kind's definition of done is actually met."
  ].join("\n");
  return agent === "codex" ? `${brief}\n\n${CODEX_NATIVE_CHILD_GUIDANCE}\n\n${CHART_CAPABILITY_NOTE}` : brief;
}
