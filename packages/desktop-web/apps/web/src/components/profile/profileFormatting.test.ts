// FILE: profileFormatting.test.ts
// Purpose: Verify profile labels follow the active UI language and regional number format.
// Layer: web profile feature tests.

import { afterEach, describe, expect, it } from "vitest";
import { getFormatLocale, setLanguagePreference } from "~/i18n";
import { formatCompact, formatDays, formatNumber, formatShortDate } from "./profileFormatting";

afterEach(() => setLanguagePreference("system"));

describe("profile locale formatting", () => {
  it("refreshes existing date and number formatters when switching between English and Chinese", () => {
    for (const language of ["en", "zh-CN"] as const) {
      setLanguagePreference(language);
      expect(formatNumber(1234567)).toBe(
        new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(1234567),
      );
      expect(formatCompact(1234)).toBe(
        `${new Intl.NumberFormat(language, { maximumFractionDigits: 1, useGrouping: false }).format(1.2)}k`,
      );
      expect(formatShortDate("2026-04-03")).toBe(
        new Intl.DateTimeFormat(language, {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }).format(new Date("2026-04-03T00:00:00Z")),
      );
    }
    setLanguagePreference("system");
    expect(formatNumber(1234567)).toBe(
      new Intl.NumberFormat(getFormatLocale(), { maximumFractionDigits: 0 }).format(1234567),
    );
  });

  it("localizes day labels while allowing an explicit regional formatter locale", () => {
    setLanguagePreference("zh-CN");
    expect(formatDays(1)).toBe("1 天");
    expect(formatDays(2)).toBe("2 天");
    expect(formatNumber(1234567, "en-IN")).toBe("12,34,567");
  });
});
