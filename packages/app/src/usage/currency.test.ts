import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FALLBACK_CNY_PER_USD,
  FX_TTL_MS,
  cnyPerUsd,
  formatCost,
  formatCount,
  refreshFxRate,
  resetFxForTests,
  setDisplayPreferences,
} from "./currency";

function reply(rates: Record<string, number>): Response {
  return new Response(JSON.stringify({ result: "success", rates }), { status: 200 });
}

afterEach(() => {
  resetFxForTests();
  vi.restoreAllMocks();
});

describe("currency", () => {
  it("falls back to a plausible rate before anything was fetched", () => {
    expect(cnyPerUsd()).toBe(FALLBACK_CNY_PER_USD);
    expect(formatCost(2, "en-US")).toContain("$");
  });

  it("keeps a fetched rate and converts costs with it", async () => {
    const fetchMock = vi.fn(async () => reply({ CNY: 7.5 }));
    await refreshFxRate(1_000, fetchMock);
    expect(cnyPerUsd()).toBe(7.5);
    setDisplayPreferences({ currency: "cny", numberUnits: "compact" });
    expect(formatCost(10, "en-US")).toContain("75");
  });

  it("asks once per TTL", async () => {
    const fetchMock = vi.fn(async () => reply({ CNY: 7.5 }));
    await refreshFxRate(1_000, fetchMock);
    await refreshFxRate(2_000, fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await refreshFxRate(1_000 + FX_TTL_MS, fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the last rate when the endpoint fails, and retries later", async () => {
    const ok = vi.fn(async () => reply({ CNY: 7.3 }));
    await refreshFxRate(1_000, ok);
    const failing = vi.fn(async () => new Response("nope", { status: 500 }));
    await refreshFxRate(1_000 + FX_TTL_MS, failing);
    expect(cnyPerUsd()).toBe(7.3);
    await refreshFxRate(1_000 + FX_TTL_MS + 60_000, failing);
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("says nothing when the reply has no CNY rate", async () => {
    const fetchMock = vi.fn(async () => reply({ EUR: 0.9 }));
    await refreshFxRate(1_000, fetchMock);
    expect(cnyPerUsd()).toBe(FALLBACK_CNY_PER_USD);
  });

  it("writes large counts in 万 and 亿 when Chinese units are on", () => {
    setDisplayPreferences({ currency: "usd", numberUnits: "wan" });
    expect(formatCount(80_000_000, "en-US")).toBe("8000万");
    expect(formatCount(210_000_000, "en-US")).toBe("2.1亿");
    setDisplayPreferences({ currency: "usd", numberUnits: "compact" });
    expect(formatCount(80_000_000, "en-US")).toMatch(/M/);
  });
});
