import { describe, expect, it } from "vitest";

import { normalizeLanguagePreference, resolveUiLocale } from "./uiLocale";

describe("interface locale resolution", () => {
  it("offers Chinese on every build flavor while preserving System order and explicit languages", () => {
    // Neolix: upstream kept Chinese Beta-only; here Stable resolves it like English.
    expect(resolveUiLocale("zh-CN", ["zh-CN", "en-US"], "production")).toBe("zh-CN");
    expect(resolveUiLocale("system", ["zh-CN"], "production")).toBe("zh-CN");
    expect(resolveUiLocale("en", ["zh-CN"], "production")).toBe("en");
    expect(resolveUiLocale("zh-CN", ["en-US"], "beta")).toBe("zh-CN");
    expect(resolveUiLocale("system", ["zh-CN"], "beta")).toBe("zh-CN");
  });

  it.each(["zh", "zh-CN", "zh-SG", "zh-Hans", "zh-Hans-CN", "zh-Hans-TW", "ZH-hans-sg"])(
    "resolves Simplified Chinese browser preference %s",
    (language) => {
      expect(resolveUiLocale("system", [language])).toBe("zh-CN");
    },
  );

  it.each(["zh-TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-CN"])(
    "does not silently map Traditional Chinese %s to Simplified Chinese",
    (language) => {
      expect(resolveUiLocale("system", [language, "en-US"])).toBe("en");
      expect(resolveUiLocale("system", [language])).toBe("en");
    },
  );

  it("respects browser preference order, explicit choices, and malformed language fallback", () => {
    // Neolix ships English and Simplified Chinese; other languages fall through to the next.
    expect(resolveUiLocale("system", ["de-DE", "zh-Hans", "en"])).toBe("zh-CN");
    expect(resolveUiLocale("system", ["es-MX", "fr-FR"])).toBe("en");
    expect(resolveUiLocale("system", ["en-GB", "zh-CN"])).toBe("en");
    expect(resolveUiLocale("system", ["not_a_locale", "ZH-cn"])).toBe("zh-CN");
    expect(resolveUiLocale("system", [])).toBe("en");
    expect(resolveUiLocale("zh-CN", ["en-US"])).toBe("zh-CN");
    expect(resolveUiLocale("en", ["zh-CN"])).toBe("en");
  });

  it("accepts only persisted preference identifiers rather than arbitrary locale aliases", () => {
    for (const preference of ["system", "en", "zh-CN"] as const)
      expect(normalizeLanguagePreference(preference)).toBe(preference);
    for (const value of [undefined, null, "zh", "zh-Hans", "zh-TW", "es", "fr", 0, {}])
      expect(normalizeLanguagePreference(value)).toBe("system");
  });
});
