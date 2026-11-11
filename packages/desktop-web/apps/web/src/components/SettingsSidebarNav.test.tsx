// FILE: SettingsSidebarNav.test.tsx
// Purpose: Guards the settings sidebar search surface and its ranking index.
// Layer: Component rendering tests
// Depends on: SettingsSidebarNav, the settings search index, and React server rendering.

import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach } from "vitest";
import { setLanguagePreference, t } from "../i18n";
import { SettingsRow } from "./settings/SettingsPanelPrimitives";

import {
  SETTINGS_SEARCH_ENTRIES,
  rankSettingsSearchEntries,
  settingsSearchEntryTarget,
} from "../settingsSearchIndex";

afterEach(() => setLanguagePreference("system"));

describe("localized settings", () => {
  it("renders Chinese labels while retaining explicit navigation targets", () => {
    setLanguagePreference("zh-CN");
    const html = renderToStaticMarkup(
      <SettingsRow
        id="setting-default-provider"
        title="settings:changed_defaultProvider"
        description="settings:chooseTheProviderUsedForNewChatsAgentCodex"
      />,
    );
    expect(html).toContain('id="setting-default-provider"');
    expect(html).toContain("默认提供方");
    expect(html).toContain("选择新对话使用的提供方");
  });

  it("finds English settings in every interface locale and Chinese settings in Chinese with stable links", () => {
    for (const language of ["en", "zh-CN"] as const) {
      setLanguagePreference(language);
      const queries =
        language === "zh-CN" ? ["default provider", "默认提供方"] : ["default provider"];
      for (const query of queries) {
        const [result] = rankSettingsSearchEntries(query, 12);
        expect(result?.id).toBe("general:default-provider");
        expect(settingsSearchEntryTarget(result!)).toBe("setting-default-provider");
      }
      const languageQueries = language === "zh-CN" ? ["language", "语言"] : ["language"];
      for (const query of languageQueries) {
        const [result] = rankSettingsSearchEntries(query, 12);
        expect(result?.id).toBe("general:language");
        expect(settingsSearchEntryTarget(result!)).toBe("setting-language");
      }
    }
  });
});

describe("rankSettingsSearchEntries", () => {
  beforeEach(() => setLanguagePreference("en"));
  it("returns nothing for an empty query", () => {
    expect(rankSettingsSearchEntries("", 12)).toHaveLength(0);
    expect(rankSettingsSearchEntries("   ", 12)).toHaveLength(0);
  });

  it("ranks an exact title match first", () => {
    const [top] = rankSettingsSearchEntries("theme", 12);
    expect(top?.id).toBe("appearance:theme");
  });

  it("matches on description keywords, not just titles", () => {
    const results = rankSettingsSearchEntries("wrap", 12);
    expect(results.some((entry) => entry.id === "behavior:diff-line-wrapping")).toBe(true);
  });

  it("indexes the stacked and split diff layout preference", () => {
    const results = rankSettingsSearchEntries("stacked", 12);
    expect(results.some((entry) => entry.id === "behavior:diff-layout")).toBe(true);
  });

  it("surfaces every row in a section when searching the section label", () => {
    const results = rankSettingsSearchEntries("appearance", SETTINGS_SEARCH_ENTRIES.length);
    expect(results.some((entry) => entry.section === "appearance")).toBe(true);
  });

  it("respects the result limit", () => {
    expect(rankSettingsSearchEntries("e", 3)).toHaveLength(3);
  });

  it("uses explicit stable targets independently of translated titles", () => {
    const themeEntry = SETTINGS_SEARCH_ENTRIES.find((entry) => entry.id === "appearance:theme")!;
    expect(settingsSearchEntryTarget(themeEntry)).toBe("setting-theme");
    for (const entry of SETTINGS_SEARCH_ENTRIES) {
      if (entry.target == null) {
        expect(settingsSearchEntryTarget(entry)).toBeNull();
      } else {
        expect(settingsSearchEntryTarget({ ...entry, title: "重命名的设置" })).toBe(
          settingsSearchEntryTarget(entry),
        );
        expect(settingsSearchEntryTarget(entry)?.startsWith("setting-")).toBe(true);
      }
    }
  });

  it("finds the Behavior and Providers rows by their titles", () => {
    const titles = (query: string) =>
      rankSettingsSearchEntries(query, 12).map((entry) => t(entry.title));
    expect(titles("dictating")).toContain("Enter while dictating");
    expect(titles("diff colors")).toContain("Pull request diff colors");
    expect(titles("enabled providers")).toContain("Enabled providers");
  });

  it("finds the Fold finished turns and Wait for subagents rows", () => {
    const sections = (query: string) =>
      rankSettingsSearchEntries(query, 12).map((entry) => `${entry.section}:${t(entry.title)}`);
    expect(sections("fold")).toContain("behavior:Fold finished turns");
    expect(sections("worked for")).toContain("behavior:Fold finished turns");
    expect(sections("subagents")).toContain("notifications:Wait for subagents");
    const targets = (query: string) =>
      rankSettingsSearchEntries(query, 12).map((entry) => settingsSearchEntryTarget(entry));
    expect(targets("fold")).toContain("setting-fold-finished-turns");
    expect(targets("subagents")).toContain("setting-wait-for-subagents");
  });

  it("matches translated section copy in Chinese", () => {
    setLanguagePreference("zh-CN");
    const sections = (query: string) =>
      rankSettingsSearchEntries(query, 12).map((entry) => entry.section);
    expect(sections("网关")).toContain("gateway");
    expect(sections("提供方")).toContain("providers");
    expect(sections("快捷键")).toContain("shortcuts");
  });

  it("deep-links the provider picker result to the Available CLIs row", () => {
    const [top] = rankSettingsSearchEntries("picker order", 12);
    expect(top && t(top.title)).toBe("Available CLIs");
    expect(settingsSearchEntryTarget(top!)).toBe("setting-available-clis");
  });

  it("finds the appearance rows added after the original index", () => {
    setLanguagePreference("zh-CN");
    const targets = (query: string) =>
      rankSettingsSearchEntries(query, 20).map((entry) => settingsSearchEntryTarget(entry));
    expect(targets("命名主题")).toContain("setting-named-theme");
    expect(targets("界面字体")).toContain("setting-ui-font");
    expect(targets("界面字号")).toContain("setting-ui-font-size");
    expect(targets("代码字体")).toContain("setting-code-font");
    expect(targets("代码字号")).toContain("setting-code-font-size");
    expect(targets("自定义聊天宽度")).toContain("setting-chat-width-custom");
    expect(targets("Vim 键位")).toContain("setting-vim-keybindings");
    expect(targets("色盲模式")).toContain("setting-colorblind");
    expect(targets("减弱动效")).toContain("setting-reduce-motion");
    expect(targets("加载动画")).toContain("setting-loading-animation");
  });

  it("finds environment, usage, quota, and system rows by their Chinese titles", () => {
    setLanguagePreference("zh-CN");
    const targets = (query: string) =>
      rankSettingsSearchEntries(query, 20).map((entry) => settingsSearchEntryTarget(entry));
    expect(targets("会话终端")).toContain("setting-session-terminal");
    expect(targets("操作")).toContain("setting-actions");
    expect(targets("项目操作")).toContain("setting-project-actions");
    // The banked-resets row is gated off with NEOLIX_RESET_CREDITS_UI_ENABLED, so search must not offer it.
    expect(targets("已储存的重置次数")).not.toContain("setting-usage-banked-resets");
    expect(targets("额度和 token")).toContain("setting-usage-credits-tokens");
    expect(targets("读取提供方用量")).toContain("setting-quota-read-usage");
    expect(targets("余额降")).toContain("setting-quota-balance-alert");
    expect(targets("重置提醒")).toContain("setting-quota-reset-reminder");
  });

  it("finds system group rows by their Chinese titles", () => {
    setLanguagePreference("zh-CN");
    const targets = (query: string) =>
      rankSettingsSearchEntries(query, 20).map((entry) => settingsSearchEntryTarget(entry));
    expect(targets("端口")).toContain("setting-network-port");
    expect(targets("允许的地址")).toContain("setting-network-allow-ips");
    expect(targets("GitHub 令牌")).toContain("setting-network-github-token");
    expect(targets("自动备份")).toContain("setting-sync-auto-backups");
    expect(targets("收集器端点")).toContain("setting-observability-collector-endpoint");
    expect(targets("订阅账号")).toContain("setting-privacy-subscription-accounts");
    expect(targets("重启守护进程")).toContain("setting-host-restart");
    expect(targets("读取智能体自身的会话")).toContain("setting-privacy-read-sessions");
    expect(targets("搜索")).toContain("setting-sessions-search");
  });

  it("hides rows whose feature or platform gate is off", () => {
    const entry = (id: string) => SETTINGS_SEARCH_ENTRIES.find((item) => item.id === id)!;
    const context = { computerBackendIsVisibleDesktop: false };
    expect(entry("appearance:custom-title-bar").applies?.(context)).toBe(false);
    expect(entry("appearance:app-icon").applies?.(context)).toBe(false);
    // The index must agree with the row's own gate, whatever this build sets it to.
    const hubsAvailable = entry("general:groups-section").applies?.(context) ?? true;
    expect(
      rankSettingsSearchEntries("hubs", 50).some((item) => item.id === "general:groups-section"),
    ).toBe(hubsAvailable);
    expect(
      rankSettingsSearchEntries("custom title bar", 50).some(
        (item) => item.id === "appearance:custom-title-bar",
      ),
    ).toBe(false);
  });

  it("does not fuzz-match short Latin queries across words", () => {
    const ids = (query: string) => rankSettingsSearchEntries(query, 50).map((entry) => entry.id);
    expect(ids("vim")).toContain("appearance:vim-keybindings");
    expect(ids("vim")).not.toContain("behavior:archive-confirmation");
    expect(ids("pr")).not.toContain("behavior:archive-confirmation");
    expect(ids("stt")).not.toContain("behavior:archive-confirmation");
  });
});
