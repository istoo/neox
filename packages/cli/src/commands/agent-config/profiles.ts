import chalk from "chalk";
import { Command } from "commander";
import type { AgentConnectProfile, AgentConnectSnapshot } from "@neolix/protocol/agent-connect";
import { agentLabel, checkedSnapshot, withAgentConnect, type AgentCliOptions } from "./shared.js";

/**
 * myna's profiles (internal/cli/main.go:66-70, 891): `neolix save`, `use`,
 * `profiles`, `rename` and `rm`. A profile is the daemon's saved setup, so
 * every verb is one of its RPCs; the wording is myna's.
 */

const PROFILE_USAGE = `  neox save <name>              snapshot every agent's settings as a profile
  neox use <name>               apply a profile
  neox profiles                 list profiles
  neox rename <old> <new>       rename a profile
  neox rm <name>                delete a profile`;

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** myna's LongSummary: each agent's model, then the library's setup. */
export function profileSummary(profile: AgentConnectProfile): string {
  const parts = Object.entries(profile.agents)
    .filter(([, setup]) => setup.connected && setup.model !== null)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, setup]) => `${providerLabel(provider)} ${setup.model}`);
  if (profile.library !== undefined) {
    parts.push("+ the library's setup");
  }
  return parts.join(" · ");
}

function providerLabel(provider: string): string {
  return agentLabel({ provider });
}

function setupOf(snapshot: AgentConnectSnapshot): Map<string, string> {
  return new Map(
    snapshot.entries.map((entry) => [
      entry.provider,
      `${entry.connected ? "on" : "off"}:${entry.model ?? ""}`,
    ]),
  );
}

/** How many agents a profile moved: myna's `(N changed)`. */
export function changedCount(before: AgentConnectSnapshot, after: AgentConnectSnapshot): number {
  const was = setupOf(before);
  const now = setupOf(after);
  const ids = new Set([...was.keys(), ...now.keys()]);
  let changed = 0;
  for (const id of ids) {
    if (was.get(id) !== now.get(id)) changed += 1;
  }
  return changed;
}

function oneArgument(args: readonly string[], usage: string): string {
  if (args.length !== 1 || args[0]!.startsWith("-")) {
    throw new Error(usage);
  }
  return args[0]!;
}

function sayHelp(usage: string): void {
  say(usage);
}

async function listProfiles(options: AgentCliOptions): Promise<void> {
  await withAgentConnect(options, async (client) => {
    const { snapshot } = await client.getAgentConnect();
    if (snapshot.profiles.length === 0) {
      say(chalk.gray("no profiles yet · neox save <name>"));
      return;
    }
    for (const profile of snapshot.profiles) {
      const mark = profile.inUse === true ? "✓" : " ";
      say(`${mark} ${chalk.bold(profile.name)}  ${chalk.gray(profileSummary(profile))}`);
    }
  });
}

async function saveProfile(options: AgentCliOptions, name: string): Promise<void> {
  await withAgentConnect(options, async (client) => {
    const snapshot = checkedSnapshot((await client.saveAgentConnectProfile(name)).snapshot);
    say(`✓ saved profile ${chalk.bold(name)}`);
    const saved = snapshot.profiles.find((profile) => profile.name === name);
    if (saved?.library !== undefined) {
      say(chalk.gray("  with the library's setup"));
    }
  });
}

async function applyProfile(options: AgentCliOptions, name: string): Promise<void> {
  await withAgentConnect(options, async (client) => {
    const before = (await client.getAgentConnect()).snapshot;
    if (!before.profiles.some((profile) => profile.name === name)) {
      throw new Error(`no profile named "${name}"`);
    }
    const after = checkedSnapshot((await client.applyAgentConnectProfile(name)).snapshot);
    say(`✓ applied ${chalk.bold(name)} ${chalk.gray(`(${changedCount(before, after)} changed)`)}`);
  });
}

async function renameProfile(options: AgentCliOptions, from: string, to: string): Promise<void> {
  await withAgentConnect(options, async (client) => {
    checkedSnapshot((await client.renameAgentConnectProfile(from, to)).snapshot);
    say(`✓ renamed profile ${chalk.bold(from)} to ${chalk.bold(to)}`);
  });
}

async function removeProfile(options: AgentCliOptions, name: string): Promise<void> {
  await withAgentConnect(options, async (client) => {
    checkedSnapshot((await client.deleteAgentConnectProfile(name)).snapshot);
    say(`✓ deleted profile ${chalk.bold(name)}`);
  });
}

function profileCommand(
  name: string,
  description: string,
  run: (args: readonly string[], options: AgentCliOptions) => Promise<void>,
): Command {
  return new Command(name)
    .description(description)
    .argument("[args...]")
    .allowUnknownOption(true)
    .helpOption(false)
    .action(async (args: string[] | undefined, _options: unknown, command: Command) => {
      const values = args ?? [];
      if (values.includes("-h") || values.includes("--help") || values[0] === "help") {
        sayHelp(PROFILE_USAGE);
        return;
      }
      await run(values, command.optsWithGlobals() as AgentCliOptions);
    });
}

export function createProfileCommands(): Command[] {
  return [
    profileCommand("profiles", "List saved profiles", (args, options) => {
      if (args.length > 0) throw new Error(PROFILE_USAGE);
      return listProfiles(options);
    }),
    profileCommand("save", "Snapshot every agent's settings as a profile", (args, options) =>
      saveProfile(options, oneArgument(args, "usage: neox save <name>")),
    ),
    profileCommand("use", "Apply a profile", (args, options) =>
      applyProfile(options, oneArgument(args, "usage: neox use <name>")),
    ),
    profileCommand("rm", "Delete a profile", (args, options) =>
      removeProfile(options, oneArgument(args, "usage: neox rm <name>")),
    ),
    profileCommand("rename", "Rename a profile", (args, options) => {
      if (args.length !== 2 || args[1]!.startsWith("-")) {
        throw new Error("usage: neox rename <old> <new>");
      }
      return renameProfile(options, args[0]!, args[1]!);
    }),
  ];
}
