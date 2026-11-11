import type { Logger } from "pino";
import { searchBase, searchKeys, type SearchApiConfig } from "./search-apis.js";

/**
 * What each key of a configured search API has used of its limit, ported
 * from myna's search_quota.go: Tavily says it at GET /usage, by the key it
 * is asked with. A read that fails is said as unknown with why, never as 0
 * used.
 */

/** What one key of a search API has used of its limit. */
export interface SearchKeyQuota {
  /** The key, masked. */
  key: string;
  /** Read, or unknown with `err`. */
  known: boolean;
  unlimited?: boolean;
  used: number;
  limit: number;
  /** What the limit belongs to: the key itself, or its account's plan. */
  of?: "key" | "plan";
  plan?: string;
  paygoLeft?: number;
  usedUp?: boolean;
  err?: string;
}

/** How long a quota read is kept before it is read again: Tavily allows /usage 10 times in 10 minutes. */
const QUOTA_KEEP_MS = 2 * 60_000;

interface KeptQuota {
  at: number;
  quota: SearchKeyQuota;
}

const kept = new Map<string, KeptQuota>();

/** Whether the gateway can read what a search API's keys have left: Tavily's, with a key. */
export function canReadSearchQuota(api: SearchApiConfig): boolean {
  return api.vendor === "tavily" && searchKeys(api).length > 0;
}

/**
 * What each of an API's keys has used of its limit, in the order of its
 * keys; empty for an API whose quota cannot be read.
 */
export async function searchQuotas(
  api: SearchApiConfig,
  options: {
    fresh?: boolean;
    fetchImpl?: typeof fetch;
    now?: number;
    logger?: Logger;
  } = {},
): Promise<SearchKeyQuota[]> {
  if (!canReadSearchQuota(api)) {
    return [];
  }
  const now = options.now ?? Date.now();
  const keys = searchKeys(api);
  const out = await Promise.all(keys.map((key) => oneQuota(api, key, { ...options, now })));
  return out;
}

async function oneQuota(
  api: SearchApiConfig,
  key: string,
  options: { fresh?: boolean; fetchImpl?: typeof fetch; now: number; logger?: Logger },
): Promise<SearchKeyQuota> {
  const id = `${api.vendor} ${searchBase(api)} ${key}`;
  const saved = kept.get(id);
  if (saved !== undefined && options.fresh !== true && options.now - saved.at < QUOTA_KEEP_MS) {
    return saved.quota;
  }
  let quota: SearchKeyQuota;
  try {
    quota = await askTavilyUsage(api, key, options);
    quota.key = maskSearchKey(key);
  } catch (error) {
    options.logger?.debug({ err: error, vendor: api.vendor }, "Cannot read a search key's quota");
    const message = error instanceof Error ? error.message : String(error);
    quota = {
      key: maskSearchKey(key),
      known: false,
      used: 0,
      limit: 0,
      err: message.split(key).join(maskSearchKey(key)),
    };
  }
  kept.set(id, { at: options.now, quota });
  return quota;
}

/** Tavily's key as the page shows it: the first four and the last four. */
export function maskSearchKey(key: string): string {
  return key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : "…";
}

interface UsageFields {
  key?: Record<string, unknown>;
  account?: Record<string, unknown>;
}

/** One number of the reply: its value, whether it is null, and whether it is there. */
function quotaNumber(
  fields: Record<string, unknown> | undefined,
  name: string,
): { value: number; null: boolean; ok: boolean } {
  if (fields === undefined || !(name in fields)) {
    return { value: 0, null: false, ok: false };
  }
  const value = fields[name];
  if (value === null) {
    return { value: 0, null: true, ok: true };
  }
  return typeof value === "number" && Number.isFinite(value)
    ? { value, null: false, ok: true }
    : { value: 0, null: false, ok: false };
}

/**
 * Tavily's GET /usage reply, as what the key has left: the key's own limit
 * when it has one, else its account plan's (the plan's usage beside it, not
 * the key's, as the account's other keys spend it too). A reply missing what
 * it takes is an error: unknown, never 0.
 */
export function readTavilyUsage(body: unknown): SearchKeyQuota {
  const usage = usageOf(body);
  const quota: SearchKeyQuota = { key: "", known: false, used: 0, limit: 0 };
  readAccount(quota, usage.account);
  readLimit(quota, usage);
  quota.known = true;
  // A key's own limit is a hard stop; a plan's goes on into pay-as-you-go
  // while there is some.
  quota.usedUp =
    quota.unlimited !== true &&
    quota.used >= quota.limit &&
    (quota.of === "key" || (quota.paygoLeft ?? 0) === 0);
  return quota;
}

function usageOf(body: unknown): UsageFields {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("unexpected reply: not an object");
  }
  const usage = body as UsageFields;
  if (usage.key === undefined || usage.key === null) {
    throw new Error("no key in the reply");
  }
  return usage;
}

function readAccount(quota: SearchKeyQuota, account: Record<string, unknown> | undefined): void {
  const plan = account?.current_plan;
  if (typeof plan === "string") {
    quota.plan = plan;
  }
  const paygoLimit = quotaNumber(account, "paygo_limit");
  const paygoUsage = quotaNumber(account, "paygo_usage");
  if (paygoLimit.ok && !paygoLimit.null && paygoUsage.ok && !paygoUsage.null) {
    quota.paygoLeft = Math.max(0, paygoLimit.value - paygoUsage.value);
  }
}

function readLimit(quota: SearchKeyQuota, usage: UsageFields): void {
  const keyUsed = quotaNumber(usage.key, "usage");
  const keyLimit = quotaNumber(usage.key, "limit");
  if (!keyLimit.ok) {
    throw new Error("no key limit in the reply");
  }
  const planLimit = quotaNumber(usage.account, "plan_limit");
  const planUsage = quotaNumber(usage.account, "plan_usage");
  if (!keyLimit.null) {
    if (!keyUsed.ok || keyUsed.null) {
      throw new Error("no key usage in the reply");
    }
    quota.used = keyUsed.value;
    quota.limit = keyLimit.value;
    quota.of = "key";
    return;
  }
  if (planLimit.ok && !planLimit.null) {
    if (!planUsage.ok || planUsage.null) {
      throw new Error("no plan usage in the reply");
    }
    quota.used = planUsage.value;
    quota.limit = planLimit.value;
    quota.of = "plan";
    return;
  }
  if (planLimit.ok && planLimit.null) {
    quota.unlimited = true;
    quota.used = keyUsed.value;
    return;
  }
  throw new Error("no plan limit in the reply");
}

/** Asks Tavily's /usage with one key, at the address the API is set at. */
async function askTavilyUsage(
  api: SearchApiConfig,
  key: string,
  options: { fetchImpl?: typeof fetch },
): Promise<SearchKeyQuota> {
  const response = await (options.fetchImpl ?? fetch)(`${searchBase(api)}/usage`, {
    method: "GET",
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) {
    const said = text.trim();
    throw new Error(
      said.length === 0
        ? `HTTP ${response.status}`
        : `HTTP ${response.status}: ${said.slice(0, 200)}`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("unexpected reply: not JSON");
  }
  return readTavilyUsage(body);
}
