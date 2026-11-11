import type {
  GatewayQuotaAccountWire,
  GatewayQuotaPointWire,
  GatewayQuotaWindowWire,
  GatewayQuotaWire,
} from "@neolix/protocol/gateway";
import {
  accountKey,
  accountSpendUsd,
  type AccountRoutingState,
  type AccountUsageReading,
} from "./accounts.js";
import {
  isProviderEnabled,
  providerAccounts,
  type GatewayAccount,
  type GatewayProvider,
} from "./config.js";
import {
  noAccessKeyError,
  planKeyOf,
  planLookupOf,
  type PlanCard,
  type PlanSource,
} from "./plan-usage.js";
import type { QuotaHistoryEntry } from "./quota-history.js";
import type { QuotaTracker } from "./quota.js";
import type { GatewayRuntime } from "./runtime.js";
import type { AccountTokenEntry } from "./usage.js";

const FIVE_HOURS_MS = 5 * 60 * 60_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60_000;
/** A window warmed less than this ago reads as started, as myna's slack has it. */
const WARM_SLACK_MS = 10 * 60_000;
/** Under this share the vendor's rounded percentage is too coarse to scale up. */
const HOLD_MIN_PERCENT = 5;
/** The most points one token window's curve is sent with, evenly sampled. */
const MAX_TOKEN_POINTS = 300;

/**
 * The allowance cards' data: each gateway account's windows, the reading its
 * own usage endpoint last answered, the readings over time, and what the
 * ledger's calls say the windows hold. An account with neither a usage
 * endpoint nor token caps has no windows and is not drawn.
 */
export interface QuotaSnapshotRuntime {
  routingState: Pick<GatewayRuntime["routingState"], "rest">;
  accountState: AccountRoutingState;
  quotaTracker: QuotaTracker;
}

interface QuotaSnapshotInput {
  providers: readonly GatewayProvider[];
  runtime: QuotaSnapshotRuntime;
  history: ReadonlyMap<string, readonly QuotaHistoryEntry[]>;
  /** The ledger's served calls, the token windows' curves and the wholes replay. */
  usage: readonly AccountTokenEntry[];
  /** How far back those curves go. */
  since: number;
  now: number;
}

export function snapshotGatewayQuota(input: QuotaSnapshotInput): GatewayQuotaWire {
  const accounts: GatewayQuotaAccountWire[] = [];
  const usageByAccount = groupUsage(input.usage);
  // The plans some provider has the access key for, as myna's keyed maps:
  // a plan no provider can read is only a card saying so when none can.
  const keyedPlans = new Set<string>();
  for (const provider of input.providers) {
    if (!isProviderEnabled(provider)) {
      continue;
    }
    const lookup = planLookupOf(provider);
    if (lookup?.kind === "read") {
      keyedPlans.add(planIdentity(lookup.source));
    }
  }
  const shownPlans = new Set<string>();
  for (const provider of input.providers) {
    if (!isProviderEnabled(provider)) {
      continue;
    }
    for (const account of providerAccounts(provider)) {
      const card = accountCardOf(input, usageByAccount, provider, account);
      if (card !== null) {
        accounts.push(card);
      }
    }
    accounts.push(...planCardsOf(input, provider, shownPlans, keyedPlans));
  }
  return { accounts, until: input.now };
}

/** One account's card, or null when it has no window to draw. */
function accountCardOf(
  input: QuotaSnapshotInput,
  usageByAccount: Map<string, AccountTokenEntry[]>,
  provider: GatewayProvider,
  account: GatewayAccount,
): GatewayQuotaAccountWire | null {
  const key = accountKey(provider, account);
  const reading = input.runtime.accountState.usage.get(key);
  const points = input.history.get(key) ?? [];
  const entries = usageByAccount.get(key) ?? [];
  const lastRequestAt = entries.at(-1)?.at ?? null;
  const windows = windowsOf({ input, key, account, entries });
  if (windows.length === 0) {
    return null;
  }
  return {
    id: key,
    provider: provider.id,
    providerLabel: provider.label ?? provider.id,
    account: account.id,
    accountLabel: account.label ?? account.id,
    enabled: account.enabled,
    restingUntil: input.runtime.routingState.rest.until(key, input.now),
    windows,
    spendUsd: accountSpendUsd(input.runtime.accountState, provider, account, input.now),
    monthlyUsdCap: account.monthlyUsd ?? null,
    canWarm: warmable(provider, account, reading, lastRequestAt, input.now),
    warmup: account.warmup,
    lastReadAt: reading?.readAt ?? null,
    history: points.map((entry) =>
      Object.assign(
        { at: entry.at, usedPercent: entry.usedPercent, resetsAt: entry.resetAt },
        entry.device === undefined ? {} : { device: entry.device },
      ),
    ),
  };
}

/** The windows one account's card draws: its usage endpoint's, and its caps'. */
function windowsOf(args: {
  input: QuotaSnapshotInput;
  key: string;
  account: GatewayAccount;
  entries: readonly AccountTokenEntry[];
}): GatewayQuotaWindowWire[] {
  const { input, key, account, entries } = args;
  const windows: GatewayQuotaWindowWire[] = [];
  const reading = input.runtime.accountState.usage.get(key);
  if (reading !== undefined) {
    const points = input.history.get(key) ?? [];
    windows.push({
      id: "usage",
      kind: "allowance",
      usedPercent: reading.usedPercent,
      remaining: reading.remaining,
      limit: reading.limit,
      resetsAt: reading.resetAt,
      pacePct: allowancePace(points, reading.usedPercent, reading.resetAt, input.now),
      ...holdsOf(entries, cycleStart(points, reading.resetAt), reading.usedPercent, input.now),
    });
  }
  const usage = input.runtime.quotaTracker.usage(key, input.now);
  if (account.quota?.tokens5h !== undefined) {
    windows.push(
      tokenWindow(
        "tokens5h",
        usage.tokens5h,
        account.quota.tokens5h,
        FIVE_HOURS_MS,
        tokenHistory(entries, account.quota.tokens5h, FIVE_HOURS_MS, input.since),
      ),
    );
  }
  if (account.quota?.tokens7d !== undefined) {
    windows.push(
      tokenWindow(
        "tokens7d",
        usage.tokens7d,
        account.quota.tokens7d,
        SEVEN_DAYS_MS,
        tokenHistory(entries, account.quota.tokens7d, SEVEN_DAYS_MS, input.since),
      ),
    );
  }
  return windows;
}

/** A plan without its access key: what myna's keyed maps compare. */
function planIdentity(source: Omit<PlanSource, "accessKeyId" | "secretAccessKey">): string {
  return `${source.vendor}:${source.action ?? source.region}`;
}

/**
 * The cards a provider's plans draw — one for Ark's Coding or Agent Plan,
 * one per TokenHub team — or, when the access key is missing where myna
 * shows one, a card that says what to give. Nothing once another provider
 * sharing the plan has drawn it.
 */
function planCardsOf(
  input: { runtime: QuotaSnapshotRuntime },
  provider: GatewayProvider,
  shown: Set<string>,
  keyed: ReadonlySet<string>,
): GatewayQuotaAccountWire[] {
  const lookup = planLookupOf(provider);
  if (lookup === null) {
    return [];
  }
  if (lookup.kind === "read") {
    const key = planKeyOf(lookup.source);
    const reading = input.runtime.accountState.plans.get(key);
    if (reading === undefined || shown.has(key)) {
      return [];
    }
    shown.add(key);
    return reading.cards.map((card) => planCardWire(provider, card, reading.readAt));
  }
  // No access key. Volcengine says so unless the account reads that plan
  // elsewhere; Guangzhou serves TokenHub's personal plan too, whose usage
  // has no API, so no card says so there (myna's tencentPlanQuotas).
  const identity = planIdentity(lookup);
  if (shown.has(`none:${identity}`) || keyed.has(identity)) {
    return [];
  }
  if (lookup.vendor === "tencent" && lookup.region === "ap-guangzhou") {
    return [];
  }
  shown.add(`none:${identity}`);
  return [
    {
      id: `${provider.id}/plan/${identity}`,
      provider: provider.id,
      providerLabel: provider.label ?? provider.id,
      account: "plan",
      accountLabel: lookup.plan,
      enabled: true,
      restingUntil: null,
      windows: [],
      spendUsd: 0,
      monthlyUsdCap: null,
      canWarm: false,
      warmup: false,
      lastReadAt: null,
      history: [],
      kind: "plan",
      providerId: provider.id,
      planId: identity,
      error: noAccessKeyError(provider, lookup.vendor),
    },
  ];
}

/** One plan card: no account, its own windows, and why it has none if it doesn't. */
function planCardWire(
  provider: GatewayProvider,
  card: PlanCard,
  readAt: number,
): GatewayQuotaAccountWire {
  return {
    id: `${provider.id}/plan/${card.id}`,
    provider: provider.id,
    providerLabel: provider.label ?? provider.id,
    account: "plan",
    accountLabel: card.user === undefined ? card.plan : `${card.plan} · ${card.user}`,
    enabled: true,
    restingUntil: null,
    windows: card.windows.map((window) => ({
      id: window.id,
      kind: "allowance",
      name: window.name,
      usedPercent: window.usedPercent,
      remaining: window.remaining,
      limit: window.limit,
      resetsAt: window.resetsAt,
      pacePct: null,
      windowMs: window.windowMs,
    })),
    spendUsd: 0,
    monthlyUsdCap: null,
    canWarm: false,
    warmup: false,
    lastReadAt: readAt,
    history: [],
    kind: "plan",
    providerId: provider.id,
    planId: card.id,
    ...(card.error === undefined ? {} : { error: card.error }),
  };
}

function tokenWindow(
  id: "tokens5h" | "tokens7d",
  used: number,
  limit: number,
  windowMs: number,
  history: GatewayQuotaPointWire[],
): GatewayQuotaWindowWire {
  const usedPercent = limit > 0 ? clampPercent((used / limit) * 100) : null;
  return {
    id,
    kind: id,
    usedPercent,
    remaining: Math.max(0, limit - used),
    limit,
    // A rolling window frees up as its oldest use leaves, not at a fixed time.
    resetsAt: null,
    pacePct: null,
    windowMs,
    ...(history.length > 0 ? { history } : {}),
  };
}

/**
 * A window that has not started: myna shows Warm up only then. A reset still
 * ahead and nothing used means the window is idle, unless a call went out
 * inside the five hours that reset closes — the ledger's last call for the
 * account is how that is told.
 */
function warmable(
  provider: GatewayProvider,
  account: GatewayAccount,
  reading: AccountUsageReading | undefined,
  lastRequestAt: number | null,
  now: number,
): boolean {
  if (!account.enabled || provider.models.length === 0) {
    return false;
  }
  if (reading === undefined) {
    return true;
  }
  const resetAt = reading.resetAt;
  if (resetAt === null) {
    return reading.usedPercent === null || reading.usedPercent <= 0;
  }
  if (resetAt <= now) {
    return true;
  }
  if (reading.usedPercent !== null && reading.usedPercent > 0) {
    return false;
  }
  if (resetAt - now < FIVE_HOURS_MS - WARM_SLACK_MS) {
    return false;
  }
  if (lastRequestAt !== null && lastRequestAt >= resetAt - FIVE_HOURS_MS) {
    return false;
  }
  return true;
}

/**
 * What the whole window holds, reckoned myna's way: the calls the gateway
 * routed through the account in this window, over the share the vendor says is
 * used. Reasons it can't be told are myna's too.
 */
function holdsOf(
  entries: readonly AccountTokenEntry[],
  start: number | null,
  usedPercent: number | null,
  now: number,
): Pick<GatewayQuotaWindowWire, "holds" | "holdsWhy"> {
  if (usedPercent === null) {
    return { holdsWhy: "clock" };
  }
  if (usedPercent < HOLD_MIN_PERCENT) {
    return { holdsWhy: "low" };
  }
  if (start === null) {
    return { holdsWhy: "clock" };
  }
  const fraction = usedPercent / 100;
  let tokens = 0;
  let costUsd = 0;
  let cacheReadTokens = 0;
  let calls = 0;
  for (const entry of entries) {
    if (entry.at < start) {
      continue;
    }
    if (entry.at > now) {
      break;
    }
    tokens += entry.tokens;
    costUsd += entry.costUsd;
    cacheReadTokens += entry.cacheReadTokens;
    calls += 1;
  }
  if (calls === 0) {
    return { holdsWhy: "none" };
  }
  return {
    holds: {
      tokens: Math.round(tokens / fraction),
      costUsd: costUsd / fraction,
      // A whole is as priced as the calls it was reckoned from.
      priced: costUsd > 0,
      calls,
      cacheReadTokens,
      since: start,
    },
  };
}

/** One point per served call, the trailing window's tokens over the cap. */
function tokenHistory(
  entries: readonly AccountTokenEntry[],
  limit: number,
  windowMs: number,
  since: number,
): GatewayQuotaPointWire[] {
  if (limit <= 0) {
    return [];
  }
  const points: GatewayQuotaPointWire[] = [];
  let first = 0;
  let sum = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    sum += entry.tokens;
    while (first <= index && entries[first]!.at <= entry.at - windowMs) {
      sum -= entries[first]!.tokens;
      first += 1;
    }
    if (entry.at < since) {
      continue;
    }
    points.push({
      at: entry.at,
      usedPercent: clampPercent((sum / limit) * 100),
      resetsAt: null,
    });
  }
  return sample(points);
}

/** Evenly sampled to what one response carries. */
function sample(points: GatewayQuotaPointWire[]): GatewayQuotaPointWire[] {
  if (points.length <= MAX_TOKEN_POINTS) {
    return points;
  }
  const step = Math.ceil(points.length / MAX_TOKEN_POINTS);
  const out: GatewayQuotaPointWire[] = [];
  for (let index = 0; index < points.length; index += step) {
    out.push(points[index]!);
  }
  const last = points.at(-1);
  if (last !== undefined && out.at(-1) !== last) {
    out.push(last);
  }
  return out;
}

function groupUsage(entries: readonly AccountTokenEntry[]): Map<string, AccountTokenEntry[]> {
  const grouped = new Map<string, AccountTokenEntry[]>();
  for (const entry of entries) {
    const key = `${entry.provider}/${entry.account}`;
    const list = grouped.get(key);
    if (list === undefined) {
      grouped.set(key, [entry]);
    } else {
      list.push(entry);
    }
  }
  for (const list of grouped.values()) {
    list.sort((left, right) => left.at - right.at);
  }
  return grouped;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * How much faster than an even burn the account is spending, in points of
 * allowance: +31 means 31 points more used than a straight line from the
 * cycle's first reading to its reset. Null until a cycle's start is known.
 */
function allowancePace(
  points: readonly QuotaHistoryEntry[],
  usedPercent: number | null,
  resetsAt: number | null,
  now: number,
): number | null {
  if (usedPercent === null || resetsAt === null || resetsAt <= now) {
    return null;
  }
  const start = cycleStart(points, resetsAt);
  if (start === null || resetsAt <= start) {
    return null;
  }
  const elapsed = Math.min(1, Math.max(0, (now - start) / (resetsAt - start)));
  return usedPercent - elapsed * 100;
}

/** The earliest reading of the run whose reset is the one now in force. */
function cycleStart(points: readonly QuotaHistoryEntry[], resetsAt: number | null): number | null {
  if (resetsAt === null) {
    return null;
  }
  let start: number | null = null;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index]!;
    if (point.resetAt !== null && point.resetAt !== resetsAt) {
      break;
    }
    start = point.at;
  }
  return start;
}

/** The account a Warm up names, when it is in the config. */
export function findAccount(
  providers: readonly GatewayProvider[],
  providerId: string,
  accountId: string,
): { provider: GatewayProvider; account: GatewayAccount } | null {
  for (const provider of providers) {
    if (provider.id !== providerId || !isProviderEnabled(provider)) {
      continue;
    }
    for (const account of providerAccounts(provider)) {
      if (account.id === accountId) {
        return { provider, account };
      }
    }
  }
  return null;
}
