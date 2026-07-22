// Perch-owned Codex app-server daemon lifecycle for the `--remote` topology.
// Perch spawns the ordinary Codex installation as
//   codex app-server --listen unix://<sock>
// and the real TUI attaches with `codex --remote unix://<sock>`, while a perch
// control client drives the same thread over the WebSocket `/rpc` channel.
//
// Any normal Codex installation with `app-server` and `--remote` support can
// host this topology without a separately managed binary.
//
// GOTCHA (verified live): a `--remote` turn inherits the DAEMON's cwd, not the
// TUI's. So the daemon key starts from the session workdir and the daemon is
// spawned WITH that cwd - never shared across workdirs - to preserve worktree
// isolation (see daemonKey for the full identity: overrides, hook identity,
// runtime fingerprint).
//
// GOTCHA (verified live): `unix://<path>` binds a socket FILE whose PARENT must
// be a real (non-symlink) directory - macOS `/tmp` is a symlink and codex
// rejects it. Sockets live under $PERCH_HOME (a real directory).

import { execFileSync, spawn as childSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { perchHome } from "../home.js";
import { CodexAppServerClient } from "./codexAppServer.js";
import { websocketUnixTransport } from "./wsUnixTransport.js";

// Which Codex driver perch should use for a session.
//   "app-server-remote" = Perch-owned daemon + `--remote` TUI +
//                         control client; per-turn model chip, protocol drive).
//   "pty"               = the existing PTY-only path (launch-time `-m` only).
export type CodexDriver = "app-server-remote" | "pty";

// Select the Codex driver. Install-independent: the only gates are that codex
// exists on PATH and that the platform has unix sockets (never win32). An
// operator can force the legacy path with PERCH_CODEX_REMOTE=0.
export function selectCodexDriver(opts?: {
  codexOnPath?: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): CodexDriver {
  const env = opts?.env ?? process.env;
  if (env.PERCH_CODEX_REMOTE === "0" || env.PERCH_CODEX_REMOTE === "false") return "pty";
  const platform = opts?.platform ?? process.platform;
  if (platform === "win32") return "pty";
  const onPath = opts?.codexOnPath ?? true;
  return onPath ? "app-server-remote" : "pty";
}

// Whether a `codex` executable is resolvable on PATH (the only real gate for
// the `--remote` topology). Best-effort and synchronous so it can inform driver
// selection at boot without blocking.
export function codexOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  const pathValue = env.PATH ?? "";
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of pathValue.split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      if (existsSync(join(dir, `codex${ext}`))) return true;
    }
  }
  return false;
}

// A running (or reused) daemon: the socket a `--remote` TUI and the control
// client both dial.
export type CodexDaemonHandle = {
  socketPath: string;
  cwd: string;
};

// A spawned daemon process, abstracted so tests inject a fake in place of a
// real `codex app-server` child.
export interface CodexDaemonProcess {
  readonly pid?: number;
  onExit(callback: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export type CodexDaemonSpawn = (args: {
  socketPath: string;
  cwd: string;
  // Extra `-c key=value` config overrides applied to the daemon (e.g.
  // `model_reasoning_effort="xhigh"`), so `--remote` turns inherit them.
  configOverrides?: string[];
  // Extra environment merged over the base env for this daemon process, so the
  // agent's tool shells inherit it (e.g. the per-session PERCH_HOOK_* wiring).
  env?: Record<string, string>;
}) => CodexDaemonProcess;

export type CodexDaemonManagerOptions = {
  env?: NodeJS.ProcessEnv;
  // Spawns `codex app-server --listen unix://<sock>` with the given cwd.
  spawn?: CodexDaemonSpawn;
  // Resolves once the daemon socket answers the JSON-RPC `initialize` handshake
  // (or rejects on timeout). Injectable so the manager is testable without a
  // real codex or real socket.
  waitHealthy?: (socketPath: string, timeoutMs: number) => Promise<void>;
  // How long to wait for a freshly spawned daemon to become healthy.
  startupTimeoutMs?: number;
  // Stable identity of the codex runtime currently on PATH, folded into daemon
  // keys (see codexRuntimeFingerprint). Injectable for tests.
  runtimeFingerprint?: () => string | undefined;
  // Stops an orphaned daemon found by sweepOrphans. The default re-verifies the
  // pid is still a `codex app-server` before signalling. Injectable for tests.
  killOrphan?: (pid: number) => void;
};

type DaemonEntry = {
  handle: CodexDaemonHandle;
  process: CodexDaemonProcess;
};

// Owns the perch daemons, one per session workdir. `acquire` starts a daemon
// (or reuses a live, healthy one) for a cwd and returns the socket to dial.
export class CodexDaemonManager {
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawn: CodexDaemonSpawn;
  private readonly waitHealthy: (socketPath: string, timeoutMs: number) => Promise<void>;
  private readonly startupTimeoutMs: number;
  private readonly runtimeFingerprint: () => string | undefined;
  private readonly killOrphan: (pid: number) => void;

  private readonly daemons = new Map<string, DaemonEntry>();
  // Single-flight: concurrent acquires of the same cwd share one startup.
  private readonly starting = new Map<string, Promise<CodexDaemonHandle>>();
  // The most recently spawned process per key, tracked from the spawn itself
  // (the daemons map only registers after waitHealthy). A replaced daemon's
  // delayed exit event consults this so it can never tear down its
  // successor's freshly bound socket/pidfile during the startup window.
  private readonly latestProcess = new Map<string, CodexDaemonProcess>();

  constructor(options: CodexDaemonManagerOptions = {}) {
    this.env = options.env ?? process.env;
    this.spawn = options.spawn ?? defaultDaemonSpawn(this.env);
    this.waitHealthy = options.waitHealthy ?? defaultWaitHealthy;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
    this.runtimeFingerprint = options.runtimeFingerprint ?? codexRuntimeFingerprint;
    this.killOrphan = options.killOrphan ?? defaultKillOrphan;
  }

  // Socket path for a workdir: $PERCH_HOME/codex-daemons/<short-hash>.sock. A
  // short hash keeps the path under the macOS sun_path limit (~104 bytes).
  // Config overrides, session-scoped hook identity, and the codex runtime
  // fingerprint fold into the hash so a daemon can never execute a later task
  // under stale hook credentials or an older codex than the client dialing it.
  socketPathFor(
    cwd: string,
    configOverrides: string[] = [],
    env?: Record<string, string>
  ): string {
    const hash = createHash("sha1")
      .update(this.daemonKeyFor(cwd, configOverrides, env))
      .digest("hex")
      .slice(0, 16);
    return join(perchHome(this.env), "codex-daemons", `${hash}.sock`);
  }

  private daemonKeyFor(cwd: string, configOverrides: string[], env?: Record<string, string>): string {
    return daemonKey(cwd, configOverrides, env, this.runtimeFingerprint());
  }

  async acquire(
    cwd: string,
    opts: { configOverrides?: string[]; env?: Record<string, string> } = {}
  ): Promise<CodexDaemonHandle> {
    const overrides = opts.configOverrides ?? [];
    const key = this.daemonKeyFor(cwd, overrides, opts.env);
    const existing = this.daemons.get(key);
    if (existing) {
      try {
        await this.waitHealthy(existing.handle.socketPath, 2_000);
        return existing.handle;
      } catch {
        // The recorded daemon died; drop it and start fresh below.
        this.forget(key);
      }
    }

    const inFlight = this.starting.get(key);
    if (inFlight) return inFlight;

    const startup = this.start(cwd, overrides, key, opts.env).finally(() => this.starting.delete(key));
    this.starting.set(key, startup);
    return startup;
  }

  private async start(
    cwd: string,
    configOverrides: string[],
    key: string,
    env?: Record<string, string>
  ): Promise<CodexDaemonHandle> {
    const socketPath = this.socketPathFor(cwd, configOverrides, env);
    mkdirSync(join(perchHome(this.env), "codex-daemons"), { recursive: true, mode: 0o700 });

    // A live socket already at this exact path: the path hash embeds the
    // session-scoped hook identity and the runtime fingerprint, so an
    // answering listener here is same-identity, same-runtime by construction
    // and safe to reuse. A stale file that no longer answers must be gone -
    // codex refuses to bind an in-use socket, and we rely on the spawn
    // erroring loudly rather than clobbering a healthy peer.
    if (existsSync(socketPath)) {
      try {
        await this.waitHealthy(socketPath, 2_000);
        const handle: CodexDaemonHandle = { socketPath, cwd };
        // This process was perch-spawned earlier this run (the key embeds the
        // session-scoped identity); recover its pidfile into a killable handle
        // so release()/stopAll() still enforce daemon-dies-with-its-session.
        this.daemons.set(key, { handle, process: this.adoptProcess(socketPath) });
        return handle;
      } catch {
        // A socket that no longer answers: usually a dead daemon, but possibly
        // one alive-but-unresponsive under load. Retire its recorded pid first
        // (killOrphan re-verifies identity; a dead or recycled pid is never
        // signalled) and remove BOTH files - the successor's spawn overwrites
        // the pidfile, and a hung daemon whose pid record is lost can never be
        // stopped by release() or a later boot sweep. Unlinking also lets
        // codex bind fresh (it refuses to bind an existing socket path).
        const stalePid = readPidFile(socketPath);
        if (stalePid !== undefined) {
          try {
            this.killOrphan(stalePid);
          } catch {
            /* never let a kill failure stop the replacement */
          }
        }
        removeDaemonFiles(socketPath);
      }
    }

    const process = this.spawn({ socketPath, cwd, configOverrides, env });
    // Record the pid next to the socket so a later boot's sweepOrphans can
    // retire this daemon if the server exits without stopAll.
    if (typeof process.pid === "number") {
      try {
        writeFileSync(pidFileFor(socketPath), String(process.pid), { mode: 0o600 });
      } catch {
        /* best effort */
      }
    }
    // Guarded on spawn identity: a delayed exit event from a daemon that was
    // already replaced must not tear down its successor's registration/files,
    // even while the successor is still inside waitHealthy (not yet in the
    // daemons map).
    this.latestProcess.set(key, process);
    process.onExit(() => {
      if (this.latestProcess.get(key) !== process) return;
      this.latestProcess.delete(key);
      this.forget(key);
      removeDaemonFiles(socketPath);
    });

    try {
      await this.waitHealthy(socketPath, this.startupTimeoutMs);
    } catch (error) {
      try {
        process.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      removeDaemonFiles(socketPath);
      throw error;
    }

    const handle: CodexDaemonHandle = { socketPath, cwd };
    this.daemons.set(key, { handle, process });
    return handle;
  }

  private forget(key: string): void {
    this.daemons.delete(key);
  }

  // Adopt a daemon found already listening at a path this manager owns: read
  // back the pid its original spawn recorded beside the socket. Kills route
  // through killOrphan, which re-verifies the pid still runs `codex
  // app-server` before signalling, so a recycled pid or a daemon without a
  // pidfile is never touched.
  private adoptProcess(socketPath: string): CodexDaemonProcess {
    const pid = readPidFile(socketPath);
    const killOrphan = this.killOrphan;
    return {
      pid,
      onExit() {
        /* not spawned by this handle; exits surface via health checks */
      },
      kill() {
        if (pid === undefined) return;
        killOrphan(pid);
      }
    };
  }

  // Adopt a daemon that is already listening at a recorded socket path from a
  // previous server life (app-server-owned recovery rebind). Health-checks the
  // socket and registers a killable handle recovered from the pidfile so
  // release()/stopAll() still apply. Returns null when nothing healthy answers
  // - the caller then respawns via acquire(). The adopt key is the socket path
  // itself: the original cwd/env-derived key is not reconstructible (the hook
  // identity that produced it belonged to the previous life).
  async adoptExisting(socketPath: string, cwd: string): Promise<CodexDaemonHandle | null> {
    for (const entry of this.daemons.values()) {
      if (entry.handle.socketPath === socketPath) return entry.handle;
    }
    if (!existsSync(socketPath)) return null;
    try {
      await this.waitHealthy(socketPath, 2_000);
    } catch {
      return null;
    }
    const handle: CodexDaemonHandle = { socketPath, cwd };
    this.daemons.set(`adopted:${socketPath}`, { handle, process: this.adoptProcess(socketPath) });
    return handle;
  }

  // A session-scoped daemon belongs to the control session that acquired it.
  // Stop it when that session detaches so sequential tasks do not accumulate
  // one live process per historical hook identity.
  release(socketPath: string): void {
    for (const [key, entry] of this.daemons) {
      if (entry.handle.socketPath !== socketPath) continue;
      try {
        entry.process.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      this.daemons.delete(key);
      removeDaemonFiles(socketPath);
      return;
    }
  }

  // Boot-time sweep of $PERCH_HOME/codex-daemons: daemons are children of the
  // server, so a non-graceful exit orphans them - live processes holding stale
  // hook credentials behind socket paths a restarted server (fresh session ids,
  // current runtime fingerprint) will never dial again. Everything in this
  // directory was perch-spawned, so the directory is the ownership boundary;
  // only pids recorded in its own pidfiles are ever signalled, and the default
  // killOrphan re-verifies the pid still runs `codex app-server` before
  // SIGTERM, so pid reuse can never hit an unrelated process. Call before the
  // first acquire - sockets not yet tracked by this manager are treated as
  // orphans. Bounded per pass; leftovers are picked up on the next boot.
  // `keep` lists socket paths that must SURVIVE the sweep: daemons recorded on
  // recoverable app-server-owned runtimes, whose live thread state is the very
  // thing the post-restart rebind reconnects to.
  sweepOrphans(keep?: ReadonlySet<string>): void {
    const dir = join(perchHome(this.env), "codex-daemons");
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    const owned = new Set<string>(keep ?? []);
    for (const entry of this.daemons.values()) {
      owned.add(entry.handle.socketPath);
    }
    let swept = 0;
    for (const name of names) {
      if (swept >= MAX_ORPHAN_SWEEP) break;
      const path = join(dir, name);
      if (name.endsWith(".sock")) {
        if (owned.has(path)) continue;
        swept += 1;
        const pid = readPidFile(path);
        if (pid !== undefined) {
          try {
            this.killOrphan(pid);
          } catch {
            /* never let a kill failure stop the sweep */
          }
        }
        removeDaemonFiles(path);
      } else if (name.endsWith(".sock.pid")) {
        // A dangling pidfile whose socket is already gone: the daemon exited
        // cleanly on its own; just drop the record (never signal a stale pid).
        const socketPath = path.slice(0, -".pid".length);
        if (owned.has(socketPath) || names.includes(name.slice(0, -".pid".length))) continue;
        try {
          rmSync(path, { force: true });
        } catch {
          /* best effort */
        }
      }
    }
  }

  // Stop every daemon this manager spawned (server shutdown). `keep` excludes
  // sockets of live app-server-owned sessions: their daemons deliberately
  // outlive a graceful restart so the next life can rebind without losing the
  // in-memory thread (their pidfiles stay for a later sweep/adopt decision).
  stopAll(keep?: ReadonlySet<string>): void {
    for (const [key, entry] of this.daemons) {
      if (keep?.has(entry.handle.socketPath)) {
        this.daemons.delete(key);
        continue;
      }
      try {
        entry.process.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      this.daemons.delete(key);
      removeDaemonFiles(entry.handle.socketPath);
    }
    this.starting.clear();
    this.latestProcess.clear();
  }
}

const MAX_ORPHAN_SWEEP = 128;

function pidFileFor(socketPath: string): string {
  return `${socketPath}.pid`;
}

function readPidFile(socketPath: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(pidFileFor(socketPath), "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 1 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function removeDaemonFiles(socketPath: string): void {
  for (const path of [socketPath, pidFileFor(socketPath)]) {
    try {
      rmSync(path, { force: true });
    } catch {
      /* best effort */
    }
  }
}

// SIGTERM an orphaned daemon by recorded pid, but only after re-verifying the
// pid still belongs to a `codex app-server` process - a recycled pid must
// never receive the signal.
function defaultKillOrphan(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000
    });
    if (!command.includes("codex") || !command.includes("app-server")) return;
    process.kill(pid, "SIGTERM");
  } catch {
    /* pid already gone (or ps unavailable): nothing to stop */
  }
}

// Cache/socket key for a daemon: workdir, config overrides, any scoped hook
// identity, and the codex runtime fingerprint. The hook values are hashed so
// tokens are never retained as map keys.
function daemonKey(
  cwd: string,
  configOverrides: string[],
  env?: Record<string, string>,
  runtime?: string
): string {
  const parts = [cwd];
  if (configOverrides.length) parts.push(configOverrides.join(" "));
  const scope = sessionScopeKey(env);
  if (scope) parts.push(scope);
  if (runtime) parts.push(`runtime:${runtime}`);
  return parts.join("\0");
}

// `codex --version` of the runtime currently on PATH, memoized per process.
// Folding it into daemon keys means a daemon left listening by an older codex
// install can never be adopted or reused by a newer client merely because its
// socket still answers initialize (verified live: a 0.142.5 daemon adopted by
// a 0.144.1 TUI rejected models the current runtime supports).
let runtimeFingerprintResolved = false;
let runtimeFingerprintValue: string | undefined;
export function codexRuntimeFingerprint(): string | undefined {
  if (!runtimeFingerprintResolved) {
    runtimeFingerprintResolved = true;
    try {
      const output = execFileSync("codex", ["--version"], { encoding: "utf8", timeout: 3_000 });
      runtimeFingerprintValue = output.trim() || undefined;
    } catch {
      runtimeFingerprintValue = undefined;
    }
  }
  return runtimeFingerprintValue;
}

function sessionScopeKey(env?: Record<string, string>): string | undefined {
  const values = [env?.PERCH_SESSION_ID, env?.PERCH_HOOK_URL, env?.PERCH_HOOK_TOKEN];
  if (!values.some(Boolean)) return undefined;
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

// The real daemon spawn: the ordinary codex, env-scrubbed of noisy rollout
// logging, listening on the unix socket with its cwd set to the session
// workdir (so `--remote` turns inherit the right directory).
function defaultDaemonSpawn(baseEnv: NodeJS.ProcessEnv): CodexDaemonSpawn {
  return ({ socketPath, cwd, configOverrides, env: extraEnv }) => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(baseEnv)) {
      if (typeof value === "string") env[key] = value;
    }
    // Per-session hook wiring (PERCH_HOOK_* etc.) wins over the inherited base.
    for (const [key, value] of Object.entries(extraEnv ?? {})) env[key] = value;
    const filter = "codex_core::rollout::list=off";
    if (!env.RUST_LOG) env.RUST_LOG = filter;
    else if (!env.RUST_LOG.includes("codex_core::rollout::list=")) env.RUST_LOG += `,${filter}`;

    // `-c key=value` config overrides are codex GLOBAL flags, so they must come
    // before the `app-server` subcommand. They set the daemon's config for every
    // `--remote` turn (e.g. `model_reasoning_effort="xhigh"`), which the
    // interactive `codex --remote` TUI otherwise resolves to the model default.
    const configArgs = (configOverrides ?? []).flatMap((override) => ["-c", override]);
    const child = childSpawn("codex", [...configArgs, "app-server", "--listen", `unix://${socketPath}`], {
      cwd,
      env,
      stdio: ["ignore", "ignore", "ignore"],
      detached: false,
      windowsHide: true
    });
    return {
      get pid() {
        return child.pid;
      },
      onExit(callback) {
        child.on("exit", (code) => callback(code));
        child.on("error", () => callback(null));
      },
      kill(signal) {
        child.kill(signal);
      }
    };
  };
}

// Default health probe: open a control connection over the WS `/rpc` transport
// and complete the `initialize` handshake within the timeout.
async function defaultWaitHealthy(socketPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) {
      const client = new CodexAppServerClient({
        sessionId: "codex-health",
        spawn: websocketUnixTransport({ socketPath })
      });
      try {
        await withTimeout(client.connect(), Math.max(500, deadline - Date.now()));
        await client.disconnect();
        return;
      } catch (error) {
        lastError = error;
        await client.disconnect().catch(() => {});
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `codex daemon did not become healthy on ${socketPath} within ${timeoutMs}ms` +
      (lastError instanceof Error ? `: ${lastError.message}` : "")
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
