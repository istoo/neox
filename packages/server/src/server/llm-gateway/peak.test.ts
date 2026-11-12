import { describe, expect, it } from "vitest";
import type { GatewayConfig, GatewayProvider } from "./config.js";
import { chinaHoliday, peakAt, peakOf } from "./peak.js";
import { usagePrice } from "./pricing.js";
import type { PricedModel, PricingCatalog } from "./pricing-catalog.js";

interface Price {
  input: number;
  output: number;
  cacheRead?: number;
}

function provider(overrides: Partial<GatewayProvider> = {}): GatewayProvider {
  return {
    id: "p",
    protocol: "openai",
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

function config(
  providers: GatewayProvider[],
  pricing: GatewayConfig["pricing"] = {},
  modelSameAs: GatewayConfig["modelSameAs"] = {},
): GatewayConfig {
  return { version: 1, enabled: true, keys: [], pricing, modelSameAs, providers, groups: [] };
}

function catalogWith(input: {
  list?: Record<string, Price>;
  makers?: Record<string, Price>;
}): PricingCatalog {
  const price = (value: Price | undefined): PricedModel | null =>
    value === undefined
      ? null
      : {
          inputPerMTok: value.input,
          outputPerMTok: value.output,
          ...(value.cacheRead === undefined ? {} : { cacheReadPerMTok: value.cacheRead }),
        };
  return {
    listPrice: (providerId: string, modelId: string) =>
      price(input.list?.[`${providerId}/${modelId}`]),
    makerPrice: (modelId: string) => price(input.makers?.[modelId]),
    priceFor: () => null,
  } as unknown as PricingCatalog;
}

/** An instant from a UTC day and "HH:MM". */
function at(day: string, time: string): number {
  return Date.parse(`${day}T${time}:00Z`);
}

const PEAK_TIME = at("2026-10-29", "02:00"); // a Thursday
const OFF_TIME = at("2026-10-29", "11:00");

describe("peak hours", () => {
  it("bills DeepSeek's own on weekdays outside China's public holidays", () => {
    const edges: Record<string, boolean> = {
      "00:59": false,
      "01:00": true,
      "03:59": true,
      "04:00": false,
      "05:59": false,
      "06:00": true,
      "09:59": true,
      "10:00": false,
      "00:00": false,
      "23:59": false,
      "12:00": false,
    };
    for (const c of [
      { day: "2026-10-29", deepseek: true, weekdays: true }, // a Thursday
      { day: "2026-10-26", deepseek: true, weekdays: true }, // a Monday
      { day: "2026-10-30", deepseek: true, weekdays: true }, // a Friday
      { day: "2026-10-31", deepseek: false, weekdays: false }, // a Saturday
      { day: "2026-11-01", deepseek: false, weekdays: false }, // a Sunday
      { day: "2026-10-05", deepseek: false, weekdays: true }, // National Day break
      { day: "2026-02-16", deepseek: false, weekdays: true }, // Spring Festival break
      { day: "2026-10-09", deepseek: true, weekdays: true }, // a Friday after the break
    ]) {
      for (const [hm, peak] of Object.entries(edges)) {
        const when = at(c.day, hm);
        expect(peakAt("deepseek", when), `deepseek ${c.day} ${hm}`).toBe(peak && c.deepseek);
        expect(peakAt("weekdays", when), `weekdays ${c.day} ${hm}`).toBe(peak && c.weekdays);
      }
    }
    // the same instant written in Shanghai's time is the same instant
    expect(peakAt("deepseek", Date.parse("2026-10-29T10:00:00+08:00"))).toBe(true);
    expect(peakAt(null, PEAK_TIME)).toBe(false);
    expect(peakAt("deepseek", Number.NaN)).toBe(false);
  });

  it("bills Ollama Cloud's 12:00 to 18:00 UTC on weekdays, holidays too", () => {
    const edges: Record<string, boolean> = {
      "11:59": false,
      "12:00": true,
      "17:59": true,
      "18:00": false,
      "00:00": false,
      "02:00": false,
      "23:59": false,
      "15:30": true,
    };
    for (const c of [
      { day: "2026-10-28", weekday: true },
      { day: "2026-10-26", weekday: true },
      { day: "2026-10-30", weekday: true },
      { day: "2026-10-05", weekday: true }, // National Day: Ollama names no holiday
      { day: "2026-10-31", weekday: false },
      { day: "2026-11-01", weekday: false },
    ]) {
      for (const [hm, peak] of Object.entries(edges)) {
        expect(peakAt("ollama", at(c.day, hm)), `${c.day} ${hm}`).toBe(peak && c.weekday);
      }
    }
    expect(peakAt("deepseek", at("2026-10-28", "15:30"))).toBe(false);
    expect(peakAt("deepseek", at("2026-10-28", "02:00"))).toBe(true);
  });

  it("knows China's public holidays", () => {
    expect(chinaHoliday(at("2026-10-01", "02:00"))).toBe(true);
    expect(chinaHoliday(at("2026-10-05", "02:00"))).toBe(true);
    expect(chinaHoliday(at("2026-10-09", "02:00"))).toBe(false);
    // Add the State Council's notice for the year this fails in.
    const year = new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCFullYear();
    expect(chinaHoliday(Date.UTC(year, 0, 1, 2)), `China's holidays for ${year}`).toBe(true);
  });
});

describe("peakOf", () => {
  const cases: Array<{
    name: string;
    p: GatewayProvider;
    model: string;
    want: "deepseek" | "weekdays" | "ollama" | null;
  }> = [
    {
      name: "deepseek",
      p: provider({ id: "deepseek", baseUrl: "https://api.deepseek.com" }),
      model: "deepseek-flash",
      want: "deepseek",
    },
    {
      name: "deepseek pro",
      p: provider({ id: "deepseek", baseUrl: "https://api.deepseek.com/v1" }),
      model: "deepseek-v4-pro",
      want: "deepseek",
    },
    {
      name: "commandcode",
      p: provider({ id: "cc", baseUrl: "https://api.commandcode.ai/provider/v1" }),
      model: "deepseek/deepseek-v4.1-flash",
      want: "weekdays",
    },
    {
      name: "commandcode pro",
      p: provider({ id: "cc", baseUrl: "https://api.commandcode.ai/provider/v1" }),
      model: "deepseek/deepseek-v4-pro",
      want: "weekdays",
    },
    {
      name: "commandcode flash-fast",
      p: provider({ id: "cc", baseUrl: "https://api.commandcode.ai/provider/v1" }),
      model: "deepseek/deepseek-v4-flash-fast",
      want: null,
    },
    {
      name: "commandcode other",
      p: provider({ id: "cc", baseUrl: "https://api.commandcode.ai/provider/v1" }),
      model: "moonshotai/kimi-k3",
      want: null,
    },
    {
      name: "commandcode plan",
      p: provider({ id: "commandcode-plan", baseUrl: "" }),
      model: "deepseek/deepseek-v4.1-flash",
      want: "weekdays",
    },
    {
      name: "commandcode plan's plugin",
      p: provider({
        id: "commandcode-plan",
        baseUrl: "plugin://commandcode-plan/v1",
      }),
      model: "deepseek/deepseek-v4.1-flash",
      want: "weekdays",
    },
    {
      name: "commandcode plan's plugin flash-fast",
      p: provider({
        id: "commandcode-plan",
        baseUrl: "plugin://commandcode-plan/v1",
      }),
      model: "deepseek/deepseek-v4-flash-fast",
      want: null,
    },
    {
      name: "another plugin",
      p: provider({ id: "zen-free", baseUrl: "plugin://zen-free/v1" }),
      model: "deepseek-v4.1-flash",
      want: null,
    },
    {
      // 文档里的插件占位是 https://plugin.invalid，不是 plugin://。
      name: "commandcode plan's plugin at a placeholder host",
      p: provider({
        id: "commandcode-plan",
        baseUrl: "https://plugin.invalid",
        plugin: { pluginId: "commandcode-auth", providerId: "commandcode-plan" },
      }),
      model: "deepseek/deepseek-v4.1-flash",
      want: "weekdays",
    },
    {
      name: "another plugin at a placeholder host",
      p: provider({
        id: "zen-free",
        baseUrl: "https://plugin.invalid",
        plugin: { pluginId: "zen-free", providerId: "zen-free" },
      }),
      model: "deepseek-v4.1-flash",
      want: null,
    },
    {
      // 非插件 provider 的假地址依旧不能借 id 冒领峰谷价。
      name: "relay at a placeholder host named deepseek",
      p: provider({ id: "deepseek", baseUrl: "https://plugin.invalid" }),
      model: "deepseek-v4-flash",
      want: null,
    },
    {
      name: "opencode go",
      p: provider({ id: "oc", baseUrl: "https://opencode.ai/zen/go/v1" }),
      model: "deepseek-v4.1-flash",
      want: "weekdays",
    },
    {
      name: "opencode go at the inference API",
      p: provider({ id: "oc", baseUrl: "https://opencode.ai/inference/go/v1" }),
      model: "deepseek-v4-pro",
      want: "weekdays",
    },
    {
      name: "opencode go other",
      p: provider({ id: "oc", baseUrl: "https://opencode.ai/zen/go/v1" }),
      model: "kimi-k3",
      want: null,
    },
    {
      name: "opencode zen",
      p: provider({ id: "oc", baseUrl: "https://opencode.ai/zen/v1" }),
      model: "deepseek-v4.1-flash",
      want: null,
    },
    {
      name: "relay",
      p: provider({ id: "relay", baseUrl: "https://relay.example/v1" }),
      model: "deepseek-v4.1-flash",
      want: null,
    },
    {
      name: "relay named deepseek",
      p: provider({ id: "deepseek", baseUrl: "https://relay.example/v1" }),
      model: "deepseek-flash",
      want: null,
    },
    {
      name: "lookalike host",
      p: provider({ id: "x", baseUrl: "https://api.deepseek.com.evil.example/v1" }),
      model: "deepseek-flash",
      want: null,
    },
    {
      name: "removed deepseek",
      p: provider({ id: "deepseek", baseUrl: "" }),
      model: "deepseek-flash",
      want: "deepseek",
    },
    {
      name: "openai",
      p: provider({ id: "openai", baseUrl: "https://api.openai.com/v1" }),
      model: "gpt-6-astra",
      want: null,
    },
    {
      name: "ollama cloud flash",
      p: provider({ id: "ollama-cloud", baseUrl: "https://ollama.com/v1" }),
      model: "deepseek-v4.1-flash",
      want: "ollama",
    },
    {
      name: "ollama cloud pro",
      p: provider({ id: "ollama-cloud", baseUrl: "https://ollama.com/v1" }),
      model: "deepseek-v4-pro",
      want: "ollama",
    },
    {
      name: "ollama cloud dated flash",
      p: provider({ id: "ollama-cloud", baseUrl: "https://ollama.com/v1" }),
      model: "deepseek-v4.1-flash:1017",
      want: "ollama",
    },
    {
      name: "ollama cloud dated pro",
      p: provider({ id: "ollama-cloud", baseUrl: "https://ollama.com/v1" }),
      model: "deepseek-v4-pro:0813",
      want: "ollama",
    },
    {
      name: "ollama cloud v4-flash",
      p: provider({ id: "ollama-cloud", baseUrl: "https://ollama.com/v1" }),
      model: "deepseek-v4-flash",
      want: null,
    },
    {
      name: "ollama cloud glm",
      p: provider({ id: "ollama-cloud", baseUrl: "https://ollama.com/v1" }),
      model: "glm-5.3",
      want: null,
    },
    {
      name: "ollama cloud gpt-oss",
      p: provider({ id: "ollama-cloud", baseUrl: "https://ollama.com/v1" }),
      model: "gpt-oss:120b",
      want: null,
    },
    {
      name: "ollama cloud lookalike tag",
      p: provider({ id: "ollama-cloud", baseUrl: "https://ollama.com/v1" }),
      model: "deepseek-v4-pro-max:1",
      want: null,
    },
    {
      name: "removed ollama cloud",
      p: provider({ id: "ollama-cloud", baseUrl: "" }),
      model: "deepseek-v4-pro",
      want: "ollama",
    },
    {
      name: "ollama local",
      p: provider({ id: "ollama", baseUrl: "http://localhost:11434/v1" }),
      model: "deepseek-v4-pro",
      want: null,
    },
    {
      name: "relay named ollama cloud",
      p: provider({ id: "ollama-cloud", baseUrl: "https://relay.example/v1" }),
      model: "deepseek-v4-pro",
      want: null,
    },
    {
      name: "ollama lookalike host",
      p: provider({ id: "x", baseUrl: "https://ollama.com.evil.example/v1" }),
      model: "deepseek-v4-pro",
      want: null,
    },
    {
      name: "opencode go at ollama's model",
      p: provider({ id: "oc", baseUrl: "https://opencode.ai/zen/go/v1" }),
      model: "deepseek-v4-pro:0813",
      want: null,
    },
  ];
  for (const c of cases) {
    it(`tells ${c.name}`, () => {
      expect(peakOf(c.p, c.model)).toBe(c.want);
    });
  }
  it("leaves every model of a provider that keeps one price alone", () => {
    expect(peakOf(provider({ id: "gw", baseUrl: "https://api.openai.com/v1" }), "glm-5.1")).toBe(
      null,
    );
  });
});

describe("prices at peak", () => {
  const deepseek = provider({ id: "deepseek", baseUrl: "https://api.deepseek.com/v1" });
  const flat = { inputPerMTok: 0.15, outputPerMTok: 0.6, cacheReadPerMTok: 0.003 };
  const priceAt = (
    providerId: string,
    modelId: string,
    when: number,
    input: {
      providers: GatewayProvider[];
      pricing?: GatewayConfig["pricing"];
      modelSameAs?: GatewayConfig["modelSameAs"];
      catalog?: PricingCatalog;
    },
  ): PricedModel | null =>
    usagePrice({
      config: config(input.providers, input.pricing, input.modelSameAs),
      providerId,
      modelId,
      catalog: input.catalog ?? null,
      at: when,
    });

  it("doubles a DeepSeek list price at peak, at the price rate still", () => {
    const catalog = catalogWith({
      list: { "deepseek/deepseek-flash": { input: 0.15, output: 0.6, cacheRead: 0.003 } },
    });
    const peak = priceAt("deepseek", "deepseek-flash", PEAK_TIME, {
      providers: [deepseek],
      catalog,
    });
    const off = priceAt("deepseek", "deepseek-flash", OFF_TIME, {
      providers: [deepseek],
      catalog,
    });
    expect(peak?.inputPerMTok).toBeCloseTo(0.3);
    expect(peak?.outputPerMTok).toBeCloseTo(1.2);
    expect(peak?.cacheReadPerMTok).toBeCloseTo(0.006);
    expect(off?.inputPerMTok).toBeCloseTo(0.15);

    const half = priceAt("deepseek", "deepseek-flash", PEAK_TIME, {
      providers: [{ ...deepseek, priceRate: 0.5 }],
      catalog,
    });
    expect(half?.inputPerMTok).toBeCloseTo(0.15);
  });

  it("doubles a price the user set for the model, or for every model", () => {
    for (const key of ["deepseek/deepseek-flash", "deepseek/*", "deepseek-flash"]) {
      const pricing = { [key]: flat };
      const peak = priceAt("deepseek", "deepseek-flash", PEAK_TIME, {
        providers: [deepseek],
        pricing,
      });
      const off = priceAt("deepseek", "deepseek-flash", OFF_TIME, {
        providers: [deepseek],
        pricing,
      });
      expect(peak?.inputPerMTok, key).toBeCloseTo(0.3);
      expect(off?.inputPerMTok, key).toBeCloseTo(0.15);
    }
  });

  it("leaves a flat vendor's price alone, set or listed", () => {
    const zen = provider({ id: "opencode-zen", baseUrl: "https://opencode.ai/zen/v1" });
    const openai = provider({ id: "openai", baseUrl: "https://api.openai.com/v1" });
    const catalog = catalogWith({
      list: {
        "opencode-zen/deepseek-v4.1-flash": { input: 0.3, output: 1.2 },
        "openai/gpt-6-astra": { input: 2, output: 8 },
      },
    });
    for (const when of [PEAK_TIME, OFF_TIME]) {
      expect(
        priceAt("opencode-zen", "deepseek-v4.1-flash", when, { providers: [zen], catalog })
          ?.inputPerMTok,
      ).toBeCloseTo(0.3);
      expect(
        priceAt("openai", "gpt-6-astra", when, { providers: [openai], catalog })?.inputPerMTok,
      ).toBeCloseTo(2);
      const set = { inputPerMTok: 0.2, outputPerMTok: 0.8 };
      expect(
        priceAt("opencode-zen", "deepseek-v4.1-flash", when, {
          providers: [zen],
          pricing: { "opencode-zen/deepseek-v4.1-flash": set },
        })?.inputPerMTok,
      ).toBeCloseTo(0.2);
    }
  });

  it("keeps the hours of the model a SamePrice model borrows, not its vendor's", () => {
    const catalog = catalogWith({
      makers: { "deepseek-flash": { input: 0.15, output: 0.6 } },
    });
    const sameAs = { "deepseek/mystery": "deepseek-flash" };
    for (const when of [PEAK_TIME, OFF_TIME]) {
      const price = priceAt("deepseek", "mystery", when, {
        providers: [deepseek],
        modelSameAs: sameAs,
        catalog,
      });
      expect(price?.inputPerMTok).toBeCloseTo(0.15);
    }
    expect(peakOf(deepseek, "mystery")).toBe("deepseek");
  });

  it("prices a removed DeepSeek provider by its id", () => {
    const catalog = catalogWith({
      makers: { "deepseek-flash": { input: 0.15, output: 0.6 } },
    });
    const removed = provider({ id: "deepseek", baseUrl: "" });
    expect(
      priceAt("deepseek", "deepseek-flash", PEAK_TIME, { providers: [removed], catalog })
        ?.inputPerMTok,
    ).toBeCloseTo(0.3);
    // Gone from the config since the call: only its id remains.
    expect(
      priceAt("deepseek", "deepseek-flash", PEAK_TIME, { providers: [], catalog })?.inputPerMTok,
    ).toBeCloseTo(0.3);
  });

  it("bills Command Code's DeepSeek models at its weekday hours", () => {
    const catalog = catalogWith({
      makers: { "deepseek/deepseek-v4.1-flash": { input: 0.15, output: 0.6 } },
    });
    const plan = provider({ id: "commandcode-plan", baseUrl: "plugin://commandcode-plan/v1" });
    const peak = priceAt("commandcode-plan", "deepseek/deepseek-v4.1-flash", PEAK_TIME, {
      providers: [plan],
      catalog,
    });
    const off = priceAt("commandcode-plan", "deepseek/deepseek-v4.1-flash", OFF_TIME, {
      providers: [plan],
      catalog,
    });
    expect(peak?.inputPerMTok).toBeCloseTo(0.3);
    expect(off?.inputPerMTok).toBeCloseTo(0.15);
    // A Chinese holiday is Command Code's weekday still.
    expect(
      priceAt("commandcode-plan", "deepseek/deepseek-v4.1-flash", at("2026-10-05", "02:00"), {
        providers: [plan],
        catalog,
      })?.inputPerMTok,
    ).toBeCloseTo(0.3);
  });

  it("bills Ollama Cloud's two models at its own hours, its GLM at one price", () => {
    const ollama = provider({ id: "ollama-cloud", baseUrl: "https://ollama.com/v1" });
    const catalog = catalogWith({
      list: {
        "ollama-cloud/deepseek-v4.1-flash": { input: 0.15, output: 0.6, cacheRead: 0.003 },
        "ollama-cloud/deepseek-v4-pro": { input: 0.66, output: 1.98, cacheRead: 0.022 },
        "ollama-cloud/glm-5.3": { input: 1.4, output: 4.4, cacheRead: 0.26 },
      },
    });
    const peak = priceAt("ollama-cloud", "deepseek-v4-pro", at("2026-10-28", "15:00"), {
      providers: [ollama],
      catalog,
    });
    expect(peak?.inputPerMTok).toBeCloseTo(1.32);
    expect(peak?.outputPerMTok).toBeCloseTo(3.96);
    expect(peak?.cacheReadPerMTok).toBeCloseTo(0.044);
    expect(
      priceAt("ollama-cloud", "deepseek-v4-pro", at("2026-10-28", "11:59"), {
        providers: [ollama],
        catalog,
      })?.inputPerMTok,
    ).toBeCloseTo(0.66);
    expect(
      priceAt("ollama-cloud", "deepseek-v4-pro", at("2026-10-31", "15:00"), {
        providers: [ollama],
        catalog,
      })?.inputPerMTok,
    ).toBeCloseTo(0.66);
    expect(
      priceAt("ollama-cloud", "deepseek-v4-pro", at("2026-10-05", "13:00"), {
        providers: [ollama],
        catalog,
      })?.inputPerMTok,
    ).toBeCloseTo(1.32);
    expect(
      priceAt("ollama-cloud", "glm-5.3", at("2026-10-28", "15:00"), {
        providers: [ollama],
        catalog,
      })?.inputPerMTok,
    ).toBeCloseTo(1.4);
    // DeepSeek's own API keeps its own hours beside it.
    const deepseekApi = provider({ id: "deepseek", baseUrl: "https://api.deepseek.com" });
    const dsCatalog = catalogWith({
      list: { "deepseek/deepseek-v4-pro": { input: 0.66, output: 1.98, cacheRead: 0.013 } },
    });
    expect(
      priceAt("deepseek", "deepseek-v4-pro", at("2026-10-28", "15:00"), {
        providers: [deepseekApi],
        catalog: dsCatalog,
      })?.inputPerMTok,
    ).toBeCloseTo(0.66);
    expect(
      priceAt("deepseek", "deepseek-v4-pro", at("2026-10-28", "02:00"), {
        providers: [deepseekApi],
        catalog: dsCatalog,
      })?.inputPerMTok,
    ).toBeCloseTo(1.32);
  });
});
