import { execFile, spawn } from "node:child_process";
import { findWslToolIn, wslToolCommand } from "../wslrun/wslrun.js";
import { rtkWslCommand } from "./wsl.js";
import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { writeManagedFile } from "./store.js";
import type { LibraryAgentTarget } from "./paths.js";
import type { LibraryBackup } from "./store.js";
import { parseJsonc } from "./mcp.js";

const run = promisify(execFile);

/** Where myna points a user who has no RTK: its own site. */
export const RTK_URL = "https://www.rtk-ai.app";
const HOOK_MARKER = "rtk hook ";

interface RtkAgentSpec {
  flags: string[];
  patch: boolean;
  env?: (env: NodeJS.ProcessEnv, homeDir: string) => NodeJS.ProcessEnv;
  files: (target: LibraryAgentTarget, homeDir: string, env: NodeJS.ProcessEnv) => string[];
  has: (target: LibraryAgentTarget, homeDir: string, env: NodeJS.ProcessEnv) => Promise<boolean>;
  remove: (
    target: LibraryAgentTarget,
    homeDir: string,
    env: NodeJS.ProcessEnv,
    backup: LibraryBackup,
  ) => Promise<void>;
}

function claudeSettings(target: LibraryAgentTarget): string {
  return target.hooksPath ?? "";
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function contains(file: string, needle: string): Promise<boolean> {
  try {
    return (await readFile(file, "utf8")).includes(needle);
  } catch {
    return false;
  }
}

async function dropCommandHooks(file: string, marker: string): Promise<void> {
  let root: Record<string, unknown>;
  try {
    const parsed = parseJsonc(await readFile(file, "utf8"));
    root = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return;
  }
  const hooks = root.hooks;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    return;
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [event, value] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      next[event] = value;
      continue;
    }
    const filtered = value.filter((entry) => {
      const remove = JSON.stringify(entry).includes(marker);
      changed ||= remove;
      return !remove;
    });
    if (filtered.length > 0) {
      next[event] = filtered;
    }
  }
  if (!changed) {
    return;
  }
  const rootNext = { ...root };
  if (Object.keys(next).length > 0) {
    rootNext.hooks = next;
  } else {
    delete rootNext.hooks;
  }
  await writeManagedFile(file, `${JSON.stringify(rootNext, null, 2)}\n`);
}

async function dropRefLines(file: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return;
  }
  const lines = text.split("\n");
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    return !(
      trimmed.startsWith("@") &&
      (trimmed === "@RTK.md" || trimmed.endsWith("/RTK.md") || trimmed.endsWith("\\RTK.md"))
    );
  });
  if (kept.length === lines.length) {
    return;
  }
  await writeManagedFile(file, kept.join("\n"));
}

async function dropBlock(file: string, begin: string, end: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return;
  }
  const start = text.indexOf(begin);
  if (start < 0) {
    return;
  }
  const finish = text.indexOf(end, start);
  if (finish < 0) {
    return;
  }
  const next = `${text.slice(0, start)}${text.slice(finish + end.length)}`.replace(
    /\n{3,}/g,
    "\n\n",
  );
  await writeManagedFile(file, next);
}

async function backupFiles(backup: LibraryBackup, agent: string, files: string[]): Promise<void> {
  for (const file of files) {
    await backup.keep(agent, file).catch(() => undefined);
  }
}

const specs: Record<string, RtkAgentSpec> = {
  claude: {
    flags: [],
    patch: true,
    files: (target) => [
      claudeSettings(target),
      target.instructionsPath,
      path.join(path.dirname(target.instructionsPath), "RTK.md"),
    ],
    has: (target) => contains(claudeSettings(target), `${HOOK_MARKER}claude`),
    async remove(target, _home, _env, backup) {
      const settings = claudeSettings(target);
      await backupFiles(backup, "claude", [settings, target.instructionsPath]);
      await dropCommandHooks(settings, `${HOOK_MARKER}claude`);
      await dropRefLines(target.instructionsPath);
      await rm(path.join(path.dirname(target.instructionsPath), "RTK.md"), { force: true });
    },
  },
  codex: {
    flags: ["--codex"],
    patch: false,
    files: (target) => [
      target.hooksPath ?? "",
      target.instructionsPath,
      path.join(path.dirname(target.instructionsPath), "RTK.md"),
    ],
    has: (target) => contains(target.hooksPath ?? "", `${HOOK_MARKER}codex`),
    async remove(target, _home, _env, backup) {
      await backupFiles(backup, "codex", [target.hooksPath ?? "", target.instructionsPath]);
      await dropCommandHooks(target.hooksPath ?? "", `${HOOK_MARKER}codex`);
      await dropRefLines(target.instructionsPath);
      await rm(path.join(path.dirname(target.instructionsPath), "RTK.md"), { force: true });
    },
  },
  opencode: {
    flags: ["--opencode"],
    patch: true,
    files: (target) => [path.join(path.dirname(target.mcpPath ?? ""), "plugins", "rtk.ts")],
    has: (target) => fileExists(path.join(path.dirname(target.mcpPath ?? ""), "plugins", "rtk.ts")),
    async remove(target, _home, _env, backup) {
      const plugin = path.join(path.dirname(target.mcpPath ?? ""), "plugins", "rtk.ts");
      await backupFiles(backup, "opencode", [plugin]);
      await rm(plugin, { force: true });
    },
  },
  copilot: {
    flags: ["--copilot"],
    patch: true,
    files: (target) => [
      path.join(path.dirname(target.instructionsPath), "hooks", "rtk-rewrite.json"),
      target.instructionsPath,
    ],
    has: (target) =>
      fileExists(path.join(path.dirname(target.instructionsPath), "hooks", "rtk-rewrite.json")),
    async remove(target, _home, _env, backup) {
      const hookFile = path.join(
        path.dirname(target.instructionsPath),
        "hooks",
        "rtk-rewrite.json",
      );
      await backupFiles(backup, "copilot", [hookFile, target.instructionsPath]);
      await rm(hookFile, { force: true });
      await dropBlock(
        target.instructionsPath,
        "<!-- rtk-instructions",
        "<!-- /rtk-instructions -->",
      );
    },
  },
  pi: {
    flags: ["--agent", "pi"],
    patch: true,
    files: (target) => [path.join(path.dirname(target.instructionsPath), "extensions", "rtk.ts")],
    has: (target) =>
      fileExists(path.join(path.dirname(target.instructionsPath), "extensions", "rtk.ts")),
    async remove(target, _home, _env, backup) {
      const extension = path.join(path.dirname(target.instructionsPath), "extensions", "rtk.ts");
      await backupFiles(backup, "pi", [extension]);
      await rm(extension, { force: true });
    },
  },
  omp: {
    flags: ["--agent", "omp"],
    patch: true,
    files: (target) => [path.join(path.dirname(target.instructionsPath), "extensions", "rtk.ts")],
    has: (target) =>
      fileExists(path.join(path.dirname(target.instructionsPath), "extensions", "rtk.ts")),
    async remove(target, _home, _env, backup) {
      const extension = path.join(path.dirname(target.instructionsPath), "extensions", "rtk.ts");
      await backupFiles(backup, "omp", [extension]);
      await rm(extension, { force: true });
    },
  },
};

/** The agent a target id names, without its WSL distro (`claude@wsl:Ubuntu`). */
export function rtkAgentKind(id: string): string {
  const at = id.indexOf("@wsl:");
  return at > 0 ? id.slice(0, at) : id;
}

/** One WSL distro's own RTK, as myna reports each (library/rtk_wsl.go). */
export interface RtkDistroStatus {
  distro: string;
  installed: boolean;
  path: string | null;
  version: string | null;
}

export interface RtkStatus {
  installed: boolean;
  path: string | null;
  version: string | null;
  url: string;
  /** The command the page would run, shown before it runs; absent when none exists. */
  installCommand?: string;
  upgradeCommand?: string;
  /** A folder holding RTK that the daemon's PATH does not include. */
  pathHint?: string;
  agents: { id: string; name: string; icon: string; on: boolean; distro?: string }[];
  /** Each WSL distro an agent lives in, and its own RTK. */
  distros?: RtkDistroStatus[];
}

async function findOnPath(env: NodeJS.ProcessEnv): Promise<string | null> {
  const dirs = (env.PATH ?? "").split(path.delimiter).filter((dir) => dir.length > 0);
  for (const dir of dirs) {
    for (const name of process.platform === "win32" ? ["rtk.exe", "rtk.cmd"] : ["rtk"]) {
      const candidate = path.join(dir, name);
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

async function versionOf(binary: string): Promise<string | null> {
  try {
    const { stdout } = await run(binary, ["--version"], { timeout: 5000 });
    const match = /(\d+\.\d+\.\d+)/.exec(stdout);
    return match ? match[1] : stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function readRtkStatus(
  targets: readonly LibraryAgentTarget[],
  options: {
    env?: NodeJS.ProcessEnv;
    homeDir: string;
    refresh?: boolean;
    /** A test's finder for a distro's rtk, and its runner. */
    findDistro?: typeof findWslToolIn;
    distroRunner?: (command: string, args: string[]) => Promise<{ stdout: string }>;
  },
): Promise<RtkStatus> {
  const env = options.env ?? process.env;
  const binary = await findOnPath(env);
  const version = binary ? await versionOf(binary) : null;
  const capable = targets.filter((target) => specs[rtkAgentKind(target.id)] !== undefined);
  const agents = await Promise.all(
    capable.map(async (target) => {
      const agent = {
        id: target.id,
        name: target.name,
        icon: target.icon,
        on: await specs[rtkAgentKind(target.id)].has(target, options.homeDir, env),
      } as { id: string; name: string; icon: string; on: boolean; distro?: string };
      if (target.distro !== undefined) {
        agent.distro = target.distro;
      }
      return agent;
    }),
  );
  const plan = await rtkInstallPlan(env);
  const hint = binary === null ? await rtkPathHint(options.homeDir) : null;
  const distros = await readDistroRtks(targets, options);
  return {
    installed: binary !== null,
    path: binary,
    version,
    url: RTK_URL,
    ...(plan.install ? { installCommand: plan.install } : {}),
    ...(plan.upgrade ? { upgradeCommand: plan.upgrade } : {}),
    ...(hint ? { pathHint: hint } : {}),
    ...(distros.length > 0 ? { distros } : {}),
    agents,
  };
}

/** Each WSL distro the targets live in, asked for its own rtk. */
async function readDistroRtks(
  targets: readonly LibraryAgentTarget[],
  options: {
    findDistro?: typeof findWslToolIn;
    distroRunner?: (command: string, args: string[]) => Promise<{ stdout: string }>;
  },
): Promise<RtkDistroStatus[]> {
  const names = [...new Set(targets.map((target) => target.distro).filter(isDistro))].sort();
  return Promise.all(names.map((distro) => readDistroRtk(distro, options)));
}

function isDistro(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

async function readDistroRtk(
  distro: string,
  options: {
    findDistro?: typeof findWslToolIn;
    distroRunner?: (command: string, args: string[]) => Promise<{ stdout: string }>;
  },
): Promise<RtkDistroStatus> {
  const tool = await (options.findDistro ?? findWslToolIn)(distro, "rtk");
  if (tool === null) {
    return { distro, installed: false, path: null, version: null };
  }
  let version: string | null = null;
  try {
    const launch = wslToolCommand(tool, { args: ["--version"] });
    const runDistro =
      options.distroRunner ??
      ((command: string, args: string[]) => run(command, args, { timeout: 5_000 }));
    const { stdout } = await runDistro(launch.command, launch.args);
    version = /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? (stdout.trim() || null);
  } catch {
    version = null;
  }
  return { distro, installed: true, path: tool.path, version };
}

export async function setRtkForAgent(params: {
  target: LibraryAgentTarget;
  on: boolean;
  homeDir: string;
  env?: NodeJS.ProcessEnv;
  backup: LibraryBackup;
  /** For a WSL target's test: its distro's finder. */
  wslFind?: typeof findWslToolIn;
}): Promise<string | null> {
  const env = params.env ?? process.env;
  const spec = specs[rtkAgentKind(params.target.id)];
  if (!spec) {
    throw new Error(`${params.target.name} has no RTK hook`);
  }
  if (!params.on) {
    await spec.remove(params.target, params.homeDir, env, params.backup);
    return null;
  }
  const binary = params.target.distro === undefined ? await findOnPath(env) : null;
  if (params.target.distro === undefined && !binary) {
    throw new Error("RTK isn't installed");
  }
  await backupFiles(
    params.backup,
    params.target.id,
    spec.files(params.target, params.homeDir, env).filter((file) => file.length > 0),
  );
  const args = ["init", "-g", ...spec.flags];
  if (spec.patch) {
    args.push("--auto-patch");
  }
  try {
    if (params.target.distro !== undefined) {
      // the distro's own rtk runs there, as its agent's hook does
      const launch = await rtkWslCommand(
        args,
        params.wslFind === undefined ? {} : { findIn: params.wslFind },
        params.target.distro,
      );
      if (launch === null) {
        throw new Error(`RTK isn't installed in WSL ${params.target.distro}`);
      }
      await run(launch.command, launch.args, {
        env,
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      });
    } else if (binary !== null) {
      await run(binary, args, {
        cwd: params.homeDir,
        env: spec.env ? { ...env, ...spec.env(env, params.homeDir) } : env,
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`RTK's installer failed: ${message}`, { cause: error });
  }
  return null;
}

// ---- installing, upgrading, and what RTK saved ----------------------------

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
/** rtk's own installer, which puts it in ~/.local/bin (myna's rtk.go). */
const INSTALL_SCRIPT_URL =
  "https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh";
const INSTALL_SCRIPT = `sh -c "curl -fsSL ${INSTALL_SCRIPT_URL} | sh"`;
const WINGET_INSTALL =
  "winget install --id rtk-ai.rtk --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity";
const BREW_INFO_TIMEOUT_MS = 30_000;
const BREW_BOTTLED_FOR_MS = 60 * 60 * 1000;

async function findNamedOnPath(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const dirs = (env.PATH ?? "").split(path.delimiter).filter((dir) => dir.length > 0);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

export interface RtkCommandResult {
  code: number | null;
  stdout: string;
}

export type RtkCommandRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<RtkCommandResult>;

const defaultRtkRunner: RtkCommandRunner = async (command, args, options) => {
  try {
    const { stdout } = await run(command, args, {
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { code: 0, stdout };
  } catch (error) {
    const failed = error as { code?: number | string; stdout?: string };
    return {
      code: typeof failed.code === "number" ? failed.code : 1,
      stdout: typeof failed.stdout === "string" ? failed.stdout : "",
    };
  }
};

const bottledCache = new Map<string, { ok: boolean; at: number }>();

/**
 * `brew info rtk` says "(bottled)" only when Homebrew would pour rtk's
 * bottle on this computer. Without one, `brew install rtk` builds rtk,
 * Rust and LLVM from source, which never finishes inside the page's five
 * minutes (myna's rtk.go:1107-1181).
 */
export async function brewBottled(
  brew: string,
  env: NodeJS.ProcessEnv,
  options: { run?: RtkCommandRunner; now?: number } = {},
): Promise<boolean> {
  const cached = bottledCache.get(brew);
  const now = options.now ?? Date.now();
  if (cached && now - cached.at < BREW_BOTTLED_FOR_MS) {
    return cached.ok;
  }
  const result = await (options.run ?? defaultRtkRunner)(brew, ["info", "rtk"], {
    env: {
      ...env,
      HOMEBREW_NO_AUTO_UPDATE: "1",
      HOMEBREW_NO_ENV_HINTS: "1",
      NONINTERACTIVE: "1",
    },
    timeoutMs: BREW_INFO_TIMEOUT_MS,
  }).catch(() => null);
  const ok = result !== null && result.code === 0 && brewSaysBottled(result.stdout);
  bottledCache.set(brew, { ok, at: now });
  return ok;
}

/** `brew info`'s line for rtk says it is bottled for this computer. */
export function brewSaysBottled(output: string): boolean {
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  for (const line of output.replace(ansi, "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("==> rtk: ")) {
      return trimmed.includes("(bottled)");
    }
  }
  return false;
}

/** What the page shows before running anything: the exact command, or none. */
export async function rtkInstallPlan(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    platform?: NodeJS.Platform;
    run?: RtkCommandRunner;
    now?: number;
  } = {},
): Promise<{ install: string | null; upgrade: string | null }> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const winget = await findNamedOnPath("winget", env);
    return winget
      ? { install: WINGET_INSTALL, upgrade: WINGET_INSTALL }
      : { install: null, upgrade: null };
  }
  const brew = await findNamedOnPath("brew", env);
  if (brew && (await brewBottled(brew, env, options))) {
    return { install: "brew install rtk", upgrade: "brew upgrade rtk" };
  }
  const curl = await findNamedOnPath("curl", env);
  if (curl) {
    return { install: INSTALL_SCRIPT, upgrade: INSTALL_SCRIPT };
  }
  return { install: null, upgrade: null };
}

/** Where an RTK the daemon's PATH misses is likely to be. */
export async function rtkPathHint(homeDir: string): Promise<string | null> {
  const candidates = [
    path.join(homeDir, ".local", "bin", "rtk"),
    "/opt/homebrew/bin/rtk",
    "/usr/local/bin/rtk",
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return path.dirname(candidate);
    }
  }
  return null;
}

function shellRun(
  command: string,
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== "win32" && child.pid !== undefined) {
          process.kill(-child.pid, "SIGTERM");
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        child.kill("SIGTERM");
      }
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

export interface RtkRunResult {
  ok: boolean;
  command: string;
  output: string;
  error?: string;
}

/** Runs the install or upgrade the user confirmed in the page. */
/** RTK's own Linux installer, run inside a WSL distro (myna's rtk_wsl.go). */
const RTK_SCRIPT = "https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh";

export interface RtkDistroRun {
  code: number | null;
  output: string;
  timedOut: boolean;
}

export type RtkDistroRunner = (
  distro: string,
  script: string,
  timeoutMs: number,
) => Promise<RtkDistroRun>;

function runInDistro(distro: string, script: string, timeoutMs: number): Promise<RtkDistroRun> {
  return new Promise((resolve, reject) => {
    const child = spawn("wsl.exe", ["-d", distro, "-e", "sh", "-lc", `${script} 2>&1`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

export async function runRtkInstall(
  action: "install" | "upgrade",
  options: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    /** A WSL distro to install or upgrade in, for the agents there. */
    distro?: string;
    /** Injectable for a test; `wsl.exe` by default. */
    runIn?: RtkDistroRunner;
  } = {},
): Promise<RtkRunResult> {
  const env = options.env ?? process.env;
  if (options.distro !== undefined) {
    const script = action === "install" ? `curl -fsSL ${RTK_SCRIPT} | sh` : "rtk upgrade";
    const runInstaller = options.runIn ?? runInDistro;
    const command = `wsl.exe -d ${options.distro} -e sh -lc ${JSON.stringify(script)}`;
    const result = await runInstaller(
      options.distro,
      script,
      options.timeoutMs ?? INSTALL_TIMEOUT_MS,
    );
    if (result.timedOut) {
      return { ok: false, command, output: result.output, error: "The installer timed out" };
    }
    if (result.code !== 0) {
      return {
        ok: false,
        command,
        output: result.output,
        error: result.output.trim() || `The installer exited with ${result.code}`,
      };
    }
    return { ok: true, command, output: result.output };
  }
  const plan = await rtkInstallPlan(env);
  const command = action === "install" ? plan.install : plan.upgrade;
  if (command === null) {
    return {
      ok: false,
      command: "",
      output: "",
      error: "RTK cannot be installed here: no Homebrew bottle, curl or winget",
    };
  }
  const result = await shellRun(command, {
    env,
    timeoutMs: options.timeoutMs ?? INSTALL_TIMEOUT_MS,
  });
  if (result.timedOut) {
    return { ok: false, command, output: result.output, error: "The installer timed out" };
  }
  if (result.code !== 0) {
    return {
      ok: false,
      command,
      output: result.output,
      error: result.output.trim() || `The installer exited with ${result.code}`,
    };
  }
  return { ok: true, command, output: result.output };
}

export interface RtkGainDay {
  date: string;
  value: number;
}

export interface RtkGain {
  available: boolean;
  raw: string;
  days: RtkGainDay[];
  total: number | null;
}

function gainDays(value: unknown): RtkGainDay[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const days: RtkGainDay[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const date = row.date ?? row.day ?? row.iso;
    const amount =
      row.saved ?? row.value ?? row.tokens ?? row.savedTokens ?? row.total ?? row.count;
    if (typeof date === "string" && typeof amount === "number" && Number.isFinite(amount)) {
      days.push({ date, value: amount });
    }
  }
  return days;
}

/** `rtk gain`, as JSON when it answers that way, otherwise as its text. */
export async function readRtkGain(env: NodeJS.ProcessEnv = process.env): Promise<RtkGain> {
  const binary = await findOnPath(env);
  if (!binary) {
    return { available: false, raw: "", days: [], total: null };
  }
  let raw = "";
  for (const args of [["gain", "--json"], ["gain"]]) {
    try {
      const { stdout } = await run(binary, args, { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
      raw = stdout.trim();
      if (raw.length > 0) {
        break;
      }
    } catch {
      // try the other form
    }
  }
  if (raw.length === 0) {
    return { available: false, raw: "", days: [], total: null };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const root = parsed as Record<string, unknown>;
      let listed: RtkGainDay[] = [];
      for (const candidate of [root.days, root.daily, root.history, root.byDay]) {
        listed = gainDays(candidate);
        if (listed.length > 0) {
          break;
        }
      }
      const totalValue = root.total ?? root.saved ?? root.totalSaved;
      const total = typeof totalValue === "number" ? totalValue : null;
      return { available: true, raw, days: listed, total };
    }
  } catch {
    // not JSON: show the text as it came
  }
  return { available: true, raw, days: [], total: null };
}
