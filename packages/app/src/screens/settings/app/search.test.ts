import { describe, expect, it } from "vitest";
import { SETTINGS_SEARCH_INDEX, searchSettingsEntries } from "./search";
import { SETTINGS_PAGE_TITLES } from "./types";

const englishTitles: Record<string, string> = {
  "settings.appearance.theme.title": "Theme",
  "settings.appearance.fonts.interfaceFont": "Interface font",
  "settings.pages.network.gateway": "Model gateway",
  "settings.pages.quota.openUsage": "Usage, quotas and requests",
  "settings.pages.privacy.masking": "Masking rules",
  "settings.sections.shortcuts": "Shortcuts",
};

const chineseTitles: Record<string, string> = {
  "settings.appearance.theme.title": "外观",
  "settings.appearance.fonts.interfaceFont": "界面字体",
  "settings.pages.network.gateway": "模型网关",
  "settings.pages.quota.openUsage": "用量、额度与请求",
  "settings.pages.privacy.masking": "脱敏规则",
  "settings.sections.shortcuts": "快捷键",
};

const translate = {
  current: (key: string) => chineseTitles[key] ?? englishTitles[key] ?? key,
  english: (key: string) => englishTitles[key] ?? key,
};

describe("settings search", () => {
  it("returns nothing for a blank query", () => {
    expect(searchSettingsEntries("   ", translate)).toEqual([]);
  });

  it("finds an English word", () => {
    const groups = searchSettingsEntries("gateway", translate);
    expect(groups.some((group) => group.pageId === "network")).toBe(true);
  });

  it("finds a Chinese word, which names the page even when the row is English", () => {
    const groups = searchSettingsEntries("字体", translate);
    const appearance = groups.find((group) => group.pageId === "appearance");
    expect(appearance?.entries.map((entry) => entry.titleKey)).toContain(
      "settings.appearance.fonts.interfaceFont",
    );
  });

  it("requires every word to match", () => {
    expect(searchSettingsEntries("gateway quota", translate)).toEqual([]);
  });

  it("resolves every entry to a page with a title", () => {
    for (const entry of SETTINGS_SEARCH_INDEX) {
      expect(SETTINGS_PAGE_TITLES[entry.pageId]).toBeTypeOf("string");
    }
  });
});
