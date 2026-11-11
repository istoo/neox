import { pathToFileURL } from "node:url";
import { resolvePassthroughCliEntrypoint } from "./entrypoints.js";

const DESKTOP_CLI_ENV = "NEOLIX_DESKTOP_CLI";
const IGNORED_ARG_PREFIXES = [
  "-psn_",
  "--class=",
  "--no-sandbox",
  "--remote-debugging-port=",
  // Login and CLI launch modes belong to the app, not to its CLI passthrough
  // (system/cli-control.ts): `--hidden` from the login record, `--panel`
  // from `neolix panel`, and the `neolix autostart|update` control flags.
  "--hidden",
  "--panel",
  "--neolix-cli-",
];

export type PassthroughCliRunner = (argv: string[]) => Promise<number>;

export function parsePassthroughCliArgs(input: {
  argv: string[];
  isDefaultApp: boolean;
  forceCli: boolean;
}): string[] | null {
  const startIndex = input.isDefaultApp ? 2 : 1;
  const effective: string[] = [];

  for (const arg of input.argv.slice(startIndex)) {
    if (IGNORED_ARG_PREFIXES.some((prefix) => arg.startsWith(prefix))) {
      continue;
    }
    effective.push(arg);
  }

  if (input.forceCli) {
    return effective;
  }

  return effective.length > 0 ? effective : null;
}

export function parsePassthroughCliArgsFromArgv(argv: string[]): string[] | null {
  return parsePassthroughCliArgs({
    argv,
    isDefaultApp: process.defaultApp,
    forceCli: process.env[DESKTOP_CLI_ENV] === "1",
  });
}

async function importPassthroughCliRunner(): Promise<PassthroughCliRunner> {
  const entrypoint = resolvePassthroughCliEntrypoint();
  const imported = (await import(pathToFileURL(entrypoint).href)) as {
    runCli?: unknown;
  };
  if (typeof imported.runCli !== "function") {
    throw new Error(`Passthrough CLI entrypoint did not export runCli: ${entrypoint}`);
  }
  return imported.runCli as PassthroughCliRunner;
}

export async function runPassthroughCli(
  args: string[],
  options: { runCli?: PassthroughCliRunner } = {},
): Promise<number> {
  const runCli = options.runCli ?? (await importPassthroughCliRunner());
  return await runCli(args);
}
