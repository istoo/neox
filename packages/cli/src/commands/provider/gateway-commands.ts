import { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import type { ConnectOptions } from "../../utils/client.js";
import {
  addJsonAndDaemonHostOptions,
  addLocalDaemonOptions,
  withGlobalOptions,
} from "../../utils/command-options.js";
import type { GatewayAccount, GatewayProvider } from "@neolix/server/gateway-config";
import { GATEWAY_PROVIDER_PRESETS, type GatewayProviderPreset } from "./presets.js";
import {
  accountsOf,
  addProviderToStore,
  exposedModels,
  findAccount,
  findGatewayProvider,
  freeProviderId,
  maskKey,
  providerHost,
  removeProviderFromStore,
  saveProvider,
  slugName,
  withAccount,
  withGatewayStore,
  type StoreOptions,
} from "./gateway-store.js";

/**
 * myna's `provider` commands (`internal/cli/providers_cli.go:28`), on this
 * computer's gateway.json. The parameter forms and wording follow myna;
 * the command prefix is `neolix`.
 */

export const PROVIDER_USAGE = `usage:
  neox providers                        list providers, keys and models
  neox presets                          list the vendors Neox knows out of the box
  neox provider <id>                    show one provider and its models
  neox provider add <preset> <key>      add a preset vendor   e.g. neox provider add deepseek sk-…
                                          again, it adds another (deepseek-2); k=v pairs too: id, name, header.X-Foo
  neox provider add <name> k=v…         add a custom vendor   k: url, anthropic, responses, gemini, key, models, catalog, icon, header.X-Foo, balance, balance.path, balance.method, balance.token, models.url, search, user-agent,
                                          decide, workspace, region, plan, access.key, access.secret, project, location, credentials, impersonate
  neox provider set <id> k=v…           change a provider's settings, with the same k=v pairs as add
  neox provider key <id> <key>          change the API key
  neox provider icon <id> <file|name>   give a custom provider a picture or a built-in icon
  neox provider fallback <id> <provider/model>…   where requests go when it's out of quota or down (none clears)
  neox provider models <id> [ids…]      fetch the vendor's model list, or choose which models to expose:
                                          ids… replace the list, +id adds one, -id takes one out, all: the default,
                                          none: serve none of them, best: only the newest of each family it lists
  neox provider refresh <id>            fetch the vendor's model list again
  neox provider refresh-every <id> [6h|1d|off]
                                          have the gateway fetch the list again by itself once it is that old
  neox provider auto-include <id> [rule…|none]
                                          rules over a model's id: a glob with *, or 're:…' a regular expression
  neox provider account-models <id> [account|key [ids…|all]]
                                          the models one account or key alone serves
  neox provider account-cap <id> [account [percent|off]]
                                          use a subscription account up to a share of each usage window
  neox provider account-cap <id> <account> --window <name> [percent|none|default]
  neox provider pool <id> [--accounts a,b,…] [--cap percent|off] [--stop on|off] [--careful on|off]
                                          a subscription's accounts as one pool
  neox provider account-concurrency <id> [account|key [n|off|default]]
                                          how many requests one account or key has out at once
  neox provider spend-cap <id> [key [usd [day|month|total]|off]]
                                          how much an API key may spend, in USD
  neox provider account-weight <id> [account [n|default]]
                                          a subscription account's share of the requests with routing=weight
  neox provider queue <id> [length [seconds]]
                                          how many may wait for each account or key past its limit, and how long
  neox provider rpm <id> [n|off]        how many requests each account or key sends in any minute
  neox provider at-once <id> [n|off|default]
                                          how many of its accounts or keys take requests at the same time
  neox provider quota-rest <id> [30m|6h|7d|until 08:00|default]
                                          how long a key sits out once the vendor says it is out of allowance
  neox provider rest-cap <id> [1m|30m|6h|1d|off|default]
                                          the most a key or account sits out while it keeps failing
  neox provider listed <id> yes|no      no: its models serve only through routing groups, not in the list
  neox provider off|on <id>             switch it off (kept, but no agent or request uses it), or on again
  neox provider test <id> [--as codex|claude-code] [model…]
                                          send a tiny request through each endpoint, or to each model
  neox provider rm <id>                 remove a provider`;

interface HomeOptions {
  home?: string;
  /** Set by withGlobalOptions on the commands that take a daemon target. */
  daemonTarget?: ConnectOptions["target"];
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

function fail(error: unknown): void {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
}

function invalid(message: string): never {
  throw { code: "INVALID_ARGUMENT", message };
}

function print(lines: string[]): void {
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
}

/**
 * A command that only edits this computer's gateway.json: its positional
 * arguments (a variadic one arrives as an array) are flattened, and failure
 * is reported without a daemon.
 */
function localAction(
  run: (args: string[], options: HomeOptions) => Promise<string[]>,
): (...parts: unknown[]) => Promise<void> {
  return withGlobalOptions(async (...parts: unknown[]) => {
    const command = parts.at(-1) as Command;
    const options = command.optsWithGlobals() as HomeOptions;
    const args = parts
      .slice(0, -2)
      .flat()
      .filter((part): part is string => typeof part === "string");
    try {
      print(await run(args, options));
    } catch (error) {
      fail(error);
    }
  });
}

/* ------------------------------ arguments ------------------------------- */

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** myna's duration arguments: 30m, 6h, 1d, 1h30m, or a whole count of the fallback unit. */
export function parseDurationMs(value: string, bareUnit: "ms" | "s" | "m" = "m"): number {
  const text = value.trim().toLowerCase();
  if (/^\d+$/.test(text)) {
    return Number(text) * UNIT_MS[bareUnit];
  }
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
  let total = 0;
  let consumed = 0;
  for (const match of text.matchAll(pattern)) {
    consumed += match[0].length;
    total += Number(match[1]) * UNIT_MS[match[2] ?? ""];
  }
  if (consumed !== text.length || total <= 0) {
    invalid(`a duration such as 30m, 6h or 1d, not "${value}"`);
  }
  return Math.round(total);
}

/** A rest in minutes, as myna's restMinutes takes it (providers_cli.go:2013). */
export function parseRestMinutes(value: string): number {
  const text = value.trim().toLowerCase();
  switch (text) {
    case "default":
    case "off":
    case "none":
    case "-":
    case "0":
      return 0;
    default:
      break;
  }
  if (/^\d+$/.test(text)) {
    return Number(text);
  }
  const days = /^(\d+)d$/.exec(text);
  if (days !== null) {
    return Number(days[1]) * 24 * 60;
  }
  const ms = parseDurationMs(text);
  if (ms < 60_000) {
    invalid(`a rest is minutes, or as 30m, 6h or 7d, or default, not "${value}"`);
  }
  return Math.round(ms / 60_000);
}

/** 7 days, 6 hours, 90 minutes. */
export function restWords(minutes: number): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (minutes % (24 * 60) === 0) {
    return plural(minutes / (24 * 60), "day");
  }
  if (minutes % 60 === 0) {
    return plural(minutes / 60, "hour");
  }
  return plural(minutes, "minute");
}

function parseWhole(value: string, what: string, allowOff: boolean): number | undefined {
  const text = value.trim().toLowerCase();
  if (allowOff && ["off", "none", "no", "-"].includes(text)) {
    return 0;
  }
  if (!/^\d+$/.test(text)) {
    invalid(`the ${what} is a whole number${allowOff ? ", or off," : ","} not "${value}"`);
  }
  return Number(text);
}

function parseTokens(value: string): number {
  const text = value.trim().toLowerCase();
  const match = /^(\d+)(k|m)?$/.exec(text);
  if (match === null) {
    invalid(`a context is tokens such as 272k or 1m, not "${value}"`);
  }
  const amount = Number(match[1]);
  let factor = 1;
  if (match[2] === "k") {
    factor = 1_000;
  } else if (match[2] === "m") {
    factor = 1_000_000;
  }
  return amount * factor;
}

function parseOnOff(value: string): boolean {
  switch (value.trim().toLowerCase()) {
    case "on":
    case "true":
    case "yes":
      return true;
    case "off":
    case "false":
    case "no":
      return false;
    default:
      invalid(`"${value}": on or off`);
  }
}

/* ------------------------------- pairs ---------------------------------- */

const PROTOCOLS = ["openai", "openai-responses", "anthropic", "gemini"] as const;
type GatewayProtocol = (typeof PROTOCOLS)[number];

function isProtocol(value: string): value is GatewayProtocol {
  return (PROTOCOLS as readonly string[]).includes(value);
}

function setProtocol(provider: GatewayProvider, protocol: GatewayProtocol, baseUrl: string): void {
  const url = baseUrl.trim();
  const wires = { ...provider.wires } as Record<string, string>;
  if (url === "") {
    delete wires[protocol];
    if (Object.keys(wires).length === 0) {
      delete provider.wires;
    } else {
      provider.wires = wires;
    }
    return;
  }
  // myna's provider keeps one address per API; the first one typed is the
  // provider's main address, and every one is kept for its own wire.
  provider.protocol = protocol;
  provider.baseUrl = url;
  provider.wires = { ...wires, [protocol]: url };
}

function setModelPick(provider: GatewayProvider, ids: string[]): void {
  const wanted = new Set(ids);
  const held = new Map(provider.models.map((model) => [model.id, model]));
  provider.models = ids.map((id) => ({ ...(held.get(id) ?? { id }), picked: true }));
  provider.modelMode = "picked";
  for (const model of held.values()) {
    if (!wanted.has(model.id)) {
      // Kept, without its pick: an older pick may come back with all.
      provider.models.push({ ...model, picked: false });
    }
  }
}

/**
 * The k=v pairs of myna's `provider add` and `provider set`
 * (`internal/cli/providers_cli.go:1004`), on a Neolix provider. myna's
 * decide/workspace/region/access pairs have no Neolix counterpart and are
 * refused rather than dropped.
 */
/** The placeholder a Bailian decision API's address carries (myna presets.go:119). */
const WORKSPACE_ID = "{WorkspaceId}";

/** Region ids a preset's keys may name from before its regions were made one. */
const REGION_ALIASES: Record<string, Record<string, string>> = {
  "tencent-cloud": { enterprise: "plan" },
};

/** The preset a provider came from: the one it was added with, or one of its id. */
function presetOf(provider: GatewayProvider): GatewayProviderPreset | undefined {
  return presetById(provider.preset ?? provider.id);
}

function presetRegionId(presetId: string, value: string): string {
  const wanted = value.trim().toLowerCase();
  return REGION_ALIASES[presetId]?.[wanted] ?? wanted;
}

/** myna's `region=`/`plan=`: every endpoint moves to the picked region's host. */
function applyPresetRegion(
  provider: GatewayProvider,
  preset: GatewayProviderPreset,
  value: string,
): void {
  if (provider.vertex !== undefined) {
    invalid(
      `${provider.label ?? provider.id} has no regions or plans to pick: location= says where it is asked (global, us, eu or a region such as us-central1)`,
    );
  }
  const regions = preset.regions ?? [];
  if (regions.length === 0) {
    invalid(`${provider.label ?? provider.id} has no regions or plans to pick`);
  }
  const wanted = presetRegionId(preset.id, value);
  const region = regions.find((held) => held.id.toLowerCase() === wanted);
  if (region === undefined) {
    invalid(`${value}: ${preset.name}'s are ${regions.map((held) => held.id).join(", ")}`);
  }
  if (region.decide !== undefined) {
    // A decision-only plan (Bailian's) moves its System One host, not a chat one.
    provider.decide = region.decide;
  }
  const order: GatewayProtocol[] = [
    provider.protocol,
    "openai",
    "anthropic",
    "openai-responses",
    "gemini",
  ];
  const protocol = order.find((held) => region.endpoints[held] !== undefined);
  if (protocol !== undefined) {
    provider.protocol = protocol;
    provider.baseUrl = region.endpoints[protocol] as string;
  } else if (region.decide === undefined) {
    invalid(`${preset.name}'s ${region.name} serves no API Neox speaks`);
  }
  if (region.website !== undefined) {
    provider.website = region.website;
  }
  if (region.keysUrl !== undefined) {
    provider.keysUrl = region.keysUrl;
  }
  if (region.catalog !== undefined) {
    provider.catalog = region.catalog;
  }
}

// myna's pair switch is one flat table (providers_cli.go:1004); splitting it
// would scatter the field names the usage string promises.
// eslint-disable-next-line complexity
export function applyPairs(provider: GatewayProvider, pairs: string[]): GatewayProvider {
  const next: GatewayProvider = { ...provider, models: [...provider.models] };
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at <= 0) {
      invalid(`expected key=value, got "${pair}"\n\n${PROVIDER_USAGE}`);
    }
    const key = pair.slice(0, at);
    const value = pair.slice(at + 1);
    const lower = key.toLowerCase();
    switch (lower) {
      case "id":
        next.id = value.trim().toLowerCase();
        break;
      case "name":
        next.label = value;
        break;
      case "url":
      case "chat":
      case "openai":
        setProtocol(next, "openai", value);
        break;
      case "responses":
        setProtocol(next, "openai-responses", value);
        break;
      case "anthropic":
        setProtocol(next, "anthropic", value);
        break;
      case "gemini":
        setProtocol(next, "gemini", value);
        break;
      case "key":
        next.apiKey = value;
        break;
      case "catalog":
        next.catalog = value;
        break;
      case "models":
        setModelPick(
          next,
          value
            .split(",")
            .map((id) => id.trim())
            .filter((id) => id.length > 0),
        );
        break;
      case "website":
        next.website = value;
        break;
      case "keys":
        next.keysUrl = value;
        break;
      case "models.url":
        next.modelsUrl = value;
        break;
      case "balance":
        next.balanceUrl = value;
        break;
      case "balance.path":
        next.balancePath = value;
        break;
      case "balance.method": {
        const method = value.trim().toUpperCase();
        if (method === "GET" || method === "") {
          next.balanceMethod = undefined;
        } else if (method === "POST") {
          next.balanceMethod = "POST";
        } else {
          invalid(`balance.method=GET|POST, not "${value}"`);
        }
        break;
      }
      case "balance.token":
        next.balanceToken = value;
        break;
      case "codex":
        switch (value.trim().toLowerCase()) {
          case "as-sent":
          case "yes":
          case "on":
            next.codexAsSent = true;
            break;
          case "default":
          case "no":
          case "off":
            next.codexAsSent = false;
            break;
          default:
            invalid(`codex=as-sent|default, not "${value}"`);
        }
        break;
      case "prompt":
        switch (value.trim().toLowerCase()) {
          case "as-written":
          case "as-sent":
          case "on":
          case "yes":
            next.promptAsWritten = true;
            break;
          case "default":
          case "no":
          case "off":
            next.promptAsWritten = false;
            break;
          default:
            invalid(`prompt=as-written|default, not "${value}"`);
        }
        break;
      case "additional-tools":
        switch (value.trim().toLowerCase()) {
          case "on":
          case "yes":
            next.additionalTools = "on";
            break;
          case "off":
          case "no":
            next.additionalTools = "off";
            break;
          case "default":
            next.additionalTools = "default";
            break;
          default:
            invalid(`additional-tools=on|off|default, not "${value}"`);
        }
        break;
      case "patience": {
        const text = value.trim().toLowerCase();
        if (["off", "no", "none", "0"].includes(text)) {
          next.patienceMs = 0;
        } else if (text === "default" || text === "") {
          next.patienceMs = undefined;
        } else {
          const ms = parseDurationMs(text, "s");
          if (ms <= 0 || ms > 4 * 60_000) {
            invalid(`patience is at most 4m, not "${value}"`);
          }
          next.patienceMs = ms;
        }
        break;
      }
      case "user-agent":
      case "ua":
        switch (value.trim().toLowerCase()) {
          case "agent":
          case "pass":
          case "yes":
          case "on":
            next.passUserAgent = true;
            break;
          case "neolix":
          case "myna":
          case "default":
          case "no":
          case "off":
            next.passUserAgent = false;
            break;
          default:
            invalid(`user-agent=agent|default, not "${value}"`);
        }
        break;
      case "search":
        if (value !== "yes" && value !== "no") {
          invalid(`search=yes|no, not "${value}"`);
        }
        next.searches = value === "yes";
        break;
      case "compaction":
        switch (value.trim().toLowerCase()) {
          case "native":
          case "yes":
          case "on":
            next.nativeCompaction = true;
            break;
          case "neolix":
          case "myna":
          case "default":
          case "no":
          case "off":
            next.nativeCompaction = false;
            break;
          default:
            invalid(`compaction=native|default, not "${value}"`);
        }
        break;
      case "unmasked":
        if (value !== "yes" && value !== "no") {
          invalid(`unmasked=yes|no, not "${value}"`);
        }
        next.unredacted = value === "yes";
        break;
      case "free":
        switch (value.trim().toLowerCase()) {
          case "yes":
          case "on":
            next.countFree = true;
            break;
          case "no":
          case "off":
            next.countFree = false;
            break;
          default:
            invalid(`free=yes|no, not "${value}"`);
        }
        break;
      case "context":
        next.models = next.models.map((model) => ({
          ...model,
          contextWindow: parseTokens(value),
        }));
        break;
      case "family":
      case "tag":
        next.family = value.trim();
        break;
      case "routing":
      case "strategy": {
        const routing = value.trim().toLowerCase();
        if (routing === "manual" || routing === "cheapest" || routing === "cheap") {
          invalid(
            `routing=${routing} is a group's: a provider's keys or accounts are routed smart, order, rotate, usage, pace, weight, free, fast or drain`,
          );
        }
        if (
          ![
            "smart",
            "order",
            "rotate",
            "usage",
            "pace",
            "weight",
            "free",
            "fast",
            "drain",
          ].includes(routing)
        ) {
          invalid(`unknown routing "${value}"`);
        }
        next.routing = routing as GatewayProvider["routing"];
        break;
      }
      case "icon":
        next.icon = value;
        break;
      case "address":
        next.baseUrl = moveAddress(next.baseUrl, value);
        break;
      case "project":
      case "location":
      case "credentials":
      case "impersonate": {
        if (next.vertex === undefined) {
          invalid(`project= is Google Vertex AI's, and ${next.label ?? next.id} isn't Vertex AI`);
        }
        next.vertex = { ...next.vertex, [lower]: value };
        break;
      }
      case "decide":
        next.decide = value;
        break;
      case "workspace": {
        const workspace = value.trim();
        if (next.decide === undefined || !next.decide.includes(WORKSPACE_ID)) {
          invalid(
            `workspace= fills in a Bailian workspace's host, and ${next.label ?? next.id}'s decision API names none`,
          );
        }
        next.decide = next.decide.split(WORKSPACE_ID).join(workspace);
        break;
      }
      case "region":
      case "plan": {
        const preset = presetOf(next);
        if (preset === undefined) {
          invalid(`${next.label ?? next.id} has no regions or plans to pick`);
        }
        applyPresetRegion(next, preset, value);
        break;
      }
      case "access.key":
        // a Volcengine account's access key, or a Tencent Cloud SecretId
        next.accessKeyId = value;
        break;
      case "access.secret":
        next.secretAccessKey = value;
        break;
      default:
        if (lower.startsWith("header.")) {
          next.headers = setHeader(next.headers, key.slice("header.".length), value);
          break;
        }
        if (lower.startsWith("context.")) {
          const modelId = key.slice("context.".length);
          const contextWindow = value.trim() === "" ? undefined : parseTokens(value);
          next.models = next.models.map((model) =>
            model.id === modelId ? { ...model, contextWindow } : model,
          );
          break;
        }
        invalid(`unknown field "${key}"\n\n${PROVIDER_USAGE}`);
    }
  }
  if (!/^[a-z][a-z0-9-]*$/.test(next.id)) {
    invalid(`id=${next.id}: an id starts with a letter and has letters, digits and dashes only`);
  }
  return next;
}

function setHeader(
  headers: Record<string, string> | undefined,
  name: string,
  value: string,
): Record<string, string> | undefined {
  const next: Record<string, string> = {};
  for (const [held, heldValue] of Object.entries(headers ?? {})) {
    if (held.toLowerCase() !== name.toLowerCase()) {
      next[held] = heldValue;
    }
  }
  if (value.trim() !== "") {
    next[name] = value;
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

/** myna's atAddress: every URL moves to the given host and port, keeping its path. */
function moveAddress(baseUrl: string, address: string): string {
  const text = address.trim();
  if (text === "") {
    invalid("address= needs an address, such as http://192.168.1.5:1234");
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    invalid(`${baseUrl} is no address to move`);
  }
  const moved = new URL(text.includes("://") ? text : `http://${text}`);
  url.host = moved.host;
  url.protocol = moved.protocol;
  return url.toString().replace(/\/$/, "");
}

/* ------------------------------- commands -------------------------------- */

function keyColumn(provider: GatewayProvider): string {
  if (provider.enabled === false) {
    return "○ switched off";
  }
  if (provider.apiKey !== undefined && provider.apiKey.length > 0) {
    return `● ${maskKey(provider.apiKey)}`;
  }
  const signedIn = accountsOf(provider).find((account) => account.agent !== undefined);
  if (signedIn !== undefined) {
    return `● signed in as ${signedIn.label ?? signedIn.id}`;
  }
  if (provider.vertex !== undefined) {
    return "● Google credentials";
  }
  const first = accountsOf(provider).find((account) => (account.apiKey ?? "").length > 0);
  if (first !== undefined) {
    return `● ${maskKey(first.apiKey ?? "")}`;
  }
  return "○ no key";
}

/**
 * Which agents start on each gateway provider: Settings → Use → Agent keeps
 * every wired agent's gateway model as `<provider>/<model>` (myna's
 * usesByProvider reads the same prefix). The state is the daemon's, so
 * without one the column is simply left out.
 */
function noteUsage(usage: Map<string, string[]>, model: string | null | undefined, agent: string) {
  if (model === null || model === undefined) {
    return;
  }
  const slash = model.indexOf("/");
  if (slash <= 0) {
    return;
  }
  const providerId = model.slice(0, slash);
  const agents = usage.get(providerId) ?? [];
  if (!agents.includes(agent)) {
    agents.push(agent);
  }
  usage.set(providerId, agents);
}

async function agentUsage(options: StoreOptions): Promise<Map<string, string[]>> {
  const usage = new Map<string, string[]>();
  if (options.daemonTarget === undefined) {
    return usage;
  }
  try {
    const client = await connectToDaemon({ target: options.daemonTarget });
    try {
      const payload = await client.getAgentConnect();
      for (const entry of payload.snapshot.entries) {
        if (!entry.connected) {
          continue;
        }
        const agent = entry.name ?? entry.provider;
        for (const model of [entry.model, ...(entry.fields ?? []).map((field) => field.model)]) {
          noteUsage(usage, model, agent);
        }
      }
    } finally {
      await client.close().catch(() => undefined);
    }
  } catch {
    // No daemon, or one too old to answer: the list still shows the file.
  }
  return usage;
}

export async function runProvidersCommand(
  options: StoreOptions,
  usageArg?: Map<string, string[]>,
): Promise<string[]> {
  const usage = usageArg ?? (await agentUsage(options));
  return withGatewayStore(options, async (store) => {
    const config = store.get();
    if (config.providers.length === 0) {
      return [
        "no providers yet · neox provider add deepseek sk-… · neox presets lists the vendors",
      ];
    }
    const rows = config.providers.map((provider) => {
      const name = provider.label ?? provider.id;
      const exposed = exposedModels(provider).length;
      const listed = `${exposed} of ${provider.models.length} models`;
      const fallback =
        (provider.fallback ?? []).length > 0 ? `  ⤷ ${(provider.fallback ?? []).join(" → ")}` : "";
      let uses = "";
      const agents = usage.get(provider.id);
      if (agents !== undefined && agents.length > 0) {
        uses = `  ← ${agents.join(", ")}`;
      }
      if (provider.enabled === false) {
        uses = `neox provider on ${provider.id}  ${uses}`.trimEnd();
      }
      return `  ${name}  ${provider.id}  ${providerHost(provider)}  ${keyColumn(provider)}  ${listed}${fallback}${uses === "" ? "" : `  ${uses}`}`;
    });
    return rows;
  });
}

/** One gateway provider as `neox providers --json` reports it: never the key itself. */
export interface ProviderSummary {
  id: string;
  label: string;
  host: string;
  enabled: boolean;
  hasKey: boolean;
  models: { exposed: number; total: number };
  fallback: string[];
  usedBy: string[];
}

export async function runProvidersJson(
  options: StoreOptions,
  usageArg?: Map<string, string[]>,
): Promise<ProviderSummary[]> {
  const usage = usageArg ?? (await agentUsage(options));
  return withGatewayStore(options, async (store) =>
    store.get().providers.map((provider) => ({
      id: provider.id,
      label: provider.label ?? provider.id,
      host: providerHost(provider),
      enabled: provider.enabled !== false,
      hasKey: (provider.apiKey ?? "").length > 0,
      models: { exposed: exposedModels(provider).length, total: provider.models.length },
      fallback: provider.fallback ?? [],
      usedBy: usage.get(provider.id) ?? [],
    })),
  );
}

export function presetById(id: string): GatewayProviderPreset | undefined {
  const wanted = id.trim().toLowerCase();
  return GATEWAY_PROVIDER_PRESETS.find((preset) => preset.id === wanted);
}

export function presetBaseUrl(preset: GatewayProviderPreset): {
  protocol: GatewayProtocol;
  baseUrl: string;
} {
  for (const protocol of ["openai", "anthropic", "openai-responses", "gemini"] as const) {
    const baseUrl = preset.endpoints[protocol];
    if (baseUrl !== undefined) {
      return { protocol, baseUrl };
    }
  }
  for (const [protocol, baseUrl] of Object.entries(preset.endpoints)) {
    if (baseUrl !== undefined && isProtocol(protocol)) {
      return { protocol, baseUrl };
    }
  }
  // A decision-only preset (myna's bailian-decision) is addressed at its
  // System One root and serves no chat model; gateway.json still wants a URL.
  if (preset.decide !== undefined) {
    return { protocol: "openai", baseUrl: preset.decide };
  }
  throw new Error(`${preset.name} has no base URL to add`);
}

export async function runAddCommand(args: string[], options: StoreOptions): Promise<string[]> {
  if (args.length === 0) {
    invalid(
      `neox provider add <preset> <key>   or   neox provider add <name> k=v…\n\n${PROVIDER_USAGE}`,
    );
  }
  const [first, ...rest] = args;
  const preset = presetById(first);
  let provider: GatewayProvider;
  let pairs: string[];
  if (preset !== undefined) {
    const { protocol, baseUrl } = presetBaseUrl(preset);
    provider = {
      id: preset.id,
      label: preset.name,
      protocol,
      baseUrl,
      accounts: [],
      replyHeaders: [],
      passHeaders: [],
      countFree: false,
      queueWaitMs: 0,
      sink: false,
      priceRate: 1,
      models: (preset.models ?? []).map((id) => ({ id })),
      fallback: [],
      website: preset.website,
      keysUrl: preset.keysUrl,
      preset: preset.id,
      ...(preset.catalog === undefined ? {} : { catalog: preset.catalog }),
      ...(preset.decide === undefined ? {} : { decide: preset.decide }),
      // A decision API's models are never an agent's (myna's DecideOnly).
      ...(Object.keys(preset.endpoints).length === 0 && preset.decide !== undefined
        ? { modelMode: "none" as const, exposeModels: false }
        : {}),
      ...(preset.vertex === true ? { vertex: {} } : {}),
    } as GatewayProvider;
    if (rest.length > 0 && !rest[0].includes("=")) {
      if (preset.vertex === true) {
        invalid(
          `${preset.name} is asked with your Google credentials, not an API key · neox provider add ${preset.id} project=<your Google Cloud project's id>`,
        );
      }
      provider.apiKey = rest[0];
      pairs = rest.slice(1);
    } else {
      pairs = rest;
    }
  } else {
    provider = {
      id: slugName(first),
      label: first,
      protocol: "openai",
      baseUrl: "",
      accounts: [],
      replyHeaders: [],
      passHeaders: [],
      countFree: false,
      queueWaitMs: 0,
      sink: false,
      priceRate: 1,
      models: [],
      fallback: [],
    } as GatewayProvider;
    pairs = rest;
  }
  provider = applyPairs(provider, pairs);
  if (provider.baseUrl === "") {
    invalid(
      `${provider.label ?? provider.id} needs an address: url=, responses=, anthropic= or gemini= gives one`,
    );
  }
  provider.id = provider.id === "" ? slugName(provider.label ?? "") : provider.id;

  return withGatewayStore(options, async (store) => {
    const config = store.get();
    const duplicate = config.providers.find(
      (held) =>
        held.baseUrl === provider.baseUrl &&
        held.protocol === provider.protocol &&
        held.apiKey !== undefined &&
        held.apiKey === provider.apiKey,
    );
    if (duplicate !== undefined) {
      throw new Error(
        `${duplicate.label ?? duplicate.id} is already added with that key (${duplicate.id}); neox provider key ${duplicate.id} <key> changes its key`,
      );
    }
    provider.id = freeProviderId(config, provider.id);
    const saved = await addProviderToStore(store, provider);
    return [
      `✓ added ${saved.provider.label ?? saved.provider.id} (${saved.provider.id})`,
      `  its models are fetched by the gateway: neox provider refresh ${saved.provider.id}`,
    ];
  });
}

export async function runSetCommand(args: string[], options: StoreOptions): Promise<string[]> {
  if (args.length < 2) {
    invalid(`neox provider set <id> k=v…\n\n${PROVIDER_USAGE}`);
  }
  const [ref, ...pairs] = args;
  return withGatewayStore(options, async (store) => {
    const before = findGatewayProvider(store.get(), ref);
    const from = before.id;
    const changed = applyPairs(before, pairs);
    const renamed = changed.id !== from;
    const saved = await saveProvider(store, before.id, () => changed);
    return [
      `✓ saved ${saved.provider.label ?? saved.provider.id} (${saved.provider.id})${renamed ? ", and its id changed" : ""}`,
    ];
  });
}

export async function runKeyCommand(args: string[], options: StoreOptions): Promise<string[]> {
  if (args.length !== 2) {
    invalid("neox provider key <id> <key>");
  }
  const [ref, key] = args;
  return withGatewayStore(options, async (store) => {
    const held = findGatewayProvider(store.get(), ref);
    if (held.vertex !== undefined) {
      throw new Error(
        `${held.label ?? held.id} is asked with your Google credentials, not an API key · neox provider set ${held.id} credentials=<file> impersonate=<service account> changes them`,
      );
    }
    const saved = await saveProvider(store, held.id, (provider) => ({ ...provider, apiKey: key }));
    return [`✓ ${saved.provider.label ?? saved.provider.id} key ${maskKey(key)}`];
  });
}

export async function runIconCommand(args: string[], options: StoreOptions): Promise<string[]> {
  if (args.length !== 2) {
    invalid('neox provider icon <id> <picture file | built-in name | "">');
  }
  const [ref, icon] = args;
  return withGatewayStore(options, async (store) => {
    const saved = await saveProvider(store, ref, (provider) => ({
      ...provider,
      icon: icon === "" ? "generic" : icon,
    }));
    return [
      `✓ ${saved.provider.label ?? saved.provider.id} icon ${saved.provider.icon ?? "generic"}`,
    ];
  });
}

export async function runFallbackCommand(args: string[], options: StoreOptions): Promise<string[]> {
  if (args.length < 1) {
    invalid("neox provider fallback <id> [provider/model… | group/<id>… | none]");
  }
  const [ref, ...fallbacks] = args;
  return withGatewayStore(options, async (store) => {
    let provider = findGatewayProvider(store.get(), ref);
    if (fallbacks.length > 0) {
      const wanted = fallbacks.length === 1 && fallbacks[0] === "none" ? [] : fallbacks;
      for (const fallback of wanted) {
        const slash = fallback.indexOf("/");
        const known =
          slash > 0 &&
          (fallback.startsWith("group/")
            ? store.get().groups.some((group) => group.id === fallback.slice("group/".length))
            : store.get().providers.some((held) => held.id === fallback.slice(0, slash)));
        if (!known) {
          invalid(
            `Neox knows no model or group "${fallback}" (neox provider <id> lists its models)`,
          );
        }
      }
      const saved = await saveProvider(store, provider.id, (held) => ({
        ...held,
        fallback: wanted,
      }));
      provider = saved.provider;
    }
    if ((provider.fallback ?? []).length === 0) {
      return [
        `${provider.label ?? provider.id} has no fallback · neox provider fallback ${provider.id} <provider/model>…`,
      ];
    }
    return [
      `✓ ${provider.label ?? provider.id} falls back to ${(provider.fallback ?? []).join(" → ")} · when out of quota, rate limited or down`,
    ];
  });
}

export interface ModelFetch {
  models: string[];
  error?: string;
}

export type FetchModels = (provider: GatewayProvider, options: StoreOptions) => Promise<ModelFetch>;

export type TestModel = (
  provider: GatewayProvider,
  model: string,
) => Promise<{ ok: boolean; status: number; latencyMs: number; error: string | null }>;

export type DetectProtocols = (
  provider: GatewayProvider,
) => Promise<Array<{ protocol: string; ok: boolean; status: number; error: string | null }>>;

interface TestDeps {
  testModel?: TestModel;
  detect?: DetectProtocols;
}

/** Picks or clears the models a provider serves (myna's editPicks, providers_cli.go:2061). */
export function editPicks(
  provider: GatewayProvider,
  args: string[],
): { models: GatewayProvider["models"]; modelMode: NonNullable<GatewayProvider["modelMode"]> } {
  if (args.length === 1 && (args[0] === "all" || args[0] === "-")) {
    return { models: provider.models, modelMode: "list" };
  }
  if (args.length === 1 && args[0] === "none") {
    return { models: provider.models, modelMode: "none" };
  }
  if (args.length === 1 && args[0] === "best") {
    return { models: provider.models, modelMode: "best" };
  }
  const held = new Map(provider.models.map((model) => [model.id, model]));
  const current = new Set(exposedModels(provider));
  const edits = args.some((arg) => arg.startsWith("+") || arg.startsWith("-"));
  if (!edits) {
    const ids = args.filter((arg) => arg.length > 0);
    return {
      models: [...new Set(ids)].map((id) =>
        Object.assign({}, held.get(id) ?? { id }, { picked: true }),
      ),
      modelMode: "picked",
    };
  }
  for (const arg of args) {
    const id = arg.slice(1);
    if (id === "") {
      continue;
    }
    if (arg.startsWith("+")) {
      current.add(id);
    } else {
      current.delete(id);
    }
  }
  return {
    models: [...current].map((id) => Object.assign({}, held.get(id) ?? { id }, { picked: true })),
    modelMode: "picked",
  };
}

export async function runModelsCommand(
  ref: string,
  ids: string[],
  options: StoreOptions,
  fetchModels: FetchModels = fetchModelsFromDaemon,
): Promise<string[]> {
  return withGatewayStore(options, async (store) => {
    const provider = findGatewayProvider(store.get(), ref);
    if (ids.length > 0) {
      const picked = editPicks(provider, ids);
      const saved = await saveProvider(store, provider.id, (held) => ({
        ...held,
        models: picked.models,
        modelMode: picked.modelMode,
      }));
      return showProvider(saved.provider);
    }
    const fetched = await fetchModels(provider, options);
    if (fetched.error !== undefined) {
      throw new Error(fetched.error);
    }
    const saved = await mergeFetchedModels(store, provider, fetched.models);
    return [
      `✓ ${fetched.models.length} models from ${providerHost(provider)}`,
      ...showProvider(saved),
    ];
  });
}

function daemonTargetOf(options: StoreOptions): ConnectOptions["target"] {
  if (options.daemonTarget === undefined) {
    throw new Error("this command needs a running daemon: pass --host or start one");
  }
  return options.daemonTarget;
}

async function fetchModelsFromDaemon(
  provider: GatewayProvider,
  options: StoreOptions,
): Promise<ModelFetch> {
  const client = await connectToDaemon({ target: daemonTargetOf(options) });
  try {
    const payload = await client.getGatewayProviderModels(probeTarget(provider));
    return {
      models: payload.models,
      ...(payload.error === null ? {} : { error: payload.error }),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function probeTarget(provider: GatewayProvider): {
  protocol: GatewayProvider["protocol"];
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  insecureTls?: boolean;
  modelsUrl?: string;
  providerId?: string;
} {
  return {
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    // The daemon merges newly listed AutoInclude matches into the saved
    // provider when it knows which one was asked (auto-include.ts).
    providerId: provider.id,
    ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
    ...(provider.headers === undefined ? {} : { headers: provider.headers }),
    ...(provider.insecureTls === undefined ? {} : { insecureTls: provider.insecureTls }),
    // myna's ModelsURL: where its list is, when not `${baseUrl}/models`.
    ...(provider.modelsUrl === undefined ? {} : { modelsUrl: provider.modelsUrl }),
  };
}

async function mergeFetchedModels(
  store: Parameters<typeof saveProvider>[0],
  provider: GatewayProvider,
  ids: string[],
): Promise<GatewayProvider> {
  const known = new Set(ids);
  const kept = provider.models.filter((model) => known.has(model.id));
  const held = new Set(kept.map((model) => model.id));
  const added = ids.filter((id) => !held.has(id)).map((id) => ({ id, picked: false }));
  const saved = await saveProvider(store, provider.id, (current) => ({
    ...current,
    models: [...kept, ...added],
  }));
  return saved.provider;
}

export async function runRefreshCommand(
  ref: string,
  options: StoreOptions,
  fetchModels: FetchModels = fetchModelsFromDaemon,
): Promise<string[]> {
  return runModelsCommand(ref, [], options, fetchModels);
}

export async function runRefreshEveryCommand(
  args: string[],
  options: StoreOptions,
): Promise<string[]> {
  if (args.length < 1 || args.length > 2) {
    invalid("neox provider refresh-every <id> [30m|6h|1d|off]");
  }
  const [ref, value] = args;
  return withGatewayStore(options, async (store) => {
    let provider = findGatewayProvider(store.get(), ref);
    if (value !== undefined) {
      const text = value.trim().toLowerCase();
      const ms =
        text === "off" || text === "none" || text === "default" ? undefined : parseDurationMs(text);
      if (ms !== undefined && ms < 10 * 60_000) {
        invalid("refresh-every is at least 10m, or off");
      }
      const saved = await saveProvider(store, provider.id, (held) => ({
        ...held,
        refreshEveryMs: ms,
      }));
      provider = saved.provider;
    }
    if (provider.refreshEveryMs !== undefined) {
      return [
        `${provider.label ?? provider.id} · its model list is fetched by the gateway every ${restWords(
          Math.round(provider.refreshEveryMs / 60_000),
        )} (neox serve, or the app, running)`,
      ];
    }
    return [
      `${provider.label ?? provider.id} · its model list is fetched only when asked (neox provider refresh ${provider.id}, or Fetch models)`,
    ];
  });
}

export async function runAutoIncludeCommand(
  args: string[],
  options: StoreOptions,
): Promise<string[]> {
  if (args.length < 1) {
    invalid("neox provider auto-include <id> [rule…|none]");
  }
  const [ref, ...rules] = args;
  return withGatewayStore(options, async (store) => {
    let provider = findGatewayProvider(store.get(), ref);
    if (rules.length > 0) {
      const wanted = rules.length === 1 && (rules[0] === "none" || rules[0] === "off") ? [] : rules;
      for (const rule of wanted) {
        if (rule.startsWith("re:")) {
          try {
            RegExp(rule.slice(3));
          } catch {
            invalid(`auto-include rule "${rule}" is no regular expression`);
          }
        }
      }
      const saved = await saveProvider(store, provider.id, (held) => ({
        ...held,
        autoInclude: wanted,
      }));
      provider = saved.provider;
    }
    if ((provider.autoInclude ?? []).length === 0) {
      return [
        `${provider.label ?? provider.id} · no auto-include rules: a newly listed model is exposed as its picks say`,
      ];
    }
    return [
      `${provider.label ?? provider.id} · a newly listed model is exposed when one of these matches its id: ${(provider.autoInclude ?? []).join(" ")}`,
    ];
  });
}

function accountLabel(provider: GatewayProvider, account: GatewayAccount): string {
  const key = maskKey(account.apiKey ?? provider.apiKey ?? "");
  return account.label !== undefined
    ? `${account.label} ${key} · ${account.id}`
    : `${key} ${account.id}`;
}

export async function runAccountModelsCommand(
  args: string[],
  options: StoreOptions,
): Promise<string[]> {
  if (args.length < 1) {
    invalid("neox provider account-models <id> [account|key [model ids…|all]]");
  }
  const [ref, accountRef, ...models] = args;
  return withGatewayStore(options, async (store) => {
    let provider = findGatewayProvider(store.get(), ref);
    if (accountRef !== undefined && models.length > 0) {
      const account = findAccount(provider, accountRef);
      const wanted =
        models.length === 1 && (models[0] === "all" || models[0] === "-") ? [] : models;
      const saved = await saveProvider(store, provider.id, (held) =>
        withAccount(held, account.id, (current) => ({ ...current, models: wanted })),
      );
      provider = saved.provider;
    }
    const accounts =
      accountRef === undefined ? accountsOf(provider) : [findAccount(provider, accountRef)];
    if (accounts.length === 0) {
      return [`${provider.label ?? provider.id} has no account or key`];
    }
    return accounts.map((account) =>
      (account.models ?? []).length === 0
        ? `${accountLabel(provider, account)} · every model ${provider.label ?? provider.id} serves`
        : `${accountLabel(provider, account)} · only ${(account.models ?? []).join(", ")}`,
    );
  });
}

function parseCap(value: string): number | undefined {
  const text = value.trim().toLowerCase();
  if (["off", "none", "no", "0"].includes(text)) {
    return undefined;
  }
  const percent = /^(\d+)%?$/.exec(text);
  if (percent === null || Number(percent[1]) < 1 || Number(percent[1]) > 99) {
    invalid(`a cap is a share from 1 to 99 (percent), or off, not "${value}"`);
  }
  return Number(percent[1]);
}

export async function runAccountCapCommand(
  args: string[],
  options: StoreOptions & { window?: string },
): Promise<string[]> {
  if (args.length < 1) {
    invalid(
      "neox provider account-cap <id> [account [percent|off]]\n       neox provider account-cap <id> <account> --window <name> [percent|none|default]",
    );
  }
  const [ref, accountRef, value] = args;
  return withGatewayStore(options, async (store) => {
    let provider = findGatewayProvider(store.get(), ref);
    if (accountsOf(provider).length === 0) {
      throw new Error(`${provider.label ?? provider.id} has no account to cap`);
    }
    if (accountRef !== undefined && value !== undefined) {
      const account = findAccount(provider, accountRef);
      const window = options.window;
      const saved = await saveProvider(store, provider.id, (held) =>
        withAccount(held, account.id, (current) => {
          if (window === undefined) {
            const capPercent = parseCap(value);
            return capPercent === undefined
              ? { ...current, capPercent: undefined, capWindows: undefined }
              : { ...current, capPercent };
          }
          const windows = { ...current.capWindows };
          const text = value.trim().toLowerCase();
          if (text === "default" || text === "-") {
            delete windows[window];
          } else if (["none", "off", "no", "100", "100%"].includes(text)) {
            windows[window] = 100;
          } else {
            const cap = parseCap(value);
            if (cap === undefined) {
              delete windows[window];
            } else {
              windows[window] = cap;
            }
          }
          return {
            ...current,
            capWindows: Object.keys(windows).length === 0 ? undefined : windows,
          };
        }),
      );
      provider = saved.provider;
    }
    const accounts =
      accountRef === undefined ? accountsOf(provider) : [findAccount(provider, accountRef)];
    if (accounts.length === 0) {
      return [`${provider.label ?? provider.id} has no account`];
    }
    return accounts.flatMap((account) => {
      const lines: string[] = [];
      if (account.capPercent !== undefined) {
        lines.push(`${account.id} · capped at ${account.capPercent}% of each usage window`);
      } else if (Object.keys(account.capWindows ?? {}).length > 0) {
        lines.push(`${account.id} · no cap on its other windows: used to 100%`);
      } else {
        lines.push(`${account.id} · no cap: used to 100%`);
      }
      for (const [window, cap] of Object.entries(account.capWindows ?? {})) {
        lines.push(
          cap >= 100 ? `  ${window} · no cap on this window` : `  ${window} · capped at ${cap}%`,
        );
      }
      return lines;
    });
  });
}

export async function runPoolCommand(
  ref: string,
  options: StoreOptions & {
    accounts?: string;
    cap?: string;
    stop?: string;
    careful?: string;
  },
): Promise<string[]> {
  return withGatewayStore(options, async (store) => {
    let provider = findGatewayProvider(store.get(), ref);
    if (accountsOf(provider).length === 0) {
      throw new Error(`${provider.label ?? provider.id} has no accounts to pool`);
    }
    if (
      options.accounts !== undefined ||
      options.cap !== undefined ||
      options.stop !== undefined ||
      options.careful !== undefined
    ) {
      const named =
        options.accounts === undefined
          ? undefined
          : options.accounts
              .split(",")
              .map((name) => name.trim())
              .filter((name) => name.length > 0);
      if (named !== undefined && named.length === 0) {
        invalid("--accounts names at least one account");
      }
      const saved = await saveProvider(store, provider.id, (held) => {
        let accounts = accountsOf(held);
        if (named !== undefined) {
          const ids = named.map((name) => findAccount(held, name).id);
          const inUse = new Set(ids);
          const indexed = new Map(accounts.map((account) => [account.id, account]));
          const chosen = ids.flatMap((id) => {
            const account = indexed.get(id);
            return account === undefined ? [] : [account];
          });
          const ordered = [...chosen, ...accounts.filter((account) => !inUse.has(account.id))];
          accounts = ordered.map((account) =>
            Object.assign({}, account, { enabled: inUse.has(account.id) }),
          );
        }
        if (options.cap !== undefined) {
          const cap = parseCap(options.cap);
          const inUse =
            named === undefined ? accounts : accounts.filter((account) => account.enabled);
          const chosen = new Set(inUse.map((account) => account.id));
          accounts = accounts.map((account) =>
            chosen.has(account.id)
              ? { ...account, capPercent: cap, capWindows: undefined }
              : account,
          );
        }
        return {
          ...held,
          accounts,
          ...(options.stop === undefined ? {} : { stopAtCap: parseOnOff(options.stop) }),
          ...(options.careful === undefined ? {} : { capCareful: parseOnOff(options.careful) }),
        };
      });
      provider = saved.provider;
    }
    const accounts = accountsOf(provider);
    const lines = accounts.map((account) =>
      account.enabled
        ? `${account.id} · in use${account.capPercent === undefined ? "" : `, capped at ${account.capPercent}%`}`
        : `${account.id} · out of the pool`,
    );
    lines.push(
      provider.stopAtCap === true
        ? "at the caps it answers 429 rather than go on to the fallbacks"
        : "at the caps it goes on to the fallbacks",
    );
    lines.push(
      provider.capCareful === true
        ? "near a cap usage is read again, and an account held while its usage can't be told"
        : "usage is read as it comes",
    );
    return lines;
  });
}

export async function runAccountConcurrencyCommand(
  args: string[],
  options: StoreOptions,
): Promise<string[]> {
  if (args.length < 1) {
    invalid("neox provider account-concurrency <id> [account|key [n|off|default]]");
  }
  const [ref, accountRef, value] = args;
  return withGatewayStore(options, async (store) => {
    let provider = findGatewayProvider(store.get(), ref);
    if (accountRef !== undefined && value !== undefined) {
      const account = findAccount(provider, accountRef);
      const text = value.trim().toLowerCase();
      const maxConcurrency =
        text === "default" || text === "plugin"
          ? undefined
          : parseWhole(value, "limit", true) || undefined;
      const saved = await saveProvider(store, provider.id, (held) =>
        withAccount(held, account.id, (current) => ({ ...current, maxConcurrency })),
      );
      provider = saved.provider;
    }
    const accounts =
      accountRef === undefined ? accountsOf(provider) : [findAccount(provider, accountRef)];
    if (accounts.length === 0) {
      return [`${provider.label ?? provider.id} has no account or key`];
    }
    return accounts.map((account) =>
      account.maxConcurrency !== undefined
        ? `${accountLabel(provider, account)} · at most ${account.maxConcurrency} at once (its own)`
        : `${accountLabel(provider, account)} · no limit at once`,
    );
  });
}

export function parseSpendPeriod(value: string | undefined): "day" | "month" | "total" {
  switch ((value ?? "day").trim().toLowerCase()) {
    case "day":
    case "daily":
      return "day";
    case "month":
    case "monthly":
      return "month";
    case "total":
    case "all":
      return "total";
    default:
      invalid(`a spend cap is a day (the default), a month or total, not "${value}"`);
  }
}

export function spendPeriodLabel(period: "day" | "month" | "total"): string {
  switch (period) {
    case "month":
      return "this month";
    case "total":
      return "in all";
    default:
      return "today";
  }
}

export async function runSpendCapCommand(args: string[], options: StoreOptions): Promise<string[]> {
  if (args.length < 1 || args.length > 4) {
    invalid("neox provider spend-cap <id> [key [usd [day|month|total]|off]]");
  }
  const [ref, keyRef, usdText, periodText] = args;
  return withGatewayStore(options, async (store) => {
    let provider = findGatewayProvider(store.get(), ref);
    if (accountsOf(provider).some((account) => account.agent !== undefined)) {
      throw new Error(
        `${provider.label ?? provider.id} is a subscription: a spend cap is for an API key (an account's cap is a share of its usage windows, neox provider account-cap)`,
      );
    }
    if (keyRef !== undefined && usdText !== undefined) {
      const account = findAccount(provider, keyRef);
      const text = usdText.trim().toLowerCase();
      const usd = Number(text);
      if (text !== "off" && (Number.isNaN(usd) || usd < 0)) {
        invalid(`a spend cap is in USD, or off, not "${usdText}"`);
      }
      const period = text === "off" ? "day" : parseSpendPeriod(periodText);
      const saved = await saveProvider(store, provider.id, (held) =>
        withAccount(held, account.id, (current) =>
          text === "off"
            ? { ...current, spendCap: undefined }
            : { ...current, spendCap: { usd, period } },
        ),
      );
      provider = saved.provider;
    }
    const accounts = keyRef === undefined ? accountsOf(provider) : [findAccount(provider, keyRef)];
    if (accounts.length === 0) {
      return [`${provider.label ?? provider.id} has no key`];
    }
    return accounts.map((account) => {
      const cap = account.spendCap;
      if (cap === undefined) {
        return `${accountLabel(provider, account)} · no spend cap`;
      }
      return `${accountLabel(provider, account)} · $${cap.usd.toFixed(2)} ${spendPeriodLabel(cap.period)}`;
    });
  });
}

export async function runAccountWeightCommand(
  args: string[],
  options: StoreOptions,
): Promise<string[]> {
  if (args.length < 1 || args.length > 3) {
    invalid("neox provider account-weight <id> [account [n|default]]");
  }
  const [ref, accountRef, value] = args;
  return withGatewayStore(options, async (store) => {
    let provider = findGatewayProvider(store.get(), ref);
    if (accountRef !== undefined && value !== undefined) {
      const account = findAccount(provider, accountRef);
      const text = value.trim().toLowerCase();
      const weight = text === "default" || text === "1" ? 1 : Number.parseFloat(text);
      if (!Number.isFinite(weight) || weight <= 0) {
        invalid(`a weight is a positive number, or default, not "${value}"`);
      }
      const saved = await saveProvider(store, provider.id, (held) =>
        withAccount(held, account.id, (current) => ({ ...current, weight })),
      );
      provider = saved.provider;
    }
    const accounts =
      accountRef === undefined ? accountsOf(provider) : [findAccount(provider, accountRef)];
    if (accounts.length === 0) {
      return [`${provider.label ?? provider.id} has no account`];
    }
    const lines = accounts.map((account) =>
      account.weight > 1 ? `${account.id} · weight ${account.weight}` : `${account.id} · weight 1`,
    );
    if (provider.routing !== "weight") {
      lines.push(
        `Weights count with routing=weight: neox provider set ${provider.id} routing=weight`,
      );
    }
    return lines;
  });
}

export async function runQueueCommand(args: string[], options: StoreOptions): Promise<string[]> {
  if (args.length < 1 || args.length > 3) {
    invalid("neox provider queue <id> [length [seconds]]");
  }
  const [ref, lengthText, secondsText] = args;
  return withGatewayStore(options, async (store) => {
    let provider = findGatewayProvider(store.get(), ref);
    if (lengthText !== undefined) {
      const queueLength = parseWhole(lengthText, "queue length", true) ?? 0;
      const queueWaitMs =
        secondsText === undefined
          ? provider.queueWaitMs
          : (parseWhole(secondsText, "wait in seconds", true) ?? 0) * 1_000;
      const saved = await saveProvider(store, provider.id, (held) => ({
        ...held,
        queueLength,
        queueWaitMs,
      }));
      provider = saved.provider;
    }
    const length = (provider.queueLength ?? 0) > 0 ? String(provider.queueLength) : "no bound";
    const wait =
      provider.queueWaitMs > 0
        ? `${Math.round(provider.queueWaitMs / 1_000)}s`
        : "as long as it takes";
    return [
      `${provider.label ?? provider.id} · queue for each account or key: ${length} waiting, each for ${wait}`,
    ];
  });
}

export async function runRpmCommand(args: string[], options: StoreOptions): Promise<string[]> {
  if (args.length < 1 || args.length > 2) {
    invalid("neox provider rpm <id> [n|off]");
  }
  const [ref, value] = args;
  return withGatewayStore(options, async (store) => {
    let provider = findGatewayProvider(store.get(), ref);
    if (value !== undefined) {
      const maxRpm = parseWhole(value, "requests a minute", true) || undefined;
      const saved = await saveProvider(store, provider.id, (held) => {
        const accounts = accountsOf(held).map((account) => Object.assign({}, account, { maxRpm }));
        return { ...held, accounts };
      });
      provider = saved.provider;
    }
    const limit = accountsOf(provider).find((account) => account.maxRpm !== undefined)?.maxRpm;
    return [
      limit === undefined
        ? `${provider.label ?? provider.id} · each account or key: no limit on requests a minute`
        : `${provider.label ?? provider.id} · each account or key: at most ${limit} requests a minute`,
    ];
  });
}

export async function runAtOnceCommand(args: string[], options: StoreOptions): Promise<string[]> {
  if (args.length < 1 || args.length > 2) {
    invalid("neox provider at-once <id> [n|off|default]");
  }
  const [ref, value] = args;
  return withGatewayStore(options, async (store) => {
    let provider = findGatewayProvider(store.get(), ref);
    if (value !== undefined) {
      const text = value.trim().toLowerCase();
      const maxAccounts =
        text === "default" || text === "plugin"
          ? undefined
          : parseWhole(value, "accounts at once", true) || undefined;
      const saved = await saveProvider(store, provider.id, (held) => ({
        ...held,
        maxAccounts,
      }));
      provider = saved.provider;
    }
    if (provider.maxAccounts !== undefined) {
      return [
        `${provider.label ?? provider.id} · ${provider.maxAccounts} of its accounts or keys take requests at once, the first in the list; the others wait in reserve`,
      ];
    }
    return [`${provider.label ?? provider.id} · every account or key takes requests`];
  });
}

export async function runQuotaRestCommand(
  args: string[],
  options: StoreOptions,
): Promise<string[]> {
  if (args.length === 3 && (args[1] === "until" || args[1] === "at")) {
    args = [args[0] as string, args[2] as string];
  }
  if (args.length < 1 || args.length > 2) {
    invalid("neox provider quota-rest <id> [30m|6h|7d|until 08:00|until 00:00+08:00|default]");
  }
  const [ref, value] = args;
  return withGatewayStore(options, async (store) => {
    let provider = findGatewayProvider(store.get(), ref);
    if (value !== undefined) {
      let quotaRest: GatewayProvider["quotaRest"];
      if (value.includes(":")) {
        if (!/^\d{1,2}:\d{2}(?:[+-]\d{2}:\d{2})?$/.test(value)) {
          invalid(`quota-rest=until takes a time such as 08:00 or 00:00+08:00, not "${value}"`);
        }
        quotaRest = { resetAt: value };
      } else {
        const text = value.trim().toLowerCase();
        const seconds =
          text === "default" || text === "off" || text === "none" || text === "-"
            ? undefined
            : Math.round(parseDurationMs(text) / 1_000);
        if (seconds !== undefined && seconds > 8 * 86_400) {
          invalid("quota-rest is at most 8 days");
        }
        quotaRest = seconds === undefined ? undefined : { seconds };
      }
      const saved = await saveProvider(store, provider.id, (held) => ({ ...held, quotaRest }));
      provider = saved.provider;
    }
    const name = provider.label ?? provider.id;
    if (provider.quotaRest?.resetAt !== undefined) {
      return [
        `${name} · a key out of its allowance, with no word of when it is back, sits out until ${provider.quotaRest.resetAt}`,
      ];
    }
    if ((provider.quotaRest?.seconds ?? 0) > 0) {
      return [
        `${name} · a key out of its allowance, with no word of when it is back, sits out ${restWords(
          Math.round((provider.quotaRest?.seconds ?? 0) / 60),
        )}`,
      ];
    }
    return [
      `${name} · a key out of its allowance, with no word of when it is back, sits out 15 minutes (Neox's own)`,
    ];
  });
}

export async function runRestCapCommand(args: string[], options: StoreOptions): Promise<string[]> {
  if (args.length < 1 || args.length > 2) {
    invalid("neox provider rest-cap <id> [1m|30m|6h|1d|off|default]");
  }
  const [ref, value] = args;
  return withGatewayStore(options, async (store) => {
    let provider = findGatewayProvider(store.get(), ref);
    if (value !== undefined) {
      const text = value.trim().toLowerCase();
      let restCapMs: number | undefined;
      if (text === "off" || text === "never" || text === "no") {
        restCapMs = 0;
      } else if (text === "default" || text === "-") {
        restCapMs = undefined;
      } else {
        const minutes = parseRestMinutes(text);
        if (minutes <= 0) {
          invalid("the shortest rest cap is 1m, or default");
        }
        if (minutes > 8 * 24 * 60) {
          invalid("rest-cap is at most 8 days");
        }
        restCapMs = minutes * 60_000;
      }
      const saved = await saveProvider(store, provider.id, (held) => ({ ...held, restCapMs }));
      provider = saved.provider;
    }
    const name = provider.label ?? provider.id;
    if (provider.restCapMs === 0) {
      return [
        `${name} · a key or account that fails without saying why doesn't rest: the next request asks it again. Out of quota or credit, its key refused or its model not served still rests it; rate limited, at most 30 minutes (Neox's own)`,
      ];
    }
    if ((provider.restCapMs ?? 0) > 0) {
      return [
        `${name} · a key or account that keeps failing sits out at most ${restWords(
          Math.round((provider.restCapMs ?? 0) / 60_000),
        )}`,
      ];
    }
    return [
      `${name} · a key or account that keeps failing sits out at most 10 minutes, 30 when rate limited (Neox's own)`,
    ];
  });
}

export async function runListedCommand(args: string[], options: StoreOptions): Promise<string[]> {
  if (args.length !== 2 || (args[1] !== "yes" && args[1] !== "no")) {
    invalid("neox provider listed <id> yes|no");
  }
  const [ref, value] = args;
  return withGatewayStore(options, async (store) => {
    const saved = await saveProvider(store, ref, (provider) => ({
      ...provider,
      exposeModels: value === "no" ? false : undefined,
    }));
    return [
      value === "no"
        ? `✓ ${saved.provider.label ?? saved.provider.id} · serves only through routing groups`
        : `✓ ${saved.provider.label ?? saved.provider.id} · its models are listed`,
    ];
  });
}

export async function runOnOffCommand(
  verb: "off" | "on",
  args: string[],
  options: StoreOptions,
): Promise<string[]> {
  if (args.length !== 1) {
    invalid(`neox provider ${verb} <id>`);
  }
  return withGatewayStore(options, async (store) => {
    const saved = await saveProvider(store, args[0] as string, (provider) => ({
      ...provider,
      enabled: verb === "on" ? undefined : false,
    }));
    const name = saved.provider.label ?? saved.provider.id;
    return [
      verb === "off"
        ? `✓ ${name} is switched off: agents are given none of its models`
        : `✓ ${name} is switched on`,
    ];
  });
}

export async function runRemoveCommand(args: string[], options: StoreOptions): Promise<string[]> {
  if (args.length !== 1) {
    invalid("neox provider rm <id>");
  }
  return withGatewayStore(options, async (store) => {
    const removed = await removeProviderFromStore(store, args[0] as string);
    return [`✓ removed ${removed.provider.label ?? removed.provider.id}`];
  });
}

// One row per setting, as myna's showProvider prints them.
// eslint-disable-next-line complexity
export function showProvider(provider: GatewayProvider): string[] {
  const lines: string[] = [];
  const name = `${provider.label ?? provider.id}  ${provider.id}${
    provider.website === undefined ? "" : `  ${provider.website}`
  }`;
  lines.push(`  ${name}`);
  const kv = (key: string, value: string | undefined, note = "") => {
    if (value !== undefined && value !== "") {
      lines.push(`  ${key.padEnd(10)} ${value}${note}`);
    }
  };
  kv(provider.protocol, provider.baseUrl);
  if (provider.searches === true) {
    kv("search", "by itself", "  a client's web search goes to it as sent");
  }
  if (provider.passUserAgent === true) {
    kv("user-agent", "agent's", "  the User-Agent the agent gave, not Neox's");
  }
  if (provider.unredacted === true) {
    kv("unmasked", "yes", "  Settings' redaction leaves its requests as written");
  }
  if (provider.countFree) {
    kv("free", "yes", "  counted free by Free first and Cheapest routing");
  }
  if (provider.nativeCompaction === true) {
    kv("compaction", "native", "  Codex's own, sealed by the key or account that answers it");
  }
  kv("key", provider.apiKey === undefined ? undefined : maskKey(provider.apiKey));
  kv(
    "access key",
    provider.accessKeyId === undefined ? undefined : maskKey(provider.accessKeyId),
    provider.secretAccessKey === undefined ? "" : "  with its secret",
  );
  kv("decide", provider.decide, "  routes groups");
  kv("catalog", provider.catalog);
  kv("keys", provider.keysUrl);
  kv(
    "balance",
    provider.balanceUrl,
    provider.balancePath === undefined ? "" : `  ${provider.balancePath}`,
  );
  for (const [header, value] of Object.entries(provider.headers ?? {})) {
    kv("header", `${header}: ${value}`);
  }
  if (provider.refreshEveryMs !== undefined) {
    kv(
      "refresh",
      `every ${restWords(Math.round(provider.refreshEveryMs / 60_000))}`,
      "  the gateway fetches its list by itself",
    );
  }
  if ((provider.autoInclude ?? []).length > 0) {
    kv(
      "include",
      (provider.autoInclude ?? []).join(" "),
      "  newly listed models these match are exposed",
    );
  }
  const exposed = exposedModels(provider);
  kv(
    "models",
    `${exposed.length} exposed of ${provider.models.length}${provider.modelMode === undefined ? "" : ` · ${provider.modelMode}`}`,
  );
  for (const id of exposed.slice(0, 12)) {
    lines.push(`             ${provider.id}/${id}`);
  }
  if (exposed.length > 12) {
    lines.push(`             … ${exposed.length - 12} more`);
  }
  if ((provider.fallback ?? []).length > 0) {
    kv("fallback", (provider.fallback ?? []).join(" → "));
  }
  return lines;
}

export type LiveDetails = (provider: GatewayProvider) => Promise<string[]>;

/**
 * `provider <id>` with a daemon: its balance, when it has a balance endpoint.
 * No daemon (or an old one, or a failed ask) leaves the offline row alone —
 * myna asks the vendor directly, this CLI asks the daemon so its proxy,
 * masking and key handling apply. Upstream status is not repeated here:
 * Neolix shows it elsewhere already, and myna's show has no such row.
 */
async function liveProviderDetails(
  provider: GatewayProvider,
  options: StoreOptions,
): Promise<string[]> {
  // myna's show asks the vendor for the balance whenever the provider has a
  // balance query, and prints "unavailable" with why when it cannot (its
  // providers_cli.go showProvider); with no balance query it says nothing.
  const unavailable = (why: string): string[] =>
    provider.balanceUrl === undefined ? [] : [`  balance    unavailable  ${why}`];
  if (options.daemonTarget === undefined) {
    return unavailable("no daemon to ask through");
  }
  try {
    const client = await connectToDaemon({ target: options.daemonTarget });
    try {
      const lines: string[] = [];
      if (provider.balanceUrl !== undefined) {
        const payload = await client.getGatewayProviderBalance({
          balanceUrl: provider.balanceUrl,
          ...(provider.balancePath === undefined ? {} : { balancePath: provider.balancePath }),
          ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
          ...(provider.headers === undefined ? {} : { headers: provider.headers }),
          ...(provider.balanceMethod === undefined ? {} : { method: provider.balanceMethod }),
          ...(provider.balanceToken === undefined ? {} : { token: provider.balanceToken }),
        });
        lines.push(
          payload.amount === null || payload.amount === undefined
            ? `  balance    unavailable${payload.error === undefined ? "" : `  ${payload.error}`}`
            : `  balance    ${payload.amount}`,
        );
      }
      return lines;
    } finally {
      await client.close().catch(() => undefined);
    }
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

export async function runShowCommand(
  ref: string,
  options: StoreOptions,
  live: LiveDetails = (provider) => liveProviderDetails(provider, options),
): Promise<string[]> {
  return withGatewayStore(options, async (store) => {
    const provider = findGatewayProvider(store.get(), ref);
    return [...showProvider(provider), ...(await live(provider))];
  });
}

export function runPresetsCommand(): string[] {
  const lines: string[] = [];
  for (const preset of GATEWAY_PROVIDER_PRESETS) {
    const vertex =
      preset.vertex === true ? `neox provider add ${preset.id} project=<project id>` : undefined;
    const state = vertex ?? `neox provider add ${preset.id} <key>`;
    lines.push(`  ${preset.name.padEnd(28)} ${preset.id.padEnd(14)} ${state}`);
  }
  return lines;
}

/* ------------------------------- runtime -------------------------------- */

export async function runTestCommand(
  ref: string,
  models: string[],
  options: StoreOptions & { as?: string },
  deps: TestDeps = {},
): Promise<{ lines: string[]; ok: boolean }> {
  const provider = await withGatewayStore(options, async (store) =>
    findGatewayProvider(store.get(), ref),
  );
  const lines: string[] = [];
  if (models.length > 0) {
    const testModel =
      deps.testModel ?? ((held, model) => testModelFromDaemon(held, model, options));
    let ok = true;
    for (const model of models) {
      const result = await testModel(provider, model);
      if (result.ok) {
        lines.push(`  ✓ ${provider.protocol.padEnd(10)} ${result.latencyMs} ms · ${model}`);
      } else {
        ok = false;
        const status = result.status === 0 ? "" : `${result.status} · `;
        lines.push(`  ✗ ${provider.protocol.padEnd(10)} ${model} · ${status}${result.error ?? ""}`);
      }
    }
    return { lines, ok };
  }
  const detect = deps.detect ?? ((held) => detectFromDaemon(held, options));
  const results = await detect(provider);
  if (results.length === 0) {
    return { lines: [`  ✗ ${provider.protocol.padEnd(10)} no endpoint answered`], ok: false };
  }
  let ok = true;
  for (const result of results) {
    if (result.ok) {
      lines.push(`  ✓ ${result.protocol.padEnd(10)} ${result.status}`);
    } else {
      ok = false;
      const status = result.status === 0 ? "" : `${result.status} · `;
      lines.push(`  ✗ ${result.protocol.padEnd(10)} ${status}${result.error ?? ""}`);
    }
  }
  return { lines, ok };
}

async function testModelFromDaemon(
  provider: GatewayProvider,
  model: string,
  options: StoreOptions,
): Promise<{ ok: boolean; status: number; latencyMs: number; error: string | null }> {
  const client = await connectToDaemon({ target: daemonTargetOf(options) });
  try {
    return await client.testGatewayProviderModel(probeTarget(provider), model);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function detectFromDaemon(
  provider: GatewayProvider,
  options: StoreOptions,
): Promise<Array<{ protocol: string; ok: boolean; status: number; error: string | null }>> {
  const client = await connectToDaemon({ target: daemonTargetOf(options) });
  try {
    const payload = await client.detectGatewayProviderProtocols(probeTarget(provider));
    return payload.results;
  } finally {
    await client.close().catch(() => undefined);
  }
}

/* ----------------------------- registration ------------------------------ */

/** myna's `myna providers`, as its own top-level command. */
export function createProvidersCommand(): Command {
  const command = addLocalDaemonOptions(
    new Command("providers").description("List gateway providers, their keys and models"),
  );
  command.action(
    withGlobalOptions(async (options: HomeOptions, source: Command) => {
      const merged = source.optsWithGlobals() as HomeOptions & { json?: boolean; format?: string };
      try {
        if (merged.json === true || merged.format === "json") {
          process.stdout.write(`${JSON.stringify(await runProvidersJson(merged), null, 2)}\n`);
          return;
        }
        print(await runProvidersCommand(merged ?? options));
      } catch (error) {
        fail(error);
      }
    }),
  );
  return command;
}

/** myna's `myna presets`. */
export function createPresetsCommand(): Command {
  const command = new Command("presets").description("List the vendors Neox knows out of the box");
  command.action(() => {
    print(runPresetsCommand());
  });
  return command;
}

export function addGatewayProviderCommands(provider: Command): void {
  addLocalDaemonOptions(
    provider
      .command("add")
      .description("Add a provider from a preset or a custom vendor")
      .argument("<name>", "Preset id (neox presets) or a name for a custom vendor")
      .argument("[pairs...]", "Its key, then k=v pairs (url=, key=, header.X-Foo=, …)"),
  ).action(localAction(runAddCommand));

  addLocalDaemonOptions(
    provider
      .command("set")
      .description("Change a provider's settings")
      .argument("<id>", "Provider id or name")
      .argument("<pairs...>", "k=v pairs, the same as add"),
  ).action(localAction(runSetCommand));

  addLocalDaemonOptions(
    provider
      .command("key")
      .description("Change the API key")
      .argument("<id>", "Provider id or name")
      .argument("<key>", "The new key"),
  ).action(localAction(runKeyCommand));

  addLocalDaemonOptions(
    provider
      .command("icon")
      .description("Give a custom provider a picture or a built-in icon")
      .argument("<id>", "Provider id or name")
      .argument("<icon>", 'A picture file, a built-in icon\'s name, or ""'),
  ).action(localAction(runIconCommand));

  addLocalDaemonOptions(
    provider
      .command("fallback")
      .description("Where requests go when this provider is out of quota, rate limited or down")
      .argument("<id>", "Provider id or name")
      .argument("[fallbacks...]", "provider/model or group/<id>, or none"),
  ).action(localAction(runFallbackCommand));

  addLocalDaemonOptions(
    provider
      .command("refresh")
      .description("Fetch the vendor's model list again")
      .argument("<id>", "Provider id or name"),
  ).action(
    localAction((args: string[], options: HomeOptions) =>
      runRefreshCommand(args[0] as string, options),
    ),
  );

  addLocalDaemonOptions(
    provider
      .command("refresh-every")
      .description("Have the gateway fetch its model list again by itself")
      .argument("<id>", "Provider id or name")
      .argument("[every]", "30m, 6h, 1d or off (at least 10m)"),
  ).action(localAction(runRefreshEveryCommand));

  addLocalDaemonOptions(
    provider
      .command("auto-include")
      .description("Rules a newly listed model is exposed by")
      .argument("<id>", "Provider id or name")
      .argument("[rules...]", "Globs such as 'gpt-*', re:… regular expressions, or none"),
  ).action(localAction(runAutoIncludeCommand));

  addLocalDaemonOptions(
    provider
      .command("account-models")
      .description("The models one account or key alone serves")
      .argument("<id>", "Provider id or name")
      .argument("[account]", "Account or key id")
      .argument("[models...]", "Model ids, or all"),
  ).action(localAction(runAccountModelsCommand));

  addLocalDaemonOptions(
    provider
      .command("account-cap")
      .description("Use a subscription account up to a share of its usage windows")
      .argument("<id>", "Provider id or name")
      .argument("[account]", "Account id")
      .argument("[value]", "A percent, off, or a window's percent, none or default")
      .option("--window <name>", 'One usage window alone, such as "5 hours"'),
  ).action(
    withGlobalOptions(
      async (
        ref: string,
        account: string | undefined,
        value: string | undefined,
        _options: { window?: string },
        command: Command,
      ) => {
        const options = command.optsWithGlobals() as HomeOptions & { window?: string };
        try {
          print(
            await runAccountCapCommand(
              [ref, account, value].filter((part): part is string => part !== undefined),
              options,
            ),
          );
        } catch (error) {
          fail(error);
        }
      },
    ),
  );

  addLocalDaemonOptions(
    provider
      .command("pool")
      .description("A subscription's accounts as one pool")
      .argument("<id>", "Provider id or name")
      .option("--accounts <list>", "Accounts in use, in that order, comma separated")
      .option("--cap <percent|off>", "Cap each account in use")
      .option("--stop <on|off>", "Answer 429 at the caps instead of going on to the fallbacks")
      .option("--careful <on|off>", "Read usage again near a cap, and hold what can't be read"),
  ).action(
    withGlobalOptions(
      async (
        ref: string,
        options: {
          accounts?: string;
          cap?: string;
          stop?: string;
          careful?: string;
        },
        command: Command,
      ) => {
        try {
          print(await runPoolCommand(ref, { ...command.optsWithGlobals(), ...options }));
        } catch (error) {
          fail(error);
        }
      },
    ),
  );

  addLocalDaemonOptions(
    provider
      .command("account-concurrency")
      .description("How many requests one account or key has out at once")
      .argument("<id>", "Provider id or name")
      .argument("[account]", "Account or key id")
      .argument("[value]", "A whole number, off or default"),
  ).action(localAction(runAccountConcurrencyCommand));

  addLocalDaemonOptions(
    provider
      .command("spend-cap")
      .description("How much an API key may spend, in USD")
      .argument("<id>", "Provider id or name")
      .argument("[key]", "Account or key id")
      .argument("[usd]", "The cap in USD, or off")
      .argument("[period]", "day (the default), month or total"),
  ).action(localAction(runSpendCapCommand));

  addLocalDaemonOptions(
    provider
      .command("account-weight")
      .description("A subscription account's share of the requests with routing=weight")
      .argument("<id>", "Provider id or name")
      .argument("[account]", "Account id")
      .argument("[value]", "A positive number, or default"),
  ).action(localAction(runAccountWeightCommand));

  addLocalDaemonOptions(
    provider
      .command("queue")
      .description("How many may wait for each account or key past its limit, and how long")
      .argument("<id>", "Provider id or name")
      .argument("[length]", "How many may wait, or off")
      .argument("[seconds]", "How long each waits, in seconds"),
  ).action(localAction(runQueueCommand));

  addLocalDaemonOptions(
    provider
      .command("rpm")
      .description("How many requests each account or key sends in any minute")
      .argument("<id>", "Provider id or name")
      .argument("[value]", "A whole number, or off"),
  ).action(localAction(runRpmCommand));

  addLocalDaemonOptions(
    provider
      .command("at-once")
      .description("How many accounts or keys take requests at the same time")
      .argument("<id>", "Provider id or name")
      .argument("[value]", "A whole number, off or default"),
  ).action(localAction(runAtOnceCommand));

  addLocalDaemonOptions(
    provider
      .command("quota-rest")
      .description("How long a key sits out when the vendor names no reset time")
      .argument("<id>", "Provider id or name")
      .argument("[value...]", "30m, 6h, 7d, until 08:00, or default"),
  ).action(localAction(runQuotaRestCommand));

  addLocalDaemonOptions(
    provider
      .command("rest-cap")
      .description("The most a key or account sits out while it keeps failing")
      .argument("<id>", "Provider id or name")
      .argument("[value]", "1m, 30m, 6h, 1d, off or default"),
  ).action(localAction(runRestCapCommand));

  addLocalDaemonOptions(
    provider
      .command("listed")
      .description("Whether its models are listed to agents")
      .argument("<id>", "Provider id or name")
      .argument("<yes|no>", "no: served only through routing groups"),
  ).action(localAction(runListedCommand));

  addLocalDaemonOptions(
    provider
      .command("off")
      .description("Switch a provider off, keeping its keys and settings")
      .argument("<id>", "Provider id or name"),
  ).action(
    localAction((args: string[], options: HomeOptions) => runOnOffCommand("off", args, options)),
  );

  addLocalDaemonOptions(
    provider
      .command("on")
      .description("Switch a provider on again")
      .argument("<id>", "Provider id or name"),
  ).action(
    localAction((args: string[], options: HomeOptions) => runOnOffCommand("on", args, options)),
  );

  addJsonAndDaemonHostOptions(
    provider
      .command("test")
      .description("Send a tiny request through each endpoint, or to each model")
      .argument("<id>", "Provider id or name")
      .argument("[models...]", "Model ids to test")
      .option("--as <agent>", "Ask it as codex or claude-code does"),
  ).action(
    withGlobalOptions(
      async (ref: string, models: string[], options: { as?: string }, command: Command) => {
        const merged = command.optsWithGlobals() as HomeOptions & { as?: string };
        try {
          const result = await runTestCommand(ref, models, { ...merged, ...options });
          print(result.lines);
          if (!result.ok) {
            process.exitCode = 1;
          }
        } catch (error) {
          fail(error);
        }
      },
    ),
  );

  addLocalDaemonOptions(
    provider
      .command("rm")
      .alias("remove")
      .alias("delete")
      .description("Remove a provider")
      .argument("<id>", "Provider id or name"),
  ).action(localAction(runRemoveCommand));

  // myna's `provider <id>`: the default command catches an id that is no
  // verb, and says the usage for anything else.
  provider
    .command("*", { hidden: true, isDefault: true })
    .argument("[args...]")
    .action(
      withGlobalOptions(async (args: string[], options: HomeOptions, _command: Command) => {
        try {
          if (args.length === 0) {
            process.stderr.write(`${PROVIDER_USAGE}\n`);
            process.exitCode = 1;
            return;
          }
          if (args.length > 1) {
            invalid(`neox provider <id>   (neox provider --help lists the verbs)`);
          }
          print(await runShowCommand(args[0] as string, options));
        } catch (error) {
          fail(error);
        }
      }),
    );
}
