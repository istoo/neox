import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { StoredMcpServer } from "./store.js";

/** Something a market server needs from the user before it can start. */
export interface MarketInput {
  key: string;
  where: "env" | "header" | "arg";
  label: string;
  description?: string;
  placeholder?: string;
  secret?: boolean;
  required?: boolean;
  /** A header's value around the input, "Bearer {}". */
  format?: string;
}

export interface MarketServer {
  id: string;
  name: string;
  title: string;
  description: string;
  publisher?: string;
  icon?: string;
  homepage?: string;
  transport: "stdio" | "http" | "sse";
  /** npx, uvx or docker for a local one. */
  runs?: string;
  featured?: boolean;
  /** No agent is picked for it until the user ticks one (myna's OptIn). */
  optIn?: boolean;
  inputs: MarketInput[];
  server: Omit<StoredMcpServer, "agents">;
  /** Where the server is, normalised, for address searches. */
  addresses: string[];
}

export interface MarketServerView {
  id: string;
  name: string;
  title: string;
  description: string;
  publisher?: string;
  icon?: string;
  homepage?: string;
  transport: "stdio" | "http" | "sse";
  runs?: string;
  featured?: boolean;
  optIn?: boolean;
  inputs: MarketInput[];
  /** The library server that is this one, when it has one. */
  have?: string;
}

interface RegistryHeader {
  name?: unknown;
  value?: unknown;
  description?: unknown;
  isRequired?: unknown;
  isSecret?: unknown;
}

interface RegistryEnvVar {
  name?: unknown;
  description?: unknown;
  isRequired?: unknown;
  isSecret?: unknown;
}

interface RegistryArg {
  type?: unknown;
  name?: unknown;
  value?: unknown;
  default?: unknown;
  valueHint?: unknown;
  description?: unknown;
  isRequired?: unknown;
}

interface RegistryServer {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  websiteUrl?: unknown;
  repository?: { url?: unknown };
  icons?: { src?: unknown }[];
  remotes?: { type?: unknown; url?: unknown; headers?: RegistryHeader[] }[];
  packages?: {
    registryType?: unknown;
    identifier?: unknown;
    transport?: { type?: unknown };
    environmentVariables?: RegistryEnvVar[];
    packageArguments?: RegistryArg[];
  }[];
}

const PLACEHOLDER = /\{[^{}]*\}/;
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function ownerAvatar(owner: string): string {
  return `https://github.com/${owner}.png?size=96`;
}

function remoteServer(
  id: string,
  title: string,
  publisher: string,
  icon: string,
  url: string,
  description: string,
  inputs: MarketInput[] = [],
): MarketServer {
  return {
    id,
    name: id,
    title,
    publisher,
    icon,
    description,
    transport: "http",
    featured: true,
    inputs,
    server: { name: id, transport: "http", url },
    addresses: [],
  };
}

function localServer(
  id: string,
  title: string,
  publisher: string,
  icon: string,
  homepage: string,
  description: string,
  command: string,
  args: string[],
  inputs: MarketInput[] = [],
): MarketServer {
  return {
    id,
    name: id,
    title,
    publisher,
    icon,
    homepage,
    description,
    transport: "stdio",
    runs: command,
    featured: true,
    inputs,
    server: { name: id, transport: "stdio", command, args },
    addresses: [],
  };
}

function secretEnv(key: string, label: string, where: string): MarketInput {
  return { key, where: "env", label, description: where, secret: true, required: true };
}

/** Installed with the daemon's address and a key, not from a static entry. */
export const NEOLIX_WEB_SEARCH_ID = "neox-web-search";
export const NEOLIX_VISION_ID = "neox-vision";
export const NEOLIX_IMAGE_ID = "neox-image";

/** Where each of Neolix's own servers answers on the gateway. */
export const NEOLIX_SELF_PATHS: Record<string, string> = {
  [NEOLIX_VISION_ID]: "/mcp/myna/vision",
  [NEOLIX_IMAGE_ID]: "/mcp/myna/image",
  [NEOLIX_WEB_SEARCH_ID]: "/mcp/myna/web-search",
};

/** Neolix's own servers as the market lists them; the address is added
 * when one is installed (myna's selfServer, searchServer, visionServer). */
function neolixSelfServer(id: string, title: string, description: string): MarketServer {
  return {
    id,
    name: id,
    title,
    publisher: "Neox",
    description,
    transport: "http",
    featured: true,
    // Each call costs what the model or the search charges, so no agent is
    // given it until the user ticks one (myna's OptIn).
    optIn: true,
    inputs: [],
    server: { name: id, transport: "http", url: "" },
    addresses: [id, NEOLIX_SELF_PATHS[id] ?? ""],
  };
}

const NEOLIX_VISION = neolixSelfServer(
  NEOLIX_VISION_ID,
  "Neox Image Recognition",
  "Read an image from a file, a URL or a data URL, with the image recognition model set in Neox's gateway.",
);

const NEOLIX_IMAGE = neolixSelfServer(
  NEOLIX_IMAGE_ID,
  "Neox Image",
  "Generate and edit images, and make short videos, with the image model set in Neox's gateway.",
);

const NEOLIX_WEB_SEARCH = neolixSelfServer(
  NEOLIX_WEB_SEARCH_ID,
  "Neox Web Search",
  "Search the web and read a page by its URL, through the search set up in Neox's gateway.",
);

const NEOLIX_SELF_SERVERS = [NEOLIX_VISION, NEOLIX_IMAGE, NEOLIX_WEB_SEARCH];

/** Ported from myna's market.go; the Myna-branded entries are left out. */
const FEATURED: MarketServer[] = [
  remoteServer(
    "context7",
    "Context7",
    "Upstash",
    ownerAvatar("upstash"),
    "https://mcp.context7.com/mcp",
    "Up-to-date documentation and code examples for any library, straight into the prompt.",
    [
      {
        key: "CONTEXT7_API_KEY",
        where: "header",
        label: "API key",
        description: "Optional — raises the rate limit. From context7.com/dashboard",
        secret: true,
        format: "{}",
      },
    ],
  ),
  localServer(
    "playwright",
    "Playwright",
    "Microsoft",
    "https://playwright.dev/img/playwright-logo.svg",
    "https://github.com/microsoft/playwright-mcp",
    "Drive a real browser: open pages, click, type and read them through the accessibility tree.",
    "npx",
    ["-y", "@playwright/mcp@latest"],
  ),
  localServer(
    "chrome-devtools",
    "Chrome DevTools",
    "Google",
    ownerAvatar("ChromeDevTools"),
    "https://github.com/ChromeDevTools/chrome-devtools-mcp",
    "Control and inspect a live Chrome: console, network, performance traces and screenshots.",
    "npx",
    ["-y", "chrome-devtools-mcp@latest"],
  ),
  remoteServer(
    "github",
    "GitHub",
    "GitHub",
    ownerAvatar("github"),
    "https://api.githubcopilot.com/mcp/",
    "Repositories, issues, pull requests, Actions and code search on GitHub.",
    [
      {
        key: "Authorization",
        where: "header",
        label: "Personal access token",
        description: "github.com/settings/personal-access-tokens",
        placeholder: "github_pat_…",
        secret: true,
        required: true,
        format: "Bearer {}",
      },
    ],
  ),
  remoteServer(
    "deepwiki",
    "DeepWiki",
    "Cognition",
    ownerAvatar("CognitionAI"),
    "https://mcp.deepwiki.com/mcp",
    "Ask questions about any public GitHub repository and read its generated wiki.",
  ),
  remoteServer(
    "exa",
    "Exa",
    "Exa",
    ownerAvatar("exa-labs"),
    "https://mcp.exa.ai/mcp",
    "Web search and code search built for agents, with clean page contents.",
  ),
  remoteServer(
    "anysearch",
    "AnySearch",
    "AnySearch",
    ownerAvatar("anysearch-ai"),
    "https://api.anysearch.com/mcp",
    "Real-time web search, vertical searches (finance, papers, code, security and more) and full pages as Markdown.",
    [
      {
        key: "Authorization",
        where: "header",
        label: "API key",
        description: "Optional — raises the rate limit. From anysearch.com/console/api-keys",
        placeholder: "as_sk_…",
        secret: true,
        format: "Bearer {}",
      },
    ],
  ),
  localServer(
    "filesystem",
    "Filesystem",
    "Model Context Protocol",
    ownerAvatar("modelcontextprotocol"),
    "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    "Read, write and search files, limited to the folders you allow.",
    "npx",
    ["-y", "@modelcontextprotocol/server-filesystem"],
    [
      {
        key: "dir",
        where: "arg",
        label: "Folder",
        description: "The folder it may read and write",
        placeholder: "~/code",
        required: true,
      },
    ],
  ),
  localServer(
    "fetch",
    "Fetch",
    "Model Context Protocol",
    ownerAvatar("modelcontextprotocol"),
    "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    "Fetch a web page and hand it over as Markdown.",
    "uvx",
    ["mcp-server-fetch"],
  ),
  localServer(
    "memory",
    "Memory",
    "Model Context Protocol",
    ownerAvatar("modelcontextprotocol"),
    "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    "A knowledge graph the agent keeps across conversations.",
    "npx",
    ["-y", "@modelcontextprotocol/server-memory"],
  ),
  localServer(
    "sequential-thinking",
    "Sequential Thinking",
    "Model Context Protocol",
    ownerAvatar("modelcontextprotocol"),
    "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    "Think a problem through step by step, revising and branching as it goes.",
    "npx",
    ["-y", "@modelcontextprotocol/server-sequential-thinking"],
  ),
  localServer(
    "git",
    "Git",
    "Model Context Protocol",
    ownerAvatar("modelcontextprotocol"),
    "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    "Read, search and change Git repositories.",
    "uvx",
    ["mcp-server-git"],
  ),
  localServer(
    "time",
    "Time",
    "Model Context Protocol",
    ownerAvatar("modelcontextprotocol"),
    "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
    "The current time anywhere, and conversions between time zones.",
    "uvx",
    ["mcp-server-time"],
  ),
  remoteServer(
    "sentry",
    "Sentry",
    "Sentry",
    ownerAvatar("getsentry"),
    "https://mcp.sentry.dev/mcp",
    "Issues, errors and traces from Sentry, and Seer's analysis of them.",
  ),
  remoteServer(
    "linear",
    "Linear",
    "Linear",
    ownerAvatar("linear"),
    "https://mcp.linear.app/mcp",
    "Find, create and update Linear issues, projects and comments.",
  ),
  remoteServer(
    "notion",
    "Notion",
    "Notion",
    ownerAvatar("makenotion"),
    "https://mcp.notion.com/mcp",
    "Search, read and write pages and databases in your Notion workspace.",
  ),
  remoteServer(
    "atlassian",
    "Atlassian",
    "Atlassian",
    ownerAvatar("atlassian"),
    "https://mcp.atlassian.com/v1/mcp",
    "Jira issues and Confluence pages from Atlassian Cloud.",
  ),
  remoteServer(
    "supabase",
    "Supabase",
    "Supabase",
    ownerAvatar("supabase"),
    "https://mcp.supabase.com/mcp",
    "Manage Supabase projects: tables, SQL, migrations, logs and edge functions.",
  ),
  remoteServer(
    "stripe",
    "Stripe",
    "Stripe",
    ownerAvatar("stripe"),
    "https://mcp.stripe.com",
    "Customers, payments, subscriptions and Stripe's documentation.",
  ),
  remoteServer(
    "vercel",
    "Vercel",
    "Vercel",
    ownerAvatar("vercel"),
    "https://mcp.vercel.com",
    "Projects, deployments and logs on Vercel, and its documentation.",
  ),
  remoteServer(
    "neon",
    "Neon",
    "Neon",
    ownerAvatar("neondatabase"),
    "https://mcp.neon.tech/mcp",
    "Serverless Postgres on Neon: projects, branches and SQL.",
  ),
  remoteServer(
    "cloudflare-docs",
    "Cloudflare Docs",
    "Cloudflare",
    ownerAvatar("cloudflare"),
    "https://docs.mcp.cloudflare.com/mcp",
    "Search Cloudflare's documentation.",
  ),
  remoteServer(
    "microsoft-learn",
    "Microsoft Learn",
    "Microsoft",
    ownerAvatar("microsoft"),
    "https://learn.microsoft.com/api/mcp",
    "Official Microsoft and Azure documentation and code samples.",
  ),
  remoteServer(
    "huggingface",
    "Hugging Face",
    "Hugging Face",
    ownerAvatar("huggingface"),
    "https://huggingface.co/mcp",
    "Search models, datasets, Spaces and papers on the Hugging Face Hub.",
  ),
  localServer(
    "brave-search",
    "Brave Search",
    "Brave",
    ownerAvatar("brave"),
    "https://github.com/brave/brave-search-mcp-server",
    "Web, news, image and local search from Brave's independent index.",
    "npx",
    ["-y", "@brave/brave-search-mcp-server"],
    [secretEnv("BRAVE_API_KEY", "API key", "brave.com/search/api")],
  ),
  localServer(
    "firecrawl",
    "Firecrawl",
    "Firecrawl",
    ownerAvatar("firecrawl"),
    "https://github.com/firecrawl/firecrawl-mcp-server",
    "Scrape, crawl and search the web into clean Markdown.",
    "npx",
    ["-y", "firecrawl-mcp"],
    [secretEnv("FIRECRAWL_API_KEY", "API key", "firecrawl.dev/app/api-keys")],
  ),
  localServer(
    "tavily",
    "Tavily",
    "Tavily",
    ownerAvatar("tavily-ai"),
    "https://github.com/tavily-ai/tavily-mcp",
    "Search and extract from the web with Tavily.",
    "npx",
    ["-y", "tavily-mcp"],
    [secretEnv("TAVILY_API_KEY", "API key", "app.tavily.com")],
  ),
];

function normalizeAddress(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\.git$/, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

function addressesOf(...values: (string | undefined)[]): string[] {
  return values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map(normalizeAddress);
}

function packageOf(server: MarketServer["server"]): string {
  if (server.transport !== "stdio") {
    return "";
  }
  for (const arg of server.args ?? []) {
    if (!arg || arg.startsWith("-") || arg === "run") {
      continue;
    }
    const at = arg.lastIndexOf("@");
    return at > 0 ? arg.slice(0, at) : arg;
  }
  return "";
}

function serverKey(server: MarketServer["server"]): string {
  if (server.transport !== "stdio") {
    return (server.url ?? "").replace(/\/+$/, "").toLowerCase();
  }
  return `${server.command ?? ""} ${packageOf(server)}`.trim();
}

function lookupAddress(query: string): string {
  const raw = query.trim();
  return /^[a-z0-9@._:/-]+$/i.test(raw) &&
    (raw.includes("/") || raw.includes(".") || raw.startsWith("@"))
    ? normalizeAddress(raw)
    : "";
}

function addressScore(address: string, candidates: readonly string[]): number {
  if (address.length === 0) {
    return 0;
  }
  let best = 0;
  for (const candidate of candidates) {
    if (candidate === address) {
      best = Math.max(best, 3);
    } else if (candidate.startsWith(`${address}/`) || address.startsWith(`${candidate}/`)) {
      best = Math.max(best, 2);
    } else if (candidate.includes(address) && address.includes("/")) {
      best = Math.max(best, 1);
    }
  }
  return best;
}

function shortName(name: string): string {
  const last = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
  let next = last;
  for (const prefix of ["mcp-server-", "server-", "mcp-"]) {
    next = next.replace(new RegExp(`^${prefix}`), "");
  }
  for (const suffix of ["-mcp-server", "-mcp", "-server", "_mcp", ".mcp"]) {
    next = next.replace(new RegExp(`${suffix}$`), "");
  }
  next = next
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (NAME_PATTERN.test(next)) {
    return next;
  }
  return last.length > 0 && NAME_PATTERN.test(last) ? last : "server";
}

function githubOwner(url: string | undefined): string {
  if (!url) {
    return "";
  }
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") {
      return "";
    }
    return parsed.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
  } catch {
    return "";
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function boolValue(value: unknown): boolean {
  return value === true;
}

type MarketBase = Omit<MarketServer, "transport" | "inputs" | "server" | "runs">;

function baseFromRegistry(raw: RegistryServer, id: string, name: string): MarketBase {
  const homepage = stringValue(raw.websiteUrl) || stringValue(raw.repository?.url);
  const addresses = addressesOf(
    id,
    stringValue(raw.websiteUrl),
    stringValue(raw.repository?.url),
    ...(raw.remotes ?? []).map((entry) => stringValue(entry.url)),
    ...(raw.packages ?? []).map((entry) => stringValue(entry.identifier)),
  );
  const owner =
    githubOwner(stringValue(raw.repository?.url)) ||
    (id.startsWith("io.github.") ? id.slice("io.github.".length).split("/")[0] : "");
  const publisher = owner || id.split("/")[0].split(".").toReversed().join(".");
  const icon =
    (raw.icons ?? [])
      .map((entry) => stringValue(entry.src))
      .find((src) => src.startsWith("https://")) ?? (owner ? ownerAvatar(owner) : undefined);
  return {
    id,
    name,
    title: stringValue(raw.title) || name,
    description: stringValue(raw.description),
    publisher,
    ...(icon ? { icon } : {}),
    ...(homepage ? { homepage } : {}),
    addresses,
  };
}

function headerInput(header: RegistryHeader): MarketInput {
  const key = stringValue(header.name);
  const required = boolValue(header.isRequired);
  const secret = boolValue(header.isSecret);
  return {
    key,
    where: "header",
    label: key,
    ...(stringValue(header.description) ? { description: stringValue(header.description) } : {}),
    ...(secret ? { secret: true } : {}),
    ...(required ? { required: true } : {}),
  };
}

function remoteFromRegistry(
  base: MarketBase,
  name: string,
  remote: { type?: unknown; url?: unknown; headers?: RegistryHeader[] },
): MarketServer | null {
  const type = stringValue(remote.type);
  const url = stringValue(remote.url);
  if (
    (type !== "streamable-http" && type !== "sse") ||
    url.includes("{") ||
    !url.startsWith("https://")
  ) {
    return null;
  }
  const headers: Record<string, string> = {};
  const inputs: MarketInput[] = [];
  for (const header of remote.headers ?? []) {
    const key = stringValue(header.name);
    const value = stringValue(header.value);
    if (!key) {
      continue;
    }
    if (value && !PLACEHOLDER.test(value)) {
      headers[key] = value;
      continue;
    }
    if (!boolValue(header.isRequired) && !boolValue(header.isSecret)) {
      continue;
    }
    inputs.push({
      ...headerInput(header),
      format: value ? value.replace(PLACEHOLDER, "{}") : "{}",
    });
  }
  const transport = type === "sse" ? "sse" : "http";
  return {
    ...base,
    transport,
    inputs,
    server: {
      name,
      transport,
      url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    },
  };
}

function envInput(variable: RegistryEnvVar): MarketInput {
  const key = stringValue(variable.name);
  return {
    key,
    where: "env",
    label: key,
    ...(stringValue(variable.description)
      ? { description: stringValue(variable.description) }
      : {}),
    ...(boolValue(variable.isSecret) ? { secret: true } : {}),
    ...(boolValue(variable.isRequired) ? { required: true } : {}),
  };
}

function packageCommand(kind: "npm" | "pypi" | "oci", identifier: string): string[] {
  if (kind === "npm") {
    return ["npx", "-y", identifier];
  }
  if (kind === "pypi") {
    return ["uvx", identifier];
  }
  return ["docker", "run", "-i", "--rm"];
}

function packageFromRegistry(
  base: MarketBase,
  name: string,
  pkg: {
    registryType?: unknown;
    identifier?: unknown;
    transport?: { type?: unknown };
    environmentVariables?: RegistryEnvVar[];
    packageArguments?: RegistryArg[];
  },
  kind: "npm" | "pypi" | "oci",
): MarketServer | null {
  const identifier = stringValue(pkg.identifier);
  const [command, ...args] = packageCommand(kind, identifier);
  const inputs: MarketInput[] = [];
  for (const variable of pkg.environmentVariables ?? []) {
    const key = stringValue(variable.name);
    if (!key || (!boolValue(variable.isRequired) && !boolValue(variable.isSecret))) {
      continue;
    }
    inputs.push(envInput(variable));
    if (kind === "oci") {
      args.push("-e", key);
    }
  }
  if (kind === "oci") {
    args.push(identifier);
  }
  for (const [index, argument] of (pkg.packageArguments ?? []).entries()) {
    let value = stringValue(argument.value) || stringValue(argument.default);
    if (PLACEHOLDER.test(value)) {
      value = "";
    }
    const named = stringValue(argument.type) === "named";
    if (value && named) {
      args.push(stringValue(argument.name), value);
    } else if (value) {
      args.push(value);
    } else if (boolValue(argument.isRequired) && !named) {
      inputs.push({
        key: `arg${index}`,
        where: "arg",
        label: stringValue(argument.valueHint) || `Argument ${index + 1}`,
        ...(stringValue(argument.description)
          ? { description: stringValue(argument.description) }
          : {}),
        required: true,
      });
    } else if (boolValue(argument.isRequired)) {
      return null;
    }
  }
  return {
    ...base,
    transport: "stdio",
    runs: command,
    inputs,
    server: { name, transport: "stdio", command, args },
  };
}

/** A registry entry as the library would keep it (market.go:fromRegistry). */
export function fromRegistry(raw: RegistryServer): MarketServer | null {
  const id = stringValue(raw.name);
  if (id.length === 0) {
    return null;
  }
  const name = shortName(id);
  const base = baseFromRegistry(raw, id, name);
  for (const remote of raw.remotes ?? []) {
    const server = remoteFromRegistry(base, name, remote);
    if (server) {
      return server;
    }
  }
  for (const registryType of ["npm", "pypi", "oci"] as const) {
    for (const pkg of raw.packages ?? []) {
      if (
        stringValue(pkg.registryType) !== registryType ||
        !stringValue(pkg.identifier) ||
        (stringValue(pkg.transport?.type) && stringValue(pkg.transport?.type) !== "stdio")
      ) {
        continue;
      }
      const server = packageFromRegistry(base, name, pkg, registryType);
      if (server) {
        return server;
      }
    }
  }
  return null;
}

let snapshotCache: MarketServer[] | null = null;

function snapshotPath(): string {
  return fileURLToPath(new URL("./data/market_servers.json", import.meta.url));
}

/** The registry crawl shipped with the server, once per process. */
export async function popularServers(file = snapshotPath()): Promise<MarketServer[]> {
  if (snapshotCache && file === snapshotPath()) {
    return snapshotCache;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const seen = new Set(FEATURED.map((entry) => serverKey(entry.server)));
  const list: MarketServer[] = [];
  for (const entry of parsed as RegistryServer[]) {
    const server = fromRegistry(entry);
    if (!server) {
      continue;
    }
    const key = serverKey(server.server);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    list.push(server);
  }
  if (file === snapshotPath()) {
    snapshotCache = list;
  }
  return list;
}

function prepare(servers: MarketServer[]): MarketServer[] {
  for (const server of servers) {
    if (server.addresses.length === 0) {
      server.addresses = addressesOf(server.homepage, server.server.url, packageOf(server.server));
    }
  }
  return servers;
}

/** The registry's live search, best effort: a failure leaves the snapshot. */
async function searchRegistry(
  query: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<{ servers: MarketServer[]; error?: string }> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(query)}&limit=100&version=latest`;
  try {
    const response = await doFetch(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return { servers: [], error: `the MCP Registry answered ${response.status}` };
    }
    const body = (await response.json()) as {
      servers?: { server?: RegistryServer; _meta?: Record<string, { status?: string }> }[];
    };
    const out: MarketServer[] = [];
    const seen = new Set<string>();
    for (const entry of body.servers ?? []) {
      const status = entry._meta?.["io.modelcontextprotocol.registry/official"]?.status;
      if (status && status !== "active") {
        continue;
      }
      const server = entry.server ? fromRegistry(entry.server) : null;
      if (!server) {
        continue;
      }
      const key = serverKey(server.server);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(server);
    }
    return { servers: prepare(out) };
  } catch (error) {
    return {
      servers: [],
      error: `the MCP Registry: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export interface MarketSearchOutcome {
  servers: MarketServerView[];
  /** Why the live registry's search failed; the snapshot's results are still here. */
  registryError?: string;
}

export interface MarketSearchOptions {
  /** Tests: the shipped snapshot's file. */
  snapshot?: string;
  /** Tests: the registry's answer, or none. */
  fetchImpl?: typeof fetch;
  live?: boolean;
}

/**
 * What the market shows for a search: the featured servers that match,
 * then the shipped snapshot's, then the registry's live ones
 * (market.go:MarketServers).
 */
export async function searchMarketServers(
  query: string,
  library: { mcp: StoredMcpServer[] },
  options: MarketSearchOptions = {},
): Promise<MarketSearchOutcome> {
  const raw = query.trim();
  const lowered = raw.toLowerCase();
  const address = lookupAddress(raw);
  const featured = prepare(FEATURED.map((entry) => ({ ...entry })));
  const dynamic = prepare(
    NEOLIX_SELF_SERVERS.map((entry) => ({ ...entry, addresses: [...entry.addresses] })),
  );
  const popular = prepare(await popularServers(options.snapshot));
  const seen = new Set<string>();
  const out: MarketServer[] = [];
  let live: MarketServer[] = [];
  let registryError: string | undefined;
  if (lowered.length > 0 && options.live !== false) {
    const answer = await searchRegistry(raw, options);
    live = answer.servers;
    registryError = answer.error;
  }

  const add = (list: MarketServer[]): void => {
    for (const server of list) {
      // Neolix's own servers have no address until one is installed, so
      // their id tells them apart.
      const key = server.server.url ? serverKey(server.server) : server.id;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(server);
    }
  };
  const matches = (server: MarketServer): boolean => {
    if (address.length > 0) {
      return addressScore(address, server.addresses) > 0;
    }
    if (lowered.length === 0) {
      return true;
    }
    return `${server.title} ${server.id} ${server.publisher ?? ""} ${server.description} ${packageOf(server.server)}`
      .toLowerCase()
      .includes(lowered);
  };

  add(featured.filter(matches));
  add(dynamic.filter(matches));
  add(popular.filter(matches));
  add(live.filter(matches));

  const have = new Map(library.mcp.map((server) => [serverKey(server), server.name]));
  const views: MarketServerView[] = [];
  for (const server of out) {
    const entry: MarketServerView = {
      id: server.id,
      name: server.name,
      title: server.title,
      description: server.description,
      transport: server.transport,
      inputs: server.inputs,
    };
    if (server.publisher) {
      entry.publisher = server.publisher;
    }
    if (server.icon) {
      entry.icon = server.icon;
    }
    if (server.homepage) {
      entry.homepage = server.homepage;
    }
    if (server.runs) {
      entry.runs = server.runs;
    }
    if (server.featured) {
      entry.featured = true;
    }
    if (server.optIn) {
      entry.optIn = true;
    }
    const selfPath = NEOLIX_SELF_PATHS[server.id];
    const known =
      selfPath !== undefined
        ? library.mcp.find((item) => item.name === server.id || item.url?.endsWith(selfPath))?.name
        : have.get(serverKey(server.server));
    if (known) {
      entry.have = known;
    }
    views.push(entry);
  }
  return { servers: views, ...(registryError ? { registryError } : {}) };
}

/** The market entry an id names, from the featured list or the snapshot. */
export async function marketServerById(
  id: string,
  options: { snapshot?: string } = {},
): Promise<MarketServer | null> {
  const featured = FEATURED.find((entry) => entry.id === id);
  if (featured) {
    return prepare([{ ...featured }])[0];
  }
  const self = NEOLIX_SELF_SERVERS.find((entry) => entry.id === id);
  if (self) {
    return prepare([{ ...self, addresses: [...self.addresses] }])[0];
  }
  const popular = await popularServers(options.snapshot);
  return popular.find((entry) => entry.id === id) ?? null;
}

/** Builds the library server a market entry becomes, with the user's values. */
export function serverFromMarket(
  entry: MarketServer,
  values: Record<string, string>,
  agents: string[],
): Omit<StoredMcpServer, "name"> & { name: string } {
  const server = entry.server;
  const args = [...(server.args ?? [])];
  const env = { ...server.env };
  const headers = { ...server.headers };
  for (const input of entry.inputs) {
    const value = (values[input.key] ?? "").trim();
    if (value.length === 0) {
      if (input.required) {
        throw new Error(`${entry.title} needs ${input.label}`);
      }
      continue;
    }
    if (input.where === "env") {
      env[input.key] = value;
    } else if (input.where === "header") {
      headers[input.key] = (input.format ?? "{}").replace("{}", value);
    } else {
      args.push(value);
    }
  }
  return {
    name: entry.name,
    transport: server.transport,
    ...(server.command ? { command: server.command } : {}),
    ...(args.length > 0 ? { args } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(server.url ? { url: server.url } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    agents: [...new Set(agents)].sort(),
    ...(entry.description ? { note: entry.description } : {}),
    ...(entry.icon ? { icon: entry.icon } : {}),
  };
}

/** A name the library does not have yet: docs, docs-2, docs-3. */
export function availableServerName(wanted: string, library: { mcp: StoredMcpServer[] }): string {
  if (!library.mcp.some((server) => server.name === wanted)) {
    return wanted;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${wanted}-${index}`;
    if (!library.mcp.some((server) => server.name === candidate)) {
      return candidate;
    }
  }
}
