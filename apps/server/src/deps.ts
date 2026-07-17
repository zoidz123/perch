import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { DoctorFixAction, DoctorProjectGate, DoctorResponse, DoctorToolStatus } from "@perch/shared";
import type { Project } from "./projects.js";
import {
  resolveBundledNoMistakes,
  validateBundledNoMistakes,
  type NoMistakesRuntimeFacts
} from "./noMistakesRuntime.js";

const execFileAsync = promisify(execFile);

// Environment doctor (GET /doctor + `perch doctor`): the external tools perch
// depends on, checked declaratively so future tools slot into the table
// instead of growing code paths. Detection resolves each binary on PATH and
// asks it for a version; gh and no-mistakes get an extra state probe (auth,
// daemon). The no-mistakes gate is additionally checked per registered
// project: `no-mistakes init` adds a `no-mistakes` git remote to shared repo
// config, so readiness is a cheap `git config` read - the binary itself is
// never invoked per project.

const EXEC_TIMEOUT_MS = 4000;
// `no-mistakes init` may download hooks and talk to its daemon; give it real
// time before declaring failure.
const INIT_TIMEOUT_MS = 60_000;

type ProbeExecOptions = { timeout: number; env?: NodeJS.ProcessEnv };

export type ToolSpec = {
  name: string;
  required: boolean;
  versionArgs: string[];
  // Extra state probe once the binary is found (auth, daemon); returns a
  // human-readable note. Runs with the same exec options as the version
  // check (timeout, and the telemetry opt-out env for no-mistakes).
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
  // the user already exported always wins.
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
  },
  {
    name: "no-mistakes",
    required: false,
    versionArgs: ["--version"],
    probe: noMistakesDaemonProbe,
    installHint: "bundled with perchctl; update perchctl to repair this runtime",
    installNote:
      "Perch-managed no-mistakes is an immutable signed runtime bundled with perchctl. " +
      "Perch never downloads or repairs it from a consumer install and never falls back to PATH.",
    docsUrl: "https://github.com/zoidz123/no-mistakes/releases/tag/v1.39.0-perch.1"
  }
];

// gh's unauthenticated note doubles as the planner's signal that a manual
// `gh auth login` step is outstanding; keep probe and planner in sync.
const GH_UNAUTHENTICATED_NOTE = "not authenticated - run `gh auth login`";

// no-mistakes telemetry opt-out variable ("when set to a disabling value,
// telemetry stays off"). Also defaulted to "0" in every PTY perch spawns
// (see sanitizeSpawnEnv in adapters/pty.ts) unless the user exported it.
export const NO_MISTAKES_TELEMETRY_ENV = "NO_MISTAKES_TELEMETRY";

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
      if (spec.name === "no-mistakes") continue;
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
  projects?: Project[];
  // Test-only fake runtime injection. Production always resolves the bundled
  // signed binary and never consults PATH.
  noMistakesPath?: string | null;
};

export async function collectDoctor(deps: DoctorDeps = {}): Promise<DoctorResponse> {
  const env = deps.env ?? process.env;
  const tools = await Promise.all(
    DEPENDENCY_TOOLS.map((spec) =>
      spec.name === "no-mistakes" ? checkBundledNoMistakes(spec, deps, env) : checkTool(spec, env)
    )
  );
  const binaryFound = tools.find((tool) => tool.name === "no-mistakes")?.found ?? false;
  const projects = await Promise.all(
    (deps.projects ?? []).map((project) => projectGate(project, binaryFound))
  );
  return {
    at: new Date().toISOString(),
    ok: tools.every((tool) => !tool.required || tool.found),
    tools,
    noMistakes: { binaryFound, projects },
    fix: planFix(tools)
  };
}

async function checkBundledNoMistakes(
  spec: ToolSpec,
  deps: DoctorDeps,
  env: NodeJS.ProcessEnv
): Promise<DoctorToolStatus> {
  const resolved = noMistakesRuntime(deps);
  if (!resolved.path) {
    return {
      name: spec.name,
      required: spec.required,
      found: false,
      installHint: spec.installHint,
      ...(resolved.error ? { note: resolved.error } : {})
    };
  }
  const execOptions = {
    timeout: EXEC_TIMEOUT_MS,
    env: {
      ...env,
      [NO_MISTAKES_TELEMETRY_ENV]:
        env[NO_MISTAKES_TELEMETRY_ENV] ?? process.env[NO_MISTAKES_TELEMETRY_ENV] ?? "0"
    }
  };
  let version: string | undefined;
  let note: string | undefined;
  try {
    const { stdout } = await execFileAsync(resolved.path, spec.versionArgs, execOptions);
    version = parseVersion(stdout);
    if (!stdout.includes("authorization-protocol=1")) note = "incompatible authorization protocol";
  } catch {
    note = "bundled runtime failed `--version`";
  }
  if (spec.probe && note === undefined) note = await spec.probe(resolved.path, execOptions);
  return {
    name: spec.name,
    required: spec.required,
    found: note !== "incompatible authorization protocol" && note !== "bundled runtime failed `--version`",
    path: resolved.path,
    ...(version ? { version } : {}),
    ...(note ? { note } : {}),
    installHint: spec.installHint
  };
}

async function checkTool(spec: ToolSpec, env: NodeJS.ProcessEnv): Promise<DoctorToolStatus> {
  const installer = spec.installer ? { installer: true as const } : {};
  const binPath = findOnPath(spec.name, env);
  if (!binPath) {
    return { name: spec.name, required: spec.required, found: false, installHint: spec.installHint, ...installer };
  }
  // no-mistakes sends telemetry on every command; version and daemon probes
  // run with perch's default opt-out (an exported value wins, same rule as
  // the PTY spawn env).
  const execOptions = {
    timeout: EXEC_TIMEOUT_MS,
    ...(spec.name === "no-mistakes"
      ? { env: { ...process.env, [NO_MISTAKES_TELEMETRY_ENV]: process.env[NO_MISTAKES_TELEMETRY_ENV] ?? "0" } }
      : {})
  };
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
// override (one deliberate exception: the no-mistakes telemetry opt-out
// default above), so the injected PATH only affects lookup, never the tool's
// own environment.
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

// Report-only: the binary manages its own daemon (it autostarts on use), so
// this never tries to start or repair it.
async function noMistakesDaemonProbe(binPath: string, execOptions: ProbeExecOptions): Promise<string> {
  try {
    await execFileAsync(binPath, ["daemon", "status"], execOptions);
    return "daemon running";
  } catch {
    return "daemon not running (it autostarts on use)";
  }
}

// The no-mistakes binary as the environment doctor would resolve it. The init
// wiring and the dispatch readiness gate (T3) share this lookup so "binary
// present" means the same thing everywhere.
function noMistakesRuntime(deps: Pick<DoctorDeps, "noMistakesPath"> = {}): {
  path?: string;
  facts?: NoMistakesRuntimeFacts;
  error?: string;
} {
  if (Object.hasOwn(deps, "noMistakesPath")) {
    if (!deps.noMistakesPath) return { error: "bundled no-mistakes runtime unavailable" };
    try {
      accessSync(deps.noMistakesPath, constants.X_OK);
      if (!statSync(deps.noMistakesPath).isFile()) throw new Error("runtime is not a regular file");
      return { path: deps.noMistakesPath };
    } catch {
      return { error: "bundled no-mistakes runtime unavailable" };
    }
  }
  const resolution = resolveBundledNoMistakes();
  return resolution.ok && resolution.facts
    ? { path: resolution.facts.path, facts: resolution.facts }
    : { error: resolution.error ?? "bundled no-mistakes runtime unavailable" };
}

export function noMistakesBinary(deps: Pick<DoctorDeps, "noMistakesPath"> = {}): string | undefined {
  return noMistakesRuntime(deps).path;
}

export function noMistakesRuntimeFacts(): NoMistakesRuntimeFacts | undefined {
  return noMistakesRuntime().facts;
}

// A repo is initialized when `no-mistakes init` added its `no-mistakes` git
// remote to shared repo config - a cheap `git config` read, never a binary
// invocation.
export async function repoGateState(
  repoRoot: string
): Promise<{ initialized: boolean; note?: string }> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoRoot, "config", "--get", "remote.no-mistakes.url"],
      { timeout: EXEC_TIMEOUT_MS }
    );
    return { initialized: stdout.trim().length > 0 };
  } catch (error) {
    // Exit 1 means the key is simply absent (not initialized); anything else
    // means git could not read the repo at all.
    const code = (error as { code?: unknown }).code;
    return { initialized: false, ...(code !== 1 ? { note: "not a readable git repository" } : {}) };
  }
}

// Consent-driven `no-mistakes init` (O2: setting the mode IS the consent).
// Runs the vendor binary in the repo root; idempotent upstream ("sets up or
// refreshes"), so re-running on every mode set is safe. Output is captured
// verbatim so upstream errors surface unparaphrased.
export async function runNoMistakesInit(
  repoRoot: string,
  deps: Pick<DoctorDeps, "env" | "noMistakesPath"> = {}
): Promise<{ ok: boolean; output: string }> {
  const env = deps.env ?? process.env;
  const binPath = noMistakesBinary(deps);
  if (!binPath) {
    return { ok: false, output: "bundled no-mistakes runtime unavailable" };
  }
  if (Object.hasOwn(deps, "noMistakesPath")) {
    try {
      const { stdout } = await execFileAsync(binPath, ["--version"], {
        timeout: EXEC_TIMEOUT_MS,
        env: { ...env, [NO_MISTAKES_TELEMETRY_ENV]: env[NO_MISTAKES_TELEMETRY_ENV] ?? "0" }
      });
      if (!stdout.includes("v1.39.0-perch.1") || !stdout.includes("authorization-protocol=1")) {
        return { ok: false, output: "bundled runtime version or authorization protocol mismatch" };
      }
    } catch {
      return { ok: false, output: "bundled runtime version validation failed" };
    }
  } else {
    const validation = await validateBundledNoMistakes({ env });
    if (!validation.ok) return { ok: false, output: validation.error ?? "bundled runtime validation failed" };
  }
  try {
    // Same telemetry opt-out default as every other no-mistakes invocation
    // perch makes (an exported value wins).
    const { stdout, stderr } = await execFileAsync(binPath, ["init"], {
      cwd: repoRoot,
      timeout: INIT_TIMEOUT_MS,
      env: { ...process.env, [NO_MISTAKES_TELEMETRY_ENV]: process.env[NO_MISTAKES_TELEMETRY_ENV] ?? "0" }
    });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message?: string };
    const output = `${failed.stdout ?? ""}${failed.stderr ?? ""}`.trim();
    return { ok: false, output: output || (failed.message ?? "no-mistakes init failed") };
  }
}

async function projectGate(project: Project, binaryFound: boolean): Promise<DoctorProjectGate> {
  const { initialized, note } = await repoGateState(project.rootPath);
  return {
    rootPath: project.rootPath,
    name: project.name,
    ...(project.mode ? { mode: project.mode } : {}),
    initialized,
    ready: binaryFound && initialized,
    ...(note ? { note } : {})
  };
}
