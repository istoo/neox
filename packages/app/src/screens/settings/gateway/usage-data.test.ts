import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCompact, formatUsd } from "./usage-data";
import { resetFxForTests, setDisplayPreferences } from "@/usage/currency";

afterEach(() => {
  resetFxForTests();
  vi.restoreAllMocks();
});

describe("gateway usage formatting", () => {
  it("shows costs in dollars by default", () => {
    expect(formatUsd(1.234, "en-US")).toBe("$1.23");
    expect(formatUsd(0, "en-US")).toBe("$0.00");
  });

  it("converts costs to yuan when the currency setting is CNY", async () => {
    setDisplayPreferences({ currency: "cny", numberUnits: "compact" });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ rates: { CNY: 7.5 } }), {
          status: 200,
        }),
    );
    const { refreshFxRate } = await import("@/usage/currency");
    await refreshFxRate(Date.now(), fetchMock);
    expect(formatUsd(2, "en-US")).toContain("15");
  });

  it("writes counts in 万 when Chinese units are on", () => {
    setDisplayPreferences({ currency: "usd", numberUnits: "wan" });
    expect(formatCompact(80_000_000, "en-US")).toBe("8000万");
    setDisplayPreferences({ currency: "usd", numberUnits: "compact" });
    expect(formatCompact(1_900_000, "en-US")).toBe("1.9M");
  });
});
