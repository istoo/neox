import chalk from "chalk";
import { Command } from "commander";
import type { AgentConnectEntry } from "@neolix/protocol/agent-connect";
import {
  AGENT_ALIASES,
  AGENT_COMMAND_IDS,
  agentHelpText,
  agentLabel,
  checkedSnapshot,
  fieldDefinitions,
  fieldsOf,
  flagArgument,
  requireAgentEntry,
  staticAgentLabel,
  tilde,
  withAgentConnect,
  type AgentCliOptions,
} from "./shared.js";

/**
 * `neolix <agent> [model] / <model> default / <agent> default` — myna's agent
 * forms (internal/cli/main.go:58-63, 160-165). Neolix's one field on an agent
 * is the gateway model it starts on: setting it connects the agent, and
 * `default` is Disconnect, which puts back what it had before.
 */

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function showAgent(entry: AgentConnectEntry): void {
  const value = entry.connected ? (entry.model ?? "—") : "—";
  say(`  ${chalk.bold(agentLabel(entry))}  ${value}  ${chalk.dim(tilde(entry.configPath))}`);
}

function showModel(entry: AgentConnectEntry): void {
  say(
    `${chalk.bold(agentLabel(entry))} ${chalk.gray("model")} ${entry.model ?? chalk.gray("default")}`,
  );
}

/** One of the agent's own fields, as its config reads now. */
function showField(entry: AgentConnectEntry, key: string): boolean {
  const setting = entry.settings?.find((item) => item.key === key);
  if (setting === undefined) return false;
  const value = setting.value === "" ? chalk.gray("default") : setting.value;
  say(`${chalk.bold(agentLabel(entry))} ${chalk.gray(setting.label)} ${value}`);
  return true;
}

async function setModel(options: AgentCliOptions, id: string, value: string): Promise<void> {
  await withAgentConnect(options, async (client) => {
    const before = (await client.getAgentConnect()).snapshot;
    const entry = requireAgentEntry(before, id);
    const result = await client.setAgentConnect({
      provider: entry.provider,
      connected: true,
      model: value,
    });
    const after = checkedSnapshot(result.snapshot);
    const now = requireAgentEntry(after, id).model;
    const shown = now ?? chalk.gray("default");
    const unchanged = now === entry.model ? ` ${chalk.gray("(unchanged)")}` : "";
    say(`✓ ${chalk.bold(agentLabel(entry))} ${chalk.gray("model")} ${shown}${unchanged}`);
  });
}

async function disconnect(options: AgentCliOptions, id: string): Promise<void> {
  await withAgentConnect(options, async (client) => {
    const before = (await client.getAgentConnect()).snapshot;
    const entry = requireAgentEntry(before, id);
    if (!entry.connected) {
      say(
        `✓ ${chalk.bold(agentLabel(entry))} ${chalk.gray("model")} ${chalk.gray("default")} ${chalk.gray("(unchanged)")}`,
      );
      return;
    }
    const result = await client.setAgentConnect({ provider: entry.provider, connected: false });
    checkedSnapshot(result.snapshot);
    say(`✓ ${chalk.bold(agentLabel(entry))} ${chalk.gray("default")}`);
    say(chalk.gray("  disconnected from Neox, back to what it had before"));
  });
}

function unknownField(label: string, field: string, keys: readonly string[]): Error {
  return new Error(`${label} has no field "${field}" (fields: ${keys.join(", ")})`);
}

/** Writes one of the agent's own fields into its config (myna's `<agent> <field> <value>`). */
async function setField(
  options: AgentCliOptions,
  id: string,
  field: string,
  value: string,
): Promise<void> {
  await withAgentConnect(options, async (client) => {
    const before = (await client.getAgentConnect()).snapshot;
    const entry = requireAgentEntry(before, id);
    const fields = fieldDefinitions(id, entry.settings);
    const known = fields.find((item) => item.key === field);
    if (known === undefined) {
      throw unknownField(
        agentLabel(entry),
        field,
        fields.map((item) => item.key),
      );
    }
    const was = entry.settings?.find((item) => item.key === field)?.value;
    const result = await client.setAgentConnect({
      provider: entry.provider,
      connected: entry.connected,
      field,
      value,
    });
    const after = checkedSnapshot(result.snapshot);
    const now = requireAgentEntry(after, id).settings?.find((item) => item.key === field);
    const shown = now === undefined || now.value === "" ? chalk.gray("default") : now.value;
    const unchanged = (was ?? "") === (now?.value ?? "") ? ` ${chalk.gray("(unchanged)")}` : "";
    say(`✓ ${chalk.bold(agentLabel(entry))} ${chalk.gray(known.label)} ${shown}${unchanged}`);
  });
}

async function runAgentForm(
  id: string,
  args: readonly string[],
  options: AgentCliOptions,
): Promise<void> {
  const asked = args.includes("-h") || args.includes("--help") || args[0] === "help";
  if (asked) {
    say(agentHelpText(id, staticAgentLabel(id)));
    return;
  }
  const flag = flagArgument(args);
  if (flag !== null) {
    throw new Error(
      `unknown flag ${flag}: nothing was changed\n\n${agentHelpText(id, staticAgentLabel(id))}`,
    );
  }
  if (args.length === 0) {
    await withAgentConnect(options, async (client) => {
      const { snapshot } = await client.getAgentConnect();
      showAgent(requireAgentEntry(snapshot, id));
    });
    return;
  }
  const [first] = args;
  const fields = fieldsOf(id);
  const isField = (name: string) => fields.some((item) => item.key === name);
  if (args.length === 1) {
    if (first!.toLowerCase() === "default") {
      await disconnect(options, id);
      return;
    }
    if (isField(first!)) {
      await withAgentConnect(options, async (client) => {
        const { snapshot } = await client.getAgentConnect();
        const entry = requireAgentEntry(snapshot, id);
        if (!showField(entry, first!)) showModel(entry);
      });
      return;
    }
    await setModel(options, id, first!);
    return;
  }
  if (args.length > 2) {
    throw new Error(`too many arguments\n\n${agentHelpText(id, staticAgentLabel(id))}`);
  }
  const field = first!;
  const value = args[1]!;
  if (!isField(field)) {
    throw unknownField(
      staticAgentLabel(id),
      field,
      fields.map((item) => item.key),
    );
  }
  if (field === "model") {
    if (value.toLowerCase() === "default") {
      await disconnect(options, id);
      return;
    }
    await setModel(options, id, value);
    return;
  }
  await setField(options, id, field, value.toLowerCase() === "default" ? "" : value);
}

export function createAgentCommands(): Command[] {
  return AGENT_COMMAND_IDS.map((id) => {
    const alias = Object.entries(AGENT_ALIASES).find(([, target]) => target === id)?.[0];
    const command = new Command(id)
      .description(`Show or set ${staticAgentLabel(id)}'s fields, as myna's ${id}`)
      .argument("[args...]")
      .allowUnknownOption(true)
      .helpOption(false)
      .action(async (args: string[] | undefined, _options: unknown, owner: Command) => {
        const merged = owner.optsWithGlobals() as AgentCliOptions;
        await runAgentForm(id, args ?? [], merged);
      });
    return alias === undefined ? command : command.alias(alias);
  });
}
