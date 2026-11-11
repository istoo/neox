import {
  accountKey,
  accountSpendUsd,
  createAccountRoutingState,
  type AccountRoutingState,
} from "./accounts.js";
import { describeEffectiveProxy } from "../network/index.js";
import { RateLimiter } from "./access.js";
import type { GatewayConfigStore, GatewayConfig } from "./config.js";
import { providerAccounts } from "./config.js";
import { QuotaTracker } from "./quota.js";
import type { PricingCatalog } from "./pricing-catalog.js";
import type { SavedRest } from "./rests.js";
import { RestTable, type RoutingState } from "./routing.js";
import { RouteTrace } from "./route-trace.js";
import type { UsageLedger } from "./usage.js";
import type { QuotaHistoryStore } from "./quota-history.js";
import type { UsagePoller } from "./usage-poller.js";
import type { WarmupScheduler } from "./warmup.js";
import type { Masker } from "./masking.js";
import type { MaskingRecordStore } from "./masking-records.js";
import type { GuardService } from "../privacy/service.js";
import type { TurnTracker } from "./turndone.js";
import type { GatewayArchive } from "./gateway-archive.js";
import type { RouteHistory } from "./route-history.js";
import type { ListRefreshScheduler } from "./list-refresh.js";
import type { CheckinService } from "./checkin/service.js";

/**
 * Everything a running gateway remembers. The router and the settings RPC share
 * one instance so the UI shows the same rest and quota state the router uses.
 */
export interface GatewayRuntime {
  routingState: RoutingState;
  accountState: AccountRoutingState;
  quotaTracker: QuotaTracker;
  rateLimiter: RateLimiter;
  /** The Routing page's recent requests, newest first. */
  routeTrace: RouteTrace;
  startedAt: number;
  /** Called after a conversation binding changes, so it can be persisted. */
  onStickyChange?: () => void;
  /** Called after a credit-ladder rest starts or ends, so it can be persisted. */
  onRestChange?: (rest: SavedRest) => void;
  onRestCleared?: (key: string) => void;
  /** models.dev list prices, used when `gateway.json` has no manual price. */
  pricing?: PricingCatalog;
  /**
   * The providers whose model lists are kept fresh on their own schedule;
   * `neolix sync` asks it, so an explicit refresh shares its retry guard.
   */
  listRefresh?: ListRefreshScheduler;
}

export function createGatewayRuntime(
  ledger: UsageLedger,
  options: {
    sticky?: ReadonlyMap<string, string>;
    creditLevels?: ReadonlyMap<string, number>;
    onStickyChange?: () => void;
    onRestChange?: (rest: SavedRest) => void;
    onRestCleared?: (key: string) => void;
    pricing?: PricingCatalog;
    listRefresh?: ListRefreshScheduler;
  } = {},
): GatewayRuntime {
  const routingState: RoutingState = {
    rest: new RestTable(),
    rotationCursors: new Map(),
    usageCounts: new Map(),
    sticky: new Map(options.sticky ?? []),
    lastUsed: new Map(),
    speedProbes: new Map(),
    drainAt: new Map(),
    spent: new Set(),
  };
  const quotaTracker = new QuotaTracker();
  const now = Date.now();
  for (const entry of ledger.accountUsageHistory(now)) {
    // The live path records under `provider/account` (attempts.ts), so the
    // replay has to use the same key or a restart forgets every window.
    // The live path records under `provider/account` (attempts.ts), so the
    // replay has to use the same key or a restart forgets every window.
    quotaTracker.record(`${entry.provider}/${entry.account}`, entry.at, entry.tokens);
  }
  const accountState = createAccountRoutingState(routingState.rest);
  for (const [key, level] of options.creditLevels ?? []) {
    accountState.credit.set(key, level);
  }
  return {
    routingState,
    accountState,
    quotaTracker,
    rateLimiter: new RateLimiter(),
    routeTrace: new RouteTrace(),
    startedAt: now,
    ...(options.onStickyChange === undefined ? {} : { onStickyChange: options.onStickyChange }),
    ...(options.onRestChange === undefined ? {} : { onRestChange: options.onRestChange }),
    ...(options.onRestCleared === undefined ? {} : { onRestCleared: options.onRestCleared }),
    ...(options.pricing === undefined ? {} : { pricing: options.pricing }),
    ...(options.listRefresh === undefined ? {} : { listRefresh: options.listRefresh }),
  };
}

export interface GatewayAccountStatus {
  provider: string;
  account: string;
  enabled: boolean;
  priority: number;
  weight: number;
  inflight: number;
  restingUntil: number | null;
  tokens5h: number;
  tokens7d: number;
  tokens5hCap: number | null;
  tokens7dCap: number | null;
  spendUsd: number;
  monthlyUsdCap: number | null;
  usedPercent: number | null;
}

export interface GatewayStatus {
  enabled: boolean;
  startedAt: number;
  monthSpendUsd: number;
  budgetUsd: number | null;
  /** The proxy upstream requests use, its login left out, and what chose it. */
  proxy: string;
  proxySource: "settings" | "environment" | "system" | "off" | "none";
  accounts: GatewayAccountStatus[];
  served: Array<{ key: string; count: number }>;
  recent: Array<{
    time: string;
    requested: string;
    provider: string;
    account: string | null;
    model: string;
    status: number;
    ok: boolean;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
}

export function snapshotGatewayStatus(input: {
  config: GatewayConfig;
  runtime: GatewayRuntime;
  ledger: UsageLedger;
  now: number;
}): GatewayStatus {
  const accounts: GatewayAccountStatus[] = [];
  for (const provider of input.config.providers) {
    for (const account of providerAccounts(provider)) {
      const key = accountKey(provider, account);
      const usage = input.runtime.quotaTracker.usage(key, input.now);
      accounts.push({
        provider: provider.id,
        account: account.id,
        enabled: account.enabled,
        priority: account.priority,
        weight: account.weight,
        inflight: input.runtime.accountState.inflight.get(key) ?? 0,
        restingUntil: input.runtime.routingState.rest.until(key, input.now),
        tokens5h: usage.tokens5h,
        tokens7d: usage.tokens7d,
        tokens5hCap: account.quota?.tokens5h ?? null,
        tokens7dCap: account.quota?.tokens7d ?? null,
        spendUsd: accountSpendUsd(input.runtime.accountState, provider, account, input.now),
        monthlyUsdCap: account.monthlyUsd ?? null,
        usedPercent: input.runtime.accountState.usage.get(key)?.usedPercent ?? null,
      });
    }
  }
  const proxy = describeEffectiveProxy({
    env: process.env,
    platform: process.platform,
    setting: input.config.proxy ?? "",
  });
  return {
    enabled: input.config.enabled,
    startedAt: input.runtime.startedAt,
    monthSpendUsd: input.ledger.spentThisMonth(input.now),
    budgetUsd: input.config.budget?.monthlyUsd ?? null,
    proxy: proxy.proxy,
    proxySource: proxy.source,
    accounts,
    served: [...input.ledger.countsSnapshot()].map(([key, count]) => ({ key, count })),
    recent: input.ledger.recentEntries().map((entry) => ({
      time: entry.time,
      requested: entry.requested,
      provider: entry.provider,
      account: entry.account,
      model: entry.model,
      status: entry.status,
      ok: entry.ok,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      costUsd: entry.costUsd,
    })),
  };
}
/** The daemon-side objects the settings RPC needs. */
export interface LlmGatewayService {
  configStore: GatewayConfigStore;
  ledger: UsageLedger;
  runtime: GatewayRuntime;
  /** The same masker the /v1 router uses, for the settings page's preview. */
  masker: Masker;
  maskingRecords: MaskingRecordStore;
  /** Settings → Masking's local model, its files and its loaded state. */
  maskingLocalModel: GuardService;
  /** The allowance readings the poller took, kept across restarts. */
  quotaHistory: QuotaHistoryStore;
  /** Reads the accounts' allowance endpoints, on its timer or when asked. */
  usagePoller: UsagePoller;
  /** The scheduler the settings page's Warm up button asks. */
  warmup: WarmupScheduler;
  /** Follows gateway turns; the websocket server forwards each end to the app. */
  turnTracker: TurnTracker;
  /** The request archive on this computer, when one was started. */
  archive?: GatewayArchive;
  /** The routing history kept a day to a file. */
  history?: RouteHistory;
  /** The daily check-ins the Usage card shows and a press asks for. */
  checkin?: CheckinService;
}
