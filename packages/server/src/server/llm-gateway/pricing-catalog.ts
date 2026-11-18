import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { writePrivateFileAtomic } from "../private-files.js";
/**
 * A model's price as the catalog knows it: the list price plus the cache
 * prices and context tiers models.dev carries. A price `gateway.json` sets by
 * hand is a `GatewayPrice` and fits here as it is.
 */
export interface PricedModel {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
  /** Cache writes kept an hour; a price without one bills them as 5-minute writes. */
  cacheWrite1hPerMTok?: number;
  /** Whole-request prices once the prompt is over `aboveTokens`, lowest first. */
  tiers?: PricedTier[];
}

export interface PricedTier {
  aboveTokens: number;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
  cacheWrite1hPerMTok?: number;
}

const FILENAME = "gateway-pricing.json";
const MODELS_DEV_URL = "https://models.dev/api.json";
const STALE_MS = 24 * 60 * 60_000;
const REFRESH_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * 3 holds the maker prices beside the list prices, and 1-hour cache writes.
 * A version 1 cache was read from a shape models.dev no longer answers with and
 * so held no prices at all; an old cache is ignored so the next start fetches
 * again instead of serving nothing.
 */
const CACHE_VERSION = 3;

interface CachedCatalog {
  version: typeof CACHE_VERSION;
  fetchedAt: number;
  prices: Record<string, PricedModel>;
  /** Model id → its maker's list price. */
  makers: Record<string, PricedModel>;
}

/** What one fetch of models.dev did, for the `gateway.catalog.refresh` RPC. */
export interface PricingCatalogRefresh {
  ok: boolean;
  /** The list prices held after a successful refresh. */
  models?: number;
  error?: string;
}

/**
 * List prices from models.dev, cached next to the gateway config. A failed
 * refresh keeps the previous cache; without any cache, costs stay zero and
 * budgets only bind where `gateway.json` carries manual prices.
 */
export class PricingCatalog {
  public readonly filePath: string;

  private readonly logger: Logger;
  /** `provider/model` → its list price. */
  private prices = new Map<string, PricedModel>();
  /** Model id → the price its maker lists it at. */
  private makers = new Map<string, PricedModel>();
  private fetchedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  /** The fetch in flight; `dispose` aborts and awaits it so nothing writes after shutdown. */
  private inFlight: { controller: AbortController; done: Promise<PricingCatalogRefresh> } | null =
    null;
  private disposed = false;

  constructor(options: { neolixHome: string; logger: Logger }) {
    this.filePath = path.join(options.neolixHome, FILENAME);
    this.logger = options.logger;
  }

  public async start(now: number): Promise<void> {
    await this.loadCache();
    if (now - this.fetchedAt > STALE_MS) {
      void this.refresh(now);
    }
    this.timer = setInterval(() => {
      void this.refresh(Date.now());
    }, REFRESH_INTERVAL_MS);
    this.timer.unref();
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const inFlight = this.inFlight;
    if (inFlight !== null) {
      inFlight.controller.abort();
      await inFlight.done;
    }
  }

  /** The provider's own list price for the model, when models.dev lists it. */
  public listPrice(providerId: string, modelId: string): PricedModel | null {
    return this.prices.get(`${providerId}/${modelId}`) ?? null;
  }

  /**
   * The model's maker's list price, whatever provider a reseller serves it
   * through — models.dev's canonical id names the maker. A prefixed id
   * ("moonshotai/kimi-k3") reads as the bare one, as myna reads it.
   */
  public makerPrice(modelId: string): PricedModel | null {
    return this.makers.get(modelId) ?? this.makers.get(bareModelId(modelId)) ?? null;
  }

  /** The provider's list price first, then its maker's. */
  public priceFor(providerId: string, modelId: string): PricedModel | null {
    return this.listPrice(providerId, modelId) ?? this.makerPrice(modelId);
  }

  public async refresh(now: number): Promise<PricingCatalogRefresh> {
    if (this.disposed) {
      return { ok: false, error: "The price catalog is shut down" };
    }
    // One fetch at a time: a refresh asked for while one runs shares its result.
    if (this.inFlight !== null) {
      return this.inFlight.done;
    }
    const controller = new AbortController();
    const done = this.fetchAndStore(now, controller.signal).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = { controller, done };
    return done;
  }

  private async fetchAndStore(now: number, signal: AbortSignal): Promise<PricingCatalogRefresh> {
    try {
      const response = await fetch(MODELS_DEV_URL, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) {
        return { ok: false, error: `models.dev answered ${response.status}` };
      }
      const payload: unknown = await response.json();
      if (signal.aborted) {
        return { ok: false, error: "The price catalog is shut down" };
      }
      const parsed = parseModelsDev(payload);
      this.prices = parsed.prices;
      this.makers = parsed.makers;
      this.fetchedAt = now;
      const cache: CachedCatalog = {
        version: CACHE_VERSION,
        fetchedAt: now,
        prices: Object.fromEntries(this.prices),
        makers: Object.fromEntries(this.makers),
      };
      await writePrivateFileAtomic(this.filePath, `${JSON.stringify(cache)}\n`);
      return { ok: true, models: this.prices.size };
    } catch (error) {
      this.logger.warn({ err: error }, "Cannot refresh the model price catalog");
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async loadCache(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(parsed) || parsed.version !== CACHE_VERSION || !isRecord(parsed.prices)) {
      return;
    }
    if (!isRecord(parsed.makers)) {
      return;
    }
    this.fetchedAt = typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : 0;
    this.prices = parsePrices(parsed.prices);
    this.makers = parsePrices(parsed.makers);
  }
}

/**
 * models.dev: a provider map keyed by id, each with its models and their
 * `cost` (`input`, `output`, `cache_read`, `cache_write`, `cache_write_1h`,
 * and the context `tiers`). Older replies nested the map under `providers`,
 * which is read too. Costs are US dollars per million tokens.
 */
export function parseModelsDev(payload: unknown): ParsedCatalog {
  const prices = new Map<string, PricedModel>();
  const entries: ParsedEntry[] = [];
  if (!isRecord(payload)) {
    return { prices, makers: new Map() };
  }
  const providers = isRecord(payload.providers) ? payload.providers : payload;
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!isRecord(provider) || !isRecord(provider.models)) {
      continue;
    }
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!isRecord(model) || !isRecord(model.cost)) {
        continue;
      }
      const input = model.cost.input;
      const output = model.cost.output;
      if (typeof input !== "number" || typeof output !== "number") {
        continue;
      }
      const price = priceOfCost(model.cost, input, output);
      prices.set(`${providerId}/${modelId}`, price);
      entries.push({
        modelId,
        price,
        canonical: typeof model.canonical_model_id === "string" ? model.canonical_model_id : null,
      });
    }
  }
  return { prices, makers: makerPricesOf(entries, prices) };
}

export interface ParsedCatalog {
  /** `provider/model` → its list price. */
  prices: Map<string, PricedModel>;
  /** Model id → the price its maker lists it at. */
  makers: Map<string, PricedModel>;
}

interface ParsedEntry {
  modelId: string;
  price: PricedModel;
  /** models.dev's `owner/model` id, which names the maker. */
  canonical: string | null;
}

/**
 * A model's maker's price: the price under the provider its canonical id
 * names, else the first listing of that id, which is what models.dev has
 * when it names no maker.
 */
function makerPricesOf(
  entries: readonly ParsedEntry[],
  prices: ReadonlyMap<string, PricedModel>,
): Map<string, PricedModel> {
  const makers = new Map<string, PricedModel>();
  for (const entry of entries) {
    if (entry.canonical === null || makers.has(entry.modelId)) {
      continue;
    }
    const target = prices.get(entry.canonical);
    if (target !== undefined) {
      makers.set(entry.modelId, target);
    }
  }
  for (const entry of entries) {
    if (!makers.has(entry.modelId)) {
      makers.set(entry.modelId, entry.price);
    }
  }
  return makers;
}

/** A model id without the vendor prefix a reseller spells it with. */
function bareModelId(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  return slash >= 0 ? modelId.slice(slash + 1) : modelId;
}

function parsePrices(values: Record<string, unknown>): Map<string, PricedModel> {
  const prices = new Map<string, PricedModel>();
  for (const [key, value] of Object.entries(values)) {
    const price = parsePrice(value);
    if (price !== null) {
      prices.set(key, price);
    }
  }
  return prices;
}

/** A model's cost from models.dev: the flat price, its cache prices and its tiers. */
function priceOfCost(cost: Record<string, unknown>, input: number, output: number): PricedModel {
  const price: PricedModel = { inputPerMTok: input, outputPerMTok: output };
  const cacheRead = numberOr(cost.cache_read, null);
  const cacheWrite = numberOr(cost.cache_write, null);
  const cacheWrite1h = numberOr(cost.cache_write_1h, null);
  if (cacheRead !== null) {
    price.cacheReadPerMTok = cacheRead;
  }
  if (cacheWrite !== null) {
    price.cacheWritePerMTok = cacheWrite;
  }
  if (cacheWrite1h !== null) {
    price.cacheWrite1hPerMTok = cacheWrite1h;
  }
  const tiers = tiersOfCost(cost.tiers, price);
  if (tiers.length > 0) {
    price.tiers = tiers;
  }
  return price;
}

/**
 * models.dev's context tiers, lowest first. A part a tier leaves out is the
 * base price's, as models.dev means it; a tier of another kind is skipped.
 */
function tiersOfCost(raw: unknown, base: PricedModel): PricedTier[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const tiers: PricedTier[] = [];
  for (const item of raw) {
    if (!isRecord(item) || !isRecord(item.tier) || item.tier.type !== "context") {
      continue;
    }
    const above = numberOr(item.tier.size, null);
    if (above === null || above <= 0) {
      continue;
    }
    const tier: PricedTier = {
      aboveTokens: above,
      inputPerMTok: numberOr(item.input, base.inputPerMTok) ?? base.inputPerMTok,
      outputPerMTok: numberOr(item.output, base.outputPerMTok) ?? base.outputPerMTok,
    };
    const cacheRead = numberOr(item.cache_read, base.cacheReadPerMTok ?? 0);
    const cacheWrite = numberOr(item.cache_write, base.cacheWritePerMTok ?? 0);
    const cacheWrite1h = numberOr(
      item.cache_write_1h,
      base.cacheWrite1hPerMTok ?? base.cacheWritePerMTok ?? 0,
    );
    if (cacheRead !== null && cacheRead > 0) {
      tier.cacheReadPerMTok = cacheRead;
    }
    if (cacheWrite !== null && cacheWrite > 0) {
      tier.cacheWritePerMTok = cacheWrite;
    }
    if (cacheWrite1h !== null && cacheWrite1h > 0) {
      tier.cacheWrite1hPerMTok = cacheWrite1h;
    }
    tiers.push(tier);
  }
  return tiers.sort((left, right) => left.aboveTokens - right.aboveTokens);
}

function parsePrice(value: unknown): PricedModel | null {
  if (!isRecord(value)) {
    return null;
  }
  const input = value.inputPerMTok;
  const output = value.outputPerMTok;
  if (typeof input !== "number" || typeof output !== "number") {
    return null;
  }
  return priceOfCost(value, input, output);
}

/** A finite number, or the fallback when the value is anything else. */
function numberOr(value: unknown, fallback: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
