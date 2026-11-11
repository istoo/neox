import { describe, expect, it } from "vitest";
import { GatewayConfigSchema, type GatewayConfig } from "./config.js";
import {
  clockOf,
  normalizeWarmAt,
  normalizeWarmAtConfig,
  normalizeWarmAts,
  warmAtsFor,
  withAccountWarmAt,
  withWarmAts,
} from "./warm-at.js";

function configWith(overrides: Record<string, unknown> = {}): GatewayConfig {
  return GatewayConfigSchema.parse({
    providers: [
      {
        id: "codex",
        protocol: "openai",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        accounts: [
          { id: "me", warmup: true },
          { id: "other", warmup: true },
        ],
      },
      {
        id: "some-vendor",
        protocol: "openai",
        baseUrl: "https://api.example.com",
        accounts: [{ id: "main" }],
      },
    ],
    ...overrides,
  });
}

describe("warm-at times", () => {
  it("reads a time of day as myna's Clock does", () => {
    expect(clockOf("6:00")).toBe("06:00");
    expect(clockOf(" 21:30:00 ")).toBe("21:30");
    expect(clockOf("24:00")).toBeNull();
    expect(clockOf("09:60")).toBeNull();
    expect(clockOf("morning")).toBeNull();
  });

  it("keeps a list canonical, once each, earliest first", () => {
    // myna's warmats_test.go: TestWarmAtsMigrate's several-times case.
    expect(normalizeWarmAts(["19:10", " 9:00", "15:05:00", "09:00", ""])).toEqual([
      "09:00",
      "15:05",
      "19:10",
    ]);
    expect(normalizeWarmAts([])).toEqual([]);
  });

  it("keeps an account's own time, its off, or its follow", () => {
    expect(normalizeWarmAt("6:00")).toBe("06:00");
    expect(normalizeWarmAt(" OFF ")).toBe("off");
    expect(normalizeWarmAt("")).toBe("");
    expect(normalizeWarmAt("25:00")).toBe("");
  });

  it("prefers an account's own time to its agent's list", () => {
    const config = configWith({ codexWarmAts: ["6:00", "15:00"] });
    const provider = config.providers[0]!;
    const follows = provider.accounts[0]!;
    const own = { ...follows, warmAt: "19:10" };
    const off = { ...follows, warmAt: "off" };
    expect(warmAtsFor(provider, follows, config)).toEqual(["06:00", "15:00"]);
    expect(warmAtsFor(provider, own, config)).toEqual(["19:10"]);
    expect(warmAtsFor(provider, off, config)).toEqual([]);
    expect(warmAtsFor(config.providers[1]!, config.providers[1]!.accounts[0]!, config)).toEqual([]);
  });

  it("writes one agent's list and one account's time", () => {
    const config = configWith();
    const withTimes = withWarmAts(config, "claude", ["21:30:00", "06:00", "06:00"]);
    expect(withTimes.claudeWarmAts).toEqual(["21:30:00", "06:00", "06:00"]);
    expect(withTimes.codexWarmAts).toEqual([]);
    const single = withAccountWarmAt(config, "codex", "other", "09:00");
    expect(single?.providers[0]?.accounts[1]?.warmAt).toBe("09:00");
    expect(single?.providers[0]?.accounts[0]?.warmAt).toBe("");
    expect(withAccountWarmAt(config, "codex", "nobody", "09:00")).toBeNull();
    expect(withAccountWarmAt(config, "nobody", "me", "09:00")).toBeNull();
  });

  it("canonicalizes every warm-at as config is written", () => {
    const config = configWith({
      codexWarmAts: [" 9:00", "15:05:00", "09:00", "nope"],
    });
    const first = config.providers[0]!;
    const kept = normalizeWarmAtConfig({
      ...config,
      providers: [
        {
          ...first,
          accounts: [{ ...first.accounts[0]!, warmAt: " 6:00" }, ...first.accounts.slice(1)],
        },
        ...config.providers.slice(1),
      ],
    });
    expect(kept.codexWarmAts).toEqual(["09:00", "15:05"]);
    expect(kept.providers[0]?.accounts[0]?.warmAt).toBe("06:00");
  });
});
