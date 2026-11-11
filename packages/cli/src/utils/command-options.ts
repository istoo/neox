import type { Command } from "commander";
import { selectDaemonTarget } from "./daemon-target.js";

const JSON_OPTION_DESCRIPTION = "Output in JSON format";
const DAEMON_HOST_OPTION_DESCRIPTION =
  "Explicit daemon endpoint: host:port, TCP, socket, SSH, or pairing URL (default: local home)";

const localCommands = new WeakSet<Command>();

export function addLocalDaemonOptions<T extends Command>(command: T): T {
  localCommands.add(command);
  command.option("--home <path>", "Local daemon home (default: ~/.neox)");
  return command;
}

export function collectMultiple(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

export function addJsonOption<T extends Command>(command: T): T {
  command.option("--json", JSON_OPTION_DESCRIPTION);
  return command;
}

export function addDaemonHostOption<T extends Command>(command: T): T {
  command.option("--host <host>", DAEMON_HOST_OPTION_DESCRIPTION);
  if (!command.options.some((option) => option.long === "--home"))
    command.option("--home <path>", "Select a local daemon home (default: ~/.neox)");
  return command;
}

export function addJsonAndDaemonHostOptions<T extends Command>(command: T): T {
  return addDaemonHostOption(addJsonOption(command));
}

export interface DaemonSelectors {
  home?: string;
  host?: string;
}

/** --home and --host as this command and its ancestors parsed them. */
export function globalDaemonSelectors(command: Command): DaemonSelectors {
  const options = command.optsWithGlobals() as DaemonSelectors;
  const selectors = { home: new Set<string>(), host: new Set<string>() };
  for (let current: Command | null = command; current; current = current.parent) {
    for (const key of ["home", "host"] as const) {
      const value = current.opts()[key];
      if (typeof value === "string") selectors[key].add(value);
    }
  }
  for (const key of ["home", "host"] as const) {
    if (selectors[key].size > 1)
      throw { code: "TARGET_AMBIGUOUS", message: `Conflicting duplicate --${key} selectors.` };
  }
  return { home: options.home, host: options.host };
}

/**
 * The home a command that only reads or writes this computer's files uses.
 * --host names a daemon endpoint, which such a command cannot reach.
 */
export function localDaemonHome(command: Command): string | undefined {
  const selectors = globalDaemonSelectors(command);
  if (selectors.host !== undefined) {
    throw {
      code: "LOCAL_OPERATION",
      message: "This is a local operation; use --home. --host is not supported.",
    };
  }
  return selectors.home;
}

export function withGlobalOptions<Args extends unknown[], Result>(
  handler: (...args: Args) => Result,
): (...args: Args) => Result {
  return (...args) => {
    const command = args.at(-1) as Command;
    const mergedArgs = [...args];
    const options = command.optsWithGlobals();
    const localOnly = localCommands.has(command);
    options.daemonTarget = selectDaemonTarget(
      globalDaemonSelectors(command),
      process.env,
      localOnly,
    );
    mergedArgs[mergedArgs.length - 2] = options;
    return handler(...(mergedArgs as Args));
  };
}
