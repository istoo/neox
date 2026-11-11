import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { slugName } from "./gateway-store.js";
import { GATEWAY_PROVIDER_PRESETS } from "./presets.js";
import { runAddCommand } from "./gateway-commands.js";
import { withGatewayStore, type StoreOptions } from "./gateway-store.js";

/**
 * `neolix provider import <link>` — myna's `myna import [-y] <myna://import?…>`
 * (internal/provider/importurl.go, internal/cli/providers_cli.go:1465). A
 * link carries a preset or a provider's endpoints, its key and models; the
 * provider is shown, then added. `myna://` is accepted beside `neolix://` so
 * a link made for myna still works here.
 */

const IMPORT_USAGE = `usage:
  neox provider import [-y] <neolix://import?…>

  The link names a preset (preset=claude, region=…, name=…) or a provider of
  its own (name=…, chat=/responses=/anthropic=/gemini=…, website=, keys=,
  catalog=, icon=), with key= and models=a,b. A myna:// link is accepted too.`;

export interface ImportProvider {
  /** The provider id the link names, before neolix makes it free. */
  id: string;
  name: string;
  /** Arguments for `neolix provider add`, in the order it reads them. */
  args: string[];
  /** One endpoint, as neolix serves one protocol per provider. */
  endpoint: { protocol: string; baseUrl: string } | null;
  key: string;
  models: string[];
}

function fail(message: string): never {
  throw new Error(message);
}

function trimmed(query: URLSearchParams, key: string): string {
  return (query.get(key) ?? "").trim();
}

/** https, or http to this machine or the local network (myna's endpoint). */
function endpointOf(name: string, raw: string): string | null {
  if (raw === "") {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(`the link's ${name}= is not a base URL: ${JSON.stringify(raw)}`);
  }
  if (url.host === "" || url.username !== "" || url.search !== "" || url.hash !== "") {
    return fail(`the link's ${name}= is not a base URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "https:") {
    const host = url.hostname;
    const local =
      host === "localhost" ||
      host.endsWith(".local") ||
      /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(host) ||
      host === "::1";
    if (url.protocol !== "http:" || !local) {
      return fail(`the link's ${name}= must use https: ${JSON.stringify(raw)}`);
    }
  }
  return url.toString().replace(/\/+$/u, "");
}

/** A web page kept only when it is https (myna's page). */
function pageOf(raw: string): string | undefined {
  if (raw === "") {
    return undefined;
  }
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" && url.host !== "" && url.username === "") {
      return url.pathname === "/" ? `${url.origin}` : url.toString();
    }
  } catch {
    // Not a URL: myna keeps no page.
  }
  return undefined;
}

function iconOf(raw: string): string | undefined {
  if (raw === "") {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(`the link's icon= is not a picture URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "https:") {
    return fail(`the link's icon= must use https: ${JSON.stringify(raw)}`);
  }
  return url.toString();
}

interface LinkPart {
  presetId: string;
  name: string;
  id: string;
  endpoint: { protocol: string; baseUrl: string } | null;
  pairs: string[];
}

function presetPart(get: (key: string) => string, pairs: string[]): LinkPart {
  const preset = get("preset");
  const found = GATEWAY_PROVIDER_PRESETS.find(
    (entry) => entry.id === preset.toLowerCase() || slugName(entry.name) === preset.toLowerCase(),
  );
  if (found === undefined) {
    return fail(`Neox has no ${preset} preset; neox presets lists them`);
  }
  if (found.vertex === true) {
    return fail(
      `${found.name} is added with your own Google Cloud project, not from a link: neox provider add ${found.id} project=<id>`,
    );
  }
  let name = found.name;
  if (found.regions !== undefined && found.regions.length > 0) {
    const region = get("region");
    if (region !== "") {
      if (!found.regions.some((entry) => entry.id === region)) {
        return fail(`${found.name} has no region ${JSON.stringify(region)}`);
      }
      pairs.push(`region=${region}`);
    }
  }
  if (get("name") !== "") {
    name = get("name");
    pairs.push(`name=${name}`);
  }
  let id = "";
  if (get("id") !== "") {
    id = get("id");
    pairs.push(`id=${id}`);
  }
  return { presetId: found.id, name, id, endpoint: null, pairs };
}

const ENDPOINT_PARAMS = [
  ["chat", "openai"],
  ["responses", "openai-responses"],
  ["anthropic", "anthropic"],
  ["gemini", "gemini"],
] as const;

function endpointPairs(
  get: (key: string) => string,
  pairs: string[],
): { protocol: string; baseUrl: string } | null {
  let endpoint: { protocol: string; baseUrl: string } | null = null;
  for (const [key, protocol] of ENDPOINT_PARAMS) {
    const baseUrl = endpointOf(key, get(key));
    if (baseUrl === null) {
      continue;
    }
    // Neolix serves one protocol per provider; the link's first one wins.
    if (endpoint === null) {
      endpoint = { protocol, baseUrl };
    }
    pairs.push(`${key}=${baseUrl}`);
  }
  return endpoint;
}

function customPart(get: (key: string) => string, pairs: string[]): LinkPart {
  const name = get("name");
  if (name === "") {
    return fail("the link names no provider: it needs preset= or name=");
  }
  const endpoint = endpointPairs(get, pairs);
  if (endpoint === null) {
    return fail("the link gives no base URL: it needs chat=, responses=, anthropic= or gemini=");
  }
  const website = pageOf(get("website"));
  if (website !== undefined) {
    pairs.push(`website=${website}`);
  }
  const keys = pageOf(get("keys"));
  if (keys !== undefined) {
    pairs.push(`keys=${keys}`);
  }
  const catalog = get("catalog").toLowerCase();
  if (catalog !== "") {
    pairs.push(`catalog=${catalog}`);
  }
  let id = "";
  if (get("id") !== "") {
    id = get("id");
    pairs.push(`id=${id}`);
  }
  return { presetId: "", name, id, endpoint, pairs };
}

function keyIsSound(key: string): boolean {
  if (key.length > 4096) {
    return false;
  }
  for (const character of key) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 0x20 || point === 0x7f) {
      return false;
    }
  }
  return true;
}

function finalIdOf(part: LinkPart): string {
  if (part.id !== "") {
    return slugName(part.id);
  }
  if (part.presetId !== "") {
    return part.presetId;
  }
  return slugName(part.name);
}

/** myna's ParseImport, yielding the arguments `provider add` reads. */
export function parseImportLink(link: string): ImportProvider {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return fail("not a neolix:// or myna:// link");
  }
  const scheme = url.protocol.replace(/:$/u, "").toLowerCase();
  if (scheme !== "neox" && scheme !== "myna") {
    return fail("not a neolix:// or myna:// link");
  }
  const action = (url.host !== "" ? url.host : url.pathname.replace(/^\/+/u, "")).replace(
    /\/+$/u,
    "",
  );
  if (action !== "import") {
    return fail(
      `${scheme}://${action} is not something Neox knows; links start ${scheme}://import?`,
    );
  }
  const query = url.searchParams;
  const get = (key: string) => trimmed(query, key);
  const pairs: string[] = [];
  const part = get("preset") !== "" ? presetPart(get, pairs) : customPart(get, pairs);

  const icon = iconOf(get("icon"));
  if (icon !== undefined) {
    pairs.push(`icon=${icon}`);
  }
  const key = get("key");
  if (!keyIsSound(key)) {
    return fail("the link's key is not a key");
  }
  const models = get("models")
    .split(",")
    .map((model) => model.trim())
    .filter((model) => model.length > 0)
    .slice(0, 200);
  if (models.length > 0) {
    pairs.push(`models=${models.join(",")}`);
  }
  const finalId = finalIdOf(part);
  if (finalId === "") {
    return fail("the link's name has no letters or digits to make an id from");
  }
  if (finalId === "neox" || finalId === "neolix") {
    return fail(`"${finalId}" is what agents call the gateway itself; the link needs another id`);
  }
  if (key !== "") {
    pairs.push(`key=${key}`);
  }
  const args = part.presetId !== "" ? [part.presetId, ...pairs] : [part.name, ...pairs];
  return {
    id: finalId,
    name: part.name.slice(0, 80),
    args,
    endpoint: part.endpoint,
    key,
    models,
  };
}

export interface ImportCommandOptions extends StoreOptions {
  yes?: boolean;
}

async function confirmImport(): Promise<boolean> {
  if (process.stdin.isTTY !== true) {
    throw new Error("not a terminal: add -y to import without asking");
  }
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await reader.question("Add it? [y/N] ");
    const lower = answer.trim().toLowerCase();
    return lower === "y" || lower === "yes";
  } finally {
    reader.close();
  }
}

export async function runImportCommand(
  args: string[],
  options: ImportCommandOptions,
): Promise<string[]> {
  let yes = options.yes === true;
  let link = "";
  for (const value of args) {
    if (value === "-y" || value === "--yes") {
      yes = true;
    } else if (link === "") {
      link = value;
    } else {
      throw new Error(IMPORT_USAGE);
    }
  }
  if (link === "") {
    throw new Error(IMPORT_USAGE);
  }
  const imported = parseImportLink(link);
  const lines: string[] = [];
  const where =
    imported.endpoint !== null
      ? `${imported.endpoint.protocol} ${imported.endpoint.baseUrl}`
      : "its preset's endpoint";
  lines.push(`  ${chalk.bold(imported.name)} ${chalk.gray(imported.id)}  ${where}`);
  if (imported.key !== "") {
    lines.push(`  key ${chalk.gray(`${imported.key.slice(0, 4)}…${imported.key.slice(-4)}`)}`);
  }
  if (imported.models.length > 0) {
    lines.push(`  models ${chalk.gray(imported.models.join(", "))}`);
  }
  await withGatewayStore(options, async (store) => {
    const held = store.get().providers.find((provider) => provider.id === imported.id);
    if (held !== undefined) {
      lines.push(`${chalk.yellow("!")} replaces your ${held.label ?? held.id}`);
    }
  });
  process.stdout.write(`${lines.join("\n")}\n`);
  if (!yes && !(await confirmImport())) {
    throw new Error("nothing added");
  }
  const added = await runAddCommand(imported.args, options);
  if (imported.key === "") {
    return [
      ...added,
      `${chalk.yellow("!")} the link has no key · neox provider key ${imported.id} <key>`,
    ];
  }
  return added;
}

export { IMPORT_USAGE };
