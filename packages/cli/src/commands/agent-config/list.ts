import chalk from "chalk";
import { Command } from "commander";
import type { AgentConnectEntry, AgentConnectSnapshot } from "@neolix/protocol/agent-connect";
import {
  agentLabel,
  findAgentEntry,
  tilde,
  withAgentConnect,
  type AgentCliOptions,
} from "./shared.js";

/**
 * `neolix agents` — myna's `myna agents` (internal/cli/main.go:495): every
 * agent Neolix knows, with its model and the config file it keeps. myna's
 * `myna ls` shows the same rows in the order the app lists them, the hidden
 * ones last and dimmed; that is this command's order too.
 */

function arranged(snapshot: AgentConnectSnapshot): AgentConnectEntry[] {
  const rank = new Map((snapshot.order ?? []).map((id, index) => [id, index]));
  const at = (entry: AgentConnectEntry) => rank.get(entry.provider) ?? Number.MAX_SAFE_INTEGER;
  return [...snapshot.entries].sort((a, b) => at(a) - at(b));
}

interface AgentRow {
  name: string;
  values: string;
  path: string;
  dim: boolean;
}

function suffixOf(isHidden: boolean, unsupported: boolean): string {
  if (isHidden) return " hidden";
  if (unsupported) return " not supported";
  return "";
}

function rowOf(entry: AgentConnectEntry, hidden: ReadonlySet<string>): AgentRow {
  const isHidden = hidden.has(entry.provider);
  const unsupported = entry.reason === "unsupported";
  return {
    name: `${agentLabel(entry)}${suffixOf(isHidden, unsupported)}`,
    values: entry.connected ? (entry.model ?? "—") : "—",
    path: tilde(entry.configPath),
    dim: isHidden || unsupported,
  };
}

export function printAgents(snapshot: AgentConnectSnapshot): void {
  const hidden = new Set(snapshot.hidden ?? []);
  const rows = arranged(snapshot).map((entry) => rowOf(entry, hidden));
  const nameWidth = Math.max(...rows.map((row) => row.name.length), 0);
  const valueWidth = Math.max(...rows.map((row) => row.values.length), 0);
  for (const row of rows) {
    const name = row.name.padEnd(nameWidth);
    const values = row.values.padEnd(valueWidth);
    process.stdout.write(
      `  ${row.dim ? chalk.dim(name) : chalk.bold(name)}  ${values}  ${chalk.dim(row.path)}\n`,
    );
  }
}

export function createAgentsCommand(): Command {
  return new Command("agents")
    .description("List every agent Neox supports, or one with its model and config file")
    .argument("[args...]")
    .allowUnknownOption(true)
    .helpOption(false)
    .action(async (args: string[] | undefined, _options: unknown, command: Command) => {
      const values = args ?? [];
      if (values.length === 1 && ["-h", "--help", "help"].includes(values[0]!)) {
        process.stdout.write(`${command.helpInformation()}\n`);
        return;
      }
      if (values.length > 1) {
        throw new Error("usage: neox agents [<agent>]");
      }
      const options = command.optsWithGlobals() as AgentCliOptions;
      await withAgentConnect(options, async (client) => {
        const { snapshot } = await client.getAgentConnect();
        if (values.length === 0) {
          printAgents(snapshot);
          return;
        }
        const entry = findAgentEntry(snapshot, values[0]!);
        if (entry === undefined) {
          throw new Error(`no agent "${values[0]}" on this host`);
        }
        printAgents({ ...snapshot, entries: [entry], order: [], hidden: [] });
      });
    });
}
