import { isGitHubHost, parseGitRemoteLocation } from "@neolix/protocol/git-remote";
import {
  PublishedPluginDetailSchema,
  type PluginRegistries,
} from "@neolix/protocol/plugin-registry";
import type { PluginReadmeSource } from "@neolix/protocol/messages";

const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const GITHUB_RAW_URL = "https://raw.githubusercontent.com";
const README_TTL_MS = 10 * 60_000;
const NETWORK_TIMEOUT_MS = 12_000;
const MAX_README_BYTES = 512 * 1024;
const GITHUB_README_CANDIDATES = ["README.md", "readme.md", "Readme.md", "README"];

export interface PluginReadmeOptions {
  baseUrl?: string;
  registries?: PluginRegistries;
  npmRegistryUrl?: string;
  githubRawUrl?: string;
}

interface CacheEntry {
  at: number;
  markdown: string;
}

const cache = new Map<string, CacheEntry>();

function cached(key: string): string | null {
  const entry = cache.get(key);
  return entry && Date.now() - entry.at < README_TTL_MS ? entry.markdown : null;
}

function remember(key: string, markdown: string): string {
  if (cache.size > 50) cache.clear();
  cache.set(key, { at: Date.now(), markdown });
  return markdown;
}

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const response = await fetch(url, {
    // See market.ts fetchJson: the daemon's platform fetch cannot decode a
    // compressed body while npm undici's dispatcher is installed.
    headers: { "accept-encoding": "identity", ...headers },
    redirect: "error",
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${new URL(url).host} returned ${response.status}`);
  const text = await response.text();
  return text.length > MAX_README_BYTES ? text.slice(0, MAX_README_BYTES) : text;
}

function registryBase(options: PluginReadmeOptions): string {
  const base = options.baseUrl?.trim();
  if (!base) throw new Error("Plugin registry is not configured");
  return base.replace(/\/+$/, "");
}

function githubRepository(remote: string): string | null {
  const location = parseGitRemoteLocation(remote);
  if (!location || !isGitHubHost(location.host)) return null;
  const parts = location.path
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
}

async function registryReadme(
  id: Extract<PluginReadmeSource, { kind: "registry" }>["id"],
  locale: string | undefined,
  options: PluginReadmeOptions,
): Promise<string> {
  const base = registryBase(options);
  const headers: Record<string, string> = {};
  const authorization = options.registries?.[new URL(base).host]?.authorization;
  if (authorization) headers.Authorization = authorization;
  const raw = await fetchText(`${base}/plugins/${id}.json`, headers);
  const plugin = PublishedPluginDetailSchema.parse(JSON.parse(raw));
  const translated = locale ? plugin.overviewTranslations?.[locale] : undefined;
  return translated ?? plugin.readme;
}

async function npmReadme(packageName: string, options: PluginReadmeOptions): Promise<string> {
  const base = (options.npmRegistryUrl ?? NPM_REGISTRY_URL).replace(/\/+$/, "");
  const path = packageName.split("/").map(encodeURIComponent).join("/");
  const raw = await fetchText(`${base}/${path}`);
  const document = JSON.parse(raw) as { readme?: unknown };
  if (typeof document.readme !== "string" || document.readme.trim() === "") {
    throw new Error(`npm has no README for ${packageName}`);
  }
  return document.readme;
}

async function githubReadme(
  remote: string,
  ref: string | undefined,
  options: PluginReadmeOptions,
): Promise<string> {
  const repository = githubRepository(remote);
  if (!repository) throw new Error("Only GitHub repositories have a readable README");
  const base = (options.githubRawUrl ?? GITHUB_RAW_URL).replace(/\/+$/, "");
  let lastError: unknown;
  for (const candidate of GITHUB_README_CANDIDATES) {
    try {
      const text = await fetchText(`${base}/${repository}/${ref ?? "HEAD"}/${candidate}`);
      if (text.trim()) return text;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`No README in ${repository}`);
}

/** A plugin's README from its registry entry, npm package, or GitHub repository. */
export async function loadPluginReadme(
  source: PluginReadmeSource,
  options: PluginReadmeOptions = {},
  locale?: string,
): Promise<string> {
  const key = `${source.kind}:${JSON.stringify(source)}:${locale ?? ""}`;
  const hit = cached(key);
  if (hit !== null) return hit;
  let markdown: string;
  if (source.kind === "registry") markdown = await registryReadme(source.id, locale, options);
  else if (source.kind === "npm") markdown = await npmReadme(source.package, options);
  else markdown = await githubReadme(source.remote, source.ref, options);
  return remember(key, markdown);
}
