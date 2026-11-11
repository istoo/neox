import { codexCreditsPlan } from "./codex-credits.js";
import { codexLimitsOf } from "./codex-limits.js";
import { providerAccounts, type GatewayAccount, type GatewayProvider } from "./config.js";
import { providerKeptToAgent } from "./switch-only.js";
import { planReadingKeyOf, type PlanReading } from "./plan-usage.js";
import {
  accountAtUsageCap,
  poolAtCap,
  queueHasRoom,
  spendCapReached,
  type UsageWindow,
} from "./provider-limits.js";
import type { RestTable } from "./routing.js";
import { windowsFromCodexLimits } from "./warm-windows.js";

export function accountKey(provider: GatewayProvider, account: GatewayAccount): string {
  return `${provider.id}/${account.id}`;
}

export interface AccountSpend {
  month: string;
  usd: number;
  /** The local day the day's spend is counted in, "YYYY-MM-DD". */
  day: string;
  dayUsd: number;
  /** Everything spent on it since the daemon started, for a "total" cap. */
  totalUsd: number;
}

export interface AccountRoutingState {
  rest: RestTable;
  /** Smooth weighted round-robin counters, per provider/account. */
  currentWeight: Map<string, number>;
  inflight: Map<string, number>;
  /** Request timestamps inside the current minute, for `maxRpm`. */
  rpm: Map<string, number[]>;
  spend: Map<string, AccountSpend>;
  /** Requests waiting for a free slot when `queueWaitMs` is set. */
  waiters: Set<() => void>;
  /** How many wait per provider/account, for `queueLength`. */
  waiting: Map<string, number>;
  /** Credit-ladder level per provider/account. */
  credit: Map<string, number>;
  /** Readings from each account's usage endpoint, when one is configured. */
  usage: Map<string, AccountUsageReading>;
  /** Readings from a provider plan's control plane, by access key and plan. */
  plans: Map<string, PlanReading>;
}

/** One answer from an account's own usage endpoint. */
export interface AccountUsageReading {
  remaining: number | null;
  limit: number | null;
  usedPercent: number | null;
  resetAt: number | null;
  readAt: number;
  /** The vendor's per-window shares, where it reports them (`capWindows`). */
  windows?: UsageWindow[];
}

/**
 * The accounts the gateway may serve a request on. myna's SwitchOnly keeps
 * an agent's own sign-ins out of gateway routing (`provider/routing.go:149`):
 * `neolix accounts switch-only codex|claude on` only moves the sign-in between
 * them. API keys and the other subscription agents still serve.
 */
export function routableAccounts(provider: GatewayProvider): GatewayAccount[] {
  const accounts = providerAccounts(provider);
  if (provider.switchOnly !== true) {
    return accounts;
  }
  return accounts.filter(
    (account) => account.agent !== "claude-code" && account.codexAccountId === undefined,
  );
}

/**
 * The usage reading routing reads for an account: what its usage endpoint
 * last said, or, for a Codex account, the windows its own backend last
 * reported. A Codex account has no usage endpoint; its 5-hour and weekly
 * shares arrive on the replies the gateway relays (`codex-limits`).
 */
function usageReadingOf(
  state: AccountRoutingState,
  provider: GatewayProvider,
  account: GatewayAccount,
): AccountUsageReading | undefined {
  const reading = state.usage.get(accountKey(provider, account));
  if (reading !== undefined) {
    return reading;
  }
  const plan = planReadingOf(state, provider);
  if (plan !== undefined) {
    return plan;
  }
  if (account.codexAccountId === undefined) {
    return undefined;
  }
  const windows = windowsFromCodexLimits(codexLimitsOf(account.codexAccountId));
  if (windows === undefined) {
    return undefined;
  }
  return {
    remaining: null,
    limit: null,
    usedPercent: null,
    resetAt: null,
    readAt: 0,
    windows: windows.map((window) => ({
      key: window.id,
      usedPercent: window.usedPct,
      resetsAt: window.resetsAt,
    })),
  };
}

export function createAccountRoutingState(rest: RestTable): AccountRoutingState {
  return {
    rest,
    currentWeight: new Map(),
    inflight: new Map(),
    rpm: new Map(),
    spend: new Map(),
    waiters: new Set(),
    waiting: new Map(),
    credit: new Map(),
    usage: new Map(),
    plans: new Map(),
  };
}

/**
 * A plan's last reading as the account's allowance: its first window is the
 * one routing holds against a cap, the rest stay for cap windows.
 */
function planReadingOf(
  state: AccountRoutingState,
  provider: GatewayProvider,
): AccountUsageReading | undefined {
  const key = planReadingKeyOf(provider);
  const plan = key === null ? undefined : state.plans.get(key);
  const windows = plan?.cards.flatMap((card) => card.windows) ?? [];
  const main = windows[0];
  if (plan === undefined || main === undefined) {
    return undefined;
  }
  return {
    remaining: main.remaining,
    limit: main.limit,
    usedPercent: main.usedPercent,
    resetAt: main.resetsAt,
    readAt: plan.readAt,
    windows: windows.map((window) => ({
      key: window.id,
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt,
    })),
  };
}

export function addAccountSpend(
  state: AccountRoutingState,
  provider: GatewayProvider,
  account: GatewayAccount,
  usd: number,
  now: number,
): void {
  if (usd <= 0) {
    return;
  }
  const key = accountKey(provider, account);
  const month = localMonth(now);
  const day = localDay(now);
  const existing = state.spend.get(key);
  const monthUsd = existing !== undefined && existing.month === month ? existing.usd : 0;
  const dayUsd = existing !== undefined && existing.day === day ? existing.dayUsd : 0;
  state.spend.set(key, {
    month,
    usd: monthUsd + usd,
    day,
    dayUsd: dayUsd + usd,
    totalUsd: (existing?.totalUsd ?? 0) + usd,
  });
}

/** This computer's day as the spend caps count it (myna's SpendDay). */
function localDay(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** This computer's calendar month, the same time zone as its day and the budgets. */
function localMonth(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** What an account spent in a cap's period: a day, a month, or in all. */
export function accountSpendWithin(
  state: AccountRoutingState,
  provider: GatewayProvider,
  account: GatewayAccount,
  period: "day" | "month" | "total",
  now: number,
): number {
  const existing = state.spend.get(accountKey(provider, account));
  if (existing === undefined) {
    return 0;
  }
  if (period === "total") {
    return existing.totalUsd;
  }
  if (period === "day") {
    return existing.day === localDay(now) ? existing.dayUsd : 0;
  }
  const month = localMonth(now);
  return existing.month === month ? existing.usd : 0;
}

export function accountSpendUsd(
  state: AccountRoutingState,
  provider: GatewayProvider,
  account: GatewayAccount,
  now: number,
): number {
  const existing = state.spend.get(accountKey(provider, account));
  if (existing === undefined) {
    return 0;
  }
  const month = localMonth(now);
  return existing.month === month ? existing.usd : 0;
}

/**
 * Orders one provider's accounts for the next attempt.
 *
 * Priority tiers are absolute: a lower tier is only touched when every higher
 * one is resting or at capacity. Inside a tier, weights decide the share of
 * traffic through smooth weighted round-robin, then a resting account moves
 * behind the awake ones and a full account behind the free ones.
 */
export function planAccounts(input: {
  provider: GatewayProvider;
  state: AccountRoutingState;
  now: number;
  /** Filter accounts that cannot serve this model. */
  modelId?: string;
}): GatewayAccount[] {
  // myna's KeptToAgent: a Claude subscription set to switch-only serves no
  // request through the gateway at all (`provider.go:2248-2258`).
  if (providerKeptToAgent(input.provider)) {
    return [];
  }
  const accounts = routableAccounts(input.provider).filter(
    (account) => account.enabled && servesModel(account, input.modelId),
  );
  // A lone account still goes through the holds below: myna leaves a
  // Codex account set not to spend its credits out even when it is the
  // only one that could answer (restLast's single-candidate branch keeps
  // it only when nothing holds it).
  const keyed = accounts.map((account) => ({
    account,
    key: accountKey(input.provider, account),
  }));
  const tiers = new Map<number, typeof keyed>();
  for (const entry of keyed) {
    const tier = tiers.get(entry.account.priority);
    if (tier === undefined) {
      tiers.set(entry.account.priority, [entry]);
    } else {
      tier.push(entry);
    }
  }
  const priorities = [...tiers.keys()].sort((left, right) => right - left);
  const ordered: GatewayAccount[] = [];
  for (const priority of priorities) {
    const tier = tiers.get(priority) ?? [];
    ordered.push(...weightedOrder(tier, input));
  }
  return moveUnavailableBehind(ordered, input);
}

function servesModel(account: GatewayAccount, modelId: string | undefined): boolean {
  if (modelId === undefined || account.models.length === 0) {
    return true;
  }
  return account.models.includes(modelId) || account.models.includes("*");
}

function rpmFull(
  account: GatewayAccount,
  state: AccountRoutingState,
  key: string,
  now: number,
): boolean {
  if (account.maxRpm === undefined) {
    return false;
  }
  const cutoff = now - 60_000;
  const recent = (state.rpm.get(key) ?? []).filter((at) => at > cutoff);
  state.rpm.set(key, recent);
  return recent.length >= account.maxRpm;
}

function spendFull(
  account: GatewayAccount,
  provider: GatewayProvider,
  state: AccountRoutingState,
  now: number,
): boolean {
  if (
    account.monthlyUsd !== undefined &&
    accountSpendUsd(state, provider, account, now) >= account.monthlyUsd
  ) {
    return true;
  }
  const cap = account.spendCap;
  if (cap === undefined) {
    return false;
  }
  return spendCapReached(cap, accountSpendWithin(state, provider, account, cap.period, now));
}

function weightedOrder(
  tier: { account: GatewayAccount; key: string }[],
  input: { state: AccountRoutingState },
): GatewayAccount[] {
  if (tier.length === 1) {
    return tier.map((entry) => entry.account);
  }
  const total = tier.reduce((sum, entry) => sum + entry.account.weight, 0);
  const ranked = tier.map((entry) => {
    const current = (input.state.currentWeight.get(entry.key) ?? 0) + entry.account.weight;
    input.state.currentWeight.set(entry.key, current);
    return { entry, current };
  });
  ranked.sort((left, right) => right.current - left.current);
  const winner = ranked[0];
  if (winner !== undefined) {
    const current = input.state.currentWeight.get(winner.entry.key) ?? 0;
    input.state.currentWeight.set(winner.entry.key, current - total);
  }
  return ranked.map((entry) => entry.entry.account);
}

/** Awake and below their concurrency cap first; the original order otherwise. */
function moveUnavailableBehind(
  accounts: GatewayAccount[],
  input: { provider: GatewayProvider; state: AccountRoutingState; now: number },
): GatewayAccount[] {
  const free: GatewayAccount[] = [];
  const resting: GatewayAccount[] = [];
  const busy: GatewayAccount[] = [];
  // debt: "last" goes after the other accounts here, not after every other
  // candidate and fallback the walk could ask (myna's creditsLast).
  const creditsLast: GatewayAccount[] = [];
  for (const account of accounts) {
    const key = accountKey(input.provider, account);
    if (input.state.rest.isResting(key, input.now)) {
      resting.push(account);
      continue;
    }
    const reading = usageReadingOf(input.state, input.provider, account);
    const credits = codexCreditsPlan(account, windowUsedUp(reading));
    if (credits.hold) {
      // Held as used up: its credits are not spent while another may answer.
      continue;
    }
    if (credits.first) {
      free.push(account);
      continue;
    }
    if (credits.last) {
      creditsLast.push(account);
      continue;
    }
    if (reading !== undefined && reading.remaining !== null && reading.remaining <= 0) {
      busy.push(account);
      continue;
    }
    if (accountAtUsageCap(account, reading)) {
      busy.push(account);
      continue;
    }
    const inflight = input.state.inflight.get(key) ?? 0;
    if (
      (account.maxConcurrency !== undefined && inflight >= account.maxConcurrency) ||
      rpmFull(account, input.state, key, input.now) ||
      spendFull(account, input.provider, input.state, input.now)
    ) {
      busy.push(account);
      continue;
    }
    free.push(account);
  }
  return [...free, ...busy, ...creditsLast, ...resting];
}

/**
 * Whether every account a candidate could use spends its credits last,
 * with a window already used up: the candidate goes behind the fallbacks
 * too (myna's restLast, which orders credits-last candidates after every
 * candidate that isn't).
 */
export function allAccountsCreditLast(input: {
  provider: GatewayProvider;
  state: AccountRoutingState;
  now: number;
  modelId?: string;
}): boolean {
  // Read without planAccounts: that orders by weight, which advances the
  // rotation counters a second time for one request.
  const accounts = providerKeptToAgent(input.provider)
    ? []
    : routableAccounts(input.provider).filter(
        (account) => account.enabled && servesModel(account, input.modelId),
      );
  if (accounts.length === 0) {
    return false;
  }
  return accounts.every((account) => {
    const reading = usageReadingOf(input.state, input.provider, account);
    return codexCreditsPlan(account, windowUsedUp(reading)).last;
  });
}

/** One of the account's usage windows is used up at the vendor's own 100%. */
function windowUsedUp(reading: AccountUsageReading | undefined): boolean {
  if (reading === undefined) {
    return false;
  }
  if (reading.remaining !== null && reading.remaining <= 0) {
    return true;
  }
  if (reading.usedPercent !== null && reading.usedPercent >= 100) {
    return true;
  }
  return (reading.windows ?? []).some(
    (window) => window.usedPercent !== null && window.usedPercent >= 100,
  );
}

export function acquireAccount(
  state: AccountRoutingState,
  provider: GatewayProvider,
  account: GatewayAccount,
): void {
  const key = accountKey(provider, account);
  state.inflight.set(key, (state.inflight.get(key) ?? 0) + 1);
  const recent = state.rpm.get(key) ?? [];
  recent.push(Date.now());
  state.rpm.set(key, recent);
}

export function releaseAccount(
  state: AccountRoutingState,
  provider: GatewayProvider,
  account: GatewayAccount,
): void {
  const key = accountKey(provider, account);
  const inflight = state.inflight.get(key) ?? 0;
  if (inflight <= 1) {
    state.inflight.delete(key);
  } else {
    state.inflight.set(key, inflight - 1);
  }
  // The last slot freeing is exactly what a queued request waits for, so the
  // wake-up cannot sit only on the branch that leaves a slot busy.
  for (const wake of state.waiters) {
    wake();
  }
  state.waiters.clear();
}

/**
 * Resolves when an account frees up, or after the timeout. With an account,
 * the wait counts against the provider's `queueLength`, and a full queue
 * answers false at once (myna's QueueLimit, `provider.go:206-209`).
 */
export async function waitForFreeAccount(
  state: AccountRoutingState,
  timeoutMs: number,
  queue?: { provider: GatewayProvider; account: GatewayAccount },
): Promise<boolean> {
  const key = queue === undefined ? null : accountKey(queue.provider, queue.account);
  if (key !== null && !queueHasRoom(queue?.provider.queueLength, state.waiting.get(key) ?? 0)) {
    return false;
  }
  if (key !== null) {
    state.waiting.set(key, (state.waiting.get(key) ?? 0) + 1);
  }
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref();
  });
  let wake: (() => void) | null = null;
  const freed = new Promise<void>((resolve) => {
    wake = resolve;
    state.waiters.add(resolve);
  });
  try {
    await Promise.race([timeout, freed]);
    return true;
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
    if (wake !== null) {
      state.waiters.delete(wake);
    }
    if (key !== null) {
      const waiting = (state.waiting.get(key) ?? 1) - 1;
      if (waiting <= 0) {
        state.waiting.delete(key);
      } else {
        state.waiting.set(key, waiting);
      }
    }
  }
}

/** True when at least one account could take a request right now. */
export function hasFreeAccount(
  state: AccountRoutingState,
  provider: GatewayProvider,
  now: number,
  modelId: string | undefined,
): boolean {
  return providerAccounts(provider).some((account) => {
    if (!account.enabled || !servesModel(account, modelId)) {
      return false;
    }
    const key = accountKey(provider, account);
    if (state.rest.isResting(key, now)) {
      return false;
    }
    const reading = usageReadingOf(state, provider, account);
    if (reading !== undefined && reading.remaining !== null && reading.remaining <= 0) {
      return false;
    }
    if (accountAtUsageCap(account, reading) || spendFull(account, provider, state, now)) {
      return false;
    }
    const inflight = state.inflight.get(key) ?? 0;
    if (account.maxConcurrency !== undefined && inflight >= account.maxConcurrency) {
      return false;
    }
    return !rpmFull(account, state, key, now);
  });
}

/**
 * Whether the provider's pool ends at its caps (myna's CapStop,
 * `provider.go:435-439`): every account that serves the model is held by
 * its usage or spend cap, so the request is answered 429 rather than sent
 * to a fallback. False when the provider does not stop at caps.
 */
export function providerAtCap(
  state: AccountRoutingState,
  provider: GatewayProvider,
  now: number,
  modelId: string | undefined,
): boolean {
  const accounts = routableAccounts(provider).filter(
    (account) => account.enabled && servesModel(account, modelId),
  );
  return poolAtCap(provider, accounts, (account) => {
    const reading = usageReadingOf(state, provider, account);
    if (reading !== undefined && reading.remaining !== null && reading.remaining <= 0) {
      return true;
    }
    return accountAtUsageCap(account, reading) || spendFull(account, provider, state, now);
  });
}
