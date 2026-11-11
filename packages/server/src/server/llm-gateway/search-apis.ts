import type { Logger } from "pino";
import { pluginSearchApi, runPluginSearch } from "./plugin-search.js";

/** How many pages a search API is asked for (myna's searchHits). */
export const SEARCH_HITS = 6;
/** The most of a page's text a hit carries. */
export const PAGE_TEXT = 1500;

export interface SearchVendorDef {
  id: string;
  name: string;
  /** Its address; "" for one the user runs (a SearXNG). */
  base: string;
  keysUrl?: string;
  /** It answers with no key too. */
  keyOptional?: boolean;
  /** What goes after the base to search. */
  paths: string[];
}

/** myna's SearchVendors, in the order it offers them. */
export const SEARCH_VENDORS: readonly SearchVendorDef[] = [
  {
    id: "tavily",
    name: "Tavily",
    base: "https://api.tavily.com",
    keysUrl: "https://app.tavily.com/home",
    paths: ["/search"],
  },
  {
    id: "brave",
    name: "Brave Search",
    base: "https://api.search.brave.com",
    keysUrl: "https://api-dashboard.search.brave.com/app/keys",
    paths: ["/res/v1/web/search"],
  },
  {
    id: "exa",
    name: "Exa",
    base: "https://api.exa.ai",
    keysUrl: "https://dashboard.exa.ai/api-keys",
    paths: ["/search"],
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    base: "https://api.firecrawl.dev",
    keysUrl: "https://www.firecrawl.dev/app/api-keys",
    paths: ["/v2/search"],
  },
  {
    id: "you",
    name: "You.com",
    base: "https://ydc-index.io",
    keysUrl: "https://you.com/platform",
    keyOptional: true,
    paths: ["/v1/search", "/v1/agents/search"],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    base: "https://api.deepseek.com",
    keysUrl: "https://platform.deepseek.com/api_keys",
    paths: ["/v1/tools/search"],
  },
  {
    id: "volcengine",
    name: "Doubao Search (Volcengine)",
    base: "https://open.feedcoopapi.com",
    keysUrl: "https://console.volcengine.com/search-infinity/api-key",
    paths: ["/search_api/web_search"],
  },
  {
    id: "wsa",
    name: "Yuanbao Search (Tencent Cloud)",
    base: "https://api.wsa.cloud.tencent.com",
    keysUrl: "https://console.cloud.tencent.com/wsapi/index",
    paths: ["/SearchPro"],
  },
  {
    id: "searxng",
    name: "SearXNG",
    base: "",
    keyOptional: true,
    paths: ["/search"],
  },
];

/** You.com's search that takes no key (100 a day per address). */
export const YOU_FREE_SEARCH = "https://api.you.com/v1/agents/search";

export type SearchPick = "" | "order";

export interface SearchApiConfig {
  vendor: string;
  key?: string;
  url?: string;
  pick?: SearchPick;
  off?: boolean;
}

export interface FoundPage {
  title: string;
  url: string;
  text: string;
  age?: string;
}

export function searchVendorOf(id: string): SearchVendorDef | undefined {
  return SEARCH_VENDORS.find((vendor) => vendor.id === id);
}

/** The keys in `key`: one, or several separated by commas, spaces or lines. */
export function searchKeys(api: SearchApiConfig): string[] {
  const out: string[] = [];
  for (const key of (api.key ?? "").split(/[,;\s]+/)) {
    if (key.length > 0 && !out.includes(key)) {
      out.push(key);
    }
  }
  return out;
}

/** The API's address without a trailing slash nor the vendor's own path. */
export function searchBase(api: SearchApiConfig): string {
  if (pluginSearchApi(api.vendor) !== undefined) {
    return api.url ?? "";
  }
  const vendor = searchVendorOf(api.vendor);
  if (api.url === undefined || api.url.length === 0) {
    return vendor?.base ?? "";
  }
  let base = api.url.replace(/\/+$/, "");
  for (const path of vendor?.paths ?? []) {
    if (base.length > path.length && base.toLowerCase().endsWith(path.toLowerCase())) {
      base = base.slice(0, base.length - path.length).replace(/\/+$/, "");
      break;
    }
  }
  return base;
}

/** Ready: a vendor known, at an address, with a key where one is needed. */
export function searchReady(api: SearchApiConfig): boolean {
  const plugin = pluginSearchApi(api.vendor);
  if (plugin !== undefined) {
    return (
      (plugin.needURL !== true || (api.url !== undefined && api.url.length > 0)) &&
      (searchKeys(api).length > 0 || plugin.keyOptional === true)
    );
  }
  const vendor = searchVendorOf(api.vendor);
  if (vendor === undefined) {
    return false;
  }
  return (
    (searchBase(api).length > 0 || vendor.id === "you") &&
    (searchKeys(api).length > 0 || vendor.keyOptional === true)
  );
}

/** The APIs that can be asked, in the order they are tried. */
export function readySearchApis(apis: readonly SearchApiConfig[] | undefined): SearchApiConfig[] {
  return (apis ?? []).filter((api) => api.off !== true && searchReady(api));
}

/** The rests a refusal earns (myna's search_keys.go). */
const RATE_LIMIT_REST = 60_000;
const RATE_LIMIT_REST_MIN = 30_000;
const RATE_LIMIT_REST_MAX = 600_000;
const TURNED_AWAY_REST = 600_000;
const OUT_OF_CREDIT_REST = 3_600_000;

/** How long a key a search API refused with this status rests. */
export function searchRestFor(vendor: string, status: number, retryAfter: string | null): number {
  if (status === 401 || status === 403) {
    return TURNED_AWAY_REST;
  }
  if (status === 402 || (vendor === "tavily" && (status === 432 || status === 433))) {
    return OUT_OF_CREDIT_REST;
  }
  let rest = RATE_LIMIT_REST;
  const seconds = retryAfter === null ? Number.NaN : Number.parseInt(retryAfter, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    rest = seconds * 1000;
  } else if (retryAfter !== null) {
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) {
      rest = at - Date.now();
    }
  }
  return Math.min(Math.max(rest, RATE_LIMIT_REST_MIN), RATE_LIMIT_REST_MAX);
}

/** One API's keys picked in turn or in order, a resting one asked last. */
export class SearchKeyPicker {
  private readonly turns = new Map<string, number>();
  private readonly rests = new Map<string, { until: number; reason: string }>();
  private readonly now: () => number;

  public constructor(now: () => number = Date.now) {
    this.now = now;
  }

  public pick(api: SearchApiConfig): string | null {
    const keys = searchKeys(api);
    if (keys.length === 0) {
      return null;
    }
    const now = this.now();
    const free = (key: string): boolean => {
      const rest = this.rests.get(`${api.vendor}\u0000${key}`);
      return rest === undefined || rest.until <= now;
    };
    const start = api.pick === "order" ? 0 : (this.turns.get(api.vendor) ?? 0);
    if (api.pick !== "order") {
      this.turns.set(api.vendor, start + 1);
    }
    for (let step = 0; step < keys.length; step += 1) {
      const key = keys[(start + step) % keys.length];
      if (key !== undefined && free(key)) {
        return key;
      }
    }
    // Every key rests: the one whose rest ends first is asked again.
    let soonest: { key: string; until: number } | null = null;
    for (const key of keys) {
      const rest = this.rests.get(`${api.vendor}\u0000${key}`);
      if (rest !== undefined && (soonest === null || rest.until < soonest.until)) {
        soonest = { key, until: rest.until };
      }
    }
    return soonest?.key ?? keys[0] ?? null;
  }

  /** A key the API refused rests for what its status and Retry-After say. */
  public refuse(
    api: SearchApiConfig,
    key: string | null,
    status: number,
    retryAfter: string | null = null,
  ): void {
    if (key === null || !isKeyRefusal(status)) {
      return;
    }
    this.rests.set(`${api.vendor}\u0000${key}`, {
      until: this.now() + searchRestFor(api.vendor, status, retryAfter),
      reason: status === 401 || status === 403 ? "turned away" : "refused",
    });
  }
}

function isKeyRefusal(status: number): boolean {
  return (
    status === 401 ||
    status === 402 ||
    status === 403 ||
    status === 429 ||
    status === 432 ||
    status === 433
  );
}

export interface SearchAsk {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

/** What one search API is asked, as myna asks it. */
export function buildSearchAsk(api: SearchApiConfig, key: string | null, query: string): SearchAsk {
  const base = searchBase(api);
  const headers: Record<string, string> = { accept: "application/json" };
  const withKey = (header: string): void => {
    if (key !== null) {
      headers[header] = key;
    }
  };
  switch (api.vendor) {
    case "tavily":
      if (key !== null) {
        headers.authorization = `Bearer ${key}`;
      }
      return {
        url: `${base}/search`,
        method: "POST",
        headers,
        body: { query, max_results: SEARCH_HITS, search_depth: "basic" },
      };
    case "brave":
      withKey("x-subscription-token");
      return {
        url: `${base}/res/v1/web/search?q=${encodeURIComponent(query)}&count=${SEARCH_HITS}`,
        method: "GET",
        headers,
      };
    case "exa":
      withKey("x-api-key");
      return {
        url: `${base}/search`,
        method: "POST",
        headers,
        body: {
          query,
          numResults: SEARCH_HITS,
          contents: { text: { maxCharacters: PAGE_TEXT } },
        },
      };
    case "firecrawl":
      if (key !== null) {
        headers.authorization = `Bearer ${key}`;
      }
      return {
        url: `${base}/v2/search`,
        method: "POST",
        headers,
        body: { query, limit: SEARCH_HITS },
      };
    case "deepseek":
      if (key !== null) {
        headers.authorization = `Bearer ${key}`;
      }
      return {
        url: `${base}/v1/tools/search`,
        method: "POST",
        headers,
        body: { query: query.slice(0, 128), count: SEARCH_HITS },
      };
    case "volcengine":
      if (key !== null) {
        headers.authorization = `Bearer ${key}`;
      }
      return {
        url: `${base}/search_api/web_search`,
        method: "POST",
        headers,
        body: {
          Query: query.slice(0, 100),
          SearchType: "web",
          Count: SEARCH_HITS,
          Filter: { NeedUrl: true },
        },
      };
    case "wsa":
      if (key !== null) {
        headers.authorization = `Bearer ${key}`;
      }
      return { url: `${base}/SearchPro`, method: "POST", headers, body: { Query: query, Cnt: 10 } };
    case "searxng":
      return {
        url: `${base}/search?q=${encodeURIComponent(query)}&format=json`,
        method: "GET",
        headers,
      };
    case "you":
      if (key !== null) {
        headers["x-api-key"] = key;
        return {
          url: `${base}/v1/search`,
          method: "POST",
          headers,
          body: { query, count: SEARCH_HITS },
        };
      }
      return {
        url: `${api.url === undefined || api.url.length === 0 ? YOU_FREE_SEARCH : `${base}/v1/agents/search`}?query=${encodeURIComponent(query)}&count=${SEARCH_HITS}`,
        method: "GET",
        headers,
      };
    default:
      throw new Error(`Unknown search API: ${api.vendor}`);
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pagesOfResults(results: unknown): FoundPage[] {
  if (!Array.isArray(results)) {
    return [];
  }
  const pages: FoundPage[] = [];
  for (const entry of results) {
    const result = recordOf(entry);
    if (result === null) {
      continue;
    }
    const url = text(result.url);
    if (url.length === 0) {
      continue;
    }
    const age = text(result.age) || text(result.date);
    const body =
      text(result.content) ||
      text(result.summary) ||
      text(result.text) ||
      text(result.description) ||
      text(result.markdown) ||
      text(result.snippet);
    pages.push({
      title: text(result.title) || url,
      url,
      text: body.slice(0, PAGE_TEXT),
      ...(age.length === 0 ? {} : { age }),
    });
  }
  return pages;
}

/** The pages a search API's reply holds, as myna reads them. */
export function parseSearchReply(vendor: string, reply: unknown): FoundPage[] {
  const record = recordOf(reply);
  if (record === null) {
    return [];
  }
  switch (vendor) {
    case "brave": {
      const web = recordOf(record.web);
      return pagesOfResults(web?.results).slice(0, SEARCH_HITS);
    }
    case "firecrawl": {
      const data = recordOf(record.data);
      if (data !== null && Array.isArray(data.web)) {
        return pagesOfResults(data.web).slice(0, SEARCH_HITS);
      }
      return pagesOfResults(record.data).slice(0, SEARCH_HITS);
    }
    case "wsa": {
      const response = recordOf(record.Response);
      const pages = pagesOfResults(response?.Pages).slice(0, SEARCH_HITS);
      if (pages.length > 0) {
        return pages;
      }
      return pagesOfResults(response?.Results).slice(0, SEARCH_HITS);
    }
    case "volcengine": {
      const result = recordOf(record.Result);
      return pagesOfResults(result?.WebResults ?? result?.Results).slice(0, SEARCH_HITS);
    }
    case "you": {
      const results = recordOf(record.results);
      const hits = Array.isArray(record.hits) ? record.hits : results?.hits;
      return pagesOfResults(hits).slice(0, SEARCH_HITS);
    }
    default:
      return pagesOfResults(record.results).slice(0, SEARCH_HITS);
  }
}

/** What the search found, as a model is given it. */
export function pagesSaid(pages: readonly FoundPage[]): string {
  return pages
    .map((page, index) => {
      const head = `${index + 1}. ${page.title} — ${page.url}`;
      return page.text.length === 0 ? head : `${head}\n${page.text}`;
    })
    .join("\n\n");
}

/** Asks one API and returns its pages; a refusal is thrown with its status. */
export async function askSearchApi(input: {
  api: SearchApiConfig;
  key: string | null;
  query: string;
  fetchImpl?: typeof fetch;
  logger: Logger;
}): Promise<FoundPage[]> {
  if (pluginSearchApi(input.api.vendor) !== undefined) {
    return runPluginSearch(input.api.vendor, {
      query: input.query,
      key: input.key,
      url: input.api.url ?? null,
    });
  }
  const ask = buildSearchAsk(input.api, input.key, input.query);
  const headers =
    ask.body === undefined ? ask.headers : { ...ask.headers, "content-type": "application/json" };
  const response = await (input.fetchImpl ?? fetch)(ask.url, {
    method: ask.method,
    headers,
    ...(ask.body === undefined ? {} : { body: JSON.stringify(ask.body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  const reply: unknown = (() => {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  })();
  if (!response.ok) {
    input.logger.debug({ vendor: input.api.vendor, status: response.status }, "Search API failed");
    throw new SearchApiError(
      response.status,
      `search API ${input.api.vendor} failed`,
      response.headers.get("retry-after"),
    );
  }
  return parseSearchReply(input.api.vendor, reply);
}

export class SearchApiError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfter: string | null = null,
  ) {
    super(message);
    this.name = "SearchApiError";
  }
}
