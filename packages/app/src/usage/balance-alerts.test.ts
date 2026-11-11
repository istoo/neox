import { describe, expect, it } from "vitest";
import { findDueBalanceAlerts, parseBalanceAmount, type BalanceReading } from "./balance-alerts";

function reading(overrides: Partial<BalanceReading> = {}): BalanceReading {
  return {
    key: "deepseek/work",
    providerLabel: "DeepSeek",
    accountLabel: "work",
    text: "$4.20",
    value: 4.2,
    ...overrides,
  };
}

describe("parseBalanceAmount", () => {
  it("reads a plain number", () => {
    expect(parseBalanceAmount("12.50")).toEqual({ value: 12.5, text: "12.50" });
  });

  it("keeps the vendor's wording and strips grouping and symbols", () => {
    expect(parseBalanceAmount("¥ 1,234.56")).toEqual({ value: 1234.56, text: "¥ 1,234.56" });
    expect(parseBalanceAmount("1200 credits")).toEqual({ value: 1200, text: "1200 credits" });
  });

  it("reads a vendor's k/M shorthand as myna does", () => {
    expect(parseBalanceAmount("1.5k credits")?.value).toBe(1500);
    expect(parseBalanceAmount("2M tokens")?.value).toBe(2_000_000);
  });

  it("says nothing for an amount with no number", () => {
    expect(parseBalanceAmount(null)).toBeNull();
    expect(parseBalanceAmount("")).toBeNull();
    expect(parseBalanceAmount("unavailable")).toBeNull();
    expect(parseBalanceAmount("unlimited")).toBeNull();
  });

  it("ignores a percentage, which is not an amount", () => {
    expect(parseBalanceAmount("80% used")).toBeNull();
  });
});

describe("findDueBalanceAlerts", () => {
  it("alerts when a balance reaches the threshold, once", () => {
    const below = new Set<string>();
    const first = findDueBalanceAlerts({ readings: [reading()], threshold: 5, below });
    expect(first).toHaveLength(1);
    expect(first[0]?.text).toBe("$4.20");
    expect(findDueBalanceAlerts({ readings: [reading()], threshold: 5, below })).toEqual([]);
  });

  it("re-arms after a top-up takes the balance back above the threshold", () => {
    const below = new Set<string>();
    findDueBalanceAlerts({ readings: [reading()], threshold: 5, below });
    findDueBalanceAlerts({
      readings: [reading({ value: 20, text: "$20.00" })],
      threshold: 5,
      below,
    });
    expect(below.size).toBe(0);
    expect(findDueBalanceAlerts({ readings: [reading()], threshold: 5, below })).toHaveLength(1);
  });

  it("keeps a balance that alerted quiet while its vendor says no number", () => {
    const below = new Set<string>();
    findDueBalanceAlerts({ readings: [reading()], threshold: 5, below });
    // "unlimited" parses to nothing, so no reading arrives at all this round.
    expect(findDueBalanceAlerts({ readings: [], threshold: 5, below })).toEqual([]);
    expect(below.has("deepseek/work")).toBe(true);
    // Topped up and numeric again: re-armed.
    findDueBalanceAlerts({
      readings: [reading({ value: 20, text: "$20" })],
      threshold: 5,
      below,
    });
    expect(below.size).toBe(0);
  });

  it("does nothing when the threshold is off", () => {
    expect(
      findDueBalanceAlerts({ readings: [reading()], threshold: 0, below: new Set<string>() }),
    ).toEqual([]);
  });

  it("judges each account in its own unit", () => {
    const below = new Set<string>();
    const due = findDueBalanceAlerts({
      readings: [
        reading({ key: "a/one", value: 3, text: "3 credits" }),
        reading({ key: "b/two", value: 30, text: "¥30" }),
      ],
      threshold: 5,
      below,
    });
    expect(due.map((alert) => alert.key)).toEqual(["a/one"]);
  });
});
