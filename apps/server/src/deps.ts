import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { DoctorFixAction, DoctorResponse, DoctorToolStatus } from "@perch/shared";

const execFileAsync = promisify(execFile);

// Environment doctor (GET /doctor + `perch doctor`): the external tools perch
// depends on, checked declaratively so future tools slot into the table
// instead of growing code paths. Detection resolves each binary on PATH and
// asks it for a version; gh gets an extra state probe (auth).

const EXEC_TIMEOUT_MS = 4000;

type ProbeExecOptions = { timeout: number; env?: NodeJS.ProcessEnv };

export type ToolSpec = {
  name: string;
  required: boolean;
  versionArgs: string[];
  // Extra state probe once the binary is found (auth); returns a
  // human-readable note. Runs with the same exec options as the version
  // check.
  probe?: (binPath: string, execOptions: ProbeExecOptions) => Promise<string>;
  // The exact command that installs this tool. `perch doctor --fix` (T2)
  // reads `installer` to know which hints are safe to run unattended;
  // everything else is report-only.
  installHint: string;
  // True when installHint is an official unattended installer that --fix may
  // run after consent (the tool needs no interactive auth flow of its own).
  installer?: boolean;
  // Env defaults --fix applies when running the installer - upstream's own
  // documented variables only (configuration, never patching). A variable
  // the user already exported always wins. Set PERCH_FIX_LINK_DIR here when
  // the installer links its binary somewhere --fix should verify afterwards.
  installEnv?: () => Record<string, string>;
  // Plain-language note shown with the install action.
  installNote?: string;
  // The exact commands the user runs themselves when the tool is missing.
  // --fix reports these verbatim and never runs them: each ends in an
  // interactive sign-in (subscription or token) that cannot be automated.
  manualCommands?: string[];
  docsUrl?: string;
};

export const DEPENDENCY_TOOLS: ToolSpec[] = [
  {
    name: "claude",
    required: true,
    versionArgs: ["--version"],
    installHint: "npm install -g @anthropic-ai/claude-code",
    manualCommands: [
      "npm install -g @anthropic-ai/claude-code",
      "claude   # first run opens sign-in (Claude subscription or Anthropic API key)"
    ],
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code"
  },
  {
    name: "codex",
    required: false,
    versionArgs: ["--version"],
    installHint: "npm install -g @openai/codex",
    manualCommands: [
      "npm install -g @openai/codex",
      "codex   # first run opens sign-in (ChatGPT subscription or OpenAI API key)"
    ],
    docsUrl: "https://github.com/openai/codex"
  },
  {
    name: "gh",
    required: false,
    versionArgs: ["--version"],
    probe: ghAuthProbe,
    installHint: "brew install gh",
    manualCommands: ["brew install gh", "gh auth login"],
    docsUrl: "https://cli.github.com"
  }
];

// gh's unauthenticated note doubles as the planner's signal that a manual
// `gh auth login` step is outstanding; keep probe and planner in sync.
const GH_UNAUTHENTICATED_NOTE = "not authenticated - run `gh auth login`";

// What `perch doctor --fix` would do, derived from detection results. Install
// actions exist only for tools with an official unattended installer;
// everything else is reported with the exact commands the user runs
// themselves.
export function planFix(tools: DoctorToolStatus[]): DoctorFixAction[] {
  const actions: DoctorFixAction[] = [];
  for (const spec of DEPENDENCY_TOOLS) {
    const status = tools.find((tool) => tool.name === spec.name);
    if (!status) continue;
    if (!status.found) {
      if (spec.installer) {
        actions.push({
          name: spec.name,
          kind: "install",
          command: spec.installHint,
          ...(spec.installEnv ? { env: spec.installEnv() } : {}),
          ...(spec.installNote ? { note: spec.installNote } : {})
        });
      } else {
        actions.push({
          name: spec.name,
          kind: "manual",
          commands: spec.manualCommands ?? [spec.installHint],
          reason: "needs its own interactive sign-in; --fix never automates auth"
        });
      }
    } else if (spec.name === "gh" && status.note === GH_UNAUTHENTICATED_NOTE) {
      actions.push({
        name: spec.name,
        kind: "manual",
        commands: ["gh auth login"],
        reason: "installed but not signed in"
      });
    }
  }
  return actions;
}

export type DoctorDeps = {
  // PATH source for binary lookup; injected in tests as a shim dir.
  env?: NodeJS.ProcessEnv;
};

export async function collectDoctor(deps: DoctorDeps = {}): Promise<DoctorResponse> {
  const env = deps.env ?? process.env;
  const tools = await Promise.all(DEPENDENCY_TOOLS.map((spec) => checkTool(spec, env)));
  return {
    at: new Date().toISOString(),
    ok: tools.every((tool) => !tool.required || tool.found),
    tools,
    fix: planFix(tools)
  };
}

async function checkTool(spec: ToolSpec, env: NodeJS.ProcessEnv): Promise<DoctorToolStatus> {
  const installer = spec.installer ? { installer: true as const } : {};
  const binPath = findOnPath(spec.name, env);
  if (!binPath) {
    return { name: spec.name, required: spec.required, found: false, installHint: spec.installHint, ...installer };
  }
  const execOptions = { timeout: EXEC_TIMEOUT_MS };
  let version: string | undefined;
  let note: string | undefined;
  try {
    const { stdout } = await execFileAsync(binPath, spec.versionArgs, execOptions);
    version = parseVersion(stdout);
  } catch {
    note = "found but `--version` failed";
  }
  if (spec.probe && note === undefined) {
    note = await spec.probe(binPath, execOptions);
  }
  return {
    name: spec.name,
    required: spec.required,
    found: true,
    path: binPath,
    ...(version ? { version } : {}),
    ...(note ? { note } : {}),
    installHint: spec.installHint,
    ...installer
  };
}

// The binaries are resolved to absolute paths here and exec'd without an env
// override, so the injected PATH only affects lookup, never the tool's own
// environment.
function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Not here; keep walking.
    }
  }
  return undefined;
}

function parseVersion(stdout: string): string | undefined {
  const match = stdout.match(/v?\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/);
  return match ? match[0] : undefined;
}

async function ghAuthProbe(binPath: string, execOptions: ProbeExecOptions): Promise<string> {
  try {
    await execFileAsync(binPath, ["auth", "status"], execOptions);
    return "authenticated";
  } catch {
    return GH_UNAUTHENTICATED_NOTE;
  }
}
