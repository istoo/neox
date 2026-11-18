import type { NeolixPluginPanel } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { PluginPanelEntry } from "./contributions";
import {
  PLUGIN_PANEL_DEFAULT_HEIGHT,
  PLUGIN_PANEL_MAX_HEIGHT,
  PLUGIN_PANEL_MIN_HEIGHT,
  slotPanelEntries,
  slotPanelHeight,
  slotPanelParams,
} from "./pluginSlotPanels.logic";

function entry(slot: NeolixPluginPanel["slot"], id: string, height?: number): PluginPanelEntry {
  return {
    pluginId: "acme",
    pluginName: "Acme",
    contribution: {
      id,
      slot,
      title: id,
      view: id,
      ...(height === undefined ? {} : { height }),
    },
  };
}

describe("plugin slot panels", () => {
  it("keeps only the entries of the requested slot", () => {
    const entries = [entry("usage", "a"), entry("agents", "b"), entry("usage", "c")];
    expect(slotPanelEntries(entries, "usage").map((item) => item.contribution.id)).toEqual([
      "a",
      "c",
    ]);
    expect(slotPanelEntries(entries, "provider")).toEqual([]);
  });

  it("tells only a provider panel where it is", () => {
    const provider = { id: "acme-gateway", name: "Acme Gateway" };
    expect(slotPanelParams("provider", provider)).toEqual({
      providerId: "acme-gateway",
      providerName: "Acme Gateway",
    });
    expect(slotPanelParams("provider", undefined)).toBeUndefined();
    expect(slotPanelParams("usage", provider)).toBeUndefined();
  });

  it("uses the declared height within the frame's range", () => {
    expect(slotPanelHeight(entry("usage", "a").contribution)).toBe(PLUGIN_PANEL_DEFAULT_HEIGHT);
    expect(slotPanelHeight(entry("usage", "a", 320).contribution)).toBe(320);
    expect(slotPanelHeight(entry("usage", "a", 1).contribution)).toBe(PLUGIN_PANEL_MIN_HEIGHT);
    expect(slotPanelHeight(entry("usage", "a", 9000).contribution)).toBe(PLUGIN_PANEL_MAX_HEIGHT);
  });
});
