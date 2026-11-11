import chalk from "chalk";
import { Command } from "commander";
import type { Logger } from "pino";
import { resolveNeolixHome } from "@neolix/server/daemon-control";
import { GatewayConfigStore } from "@neolix/server/gateway-config";
import type { GatewaySearchApiWire } from "@neolix/protocol/gateway";

/**
 * `neolix search` — myna's `myna search` (internal/cli/search_cli.go), over
 * this computer's gateway.json (`search.apis`). The daemon watches the file,
 * so no daemon is needed. Wording and usage are myna's, with neolix as the
 * command.
 */

interface VendorDef {
  id: string;
  name: string;
  base: string;
  /** What goes after the base to search. */
  paths: string[];
  keyOptional?: boolean;
}

/**
 * myna's SearchVendors, as `llm-gateway/search-apis.ts` serves them. Kept
 * here rather than imported so the CLI reads and writes gateway.json without
 * loading the daemon's gateway runtime.
 */
const VENDORS: readonly VendorDef[] = [
  { id: "tavily", name: "Tavily", base: "https://api.tavily.com", paths: ["/search"] },
  {
    id: "brave",
    name: "Brave Search",
    base: "https://api.search.brave.com",
    paths: ["/res/v1/web/search"],
  },
  { id: "exa", name: "Exa", base: "https://api.exa.ai", paths: ["/search"] },
  { id: "firecrawl", name: "Firecrawl", base: "https://api.firecrawl.dev", paths: ["/v2/search"] },
  {
    id: "you",
    name: "You.com",
    base: "https://ydc-index.io",
    paths: ["/v1/search", "/v1/agents/search"],
    keyOptional: true,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    base: "https://api.deepseek.com",
    paths: ["/v1/tools/search"],
  },
  {
    id: "volcengine",
    name: "Doubao Search (Volcengine)",
    base: "https://open.feedcoopapi.com",
    paths: ["/search_api/web_search"],
  },
  {
    id: "wsa",
    name: "Yuanbao Search (Tencent Cloud)",
    base: "https://api.wsa.cloud.tencent.com",
    paths: ["/SearchPro"],
  },
  { id: "searxng", name: "SearXNG", base: "", paths: ["/search"], keyOptional: true },
];

const searchUsage = `usage:
  neox search                              the search APIs a model's web search goes to
  neox search add <api> <key> [url=<address>] [pick=turns|order]
                                             add one, or give one a new key
                                             (several keys as k1,k2: searches take them in turn,
                                             or with pick=order the first until it is refused)
  neox search add searxng url=<address> [<key>]
  neox search add you [<key>]              You.com: free with no key (100 searches a day)
  neox search off <api>                    keep one, key and all, but never ask it
  neox search on <api>                     ask it again
  neox search move <api> <n>               put one at place n in the order they are asked
  neox search rm <api>                     take one away

  apis: tavily, brave, exa, firecrawl, you, deepseek, volcengine, wsa, searxng
        and the ones a plugin gives (its search hook), as <plugin>:<id> in Neox's Settings
        › Models › Web search; a plugin that is off gives none

  url= is the API's base URL, for an endpoint of your own that answers as that API
  does (e.g. url=https://search.example.com/tavily). Without it the vendor's own is
  used; a new key alone keeps the url set before, and url= with nothing after it puts
  the vendor's own back. Neox puts the API's path after it (/search for Tavily), so
  a url given with that path at its end is taken as its base. The key is sent only
  to that url.`;

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
} as unknown as Logger;

async function withStore<T>(work: (store: GatewayConfigStore) => Promise<T>): Promise<T> {
  const neolixHome = resolveNeolixHome({ NEOLIX_HOME: process.env.NEOLIX_HOME });
  const store = new GatewayConfigStore({ neolixHome, logger: silentLogger });
  await store.start();
  try {
    return await work(store);
  } finally {
    store.dispose();
  }
}

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function vendorOf(id: string): VendorDef | undefined {
  return VENDORS.find((vendor) => vendor.id === id);
}

function isPluginVendor(id: string): boolean {
  return /^[a-z0-9-]+:[a-z0-9-]+$/u.test(id);
}

function knownVendor(id: string): VendorDef | "plugin" {
  const vendor = vendorOf(id);
  if (vendor !== undefined) {
    return vendor;
  }
  if (isPluginVendor(id)) {
    return "plugin";
  }
  throw new Error(
    `no ${id} search API · apis: ${VENDORS.map((entry) => entry.id).join(", ")}, or <plugin>:<id>`,
  );
}

/** myna's provider.Mask for keys. */
function maskKey(value: string): string {
  if (value.length <= 8) {
    return "•".repeat(value.length);
  }
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function keysOf(api: GatewaySearchApiWire): string[] {
  const out: string[] = [];
  for (const key of (api.key ?? "").split(/[,;\s]+/u)) {
    if (key.length > 0 && !out.includes(key)) {
      out.push(key);
    }
  }
  return out;
}

function baseOf(api: GatewaySearchApiWire): string {
  const vendor = vendorOf(api.vendor);
  if (api.url === undefined || api.url.length === 0) {
    return vendor?.base ?? "";
  }
  let base = api.url.replace(/\/+$/u, "");
  for (const path of vendor?.paths ?? []) {
    if (base.length > path.length && base.toLowerCase().endsWith(path.toLowerCase())) {
      base = base.slice(0, base.length - path.length).replace(/\/+$/u, "");
      break;
    }
  }
  return base;
}

function readyOf(api: GatewaySearchApiWire): boolean {
  if (isPluginVendor(api.vendor)) {
    return (api.url ?? "").length > 0 && keysOf(api).length > 0;
  }
  const vendor = vendorOf(api.vendor);
  if (vendor === undefined) {
    return false;
  }
  return (
    (baseOf(api).length > 0 || vendor.id === "you") &&
    (keysOf(api).length > 0 || vendor.keyOptional === true)
  );
}

function nameOf(api: GatewaySearchApiWire): string {
  return vendorOf(api.vendor)?.name ?? api.vendor;
}

function apisOf(config: { search?: { apis?: GatewaySearchApiWire[] } }): GatewaySearchApiWire[] {
  return config.search?.apis ?? [];
}

async function searchList(): Promise<void> {
  const apis = await withStore(async (store) => apisOf(store.get()));
  if (apis.length === 0) {
    say(
      chalk.gray(
        "  no search API · neox search add <tavily|brave|exa|firecrawl|you|deepseek|volcengine|wsa|searxng> <key>",
      ),
    );
    return;
  }
  apis.forEach((api, index) => {
    const keys = keysOf(api);
    let what = api.key === undefined || api.key === "" ? "no key" : maskKey(api.key);
    if (api.url !== undefined && api.url !== "") {
      what += `  ${api.url}`;
    }
    if (keys.length > 1) {
      what += api.pick === "order" ? "  in order" : "  in turn";
    }
    let line = `  ${index + 1}. ${nameOf(api).padEnd(14)} ${chalk.gray(what)}`;
    if (!readyOf(api)) {
      line += `  ${chalk.gray("needs its key")}`;
    }
    if (api.off === true) {
      line += `  ${chalk.yellow("off")}`;
    }
    say(line);
  });
}

interface SearchArgs {
  vendor: string;
  key: string;
  url: string | undefined;
  /** Whether url= was given: url= with nothing after it clears the address. */
  urlGiven: boolean;
  pick: "" | "order";
}

/** myna's search add: url= with nothing after it puts the vendor's own back. */
function readAdd(args: string[]): SearchArgs {
  const vendor = args[0]?.trim().toLowerCase() ?? "";
  if (vendor === "") {
    throw new Error("neox search add <api> <key> [url=<address>]");
  }
  const add: SearchArgs = { vendor, key: "", url: undefined, urlGiven: false, pick: "" };
  for (const value of args.slice(1)) {
    if (value.startsWith("url=")) {
      const url = value.slice(4).trim();
      add.url = url === "" ? undefined : url.replace(/\/+$/u, "");
      add.urlGiven = true;
    } else if (value.startsWith("pick=")) {
      const pick = value.slice(5).trim();
      if (pick !== "" && pick !== "turns" && pick !== "order") {
        throw new Error(`pick=turns|order, not "${pick}"`);
      }
      add.pick = pick === "order" ? "order" : "";
    } else if (add.key === "") {
      add.key = value;
    } else {
      throw new Error("neox search add <api> <key> [url=<address>] [pick=turns|order]");
    }
  }
  if (args.length === 1) {
    throw new Error("neox search add <api> <key> [url=<address>]");
  }
  return add;
}

async function searchAdd(args: string[]): Promise<void> {
  const add = readAdd(args);
  knownVendor(add.vendor);
  await withStore(async (store) => {
    const config = store.get();
    const apis = [...apisOf(config)];
    const index = apis.findIndex((api) => api.vendor === add.vendor);
    const held = index < 0 ? undefined : apis[index];
    // A new key alone keeps the address set before (#1580); url= with
    // nothing after it puts the vendor's own back.
    const url = add.urlGiven ? add.url : held?.url;
    const api: GatewaySearchApiWire = { vendor: add.vendor };
    if (add.key !== "") {
      api.key = add.key;
    } else if (held?.key !== undefined) {
      api.key = held.key;
    }
    if (url !== undefined && url !== "") {
      api.url = url;
    }
    if (add.pick !== "") {
      api.pick = add.pick;
    }
    if (held?.off === true) {
      api.off = true;
    }
    const next = index < 0 ? [...apis, api] : apis.map((entry, at) => (at === index ? api : entry));
    await store.write({
      ...config,
      search: { ...(config.search ?? { enabled: false }), apis: next },
    });
    const at = next.findIndex((entry) => entry.vendor === add.vendor);
    say(
      `${chalk.green("✓")} ${nameOf(api)} ${chalk.gray(`search API ${at + 1} of ${next.length}`)}`,
    );
  });
}

async function searchOnOff(args: string[], on: boolean): Promise<void> {
  if (args.length !== 1) {
    throw new Error(`neox search ${on ? "on" : "off"} <api>`);
  }
  const vendor = args[0]!.trim().toLowerCase();
  knownVendor(vendor);
  await withStore(async (store) => {
    const config = store.get();
    const apis = apisOf(config);
    if (!apis.some((api) => api.vendor === vendor)) {
      throw new Error(`no ${vendor} search API is set up`);
    }
    const next = apis.map((api) => (api.vendor === vendor ? withSwitch(api, on) : api));
    await store.write({
      ...config,
      search: { ...(config.search ?? { enabled: false }), apis: next },
    });
    say(`${chalk.green("✓")} ${vendor} ${on ? "on" : "off"}`);
  });
}

function withSwitch(api: GatewaySearchApiWire, on: boolean): GatewaySearchApiWire {
  if (!on) {
    return { ...api, off: true };
  }
  const { off: _off, ...rest } = api;
  return rest;
}

async function searchMove(args: string[]): Promise<void> {
  if (args.length !== 2) {
    throw new Error("neox search move <api> <n>");
  }
  const vendor = args[0]!.trim().toLowerCase();
  const place = Number.parseInt(args[1]!, 10);
  await withStore(async (store) => {
    const config = store.get();
    const apis = apisOf(config);
    const index = apis.findIndex((api) => api.vendor === vendor);
    if (index < 0) {
      throw new Error(`no ${vendor} search API is set up`);
    }
    if (!Number.isFinite(place) || place < 1 || place > apis.length) {
      throw new Error(`neox search move <api> <n>, n from 1 to ${apis.length}`);
    }
    const next = [...apis];
    const [moved] = next.splice(index, 1);
    next.splice(place - 1, 0, moved!);
    await store.write({
      ...config,
      search: { ...(config.search ?? { enabled: false }), apis: next },
    });
    say(
      `${chalk.green("✓")} ${nameOf(moved!)} ${chalk.gray(`search API ${place} of ${next.length}`)}`,
    );
  });
}

async function searchRemove(args: string[]): Promise<void> {
  if (args.length !== 1) {
    throw new Error("neox search rm <api>");
  }
  const vendor = args[0]!.trim().toLowerCase();
  await withStore(async (store) => {
    const config = store.get();
    const apis = apisOf(config);
    if (!apis.some((api) => api.vendor === vendor)) {
      throw new Error(`no ${vendor} search API is set up`);
    }
    const next = apis.filter((api) => api.vendor !== vendor);
    await store.write({
      ...config,
      search: { ...(config.search ?? { enabled: false }), apis: next },
    });
    say(`${chalk.green("✓")} removed`);
  });
}

export async function runSearchCommand(args: string[]): Promise<void> {
  if (args.length === 0) {
    await searchList();
    return;
  }
  const [word, ...rest] = args;
  switch (word) {
    case "help":
    case "-h":
    case "--help":
      say(searchUsage);
      return;
    case "add":
    case "set":
      await searchAdd(rest);
      return;
    case "on":
      await searchOnOff(rest, true);
      return;
    case "off":
      await searchOnOff(rest, false);
      return;
    case "move":
    case "mv":
      await searchMove(rest);
      return;
    case "rm":
    case "remove":
      await searchRemove(rest);
      return;
    default:
      throw new Error("neox search [add|on|off|move|rm] (neox search help)");
  }
}

export function createSearchCommand(): Command {
  return new Command("search")
    .description("The web search APIs a model's search goes to")
    .argument("[args...]")
    .allowUnknownOption(true)
    .helpOption(false)
    .action(async (args: string[] | undefined) => {
      await runSearchCommand(args ?? []);
    });
}
