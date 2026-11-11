import { describe, expect, it, vi } from "vitest";
import { ensureI18nLanguageForRender, syncDocumentLanguage } from "./sync-language";

describe("syncDocumentLanguage", () => {
  it("sets the document language to the resolved locale", () => {
    const root = { lang: "en" };

    syncDocumentLanguage("zh-CN", root);

    expect(root.lang).toBe("zh-CN");
  });

  it("does nothing when the runtime has no document", () => {
    expect(() => syncDocumentLanguage("ja", undefined)).not.toThrow();
  });
});

describe("ensureI18nLanguageForRender", () => {
  it("changes the i18n language before callers render children", () => {
    const calls: string[] = [];
    const i18n = {
      language: "en",
      changeLanguage: (locale: string) => {
        calls.push(locale);
        i18n.language = locale;
        return Promise.resolve();
      },
    };

    ensureI18nLanguageForRender("zh-CN", i18n);

    expect(i18n.language).toBe("zh-CN");
    expect(calls).toEqual(["zh-CN"]);
  });

  it("does not call changeLanguage when the current language already matches", () => {
    const changeLanguage = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    ensureI18nLanguageForRender("en", {
      language: "en",
      changeLanguage,
    });

    expect(changeLanguage).not.toHaveBeenCalled();
  });
});
