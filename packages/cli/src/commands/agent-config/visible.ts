import chalk from "chalk";
import { Command } from "commander";
import type { GatewayConfig, GatewayProvider } from "@neolix/server/gateway-config";
import { setOnlyPicked, setVisibleNames } from "@neolix/server/gateway-visibility";
import { withGatewayStore } from "../provider/gateway-store.js";
import { catalogRows } from "./catalog-rows.js";
import {
  AGENT_COMMAND_IDS,
  canonicalAgentId,
  staticAgentLabel,
  type AgentCliOptions,
} from "./shared.js";

/**
 * `neolix visible` — myna's `myna visible` (internal/cli/visible_cli.go): which
 * models each agent is shown. Neolix's agents that keep a model list of their
 * own (Codex) narrow it by provider, group or family; `all` gives every model
 * back. The records live in gateway.json at the root (`visible`,
 * `hiddenModels`, `pickedModels`), where the gateway and the Agents page
 * read them too.
 */

const visibleUsage = `usage:
  neox visible                          which models each agent is shown
  neox visible <agent>                  the models one agent is shown
  neox visible <agent> <name>[,<name>…] show the agent only these: families (a tag set with
                                          neox provider set <id> family=relay, or neox group set),
                                          provider ids and group ids
  neox visible <agent> all              show the agent every model again, the ones taken out of
                                          its list one by one too
  neox visible <agent> --only-picked    show the agent only the models ticked for it now; a model
                                          that comes later, of any provider, stays off until it is
                                          ticked in its list on the Agents page
  neox visible <agent> --show-new       show it the models that come later again (the default)

  An agent not narrowed is shown every model. --only-picked and --show-new keep the models
  shown as they are, and keep the providers, families and groups the agent is narrowed to.`;

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** The model ids a provider serves, honouring its modelMode (myna's picks). */
function providerModelIds(provider: GatewayProvider): string[] {
  if (provider.enabled === false || provider.exposeModels === false) return [];
  const mode = provider.modelMode ?? "list";
  if (mode === "none") return [];
  return provider.models
    .filter((model) => mode !== "picked" || model.picked === true)
    .map((model) => `${provider.id}/${model.id}`);
}

export function servedModelIds(config: GatewayConfig): string[] {
  return config.providers.flatMap((provider) => providerModelIds(provider));
}

/** The model ids under a group's members, `:effort` and nested groups aside. */
function groupModelIds(config: GatewayConfig): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const group of config.groups) {
    const ids = group.members
      .map((member) => member.split(":")[0] ?? "")
      .filter((member) => member !== "" && !member.startsWith("group/"));
    out.set(group.id, ids);
  }
  return out;
}

/** myna's families: the provider and group tags a visibility can name. */
export function familiesOf(config: GatewayConfig): string[] {
  const families = [
    ...config.providers.map((provider) => provider.family),
    ...config.groups.map((group) => group.family),
  ].filter((family): family is string => family !== undefined && family.trim() !== "");
  return [...new Set(families)];
}

/** Every name a visibility can hold: families, provider ids and group ids. */
export function visibleNameMap(config: GatewayConfig): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  const add = (name: string | undefined, ids: readonly string[]) => {
    const key = (name ?? "").trim().toLowerCase();
    if (key === "") return;
    const held = out.get(key) ?? new Set<string>();
    for (const id of ids) held.add(id);
    out.set(key, held);
  };
  const groups = groupModelIds(config);
  for (const provider of config.providers) {
    const ids = providerModelIds(provider);
    add(provider.id, ids);
    add(provider.family, ids);
  }
  for (const group of config.groups) {
    const ids = groups.get(group.id) ?? [];
    add(group.id, ids);
    add(group.family, ids);
  }
  return new Map([...out].map(([name, ids]) => [name, [...ids]]));
}

/**
 * The models the names cover, or null when one names no family, provider or
 * group (myna's refusal, with its hint).
 */
export function modelsNamed(
  config: GatewayConfig,
  names: readonly string[],
): { ids: string[] } | { unknown: string } {
  const map = visibleNameMap(config);
  const ids = new Set<string>();
  for (const name of names) {
    const clean = name.trim().replace(/^group\//i, "");
    const held = map.get(clean.toLowerCase());
    if (held === undefined) return { unknown: clean };
    for (const id of held) ids.add(id);
  }
  return { ids: [...ids] };
}

function orNone(values: readonly string[]): string {
  return values.length === 0 ? "none yet" : values.join(", ");
}

function unknownName(config: GatewayConfig, name: string): Error {
  return new Error(
    `${name} is no family, provider or group (families: ${orNone(familiesOf(config))}; neox provider set <id> family=${name} makes one)`,
  );
}

function shownLine(shown: number, hidden: number, label: string): string {
  return `  ${chalk.bold(label)}  ${shown} shown, ${hidden} not`;
}

/** The catalog row ids kept by the agent's visibility, picks and hidden models. */
export function modelsShown(
  config: GatewayConfig,
  id: string,
): { listed: number; shown: number; hidden: string[] } {
  const all = catalogRows(config).map((row) => row.id);
  const key = canonicalAgentId(id).toLowerCase();
  const names = config.visible?.[key];
  const picked = config.pickedModels?.[key];
  const hidden = new Set(config.hiddenModels?.[key] ?? []);
  const named = rowNameIds(config);
  const listed =
    names === undefined
      ? all
      : all.filter((row) =>
          names.some((name) => named.get(name.trim().toLowerCase())?.has(row) === true),
        );
  const shown =
    picked !== undefined
      ? listed.filter((row) => picked.includes(row))
      : listed.filter((row) => !hidden.has(row));
  const shownSet = new Set(shown);
  return {
    listed: listed.length,
    shown: shown.length,
    hidden: all.filter((row) => !shownSet.has(row)),
  };
}

/** Each visibility name → the catalog ids it names (a group by its own entry). */
function rowNameIds(config: GatewayConfig): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (name: string | undefined, id: string) => {
    const key = (name ?? "").trim().toLowerCase();
    if (key === "") return;
    const held = out.get(key) ?? new Set<string>();
    held.add(id);
    out.set(key, held);
  };
  for (const provider of config.providers) {
    if (provider.enabled === false || provider.exposeModels === false) continue;
    for (const model of provider.models) {
      if ((provider.modelMode ?? "list") === "none") continue;
      if ((provider.modelMode ?? "list") === "picked" && model.picked !== true) continue;
      const id = `${provider.id}/${model.id}`;
      add(provider.id, id);
      add(provider.family, id);
    }
  }
  for (const group of config.groups) {
    if (group.disabled === true) continue;
    const id = `group/${group.id}`;
    add(group.id, id);
    add(id, id);
    add(group.family, id);
  }
  return out;
}

/** An agent's name without asking the daemon, and its error for an unknown one. */
function localAgentLabel(id: string): string {
  const canonical = canonicalAgentId(id);
  if (!AGENT_COMMAND_IDS.includes(canonical as (typeof AGENT_COMMAND_IDS)[number])) {
    throw new Error(`no agent "${id}" (neox agents lists them)`);
  }
  return staticAgentLabel(canonical);
}

function printOne(config: GatewayConfig, id: string): void {
  const view = modelsShown(config, id);
  const key = canonicalAgentId(id).toLowerCase();
  const says = config.pickedModels?.[key] === undefined ? "" : " · only models picked";
  say(shownLine(view.shown, view.hidden.length, `${localAgentLabel(id)}${says}`));
  if (view.hidden.length > 0) {
    say(chalk.gray(`    not shown: ${view.hidden.join(", ")}`));
  }
}

async function printAll(options: AgentCliOptions): Promise<void> {
  await withGatewayStore({ home: options.home }, async (store) => {
    const config = store.get();
    const ids = [
      ...new Set([
        ...Object.keys(config.visible ?? {}),
        ...Object.keys(config.hiddenModels ?? {}),
        ...Object.keys(config.pickedModels ?? {}),
      ]),
    ].sort();
    if (ids.length === 0) {
      say(
        chalk.gray(
          "  every agent is shown every model · neox visible <agent> <family>,… narrows one",
        ),
      );
    }
    for (const id of ids) {
      const view = modelsShown(config, id);
      const says: string[] = [];
      const names = config.visible?.[id];
      if (names !== undefined) says.push(names.join(", "));
      if (config.pickedModels?.[id] !== undefined) says.push("only models picked");
      const label = says.length === 0 ? id : `${id}  ${chalk.gray(says.join(" · "))}`;
      say(shownLine(view.shown, view.hidden.length, label));
    }
    const families = familiesOf(config);
    if (families.length > 0) {
      say(chalk.gray(`  families: ${families.join(", ")}`));
    }
  });
}

/** Writes the narrowed names, or takes every record out for `all`. */
async function setVisible(
  options: AgentCliOptions,
  id: string,
  names: readonly string[] | null,
): Promise<void> {
  const agent = canonicalAgentId(id).toLowerCase();
  await withGatewayStore({ home: options.home }, async (store) => {
    const config = store.get();
    if (names !== null) {
      const named = modelsNamed(config, names);
      if ("unknown" in named) throw unknownName(config, named.unknown);
    }
    const records = setVisibleNames(config, agent, names);
    await store.write({ ...config, ...records });
  });
}

/** The only-picked switch: the models shown now become the picks, or go back to hidden. */
async function setOnlyPickedState(
  options: AgentCliOptions,
  id: string,
  on: boolean,
): Promise<void> {
  const agent = canonicalAgentId(id).toLowerCase();
  await withGatewayStore({ home: options.home }, async (store) => {
    const config = store.get();
    const records = setOnlyPicked(config, agent, on);
    await store.write({ ...config, ...records });
  });
}

export async function runVisible(args: readonly string[], options: AgentCliOptions): Promise<void> {
  const asked = args.includes("-h") || args.includes("--help") || args[0] === "help";
  if (asked) {
    say(visibleUsage);
    return;
  }
  if (args.length === 0) {
    await printAll(options);
    return;
  }
  const id = args[0]!;
  localAgentLabel(id);
  if (args.length === 1) {
    await withGatewayStore({ home: options.home }, async (store) => printOne(store.get(), id));
    return;
  }
  if (args[1] === "--only-picked" || args[1] === "--show-new") {
    await setOnlyPickedState(options, id, args[1] === "--only-picked");
    say("✓ saved");
    await withGatewayStore({ home: options.home }, async (store) => printOne(store.get(), id));
    return;
  }
  const names = args
    .slice(1)
    .join(",")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (names.length === 0) {
    throw new Error(`usage:\n${visibleUsage}`);
  }
  const all = names.length === 1 && names[0]!.toLowerCase() === "all";
  await setVisible(options, id, all ? null : names);
  say("✓ saved");
  await withGatewayStore({ home: options.home }, async (store) => printOne(store.get(), id));
}

export function createVisibleCommand(): Command {
  return new Command("visible")
    .description("Which models each agent is shown")
    .argument("[args...]")
    .allowUnknownOption(true)
    .helpOption(false)
    .action(async (args: string[] | undefined, _options: unknown, command: Command) => {
      await runVisible(args ?? [], command.optsWithGlobals() as AgentCliOptions);
    });
}
