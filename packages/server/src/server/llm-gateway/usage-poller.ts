import type { Logger } from "pino";
import { accountKey, type AccountRoutingState, type AccountUsageReading } from "./accounts.js";
import {
  isProviderEnabled,
  providerAccounts,
  type GatewayAccount,
  type GatewayProvider,
} from "./config.js";
import { readFactoryUsage } from "./factory-usage.js";
import { planKeyOf, planLookupOf, readPlanUsage } from "./plan-usage.js";
import type { UsageWindow } from "./provider-limits.js";
import { loadSubscriptionAccount } from "./subscription-auth.js";
import { buildUpstreamHeaders } from "./upstream.js";

export type UsageReading = AccountUsageReading;

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const TICK_MS = 30_000;

/**
 * Polls `account.usageUrl` for accounts that declare one. Vendors answer with
 * different field names, so the reader accepts the common spellings; anything
 * it cannot read leaves the account untouched.
 */
export class UsagePoller {
  private readonly state: AccountRoutingState;
  private readonly readAt = new Map<string, number>();
  /** When each plan (access key and plan) was last asked. */
  private readonly planAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(options: {
    state: AccountRoutingState;
    providers: () => GatewayProvider[];
    logger: Logger;
    /** Called with every reading, for the history the allowance cards draw. */
    onReading?: (provider: GatewayProvider, account: GatewayAccount, reading: UsageReading) => void;
    /**
     * Where the subscription stores live, for an account whose allowance is
     * read from its sign-in rather than a URL (Factory's key).
     */
    gatewayDir?: string;
    /**
     * myna's QuotaReads: true when allowances are read only on request, so
     * the timer reads nothing and refreshAll serves the asks.
     */
    readsAsked?: () => boolean;
  }) {
    this.state = options.state;
    this.providers = options.providers;
    this.logger = options.logger;
    this.onReading = options.onReading;
    this.readsAsked = options.readsAsked ?? (() => false);
    this.gatewayDir = options.gatewayDir;
  }

  private readonly readsAsked: () => boolean;
  private readonly gatewayDir: string | undefined;

  private readonly providers: () => GatewayProvider[];
  private readonly logger: Logger;
  private readonly onReading:
    | ((provider: GatewayProvider, account: GatewayAccount, reading: UsageReading) => void)
    | undefined;

  public start(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  public dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.readsAsked()) {
      return;
    }
    const now = Date.now();
    for (const provider of this.providers()) {
      if (!isProviderEnabled(provider)) {
        continue;
      }
      for (const account of providerAccounts(provider)) {
        if (!this.readable(account) || !account.enabled) {
          continue;
        }
        const key = accountKey(provider, account);
        const interval = account.usageIntervalMs ?? DEFAULT_INTERVAL_MS;
        const last = this.readAt.get(key) ?? 0;
        if (now - last < interval) {
          continue;
        }
        this.readAt.set(key, now);
        await this.poll(provider, account, now);
      }
    }
    await this.pollPlans(now, false);
  }

  /** Reads every account's usage endpoint and plan now, when the user asked. */
  public async refreshAll(now: number = Date.now()): Promise<void> {
    for (const provider of this.providers()) {
      if (!isProviderEnabled(provider)) {
        continue;
      }
      for (const account of providerAccounts(provider)) {
        if (!this.readable(account) || !account.enabled) {
          continue;
        }
        this.readAt.set(accountKey(provider, account), now);
        await this.poll(provider, account, now);
      }
    }
    await this.pollPlans(now, true);
  }

  /**
   * Reads each plan's control plane (Ark's or TokenHub's) once per access
   * key and plan, on the same timer the usage endpoints keep. A plan's
   * reading is provider-wide, so providers sharing an access key share one.
   */
  private async pollPlans(now: number, asked: boolean): Promise<void> {
    const read = new Set<string>();
    for (const provider of this.providers()) {
      if (!isProviderEnabled(provider)) {
        continue;
      }
      const lookup = planLookupOf(provider);
      if (lookup?.kind !== "read") {
        continue;
      }
      const key = planKeyOf(lookup.source);
      if (read.has(key)) {
        continue;
      }
      const last = this.planAt.get(key) ?? 0;
      if (!asked && now - last < DEFAULT_INTERVAL_MS) {
        continue;
      }
      read.add(key);
      this.planAt.set(key, now);
      this.state.plans.set(key, await readPlanUsage(lookup.source, { now }));
    }
  }

  /**
   * Reads one account's usage endpoint now, for a careful cap. When
   * allowances are read only on request, the kept reading stands, as
   * myna's heldRead leaves it; refreshAll is the user's ask.
   */
  public async refresh(
    provider: GatewayProvider,
    account: GatewayAccount,
    now: number = Date.now(),
  ): Promise<void> {
    if (!this.readable(account) || this.readsAsked()) {
      return;
    }
    this.readAt.set(accountKey(provider, account), now);
    await this.poll(provider, account, now);
  }

  /** Whether this account has an allowance to read at all. */
  private readable(account: GatewayAccount): boolean {
    if (account.usageUrl !== undefined) {
      return true;
    }
    return account.agent === "factory" && this.gatewayDir !== undefined;
  }

  private async poll(
    provider: GatewayProvider,
    account: GatewayAccount,
    now: number,
  ): Promise<void> {
    if (account.agent === "factory") {
      await this.pollFactory(provider, account, now);
      return;
    }
    if (account.usageUrl === undefined) {
      return;
    }
    try {
      const response = await fetch(account.usageUrl, {
        headers: buildUpstreamHeaders(provider, account, {}),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        return;
      }
      const payload: unknown = await response.json();
      const reading = readUsage(payload, now);
      if (reading === null) {
        return;
      }
      this.state.usage.set(accountKey(provider, account), reading);
      this.onReading?.(provider, account, reading);
    } catch (error) {
      this.logger.warn(
        { err: error, provider: provider.id, account: account.id },
        "Cannot read the account usage endpoint",
      );
    }
  }

  /**
   * Factory's allowance comes from its key, not a `usageUrl`: the account
   * the provider names is read from the subscription store and asked
   * (`factory_usage.go`).
   */
  private async pollFactory(
    provider: GatewayProvider,
    account: GatewayAccount,
    now: number,
  ): Promise<void> {
    if (this.gatewayDir === undefined) {
      return;
    }
    const found = await loadSubscriptionAccount(
      this.gatewayDir,
      "factory",
      account.subscriptionUser ?? "",
    );
    if (found === null || found.agent !== "factory") {
      return;
    }
    const reading = await readFactoryUsage({ account: found, now });
    if ("error" in reading) {
      this.logger.warn(
        { error: reading.error, provider: provider.id, account: account.id },
        "Cannot read the Factory account's limits",
      );
      return;
    }
    this.state.usage.set(accountKey(provider, account), reading);
    this.onReading?.(provider, account, reading);
  }
}

/**
 * Accepts `remaining` / `remaining_tokens`, `limit` / `total`, and reset
 * timestamps; a vendor that reports each usage window separately puts them
 * under `windows` (or `window_caps`, Claude's own spelling), which cap
 * windows are read from.
 */
export function readUsage(payload: unknown, now: number): UsageReading | null {
  if (!isRecord(payload)) {
    return null;
  }
  const remaining = firstNumber(payload, ["remaining", "remainingTokens", "remaining_tokens"]);
  const limit = firstNumber(payload, ["limit", "total", "limitTokens"]);
  const reset = firstTimestamp(payload, ["resetAt", "reset_at", "resetsAt", "resets_at"], now);
  const windows = readWindows(payload, now);
  if (remaining === null && limit === null && windows.length === 0) {
    return null;
  }
  const usedPercent =
    remaining !== null && limit !== null && limit > 0
      ? Math.min(100, Math.max(0, ((limit - remaining) / limit) * 100))
      : null;
  return {
    remaining,
    limit,
    resetAt: reset,
    usedPercent,
    readAt: now,
    ...(windows.length === 0 ? {} : { windows }),
  };
}

/** The per-window shares a usage answer carries, where it carries any. */
function readWindows(payload: Record<string, unknown>, now: number): UsageWindow[] {
  const raw = payload.windows ?? payload.window_caps;
  if (!Array.isArray(raw)) {
    return [];
  }
  const windows: UsageWindow[] = [];
  for (const item of raw) {
    if (!isRecord(item)) {
      continue;
    }
    const key = firstText(item, ["key", "name", "id", "window"]);
    if (key === null) {
      continue;
    }
    const used = firstNumber(item, [
      "usedPercent",
      "used_percent",
      "used_pct",
      "utilization",
      "percent",
    ]);
    const resetsAt = firstTimestamp(item, ["resetsAt", "resets_at", "resetAt", "reset_at"], now);
    windows.push({ key, usedPercent: used ?? usedShare(item), resetsAt });
  }
  return windows;
}

/** A window told as used and limit, in percent. */
function usedShare(window: Record<string, unknown>): number | null {
  const used = firstNumber(window, ["used", "usedTokens", "used_tokens"]);
  const limit = firstNumber(window, ["limit", "total", "cap"]);
  if (used === null || limit === null || limit <= 0) {
    return null;
  }
  return Math.min(100, Math.max(0, (used / limit) * 100));
}

function firstText(record: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function firstNumber(record: Record<string, unknown>, names: string[]): number | null {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function firstTimestamp(
  record: Record<string, unknown>,
  names: string[],
  now: number,
): number | null {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 10_000_000_000 ? value : now + value * 1000;
    }
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
