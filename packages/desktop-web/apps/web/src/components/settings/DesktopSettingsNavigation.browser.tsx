// FILE: DesktopSettingsNavigation.browser.tsx
// Purpose: The Desktop settings section exists only inside the Electron shell,
//          and search must reach it there.
// Layer: Browser UI test

import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {},
  });
});

describe("desktop settings navigation", () => {
  it("lists the Desktop section and resolves it as a deep link", async () => {
    const navigation = await import("../../settingsNavigation");

    expect(navigation.isSettingsSectionAvailable("desktop")).toBe(true);
    const item = navigation.SETTINGS_NAV_ITEMS.find((entry) => entry.id === "desktop");
    expect(item?.icon).toBe("layout-window");
    expect(item?.group).toBe("system");
    expect(navigation.normalizeSettingsSection("desktop")).toBe("desktop");
  });

  it("finds the Desktop rows through settings search", async () => {
    const search = await import("../../settingsSearchIndex");

    const results = search.rankSettingsSearchEntries("tray", 20);
    expect(results.some((entry) => entry.section === "desktop")).toBe(true);
  });
});
