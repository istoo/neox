import { describe, expect, it } from "vitest";

import type { PluginSidebarEntry } from "~/plugins/contributions";

import {
  canMoveSidebarNavItem,
  isSidebarNavItemPinned,
  normalizeSidebarNavPreferences,
  pluginSidebarNavKey,
  resolveSidebarNavItems,
  setSidebarNavItemVisible,
  moveSidebarNavItem,
} from "./sidebarNav.model";

function pluginEntry(id: string, section: "header" | "footer" = "header"): PluginSidebarEntry {
  return {
    pluginId: "example",
    pluginName: "Example",
    contribution: {
      id,
      title: `Plugin ${id}`,
      view: `view-${id}`,
      section,
    },
  } as PluginSidebarEntry;
}

describe("resolveSidebarNavItems", () => {
  it("uses the built-in order before any saved preference", () => {
    const items = resolveSidebarNavItems({
      section: "header",
      pluginEntries: [pluginEntry("a")],
      preferences: [],
    });
    expect(items.map((item) => item.key)).toEqual([
      "new-thread",
      "history",
      pluginSidebarNavKey(pluginEntry("a")),
    ]);
  });

  it("places saved keys first and appends entries the list predates", () => {
    const entry = pluginEntry("a");
    const items = resolveSidebarNavItems({
      section: "header",
      pluginEntries: [entry],
      preferences: [{ key: pluginSidebarNavKey(entry), visible: false }],
    });
    expect(items.map((item) => item.key)).toEqual([
      pluginSidebarNavKey(entry),
      "new-thread",
      "history",
    ]);
    expect(items[0]?.visible).toBe(false);
  });

  it("keeps a footer plugin entry out of the header section", () => {
    const items = resolveSidebarNavItems({
      section: "header",
      pluginEntries: [pluginEntry("a", "footer")],
      preferences: [],
    });
    expect(items.map((item) => item.key)).toEqual(["new-thread", "history"]);
  });
});

describe("setSidebarNavItemVisible", () => {
  it("writes the new visibility without disturbing the order", () => {
    const items = resolveSidebarNavItems({
      section: "header",
      pluginEntries: [],
      preferences: [],
    });
    expect(
      setSidebarNavItemVisible({
        items,
        key: "history",
        visible: false,
        previous: [],
      }),
    ).toEqual([
      { key: "new-thread", visible: true },
      { key: "history", visible: false },
    ]);
  });

  it("keeps an unavailable plugin preference after the resolved rows", () => {
    const items = resolveSidebarNavItems({
      section: "header",
      pluginEntries: [],
      preferences: [{ key: "plugin:gone:view", visible: false }],
    });
    expect(
      setSidebarNavItemVisible({
        items,
        key: "history",
        visible: false,
        previous: [{ key: "plugin:gone:view", visible: false }],
      }),
    ).toEqual([
      { key: "plugin:gone:view", visible: false },
      { key: "new-thread", visible: true },
      { key: "history", visible: false },
    ]);
  });
});

describe("canMoveSidebarNavItem", () => {
  it("refuses a move whose only neighbour is a pinned row", () => {
    const items = resolveSidebarNavItems({
      section: "header",
      pluginEntries: [],
      preferences: [],
    });
    expect(items.map((item) => item.key)).toEqual(["new-thread", "history"]);

    expect(canMoveSidebarNavItem({ items, key: "history", direction: "up" })).toBe(false);
    expect(canMoveSidebarNavItem({ items, key: "history", direction: "down" })).toBe(false);
    expect(canMoveSidebarNavItem({ items, key: "new-thread", direction: "down" })).toBe(false);
  });

  it("allows a row with a movable neighbour", () => {
    const entry = pluginEntry("a");
    const items = resolveSidebarNavItems({
      section: "header",
      pluginEntries: [entry],
      preferences: [],
    });
    const pluginKey = pluginSidebarNavKey(entry);

    expect(canMoveSidebarNavItem({ items, key: pluginKey, direction: "up" })).toBe(true);
    expect(canMoveSidebarNavItem({ items, key: pluginKey, direction: "down" })).toBe(false);
  });
});

describe("moveSidebarNavItem", () => {
  const entries = [pluginEntry("a"), pluginEntry("b")];
  const items = resolveSidebarNavItems({
    section: "header",
    pluginEntries: entries,
    preferences: [],
  });

  it("moves one row across its movable neighbours", () => {
    const key = pluginSidebarNavKey(entries[1]!);
    expect(
      moveSidebarNavItem({ items, key, direction: "up", previous: [] }).map((row) => row.key),
    ).toEqual(["new-thread", "history", key, pluginSidebarNavKey(entries[0]!)]);
  });

  it("refuses to move a pinned row", () => {
    expect(isSidebarNavItemPinned("new-thread")).toBe(true);
    expect(isSidebarNavItemPinned("history")).toBe(false);
    expect(
      moveSidebarNavItem({
        items,
        key: "new-thread",
        direction: "down",
        previous: [],
      }).map((row) => row.key),
    ).toEqual(items.map((item) => item.key));
  });
});

describe("normalizeSidebarNavPreferences", () => {
  it("drops duplicates and keeps unknown keys", () => {
    expect(
      normalizeSidebarNavPreferences([
        { key: "history", visible: false },
        { key: "history", visible: true },
        { key: "plugin:gone:view", visible: true },
      ]),
    ).toEqual([
      { key: "history", visible: false },
      { key: "plugin:gone:view", visible: true },
    ]);
  });
});
