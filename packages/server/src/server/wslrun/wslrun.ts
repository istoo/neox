import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseWslDistros } from "../external-sessions/wsl.js";

const run = promisify(execFile);

// Ported from myna's internal/wslrun: an agent installed only inside a WSL
// distro runs there, through wsl.exe, with its paths told the way the
// distro spells them.

export interface WslTool {
  /** The distro, as wsl.exe -l names it. */
  distro: string;
  /** The command inside the distro. */
  path: string;
  /** The distro's PATH, which the command may need (node and its tools). */
  pathEnv: string;
  /** The Windows host's address inside the distro, null when it is 127.0.0.1. */
  host: string | null;
  /** The distro's home folder, inside the distro. */
  home: string;
}

export interface WslrunDeps {
  platform?: NodeJS.Platform;
  /** Settings' Detect agents in WSL, inverse. */
  enabled?: boolean;
  /** `wsl.exe ...` and its stdout, injectable. */
  exec?: (args: string[]) => Promise<string>;
  /** Whether Windows itself has the command; a WSL one is only a fallback. */
  onHost?: (command: string) => Promise<boolean>;
}

const FIND_AGE_MS = 60_000;

interface CachedFind {
  at: number;
  tool: WslTool | null;
}

const found = new Map<string, CachedFind>();

/** HostLoopback is whether a distro's 127.0.0.1 reaches Windows' (myna's wslrun.HostLoopback). */
export function hostLoopback(mode: string): boolean {
  return ["mirrored", "consomme", "virtioproxy"].includes(mode.trim().toLowerCase());
}

/** A Windows path as the distro spells it: C:\Users\me → /mnt/c/Users/me. */
export function windowsToWslPath(value: string, mount = "/mnt/"): string {
  const match = /^([A-Za-z]):(?:[\\/](.*))?$/u.exec(value.trim());
  if (match?.[1] === undefined) return value;
  const rest = (match[2] ?? "").replace(/\\/gu, "/");
  return `${mount}${match[1].toLowerCase()}${rest.length > 0 ? `/${rest}` : ""}`;
}

function probeScript(command: string): string {
  return [
    'echo "home:$HOME"',
    'echo "path:$PATH"',
    `p=$(command -v '${command.replace(/'/gu, "")}' 2>/dev/null) && echo "bin:$p"`,
    "ip route show default 2>/dev/null | head -n1 | sed 's/^/route:/'",
    'command -v wslinfo >/dev/null 2>&1 && echo "net:$(wslinfo --networking-mode 2>/dev/null)"',
    "awk '$1 ~ /^[A-Za-z]:/ {print \"win:\" $2}' /proc/mounts 2>/dev/null | head -n1",
    "true",
  ].join("; ");
}

function parseProbe(distro: string, output: string): WslTool | null {
  let home = "";
  let path = "";
  let pathEnv = "";
  let route = "";
  let net = "";
  let mount = "/mnt/";
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith("home:")) home = line.slice(5).trim();
    else if (line.startsWith("path:")) pathEnv = line.slice(5).trim();
    else if (line.startsWith("bin:")) path = line.slice(4).trim();
    else if (line.startsWith("route:")) route = line.slice(6).trim();
    else if (line.startsWith("net:")) net = line.slice(4).trim();
    else if (line.startsWith("win:")) mount = `${line.slice(4).trim().replace(/\/?$/u, "/")}`;
  }
  if (home.length === 0 || path.length === 0) return null;
  // A command on Windows' drives (/mnt/c/...) is Windows' own, not the distro's.
  if (path.startsWith(mount)) return null;
  const host = hostLoopback(net) ? null : (/\bvia\s+(\S+)/u.exec(route)?.[1] ?? null);
  return { distro, path, pathEnv, host, home };
}

/**
 * Finds a command of a running WSL distro's own, the default distro first.
 * A stopped distro is never started to look.
 */
export async function findWslTool(command: string, deps: WslrunDeps = {}): Promise<WslTool | null> {
  if ((deps.platform ?? process.platform) !== "win32" || deps.enabled === false) return null;
  if (!/^[A-Za-z0-9_.+-]+$/u.test(command)) return null;
  if (await (deps.onHost ?? onHostPath)(command)) return null;
  const cached = found.get(command);
  const now = Date.now();
  if (cached !== undefined && now - cached.at < FIND_AGE_MS) return cached.tool;
  const exec = deps.exec ?? runWsl;
  let listing: string;
  try {
    listing = await exec(["-l", "-v"]);
  } catch {
    found.set(command, { at: now, tool: null });
    return null;
  }
  let ordered = parseWslDistros(listing)
    .filter((distro) => distro.running)
    .map((distro) => distro.name);
  try {
    const names = (await exec(["-l", "-q"]))
      .split(String.fromCharCode(0))
      .join("")
      .split(/\r?\n/u)
      .map((name) => name.trim());
    const preferred = names.find((name) => name.length > 0);
    if (preferred !== undefined && ordered.includes(preferred)) {
      ordered = [preferred, ...ordered.filter((name) => name !== preferred)];
    }
  } catch {
    // No default distro known: the listing's order stands.
  }
  let tool: WslTool | null = null;
  for (const distro of ordered) {
    try {
      const output = await exec(["-d", distro, "-e", "sh", "-lc", probeScript(command)]);
      tool = parseProbe(distro, output);
    } catch {
      tool = null;
    }
    if (tool !== null) break;
  }
  found.set(command, { at: now, tool });
  return tool;
}

/**
 * Finds a command of the running distro named, even when this machine has
 * one too (myna's wslrun.In): an agent in that distro runs its own.
 */
export async function findWslToolIn(
  distro: string,
  command: string,
  deps: WslrunDeps = {},
): Promise<WslTool | null> {
  if ((deps.platform ?? process.platform) !== "win32" || deps.enabled === false) return null;
  if (distro.length === 0 || !/^[A-Za-z0-9_.+-]+$/u.test(command)) return null;
  const key = `${distro}\u0000${command}`;
  const cached = found.get(key);
  const now = Date.now();
  if (cached !== undefined && now - cached.at < FIND_AGE_MS) return cached.tool;
  const exec = deps.exec ?? runWsl;
  let running = false;
  try {
    running = parseWslDistros(await exec(["-l", "-v"])).some(
      (one) => one.name === distro && one.running,
    );
  } catch {
    running = false;
  }
  let tool: WslTool | null = null;
  if (running) {
    try {
      const output = await exec(["-d", distro, "-e", "sh", "-lc", probeScript(command)]);
      tool = parseProbe(distro, output);
    } catch {
      tool = null;
    }
  }
  found.set(key, { at: now, tool });
  return tool;
}

export interface WslLaunch {
  command: string;
  args: string[];
  cwd?: string;
  /** The distro's home, for a caller that has to start there. */
  home: string;
}

/**
 * Runs a command that Windows lacks in the running distro that has it
 * (myna's wslrun.Command): the arguments are handed as they are, and a
 * Windows cwd is spelt for the distro.
 */
export async function wslLaunch(
  launch: {
    command: string;
    args: string[];
    cwd?: string;
    /** What the command runs with there; a Windows path value is spelt for the distro. */
    env?: Record<string, string>;
  },
  deps: WslrunDeps = {},
): Promise<WslLaunch | null> {
  const tool = await findWslTool(launch.command, deps);
  if (tool === null) return null;
  return { ...wslToolCommand(tool, launch), home: tool.home };
}

/**
 * The wsl.exe command for a tool someone else found: a caller that has to
 * spawn synchronously (the Claude SDK's process hook) builds it here.
 */
export function wslToolCommand(
  tool: WslTool,
  launch: { args: string[]; cwd?: string; env?: Record<string, string> },
): { command: string; args: string[]; cwd: string } {
  const cwd =
    launch.cwd === undefined || launch.cwd.length === 0 ? tool.home : windowsToWslPath(launch.cwd);
  const entries = Object.entries(launch.env ?? {}).map(
    ([key, value]) => `${key}=${windowsToWslPath(value)}`,
  );
  // /usr/bin/env gives the distro's own PATH and what the caller passes,
  // as myna's wslrun does (its path inside the distro, not Windows').
  const args =
    entries.length === 0
      ? ["-d", tool.distro, "-e", tool.path, ...launch.args]
      : [
          "-d",
          tool.distro,
          "--exec",
          "/usr/bin/env",
          `PATH=${tool.pathEnv}`,
          ...entries,
          tool.path,
          ...launch.args,
        ];
  return { command: "wsl.exe", args, cwd };
}

/** Empties the cached finds, for a test or a Settings change. */
export function forgetWslTools(): void {
  found.clear();
}

async function onHostPath(command: string): Promise<boolean> {
  const directories = (process.env["PATH"] ?? process.env["Path"] ?? "").split(";");
  const extensions = (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";");
  const { access, constants } = await import("node:fs/promises");
  const { join } = await import("node:path");
  for (const directory of directories) {
    if (directory.length === 0) continue;
    for (const extension of extensions) {
      try {
        await access(join(directory, `${command}${extension}`), constants.X_OK);
        return true;
      } catch {
        // Try the next candidate.
      }
    }
  }
  return false;
}

async function runWsl(args: string[]): Promise<string> {
  const { stdout } = await run("wsl.exe", args, {
    encoding: "buffer",
    windowsHide: true,
    timeout: 30_000,
    env: { ...process.env, WSL_UTF8: "1" },
  });
  return Buffer.from(stdout).toString("utf8");
}
