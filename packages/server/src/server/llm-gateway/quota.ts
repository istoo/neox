const FIVE_HOURS_MS = 5 * 60 * 60_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60_000;

export interface AccountQuota {
  tokens5h?: number;
  tokens7d?: number;
}

interface UsageEntry {
  at: number;
  tokens: number;
}

export interface QuotaUsage {
  tokens5h: number;
  tokens7d: number;
}

/**
 * Rolling token windows per account. Vendors count allowance over a moving
 * window rather than per calendar day, so the tracker keeps individual entries
 * and drops the ones that fell out of the window.
 */
export class QuotaTracker {
  private readonly entries = new Map<string, UsageEntry[]>();

  public record(key: string, at: number, tokens: number): void {
    if (tokens <= 0) {
      return;
    }
    const list = this.entries.get(key);
    if (list === undefined) {
      this.entries.set(key, [{ at, tokens }]);
      return;
    }
    list.push({ at, tokens });
    this.prune(list, at);
  }

  public usage(key: string, now: number): QuotaUsage {
    const list = this.entries.get(key);
    if (list === undefined) {
      return { tokens5h: 0, tokens7d: 0 };
    }
    this.prune(list, now);
    return {
      tokens5h: sumSince(list, now - FIVE_HOURS_MS),
      tokens7d: sumSince(list, now - SEVEN_DAYS_MS),
    };
  }

  /** When the account's own caps free up, or null when it has room. */
  public restedUntil(key: string, now: number, quota: AccountQuota): number | null {
    const list = this.entries.get(key) ?? [];
    this.prune(list, now);
    const fiveHour = overflowUntil(list, now, quota.tokens5h, FIVE_HOURS_MS);
    const sevenDay = overflowUntil(list, now, quota.tokens7d, SEVEN_DAYS_MS);
    if (fiveHour === null && sevenDay === null) {
      return null;
    }
    return Math.max(fiveHour ?? 0, sevenDay ?? 0);
  }

  public forget(key: string): void {
    this.entries.delete(key);
  }

  private prune(list: UsageEntry[], now: number): void {
    const cutoff = now - SEVEN_DAYS_MS;
    let firstFresh = 0;
    while (firstFresh < list.length && list[firstFresh]!.at <= cutoff) {
      firstFresh += 1;
    }
    if (firstFresh > 0) {
      list.splice(0, firstFresh);
    }
  }
}

function sumSince(list: UsageEntry[], since: number): number {
  let total = 0;
  for (const entry of list) {
    if (entry.at > since) {
      total += entry.tokens;
    }
  }
  return total;
}

/**
 * The moment enough of the oldest entries leave the window to fall under the
 * cap again, or null when the window is already under it.
 */
function overflowUntil(
  list: UsageEntry[],
  now: number,
  cap: number | undefined,
  windowMs: number,
): number | null {
  if (cap === undefined) {
    return null;
  }
  const since = now - windowMs;
  const inside = list.filter((entry) => entry.at > since).sort((a, b) => a.at - b.at);
  let total = inside.reduce((sum, entry) => sum + entry.tokens, 0);
  if (total < cap) {
    return null;
  }
  for (const entry of inside) {
    total -= entry.tokens;
    if (total < cap) {
      // The wait ends when this entry leaves the window.
      return entry.at + windowMs;
    }
  }
  const last = inside[inside.length - 1];
  return last === undefined ? now : last.at + windowMs;
}

export interface QuotaSnapshot {
  remainingTokens: number | null;
  resetAt: number | null;
  remainingRequests: number | null;
}

/**
 * Reads the rate-limit headers Anthropic and OpenAI style APIs expose. Unknown
 * or missing headers yield null so the caller keeps its own accounting.
 */
export function quotaFromHeaders(headers: Headers, now: number): QuotaSnapshot | null {
  const anthropicTokens = readNumber(headers.get("anthropic-ratelimit-tokens-remaining"));
  const anthropicReset = readTimestamp(headers.get("anthropic-ratelimit-tokens-reset"), now);
  const openaiTokens = readNumber(headers.get("x-ratelimit-remaining-tokens"));
  const openaiReset = readDuration(headers.get("x-ratelimit-reset-tokens"), now);
  const openaiRequests = readNumber(headers.get("x-ratelimit-remaining-requests"));

  const remainingTokens = anthropicTokens ?? openaiTokens;
  const remainingRequests =
    readNumber(headers.get("anthropic-ratelimit-requests-remaining")) ?? openaiRequests;
  const resetAt = anthropicReset ?? openaiReset;
  if (remainingTokens === null && remainingRequests === null) {
    return null;
  }
  return { remainingTokens, remainingRequests, resetAt };
}

/** True when the vendor says there is nothing left in the current window. */
export function isExhausted(snapshot: QuotaSnapshot): boolean {
  if (snapshot.remainingTokens !== null && snapshot.remainingTokens <= 0) {
    return true;
  }
  return snapshot.remainingRequests !== null && snapshot.remainingRequests <= 0;
}

function readNumber(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readTimestamp(value: string | null, now: number): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? readDuration(value, now) : parsed;
}

/** Parses durations such as `1.5s`, `6m0s`, `200ms`. */
function readDuration(value: string | null, now: number): number | null {
  if (value === null) {
    return null;
  }
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
  let total = 0;
  let matched = false;
  for (let match = pattern.exec(value); match !== null; match = pattern.exec(value)) {
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2];
    total += amount * unitFactor(unit);
  }
  return matched ? now + total : null;
}

function unitFactor(unit: string | undefined): number {
  switch (unit) {
    case "ms":
      return 1;
    case "m":
      return 60_000;
    case "h":
      return 3_600_000;
    case "d":
      return 86_400_000;
    default:
      return 1000;
  }
}
