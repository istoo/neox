/**
 * The search APIs plugins give the gateway. A plugin's index.server.ts
 * registers `{id, name, keysURL, keyOptional, needURL, execute}`; the
 * daemon lists it beside the built-in vendors and asks it through the
 * same search path. The vendor id in `search.apis` is
 * `plugin:<pluginId>:<searchId>`.
 */
import type { FoundPage } from "./search-apis.js";

export interface PluginSearchApi {
  vendor: string;
  name: string;
  keysURL?: string;
  keyOptional?: boolean;
  needURL?: boolean;
}

export interface PluginSearchBridge {
  list(): readonly PluginSearchApi[];
  run(
    vendor: string,
    input: { query: string; key: string | null; url: string | null },
  ): Promise<unknown>;
}

let bridge: PluginSearchBridge | null = null;

export function configurePluginSearch(next: PluginSearchBridge | null): void {
  bridge = next;
}

/** The plugin search API a vendor id names, if one does. */
export function pluginSearchApi(vendor: string): PluginSearchApi | undefined {
  return bridge?.list().find((api) => api.vendor === vendor);
}

/** The search APIs plugins give, for the settings page's vendor list. */
export function pluginSearchApis(): readonly PluginSearchApi[] {
  return bridge?.list() ?? [];
}

/** Asks a plugin's search API and reads its pages. */
export async function runPluginSearch(
  vendor: string,
  input: { query: string; key: string | null; url: string | null },
): Promise<FoundPage[]> {
  if (bridge === null) {
    throw new Error(`Unknown search vendor: ${vendor}`);
  }
  const result = await bridge.run(vendor, input);
  if (!Array.isArray(result)) {
    throw new Error(`Search API ${vendor} returned no pages`);
  }
  const pages: FoundPage[] = [];
  for (const page of result) {
    if (
      typeof page !== "object" ||
      page === null ||
      typeof (page as { title?: unknown }).title !== "string" ||
      typeof (page as { url?: unknown }).url !== "string"
    ) {
      continue;
    }
    const entry = page as { title: string; url: string; text?: unknown; age?: unknown };
    pages.push({
      title: entry.title,
      url: entry.url,
      text: typeof entry.text === "string" ? entry.text : "",
      ...(typeof entry.age === "string" ? { age: entry.age } : {}),
    });
  }
  return pages;
}
