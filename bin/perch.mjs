#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const DEFAULT_SERVER_URL = "http://127.0.0.1:8787";
const DETACH_BYTE = 0x1d;
// Ctrl+] as encoded when the mirrored agent enables a modern keyboard protocol
// (kitty progressive enhancement `CSI > 1 u`, xterm modifyOtherKeys) and the
// attached terminal honors it: kitty CSI-u `ESC [ 93 ; 5 [:1|:2] u` (press or
// repeat) and modifyOtherKeys `ESC [ 27 ; 5 ; 93 ~`.
const DETACH_SEQUENCE = /^\x1b\[(?:93;5(?::[12])?u|27;5;93~)$/;
// Undo terminal modes the mirrored agent may have pushed onto the attached
// terminal so the shell gets a normal terminal back after detach: kitty
// keyboard flags, modifyOtherKeys, mouse tracking (all encodings), focus
// reporting, color-scheme reporting, bracketed paste, plus show the cursor.
const TERMINAL_MODE_RESET =
  "\x1b[<u\x1b[>4;0m" +
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l" +
  "\x1b[?1004l\x1b[?2031l\x1b[?2004l\x1b[?25h";
const HEALTH_TIMEOUT_MS = 700;
const STARTUP_TIMEOUT_MS = 8000;
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_VERSION = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;
const NO_MISTAKES_MANIFEST = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, "vendor/no-mistakes/manifest.json"), "utf8")
);

// Mirrors apps/server/src/home.ts; keep the paths in sync.
const PERCH_HOME = process.env.PERCH_HOME ?? join(homedir(), ".perch");
const TOKEN_PATH = join(PERCH_HOME, "token");
const PID_PATH = join(PERCH_HOME, "perch.pid");
const LOG_PATH = join(PERCH_HOME, "server.log");

const AGENTS = {
  codex: { command: "codex", agent: "codex", label: "Codex" },
  claude: { command: "claude", agent: "claude", label: "Claude" }
};

// Mirrors MATE_CLAUDE_FALLBACK_MODEL in apps/server/src/models.ts; keep in
// sync. A fresh Claude mate with no configured model pins this instead of
// inheriting the Claude CLI's drifting global default.
const MATE_CLAUDE_FALLBACK_MODEL = "best";

// Mirrors MATE_CODEX_FALLBACK in apps/server/src/models.ts; keep in sync. A
// fresh Codex mate without an applicable configured model pins this instead
// of inheriting the Codex CLI's default.
const MATE_CODEX_FALLBACK = { model: "gpt-5.6-sol", effort: "medium" };

const AGENT_COMMANDS = new Set(["run", ...Object.keys(AGENTS)]);

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`perch: ${message}`);
  process.exit(1);
});

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.version) {
    console.log(PACKAGE_VERSION);
    return;
  }

  if (parsed.help || parsed.command === "help" || !parsed.command) {
    printHelp(parsed.command === "help" ? parsed.args[0] : parsed.command);
    return;
  }

  if (parsed.command === "server") {
    await runServerCommand(parsed.args[0] ?? "status", parsed.options);
    return;
  }

  if (parsed.command === "uninstall") {
    await runUninstall(parsed.options);
    return;
  }

  await ensureServerRunning(parsed.options);

  if (parsed.command === "ls") {
    await listSessions(parsed.options);
    return;
  }

  if (parsed.command === "pair") {
    await pairDevice(parsed.options);
    return;
  }

  if (parsed.command === "devices") {
    await runDevicesCommand(parsed.args, parsed.options);
    return;
  }

  if (parsed.command === "project") {
    await runProjectCommand(parsed.args, parsed.options);
    return;
  }

  if (parsed.command === "config") {
    await runConfigCommand(parsed.args, parsed.options);
    return;
  }

  if (parsed.command === "runtime") {
    await runRuntimeCommand(parsed.args, parsed.options);
    return;
  }

  if (parsed.command === "models") {
    await runModelsCommand(parsed.args, parsed.options);
    return;
  }

  if (parsed.command === "worktrees") {
    await runWorktreesCommand(parsed.args, parsed.options);
    return;
  }

  if (parsed.command === "doctor") {
    await runDoctorCommand(parsed.args, parsed.options);
    return;
  }

  if (parsed.command === "recover") {
    await runRecoverCommand(parsed.args, parsed.options);
    return;
  }

  if (parsed.command === "stop") {
    const sessionRef = parsed.args[0];
    if (!sessionRef) {
      throw new Error("stop requires a session id");
    }
    const session = await resolveSession(sessionRef, parsed.options);
    const response = await fetch(httpUrl(parsed.options, `/sessions/${encodeURIComponent(session.id)}`), {
      method: "DELETE",
      headers: jsonHeaders(parsed.options)
    });
    if (!response.ok) {
      throw new Error(await responseError(response));
    }
    console.log(`stopped ${shortSessionId(session.id)}`);
    return;
  }

  if (parsed.command === "attach") {
    const sessionRef = parsed.args[0];
    if (!sessionRef) {
      throw new Error("attach requires a session id");
    }
    const session = await resolveSession(sessionRef, parsed.options);
    if (session.status === "done" || session.status === "error") {
      const short = shortSessionId(session.id);
      console.error(`Session ${short} already ended (${session.status}) - the agent process exited, so there is nothing to attach to.`);
      console.error("Exiting the agent ends its perch session; detach with Ctrl-] to keep it running. Start a new session with `perch claude` (see `perch ls`).");
      process.exitCode = 1;
      return;
    }
    await attachToSession(session.id, parsed.options);
    return;
  }

  if (parsed.command === "mate") {
    await runMateCommand(parsed);
    return;
  }

  await maybePrintPairingHint(parsed.options);

  const request = makeStartRequest(parsed);

  if (!parsed.options.attach) {
    const session = await startViaHttp(request, parsed.options);
    printStarted(session);
    return;
  }

  await startAndAttach(request, parsed.options);
}

// ---------------------------------------------------------------------------
// Server lifecycle: token, autostart, status/stop/logs
// ---------------------------------------------------------------------------

function readOrCreateToken() {
  mkdirSync(PERCH_HOME, { recursive: true, mode: 0o700 });

  const existing = readTokenFile();
  if (existing) {
    return existing;
  }

  const token = randomBytes(32).toString("hex");
  const stagingPath = join(PERCH_HOME, `.token.${process.pid}.${randomBytes(4).toString("hex")}`);
  writeFileSync(stagingPath, `${token}\n`, { mode: 0o600 });
  chmodSync(stagingPath, 0o600);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        linkSync(stagingPath, TOKEN_PATH);
        return token;
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw error;
        }
        const raced = readTokenFile();
        if (raced) {
          return raced;
        }
        rmSync(TOKEN_PATH, { force: true });
      }
    }
    throw new Error(`could not create token file at ${prettyPath(TOKEN_PATH)}`);
  } finally {
    rmSync(stagingPath, { force: true });
  }
}

function readTokenFile() {
  if (!existsSync(TOKEN_PATH)) {
    return undefined;
  }
  const token = readFileSync(TOKEN_PATH, "utf8").trim();
  return token || undefined;
}

function resolveToken(options) {
  options.token ??= readOrCreateToken();
  return options.token;
}

function isLocalServer(options) {
  const url = new URL(options.server);
  return url.hostname === "127.0.0.1" || url.hostname === "localhost";
}

async function fetchHealth(options) {
  try {
    const response = await fetch(httpUrl(options, "/health"), {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
    });
    if (!response.ok) {
      return undefined;
    }
    const health = await response.json();
    if (health?.ok !== true || typeof health.adapter !== "string") {
      return undefined;
    }
    return health;
  } catch {
    return undefined;
  }
}

function serverEntryPath() {
  const binDir = dirname(fileURLToPath(import.meta.url));
  return join(binDir, "..", "apps", "server", "dist", "index.js");
}

async function ensureServerRunning(options) {
  if (await fetchHealth(options)) {
    return;
  }

  if (!isLocalServer(options)) {
    throw new Error(`cannot reach perch server at ${options.server}`);
  }

  const entry = serverEntryPath();
  if (!existsSync(entry)) {
    throw new Error(`server build missing at ${entry} - run \`npm run build\` first`);
  }

  process.stderr.write("perch server not running, starting... ");
  mkdirSync(PERCH_HOME, { recursive: true, mode: 0o700 });
  const logFd = openSync(LOG_PATH, "a");
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      PORT: String(new URL(options.server).port || 8787)
    }
  });
  child.unref();

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await fetchHealth(options)) {
      console.error(`ok (pid ${child.pid}, log: ${prettyPath(LOG_PATH)})`);
      return;
    }
    await delay(150);
  }

  // The most common failure: another process (often an old dev server)
  // already owns the port, so our spawn crashed with EADDRINUSE.
  try {
    const log = readFileSync(LOG_PATH, "utf8");
    if (log.slice(-2000).includes("EADDRINUSE")) {
      const port = new URL(options.server).port || "8787";
      throw new Error(
        `port ${port} is already in use by something that is not a perch server - stop it first, or set PERCH_SERVER_URL to a different port`
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("already in use")) {
      throw error;
    }
  }

  throw new Error(`server did not become healthy within ${STARTUP_TIMEOUT_MS / 1000}s - check ${prettyPath(LOG_PATH)}`);
}

async function runServerCommand(action, options) {
  if (action === "status") {
    const health = await fetchHealth(options);
    if (health) {
      const pid = readPid();
      console.log(`running${pid ? ` (pid ${pid})` : ""} at ${options.server}`);
      console.log(`adapter: ${health.adapter}  version: ${health.version}`);
    } else {
      console.log("not running");
    }
    return;
  }

  if (action === "stop") {
    const pid = readPid();
    if (!pid) {
      console.log("not running (no pidfile)");
      return;
    }
    // A stale pidfile can point at a recycled PID after an unclean death or
    // reboot; never SIGTERM a process that is not actually a perch server.
    if (!isPerchServerProcess(pid)) {
      console.log(`pid ${pid} is not a perch server (stale pidfile) - not stopping it`);
      return;
    }
    try {
      process.kill(pid, "SIGTERM");
      console.log(`stopped (pid ${pid})`);
    } catch {
      console.log(`no process with pid ${pid} (stale pidfile)`);
    }
    return;
  }

  if (action === "logs") {
    if (!existsSync(LOG_PATH)) {
      console.log(`no log file at ${prettyPath(LOG_PATH)}`);
      return;
    }
    const text = readFileSync(LOG_PATH, "utf8");
    const lines = text.split("\n");
    process.stdout.write(lines.slice(-100).join("\n"));
    return;
  }

  if (action === "start") {
    await ensureServerRunning(options);
    console.log(`running at ${options.server}`);
    return;
  }

  throw new Error(`unknown server action: ${action} (expected status|start|stop|logs)`);
}

function readPid() {
  try {
    const pid = Number(readFileSync(PID_PATH, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 1) {
      return undefined;
    }
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

function isPerchServerProcess(pid) {
  try {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    if (result.status !== 0) {
      return false;
    }
    const command = (result.stdout ?? "").trim();
    return /apps\/server\/dist\/index\.js/.test(command);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

async function pairDevice(options) {
  const response = await fetch(httpUrl(options, "/devices"), {
    method: "POST",
    headers: jsonHeaders(options),
    body: JSON.stringify({ name: options.title })
  });
  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  const body = await response.json();

  const { default: qrcode } = await import("qrcode-terminal");
  console.log("");
  console.log("  Scan with the Perch app to pair this Mac:");
  console.log("");
  qrcode.generate(body.url, { small: true }, (qr) => {
    console.log(
      qr
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n")
    );
  });
  console.log(`  Or paste this offer into the app:`);
  console.log(`  ${body.url}`);
  console.log("");
  console.log(`  Paired device slot: ${body.device.name} (revoke with \`perch devices revoke ${body.device.id.slice(0, 8)}\`)`);
}

// One quiet line on agent start when no phone is paired yet. The full QR
// lives behind `perch pair` so the agent TUI takeover stays clean.
async function maybePrintPairingHint(options) {
  if (!process.stderr.isTTY) {
    return;
  }
  try {
    const response = await fetch(httpUrl(options, "/devices"), { headers: jsonHeaders(options) });
    if (!response.ok) {
      return;
    }
    const body = await response.json();
    if (!body.devices?.length) {
      console.error("tip: no phone paired yet - run `perch pair` to connect the Perch app");
    }
  } catch {
    // Hint only; never block startup on it.
  }
}

async function runDevicesCommand(args, options) {
  const action = args[0] ?? "ls";

  if (action === "ls") {
    const response = await fetch(httpUrl(options, "/devices"), { headers: jsonHeaders(options) });
    if (!response.ok) {
      throw new Error(await responseError(response));
    }
    const body = await response.json();
    if (!body.devices.length) {
      console.log("no paired devices - run `perch pair`");
      return;
    }
    for (const device of body.devices) {
      const seen = device.lastSeenAt ? `last seen ${humanizeSince(device.lastSeenAt)}` : "never connected";
      console.log(`${device.id.slice(0, 8)}  ${device.name}  (${seen})`);
    }
    return;
  }

  if (action === "revoke") {
    const id = args[1];
    if (!id) {
      throw new Error("devices revoke requires a device id");
    }
    const response = await fetch(httpUrl(options, `/devices/${encodeURIComponent(id)}`), {
      method: "DELETE",
      headers: jsonHeaders(options)
    });
    if (!response.ok) {
      throw new Error(await responseError(response));
    }
    console.log("revoked");
    return;
  }

  throw new Error(`unknown devices action: ${action} (expected ls|revoke)`);
}

// ---------------------------------------------------------------------------
// Project registry: list / add / remove
// ---------------------------------------------------------------------------

const PROJECT_MODES = new Set(["direct-PR", "no-mistakes", "local-only"]);

async function runProjectCommand(args, options) {
  const action = args[0] ?? "list";

  if (action === "list" || action === "ls") {
    const response = await fetch(httpUrl(options, "/projects"), { headers: jsonHeaders(options) });
    if (!response.ok) {
      throw new Error(await responseError(response));
    }
    const body = await response.json();
    const projects = body.projects ?? [];
    if (!projects.length) {
      console.log("no projects yet - they register themselves when a session starts, or run `perch project add <path>`");
      return;
    }
    const rows = projects.map((project) => ({
      name: project.name,
      mode: project.mode ?? "direct-PR (default)",
      yolo: project.yolo ? "true" : "false (default)",
      used: humanizeSince(project.lastUsedAt),
      path: prettyPath(project.rootPath)
    }));
    const widths = {
      name: Math.max(4, ...rows.map((row) => row.name.length)),
      mode: Math.max(4, ...rows.map((row) => row.mode.length)),
      yolo: Math.max(4, ...rows.map((row) => row.yolo.length)),
      used: Math.max(9, ...rows.map((row) => row.used.length))
    };
    console.log(
      `${"NAME".padEnd(widths.name)}  ${"MODE".padEnd(widths.mode)}  ${"YOLO".padEnd(widths.yolo)}  ${"LAST USED".padEnd(widths.used)}  PATH`
    );
    for (const row of rows) {
      console.log(
        `${row.name.padEnd(widths.name)}  ${row.mode.padEnd(widths.mode)}  ${row.yolo.padEnd(widths.yolo)}  ${row.used.padEnd(widths.used)}  ${row.path}`
      );
    }
    return;
  }

  if (action === "add") {
    const { path, mode, yolo, yes } = parseProjectArgs(args.slice(1), "add");
    const root = resolve(path);
    if (!existsSync(root)) {
      throw new Error(`no such directory: ${root}`);
    }
    // O2: setting mode no-mistakes is consent to run `no-mistakes init` in the
    // repo right away, so the CLI asks first (skipped under --yes / non-TTY).
    if (mode === "no-mistakes" && !yes && process.stdin.isTTY) {
      const answer = await promptLine(`initialize the no-mistakes gate in ${prettyPath(root)} now? [Y/n] `);
      if (/^n/i.test(answer.trim())) {
        console.log("aborted - setting the mode runs `no-mistakes init`; nothing registered");
        return;
      }
    }
    const response = await fetch(httpUrl(options, "/projects"), {
      method: "POST",
      headers: jsonHeaders(options),
      body: JSON.stringify({
        rootPath: root,
        ...(mode ? { mode } : {}),
        ...(yolo !== undefined ? { yolo } : {})
      })
    });
    if (!response.ok) {
      throw new Error(await responseError(response));
    }
    const body = await response.json();
    console.log(`registered ${body.project.name} (${prettyPath(body.project.rootPath)})`);
    if (body.noMistakes?.warning) {
      console.log(`warning: ${body.noMistakes.warning}`);
    } else if (body.noMistakes?.ran) {
      console.log("no-mistakes gate initialized");
    }
    return;
  }

  if (action === "remove" || action === "rm") {
    const { path } = parseProjectArgs(args.slice(1), "remove");
    const root = resolve(path);
    const response = await fetch(httpUrl(options, "/projects"), {
      method: "DELETE",
      headers: jsonHeaders(options),
      body: JSON.stringify({ rootPath: root })
    });
    if (!response.ok) {
      throw new Error(await responseError(response));
    }
    console.log(`removed ${prettyPath(root)} from the registry (the directory itself is untouched)`);
    return;
  }

  if (action === "show") {
    const { path } = parseProjectArgs(args.slice(1), "show");
    const root = resolve(path);
    const response = await fetch(httpUrl(options, "/projects"), { headers: jsonHeaders(options) });
    if (!response.ok) throw new Error(await responseError(response));
    const project = (await response.json()).projects?.find((entry) => resolve(entry.rootPath) === root);
    if (!project) throw new Error(`unknown project: ${root}`);
    console.log(`PROJECT  ${project.name}\nPATH     ${prettyPath(project.rootPath)}\nMODE     ${project.mode ?? "direct-PR (built-in default)"}\nYOLO     ${project.yolo ? "true" : "false (built-in default)"}`);
    return;
  }

  if (action === "set") {
    const { path, mode, yolo, yes } = parseProjectArgs(args.slice(1), "set");
    if (mode === undefined && yolo === undefined) throw new Error("project set requires --mode or --yolo");
    const root = resolve(path);
    if (mode === "no-mistakes") {
      const config = await fetchConfig(options);
      validateBundledRuntimeEntries(config.entries ?? {});
      if (!yes && !process.stdin.isTTY) throw new Error("setting project mode=no-mistakes requires confirmation; rerun with --yes");
    }
    const response = await fetch(httpUrl(options, "/projects"), { method: "PATCH", headers: jsonHeaders(options), body: JSON.stringify({ rootPath: root, ...(mode !== undefined ? { mode } : {}), ...(yolo !== undefined ? { yolo } : {}) }) });
    if (!response.ok) throw new Error(await responseError(response));
    console.log(`updated ${prettyPath(root)}`);
    return;
  }

  throw new Error(`unknown project action: ${action} (expected list|add|show|set|remove)`);
}

function parseProjectArgs(args, action) {
  let path;
  let mode;
  let yolo;
  let yes;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--mode") {
      mode = requireValue(args, (index += 1), arg);
    } else if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length);
    } else if (arg === "--yolo") {
      yolo = true;
    } else if (arg === "--no-yolo") {
      yolo = false;
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option for project ${action}: ${arg}`);
    } else if (!path) {
      path = arg;
    } else {
      throw new Error(`project ${action} takes one path (got "${arg}" too)`);
    }
  }
  if (!path) {
    throw new Error(`project ${action} requires a path`);
  }
  if (mode !== undefined && !PROJECT_MODES.has(mode)) {
    throw new Error(`invalid --mode: ${mode} (expected ${[...PROJECT_MODES].join("|")})`);
  }
  return { path, mode, yolo, yes };
}

// ---------------------------------------------------------------------------
// First-class configuration
// ---------------------------------------------------------------------------

const CONFIG_KEYS = {
  "dispatch.agent": { scope: "global", layer: "dispatchDefaults", field: "agent" },
  "dispatch.model": { scope: "global", layer: "dispatchDefaults", field: "model" },
  "dispatch.effort": { scope: "global", layer: "dispatchDefaults", field: "effort" },
  "mate.agent": { scope: "global", layer: "mateDefaults", field: "agent" },
  "mate.model": { scope: "global", layer: "mateDefaults", field: "model" },
  "mate.effort": { scope: "global", layer: "mateDefaults", field: "effort" }
};
const CONFIG_AGENTS = new Set(["claude", "codex"]);
const CONFIG_MODES = new Set(["direct-PR", "no-mistakes", "local-only"]);

async function fetchConfig(options, project) {
  const query = `?effective=1${project ? `&project=${encodeURIComponent(project)}` : ""}`;
  const response = await fetch(httpUrl(options, `/config${query}`), { headers: jsonHeaders(options) });
  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  return response.json();
}

async function fetchModels(options) {
  const response = await fetch(httpUrl(options, "/models?claude=bundled"), { headers: jsonHeaders(options) });
  if (!response.ok) throw new Error(await responseError(response));
  return response.json();
}

async function runModelsCommand(args, options) {
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else throw new Error(`unknown models option: ${arg}`);
  }
  const [registry, config] = await Promise.all([fetchModels(options), fetchConfig(options)]);
  const models = modelInventory(registry, config);
  const notes = modelSourceNotes(registry);
  if (json) {
    console.log(JSON.stringify({
      generatedAt: registry.generatedAt ?? registry.at,
      models,
      notes,
      sources: registry.sources ?? []
    }, null, 2));
    return;
  }
  const tableRows = models.map((model) => [
    model.model,
    model.agent,
    model.efforts.length ? model.efforts.join(",") : "-",
    model.aliases.length ? model.aliases.join(",") : "-",
    model.source,
    model.selected.length ? model.selected.join(",") : "-"
  ]);
  printTable(["MODEL", "AGENT", "EFFORTS", "ALIASES", "SOURCE", "SELECTED"], tableRows);
  for (const note of notes) console.error(`Note: ${note}`);
}

function modelInventory(registry, config) {
  const selected = {
    mate: config.mateResolved ?? config.mateDefaults ?? {},
    dispatch: config.dispatchResolved ?? config.dispatchDefaults ?? {}
  };
  const rows = [];
  for (const provider of registry.providers ?? []) {
    for (const entry of provider.options ?? []) {
      if (entry.status === "unknown") continue;
      const model = entry.runtimeId ?? entry.id;
      const aliases = modelAliases(entry, model);
      const selectedRoles = Object.entries(selected)
        .filter(([, value]) => value?.agent === provider.provider && [model, ...aliases].includes(value?.model))
        .map(([role]) => role);
      // Hidden catalog entries (meta-aliases, older families) are not offered,
      // but one that is actively selected stays listed rather than vanishing.
      if (entry.hidden === true && selectedRoles.length === 0) continue;
      rows.push({
        model,
        agent: provider.provider,
        efforts: entry.supportedReasoningEfforts ?? [],
        aliases,
        source: entry.runtimeSource === "codex-app-server" ? "live" : "bundled",
        selected: selectedRoles
      });
    }
  }
  return rows;
}

function modelAliases(entry, model = entry.runtimeId ?? entry.id) {
  return [...new Set([entry.id, entry.runtimeId, entry.nativeProviderId, entry.apiId]
    .filter((value) => typeof value === "string" && value.length > 0 && value !== model))];
}

function modelSourceNotes(registry) {
  const notes = new Map();
  for (const source of registry.sources ?? []) {
    if (source.role !== "runtime" || (source.ok && source.status !== "fallback" && source.status !== "failed")) continue;
    if (!notes.has(source.name)) notes.set(source.name, `${source.name}: ${source.reason ?? source.status ?? "unavailable"}`);
  }
  return [...notes.values()];
}

function printTable(headers, rows) {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => String(row[index]).length)));
  console.log(headers.map((header, index) => header.padEnd(widths[index])).join("  "));
  for (const row of rows) {
    console.log(row.map((value, index) => String(value).padEnd(widths[index])).join("  "));
  }
}

async function runConfigCommand(args, options) {
  const parsed = parseConfigArgs(args);
  if (!["show", "get", "set", "unset", "validate"].includes(parsed.action)) {
    throw new Error(`unknown config action: ${parsed.action} (expected show|get|set|unset|validate)`);
  }
  const expectedPositionals = parsed.action === "set" ? 2 : ["get", "unset"].includes(parsed.action) ? 1 : 0;
  if (parsed.action === "set" && parsed.positionals.length < 2) {
    throw new Error(`config set ${parsed.positionals[0] ?? "<key>"} requires a value`);
  }
  if (parsed.positionals.length !== expectedPositionals) {
    throw new Error(`config ${parsed.action} expects ${expectedPositionals} positional argument${expectedPositionals === 1 ? "" : "s"}`);
  }
  if ((parsed.action === "set" || parsed.action === "unset") && parsed.effective) {
    throw new Error("--effective is read-only and cannot be used with config mutations");
  }
  if (parsed.action === "set" && ["mate", "dispatch"].includes(parsed.positionals[0])) {
    await setRoleModel(parsed, options);
    return;
  }
  if (parsed.agent || parsed.effort) {
    throw new Error("--agent and --effort are only valid with `perch config set mate|dispatch <model>`");
  }
  if (parsed.action === "set" || parsed.action === "unset") {
    if (parsed.action === "set" && /^(mate|dispatch)\.(agent|model|effort)$/.test(parsed.positionals[0])) {
      const role = parsed.positionals[0].split(".")[0];
      console.error(`Deprecated: use \`perch config set ${role} <model> [--effort <level>]\` for atomic model selection.`);
    }
    await mutateConfig(parsed, options);
    return;
  }
  if (parsed.project) throw new Error("project settings moved to `perch project show|set <path>`");
  const config = await fetchConfig(options);
  let entries = redactConfigEntries(config.entries ?? {});
  entries = Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry.scope === "global"));
  if (parsed.action === "validate") {
    validateConfigEntries(entries, parsed);
    if (parsed.json) console.log(JSON.stringify({ valid: true, entries }, null, 2));
    else console.log("configuration valid");
    return;
  }
  if (parsed.action === "get") {
    const key = requireConfigKey(parsed.positionals[0], entries);
    const entry = entries[key];
    if (parsed.json) console.log(JSON.stringify({ key, ...entry }, null, 2));
    else if (parsed.effective) console.log(`${formatConfigValue(entry.effectiveValue)} (${entry.source}, ${entry.scope})`);
    else console.log(formatConfigValue(entry.storedValue));
    return;
  }
  entries = { ...entries, ...await roleResolutionEntries(config, options) };
  const selected = entries;
  if (parsed.json) {
    console.log(JSON.stringify(selected, null, 2));
    return;
  }
  for (const [key, entry] of Object.entries(selected)) {
    const value = parsed.effective ? entry.effectiveValue : entry.storedValue;
    console.log(`${key.padEnd(34)} ${formatConfigValue(value).padEnd(18)} ${entry.source.padEnd(11)} ${entry.scope}`);
  }
}

function parseConfigArgs(args) {
  const parsed = {
    action: args[0] ?? "show",
    global: false,
    project: undefined,
    effective: false,
    json: false,
    yes: false,
    agent: undefined,
    effort: undefined,
    positionals: []
  };
  for (let index = args[0] ? 1 : 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--global") parsed.global = true;
    else if (value === "--project") {
      parsed.project = args[index + 1];
      if (!parsed.project) throw new Error("--project requires an absolute or relative path");
      index += 1;
    } else if (value === "--effective") parsed.effective = true;
    else if (value === "--json") parsed.json = true;
    else if (value === "--yes") parsed.yes = true;
    else if (value === "--agent") {
      parsed.agent = args[index + 1];
      if (!parsed.agent) throw new Error("--agent requires claude or codex");
      index += 1;
    } else if (value === "--effort") {
      parsed.effort = args[index + 1];
      if (!parsed.effort) throw new Error("--effort requires a level");
      index += 1;
    } else if (value.startsWith("--")) throw new Error(`unknown config option: ${value}`);
    else parsed.positionals.push(value);
  }
  if (parsed.global && parsed.project) throw new Error("choose exactly one of --global or --project PATH");
  return parsed;
}

async function setRoleModel(parsed, options) {
  if (parsed.project) throw new Error("atomic model selection is global-only");
  if (parsed.agent && !CONFIG_AGENTS.has(parsed.agent)) {
    throw new Error(`invalid --agent: ${parsed.agent} (expected ${[...CONFIG_AGENTS].join("|")})`);
  }
  const [role, requestedModel] = parsed.positionals;
  const registry = await fetchModels(options);
  let candidates = modelCandidates(registry, requestedModel, parsed.agent);
  if (!candidates.length) throw unknownModelError(registry, requestedModel, parsed.agent);
  const agents = [...new Set(candidates.map((candidate) => candidate.agent))];
  if (agents.length > 1) {
    if (!process.stdin.isTTY) {
      throw new Error(`model "${requestedModel}" is available for multiple agents (${agents.join(", ")}); rerun with --agent <agent>`);
    }
    const answer = (await promptLine(`Model "${requestedModel}" is available for ${agents.join(" or ")}. Choose agent: `)).trim();
    if (!agents.includes(answer)) throw new Error(`invalid agent choice "${answer}" (expected ${agents.join("|")})`);
    candidates = candidates.filter((candidate) => candidate.agent === answer);
  }
  const selected = candidates[0];
  const efforts = selected.entry.supportedReasoningEfforts ?? [];
  if (parsed.effort && !efforts.includes(parsed.effort)) {
    throw new Error(`invalid effort "${parsed.effort}" for model "${selected.model}". Valid efforts: ${efforts.length ? efforts.join(", ") : "none"}`);
  }
  const effort = parsed.effort ?? defaultModelEffort(selected.provider, selected.entry);
  const layer = role === "mate" ? "mateDefaults" : "dispatchDefaults";
  const response = await fetch(httpUrl(options, "/config"), {
    method: "PATCH",
    headers: jsonHeaders(options),
    body: JSON.stringify({ [layer]: { agent: selected.agent, model: selected.model, effort: effort ?? null } })
  });
  if (!response.ok) throw new Error(await responseError(response));
  if (parsed.json) {
    console.log(JSON.stringify({ role, agent: selected.agent, model: selected.model, effort: effort ?? null }, null, 2));
  } else {
    console.log(`${role} = ${selected.agent}/${selected.model}${effort ? ` (${effort})` : ""}`);
  }
}

function modelCandidates(registry, identifier, requestedAgent) {
  const direct = [];
  const aliases = [];
  for (const provider of registry.providers ?? []) {
    if (requestedAgent && provider.provider !== requestedAgent) continue;
    for (const entry of provider.options ?? []) {
      const model = entry.runtimeId ?? entry.id;
      const candidate = { agent: provider.provider, model, provider, entry };
      if (identifier === entry.id || identifier === entry.runtimeId) direct.push(candidate);
      else if (modelAliases(entry, model).includes(identifier)) aliases.push(candidate);
    }
  }
  const agents = new Set([...direct, ...aliases].map((candidate) => candidate.agent));
  const matches = [...agents].flatMap((agent) => {
    const agentDirect = direct.filter((candidate) => candidate.agent === agent);
    return agentDirect.length ? agentDirect : aliases.filter((candidate) => candidate.agent === agent);
  });
  return [...new Map(matches.map((candidate) => [`${candidate.agent}:${candidate.model}`, candidate])).values()];
}

function defaultModelEffort(provider, entry) {
  if (provider.provider !== "codex") return undefined;
  if (entry.defaultReasoningEffort) return entry.defaultReasoningEffort;
  const roleDefault = Object.values(provider.roleDefaults ?? {}).find((value) => value?.model === (entry.runtimeId ?? entry.id));
  if (roleDefault?.effort) return roleDefault.effort;
  const efforts = entry.supportedReasoningEfforts ?? [];
  return efforts.includes("medium") ? "medium" : efforts[0];
}

function unknownModelError(registry, identifier, requestedAgent) {
  const choices = [];
  for (const provider of registry.providers ?? []) {
    if (requestedAgent && provider.provider !== requestedAgent) continue;
    for (const entry of provider.options ?? []) {
      const model = entry.runtimeId ?? entry.id;
      for (const value of [model, ...modelAliases(entry, model)]) {
        choices.push({ value, agent: provider.provider, distance: editDistance(identifier, value) });
      }
    }
  }
  const suggestions = [...new Map(choices.sort((a, b) => a.distance - b.distance || a.value.localeCompare(b.value))
    .map((choice) => [`${choice.agent}:${choice.value}`, choice])).values()].slice(0, 3);
  return new Error(`unknown model "${identifier}".${suggestions.length ? ` Closest matches: ${suggestions.map((item) => `${item.value} (${item.agent})`).join(", ")}.` : ""} Run \`perch models\` to list available models.`);
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
        ? previous[rightIndex - 1]
        : 1 + Math.min(previous[rightIndex - 1], previous[rightIndex], current[rightIndex - 1]);
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

async function roleResolutionEntries(config, options) {
  let registry;
  try {
    registry = await fetchModels(options);
  } catch (error) {
    const value = `model registry unavailable: ${error instanceof Error ? error.message : String(error)}`;
    return Object.fromEntries(["dispatch", "mate"].map((role) => [`${role}.warning`, syntheticConfigEntry(value)]));
  }
  const result = {};
  for (const role of ["dispatch", "mate"]) {
    const defaults = config[role === "mate" ? "mateDefaults" : "dispatchDefaults"] ?? {};
    const resolved = config[role === "mate" ? "mateResolved" : "dispatchResolved"] ?? defaults;
    if (resolved.agent) result[`${role}.resolved-agent`] = syntheticConfigEntry(resolved.agent);
    const configuredModel = defaults.model;
    if (!configuredModel || configuredModel === "auto" || !defaults.agent) continue;
    if (!modelCandidates(registry, configuredModel, defaults.agent).length) {
      const otherAgents = [...new Set(modelCandidates(registry, configuredModel).map((candidate) => candidate.agent))];
      const detail = otherAgents.length ? `; model resolves to ${otherAgents.join(", ")}` : "";
      result[`${role}.warning`] = syntheticConfigEntry(`invalid ${defaults.agent}/${configuredModel} tuple${detail}`);
    }
  }
  return result;
}

function syntheticConfigEntry(value) {
  return {
    effectiveValue: value,
    source: "automatic",
    scope: "global",
    storedValue: value,
    defaultValue: null,
    overriddenBy: null,
    readOnly: true
  };
}

function requireConfigKey(key, entries) {
  if (!key || (!CONFIG_KEYS[key] && !Object.hasOwn(entries, key))) {
    throw new Error(`unknown config key: ${key ?? "(none)"}`);
  }
  return key;
}

async function mutateConfig(parsed, options) {
  if (!parsed.global && !parsed.project) {
    throw new Error("config mutations require explicit --global or --project PATH");
  }
  const key = parsed.positionals[0];
  const spec = CONFIG_KEYS[key];
  if (!spec) {
    if (key?.startsWith("runtime.no-mistakes.")) {
      throw new Error(`${key} is read-only and managed by perchctl; update Perch to change it`);
    }
    throw new Error(`unknown config key: ${key ?? "(none)"}`);
  }
  const requestedScope = parsed.global ? "global" : "project";
  if (spec.scope !== requestedScope) throw new Error(`${key} is ${spec.scope}-only`);
  let value = parsed.action === "unset" ? null : parsed.positionals[1];
  if (parsed.action === "set" && value === undefined) throw new Error(`config set ${key} requires a value`);
  if (spec.field === "agent" && value !== null && !CONFIG_AGENTS.has(value)) {
    throw new Error(`invalid ${key}: ${value} (expected ${[...CONFIG_AGENTS].join("|")})`);
  }
  if (key === "task.mode" && value !== null && !CONFIG_MODES.has(value)) {
    throw new Error(`invalid task.mode: ${value} (expected ${[...CONFIG_MODES].join("|")})`);
  }
  if (key === "task.yolo" && value !== null) {
    if (value !== "true" && value !== "false") throw new Error("task.yolo must be true or false");
    value = value === "true";
  }
  if (key === "task.mode" && value === "no-mistakes") {
    const before = await fetchConfig(options, parsed.project);
    validateBundledRuntimeEntries(before.entries ?? {});
    if (!parsed.yes) {
      if (!process.stdin.isTTY) throw new Error("setting task.mode=no-mistakes requires confirmation; rerun with --yes");
      const answer = await promptLine(`initialize and verify the bundled no-mistakes gate in ${prettyPath(parsed.project)}? [y/N] `);
      if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
        console.log("aborted; prior project mode preserved");
        return;
      }
    }
  }
  const path = spec.scope === "global" ? "/config" : "/projects";
  const body = spec.scope === "global"
    ? { [spec.layer]: { [spec.field]: value } }
    : { rootPath: parsed.project, [spec.field]: value };
  const response = await fetch(httpUrl(options, path), {
    method: "PATCH",
    headers: jsonHeaders(options),
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(await responseError(response));
  const config = await fetchConfig(options, parsed.project);
  const entry = redactConfigEntries(config.entries ?? {})[key];
  if (parsed.json) console.log(JSON.stringify({ key, ...entry }, null, 2));
  else console.log(`${key} = ${formatConfigValue(entry?.storedValue)}`);
}

function redactConfigEntries(entries) {
  return Object.fromEntries(Object.entries(entries).map(([key, entry]) => {
    if (!/(token|secret|password|credential)/i.test(key)) return [key, entry];
    const redacted = (value) => value === null || value === undefined ? value : "<redacted>";
    return [key, {
      ...entry,
      effectiveValue: redacted(entry.effectiveValue),
      storedValue: redacted(entry.storedValue),
      defaultValue: redacted(entry.defaultValue)
    }];
  }));
}

function validateConfigEntries(entries, parsed) {
  if (parsed.project && !Object.hasOwn(entries, "task.mode")) throw new Error("project configuration is unavailable");
  validateBundledRuntimeEntries(entries);
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry || !["global", "project", "runtime"].includes(entry.scope)) throw new Error(`invalid config entry: ${key}`);
  }
}

function validateBundledRuntimeEntries(entries) {
  const expected = {
    "runtime.no-mistakes.version": NO_MISTAKES_MANIFEST.version,
    "runtime.no-mistakes.protocol": NO_MISTAKES_MANIFEST.authorizationProtocol,
    "runtime.no-mistakes.source": "bundled"
  };
  for (const [key, value] of Object.entries(expected)) {
    if (entries[key]?.effectiveValue !== value) {
      throw new Error(`bundled no-mistakes validation failed for ${key}`);
    }
  }
  if (!entries["runtime.no-mistakes.path"]?.effectiveValue || !entries["runtime.no-mistakes.SHA-256"]?.effectiveValue) {
    throw new Error("bundled no-mistakes runtime path or SHA-256 is unavailable");
  }
}

async function runRuntimeCommand(args, options) {
  const action = args[0] ?? "show";
  const json = args.includes("--json");
  if (![("show"), ("validate")].includes(action) || args.some((arg) => arg !== action && arg !== "--json")) {
    throw new Error("runtime expects `perch runtime [show|validate] [--json]`");
  }
  const entries = redactConfigEntries((await fetchConfig(options)).entries ?? {});
  const runtime = Object.fromEntries(Object.entries(entries).filter(([key]) => key.startsWith("runtime.no-mistakes.")));
  if (action === "validate") {
    validateBundledRuntimeEntries(runtime);
    if (json) console.log(JSON.stringify({ valid: true, runtime }, null, 2));
    else console.log("bundled no-mistakes runtime valid");
    return;
  }
  if (json) console.log(JSON.stringify(runtime, null, 2));
  else for (const [key, entry] of Object.entries(runtime)) console.log(`${key.padEnd(34)} ${formatConfigValue(entry.effectiveValue)}`);
}

function formatConfigValue(value) {
  if (value === null || value === undefined) return "(unset)";
  return String(value);
}

// ---------------------------------------------------------------------------
// Worktree pool listing
// ---------------------------------------------------------------------------

async function runWorktreesCommand(args, options) {
  const action = args[0];
  if (action === "release") {
    await releaseWorktree(args.slice(1), options);
    return;
  }
  if (action !== undefined) {
    throw new Error(`unknown worktrees action: ${action} (expected \`perch worktrees\` or \`perch worktrees release <id> [--force]\`)`);
  }

  const [worktreesResponse, tasksResponse] = await Promise.all([
    fetch(httpUrl(options, "/worktrees"), { headers: jsonHeaders(options) }),
    fetch(httpUrl(options, "/tasks"), { headers: jsonHeaders(options) })
  ]);
  if (!worktreesResponse.ok) {
    throw new Error(await responseError(worktreesResponse));
  }
  const worktrees = (await worktreesResponse.json()).worktrees ?? [];
  // Tasks are a best-effort join, and only for LEASED slots: task records
  // keep their worktreeId after the tree is released, so a free slot showing
  // an old task would be a lie. Prefer the task whose session holds the
  // lease; fall back to the most recent non-closed task on the slot (tasks
  // arrive sorted by recency).
  const tasks = tasksResponse.ok ? ((await tasksResponse.json()).tasks ?? []) : [];
  const taskFor = (worktree) =>
    worktree.leasedBy
      ? (tasks.find((task) => task.worktreeId === worktree.id && task.sessionId === worktree.leasedBy) ??
        tasks.find((task) => task.worktreeId === worktree.id && task.state !== "closed"))
      : undefined;

  if (!worktrees.length) {
    console.log("no worktrees - the pool grows as tasks and agents run isolated (`worktree: true`)");
    return;
  }

  const rows = worktrees.map((worktree) => {
    const task = taskFor(worktree);
    // Live tree state, when the server exposes it: dirty beats unlanded
    // (uncommitted work is the more urgent fact about a slot).
    const tree = worktree.dirty === undefined ? "-" : worktree.dirty ? "dirty" : worktree.unlanded ? "unlanded" : "clean";
    return {
      id: worktree.id,
      project: basename(worktree.repoRoot),
      state: worktree.leasedBy ? "leased" : "free",
      tree,
      branch: worktree.head ?? worktree.branch ?? "-",
      task: task ? `${task.id}  ${task.title}` : "-"
    };
  });
  const widths = {
    id: Math.max(2, ...rows.map((row) => row.id.length)),
    project: Math.max(7, ...rows.map((row) => row.project.length)),
    state: Math.max(5, ...rows.map((row) => row.state.length)),
    tree: Math.max(4, ...rows.map((row) => row.tree.length)),
    branch: Math.max(6, ...rows.map((row) => row.branch.length))
  };
  console.log(
    `${"ID".padEnd(widths.id)}  ${"PROJECT".padEnd(widths.project)}  ${"STATE".padEnd(widths.state)}  ${"TREE".padEnd(widths.tree)}  ${"BRANCH".padEnd(widths.branch)}  TASK`
  );
  for (const row of rows) {
    console.log(
      `${row.id.padEnd(widths.id)}  ${row.project.padEnd(widths.project)}  ${row.state.padEnd(widths.state)}  ${row.tree.padEnd(widths.tree)}  ${row.branch.padEnd(widths.branch)}  ${row.task}`
    );
  }
}

// Free an orphaned pool lease. The server refuses live holders (running
// session or non-closed task) and, without --force, dirty/unlanded trees -
// those refusals surface verbatim as the command's error message.
async function releaseWorktree(args, options) {
  let id;
  let force = false;
  for (const arg of args) {
    if (arg === "--force") {
      force = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option for worktrees release: ${arg}`);
    } else if (!id) {
      id = arg;
    } else {
      throw new Error(`worktrees release takes one id (got "${arg}" too)`);
    }
  }
  if (!id) {
    throw new Error("worktrees release requires a worktree id (see `perch worktrees`)");
  }
  const response = await fetch(httpUrl(options, `/worktrees/${encodeURIComponent(id)}/release`), {
    method: "POST",
    headers: jsonHeaders(options),
    body: JSON.stringify({ force })
  });
  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  console.log(`released ${id}${force ? " (forced)" : ""}`);
}

// ---------------------------------------------------------------------------
// Environment doctor
// ---------------------------------------------------------------------------

// Render GET /doctor: the server checks its own environment (the one that
// actually spawns agents), the CLI just draws the table. Exit 1 when a
// required tool is missing; --json prints the raw report for scripts.
// --fix executes the server-computed fix plan: official unattended
// installers only, each command printed verbatim before it runs, per-tool
// consent on a TTY (--yes for scripted setups), never sudo, never a shell
// rc edit. Everything else is reported with the exact next commands.
async function runDoctorCommand(args, options) {
  let json = false;
  let fix = false;
  let yes = false;
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "--fix") {
      fix = true;
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else {
      throw new Error(`unknown option for doctor: ${arg} (expected \`perch doctor [--json] [--fix [--yes]]\`)`);
    }
  }
  if (json && fix) {
    throw new Error("doctor --fix cannot be combined with --json");
  }
  if (yes && !fix) {
    throw new Error("--yes only applies to `perch doctor --fix`");
  }

  const report = await fetchDoctorReport(options);
  const missingRequired = (report.tools ?? []).filter((tool) => tool.required && !tool.found);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    if (missingRequired.length) {
      process.exitCode = 1;
    }
    return;
  }

  renderDoctorReport(report);

  if (fix) {
    await runDoctorFix(report, { yes }, options);
    return;
  }

  if (missingRequired.length) {
    console.log("");
    console.log(
      `missing required: ${missingRequired.map((tool) => tool.name).join(", ")} - install and rerun \`perch doctor\``
    );
    process.exitCode = 1;
  }
}

async function fetchDoctorReport(options) {
  const response = await fetch(httpUrl(options, "/doctor"), { headers: jsonHeaders(options) });
  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  return response.json();
}

function renderDoctorReport(report) {
  const tools = report.tools ?? [];
  const rows = tools.map((tool) => ({
    mark: tool.found ? "✓" : "✗",
    name: tool.name,
    state: tool.found ? (tool.version ?? "found") : "missing",
    detail: tool.found
      ? (tool.note ?? "")
      : `${tool.required ? "REQUIRED" : "optional"} - install: ${tool.installHint}`
  }));
  const widths = {
    name: Math.max(4, ...rows.map((row) => row.name.length)),
    state: Math.max(5, ...rows.map((row) => row.state.length))
  };
  for (const row of rows) {
    console.log(
      `${row.mark} ${row.name.padEnd(widths.name)}  ${row.state.padEnd(widths.state)}  ${row.detail}`.trimEnd()
    );
  }

  const gate = report.noMistakes ?? { binaryFound: false, projects: [] };
  if (gate.projects.length) {
    console.log("");
    console.log("no-mistakes gate:");
    const nameWidth = Math.max(4, ...gate.projects.map((project) => project.name.length));
    const pathWidth = Math.max(4, ...gate.projects.map((project) => prettyPath(project.rootPath).length));
    for (const project of gate.projects) {
      const state = project.ready
        ? "ready"
        : project.note ??
          (project.initialized
            ? "initialized (reinstall this perchctl version if its bundled runtime is unavailable)"
            : "not initialized - set project task.mode=no-mistakes to initialize transactionally");
      console.log(
        `${project.ready ? "✓" : "-"} ${project.name.padEnd(nameWidth)}  ${prettyPath(project.rootPath).padEnd(pathWidth)}  ${state}`.trimEnd()
      );
    }
  }
}

// Execute the fix plan the server computed (report.fix). Safety properties
// this function owns: every command is printed verbatim before anything
// runs, installs need explicit per-tool consent (a TTY `y`, or --yes),
// nothing here ever invokes sudo or writes to shell rc files, and env
// defaults never override a variable the user exported.
async function runDoctorFix(report, { yes }, options) {
  const actions = report.fix ?? [];
  const installs = actions.filter((action) => action.kind === "install");
  const manuals = actions.filter((action) => action.kind === "manual");

  let ranAny = false;
  let failed = false;
  const ran = [];
  for (const action of installs) {
    console.log("");
    console.log(`${action.name} is missing and has an official installer. --fix will run exactly:`);
    // Env defaults ride the plan (upstream's own documented variables); a
    // variable already exported by the user always wins and is shown as such.
    const envAdds = {};
    const inherited = [];
    const effectiveEnv = {};
    for (const [key, value] of Object.entries(action.env ?? {})) {
      if (key in process.env) {
        inherited.push(`${key}=${process.env[key]}`);
        effectiveEnv[key] = process.env[key];
      } else {
        envAdds[key] = value;
        effectiveEnv[key] = value;
      }
    }
    const prefix = Object.entries(envAdds)
      .map(([key, value]) => `${key}=${JSON.stringify(value)} `)
      .join("");
    console.log(`  ${prefix}${action.command}`);
    for (const line of inherited) {
      console.log(`  (keeping your ${line})`);
    }
    if (action.note) {
      console.log(`  note: ${action.note}`);
    }

    if (!yes) {
      if (!process.stdin.isTTY) {
        console.log(
          `skipped ${action.name}: consent needed but this is not an interactive terminal - rerun with --yes, or run the command above yourself`
        );
        failed = true;
        continue;
      }
      const answer = (await promptLine(`install ${action.name} now? [y/N] `)).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        console.log(`skipped ${action.name} (no consent)`);
        continue;
      }
    }

    const result = spawnSync("/bin/sh", ["-c", action.command], {
      stdio: "inherit",
      env: { ...process.env, ...envAdds }
    });
    ranAny = true;
    ran.push({ action, effectiveEnv });
    if (result.status !== 0) {
      console.error(`${action.name} installer exited with ${result.status ?? `signal ${result.signal}`}`);
      failed = true;
    }
  }

  if (!installs.length) {
    console.log("");
    console.log(
      manuals.length
        ? "nothing --fix can install automatically."
        : "nothing to fix - every dependency perch can install is already present."
    );
  }

  if (manuals.length) {
    console.log("");
    console.log("cannot automate (each needs your own sign-in) - run these yourself:");
    for (const action of manuals) {
      console.log(`- ${action.name} (${action.reason}):`);
      for (const command of action.commands ?? []) {
        console.log(`    ${command}`);
      }
    }
  }

  let latest = report;
  if (ranAny) {
    console.log("");
    console.log("re-checking...");
    latest = await fetchDoctorReport(options);
    renderDoctorReport(latest);
    for (const { action, effectiveEnv } of ran) {
      const tool = (latest.tools ?? []).find((entry) => entry.name === action.name);
      if (!tool || tool.found) {
        continue;
      }
      // `curl | sh` reports the pipe tail's exit status, so a failed download
      // can still exit 0 - judge by evidence: did the binary land where the
      // installer links it?
      const linkDir = effectiveEnv.NO_MISTAKES_LINK_DIR;
      console.log("");
      if (linkDir && existsSync(join(linkDir, action.name))) {
        console.log(
          `${action.name}: installed to ${prettyPath(linkDir)}, but the perch server does not see it yet. Make sure that directory is on the PATH of the shell that starts perch (add \`export PATH="${linkDir}:$PATH"\` to your shell profile yourself - perch never edits shell files), then restart the server: \`perch server stop && perch server start\`.`
        );
      } else {
        console.log(
          `${action.name}: the installer ran but did not leave a binary${linkDir ? ` at ${prettyPath(join(linkDir, action.name))}` : ""} - it likely failed; see its output above and rerun \`perch doctor --fix\`.`
        );
        failed = true;
      }
    }
  }

  const missingRequired = (latest.tools ?? []).filter((tool) => tool.required && !tool.found);
  if (missingRequired.length) {
    console.log("");
    console.log(`still missing required: ${missingRequired.map((tool) => tool.name).join(", ")}`);
  }
  if (failed || missingRequired.length) {
    process.exitCode = 1;
  }
}

async function promptLine(question) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Session listing + short-id resolution
// ---------------------------------------------------------------------------

async function fetchSessions(options) {
  const response = await fetch(httpUrl(options, "/sessions"), { headers: jsonHeaders(options) });
  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  const body = await response.json();
  return body.sessions ?? [];
}

async function listSessions(options) {
  const sessions = await fetchSessions(options);
  if (sessions.length === 0) {
    console.log("no sessions - start one with `perch claude`");
    return;
  }

  const rows = sessions.map((session) => ({
    id: shortSessionId(session.id),
    agent: session.agent ?? "?",
    status: session.status ?? "?",
    title: session.title ?? "",
    activity: humanizeSince(session.lastActivityAt)
  }));
  const widths = {
    id: Math.max(2, ...rows.map((row) => row.id.length)),
    agent: Math.max(5, ...rows.map((row) => row.agent.length)),
    status: Math.max(6, ...rows.map((row) => row.status.length)),
    activity: Math.max(8, ...rows.map((row) => row.activity.length))
  };
  console.log(
    `${"ID".padEnd(widths.id)}  ${"AGENT".padEnd(widths.agent)}  ${"STATUS".padEnd(widths.status)}  ${"ACTIVITY".padEnd(widths.activity)}  TITLE`
  );
  for (const row of rows) {
    console.log(
      `${row.id.padEnd(widths.id)}  ${row.agent.padEnd(widths.agent)}  ${row.status.padEnd(widths.status)}  ${row.activity.padEnd(widths.activity)}  ${row.title}`
    );
  }
}

function printSessionEnded(sessionId, status) {
  const reason = status === "done" ? "agent exited" : "agent exited with an error";
  console.error(`\nPerch session ${shortSessionId(sessionId)} ended (${reason}).`);
  console.error("Exiting the agent ends its perch session; to leave it running next time, detach with Ctrl-] instead.");
}

function shortSessionId(id) {
  const bare = id.startsWith("pty:") ? id.slice(4) : id;
  return bare.slice(0, 8);
}

async function resolveSession(ref, options) {
  const sessions = await fetchSessions(options);
  const exact = sessions.find((session) => session.id === ref);
  if (exact) {
    return exact;
  }

  const matches = sessions.filter((session) => {
    const bare = session.id.startsWith("pty:") ? session.id.slice(4) : session.id;
    return bare.startsWith(ref) || session.id.startsWith(ref);
  });
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(`ambiguous session id "${ref}" - matches ${matches.map((m) => shortSessionId(m.id)).join(", ")}`);
  }
  throw new Error(`no session matching "${ref}" - see \`perch ls\``);
}

function humanizeSince(iso) {
  if (!iso) {
    return "-";
  }
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function prettyPath(path) {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function runUninstall(options) {
  if ((await fetchHealth(options)) && !options.force) {
    throw new Error("perch server is running; stop it first with `perch server stop`, or rerun with `perch uninstall --force`");
  }

  const hooksModuleUrl = new URL("../apps/server/dist/hooks.js", import.meta.url);
  let hooks;
  try {
    hooks = await import(hooksModuleUrl.href);
  } catch {
    throw new Error("server build missing uninstall helpers - reinstall perchctl or run `npm run build`");
  }
  const changes = hooks.planPerchUninstall(process.env);

  if (options.dryRun) {
    if (changes.length === 0 && !options.purgeData) {
      console.log("No Perch-managed configuration found.");
      return;
    }
    for (const change of changes) {
      process.stdout.write(formatFileDiff(change));
    }
    if (options.purgeData) {
      console.log(`delete ${prettyPath(PERCH_HOME)}/ recursively`);
    }
    return;
  }

  hooks.applyPerchUninstall(changes);
  if (options.purgeData && existsSync(PERCH_HOME)) {
    const resolvedHome = resolve(PERCH_HOME);
    if (resolvedHome === "/" || resolvedHome === resolve(homedir())) {
      throw new Error(`refusing to purge unsafe PERCH_HOME: ${resolvedHome}`);
    }
    rmSync(resolvedHome, { recursive: true, force: true });
  }

  for (const change of changes) {
    console.log(`${change.after === null ? "removed" : "updated"} ${prettyPath(change.path)}`);
  }
  if (options.purgeData) {
    console.log(`removed ${prettyPath(PERCH_HOME)} state`);
  } else {
    console.log(`kept ${prettyPath(PERCH_HOME)} state (use --purge-data to remove it)`);
  }
}

function formatFileDiff(change) {
  const beforeLines = change.before === null ? [] : change.before.split("\n");
  const afterLines = change.after === null ? [] : change.after.split("\n");
  const from = change.before === null ? "/dev/null" : change.path;
  const to = change.after === null ? "/dev/null" : change.path;
  const lengths = Array.from({ length: beforeLines.length + 1 }, () =>
    Array(afterLines.length + 1).fill(0)
  );
  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
      lengths[beforeIndex][afterIndex] = beforeLines[beforeIndex] === afterLines[afterIndex]
        ? lengths[beforeIndex + 1][afterIndex + 1] + 1
        : Math.max(lengths[beforeIndex + 1][afterIndex], lengths[beforeIndex][afterIndex + 1]);
    }
  }
  const body = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
    if (
      beforeIndex < beforeLines.length &&
      afterIndex < afterLines.length &&
      beforeLines[beforeIndex] === afterLines[afterIndex]
    ) {
      body.push(` ${beforeLines[beforeIndex]}`);
      beforeIndex += 1;
      afterIndex += 1;
    } else if (
      afterIndex < afterLines.length &&
      (beforeIndex === beforeLines.length || lengths[beforeIndex][afterIndex + 1] >= lengths[beforeIndex + 1][afterIndex])
    ) {
      body.push(`+${afterLines[afterIndex]}`);
      afterIndex += 1;
    } else {
      body.push(`-${beforeLines[beforeIndex]}`);
      beforeIndex += 1;
    }
  }
  const lines = [
    `--- ${from}`,
    `+++ ${to}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...body
  ];
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const options = {
    server: process.env.PERCH_SERVER_URL ?? process.env.PERCH_URL ?? DEFAULT_SERVER_URL,
    token: process.env.PERCH_TOKEN,
    cwd: process.env.PERCH_CWD ?? process.cwd(),
    title: undefined,
    attach: true,
    newMate: false,
    dryRun: false,
    purgeData: false,
    force: false
  };
  const args = [];
  let command;
  let help = false;
  let version = false;
  // For agent commands, perch flags are parsed only between the command and
  // the first positional agent arg; everything after passes through untouched
  // so agent flags that happen to collide (--title, --cwd, ...) are never
  // stolen. Non-agent commands reject unknown flags instead.
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (passthrough) {
      args.push(arg);
      continue;
    }
    if (arg === "--") {
      args.push(...argv.slice(index + 1));
      break;
    }
    if (!command && (arg === "-h" || arg === "--help")) {
      help = true;
      continue;
    }
    if (!command && (arg === "-v" || arg === "--version")) {
      version = true;
      continue;
    }
    if (arg === "--server" || arg === "--url") {
      options.server = requireValue(argv, (index += 1), arg);
      continue;
    }
    if (arg.startsWith("--server=")) {
      options.server = arg.slice("--server=".length);
      continue;
    }
    if (arg.startsWith("--url=")) {
      options.server = arg.slice("--url=".length);
      continue;
    }
    if (arg === "--token") {
      options.token = requireValue(argv, (index += 1), arg);
      continue;
    }
    if (arg.startsWith("--token=")) {
      options.token = arg.slice("--token=".length);
      continue;
    }
    if (arg === "--cwd") {
      options.cwd = resolve(requireValue(argv, (index += 1), arg));
      continue;
    }
    if (arg.startsWith("--cwd=")) {
      options.cwd = resolve(arg.slice("--cwd=".length));
      continue;
    }
    if (arg === "--title") {
      options.title = requireValue(argv, (index += 1), arg);
      continue;
    }
    if (arg.startsWith("--title=")) {
      options.title = arg.slice("--title=".length);
      continue;
    }
    if (arg === "--no-attach" || arg === "--detach") {
      options.attach = false;
      continue;
    }
    if (command === "mate" && arg === "--new") {
      options.newMate = true;
      continue;
    }
    if (command === "uninstall" && arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (command === "uninstall" && arg === "--purge-data") {
      options.purgeData = true;
      continue;
    }
    if (command === "uninstall" && arg === "--force") {
      options.force = true;
      continue;
    }

    if (!command) {
      command = arg;
      continue;
    }
    // Wrapper help must never start a provider session. Put `--` before a
    // provider's own help flag when the intent is to forward it instead.
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (AGENT_COMMANDS.has(command)) {
      args.push(arg);
      passthrough = true;
      continue;
    }
    // `project`, `config`, `models`, `worktrees`, and `doctor` keep their own flags as positionals; the shared flags above
    // (--server, --token, ...) are already consumed.
    if (arg.startsWith("-") && command !== "project" && command !== "config" && command !== "models" && command !== "worktrees" && command !== "doctor") {
      throw new Error(`unknown option for ${command}: ${arg} (see \`perch --help\`)`);
    }
    args.push(arg);
  }

  return { command, args, options, help, version };
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function makeStartRequest(parsed) {
  const desktop = detectDesktopContext();

  if (parsed.command === "run") {
    const [command, ...args] = parsed.args;
    if (!command) {
      throw new Error("run requires a command");
    }
    return withOptionalDesktop({
      command,
      args,
      cwd: parsed.options.cwd,
      title: parsed.options.title ?? defaultTitle(command, parsed.options.cwd),
      agent: inferAgent(command)
    }, desktop);
  }

  const agent = AGENTS[parsed.command];
  if (!agent) {
    throw new Error(`unknown command: ${parsed.command}`);
  }

  return withOptionalDesktop({
    command: agent.command,
    args: parsed.args,
    cwd: parsed.options.cwd,
    title: parsed.options.title ?? defaultTitle(agent.label, parsed.options.cwd),
    agent: agent.agent
  }, desktop);
}

function defaultTitle(command, cwd) {
  return `${basename(command)} - ${basename(cwd)}`;
}

function detectDesktopContext() {
  const sessionId = process.env.PERCH_DESKTOP_SESSION_ID;
  const terminal = process.env.TERM_PROGRAM ?? process.env.LC_TERMINAL;
  const desktop = cleanObject({
    sessionId,
    terminal,
    cols: process.stdout.isTTY ? process.stdout.columns : undefined,
    rows: process.stdout.isTTY ? process.stdout.rows : undefined
  });

  return Object.keys(desktop).length > 0 ? desktop : undefined;
}

function withOptionalDesktop(request, desktop) {
  return desktop ? { ...request, desktop } : request;
}

function cleanObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => {
      if (typeof field === "string") {
        return field.trim().length > 0;
      }
      return Number.isInteger(field) && field > 0;
    })
  );
}

function inferAgent(command) {
  const name = basename(command).toLowerCase();
  if (name.includes("codex")) return "codex";
  if (name.includes("claude")) return "claude";
  return "shell";
}

async function startViaHttp(request, options) {
  const response = await fetch(httpUrl(options, "/agents/pty"), {
    method: "POST",
    headers: jsonHeaders(options),
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    throw new Error(await responseError(response));
  }

  const body = await response.json();
  return body.session;
}

async function runRecoverCommand(args, options) {
  const target = args[0];
  if (target === "task") {
    const taskId = args[1];
    if (!taskId) throw new Error("recover task requires a task id");
    const response = await fetch(httpUrl(options, `/tasks/${encodeURIComponent(taskId)}/recover`), {
      method: "POST",
      headers: jsonHeaders(options),
      body: JSON.stringify({})
    });
    if (!response.ok) throw new Error(await responseError(response));
    const body = await response.json();
    const runtime = body.task?.runtime;
    console.log(
      body.alreadyLive
        ? `task ${taskId} already live${runtime?.ptySessionId ? ` (${shortSessionId(runtime.ptySessionId)})` : ""}`
        : `recovered task ${taskId} as generation ${runtime?.generation ?? "?"}${runtime?.ptySessionId ? ` (${shortSessionId(runtime.ptySessionId)})` : ""}`
    );
    return;
  }
  throw new Error("recover requires `task <id>`");
}

// perch mate: the orchestrator - an ordinary claude (or configured) session
// pinned to the mate home, whose AGENTS.md speaks perch task verbs instead of
// doing work. One mate per fleet: a live one is attached, never duplicated.
async function runMateCommand(parsed) {
  const requestedAgent = AGENTS[parsed.args[0]] ? parsed.args[0] : undefined;
  const agentArgs = requestedAgent ? parsed.args.slice(1) : parsed.args;

  const sessions = await fetchSessions(parsed.options);
  const existing = sessions.find(
    (session) => session.labels?.role === "mate" && session.status !== "done" && session.status !== "error"
  );
  if (existing && !parsed.options.newMate) {
    if (requestedAgent && existing.agent && existing.agent !== requestedAgent) {
      console.log(
        `note: the running mate is ${existing.agent}, not ${requestedAgent} - ` +
          `stop it first (perch stop ${shortSessionId(existing.id)}) to relaunch as ${requestedAgent}`
      );
    }
    console.log("mate already on deck - reconciling its fleet");
  }

  // Launch-time only: mate-agent/mate-model/mate-effort pick what a FRESH
  // mate starts as. There is no mid-conversation agent switch or relaunch.
  const config = await fetchConfig(parsed.options);
  const mateDefaults = config.mateDefaults ?? {};
  const defaultAgent = mateDefaults.agent ?? "claude";
  const agent = requestedAgent ?? defaultAgent;
  let model;
  let effort;
  if (agent === defaultAgent && config.mateResolved?.agent === agent) {
    ({ model, effort } = config.mateResolved);
  } else {
    const launchDefaults = agent === defaultAgent ? mateDefaults : {};
    model = typeof launchDefaults.model === "string" && launchDefaults.model.trim().toLowerCase() !== "auto"
      ? launchDefaults.model.trim()
      : undefined;
    effort = launchDefaults.effort;
    if (!model) {
      let roleDefault;
      try {
        const registry = await fetchModels(parsed.options);
        roleDefault = registry.providers?.find((provider) => provider.provider === agent)?.roleDefaults?.orchestrator;
      } catch {
        // Older servers did not expose role defaults. Keep the CLI compatible
        // with them by using the same static last-resort values as the server.
      }
      model = roleDefault?.model;
      effort = effort ?? roleDefault?.effort;
    }
    if (!model) {
      model = agent === "claude" ? MATE_CLAUDE_FALLBACK_MODEL : MATE_CODEX_FALLBACK.model;
      effort = effort ?? (agent === "codex" ? MATE_CODEX_FALLBACK.effort : undefined);
    }
  }

  const response = await fetch(httpUrl(parsed.options, "/mate/start"), {
    method: "POST",
    headers: jsonHeaders(parsed.options),
    body: JSON.stringify({
      agent,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(agentArgs.length > 0 ? { args: agentArgs } : {}),
      ...(parsed.options.newMate ? { new: true } : {})
    })
  });
  let body;
  if (!response.ok) {
    const message = await responseError(response);
    if (response.status === 409 && existing && !parsed.options.newMate && message === "mate already running") {
      // Compatibility with a server that predates durable mate owners: the
      // live session we just listed is still safe to attach, but that server
      // cannot run the coordinated fleet reconciliation endpoint yet. A newer
      // server never uses this exact error body for /mate/start, so any other
      // 409 (e.g. a fleet-reconcile failure) surfaces instead of attaching.
      body = { session: existing, alreadyLive: true };
    } else {
      throw new Error(message);
    }
  } else {
    body = await response.json();
  }
  const session = body.session;
  if (body.recovered) console.log(`recovered mate conversation as generation ${body.mateOwner?.generation ?? "?"}`);
  if (body.alreadyLive && parsed.options.attach) console.log("attaching (Ctrl+] detaches)");
  const children = body.recovery?.children;
  if (children) {
    console.log(
      `fleet recovery: ${children.recovered?.length ?? 0} recovered, ${children.alreadyLive?.length ?? 0} already live, ` +
      `${children.failed?.length ?? 0} failed, ${children.skipped?.length ?? 0} skipped`
    );
    for (const failure of children.failed ?? []) console.error(`  ${failure.taskId}: ${failure.error}`);
  }
  if (!parsed.options.attach) {
    printStarted(session);
    return;
  }
  await attachToSession(session.id, parsed.options);
}

async function startAndAttach(request, options) {
  await withSocket(options, ({ send, onEvent, finish }) => {
    let attached = false;
    let sessionId;
    let cleanupInput = () => {};
    const renderer = createTerminalRenderer();

    onEvent((event) => {
      if (event.type === "message" && event.sessionId === "system") {
        // Before the session exists, a system message is the start_agent
        // error report. Afterwards it is a broadcast notice (e.g. a transient
        // reconcile failure) and must not detach a healthy session.
        if (!attached) {
          console.error(`perch: ${event.text}`);
          finish(1);
        }
        return;
      }

      if (!sessionId && event.sessionId && event.sessionId !== "system") {
        sessionId = event.sessionId;
        console.error(`perch session ${shortSessionId(sessionId)} - Ctrl-] to detach (session keeps running)`);
        cleanupInput = attachStdin(sessionId, send, () => finish(0));
        attached = true;
      }

      if (event.sessionId !== sessionId) {
        return;
      }

      handleSessionEvent(event, sessionId, renderer, finish);
    });

    send({ type: "start_agent", request });

    return () => {
      if (attached) {
        cleanupInput();
      }
    };
  });
}

async function attachToSession(sessionId, options) {
  await withSocket(options, ({ send, onEvent, finish }) => {
    const renderer = createTerminalRenderer();
    const cleanupInput = attachStdin(sessionId, send, () => finish(0));
    console.error(`Attached to ${shortSessionId(sessionId)}. Press Ctrl-] to detach.`);

    onEvent((event) => {
      if (event.sessionId !== sessionId) {
        return;
      }
      handleSessionEvent(event, sessionId, renderer, finish);
    });

    send({ type: "subscribe", sessionId });

    return cleanupInput;
  });
}

function handleSessionEvent(event, sessionId, renderer, finish) {
  if (event.type === "terminal_output" || event.type === "terminal_snapshot") {
    renderer.write(event);
  } else if (event.type === "status" && (event.status === "done" || event.status === "error")) {
    renderer.finish();
    printSessionEnded(sessionId, event.status);
    finish(event.status === "done" ? 0 : 1);
  }
}

async function withSocket(options, run) {
  const webSocket = new WebSocket(wsUrl(options));
  const eventHandlers = new Set();
  let cleanup = () => {};
  let finished = false;

  await new Promise((resolve, reject) => {
    // Every exit path (detach, session end, socket error/close, signals) must
    // run cleanup: skipping it leaves the user's terminal in raw mode with
    // mouse tracking / bracketed paste / hidden cursor still active.
    const settle = (outcome) => {
      if (finished) {
        return;
      }
      finished = true;
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
      process.off("SIGINT", onSignal);
      cleanup();
      webSocket.close();
      outcome();
    };

    const finish = (code) => {
      settle(() => {
        process.exitCode = code;
        resolve();
      });
    };

    const fail = (error) => {
      settle(() => reject(error));
    };

    const onSignal = () => finish(1);
    process.on("SIGTERM", onSignal);
    process.on("SIGHUP", onSignal);
    process.on("SIGINT", onSignal);

    const send = (message) => {
      webSocket.send(JSON.stringify(message));
    };

    const onEvent = (handler) => {
      eventHandlers.add(handler);
    };

    webSocket.on("open", () => {
      cleanup = run({ send, onEvent, finish }) ?? (() => {});
    });

    webSocket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        // One malformed frame must not kill an attached CLI.
        return;
      }
      if (message.type !== "event") {
        return;
      }
      for (const handler of eventHandlers) {
        handler(message.event);
      }
    });

    webSocket.on("error", fail);

    webSocket.on("close", () => {
      fail(new Error("WebSocket closed"));
    });
  });
}

// Keystrokes and resizes ride the WebSocket (one frame per chunk) instead of
// an HTTP request per keystroke; the attached terminal owns the PTY size.
function attachStdin(sessionId, send, detach) {
  const wasRaw = Boolean(process.stdin.isTTY && process.stdin.isRaw);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  // Large pastes arrive as multiple chunks that can split a multibyte
  // character; decoding each chunk independently would corrupt it.
  const decoder = new StringDecoder("utf8");
  const onData = (chunk) => {
    const isDetachKey =
      (chunk.length === 1 && chunk[0] === DETACH_BYTE) ||
      DETACH_SEQUENCE.test(chunk.toString("latin1"));
    if (isDetachKey) {
      console.error("\nDetached. Reattach with `perch attach " + shortSessionId(sessionId) + "`.");
      detach();
      return;
    }
    const data = decoder.write(chunk);
    if (data) {
      send({ type: "input", sessionId, data });
    }
  };

  const onResize = () => {
    if (process.stdout.isTTY) {
      send({ type: "resize", sessionId, cols: process.stdout.columns, rows: process.stdout.rows });
    }
  };

  process.stdin.on("data", onData);
  process.stdout.on("resize", onResize);
  onResize();

  return () => {
    process.stdin.off("data", onData);
    process.stdout.off("resize", onResize);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(wasRaw);
    }
    if (process.stdout.isTTY) {
      process.stdout.write(TERMINAL_MODE_RESET);
    }
    process.stdin.pause();
  };
}

function createTerminalRenderer() {
  return {
    write(event) {
      if (event.type === "terminal_snapshot") {
        // Fresh serialized screen: clear, then replay the ANSI state.
        if (process.stdout.isTTY) {
          process.stdout.write("\x1b[H\x1b[2J\x1b[3J");
        }
        process.stdout.write(event.data);
        return;
      }
      if (event.raw) {
        process.stdout.write(event.raw);
        return;
      }
      if (event.text) {
        writeTerminalSnapshot(event.text);
      }
    },
    finish() {
      if (process.stdout.isTTY) {
        process.stdout.write("\x1b[?25h");
      }
    }
  };
}

function writeTerminalSnapshot(text) {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?25l\x1b[H\x1b[2J");
    process.stdout.write(text);
    process.stdout.write("\x1b[?25h");
    return;
  }

  process.stdout.write(text);
  if (!text.endsWith("\n")) {
    process.stdout.write("\n");
  }
}

function httpUrl(options, path) {
  return new URL(path.replace(/^\//, ""), normalizeServerUrl(options.server));
}

function wsUrl(options) {
  const url = new URL(normalizeServerUrl(options.server));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", resolveToken(options));
  return url;
}

function normalizeServerUrl(value) {
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url;
}

function jsonHeaders(options) {
  return {
    authorization: `Bearer ${resolveToken(options)}`,
    "content-type": "application/json"
  };
}

async function responseError(response) {
  const text = await response.text();
  try {
    const body = JSON.parse(text);
    return body.error ?? `${response.status} ${response.statusText}`;
  } catch {
    return text || `${response.status} ${response.statusText}`;
  }
}

function printStarted(session) {
  console.log(`Started ${session.title}`);
  console.log(`Session: ${session.id}`);
  console.log(`Workspace: Perch agents`);
}

function printHelp(command) {
  const usage = commandHelp(command);
  if (usage) {
    console.log(usage);
    return;
  }
  console.log(`Usage:
  perch codex [options] [codex args...]
  perch claude [options] [claude args...]
  perch run [options] -- <command> [args...]
  perch mate [options] [claude|codex]
  perch recover task <task-id>
  perch attach [options] <session-id>
  perch stop <session-id>
  perch ls
  perch pair
  perch devices [ls|revoke <id>]
  perch project [list]
  perch project add <path> [--mode direct-PR|no-mistakes|local-only] [--yolo] [--yes]
  perch project show <path>
  perch project set <path> [--mode direct-PR|no-mistakes|local-only] [--yolo|--no-yolo] [--yes]
  perch project remove <path>
  perch runtime [show|validate] [--json]
  perch models [--json]
  perch config show [--global] [--effective] [--json]
  perch config get <key> [--global|--project PATH] [--effective] [--json]
  perch config set --global <dispatch.agent|dispatch.model|dispatch.effort|
                              mate.agent|mate.model|mate.effort> <value>
  perch config set <mate|dispatch> <model> [--effort <level>] [--agent <agent>]
  perch config unset --global <key>
  perch config validate [--global] [--effective] [--json]
  perch worktrees
  perch worktrees release <id> [--force]
  perch doctor [--json] [--fix [--yes]]
  perch uninstall [--dry-run] [--purge-data] [--force]
  perch server [status|start|stop|logs]

Options:
  --server <url>    Perch server URL. Defaults to PERCH_SERVER_URL or ${DEFAULT_SERVER_URL}
  --token <token>   Perch bearer token. Defaults to PERCH_TOKEN or ~/.perch/token
  --cwd <path>      Working directory for the launched process. Defaults to current directory
  --title <title>   Session title shown in the mobile app
  --no-attach       Start the session and exit instead of attaching this terminal
  --new             With perch mate, intentionally start a fresh conversation
  --dry-run         With perch uninstall, print exact file diffs without writing
  --purge-data      With perch uninstall, also remove ~/.perch state
  --force           With perch uninstall, proceed while the server is running
  --version         Print the canonical perchctl package version

The server starts automatically when needed (log: ~/.perch/server.log).
Session ids can be shortened: \`perch attach e1b4\` works if unambiguous.
\`perch doctor\` validates the immutable no-mistakes runtime bundled with this
perchctl package. It never downloads or repairs that runtime from PATH; reinstall
this exact perchctl version if the bundled bytes are missing or corrupt.
\`perch config\` shows global Mate and dispatch defaults only. Use \`perch project\`
for delivery mode and yolo, and \`perch runtime\` for bundled-runtime provenance.

Examples:
  perch claude
  perch codex -- "Find and fix a bug in @filename"
  perch run -- /bin/zsh -lc 'for i in 1 2 3; do echo $i; sleep 1; done'

While attached, press Ctrl-] to detach without stopping the Perch session.`);
}

function commandHelp(command) {
  const common = `Global options: --server <url>, --token <token>. Launch commands also accept --cwd <path>, --title <title>, and --no-attach.`;
  if (["claude", "codex", "run"].includes(command)) {
    const usage = command === "run"
      ? "perch run [options] -- <command> [args...]"
      : `perch ${command} [options] [${command} args...]`;
    const forwardHelp = command === "run"
      ? "To view a wrapped command's help instead of this wrapper help, run:\n  perch run -- <command> --help"
      : `To forward provider help instead of viewing this wrapper help, run:\n  perch ${command} -- --help`;
    return `Usage: ${usage}\n\nStarts and attaches a Perch-managed ${command === "run" ? "command" : command} session.\n${common}\n\n${forwardHelp}`;
  }
  if (command === "mate") return `Usage: perch mate [options] [claude|codex]\n\nStarts or attaches to the durable Mate orchestrator.\n  --new  intentionally start a fresh Mate conversation\n${common}`;
  if (command === "recover") return "Usage: perch recover task <task-id>\n\nRecovers a task when its persisted runtime supports recovery.";
  if (command === "attach") return `Usage: perch attach [options] <session-id>\n\nAttaches this terminal to a live Perch session. Session ids may be shortened when unambiguous.\n${common}`;
  if (command === "stop") return "Usage: perch stop <session-id>\n\nStops a live Perch session. Session ids may be shortened when unambiguous.";
  if (command === "ls") return "Usage: perch ls\n\nLists Perch sessions.";
  if (command === "pair") return "Usage: perch pair [--title <device-name>]\n\nCreates a device pairing offer. Treat the printed URL and QR code as credentials.";
  if (command === "devices") return "Usage:\n  perch devices [ls]\n  perch devices revoke <id>\n\nLists paired devices or revokes one device token.";
  if (command === "project") return `Usage:\n  perch project [list|ls]\n  perch project add <path> [--mode direct-PR|no-mistakes|local-only] [--yolo] [--yes]\n  perch project remove|rm <path>\n\nThe project registry is live server state. Use \`perch project list\` to inspect it.\n\`--mode no-mistakes\` initializes and verifies the bundled gate before persisting the mode.`;
  if (command === "models") return "Usage: perch models [--json]\n\nLists selectable Mate and dispatch models, aliases, supported effort levels, and sources.";
  if (command === "config") return `Usage:\n  perch config show [--global|--project PATH] [--effective] [--json]\n  perch config get <key> [--global|--project PATH] [--effective] [--json]\n  perch config set <mate|dispatch> <model> [--effort <level>] [--agent <agent>]\n  perch config set --global <key> <value>\n  perch config set --project PATH <task.mode|task.yolo> <value> [--yes]\n  perch config unset --global <key>\n  perch config unset --project PATH <key>\n  perch config validate [--global|--project PATH] [--effective] [--json]\n\nGlobal defaults: dispatch.* for workers and mate.* for Mate.\nProject settings: task.mode and task.yolo. Use \`--project PATH\` to inspect a registered project's settings.\nRuntime keys are read-only provenance for this perchctl package, not project registry state.\nUse \`perch project list\` for the live project registry.`;
  if (command === "worktrees") return "Usage:\n  perch worktrees\n  perch worktrees release <id> [--force]\n\nLists isolated task worktrees or releases an orphaned lease.";
  if (command === "doctor") return "Usage: perch doctor [--json] [--fix [--yes]]\n\nChecks the server environment and validates the immutable bundled no-mistakes runtime. It does not download or PATH-repair that runtime.";
  if (command === "uninstall") return "Usage: perch uninstall [--dry-run] [--purge-data] [--force]\n\nRemoves Perch-managed agent configuration. It preserves ~/.perch state unless --purge-data is supplied.";
  if (command === "server") return "Usage: perch server [status|start|stop|logs]\n\nControls the local Perch server.";
  return undefined;
}
