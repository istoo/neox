import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SessionRoots } from "./types.js";

const run = promisify(execFile);

export interface WslDistro {
  name: string;
  running: boolean;
}

export interface WslRoots {
  distro: string;
  roots: SessionRoots;
}

/**
 * Windows reads a WSL distro's files through `\\wsl.localhost`. Only a
 * running distro's home is read: opening a stopped one's files starts it.
 *
 * debt: a stopped distro's sessions are not listed (myna keeps their last
 * listing on disk); add that when WSL sessions must show while stopped.
 */
export interface WslDeps {
  platform?: NodeJS.Platform;
  list?: () => Promise<string>;
  home?: (distro: string) => Promise<string>;
}

export async function discoverWslRoots(deps: WslDeps = {}): Promise<WslRoots[]> {
  if ((deps.platform ?? process.platform) !== "win32") {
    return [];
  }
  let listing: string;
  try {
    listing = await (deps.list ?? listDistros)();
  } catch {
    return [];
  }
  const roots: WslRoots[] = [];
  for (const distro of parseWslDistros(listing)) {
    if (!distro.running) {
      continue;
    }
    let home: string;
    try {
      home = await (deps.home ?? homeOf)(distro.name);
    } catch {
      continue;
    }
    if (home.length === 0) {
      continue;
    }
    roots.push({ distro: distro.name, roots: sessionRootsOf(distro.name, home) });
  }
  return roots;
}

/** `wsl.exe -l -v` as its distros and whether each runs now. */
export function parseWslDistros(output: string): WslDistro[] {
  const out: WslDistro[] = [];
  const clean = output.split(String.fromCharCode(0)).join("");
  for (const line of clean.split(/\r?\n/u)) {
    const trimmed = line.replace(/^\uFEFF/u, "").trim();
    if (trimmed.length === 0 || /^NAME\s+STATE\s+VERSION/iu.test(trimmed)) {
      continue;
    }
    const fields = trimmed
      .replace(/^\*/u, "")
      .trim()
      .split(/\s{2,}/u);
    const name = fields[0]?.trim() ?? "";
    const state = fields[1]?.trim() ?? "";
    if (name.length === 0 || name === "*" || state.length === 0) {
      continue;
    }
    out.push({ name, running: /^running$/iu.test(state) });
  }
  return out;
}

/** A distro's home folder as Windows reads it. */
export function wslUncPath(distro: string, home: string): string {
  const posix = home.replace(/\\/gu, "/").replace(/\/+$/u, "");
  return `\\\\wsl.localhost\\${distro}${posix.replace(/\//gu, "\\")}`;
}

/** The session folders of a distro, under its home. */
export function sessionRootsOf(distro: string, home: string): SessionRoots {
  const base = wslUncPath(distro, home);
  return {
    claude: `${base}\\.claude`,
    codex: `${base}\\.codex`,
    pi: `${base}\\.pi\\agent\\sessions`,
    // OpenCode's database and Antigravity's summary database are SQLite
    // files a Windows daemon can't read safely over the 9P share, and myna
    // doesn't list them from a distro either.
    opencode: "",
    agy: "",
  };
}

async function listDistros(): Promise<string> {
  // wsl.exe writes UTF-16LE.
  const { stdout } = await run("wsl.exe", ["-l", "-v"], {
    encoding: "buffer",
    windowsHide: true,
    timeout: 10_000,
  });
  return Buffer.from(stdout).toString("utf16le");
}

async function homeOf(distro: string): Promise<string> {
  const { stdout } = await run("wsl.exe", ["-d", distro, "-e", "sh", "-lc", 'printf %s "$HOME"'], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  return stdout.trim();
}
