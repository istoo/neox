import { isBetaFeatureEnabled } from "@synara/shared/betaFeatures";
import { describe, expect, it } from "vitest";

import {
  isSettingsSectionAvailable,
  normalizeSettingsSection,
  SETTINGS_NAV_ITEMS,
  SETTINGS_PAGES,
  SETTINGS_SECTION_IDS,
  settingsPageForSection,
  settingsPageForSectionIn,
  settingsPagesWithoutSections,
  settingsTabLabel,
} from "./settingsNavigation";

describe("settings sections", () => {
  it("shows Connectors without a Beta gate", () => {
    expect(isSettingsSectionAvailable("connectors", () => false)).toBe(true);
    expect(isSettingsSectionAvailable("integrations", () => false)).toBe(true);
  });

  it("lists Connectors without a Beta badge and allows them on Stable", () => {
    expect(
      isSettingsSectionAvailable("connectors", (feature) =>
        isBetaFeatureEnabled(feature, "production"),
      ),
    ).toBe(true);
    const ids = SETTINGS_NAV_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Sections without a Neox backend (profile, computer, appsnap) are hidden from nav.
    expect(ids.toSorted()).toEqual(
      SETTINGS_SECTION_IDS.filter((id) => isSettingsSectionAvailable(id)).toSorted(),
    );
    expect(normalizeSettingsSection("connectors")).toBe("connectors");
    expect(SETTINGS_NAV_ITEMS.find((item) => item.id === "connectors")?.badge).toBeUndefined();
  });

  it("falls back to General for unknown sections", () => {
    expect(normalizeSettingsSection("nope")).toBe("general");
    expect(normalizeSettingsSection(undefined)).toBe("general");
  });
});

describe("settings pages", () => {
  it("puts every available section on exactly one page", () => {
    const tabSections = SETTINGS_PAGES.flatMap((page) => page.tabs.map((tab) => tab.section));
    expect(new Set(tabSections).size).toBe(tabSections.length);
    expect(tabSections.toSorted()).toEqual(SETTINGS_NAV_ITEMS.map((item) => item.id).toSorted());
    expect(SETTINGS_PAGES.length).toBeLessThanOrEqual(14);
  });

  it("opens a merged section's page on that section's tab", () => {
    expect(settingsPageForSection("integrations").id).toBe("mcp");
    expect(settingsPageForSection("quota").id).toBe("usage");
    expect(settingsPageForSection("archived").id).toBe("data");
    const mcp = settingsPageForSection("connectors");
    expect(settingsTabLabel(mcp, "connectors")).toBe("settings:navTab_mcpServers");
    expect(settingsTabLabel(mcp, "integrations")).toBe("settings:navTab_mcpBuiltIn");
  });

  it("sends a retired section's saved link to the section that replaced it", () => {
    expect(normalizeSettingsSection("library-mcp")).toBe("connectors");
    expect(normalizeSettingsSection("constructor")).toBe("general");
  });

  it("drops a page whose every tab a built-in feature switch hid", () => {
    const pages = settingsPagesWithoutSections(new Set(["connectors", "integrations"]));
    expect(pages.some((page) => page.id === "mcp")).toBe(false);
    expect(settingsPageForSectionIn(pages, "general").id).toBe("general");
  });

  it("keeps a page's remaining tabs when only some are hidden", () => {
    const pages = settingsPagesWithoutSections(new Set(["quota"]));
    const usage = pages.find((page) => page.id === "usage");
    expect(usage?.tabs.map((tab) => tab.section)).toEqual(["usage"]);
    expect(settingsPageForSectionIn(pages, "usage").id).toBe("usage");
    // The hidden tab is not a landing place; the route sends it to General.
    expect(settingsPageForSectionIn(pages, "quota").id).toBe("general");
  });
});
