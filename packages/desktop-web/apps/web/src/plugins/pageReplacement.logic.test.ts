import { describe, expect, it } from "vitest";

import type { PluginSidebarEntry } from "./contributions";
import {
  applyPluginSidebarReplacements,
  normalizePluginReplaceablePage,
  pluginSidebarReplaceTarget,
  replacedPluginPage,
  resolvePluginPageReplacements,
} from "./pageReplacement.logic";
import type { SidebarNavItem } from "~/lib/sidebarNav.model";

function entry(
  pluginId: string,
  options: {
    section?: "header" | "footer";
    replaces?: "sessions" | "library" | "routing" | "usage";
  } = {},
): PluginSidebarEntry {
  return {
    pluginId,
    pluginName: pluginId,
    contribution: {
      id: "main",
      title: pluginId,
      view: "main",
      section: options.section ?? "header",
      ...(options.replaces ? { replaces: options.replaces } : {}),
    },
  };
}

function builtin(id: "new-thread" | "history" | "usage"): SidebarNavItem<"header" | "footer"> {
  return { kind: "builtin", key: id, id, visible: true };
}

function plugin(item: PluginSidebarEntry, visible = true): SidebarNavItem<"header" | "footer"> {
  return {
    kind: "plugin",
    key: `plugin:${item.pluginId}:${item.contribution.id}`,
    entry: item,
    visible,
  };
}

describe("normalizePluginReplaceablePage", () => {
  it("accepts myna's replaceable page names", () => {
    expect(normalizePluginReplaceablePage("sessions")).toBe("sessions");
    expect(normalizePluginReplaceablePage("library")).toBe("library");
    expect(normalizePluginReplaceablePage("routing")).toBe("routing");
    expect(normalizePluginReplaceablePage("usage")).toBe("usage");
  });

  it("drops names that replace nothing", () => {
    expect(normalizePluginReplaceablePage("plugins")).toBeNull();
    expect(normalizePluginReplaceablePage(undefined)).toBeNull();
  });
});

describe("pluginSidebarReplaceTarget", () => {
  it("maps the pages with sidebar rows to their built-in rows", () => {
    expect(pluginSidebarReplaceTarget("sessions")).toMatchObject({
      section: "header",
      id: "history",
    });
    expect(pluginSidebarReplaceTarget("usage")).toMatchObject({ section: "footer", id: "usage" });
  });

  it("leaves the settings-only pages without a sidebar row", () => {
    expect(pluginSidebarReplaceTarget("library")).toBeNull();
    expect(pluginSidebarReplaceTarget("routing")).toBeNull();
  });
});

describe("resolvePluginPageReplacements", () => {
  it("keeps the first entry when several replace one page", () => {
    const replacements = resolvePluginPageReplacements([
      entry("first", { replaces: "sessions" }),
      entry("second", { replaces: "sessions" }),
    ]);

    expect(replacements.get("sessions")?.pluginId).toBe("first");
  });

  it("ignores an item registered in the wrong section", () => {
    const replacements = resolvePluginPageReplacements([
      entry("header-usage", { replaces: "usage" }),
      entry("footer-usage", { section: "footer", replaces: "usage" }),
    ]);

    expect(replacements.get("usage")?.pluginId).toBe("footer-usage");
  });
});

describe("replacedPluginPage", () => {
  it("returns the entry a redirect should open", () => {
    const notes = entry("notes", { replaces: "sessions" });

    expect(replacedPluginPage([notes], "sessions")).toBe(notes);
  });

  it("returns nothing for pages a sidebar entry cannot claim", () => {
    expect(
      replacedPluginPage([entry("notes"), entry("notes", { replaces: "library" })], "library"),
    ).toBeNull();
  });
});

describe("applyPluginSidebarReplacements", () => {
  it("hides the built-in row and shows the plugin in its slot", () => {
    const notes = entry("notes", { replaces: "sessions" });
    const items = [builtin("new-thread"), builtin("history"), plugin(notes, false)];

    const next = applyPluginSidebarReplacements(items, resolvePluginPageReplacements([notes]));

    expect(next.map((item) => item.key)).toEqual(["new-thread", "plugin:notes:main", "history"]);
    expect(next[1]?.visible).toBe(true);
    expect(next[2]?.visible).toBe(false);
  });

  it("replaces the footer usage row in place", () => {
    const notes = entry("notes", { section: "footer", replaces: "usage" });
    const items = [builtin("history"), builtin("usage"), plugin(notes)];

    const next = applyPluginSidebarReplacements(items, resolvePluginPageReplacements([notes]));

    expect(next.map((item) => item.key)).toEqual(["history", "plugin:notes:main", "usage"]);
    expect(next[2]?.visible).toBe(false);
  });

  it("leaves a second replacer in its own place", () => {
    const winner = entry("first", { replaces: "sessions" });
    const other = entry("second", { replaces: "sessions" });
    const items = [builtin("history"), builtin("usage"), plugin(winner), plugin(other)];

    const next = applyPluginSidebarReplacements(
      items,
      resolvePluginPageReplacements([winner, other]),
    );

    expect(next.map((item) => item.key)).toEqual([
      "plugin:first:main",
      "history",
      "usage",
      "plugin:second:main",
    ]);
  });

  it("leaves the sidebar untouched when no plugin replaces a page", () => {
    const items = [builtin("history"), builtin("usage"), plugin(entry("notes"))];

    const next = applyPluginSidebarReplacements(items, resolvePluginPageReplacements([]));

    expect(next).toEqual(items);
    expect(next).not.toBe(items);
  });

  it("does not mutate the resolved rows", () => {
    const notes = entry("notes", { replaces: "sessions" });
    const items = [builtin("history"), plugin(notes, false)];

    applyPluginSidebarReplacements(items, resolvePluginPageReplacements([notes]));

    expect(items.map((item) => item.visible)).toEqual([true, false]);
  });
});
