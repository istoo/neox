/**
 * The dollar-to-yuan rate the CNY currency preference converts costs with.
 * Costs stay in USD everywhere; only what is shown is converted. myna's
 * `internal/fx` rules: ask a free, no-key endpoint, keep the answer for a
 * TTL, and fall back to the last rate (or a fixed one) while offline.
 *
 * A vendor's own balance is never converted: it is already in that vendor's
 * currency (see `balance-alerts.ts`).
 */
import { formatWan } from "./format";
import type { DisplayCurrency, NumberUnits } from "@/hooks/use-settings";

const RATE_URL = "https://open.er-api.com/v6/latest/USD";
/** Roughly what a dollar has been worth in yuan, for a first run offline. */
export const FALLBACK_CNY_PER_USD = 7.2;
/** How long a fetched rate is used before another is asked for. */
export const FX_TTL_MS = 12 * 60 * 60_000;
/** A failed fetch is not retried for this long: offline shows the stale rate at once. */
const RETRY_MS = 10 * 60_000;
const TIMEOUT_MS = 8_000;

interface RateSnapshot {
  cnyPerUsd: number;
  at: number;
}

export interface DisplayPreferences {
  currency: DisplayCurrency;
  numberUnits: NumberUnits;
}

let rateUrl = RATE_URL;
let cached: RateSnapshot | null = null;
let failedAt = 0;
let inflight: Promise<void> | null = null;
let preferences: DisplayPreferences = { currency: "usd", numberUnits: "compact" };

/** Points the rate at a fake server; the returned function puts it back. */
export function setFxRateUrl(url: string): () => void {
  const previous = rateUrl;
  rateUrl = url;
  return () => {
    rateUrl = previous;
  };
}

/** Forgets the rate, the failure and the inflight fetch; tests use it between cases. */
export function resetFxForTests(): void {
  cached = null;
  failedAt = 0;
  inflight = null;
  preferences = { currency: "usd", numberUnits: "compact" };
}

export function setDisplayPreferences(next: DisplayPreferences): void {
  preferences = next;
}

export function getDisplayPreferences(): DisplayPreferences {
  return preferences;
}

/** What one dollar is worth in yuan right now: the last rate, or the fallback. */
export function cnyPerUsd(): number {
  return cached?.cnyPerUsd ?? FALLBACK_CNY_PER_USD;
}

export function fxRateIsStale(now = Date.now()): boolean {
  return cached === null || now - cached.at >= FX_TTL_MS;
}

function parseCnyRate(reply: unknown): number | null {
  if (typeof reply !== "object" || reply === null) {
    return null;
  }
  const rates = (reply as { rates?: unknown }).rates;
  if (typeof rates !== "object" || rates === null) {
    return null;
  }
  const cny = (rates as Record<string, unknown>).CNY;
  return typeof cny === "number" && Number.isFinite(cny) && cny > 0 ? cny : null;
}

/**
 * Fetches a fresh rate when the one held is stale, unless a fetch failed
 * recently. Never throws and never waits longer than the endpoint does:
 * the caller shows the rate at hand meanwhile.
 */
export function refreshFxRate(now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!fxRateIsStale(now) || (failedAt > 0 && now - failedAt < RETRY_MS)) {
    return Promise.resolve();
  }
  if (inflight !== null) {
    return inflight;
  }
  inflight = (async () => {
    try {
      const response = await fetchImpl(rateUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) {
        throw new Error(`fx ${response.status}`);
      }
      const rate = parseCnyRate(await response.json());
      if (rate === null) {
        throw new Error("fx reply has no CNY rate");
      }
      cached = { cnyPerUsd: rate, at: now };
      failedAt = 0;
    } catch {
      failedAt = now;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** A cost in the display currency, in the reader's own number form. */
export function formatCost(valueUsd: number, locale: string | undefined): string {
  const { currency } = preferences;
  if (currency === "cny") {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "CNY",
      maximumFractionDigits: 2,
    }).format(valueUsd * cnyPerUsd());
  }
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(valueUsd);
}

/** A large count as K/M/B, or as 万/亿 when Chinese units are preferred. */
export function formatCount(value: number, locale: string | undefined): string {
  if (preferences.numberUnits === "wan") {
    return formatWan(value);
  }
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}
