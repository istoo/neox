import { describe, expect, it } from "vitest";
import type { GatewayConfig, GatewayProvider } from "./config.js";
import { costUsd, priceWithRate, rateAt, resolvePrice, usageCost } from "./pricing.js";
import { parseModelsDev, type PricedModel, type PricingCatalog } from "./pricing-catalog.js";

function config(
  pricing: GatewayConfig["pricing"],
  providers: GatewayProvider[] = [],
  modelSameAs: GatewayConfig["modelSameAs"] = {},
): GatewayConfig {
  return { version: 1, enabled: true, keys: [], pricing, modelSameAs, providers, groups: [] };
}

function catalogOf(price: PricedModel | null): PricingCatalog {
  return {
    listPrice: () => price,
    makerPrice: () => price,
    priceFor: () => price,
  } as unknown as PricingCatalog;
}

function catalogWith(input: {
  list?: PricedModel | null;
  makers?: Record<string, PricedModel>;
}): PricingCatalog {
  return {
    listPrice: () => input.list ?? null,
    makerPrice: (modelId: string) => input.makers?.[modelId] ?? null,
    priceFor: () => input.list ?? null,
  } as unknown as PricingCatalog;
}

function provider(overrides: Partial<GatewayProvider> = {}): GatewayProvider {
  return {
    id: "p",
    protocol: "anthropic",
    baseUrl: "https://example.test/v1",
    accounts: [],
    models: [],
    maxAccounts: undefined,
    queueWaitMs: 0,
    sink: false,
    priceRate: 1,
    rateWindows: undefined,
    ...overrides,
  };
}

describe("parseModelsDev", () => {
  it("maps provider list prices and the maker's price of a model id", () => {
    const { prices, makers } = parseModelsDev({
      providers: {
        anthropic: { models: { "claude-x": { cost: { input: 3, output: 15 } } } },
        relay: {
          models: {
            "claude-x": {
              cost: { input: 4, output: 20 },
              canonical_model_id: "anthropic/claude-x",
            },
          },
        },
      },
    });
    expect(prices.get("anthropic/claude-x")).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
    expect(prices.get("relay/claude-x")).toEqual({ inputPerMTok: 4, outputPerMTok: 20 });
    // The maker's list price, not the relay's.
    expect(makers.get("claude-x")).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
  });

  it("reads the flat provider map the API answers with now", () => {
    const { prices } = parseModelsDev({
      anthropic: { models: { "claude-x": { cost: { input: 3, output: 15 } } } },
    });
    expect(prices.get("anthropic/claude-x")).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
  });

  it("keeps the cache prices models.dev lists, 1-hour writes included", () => {
    const { prices } = parseModelsDev({
      anthropic: {
        models: {
          "claude-x": {
            cost: {
              input: 3,
              output: 15,
              cache_read: 0.3,
              cache_write: 3.75,
              cache_write_1h: 6,
            },
          },
        },
      },
    });
    expect(prices.get("anthropic/claude-x")).toEqual({
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
      cacheWrite1hPerMTok: 6,
    });
  });

  it("keeps models.dev's context tiers, a part it leaves out being the base price's", () => {
    const { prices } = parseModelsDev({
      p: {
        models: {
          m: {
            cost: {
              input: 2,
              output: 6,
              cache_read: 0.4,
              tiers: [
                { input: 4, output: 9, tier: { type: "context", size: 200_000 } },
                { input: 5, tier: { type: "context", size: 400_000 } },
                { input: 9, tier: { type: "batch", size: 1_000 } },
              ],
            },
          },
        },
      },
    });
    expect(prices.get("p/m")?.tiers).toEqual([
      {
        aboveTokens: 200_000,
        inputPerMTok: 4,
        outputPerMTok: 9,
        cacheReadPerMTok: 0.4,
      },
      {
        aboveTokens: 400_000,
        inputPerMTok: 5,
        outputPerMTok: 6,
        cacheReadPerMTok: 0.4,
      },
    ]);
  });
});

describe("resolvePrice", () => {
  it("prefers a manual price over the catalog", () => {
    const price = resolvePrice(
      config({ "p/m": { inputPerMTok: 1, outputPerMTok: 2 } }),
      "p",
      "m",
      catalogOf({ inputPerMTok: 9, outputPerMTok: 9 }),
    );
    expect(price).toEqual({ inputPerMTok: 1, outputPerMTok: 2 });
  });

  it("reads the user's provider-wide and any-provider keys", () => {
    expect(
      resolvePrice(config({ "p/*": { inputPerMTok: 1, outputPerMTok: 1 } }), "p", "m"),
    ).toEqual({ inputPerMTok: 1, outputPerMTok: 1 });
    expect(
      resolvePrice(config({ "*/m": { inputPerMTok: 2, outputPerMTok: 2 } }), "p", "m"),
    ).toEqual({ inputPerMTok: 2, outputPerMTok: 2 });
  });
});

describe("rateAt", () => {
  const windows = [
    { start: "09:00", end: "18:00", rate: 2 },
    { start: "22:00", end: "06:00", rate: 3, days: [1] },
  ];

  it("picks the first window that holds the local time", () => {
    expect(rateAt(windows, new Date(2026, 0, 5, 10, 0).getTime())).toBe(2);
    expect(rateAt(windows, new Date(2026, 0, 5, 20, 0).getTime())).toBeNull();
  });

  it("crosses midnight and belongs to the day it starts on", () => {
    // Monday 23:00 is the Monday window's.
    expect(rateAt(windows, new Date(2026, 0, 5, 23, 0).getTime())).toBe(3);
    // Tuesday 02:00 is still Monday's window, and Tuesday has none.
    expect(rateAt(windows, new Date(2026, 0, 6, 2, 0).getTime())).toBe(3);
    expect(rateAt(windows, new Date(2026, 0, 7, 2, 0).getTime())).toBeNull();
  });
});

describe("priceWithRate", () => {
  it("multiplies by the provider rate", () => {
    const price = priceWithRate(
      { inputPerMTok: 1, outputPerMTok: 2 },
      provider({ priceRate: 2 }),
      0,
    );
    expect(price).toEqual({ inputPerMTok: 2, outputPerMTok: 4 });
  });

  it("reads a legacy peak window as a rate window", () => {
    const inside = new Date(2026, 0, 1, 3, 0, 0);
    const outside = new Date(2026, 0, 1, 12, 0, 0);
    const p = provider({ peak: { startHour: 1, endHour: 6, rate: 3 } });
    expect(priceWithRate({ inputPerMTok: 1, outputPerMTok: 1 }, p, inside.getTime())).toEqual({
      inputPerMTok: 3,
      outputPerMTok: 3,
    });
    expect(priceWithRate({ inputPerMTok: 1, outputPerMTok: 1 }, p, outside.getTime())).toEqual({
      inputPerMTok: 1,
      outputPerMTok: 1,
    });
  });

  it("scales the cache prices and tiers too", () => {
    const price = priceWithRate(
      {
        inputPerMTok: 1,
        outputPerMTok: 2,
        cacheReadPerMTok: 0.1,
        cacheWritePerMTok: 1.25,
        tiers: [{ aboveTokens: 1_000, inputPerMTok: 2, outputPerMTok: 3, cacheReadPerMTok: 0.2 }],
      },
      provider({ priceRate: 2 }),
      0,
    );
    expect(price).toEqual({
      inputPerMTok: 2,
      outputPerMTok: 4,
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: 2.5,
      tiers: [{ aboveTokens: 1_000, inputPerMTok: 4, outputPerMTok: 6, cacheReadPerMTok: 0.4 }],
    });
  });
});

describe("costUsd", () => {
  it("bills input, output, cache reads and 5-minute cache writes at their own prices", () => {
    const cost = costUsd(
      {
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.3,
        cacheWritePerMTok: 3.75,
      },
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      },
    );
    expect(cost).toBeCloseTo(22.05, 10);
  });

  it("bills the 1-hour cache writes at their own price", () => {
    const cost = costUsd(
      { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheWrite1hPerMTok: 7.5 },
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 1_000_000,
        cacheWrite1hTokens: 400_000,
      },
    );
    expect(cost).toBeCloseTo(5.25, 10);
  });

  it("does not bill a cache read twice when the vendor counts it in the prompt", () => {
    const cost = costUsd(
      { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 },
      { inputTokens: 2_000_000, outputTokens: 0, cacheReadTokens: 1_000_000 },
      { cacheInPrompt: true },
    );
    expect(cost).toBeCloseTo(3.3, 10);
  });

  it("bills the whole call at the tier its prompt reaches", () => {
    const price = {
      inputPerMTok: 1,
      outputPerMTok: 1,
      tiers: [{ aboveTokens: 1_000, inputPerMTok: 2, outputPerMTok: 3 }],
    };
    expect(costUsd(price, { inputTokens: 500, outputTokens: 100 })).toBeCloseTo(0.0006, 10);
    expect(costUsd(price, { inputTokens: 2_000, outputTokens: 100 })).toBeCloseTo(0.0043, 10);
  });
});

describe("usageCost", () => {
  it("multiplies a catalog price by the provider's rate", () => {
    const cost = usageCost({
      config: config({}, [provider({ priceRate: 2 })]),
      providerId: "p",
      modelId: "m",
      catalog: catalogOf({ inputPerMTok: 1, outputPerMTok: 0 }),
      at: 0,
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
      cacheInPrompt: false,
    });
    expect(cost).toEqual({ costUsd: 2, priced: true });
  });

  it("leaves a price the user set as set by the provider's rate", () => {
    const cost = usageCost({
      config: config({ "p/m": { inputPerMTok: 1, outputPerMTok: 0 } }, [
        provider({ priceRate: 2 }),
      ]),
      providerId: "p",
      modelId: "m",
      catalog: null,
      at: 0,
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
      cacheInPrompt: false,
    });
    expect(cost).toEqual({ costUsd: 1, priced: true });
  });

  it("applies a rate window to a price the user set", () => {
    const noon = new Date(2026, 0, 1, 12, 0, 0).getTime();
    const cost = usageCost({
      config: config({ "p/m": { inputPerMTok: 1, outputPerMTok: 0 } }, [
        provider({ rateWindows: [{ start: "09:00", end: "18:00", rate: 3 }] }),
      ]),
      providerId: "p",
      modelId: "m",
      catalog: null,
      at: noon,
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
      cacheInPrompt: false,
    });
    expect(cost).toEqual({ costUsd: 3, priced: true });
  });

  it("falls back to the maker's price and then to the model it is the same as", () => {
    const maker = { inputPerMTok: 2, outputPerMTok: 0 };
    const base = {
      config: config({}, [], { "p/m": "lab/m-real" }),
      providerId: "p",
      modelId: "m",
      at: 0,
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
      cacheInPrompt: false,
    };
    expect(usageCost({ ...base, catalog: catalogWith({ makers: { m: maker } }) })).toEqual({
      costUsd: 2,
      priced: true,
    });
    expect(
      usageCost({
        ...base,
        catalog: catalogWith({ makers: { "lab/m-real": { inputPerMTok: 4, outputPerMTok: 0 } } }),
      }),
    ).toEqual({ costUsd: 4, priced: true });
  });

  it("bills a Claude model's 1-hour writes at 2× the input a user set", () => {
    const cost = usageCost({
      config: config({ "p/claude-x": { inputPerMTok: 3, outputPerMTok: 15 } }),
      providerId: "p",
      modelId: "claude-x",
      catalog: null,
      at: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 1_000_000,
        cacheWrite1hTokens: 1_000_000,
      },
      cacheInPrompt: false,
    });
    expect(cost).toEqual({ costUsd: 6, priced: true });
  });

  it("tells a price of zero from no price at all", () => {
    const free = usageCost({
      config: config({ "p/m": { inputPerMTok: 0, outputPerMTok: 0 } }),
      providerId: "p",
      modelId: "m",
      catalog: null,
      at: 0,
      usage: { inputTokens: 10, outputTokens: 10 },
      cacheInPrompt: false,
    });
    expect(free).toEqual({ costUsd: 0, priced: true });
    expect(
      usageCost({
        config: config({}),
        providerId: "p",
        modelId: "m",
        catalog: null,
        at: 0,
        usage: { inputTokens: 1, outputTokens: 1 },
        cacheInPrompt: false,
      }),
    ).toEqual({ costUsd: 0, priced: false });
  });
});
