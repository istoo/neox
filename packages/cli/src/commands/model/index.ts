import chalk from "chalk";
import { Command } from "commander";
import type { Logger } from "pino";
import { resolveNeolixHome } from "@neolix/server/daemon-control";
import {
  GatewayConfigStore,
  type GatewayConfig,
  type GatewayModel,
} from "@neolix/server/gateway-config";
import {
  addDaemonHostOption,
  addJsonOption,
  localDaemonHome,
} from "../../utils/command-options.js";

/**
 * `neolix model` — myna's `myna model` (internal/cli/model_cli.go), over this
 * computer's gateway.json. The daemon watches the file, so no daemon is
 * needed. The wording and usage strings are myna's, with neolix as the
 * command.
 */

type ModelEntry = GatewayModel;

const modelUsage = `usage:
  neox model name <provider/model>             the name the model goes by
  neox model name <provider/model> <name>      name it so everywhere: in Neox, in the gateway's
                                               model list, and in the lists Neox writes into the agents
  neox model name <provider/model> --reset     give it back its own name
  neox model price <provider/model>            what the model costs you, and what you said it costs
  neox model price <provider/model> <in>,<out>,<cache read>,<cache write>
                                               say what it costs, in USD per million tokens, all four parts as
                                               0.12,1.20,0.01,0.15; 0 is a model served for nothing, which is
                                               a price, not the absence of one; a fifth part is a 1-hour cache
                                               write's (not given: a Claude model's is 2× input, any other's the 4th)
  neox model price <provider/model> <in>,<out>,<cache read>,<cache write> --tier 272k <in>,<out>,<cr>,<cw>
                                               and what a request whose input, cached tokens included, is over
                                               272K costs, the whole request; --tier may be given again
  neox model price <provider/model> --reset    take your price off this model
  neox model price <model> <in>,<out>,<cache read>,<cache write>
                                               what the model costs from any provider you have not priced it
                                               for, kept as '*/<model>': for usage whose provider is gone, or
                                               a model models.dev doesn't price, e.g. gemini-3-pro-preview
  neox model prices                            the models you priced
  neox model context <provider/model>          how long a request it takes, and what you said it takes
  neox model context <provider/model> <n>      say how long, as 200000 or 1m; '<provider>/*' is every model
  neox model context <provider/model> --reset  take your limit off this model
  neox model output <provider/model>           the most a reply of it may hold, and what you said
  neox model output <provider/model> <n>       say the most, as 128000 or 128k; '<provider>/*' is every model
  neox model output <provider/model> --reset   take your limit off this model
  neox model spec <provider/model>             its context window, max output and vision
  neox model spec <provider/model> [--context <n>] [--output <n>] [--vision on|off]
                                               say any of them at once; auto as a value goes back to what
                                               the vendor says
  neox model spec <provider/model> --reset     take every value you set off this model
  neox model specs                             the models you gave a spec
  neox model names                             the models you named
  neox model suffix [on|own|off]               whether the agents' lists name each model with its provider
                                               (or "routing group") after it: on, as by default, "Sol · OpenAI";
                                               own, a name you gave a model just as you wrote it, "Opus 5.5",
                                               the others as on; off, "Sol" alone — but two a list would name
                                               the same keep it
  neox model compact [on|off|<size>]           whether Codex, Claude Code and Grok Build compact a long
                                               conversation at 272K: on, as by default, for a model of a
                                               longer window (in Claude Code, a Claude model runs to its
                                               own); off, at the model's whole window, 1M for a [1m] one; a
                                               size such as 500k compacts there instead

  e.g. neox model name claude/claude-opus-5-5 "Opus 5.5"
       neox model price relay-a/gpt-5.5 0.12,0.60,0.01,0.15
       neox model context relay-a/claude-opus-5-5 1m`;

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
} as unknown as Logger;

/** --home as the command that is running chose it; undefined falls back to NEOLIX_HOME. */
let selectedHome: string | undefined;

async function withStore<T>(work: (store: GatewayConfigStore) => Promise<T>): Promise<T> {
  const neolixHome = resolveNeolixHome({ NEOLIX_HOME: selectedHome ?? process.env.NEOLIX_HOME });
  const store = new GatewayConfigStore({ neolixHome, logger: silentLogger });
  await store.start();
  try {
    return await work(store);
  } finally {
    store.dispose();
  }
}

interface ModelRef {
  providerId: string;
  /** The model id as typed; "*" is every model of the provider. */
  modelId: string;
  /** The provider/model key. */
  key: string;
}

/** "provider/model" as the id before the slash and the model after it. */
export function splitModelRef(value: string): ModelRef {
  const ref = value.trim().replace(/^neolix\//, "");
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(
      `name a model as provider/model, not ${JSON.stringify(value)} (neox provider ls lists them)`,
    );
  }
  return {
    providerId: ref.slice(0, slash),
    modelId: ref.slice(slash + 1),
    key: ref,
  };
}

function isReset(args: readonly string[]): boolean {
  return (
    args.length === 1 && ["--reset", "-r", "--default", "default", "reset"].includes(args[0] ?? "")
  );
}

/** myna's ParseTokens: 200000, 200k, 1m. */
export function parseTokens(value: string): number {
  const text = value.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)([km])?$/.exec(text);
  if (match === null) {
    throw new Error(
      `a size is a number of tokens, like 200000 or 1m, not ${JSON.stringify(value)}`,
    );
  }
  const amount = Number(match[1]);
  const units: Record<string, number> = { "": 1, k: 1_000, m: 1_000_000 };
  return Math.round(amount * (units[match[2] ?? ""] ?? 1));
}

/** myna's tokenCount: 1M, 128k, 1234. */
export function tokenCount(n: number | undefined): string {
  if (n === undefined || n <= 0) {
    return "unknown";
  }
  if (n % 1_000_000 === 0) {
    return `${n / 1_000_000}M`;
  }
  if (n % 1_000 === 0) {
    return `${n / 1_000}k`;
  }
  return String(n);
}

function visionWord(images: boolean | undefined): string {
  if (images === true) return "on";
  if (images === false) return "off";
  return "unknown";
}

function perMillion(price: GatewayPrice): string {
  return `${money(price.inputPerMTok ?? 0)}/${money(price.outputPerMTok ?? 0)} per 1M in/out`;
}

function money(value: number): string {
  return `$${Number(value.toPrecision(4))}`;
}

interface GatewayPrice {
  inputPerMTok?: number;
  outputPerMTok?: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
  cacheWrite1hPerMTok?: number;
  tiers?: Array<{
    aboveTokens: number;
    inputPerMTok: number;
    outputPerMTok: number;
    cacheReadPerMTok?: number;
    cacheWritePerMTok?: number;
  }>;
}

type Pricing = Record<string, GatewayPrice>;

function providerOf(config: GatewayConfig, providerId: string) {
  return (config.providers ?? []).find((provider) => provider.id === providerId);
}

function modelOf(provider: { models: ModelEntry[] }, modelId: string): ModelEntry | undefined {
  return provider.models.find((model) => model.id === modelId);
}

function findModel(config: GatewayConfig, ref: ModelRef): ModelEntry | undefined {
  const provider = providerOf(config, ref.providerId);
  if (provider === undefined || ref.modelId === "*") {
    return undefined;
  }
  return modelOf(provider as { models: ModelEntry[] }, ref.modelId);
}

function editModel(
  store: GatewayConfigStore,
  ref: ModelRef,
  mutate: (model: ModelEntry) => void,
): Promise<GatewayConfig> {
  const config = store.get();
  const provider = providerOf(config, ref.providerId);
  if (provider === undefined) {
    throw new Error(`no provider ${ref.providerId}`);
  }
  const model = modelOf(provider as { models: ModelEntry[] }, ref.modelId);
  if (model === undefined) {
    throw new Error(`${ref.key} is not a model this provider serves`);
  }
  mutate(model);
  return store.write(config);
}

async function modelName(args: string[]): Promise<void> {
  if (args.length === 0) {
    throw new Error(modelUsage);
  }
  const ref = splitModelRef(args[0]!);
  const rest = args.slice(1);
  const config = await withStore(async (store) => store.get());
  const model = findModel(config, ref);
  const own = model?.label ?? ref.modelId;
  if (rest.length === 0) {
    console.log(chalk.bold(own), chalk.gray(`· ${ref.key} · its own name`));
    return;
  }
  const name = isReset(rest) ? "" : rest.join(" ").trim().replace(/\s+/g, " ");
  await withStore((store) =>
    editModel(store, ref, (entry) => {
      if (name === "") {
        delete entry.label;
      } else {
        entry.label = name;
      }
    }),
  );
  console.log(
    chalk.green("✓"),
    ref.key,
    chalk.gray("is called"),
    chalk.bold(name === "" ? own : name),
    name === "" ? chalk.gray("again") : "",
  );
}

async function modelNames(): Promise<void> {
  const config = await withStore(async (store) => store.get());
  const rows: string[] = [];
  for (const provider of config.providers ?? []) {
    for (const model of provider.models as ModelEntry[]) {
      if (model.label !== undefined && model.label !== "") {
        rows.push(`  ${`${provider.id}/${model.id}`.padEnd(40)}  ${model.label}`);
      }
    }
  }
  if (rows.length === 0) {
    console.log(chalk.gray("no model is named yet · neox model name <provider/model> <name>"));
    return;
  }
  for (const row of rows.sort()) {
    console.log(row);
  }
}

function priceAt(
  config: GatewayConfig,
  ref: ModelRef,
): { key: string; price: GatewayPrice } | null {
  const pricing = (config.pricing ?? {}) as Pricing;
  for (const key of [ref.key, `${ref.providerId}/*`, `*/${ref.modelId}`]) {
    const price = pricing[key];
    if (price !== undefined) {
      return { key, price };
    }
  }
  return null;
}

async function modelPrice(args: string[]): Promise<void> {
  if (args.length === 0) {
    throw new Error(modelUsage);
  }
  const ref = splitModelRef(args[0]!);
  const rest = args.slice(1);
  if (isReset(rest)) {
    await withStore(async (store) => {
      const config = store.get();
      const pricing = { ...((config.pricing ?? {}) as Pricing) };
      delete pricing[ref.key];
      await store.write({ ...config, pricing });
    });
    console.log(chalk.green("✓"), ref.key, chalk.gray("is priced by its provider again"));
    return;
  }
  const config = await withStore(async (store) => store.get());
  if (rest.length === 0) {
    const found = priceAt(config, ref);
    if (found === null) {
      console.log(chalk.gray(ref.key), chalk.gray("· no price is known for it"));
      console.log(
        chalk.gray(
          `  · neox model price ${ref.key} <in>,<out>,<cache read>,<cache write> sets it, in USD per 1M tokens`,
        ),
      );
      return;
    }
    console.log(chalk.bold(perMillion(found.price)), chalk.gray(`· ${ref.key}`));
    for (const line of priceDetail(found.price)) {
      console.log(chalk.gray(line));
    }
    return;
  }
  const price = parsePrice(rest);
  await withStore((store) => {
    const current = store.get();
    return store.write({
      ...current,
      pricing: { ...((current.pricing ?? {}) as Pricing), [ref.key]: price },
    });
  });
  console.log(chalk.green("✓"), ref.key, chalk.gray("costs"), chalk.bold(perMillion(price)));
  for (const tier of price.tiers ?? []) {
    console.log(
      chalk.gray(
        `  · and ${money(tier.inputPerMTok)}/${money(tier.outputPerMTok)} in/out the whole request over ${tokenSize(tier.aboveTokens)} input tokens`,
      ),
    );
  }
}

export function parsePrice(rest: readonly string[]): GatewayPrice {
  const parts = (rest[0] ?? "").split(",").map((part) => Number(part.trim()));
  if (parts.length < 4 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    throw new Error(
      `a price is four parts, in,out,cache read,cache write, as 0.12,1.20,0.01,0.15, not ${JSON.stringify(rest[0])}`,
    );
  }
  const price: GatewayPrice = {
    inputPerMTok: parts[0]!,
    outputPerMTok: parts[1]!,
    cacheReadPerMTok: parts[2]!,
    cacheWritePerMTok: parts[3]!,
    ...(parts[4] === undefined ? {} : { cacheWrite1hPerMTok: parts[4] }),
  };
  const tiers: NonNullable<GatewayPrice["tiers"]> = [];
  for (let at = 1; at < rest.length; at += 3) {
    if (rest[at] !== "--tier" || at + 2 >= rest.length) {
      throw new Error(`--tier takes a size and a price, not ${JSON.stringify(rest[at])}`);
    }
    const aboveTokens = parseTokens(rest[at + 1] ?? "");
    const tierParts = (rest[at + 2] ?? "").split(",").map((part) => Number(part.trim()));
    if (tierParts.length < 4 || tierParts.some((part) => !Number.isFinite(part) || part < 0)) {
      throw new Error("a tier's price is in,out,cache read,cache write, as 0.12,0.60,0.01,0.15");
    }
    tiers.push({
      aboveTokens,
      inputPerMTok: tierParts[0]!,
      outputPerMTok: tierParts[1]!,
      cacheReadPerMTok: tierParts[2]!,
      cacheWritePerMTok: tierParts[3]!,
    });
  }
  if (tiers.length > 0) {
    price.tiers = tiers;
  }
  return price;
}

function priceDetail(price: GatewayPrice): string[] {
  let cache = `  · cache read ${money(price.cacheReadPerMTok ?? 0)}, cache write ${money(price.cacheWritePerMTok ?? 0)}`;
  if ((price.cacheWrite1hPerMTok ?? 0) > 0) {
    cache += ` (5 min), ${money(price.cacheWrite1hPerMTok ?? 0)} (1 hour)`;
  }
  const lines = [cache];
  for (const tier of price.tiers ?? []) {
    lines.push(
      `  · over ${tokenSize(tier.aboveTokens)} input tokens, the whole request: ${money(tier.inputPerMTok)}/${money(tier.outputPerMTok)} in/out, cache ${money(tier.cacheReadPerMTok ?? 0)}/${money(tier.cacheWritePerMTok ?? 0)}`,
    );
  }
  return lines;
}

/** myna's tokenSize: 272K, 1M. */
export function tokenSize(n: number): string {
  if (n >= 1_000_000 && n % 1_000_000 === 0) {
    return `${n / 1_000_000}M`;
  }
  if (n >= 1_000 && n % 1_000 === 0) {
    return `${n / 1_000}K`;
  }
  return String(n);
}

async function modelPrices(json = false): Promise<void> {
  const config = await withStore(async (store) => store.get());
  const pricing = (config.pricing ?? {}) as Pricing;
  const keys = Object.keys(pricing).sort();
  if (json) {
    const sorted: Pricing = {};
    for (const key of keys) sorted[key] = pricing[key]!;
    process.stdout.write(`${JSON.stringify(sorted, null, 2)}\n`);
    return;
  }
  if (keys.length === 0) {
    console.log(chalk.gray("no model is priced by you yet"));
    console.log(
      chalk.gray("neox model price <provider/model> <in>,<out>,<cache read>,<cache write>"),
    );
    return;
  }
  for (const key of keys) {
    const price = pricing[key]!;
    console.log(
      chalk.bold(key),
      chalk.gray(
        `· ${perMillion(price)} · cache ${money(price.cacheReadPerMTok ?? 0)}/${money(price.cacheWritePerMTok ?? 0)}`,
      ),
    );
    for (const tier of price.tiers ?? []) {
      console.log(
        chalk.gray(
          `  · over ${tokenSize(tier.aboveTokens)} input tokens ${money(tier.inputPerMTok)}/${money(tier.outputPerMTok)} in/out · cache ${money(tier.cacheReadPerMTok ?? 0)}/${money(tier.cacheWritePerMTok ?? 0)}`,
        ),
      );
    }
  }
}

async function modelContext(args: string[]): Promise<void> {
  await limitCommand(
    args,
    "context",
    "takes",
    (model) => model.contextWindow,
    (model, value) => {
      if (value === undefined) {
        delete model.contextWindow;
      } else {
        model.contextWindow = value;
      }
    },
  );
}

async function modelOutput(args: string[]): Promise<void> {
  await limitCommand(
    args,
    "output",
    "answers with",
    (model) => model.maxOutputTokens,
    (model, value) => {
      if (value === undefined) {
        delete model.maxOutputTokens;
      } else {
        model.maxOutputTokens = value;
      }
    },
  );
}

async function limitCommand(
  args: string[],
  verb: string,
  says: string,
  read: (model: ModelEntry) => number | undefined,
  write: (model: ModelEntry, value: number | undefined) => void,
): Promise<void> {
  if (args.length === 0) {
    throw new Error(modelUsage);
  }
  const ref = splitModelRef(args[0]!);
  const rest = args.slice(1);
  const config = await withStore(async (store) => store.get());
  const provider = providerOf(config, ref.providerId);
  if (provider === undefined) {
    throw new Error(`no provider ${ref.providerId}`);
  }
  const model = findModel(config, ref);
  if (rest.length === 0) {
    if (ref.modelId === "*") {
      console.log(
        chalk.bold("unknown"),
        chalk.gray(`· ${ref.key} · every model of ${ref.providerId}`),
      );
      return;
    }
    if (model === undefined) {
      console.log(chalk.gray(ref.key), chalk.gray("· is not a model this provider serves"));
      return;
    }
    console.log(chalk.bold(tokenCount(read(model))), chalk.gray(`· ${ref.key}`));
    console.log(chalk.gray(`  · neox model ${verb} ${ref.key} <tokens> to change it`));
    return;
  }
  if (isReset(rest)) {
    await withStore((store) => editModel(store, ref, (entry) => write(entry, undefined)));
    console.log(
      chalk.green("✓"),
      ref.key,
      chalk.gray(
        `has no ${verb} of your own · neox model ${verb} ${ref.key} says what it ${says} now`,
      ),
    );
    return;
  }
  const value = parseTokens(rest[0]!);
  if (value === 0) {
    throw new Error(
      `0 tokens is no ${verb} at all — neox model ${verb} ${ref.key} --reset takes it off`,
    );
  }
  await withStore((store) => editModel(store, ref, (entry) => write(entry, value)));
  console.log(chalk.green("✓"), ref.key, chalk.gray(says), chalk.bold(tokenCount(value)));
}

async function modelSuffix(args: string[]): Promise<void> {
  const config = await withStore(async (store) => store.get());
  if (args.length === 0) {
    const mode = config.modelNames ?? "on";
    if (mode === "off") {
      console.log(
        "off",
        chalk.gray('· agents\' lists name a model alone, "Sol" · neox model suffix on|own'),
      );
    } else if (mode === "own") {
      console.log(
        "own",
        chalk.gray(
          '· a name you gave a model just as you wrote it, "Opus 5.5"; the others "Sol · OpenAI" · neox model suffix on|off',
        ),
      );
    } else {
      console.log(
        "on",
        chalk.gray(
          '· agents\' lists name a model with its provider, "Sol · OpenAI" · neox model suffix own|off',
        ),
      );
    }
    return;
  }
  const asked = args[0]!.toLowerCase();
  let mode: "on" | "own" | "off" | null = null;
  if (["on", "yes", "true"].includes(asked)) mode = "on";
  if (["own", "mine"].includes(asked)) mode = "own";
  if (["off", "no", "false"].includes(asked)) mode = "off";
  if (mode === null) {
    throw new Error(`neox model suffix on|own|off, not ${JSON.stringify(args[0])}`);
  }
  await withStore((store) => store.write({ ...store.get(), modelNames: mode }));
  const said = {
    off: "agents' lists name each model alone",
    own: "agents' lists name a model you named just as you wrote it",
    on: "agents' lists name each model with its provider again",
  }[mode];
  console.log(chalk.green("✓"), said);
}

async function modelCompact(args: string[]): Promise<void> {
  const config = await withStore(async (store) => store.get());
  const at = config.compactAt ?? 0;
  const sizeK = Math.round((at > 0 ? at : 272_000) / 1000);
  if (args.length === 0) {
    if (config.fullContext === true) {
      console.log(
        "off",
        chalk.gray(
          "· Codex, Claude Code and Grok Build run a conversation to the model's whole window · neox model compact on",
        ),
      );
    } else {
      console.log(
        "on",
        chalk.gray(
          `· Codex, Claude Code and Grok Build compact at ${sizeK}K on a longer window; in Claude Code a Claude model runs to its own · neox model compact off`,
        ),
      );
    }
    return;
  }
  const asked = args[0]!.toLowerCase();
  if (["on", "yes", "true"].includes(asked) || ["off", "no", "false", "full"].includes(asked)) {
    const full = asked !== "on" && asked !== "yes" && asked !== "true";
    await withStore((store) => store.write({ ...store.get(), fullContext: full }));
    console.log(
      chalk.green("✓"),
      full
        ? "Codex, Claude Code and Grok Build run a conversation to the model's whole window"
        : `Codex, Claude Code and Grok Build compact at ${sizeK}K again`,
    );
    return;
  }
  const tokens = parseTokens(asked);
  if (tokens <= 0) {
    throw new Error(
      `neox model compact on|off|<size such as 500k>, not ${JSON.stringify(args[0])}`,
    );
  }
  await withStore((store) =>
    store.write({ ...store.get(), compactAt: tokens, fullContext: false }),
  );
  console.log(
    chalk.green("✓"),
    `Codex, Claude Code and Grok Build compact at ${Math.round(tokens / 1000)}K on a longer window`,
  );
}

async function modelSpec(args: string[]): Promise<void> {
  if (args.length === 0) {
    throw new Error(modelUsage);
  }
  const ref = splitModelRef(args[0]!);
  const rest = args.slice(1);
  const config = await withStore(async (store) => store.get());
  const model = findModel(config, ref);
  if (model === undefined) {
    throw new Error(`${ref.key} is not a model this provider serves`);
  }
  if (rest.length === 0) {
    console.log(chalk.bold(ref.key));
    console.log(`  context ${tokenCount(model.contextWindow)}`);
    console.log(`  output ${tokenCount(model.maxOutputTokens)}`);
    console.log(`  vision ${visionWord(model.images)}`);
    return;
  }
  if (isReset(rest)) {
    await withStore((store) =>
      editModel(store, ref, (entry) => {
        delete entry.contextWindow;
        delete entry.maxOutputTokens;
        delete entry.images;
      }),
    );
    console.log(chalk.green("✓"), ref.key, chalk.gray("has no spec of your own"));
    return;
  }
  const patch: { context?: number; output?: number; vision?: boolean } = {};
  for (let at = 0; at < rest.length; at++) {
    const flag = rest[at];
    const value = rest[at + 1];
    if (value === undefined) {
      throw new Error(`${flag} needs a value`);
    }
    if (flag === "--context") {
      patch.context = value === "auto" ? 0 : parseTokens(value);
    } else if (flag === "--output") {
      patch.output = value === "auto" ? 0 : parseTokens(value);
    } else if (flag === "--vision") {
      patch.vision = value !== "off" && value !== "false";
    } else {
      throw new Error(`--context, --output or --vision, not ${JSON.stringify(flag)}`);
    }
    at += 1;
  }
  await withStore((store) =>
    editModel(store, ref, (entry) => {
      if (patch.context !== undefined) {
        if (patch.context === 0) delete entry.contextWindow;
        else entry.contextWindow = patch.context;
      }
      if (patch.output !== undefined) {
        if (patch.output === 0) delete entry.maxOutputTokens;
        else entry.maxOutputTokens = patch.output;
      }
      if (patch.vision !== undefined) {
        entry.images = patch.vision;
      }
    }),
  );
  console.log(chalk.green("✓"), ref.key, chalk.gray("is as you said"));
}

async function modelSpecs(): Promise<void> {
  const config = await withStore(async (store) => store.get());
  const rows: string[] = [];
  for (const provider of config.providers ?? []) {
    for (const model of provider.models as ModelEntry[]) {
      if (
        model.contextWindow === undefined &&
        model.maxOutputTokens === undefined &&
        model.images === undefined
      ) {
        continue;
      }
      rows.push(
        `  ${`${provider.id}/${model.id}`.padEnd(40)}  context ${tokenCount(model.contextWindow)}  output ${tokenCount(model.maxOutputTokens)}  vision ${visionWord(model.images)}`,
      );
    }
  }
  if (rows.length === 0) {
    console.log(chalk.gray("no model has a spec of your own yet"));
    return;
  }
  for (const row of rows.sort()) {
    console.log(row);
  }
}

async function modelEfforts(args: string[]): Promise<void> {
  if (args.length === 0) throw new Error(modelUsage);
  const ref = splitModelRef(args[0]!);
  const rest = args.slice(1);
  const config = await withStore(async (store) => store.get());
  const key = ref.key;
  if (rest.length === 1 && (rest[0] === "off" || rest[0] === "--off")) {
    await withStore((store) =>
      store.write({
        ...store.get(),
        modelReasonless: { ...store.get().modelReasonless, [key]: true },
      }),
    );
    console.log(
      chalk.green("✓"),
      key,
      chalk.gray("is sent no reasoning field"),
      chalk.gray("· --reset offers its levels again"),
    );
    return;
  }
  if (rest.length === 0) {
    if (config.modelReasonless?.[key] === true) {
      console.log(
        chalk.gray(`${key} is sent no reasoning field`),
        chalk.gray("· --reset offers its levels again"),
      );
      return;
    }
    const kept = config.modelEfforts?.[key];
    if (kept === undefined) {
      console.log(chalk.gray(`${key} offers every level it has`));
      return;
    }
    console.log(
      chalk.bold(kept.join(" ")),
      chalk.gray("· only these are offered · --reset offers them all"),
    );
    return;
  }
  const levels = isReset(rest)
    ? []
    : rest.flatMap((value) => value.split(/[,/\s]+/)).filter(Boolean);
  await withStore((store) => {
    const current = store.get();
    const efforts = { ...current.modelEfforts };
    const reasonless = { ...current.modelReasonless };
    delete reasonless[key];
    if (levels.length === 0) delete efforts[key];
    else efforts[key] = levels;
    return store.write({ ...current, modelEfforts: efforts, modelReasonless: reasonless });
  });
  if (levels.length === 0) {
    console.log(chalk.green("✓"), key, chalk.gray("offers every level it has"));
  } else {
    console.log(chalk.green("✓"), key, chalk.gray("offers"), chalk.bold(levels.join(", ")));
  }
}

async function modelWire(args: string[]): Promise<void> {
  if (args.length === 0) throw new Error(modelUsage);
  const ref = splitModelRef(args[0]!);
  const rest = args.slice(1);
  const shown = ref.modelId === "*" ? `'${ref.providerId}/*'` : ref.key;
  const config = await withStore(async (store) => store.get());
  const wires = config.modelWires ?? {};
  if (rest.length === 0) {
    const own = wires[ref.key] ?? wires[`${ref.providerId}/*`];
    const asked = own === undefined ? ref.modelId : own.split("*").join(ref.modelId);
    console.log(
      chalk.bold(asked),
      chalk.gray(`· what ${ref.providerId} is asked for, for ${shown}`),
    );
    if (asked === ref.modelId) {
      console.log(
        chalk.gray(
          `  · the same name Neox knows it by · neox model wire ${shown} <name> to change it`,
        ),
      );
    }
    return;
  }
  if (isReset(rest)) {
    if (ref.modelId !== "*" && wires[ref.key] === undefined) {
      throw new Error(`${ref.key} has no name of its own to take away`);
    }
    await withStore((store) => {
      const current = store.get();
      const next = { ...current.modelWires };
      delete next[ref.modelId === "*" ? `${ref.providerId}/*` : ref.key];
      return store.write({ ...current, modelWires: next });
    });
    console.log(chalk.green("✓"), shown, chalk.gray("no longer has a name of its own"));
    return;
  }
  const name = rest.join(" ").trim();
  if (name === "") throw new Error("a wire name is a name, not nothing");
  await withStore((store) =>
    store.write({
      ...store.get(),
      modelWires: {
        ...store.get().modelWires,
        [ref.modelId === "*" ? `${ref.providerId}/*` : ref.key]: name,
      },
    }),
  );
  console.log(chalk.green("✓"), shown, chalk.gray("is asked for as"), chalk.bold(name));
}

async function modelWires(): Promise<void> {
  const config = await withStore(async (store) => store.get());
  const wires = config.modelWires ?? {};
  const keys = Object.keys(wires)
    .filter((key) => (wires[key] ?? "").trim() !== "")
    .sort();
  if (keys.length === 0) {
    console.log(
      chalk.gray(
        "no vendor is asked for a model by another name yet · neox model wire <provider/model> <name>",
      ),
    );
    return;
  }
  const width = Math.max(...keys.map((key) => key.length));
  for (const key of keys) {
    console.log(`  ${key.padEnd(width)}  → ${wires[key]}`);
  }
}

function listedIdOf(
  config: { modelIDs?: Record<string, string> },
  ref: ModelRef,
): string | undefined {
  for (const [listed, served] of Object.entries(config.modelIDs ?? {})) {
    if (served === ref.modelId && listed.startsWith(`${ref.providerId}/`)) {
      return listed.slice(ref.providerId.length + 1);
    }
  }
  return undefined;
}

async function modelID(args: string[]): Promise<void> {
  if (args.length === 0 || args.length > 2) throw new Error(modelUsage);
  const ref = splitModelRef(args[0]!);
  const config = await withStore(async (store) => store.get());
  const listed = listedIdOf(config, ref);
  if (args.length === 1) {
    if (listed === undefined) {
      console.log(chalk.bold(ref.key), chalk.gray("· listed by its own id"));
    } else {
      console.log(
        chalk.bold(`${ref.providerId}/${listed}`),
        chalk.gray(`· ${ref.providerId} is asked for ${ref.modelId}`),
      );
    }
    return;
  }
  const id = isReset(args.slice(1)) ? "" : args[1]!.trim();
  await withStore((store) => {
    const current = store.get();
    const ids: Record<string, string> = {};
    for (const [key, served] of Object.entries(current.modelIDs ?? {})) {
      if (served !== ref.modelId) ids[key] = served;
    }
    if (id !== "" && id !== ref.modelId) ids[`${ref.providerId}/${id}`] = ref.modelId;
    return store.write({ ...current, modelIDs: ids });
  });
  if (id === "" || id === ref.modelId) {
    console.log(chalk.bold(ref.key), chalk.gray("· listed by its own id again"));
  } else {
    console.log(
      chalk.bold(`${ref.providerId}/${id}`),
      chalk.gray(
        `· listed, routed and counted so; ${ref.providerId} is still asked for ${ref.modelId}`,
      ),
    );
  }
}

async function modelIDs(): Promise<void> {
  const config = await withStore(async (store) => store.get());
  const ids = config.modelIDs ?? {};
  const keys = Object.keys(ids).sort();
  if (keys.length === 0) {
    console.log(
      chalk.gray("no model is listed by an id of yours yet · neox model id <provider/model> <id>"),
    );
    return;
  }
  const width = Math.max(...keys.map((key) => key.length));
  for (const key of keys) {
    console.log(`${key.padEnd(width)}  ${chalk.gray("is asked for as")} ${ids[key]}`);
  }
}

async function modelUsageAlias(args: string[]): Promise<void> {
  if (args.length === 0 || args.length > 2) throw new Error(modelUsage);
  const from = args[0]!.trim();
  const config = await withStore(async (store) => store.get());
  const aliases = config.usageAliases ?? {};
  if (args.length === 1) {
    const to = aliases[from];
    if (to === undefined || to === "") {
      console.log(chalk.bold(from), chalk.gray("· counted under its own id"));
    } else {
      console.log(chalk.bold(from), chalk.gray("· counted as"), to);
    }
    return;
  }
  const to = isReset(args.slice(1)) ? "" : args[1]!.trim();
  await withStore((store) => {
    const current = store.get();
    const next = { ...current.usageAliases };
    delete next[from];
    if (to !== "") next[from] = to;
    return store.write({ ...current, usageAliases: next });
  });
  if (to === "") {
    console.log(chalk.bold(from), chalk.gray("· counted under its own id again"));
  } else {
    console.log(
      chalk.bold(from),
      chalk.gray("· counted as"),
      to,
      chalk.gray(`in Usage and Sessions; requests still ask for ${from}`),
    );
  }
}

async function modelUsageAliases(): Promise<void> {
  const config = await withStore(async (store) => store.get());
  const aliases = config.usageAliases ?? {};
  const keys = Object.keys(aliases)
    .filter((key) => (aliases[key] ?? "").trim() !== "")
    .sort();
  if (keys.length === 0) {
    console.log(
      chalk.gray("no model is counted under another id yet · neox model alias <model> <name>"),
    );
    return;
  }
  const width = Math.max(...keys.map((key) => key.length));
  for (const key of keys) {
    console.log(`  ${key.padEnd(width)}  → ${aliases[key]}`);
  }
}

function globPart(char: string): string {
  if (char === "*") return ".*";
  if (char === "?") return ".";
  return char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function disabledHits(config: GatewayConfig, pattern: string): string[] {
  const re = new RegExp(
    `^${pattern
      .toLowerCase()
      .split("")
      .map((char) => globPart(char))
      .join("")}$`,
    "s",
  );
  const hits: string[] = [];
  for (const provider of config.providers ?? []) {
    for (const model of provider.models as ModelEntry[]) {
      const key = `${provider.id}/${model.id}`;
      if (re.test(key.toLowerCase()) || re.test(model.id.toLowerCase())) hits.push(key);
    }
  }
  return hits;
}

async function modelDisable(args: string[]): Promise<void> {
  if (args.length === 0) {
    throw new Error("name the models to disable, by id or glob: neox model disable '*fable*'");
  }
  const config = await withStore(async (store) => store.get());
  const patterns = args.map((value) => value.trim()).filter(Boolean);
  await withStore((store) =>
    store.write({
      ...store.get(),
      disabledModels: [...(store.get().disabledModels ?? []), ...patterns],
    }),
  );
  for (const pattern of patterns) {
    const hits = disabledHits(config, pattern);
    const note =
      hits.length > 0
        ? hits.join(", ")
        : "no model Neox serves matches it now; one that does later is disabled too";
    console.log(chalk.green("✓"), chalk.bold(pattern), chalk.gray(`is disabled · ${note}`));
  }
  console.log(
    chalk.gray("  only requests through Neox are refused; neox model enable <model> takes it back"),
  );
}

async function modelEnable(args: string[]): Promise<void> {
  if (args.length === 0)
    throw new Error("name the models to enable, as neox model disabled lists them");
  const config = await withStore(async (store) => store.get());
  const list = config.disabledModels ?? [];
  const wanted = new Set(args.map((value) => value.trim()).filter(Boolean));
  const listed = new Set(list);
  const missing = new Set([...wanted].filter((pattern) => !listed.has(pattern)));
  await withStore((store) =>
    store.write({
      ...store.get(),
      disabledModels: (store.get().disabledModels ?? []).filter((pattern) => !wanted.has(pattern)),
    }),
  );
  for (const pattern of wanted) {
    if (missing.has(pattern)) {
      console.log(
        chalk.gray(`· ${pattern} was not on the disabled list (neox model disabled lists it)`),
      );
      continue;
    }
    console.log(chalk.green("✓"), chalk.bold(pattern), chalk.gray("is enabled again"));
  }
}

async function modelDisabled(): Promise<void> {
  const config = await withStore(async (store) => store.get());
  const list = config.disabledModels ?? [];
  if (list.length === 0) {
    console.log(chalk.gray("no model is disabled · neox model disable <model> turns one off"));
    return;
  }
  for (const pattern of list) {
    const hits = disabledHits(config, pattern);
    console.log(
      chalk.bold(pattern),
      chalk.gray(`· ${hits.length > 0 ? hits.join(", ") : "matches no model Neox serves now"}`),
    );
  }
}

export function createModelCommand(): Command {
  const command = new Command("model").description("A model's name, price, limits and spec");
  command.action(() => {
    console.log(modelUsage);
  });
  const add = (
    name: string,
    action: (values: string[], json: boolean) => Promise<void>,
    supportsJson = false,
  ): void => {
    const leaf = command
      .command(name)
      .argument("[args...]")
      .allowUnknownOption(true)
      .description(`${name} — see neox model --help`);
    addDaemonHostOption(addJsonOption(leaf));
    leaf.action(
      async (values: string[] | undefined, _options: unknown, cmd: Command): Promise<void> => {
        selectedHome = localDaemonHome(cmd);
        // --json may be parsed by this leaf or by the parent model command.
        const json = (cmd.optsWithGlobals() as { json?: boolean }).json === true;
        if (json && !supportsJson) {
          throw new Error(`neox model ${name} has no JSON output (neox model prices --json does)`);
        }
        await action(values ?? [], json);
      },
    );
  };
  add("name", modelName);
  add("names", modelNames);
  add("price", modelPrice);
  add("prices", (_values, json) => modelPrices(json), true);
  add("context", modelContext);
  add("output", modelOutput);
  add("spec", modelSpec);
  add("specs", modelSpecs);
  add("suffix", modelSuffix);
  add("compact", modelCompact);
  add("efforts", modelEfforts);
  add("wire", modelWire);
  add("wires", modelWires);
  add("id", modelID);
  add("ids", modelIDs);
  add("alias", modelUsageAlias);
  add("aliases", modelUsageAliases);
  add("disable", modelDisable);
  add("enable", modelEnable);
  add("disabled", modelDisabled);
  return command;
}
