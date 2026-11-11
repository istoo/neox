import { describe, expect, it } from "vitest";

import { rateLimitWindowDisplayLabel } from "./rateLimits";

// Echoes the key and count so the assertions read the mapping, not a locale's wording.
function translate(key: string, values?: { count?: number }): string {
  return values?.count === undefined ? key : `${key}:${values.count}`;
}

describe("rateLimitWindowDisplayLabel", () => {
  const label = (value: string) =>
    rateLimitWindowDisplayLabel(
      value,
      translate as Parameters<typeof rateLimitWindowDisplayLabel>[1],
    );

  it("translates named windows regardless of case", () => {
    expect(label("Weekly")).toBe("settings:usageWindowWeekly");
    expect(label("weekly")).toBe("settings:usageWindowWeekly");
    expect(label("Month")).toBe("settings:usageWindowMonthly");
    expect(label("Usage credits")).toBe("settings:usageWindowCredits");
    expect(label("5h")).toBe("settings:usageWindowFiveHours");
  });

  it("reads a count and a unit from vendor labels", () => {
    expect(label("30 Day")).toBe("settings:usageWindowDays:30");
    expect(label("7d")).toBe("settings:usageWindowDays:7");
    expect(label("5 hours")).toBe("settings:usageWindowHours:5");
    expect(label("2 weeks")).toBe("settings:usageWindowWeeks:2");
    expect(label("3-month")).toBe("settings:usageWindowMonths:3");
    expect(label("15 min")).toBe("settings:usageWindowMinutes:15");
  });

  it("keeps labels it cannot read as the vendor wrote them", () => {
    expect(label("Opus weekly")).toBe("Opus weekly");
    expect(label("30 parsecs")).toBe("30 parsecs");
  });
});
