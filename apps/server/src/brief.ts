import type { AgentKind, Task } from "@perch/shared";
import { CHART_CAPABILITY_NOTE } from "./hooks.js";

// The dispatch brief: Perch task reporting and delivery instructions.
// Appended to the user's kickoff prompt when a task is dispatched, it tells
// the worker where it is, how to name its branch, and how to report - the
// five verbs are curl calls authed by the session's existing hook token
// (already in the PTY env), so no new secret ever enters the prompt.

// Plan linkage carried into the kickoff:
// `edit` is set only for the edit-a-finalized-plan-as-a-commit flow, where the
// server has staged the revised markdown centrally (never in the repo) and the
// worker's first commit lands it at `relativePath`.
export type PlanBrief = {
  edit?: { relativePath: string; stagedPath: string };
};

export function dispatchBrief(
  task: Task,
  worktreePath: string | undefined,
  plan: PlanBrief = {},
  agent?: AgentKind
): string {
  const verb = (kind: string, example: string) =>
    `curl -sf -X POST "\${PERCH_HOOK_URL%/hooks}/tasks/${task.id}/events" \\\n` +
    `  -H "x-perch-session: $PERCH_SESSION_ID" -H "x-perch-token: $PERCH_HOOK_TOKEN" \\\n` +
    `  -H "content-type: application/json" -d '{"kind":"${kind}","message":"${example}"}'`;

  const location = worktreePath
    ? `You are working in an isolated worktree at ${worktreePath}. Verify with pwd before changing anything; never cd outside it.`
    : `You are working in ${task.project}.`;

  const chartVerb =
    `curl -sf -X POST "\${PERCH_HOOK_URL%/hooks}/charts" \\\n` +
    `  -H "x-perch-session: $PERCH_SESSION_ID" -H "x-perch-token: $PERCH_HOOK_TOKEN" \\\n` +
    `  -H "content-type: application/json" -d '{"file":"<absolute path to the .html file>"}'`;

  // The plan this task builds from. An edit revises an existing plan doc; a
  // plain planId (a promotion) means the worker commits the plan doc as its
  // first commit, then builds. Both keep the plan doc a git commit the worker
  // authors - the server never writes to the repo.
  const planSection = plan.edit
    ? [
        "",
        "PLAN EDIT - your first commit revises the plan and touches nothing else:",
        `- The revised plan markdown is staged at ${plan.edit.stagedPath} (outside the repo; the server never writes to a repo).`,
        `- Copy its contents to ${plan.edit.relativePath} in your worktree (create docs/plans/ if missing), then commit ONLY that file as the FIRST commit of your branch (e.g. \`docs(plans): revise the plan\`).`,
        "- Every revision is a git commit; never edit the plan anywhere else.",
        "Then continue to the definition of done above."
      ]
    : task.planId
      ? [
          "",
          `This task builds from the finalized plan \`${task.planId}\`. If that plan doc is not yet committed in this repo, commit it to docs/plans/<date>-<name>.md as the FIRST commit of your branch, then build against it.`
        ]
      : [];

  const definitionOfDone =
    task.kind === "scout"
      ? "This is a SCOUT task: investigate and report. Done means a written report in your final done: message (or a file you name there). Do not change code."
      : task.mode === "local-only"
        ? "Done means the work is committed locally on your branch. Do not push or open a PR."
        : task.mode === "no-mistakes"
          ? "Done means the work passed the no-mistakes pipeline and its PR checks are green. Include the PR URL in your done: message."
          : "Done means a pushed branch with an open PR. Include the PR URL in your done: message.";

  // How to drive the gate, and the ask-user contract: findings travel to the
  // boss as structured data on the needs_decision verb, copied verbatim from
  // the gate's table - perch never parses pipeline output itself.
  const askUserExample =
    `curl -sf -X POST "\${PERCH_HOOK_URL%/hooks}/tasks/${task.id}/events" \\\n` +
    `  -H "x-perch-session: $PERCH_SESSION_ID" -H "x-perch-token: $PERCH_HOOK_TOKEN" \\\n` +
    `  -H "content-type: application/json" \\\n` +
    `  -d '{"kind":"needs_decision","message":"review gate: 2 findings need you","data":{"noMistakes":{"step":"review","findings":[{"id":"r1","severity":"error","file":"src/app.ts","line":42,"action":"ask-user","description":"the finding text, copied in full"}]}}}'`;
  const noMistakesDriving =
    task.kind !== "scout" && task.mode === "no-mistakes"
      ? [
          "",
          "Ship through the no-mistakes gate:",
          "- Drive the pipeline yourself with the /no-mistakes skill (`no-mistakes axi`); always pass --intent describing this task.",
          "- Run gate pushes unsandboxed: sandboxed Bash breaks the gate's post-receive hook.",
          "- When a gate parks the run with ask-user findings, never answer or bypass them yourself. Report needs_decision with message = a one-line summary and the findings table copied VERBATIM into data.noMistakes - every finding's id, severity, file, line, action, and description exactly as the gate printed them, no paraphrasing, no dropped findings:",
          askUserExample,
          "- The answer arrives as a message in your chat; resume the parked run with `no-mistakes axi respond`."
        ]
      : [];

  const noMistakesProhibition =
    task.kind !== "scout" && task.mode === "direct-PR"
      ? [
          "",
          "No-mistakes is prohibited for this direct-PR task.",
          "Do not invoke the no-mistakes skill, CLI, daemon, gate remote, or review agents, regardless of prompt wording, repository setup, existing gate remote, diff size, or global skill visibility.",
          "Run ordinary task-specific tests, builds, and lint, then push the branch and open the PR directly."
        ]
      : task.kind !== "scout" && task.mode === "local-only"
        ? [
            "",
            "No-mistakes is prohibited for this local-only task.",
            "Do not invoke the no-mistakes skill, CLI, daemon, gate remote, review agents, push, or any remote delivery workflow, regardless of prompt wording, repository setup, existing gate remote, diff size, or global skill visibility.",
            "Run ordinary task-specific tests, builds, and lint locally and keep the work on the local task branch."
          ]
        : [];

  const brief = [
    "",
    "---",
    `PERCH TASK BRIEF (task ${task.id})`,
    location,
    `Create and work on branch perch/${task.id}.`,
    definitionOfDone,
    ...noMistakesDriving,
    ...noMistakesProhibition,
    ...planSection,
    "",
    "Report status by POSTing task events (run these exact curl commands from your shell):",
    `- started working:\n${verb("working", "short note on your approach")}`,
    `- need a human decision:\n${verb("needs_decision", "the question, with options")}`,
    `- blocked on something external:\n${verb("blocked", "what blocks you")}`,
    `- request completion verification:\n${verb("done", "what you did; include the PR URL if any")}`,
    `- cannot complete:\n${verb("failed", "why")}`,
    "",
    "Drawing charts: when something you hand the boss is easier reviewed visually than as prose - a plan, a comparison, findings - draw a chart: one HTML file the boss annotates from desktop or phone.",
    "Fetch the authoring guide first (curl -sf \"${PERCH_HOOK_URL%/hooks}/charts/authoring\") and follow it: every chart renders in the one fixed perch look via chart.css and its documented classes - no <style> blocks, no style= attributes, no external design systems.",
    "Write the file to .charts/<slug>.html in your workspace (keep it out of commits) and register it once:",
    chartVerb,
    "Registration notifies the boss; edits to the file refresh an open review live; boss feedback arrives in your session as a [perch chart] block.",
    "Content: keep the chart to one screen. Lead with a one-line verdict, then Problem / Findings with at most four short bullets, then Fix / Recommendation with at most four short bullets. Risks and open questions are optional; include at most one short open-question or decision line.",
    "Charts are working documents: on registration the server keeps the canonical copy under ~/.perch/charts/, so the chart outlives your worktree. When the boss approves a chart as a plan, approval is the promotion: the worker implementing it converts the approved chart's content into a markdown plan doc committed to the target project's repo (docs/plans/<date>-<name>.md, or that project's docs convention) as the first commit of the implementation branch, then builds against it. Scratchpad centrally, canon per-repo.",
    "",
    "Report sparsely: one working: when you start, then only on real state changes.",
    "Never end a turn without reporting your current state via one of these curls; if you are about to wait on something long (CI, a review), report working: naming what you are waiting on first.",
    "The done: reporting verb requests mate verification; it does not mark the task done by itself.",
    "Never request completion until the definition of done above is actually met."
  ].join("\n");
  return agent === "codex" ? `${brief}\n\n${CHART_CAPABILITY_NOTE}` : brief;
}
