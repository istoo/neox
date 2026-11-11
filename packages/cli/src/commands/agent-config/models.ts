import chalk from "chalk";
import { Command } from "commander";
import { withGatewayStore } from "../provider/gateway-store.js";
import type { GatewayConfig } from "@neolix/server/gateway-config";
import { catalogRows, notServed, type CatalogRow, type NotServed } from "./catalog-rows.js";
import { modelsNamed } from "./visible.js";
import type { AgentConnectEntry } from "@neolix/protocol/agent-connect";
import { agentLabel, requireAgentEntry, withAgentConnect, type AgentCliOptions } from "./shared.js";

/**
 * `neolix models [<agent>]` — myna's `myna models` (internal/cli/providers_cli.go):
 * the catalog every agent picks from, or the one agent is shown and what is
 * kept from it, with the reason. Read from this computer's gateway.json, so
 * no daemon is needed; the agent's own list is the daemon's.
 */

const modelsUsage = `usage:
  neox models                 every model agents can pick, as provider/model
  neox models <agent>         the models one agent is shown, and why others aren't

  The catalog is every provider's served models and the routing groups. An agent's
  list is the one Neox writes into its config; a model kept from it still answers
  when the agent asks for it by name.`;

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function printRows(rows: readonly CatalogRow[]): void {
  const width = rows.reduce((widest, row) => Math.max(widest, row.id.length), 0);
  let last = "";
  for (const row of rows) {
    if (row.groupKey !== last) {
      last = row.groupKey;
      say(chalk.gray(`  ${row.heading}`));
    }
    let line = `  ${pad(row.id, width)}`;
    if (row.name !== undefined) {
      line += `  ${chalk.gray(row.name)}`;
    }
    if (row.efforts.length > 0) {
      line += chalk.gray(`  ${row.efforts.join("/")}`);
    }
    say(line);
  }
}

function printNotServed(reasons: readonly NotServed[]): void {
  for (const reason of reasons) {
    if (reason.ids.length === 0) continue;
    const shown = reason.ids.slice(0, 6);
    const more = reason.ids.length > shown.length ? ` +${reason.ids.length - shown.length}` : "";
    say(chalk.gray(`  ${reason.why}: `) + chalk.gray(shown.join(", ") + more));
  }
}

/**
 * What is kept from an agent's own list, and why (myna's explainHidden): what
 * the user took out on the Agents page, and the one-picked switch when it is
 * on. The visible names are page-infra's storage, added here when it lands.
 */
function explainHidden(entry: AgentConnectEntry): void {
  const label = agentLabel(entry);
  if (entry.models === undefined) {
    say(chalk.gray(`  Neox does not write ${label}'s model list`));
    return;
  }
  const hidden = entry.models.hidden;
  if (hidden.length > 0) {
    say(chalk.gray(`  ${hidden.length} taken out of ${label}'s list on the Agents page`));
  }
}

/**
 * How many of the catalog's rows the agent's visible names keep away from it
 * (myna's VisibleTo): none when it names no family, provider or group.
 */
function keptByVisible(
  config: GatewayConfig,
  agentId: string,
  rows: readonly CatalogRow[],
): number {
  const names = config.visible[agentId.toLowerCase()] ?? [];
  if (names.length === 0) {
    return 0;
  }
  const named = modelsNamed(config, names);
  if ("unknown" in named) {
    return 0;
  }
  const allowed = new Set(named.ids);
  return rows.filter((row) => {
    if (allowed.has(row.id)) return false;
    if (!row.id.startsWith("group/")) return true;
    const group = config.groups.find((entry) => `group/${entry.id}` === row.id);
    return !(group?.members ?? []).some((member) => allowed.has(member.split(":")[0] ?? ""));
  }).length;
}

export async function runModels(args: readonly string[], options: AgentCliOptions): Promise<void> {
  if (args.includes("-h") || args.includes("--help") || args[0] === "help") {
    say(modelsUsage);
    return;
  }
  const config = await withGatewayStore({ home: options.home }, async (store) => store.get());
  const rows = catalogRows(config);
  const excluded = notServed(config);
  if (rows.length === 0) {
    say(chalk.gray("no models yet · add a provider first: neox provider add deepseek <key>"));
  }
  if (args.length === 0) {
    printRows(rows);
    printNotServed(excluded);
    return;
  }
  const id = args[0]!;
  await withAgentConnect(options, async (client) => {
    const { snapshot } = await client.getAgentConnect();
    const entry = requireAgentEntry(snapshot, id);
    if (entry.models === undefined) {
      printRows(rows);
      explainHidden(entry);
      return;
    }
    const hidden = new Set(entry.models.hidden);
    const shown = rows.filter((row) => !hidden.has(row.id));
    if (shown.length === 0) {
      say(`${chalk.yellow("!")} ${agentLabel(entry)} is shown none of them`);
    } else {
      printRows(shown);
    }
    explainHidden(entry);
    // the visible names narrow the agent's catalog before anything is taken
    // out one model at a time (myna's VisibleTo)
    const keptOut = keptByVisible(config, entry.provider, rows);
    if (keptOut > 0) {
      say(
        chalk.gray(
          `  ${keptOut} kept from ${agentLabel(entry)}, in none of its families, providers or groups`,
        ),
      );
    }
    printNotServed(excluded);
  });
}

export function createModelsCommand(): Command {
  return new Command("models")
    .description("Every model agents can pick, or one agent's and why others aren't")
    .argument("[args...]")
    .allowUnknownOption(true)
    .helpOption(false)
    .action(async (args: string[] | undefined, _options: unknown, command: Command) => {
      await runModels(args ?? [], command.optsWithGlobals() as AgentCliOptions);
    });
}
