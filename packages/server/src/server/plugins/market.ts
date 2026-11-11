import {
  PluginRegistryIndexSchema,
  type PluginRegistries,
  type PublishedPluginSchema,
} from "@neolix/protocol/plugin-registry";
import type { z } from "zod";

// The registry's index.json is built at deploy time and served from GitHub Pages; the repo keeps
// only the per-plugin records, so there is no jsDelivr copy of the index to ask first in China.
const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const NPM_MIRROR_URL = "https://registry.npmmirror.com";
const NPM_DOWNLOADS_URL = "https://api.npmjs.org/downloads/point/last-week";
const INDEX_TTL_MS = 5 * 60_000;
const DOWNLOADS_TTL_MS = 60 * 60_000;
const SEARCH_TTL_MS = 60_000;
const NETWORK_TIMEOUT_MS = 8_000;
const MAX_DOWNLOAD_PACKAGES = 60;

type RegistryIndex = z.infer<typeof PluginRegistryIndexSchema>;
type PublishedPlugin = z.infer<typeof PublishedPluginSchema>;

export interface PluginMarket {
  registry: { name: string; url: string };
  categories: RegistryIndex["categories"];
  plugins: PublishedPlugin[];
  weeklyDownloads?: Record<string, number>;
}

export interface PluginMarketOptions {
  baseUrl?: string;
  registries?: PluginRegistries;
  npmRegistryUrl?: string;
  npmMirrorUrl?: string;
  npmDownloadsUrl?: string;
}

export interface PluginMarketSearchHit {
  package: string;
  name: string;
  description?: string;
  version?: string;
  weeklyDownloads?: number;
  publisher?: string;
}

const indexCache = new Map<string, { at: number; value: RegistryIndex }>();
const downloadsCache = new Map<string, { at: number; value: number | null }>();
const searchCache = new Map<string, { at: number; value: PluginMarketSearchHit[] }>();

function registryBase(baseUrl: string | undefined): string {
  const base = baseUrl?.trim();
  if (!base) throw new Error("Plugin registry is not configured");
  return base.replace(/\/+$/, "");
}

function cached<T>(
  cache: Map<string, { at: number; value: T }>,
  key: string,
  ttl: number,
): T | null {
  const hit = cache.get(key);
  return hit && Date.now() - hit.at < ttl ? hit.value : null;
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, {
    // The daemon's platform fetch runs on npm undici's dispatcher, and a
    // compressed body arrives undecoded with its content-encoding header
    // stripped, so response.json() sees binary. Identity keeps it plain.
    headers: { "accept-encoding": "identity", ...headers },
    redirect: "error",
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${new URL(url).host} returned ${response.status}`);
  return response.json();
}

async function loadRegistryIndex(options: PluginMarketOptions): Promise<RegistryIndex> {
  const base = registryBase(options.baseUrl);
  const hit = cached(indexCache, base, INDEX_TTL_MS);
  if (hit) return hit;
  const headers: Record<string, string> = {};
  const authorization = options.registries?.[new URL(base).host]?.authorization;
  if (authorization) headers.Authorization = authorization;
  const value = PluginRegistryIndexSchema.parse(await fetchJson(`${base}/index.json`, headers));
  indexCache.set(base, { at: Date.now(), value });
  return value;
}

function npmPackageName(plugin: PublishedPlugin): string | null {
  return plugin.artifact.kind === "npm" ? plugin.artifact.package : null;
}

function npmDownloadsPath(base: string, packageName: string): string {
  return `${base.replace(/\/+$/, "")}/${encodeURIComponent(packageName)}`;
}

async function weeklyDownloads(packageName: string, base: string): Promise<number | null> {
  const hit = cached(downloadsCache, packageName, DOWNLOADS_TTL_MS);
  if (hit !== null) return hit;
  try {
    const raw = await fetchJson(npmDownloadsPath(base, packageName));
    const downloads =
      typeof raw === "object" && raw !== null && "downloads" in raw ? raw.downloads : undefined;
    const value = typeof downloads === "number" ? downloads : null;
    downloadsCache.set(packageName, { at: Date.now(), value });
    return value;
  } catch {
    downloadsCache.set(packageName, { at: Date.now(), value: null });
    return null;
  }
}

/** npm's downloads last week for the registry's npm artifacts; unknown packages are left out. */
async function collectWeeklyDownloads(
  plugins: PublishedPlugin[],
  base: string,
): Promise<Record<string, number> | undefined> {
  const npmPlugins = plugins
    .map((plugin) => ({ id: plugin.id, packageName: npmPackageName(plugin) }))
    .filter((entry): entry is { id: string; packageName: string } => entry.packageName !== null)
    .slice(0, MAX_DOWNLOAD_PACKAGES);
  if (npmPlugins.length === 0) return undefined;
  const counts = await Promise.all(
    npmPlugins.map(
      async ({ packageName }) => [packageName, await weeklyDownloads(packageName, base)] as const,
    ),
  );
  const byPackage = new Map(counts);
  const result: Record<string, number> = {};
  for (const { id, packageName } of npmPlugins) {
    const count = byPackage.get(packageName);
    if (count !== undefined && count !== null) result[id] = count;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** The registry's published plugins, with npm's download counts when npm answers. */
export async function loadPluginMarket(options: PluginMarketOptions = {}): Promise<PluginMarket> {
  const index = await loadRegistryIndex(options);
  return {
    registry: index.registry,
    categories: index.categories,
    plugins: index.plugins,
    weeklyDownloads: await collectWeeklyDownloads(
      index.plugins,
      options.npmDownloadsUrl ?? NPM_DOWNLOADS_URL,
    ),
  };
}

function parseSearchHit(raw: unknown): PluginMarketSearchHit | null {
  if (typeof raw !== "object" || raw === null || !("package" in raw)) return null;
  const entry = raw.package;
  if (typeof entry !== "object" || entry === null) return null;
  const fields = entry as Record<string, unknown>;
  if (typeof fields.name !== "string") return null;
  const publisher = fields.publisher as Record<string, unknown> | undefined;
  return {
    package: fields.name,
    name: typeof fields.displayName === "string" ? fields.displayName : fields.name,
    version: typeof fields.version === "string" ? fields.version : undefined,
    description: typeof fields.description === "string" ? fields.description : undefined,
    publisher: typeof publisher?.username === "string" ? publisher.username : undefined,
  };
}

async function searchAt(base: string, query: string): Promise<PluginMarketSearchHit[]> {
  const url = `${base}/-/v1/search?text=${encodeURIComponent(query)}&size=20`;
  const raw = await fetchJson(url);
  const objects =
    typeof raw === "object" && raw !== null && "objects" in raw && Array.isArray(raw.objects)
      ? raw.objects
      : [];
  return objects.flatMap((entry) => {
    const hit = parseSearchHit(entry);
    return hit ? [hit] : [];
  });
}

/**
 * npm's packages matching a query. The China mirror is asked first when enabled, then the
 * official registry; download counts always come from npm.
 */
export async function searchNpmPlugins(
  query: string,
  options: {
    mirror?: boolean;
    npmRegistryUrl?: string;
    npmMirrorUrl?: string;
    npmDownloadsUrl?: string;
  } = {},
): Promise<PluginMarketSearchHit[]> {
  const term = query.trim();
  if (!term) return [];
  const key = `${options.mirror === true ? "mirror" : "official"}:${term.toLowerCase()}`;
  const hit = cached(searchCache, key, SEARCH_TTL_MS);
  if (hit) return hit;
  const downloadsBase = options.npmDownloadsUrl ?? NPM_DOWNLOADS_URL;
  let hits: PluginMarketSearchHit[] = [];
  if (options.mirror === true) {
    hits = await searchAt(options.npmMirrorUrl ?? NPM_MIRROR_URL, term).catch(() => []);
  }
  if (hits.length === 0) {
    hits = await searchAt(options.npmRegistryUrl ?? NPM_REGISTRY_URL, term);
  }
  const withDownloads = await Promise.all(
    hits.map(async (entry) => {
      const count = await weeklyDownloads(entry.package, downloadsBase);
      if (count !== null) entry.weeklyDownloads = count;
      return entry;
    }),
  );
  if (searchCache.size > 50) searchCache.clear();
  searchCache.set(key, { at: Date.now(), value: withDownloads });
  return withDownloads;
}
