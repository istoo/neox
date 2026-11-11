import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  findWslTool,
  type WslrunDeps,
  type WslTool,
  windowsToWslPath,
} from "../../../wslrun/wslrun.js";

/**
 * Claude Code is started by the Agent SDK from an executable path, which
 * cannot be wsl.exe with arguments. So Neolix writes a small executable that
 * hands the arguments to the distro's Claude (myna runs a Claude in WSL
 * through wslrun: `-d <distro> --exec /usr/bin/env PATH=... <path> args`),
 * and the SDK starts that.
 */
export interface ClaudeWslShimInput {
  neolixHome: string;
  tool: WslTool;
  /** The session's working directory, as Windows spells it. */
  cwd: string;
  /**
   * What the distro's Claude needs in its environment; PATH comes from the
   * distro. Only these names go into the shim (WSLENV), never their values.
   */
  env?: Record<string, string>;
  platform?: NodeJS.Platform;
}

/** The wsl.exe arguments the shim runs, up to Claude's own arguments. */
export function claudeWslArguments(tool: WslTool, cwd: string): string[] {
  const linuxCwd = cwd.length === 0 ? tool.home : windowsToWslPath(cwd);
  return [
    "-d",
    tool.distro,
    "--cd",
    linuxCwd,
    "--exec",
    "/usr/bin/env",
    `PATH=${tool.pathEnv}`,
    tool.path,
  ];
}

/**
 * The variables the shim hands into the distro, by name only: WSL passes
 * what WSLENV names from the Windows environment it starts with, so no
 * value — a token included — is ever written to disk. PATH is the
 * distro's own, and WSLENV itself is the shim's to set.
 */
export function claudeWslEnvNames(env: Record<string, string> = {}): string[] {
  return Object.keys(env).filter(
    (name) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) &&
      name.toLowerCase() !== "path" &&
      name.toUpperCase() !== "WSLENV",
  );
}

/**
 * The variables myna marks as Windows paths (`internal/provider/claude_signin.go`,
 * `internal/wslrun`): WSL makes them the distro's path (/p). Every other
 * variable goes by its name alone, as myna's WSLENV does.
 */
const WSL_PATH_VARIABLES = new Set(["CLAUDE_CONFIG_DIR", "BROWSER", "MYNA_OPENED_URL"]);

/** The shim's WSLENV entries: a name, with /p for one of myna's path variables. */
export function wslEnvEntries(names: readonly string[]): string[] {
  return names.map((name) => (WSL_PATH_VARIABLES.has(name.toUpperCase()) ? `${name}/p` : name));
}

/** A Windows .cmd: `%*` carries every argument the SDK passes. */
export function windowsShimContent(args: string[], envNames: string[] = []): string {
  const quoted = args.map((value) => `"${value.replace(/%/gu, "%%").replace(/"/gu, '\\"')}"`);
  const lines = ["@echo off"];
  if (envNames.length > 0) {
    const names = wslEnvEntries(envNames).join(":");
    lines.push(`if defined WSLENV (set "WSLENV=%WSLENV%:${names}") else (set "WSLENV=${names}")`);
  }
  lines.push(`wsl.exe ${quoted.join(" ")} %*`);
  return `${lines.join("\r\n")}\r\n`;
}

/** A sh script, for a Neolix daemon on a system that isn't Windows. */
export function posixShimContent(args: string[], envNames: string[] = []): string {
  const quoted = args.map((value) => `'${value.replace(/'/gu, `'\\''`)}'`);
  const wslenv =
    envNames.length === 0
      ? ""
      : `WSLENV="\${WSLENV:+$WSLENV:}${wslEnvEntries(envNames).join(":")}" `;
  return `#!/bin/sh\n${wslenv}exec wsl.exe ${quoted.join(" ")} "$@"\n`;
}

/**
 * Writes the shim for a distro's Claude and answers its path. The file is
 * named for its content, so a session that starts again reuses it.
 */
export async function writeClaudeWslShim(input: ClaudeWslShimInput): Promise<string> {
  const platform = input.platform ?? process.platform;
  const windows = platform === "win32";
  // Only names go into the file: its name and its content stay the same
  // whatever a session's tokens are.
  const envNames = claudeWslEnvNames(input.env);
  const args = claudeWslArguments(input.tool, input.cwd);
  const content = windows ? windowsShimContent(args, envNames) : posixShimContent(args, envNames);
  const digest = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const directory = path.join(input.neolixHome, "agent-connect", "wsl");
  const file = path.join(directory, `claude-${digest}.${windows ? "cmd" : "sh"}`);
  const existing = await readFile(file, "utf8").catch(() => null);
  if (existing !== content) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(file, content, { mode: 0o700 });
  }
  await chmod(directory, 0o700).catch(() => undefined);
  await chmod(file, 0o700).catch(() => undefined);
  return file;
}

/** The distro holding Claude when the resolved binary is a distro path. */
export async function wslToolForClaudeBinary(
  binary: string | null | undefined,
  deps: WslrunDeps = {},
): Promise<WslTool | null> {
  if ((deps.platform ?? process.platform) !== "win32") return null;
  if (typeof binary !== "string" || !binary.startsWith("/")) return null;
  return findWslTool("claude", deps);
}

/**
 * What the SDK should start: the shim when Claude lives in WSL, else the
 * binary itself.
 */
export async function claudeLaunchExecutable(input: {
  binary: string;
  neolixHome: string;
  cwd: string;
  env?: Record<string, string>;
  platform?: NodeJS.Platform;
  deps?: WslrunDeps;
}): Promise<string> {
  const platform = input.platform ?? process.platform;
  const tool = await wslToolForClaudeBinary(input.binary, {
    ...input.deps,
    platform,
  });
  if (tool === null) return input.binary;
  return writeClaudeWslShim({
    neolixHome: input.neolixHome,
    tool,
    cwd: input.cwd,
    ...(input.env === undefined ? {} : { env: input.env }),
    platform,
  });
}
