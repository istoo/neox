import type { StoredMcpServer } from "./store.js";
import {
  findWslTool,
  findWslToolIn,
  windowsToWslPath,
  wslToolCommand,
  type WslrunDeps,
  type WslTool,
} from "../wslrun/wslrun.js";

export interface WslCommand {
  /** Always wsl.exe. */
  command: string;
  args: string[];
  cwd: string;
  /** The command inside the distro, and its distro. */
  tool: WslTool;
}

export interface WslCommandDeps extends WslrunDeps {
  /** Finds a command in the running distros; injectable for a test. */
  find?: typeof findWslTool;
  /** Finds a command in the distro named, when it is known. */
  findIn?: typeof findWslToolIn;
}

/**
 * An MCP server as one run in a WSL distro (myna's library/mcp_check.go:
 * wslrun.In then wslrun.Command): the command found there, given the
 * server's arguments, variables and home. Null when the distro has no
 * such command.
 */
export async function mcpWslCommand(
  input: {
    command: string;
    args?: readonly string[];
    cwd?: string;
    env?: Record<string, string>;
    /** The agent's distro, when it is known: its own command is looked in. */
    distro?: string;
  },
  deps: WslCommandDeps = {},
): Promise<WslCommand | null> {
  const tool =
    input.distro === undefined
      ? await (deps.find ?? findWslTool)(input.command, deps)
      : await (deps.findIn ?? findWslToolIn)(input.distro, input.command, deps);
  if (tool === null) {
    return null;
  }
  const command = wslToolCommand(tool, {
    args: [...(input.args ?? [])],
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.env === undefined ? {} : { env: input.env }),
  });
  return { ...command, tool };
}

/**
 * RTK as a WSL agent's hook runs it (myna's library/rtk_wsl.go: a Windows
 * rtk.exe is no command there, so the distro's own is found and run).
 */
export async function rtkWslCommand(
  args: readonly string[],
  deps: WslCommandDeps = {},
  distro?: string,
): Promise<WslCommand | null> {
  return mcpWslCommand({ command: "rtk", args, ...(distro === undefined ? {} : { distro }) }, deps);
}

/**
 * A stdio MCP server as an agent in WSL starts it (myna's library/
 * mcp_wsl.go): a Windows program's path is written as the distro sees it,
 * and only the server's own variables cross to it.
 */
export function wslMcpServer(server: StoredMcpServer, mount = "/mnt/"): StoredMcpServer {
  if (server.transport !== "stdio") {
    return server;
  }
  const command = windowsCommandInWsl(server.command ?? "", mount);
  if (command === null) {
    return server;
  }
  const env = server.env ?? {};
  return {
    ...server,
    command,
    ...(Object.keys(env).length === 0 ? {} : { env: { ...env, WSLENV: wslEnvNames(env) } }),
  };
}

/**
 * A Windows program as an agent in WSL starts it (myna's library/
 * mcp_wsl.go): by its path inside the distro, through WSL's interop. Null
 * for a command that isn't a Windows path.
 */
export function windowsCommandInWsl(command: string, mount = "/mnt/"): string | null {
  if (!/^[A-Za-z]:[\\/]/.test(command.trim())) {
    return null;
  }
  return windowsToWslPath(command, mount);
}

/**
 * WSLENV naming the variables a Windows program is given: only these
 * cross into the distro, sorted, as myna gives them.
 */
export function wslEnvNames(env: Readonly<Record<string, string>> | undefined): string {
  return Object.keys(env ?? {})
    .sort()
    .join(":");
}
