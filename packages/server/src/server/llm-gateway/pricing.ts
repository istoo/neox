import {
  rateWindowsOf,
  type GatewayConfig,
  type GatewayProvider,
  type GatewayRateWindow,
} from "./config.js";
import type { IrUsage } from "./ir.js";
import { peakAt, peakOf, PEAK_FACTOR, type PeakKind } from "./peak.js";
import type { PricedModel, PricedTier, PricingCatalog } from "./pricing-catalog.js";

/**
 * Prices are per million tokens. The user's own price wins, looked up the way
 * myna looks it up: the provider's model, then a provider-wide key, then a
 * model key for every provider (and a bare model id, which older gateway.json
 * files use for the same thing).
 */
export function configuredPrice(
  config: GatewayConfig,
  providerId: string,
  modelId: string,
): PricedModel | undefined {
  return (
    config.pricing[`${providerId}/${modelId}`] ??
    config.pricing[`${providerId}/*`] ??
    config.pricing[modelId] ??
    config.pricing[`*/${modelId}`]
  );
}

/** The price the user set, or the provider's or maker's list price. */
export function resolvePrice(
  config: GatewayConfig,
  providerId: string,
  modelId: string,
  catalog: PricingCatalog | null = null,
): PricedModel | null {
  return (
    configuredPrice(config, providerId, modelId) ??
    catalog?.listPrice(providerId, modelId) ??
    catalog?.makerPrice(modelId) ??
    null
  );
}

/**
 * `priceRate`, then the time-of-day window the call falls in. The provider's
 * price rate applies to its own list price, not to one the user set by hand,
 * which is what `includePriceRate: false` says; a rate window scales either,
 * as myna's RateWindows do.
 */
export function priceWithRate(
  price: PricedModel | null,
  provider: GatewayProvider | undefined,
  now: number,
  options: { includePriceRate?: boolean } = {},
): PricedModel | null {
  if (price === null || provider === undefined) {
    return price;
  }
  let rate = options.includePriceRate === false ? 1 : (provider.priceRate ?? 1);
  const windowRate = rateAt(rateWindowsOf(provider), now);
  if (windowRate !== null) {
    rate *= windowRate;
  }
  if (rate === 1) {
    return price;
  }
  return scalePrice(price, rate);
}

/**
 * The rate a provider's windows bill at at `at`, on the host's clock: the
 * first window that holds the time wins, null outside every window. A window
 * whose start is after its end crosses midnight and belongs to the day it
 * starts on, so its early hours read as that day's.
 */
export function rateAt(
  windows: readonly GatewayRateWindow[] | undefined,
  at: number,
): number | null {
  if (windows === undefined || windows.length === 0) {
    return null;
  }
  const date = new Date(at);
  const minutes = date.getHours() * 60 + date.getMinutes();
  const day = date.getDay();
  for (const window of windows) {
    const start = parseClock(window.start);
    const end = parseClock(window.end);
    if (start === null || end === null || start === 1440 || start === end) {
      continue;
    }
    let inside: boolean;
    let ownDay = day;
    if (start < end) {
      inside = minutes >= start && minutes < end;
    } else {
      inside = minutes >= start || minutes < end;
      if (minutes < end) {
        ownDay = (day + 6) % 7;
      }
    }
    if (!inside) {
      continue;
    }
    if (window.days !== undefined && window.days.length > 0 && !window.days.includes(ownDay)) {
      continue;
    }
    return window.rate;
  }
  return null;
}

/** "HH:MM" as minutes into the day, 1440 for 24:00; null for anything else. */
function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 24 || minute > 59) {
    return null;
  }
  const minutes = hour * 60 + minute;
  return minutes > 1440 ? null : minutes;
}

/**
 * What a call costs at this price, myna's way: input, output, cache reads,
 * and cache writes split into 5-minute and 1-hour ones, each at its own rate,
 * the whole call at the highest context tier its prompt reaches.
 * `cacheInPrompt` says the vendor counts cache reads inside `inputTokens` (the
 * OpenAI and Gemini shapes), so they are billed apart rather than twice.
 */
export function costUsd(
  price: PricedModel | null,
  usage: IrUsage | null,
  options: { cacheInPrompt?: boolean } = {},
): number {
  if (price === null || usage === null) {
    return 0;
  }
  const cacheRead = Math.max(0, usage.cacheReadTokens ?? 0);
  const cacheWrite = Math.max(0, usage.cacheWriteTokens ?? 0);
  const cacheWrite1h = Math.min(Math.max(0, usage.cacheWrite1hTokens ?? 0), cacheWrite);
  const input = Math.max(
    0,
    options.cacheInPrompt === true ? usage.inputTokens - cacheRead : usage.inputTokens,
  );
  const flat = flatPrice(price, input + cacheRead + cacheWrite);
  const oneHour = flat.cacheWrite1hPerMTok ?? flat.cacheWritePerMTok ?? 0;
  return (
    (input * flat.inputPerMTok +
      Math.max(0, usage.outputTokens) * flat.outputPerMTok +
      cacheRead * (flat.cacheReadPerMTok ?? 0) +
      (cacheWrite - cacheWrite1h) * (flat.cacheWritePerMTok ?? 0) +
      cacheWrite1h * oneHour) /
    1_000_000
  );
}

export interface UsagePriceInput {
  config: GatewayConfig;
  providerId: string;
  modelId: string;
  catalog: PricingCatalog | null;
  /** The call's time, for the provider's rate windows. */
  at: number;
}

/**
 * A call's price: the price the user set for it, else the provider's list
 * price, else its maker's, else the maker's price of the model the user said
 * it is the same as (`modelSameAs`), each at the provider's rate and the
 * window the call falls in. Null when no price is known at all, which is not
 * the same as a price of zero. A caller pricing many calls holds one of these
 * per model and hour rather than resolving it per call.
 */
export function usagePrice(input: UsagePriceInput): PricedModel | null {
  const configured = configuredPrice(input.config, input.providerId, input.modelId);
  const provider = input.config.providers.find((candidate) => candidate.id === input.providerId);
  let price: PricedModel | null = null;
  let peak: PeakKind | null = null;
  if (configured !== undefined) {
    // A vendor that bills by the hour doubles any price in its peak hours:
    // the user's is the off-peak one, as its list price is.
    price = oneHourForUserPrice(configured, input.modelId);
    peak = peakFor(provider, input.providerId, input.modelId);
  } else {
    const catalogPrice =
      input.catalog?.listPrice(input.providerId, input.modelId) ??
      input.catalog?.makerPrice(input.modelId) ??
      null;
    if (catalogPrice !== null) {
      price = catalogPrice;
      peak = peakFor(provider, input.providerId, input.modelId);
    } else {
      // The price of the model the user said this one is the same as keeps
      // that model's hours, never this vendor's (myna).
      price = samePrice(input);
    }
  }
  if (price === null) {
    return null;
  }
  const rated = priceWithRate(price, provider, input.at, {
    includePriceRate: configured === undefined,
  });
  return priceAtPeak(rated, peak, input.at);
}

/**
 * A provider gone since the call is told by its id, as myna tells one: its
 * URLs are gone with it, and only the vendor's own id remains.
 */
function peakFor(
  provider: GatewayProvider | undefined,
  providerId: string,
  modelId: string,
): PeakKind | null {
  return peakOf(provider ?? { id: providerId, baseUrl: "" }, modelId);
}

/**
 * A price at the hours it is billed in: PEAK_FACTOR times it in the peak
 * hours of a vendor that bills by the hour, else the price it was.
 */
export function priceAtPeak(
  price: PricedModel | null,
  peak: PeakKind | null,
  at: number,
): PricedModel | null {
  if (price === null || peak === null || !peakAt(peak, at)) {
    return price;
  }
  return scalePrice(price, PEAK_FACTOR);
}

/** The maker's price of the model the user said this one is the same as. */
function samePrice(input: UsagePriceInput): PricedModel | null {
  const same = input.config.modelSameAs[`${input.providerId}/${input.modelId}`]?.trim();
  if (same === undefined || same.length === 0) {
    return null;
  }
  return input.catalog?.makerPrice(same) ?? null;
}

/**
 * myna's OneHourFor: a price the user set for a Claude model leaves its
 * 1-hour cache writes out, and Anthropic bills them at 2× input. A catalog
 * price without one is billed as a 5-minute write instead.
 */
function oneHourForUserPrice(price: PricedModel, modelId: string): PricedModel {
  if (price.cacheWrite1hPerMTok !== undefined || !/claude/i.test(modelId)) {
    return price;
  }
  return { ...price, cacheWrite1hPerMTok: price.inputPerMTok * 2 };
}

export interface UsageCostInput extends UsagePriceInput {
  usage: IrUsage;
  /** Whether the vendor counts cache reads inside `inputTokens`. */
  cacheInPrompt: boolean;
}

export interface UsageCost {
  costUsd: number;
  /** False when no price is known at all; a price of zero is priced. */
  priced: boolean;
}

/** One call's cost at its effective price (see `usagePrice`). */
export function usageCost(input: UsageCostInput): UsageCost {
  const price = usagePrice(input);
  if (price === null) {
    return { costUsd: 0, priced: false };
  }
  return {
    costUsd: costUsd(price, input.usage, { cacheInPrompt: input.cacheInPrompt }),
    priced: true,
  };
}

export function totalTokens(usage: IrUsage | null): number {
  return usage === null ? 0 : usage.inputTokens + usage.outputTokens;
}

/** The flat prices a prompt's size bills at: the highest tier it is over. */
function flatPrice(price: PricedModel, promptTokens: number): PricedModel {
  let flat: PricedModel = price;
  for (const tier of price.tiers ?? []) {
    if (promptTokens > tier.aboveTokens) {
      const cacheRead = tier.cacheReadPerMTok ?? price.cacheReadPerMTok;
      const cacheWrite = tier.cacheWritePerMTok ?? price.cacheWritePerMTok;
      const cacheWrite1h = tier.cacheWrite1hPerMTok ?? price.cacheWrite1hPerMTok;
      flat = {
        inputPerMTok: tier.inputPerMTok,
        outputPerMTok: tier.outputPerMTok,
        ...(cacheRead === undefined ? {} : { cacheReadPerMTok: cacheRead }),
        ...(cacheWrite === undefined ? {} : { cacheWritePerMTok: cacheWrite }),
        ...(cacheWrite1h === undefined ? {} : { cacheWrite1hPerMTok: cacheWrite1h }),
      };
    }
  }
  return flat;
}

function scalePrice(price: PricedModel, rate: number): PricedModel {
  return {
    inputPerMTok: price.inputPerMTok * rate,
    outputPerMTok: price.outputPerMTok * rate,
    ...(price.cacheReadPerMTok === undefined
      ? {}
      : { cacheReadPerMTok: price.cacheReadPerMTok * rate }),
    ...(price.cacheWritePerMTok === undefined
      ? {}
      : { cacheWritePerMTok: price.cacheWritePerMTok * rate }),
    ...(price.cacheWrite1hPerMTok === undefined
      ? {}
      : { cacheWrite1hPerMTok: price.cacheWrite1hPerMTok * rate }),
    ...(price.tiers === undefined
      ? {}
      : { tiers: price.tiers.map((tier) => scaleTier(tier, rate)) }),
  };
}

function scaleTier(tier: PricedTier, rate: number): PricedTier {
  return {
    aboveTokens: tier.aboveTokens,
    inputPerMTok: tier.inputPerMTok * rate,
    outputPerMTok: tier.outputPerMTok * rate,
    ...(tier.cacheReadPerMTok === undefined
      ? {}
      : { cacheReadPerMTok: tier.cacheReadPerMTok * rate }),
    ...(tier.cacheWritePerMTok === undefined
      ? {}
      : { cacheWritePerMTok: tier.cacheWritePerMTok * rate }),
    ...(tier.cacheWrite1hPerMTok === undefined
      ? {}
      : { cacheWrite1hPerMTok: tier.cacheWrite1hPerMTok * rate }),
  };
}
