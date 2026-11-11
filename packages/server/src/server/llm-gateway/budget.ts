import { readFile } from "node:fs/promises";
import { gatewayKeyEntries, type GatewayConfig, type GatewayKeyLimit } from "./config.js";
import type { UsageRecord } from "./usage.js";

/**
 * Each gateway key's own limits, in myna's sense (internal/budget and
 * internal/access/limit.go). A key can have several limits, each counting
 * in its own window: a calendar day, week or month in local time, or a
 * cycle of N days or N hours from when the limit was set or last reset. A
 * request is let in only while every one of them has something left, and
 * each holds that request's reservation until the call is recorded.
 *
 * The totals are summed from `gateway-usage.jsonl`, the records the Usage
 * page shows, so they survive a restart and are right for a gateway served
 * by another process. Tokens are a call's uncached input, output and cache
 * writes, and its cache reads when the limit says so; cost is the Usage
 * page's estimate at its prices, and a call with no known price adds none.
 */

export type BudgetPeriod = "day" | "week" | "month" | "days" | "hours";

export interface BudgetLimit {
  period: BudgetPeriod;
  /** A "days" period's cycle. */
  days?: number;
  /** An "hours" period's cycle. */
  hours?: number;
  tokens?: number;
  cost?: number;
  cacheReads: boolean;
  /** The cycle's first moment, or when the limit was last reset. */
  since?: string;
}

export interface BudgetWindow {
  start: number;
  reset: number;
}

export interface BudgetStatus {
  period: BudgetPeriod;
  days?: number;
  hours?: number;
  start: number;
  reset: number;
  calls: number;
  tokens: number;
  cost: number;
  unpriced: number;
  inFlight: number;
  reserved: number;
  reservedCost: number;
  tokenLimit: number;
  costLimit: number;
  cacheReads: boolean;
  tokensLeft: number;
  costLeft: number;
  spent: boolean;
}

export interface BudgetRefusal extends BudgetStatus {
  key: string;
  message: string;
  retryAfterSeconds: number;
}

interface Held {
  inFlight: number;
  tokens: number;
  cost: number;
}

interface Totals {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  unpriced: number;
}

interface BudgetRecord {
  time: number;
  key: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  priced: boolean;
}

/**
 * The calls the budget counts, by usage file, kept in memory as myna's
 * budget keeps them. UsageLedger replays the file at start and reports each
 * row as it is recorded, so a check never reads the disk on the request
 * path; the file stays the record the Usage page shows.
 */
const budgetRecords = new Map<string, BudgetRecord[]>();
const held = new Map<string, Held>();

/** Forget the in-memory sums and reservations, as a restart would. */
export function resetBudgetState(): void {
  budgetRecords.clear();
  held.clear();
}

/**
 * Record a call for the budget. Called by UsageLedger.record, before the
 * line reaches the usage file, and for each row the ledger replays at
 * start, so the budget's totals survive a restart without reading the disk
 * on the request path.
 */
export function notePendingRecord(filePath: string, entry: UsageRecord): void {
  if (typeof entry.key !== "string" || entry.key === "") {
    return;
  }
  const time = typeof entry.time === "string" ? Date.parse(entry.time) : Number.NaN;
  if (!Number.isFinite(time)) {
    return;
  }
  const rows = budgetRecords.get(filePath) ?? [];
  rows.push({
    time,
    key: entry.key,
    input: number(entry.inputTokens),
    output: number(entry.outputTokens),
    cacheRead: number(entry.cacheReadTokens),
    cacheWrite: number(entry.cacheWriteTokens),
    cost: number(entry.costUsd),
    priced: entry.priced !== false,
  });
  // The longest window a key can have is ten years, but keeping every row
  // forever is not needed: the oldest fall away well past any limit.
  if (rows.length > 100_000) {
    rows.splice(0, rows.length - 100_000);
  }
  budgetRecords.set(filePath, rows);
}

/**
 * A key's limits: its `limits` list, or the older daily-token and
 * monthly-dollar caps as the equivalent windows, so a config written
 * before the list still holds the key.
 */
export function limitsOf(entry: {
  dailyTokens?: number | undefined;
  monthlyUsd?: number | undefined;
  limits?: GatewayKeyLimit[] | undefined;
}): BudgetLimit[] {
  if (entry.limits !== undefined && entry.limits.length > 0) {
    return entry.limits
      .filter((limit) => (limit.tokens ?? 0) > 0 || (limit.cost ?? 0) > 0)
      .slice(0, 5)
      .map((limit) => ({
        period: limit.period,
        days: limit.days,
        hours: limit.hours,
        tokens: limit.tokens,
        cost: limit.cost,
        cacheReads: limit.cacheReads,
        since: limit.since,
      }));
  }
  const out: BudgetLimit[] = [];
  if (entry.dailyTokens !== undefined && entry.dailyTokens > 0) {
    out.push({ period: "day", tokens: entry.dailyTokens, cacheReads: false });
  }
  if (entry.monthlyUsd !== undefined && entry.monthlyUsd > 0) {
    out.push({ period: "month", cost: entry.monthlyUsd, cacheReads: false });
  }
  return out;
}

/** The limits of the key named `key`, or none. */
export function limitsForKey(config: GatewayConfig, key: string | null): BudgetLimit[] {
  if (key === null) {
    return [];
  }
  const entry = gatewayKeyEntries(config).find((candidate) => candidate.key === key);
  return entry === undefined ? [] : limitsOf(entry);
}

/** Keys whose spending counts against `key`: the key and the ones issued under it. */
export function countedKeys(config: GatewayConfig, key: string): string[] {
  const issued = gatewayKeyEntries(config)
    .filter((entry) => entry.issuer === key && entry.key !== key)
    .map((entry) => entry.key);
  return [key, ...issued];
}

/**
 * The window a limit counts in at `now`, in local time (myna
 * access.Limit.Window). A "days"/"hours" cycle is absolute time, 24h a day
 * whatever the clocks do; one with no `since` runs from the Unix epoch. A
 * calendar window starts at `since` instead when the key was reset in it.
 */
export function windowOf(limit: BudgetLimit, now: Date): BudgetWindow {
  const cycle = cycleOf(limit);
  if (cycle > 0) {
    const anchor = sinceMs(limit) ?? 0;
    const at = now.getTime();
    if (at < anchor) {
      return { start: anchor, reset: anchor + cycle };
    }
    const start = anchor + Math.floor((at - anchor) / cycle) * cycle;
    return { start, reset: start + cycle };
  }
  const { start, reset } = calendarWindow(limit.period, now);
  const since = sinceMs(limit);
  if (since !== null && since > start && since < reset) {
    return { start: since, reset };
  }
  return { start, reset };
}

function cycleOf(limit: BudgetLimit): number {
  switch (limit.period) {
    case "days":
      return Math.min(Math.max(limit.days ?? 1, 1), 3650) * 86_400_000;
    case "hours":
      return Math.min(Math.max(limit.hours ?? 1, 1), 8760) * 3_600_000;
    default:
      return 0;
  }
}

function sinceMs(limit: BudgetLimit): number | null {
  if (limit.since === undefined) {
    return null;
  }
  const at = Date.parse(limit.since);
  return Number.isFinite(at) ? at : null;
}

/** The calendar window of `period` containing `now`, in its own time zone. */
export function calendarWindow(period: BudgetPeriod, now: Date): BudgetWindow {
  const at = now.getTime();
  if (period === "week") {
    const day = now.getDay();
    const sinceMonday = (day + 6) % 7;
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - sinceMonday);
    const reset = new Date(now.getFullYear(), now.getMonth(), now.getDate() - sinceMonday + 7);
    return { start: start.getTime(), reset: reset.getTime() };
  }
  if (period === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const reset = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return { start: start.getTime(), reset: reset.getTime() };
  }
  if (period === "days" || period === "hours") {
    // handled by the cycle above; a hand-written limit with neither falls here
    return { start: at, reset: at + 1 };
  }
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const reset = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { start: start.getTime(), reset: reset.getTime() };
}

/** Read `gateway-usage.jsonl`, re-reading only when it changed. */
function recordsOf(ledgerPath: string): BudgetRecord[] {
  return budgetRecords.get(ledgerPath) ?? [];
}

/**
 * Read `gateway-usage.jsonl` into the budget, for a caller that has not
 * replayed it (a test, or a gateway starting without the ledger). The
 * ledger reports each row it records, so this is not on the request path.
 */
export async function loadUsageFile(ledgerPath: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(ledgerPath, "utf8");
  } catch {
    budgetRecords.delete(ledgerPath);
    return;
  }
  budgetRecords.set(ledgerPath, parseRecords(text));
}

function parseRecords(text: string): BudgetRecord[] {
  const out: BudgetRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    let row: Partial<UsageRecord>;
    try {
      row = JSON.parse(line) as Partial<UsageRecord>;
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null) {
      continue;
    }
    const time = typeof row.time === "string" ? Date.parse(row.time) : Number.NaN;
    if (!Number.isFinite(time) || typeof row.key !== "string") {
      continue;
    }
    out.push({
      time,
      key: row.key,
      input: number(row.inputTokens),
      output: number(row.outputTokens),
      cacheRead: number(row.cacheReadTokens),
      cacheWrite: number(row.cacheWriteTokens),
      cost: number(row.costUsd),
      priced: row.priced !== false,
    });
  }
  return out;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** What the keys' calls came to in a window. */
function totalsOf(
  records: readonly BudgetRecord[],
  keys: readonly string[],
  start: number,
  reset: number,
  cacheReads: boolean,
): Totals {
  const totals: Totals = {
    calls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    unpriced: 0,
  };
  const allowed = new Set(keys);
  for (const record of records) {
    if (record.time < start || record.time >= reset || !allowed.has(record.key)) {
      continue;
    }
    totals.calls += 1;
    totals.input += record.input;
    totals.output += record.output;
    totals.cacheRead += record.cacheRead;
    totals.cacheWrite += record.cacheWrite;
    totals.cost += record.cost;
    if (!record.priced) {
      totals.unpriced += 1;
    }
  }
  // A cache-read count is only summed when a limit asks for it; keep the
  // per-record number so each limit computes its own view.
  void cacheReads;
  return totals;
}

function tokensOf(totals: Totals, limit: BudgetLimit): number {
  const tokens = totals.input + totals.output + totals.cacheWrite;
  return limit.cacheReads ? tokens + totals.cacheRead : tokens;
}

function heldKey(key: string, start: number): string {
  return `${key}\u0000${start}`;
}

function newStatus(
  limit: BudgetLimit,
  window: BudgetWindow,
  totals: Totals,
  reservation: Held | undefined,
): BudgetStatus {
  const tokens = tokensOf(totals, limit);
  const status: BudgetStatus = {
    period: limit.period,
    days: limit.days,
    hours: limit.hours,
    start: window.start,
    reset: window.reset,
    calls: totals.calls,
    tokens,
    cost: totals.cost,
    unpriced: totals.unpriced,
    inFlight: reservation?.inFlight ?? 0,
    reserved: reservation?.tokens ?? 0,
    reservedCost: reservation?.cost ?? 0,
    tokenLimit: limit.tokens ?? 0,
    costLimit: limit.cost ?? 0,
    cacheReads: limit.cacheReads,
    tokensLeft: 0,
    costLeft: 0,
    spent: false,
  };
  if ((limit.tokens ?? 0) > 0) {
    status.tokensLeft = Math.max(limit.tokens! - tokens, 0);
    status.spent = tokens >= limit.tokens!;
  }
  if ((limit.cost ?? 0) > 0) {
    status.costLeft = Math.max(limit.cost! - totals.cost, 0);
    status.spent = status.spent || totals.cost >= limit.cost!;
  }
  return status;
}

/**
 * A key and the keys it was issued under, each with its own limits: a
 * child's request is held to its own limits and to its issuer's, whose
 * windows count every key issued under them (myna budget.Reserve).
 */
interface LimitOwner {
  key: string;
  limits: BudgetLimit[];
}

function limitOwners(config: GatewayConfig, key: string): LimitOwner[] {
  return limitOwnersWith(config, key, limitsForKey(config, key));
}

function limitOwnersWith(
  config: GatewayConfig,
  key: string,
  ownLimits: readonly BudgetLimit[],
): LimitOwner[] {
  const entries = gatewayKeyEntries(config);
  const owners: LimitOwner[] = [];
  const seen = new Set<string>();
  if (ownLimits.length > 0) {
    owners.push({ key, limits: [...ownLimits] });
    seen.add(key);
  }
  let current: string | null = entries.find((candidate) => candidate.key === key)?.issuer ?? null;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const entry = entries.find((candidate) => candidate.key === current);
    if (entry === undefined) {
      break;
    }
    const limits = limitsOf(entry);
    if (limits.length > 0) {
      owners.push({ key: current, limits });
    }
    current = entry.issuer ?? null;
  }
  return owners;
}

/**
 * Every limit's status now, in the order the key keeps them (myna
 * budget.All). The key's own limits only; an issuer's are enforced on
 * requests, not shown as the child's.
 */
export function statusesOf(
  config: GatewayConfig,
  key: string,
  now: Date,
  ledgerPath: string,
): BudgetStatus[] {
  const limits = limitsForKey(config, key);
  if (limits.length === 0) {
    return [];
  }
  return statusesFor(config, key, limits, now, ledgerPath);
}

function statusesFor(
  config: GatewayConfig,
  owner: string,
  limits: readonly BudgetLimit[],
  now: Date,
  ledgerPath: string,
): BudgetStatus[] {
  const records = recordsOf(ledgerPath);
  const keys = countedKeys(config, owner);
  const byStart = new Map<number, Totals>();
  return limits.map((limit) => {
    const window = windowOf(limit, now);
    let totals = byStart.get(window.start);
    if (totals === undefined) {
      totals = totalsOf(records, keys, window.start, window.reset, limit.cacheReads);
      byStart.set(window.start, totals);
    }
    return newStatus(limit, window, totals, held.get(heldKey(owner, window.start)));
  });
}

/** The status that holds a key most (myna budget.Binding). */
export function bindingStatus(all: readonly BudgetStatus[]): BudgetStatus | null {
  let binding: BudgetStatus | null = null;
  for (const status of all) {
    if (binding === null) {
      binding = status;
      continue;
    }
    if (status.spent !== binding.spent) {
      if (status.spent) {
        binding = status;
      }
      continue;
    }
    if (status.spent) {
      if (status.reset > binding.reset) {
        binding = status;
      }
      continue;
    }
    if (shareOf(status) > shareOf(binding)) {
      binding = status;
    }
  }
  return binding;
}

function shareOf(status: BudgetStatus): number {
  let share = 0;
  if (status.tokenLimit > 0) {
    share = status.tokens / status.tokenLimit;
  }
  if (status.costLimit > 0) {
    share = Math.max(share, status.cost / status.costLimit);
  }
  return share;
}

/**
 * The limit that refuses the key now, or null. Called under no lock: a
 * denial only reads the file and the reservations.
 */
export function refusalOf(
  config: GatewayConfig,
  key: string | null,
  now: Date,
  ledgerPath: string,
): BudgetRefusal | null {
  if (key === null) {
    return null;
  }
  return refusalForLimits(config, key, limitsForKey(config, key), now, ledgerPath);
}

/**
 * `refusalOf` for a caller that already resolved the key's own limits
 * (the gateway principal), so a rule set handed over directly is enforced
 * the same way.
 */
export function refusalForLimits(
  config: GatewayConfig,
  key: string,
  ownLimits: readonly BudgetLimit[],
  now: Date,
  ledgerPath: string,
): BudgetRefusal | null {
  if (key === "") {
    return null;
  }
  let refused: BudgetStatus | null = null;
  for (const owner of limitOwnersWith(config, key, ownLimits)) {
    for (const status of statusesFor(config, owner.key, owner.limits, now, ledgerPath)) {
      if (!overLimit(status)) {
        continue;
      }
      if (refused === null || status.reset > refused.reset) {
        refused = status;
      }
    }
  }
  if (refused === null) {
    return null;
  }
  return { ...refused, key, ...refusalText(refused, now) };
}

function overLimit(status: BudgetStatus): boolean {
  return (
    (status.tokenLimit > 0 && status.tokens + status.reserved >= status.tokenLimit) ||
    (status.costLimit > 0 && status.cost + status.reservedCost >= status.costLimit)
  );
}

function refusalText(
  status: BudgetStatus,
  now: Date,
): { message: string; retryAfterSeconds: number } {
  let what: string;
  if (status.tokenLimit > 0 && status.tokens + status.reserved >= status.tokenLimit) {
    what = status.cacheReads
      ? `${status.tokens} of its ${status.tokenLimit} input, output and cache tokens`
      : `${status.tokens} of its ${status.tokenLimit} input, output and cache-write tokens`;
  } else {
    what = `$${status.cost.toFixed(2)} of its $${status.costLimit.toFixed(2)} estimated cost`;
  }
  if (!status.spent) {
    what += `, with ${status.inFlight} requests in flight holding the rest`;
  }
  const when = new Date(status.reset).toISOString().slice(0, 10);
  return {
    message: `This gateway key has used ${what} for this ${perOf(status)}; it resets at ${when}`,
    retryAfterSeconds: Math.max(Math.ceil((status.reset - now.getTime()) / 1000), 1),
  };
}

/** A limit's window as a sentence ends it: "day", "10-day cycle", "5-hour cycle". */
export function perOf(status: Pick<BudgetStatus, "period" | "days" | "hours">): string {
  switch (status.period) {
    case "days":
      return `${status.days ?? 1}-day cycle`;
    case "hours":
      return `${status.hours ?? 1}-hour cycle`;
    default:
      return status.period;
  }
}

export interface Reservation {
  release(): void;
}

/**
 * Hold a request's expected usage in every window of the key's limits, or
 * refuse it. `body` is the request's size in bytes (-1 unknown); its
 * tokens are estimated at four bytes a token plus the key's mean output per
 * call this window (myna budget.Reserve). A request is let in while used +
 * reserved is under the cap, so parallel requests overshoot by about one
 * call.
 */
export function reserveBudget(input: {
  config: GatewayConfig;
  key: string | null;
  bodyBytes: number;
  now: Date;
  ledgerPath: string;
}): { reservation: Reservation } | { refusal: BudgetRefusal } {
  const { config, key, bodyBytes, now, ledgerPath } = input;
  if (key === null) {
    return { reservation: { release: () => undefined } };
  }
  const owners = limitOwners(config, key);
  if (owners.length === 0) {
    return { reservation: { release: () => undefined } };
  }
  const records = recordsOf(ledgerPath);
  const totalsBySlot = new Map<string, Totals>();
  const totalsFor = (owner: string, start: number, reset: number, cacheReads: boolean): Totals => {
    const slot = heldKey(owner, start);
    let totals = totalsBySlot.get(slot);
    if (totals === undefined) {
      totals = totalsOf(records, countedKeys(config, owner), start, reset, cacheReads);
      totalsBySlot.set(slot, totals);
    }
    return totals;
  };
  let refused: BudgetRefusal | null = null;
  for (const owner of owners) {
    for (const limit of owner.limits) {
      const window = windowOf(limit, now);
      const totals = totalsFor(owner.key, window.start, window.reset, limit.cacheReads);
      const reservation = held.get(heldKey(owner.key, window.start));
      const status = newStatus(limit, window, totals, reservation);
      if (overLimit(status) && (refused === null || status.reset > refused.reset)) {
        refused = { ...status, key, ...refusalText(status, now) };
      }
    }
  }
  if (refused !== null) {
    return { refusal: refused };
  }
  const holds: Array<{ key: string; held: Held; tokens: number; cost: number }> = [];
  const seen = new Set<string>();
  for (const owner of owners) {
    for (const limit of owner.limits) {
      const window = windowOf(limit, now);
      const slot = heldKey(owner.key, window.start);
      if (seen.has(slot)) {
        continue;
      }
      seen.add(slot);
      const totals = totalsFor(owner.key, window.start, window.reset, limit.cacheReads);
      let estimate = Math.max(bodyBytes, 0) / 4;
      if (totals.calls > 0) {
        estimate += totals.output / totals.calls;
      }
      const estimateTokens = Math.round(estimate);
      let estimateCost = 0;
      if ((limit.cost ?? 0) > 0 && estimateTokens > 0) {
        const tokens = tokensOf(totals, limit);
        estimateCost = tokens > 0 && totals.cost > 0 ? (estimateTokens * totals.cost) / tokens : 0;
      }
      let reservation = held.get(slot);
      if (reservation === undefined) {
        reservation = { inFlight: 0, tokens: 0, cost: 0 };
        held.set(slot, reservation);
      }
      reservation.inFlight += 1;
      reservation.tokens += estimateTokens;
      reservation.cost += estimateCost;
      holds.push({ key: slot, held: reservation, tokens: estimateTokens, cost: estimateCost });
    }
  }
  let released = false;
  return {
    reservation: {
      release() {
        if (released) {
          return;
        }
        released = true;
        for (const hold of holds) {
          hold.held.inFlight -= 1;
          hold.held.tokens -= hold.tokens;
          hold.held.cost -= hold.cost;
          if (hold.held.inFlight <= 0 && held.get(hold.key) === hold.held) {
            held.delete(hold.key);
          }
        }
      },
    },
  };
}
