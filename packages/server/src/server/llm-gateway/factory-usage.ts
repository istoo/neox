import type { AccountUsageReading } from "./accounts.js";
import { factoryBase, type FactoryKeyOptions } from "./factory-accounts.js";
import type { FactorySubscriptionAccount } from "./subscription-store.js";
import type { UsageWindow } from "./provider-limits.js";

/**
 * How much of a Factory plan an account has used, as droid's `/status`
 * asks it (`provider/factory_usage.go`): `GET /api/billing/limits`.
 * Standard usage runs in rolling 5-hour, weekly and monthly windows;
 * Droid Core, the open models Factory hosts, has windows of its own.
 */

export interface FactoryLimitWindow {
  usedPercent: number;
  /** The window's end, in epoch ms, or null. */
  resetsAt: number | null;
}

export interface FactoryLimits {
  standard: FactoryLimitWindow[];
  core: FactoryLimitWindow[];
  /** Extra usage left, in cents, when Factory allows it. */
  extraCents: number | null;
  readAt: number;
}

const WINDOW_KEYS = ["5h", "7d", "30d"] as const;

/** Reads a window's end: an ISO time or epoch milliseconds. */
export function factoryWhen(value: unknown): number | null {
  if (typeof value === "string" && value !== "") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return asNumber;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return typeof value === "number" && value > 0 ? value : null;
}

function poolWindows(pool: unknown): FactoryLimitWindow[] {
  if (typeof pool !== "object" || pool === null) {
    return [];
  }
  const record = pool as Record<string, unknown>;
  const out: FactoryLimitWindow[] = [];
  for (const name of ["fiveHour", "weekly", "monthly"]) {
    const window = record[name];
    if (typeof window !== "object" || window === null) {
      continue;
    }
    const entry = window as Record<string, unknown>;
    const used = typeof entry.usedPercent === "number" ? entry.usedPercent : 0;
    out.push({
      usedPercent: Math.min(Math.max(used, 0), 100),
      resetsAt: factoryWhen(entry.windowEnd),
    });
  }
  return out;
}

/** The windows `/api/billing/limits` answered, or why it didn't. */
export async function readFactoryLimits(
  input: { account: FactorySubscriptionAccount; now?: number },
  options: FactoryKeyOptions = {},
): Promise<FactoryLimits | { error: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = factoryBase(input.account, options);
  let response: Response;
  try {
    response = await fetchImpl(`${base}/api/billing/limits`, {
      headers: {
        authorization: `Bearer ${input.account.key}`,
        ...(input.account.orgId === null ? {} : { "x-factory-org-id": input.account.orgId }),
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const text = await response.text();
  if (!response.ok) {
    return {
      error: `Factory answered ${response.status}${text.trim() === "" ? "" : `: ${text.slice(0, 300)}`}`,
    };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { error: "Factory's limits didn't answer JSON" };
  }
  if (typeof body !== "object" || body === null) {
    return { error: "Factory's limits named no windows" };
  }
  const record = body as Record<string, unknown>;
  const limits =
    typeof record.limits === "object" && record.limits !== null
      ? (record.limits as Record<string, unknown>)
      : {};
  const extra =
    typeof record.extraUsageBalanceCents === "number" && record.extraUsageAllowed === true
      ? record.extraUsageBalanceCents
      : null;
  return {
    standard: poolWindows(limits.standard),
    core: poolWindows(limits.core),
    extraCents: extra,
    readAt: input.now ?? options.now?.() ?? Date.now(),
  };
}

/**
 * The reading routing and the allowance cards take: standard's windows by
 * their span, then Droid Core's. Extra usage is a balance, not a share, so
 * it has no window of its own (myna's `factoryQuota`).
 */
export function factoryUsageReading(limits: FactoryLimits): AccountUsageReading {
  const windows: UsageWindow[] = [];
  for (const [prefix, list] of [
    ["", limits.standard],
    ["core-", limits.core],
  ] as const) {
    for (const [index, window] of list.entries()) {
      windows.push({
        key: `${prefix}${WINDOW_KEYS[index] ?? String(index)}`,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt,
      });
    }
  }
  return {
    remaining: null,
    limit: null,
    usedPercent: null,
    resetAt: null,
    readAt: limits.readAt,
    windows,
  };
}

/** Reads one Factory account's allowance in the shape routing keeps. */
export async function readFactoryUsage(
  input: { account: FactorySubscriptionAccount; now?: number },
  options: FactoryKeyOptions = {},
): Promise<AccountUsageReading | { error: string }> {
  const limits = await readFactoryLimits(input, options);
  if ("error" in limits) {
    return limits;
  }
  return factoryUsageReading(limits);
}
