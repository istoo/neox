import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "./types";
import type { PluginSidebarGroup } from "./sidebar-groups";
import {
  applyPluginPageReplacements,
  normalizePluginReplacePage,
  pluginReplaceSettingsSection,
  pluginReplaceSidebarTarget,
  resolvePluginPageReplacements,
  resolveSettingsSectionReplacements,
} from "./page-replacement";
import type { SidebarNavItem } from "@/sidebar-nav/model";

function group(key: string, replaces?: "sessions" | "usage"): PluginSidebarGroup {
  return {
    kind: "item",
    key,
    pluginId: key.split("/")[0] ?? key,
    contributionId: "main",
    title: key,
    ...(replaces ? { replaces } : {}),
    targets: [],
  };
}

function builtin(id: "history" | "usage"): SidebarNavItem<"header" | "footer"> {
  return { kind: "builtin", key: id, id, visible: true };
}

function plugin(
  groupItem: PluginSidebarGroup,
  visible = true,
): SidebarNavItem<"header" | "footer"> {
  return { kind: "plugin", key: groupItem.key, group: groupItem, visible };
}

function settingsScreen(
  id: string,
  replaces: "sessions" | "library" | "routing" | "usage",
): InstalledPlugin["settingsScreens"][number] {
  return {
    id,
    title: id,
    icon: "Settings",
    replaces,
    Component: () => null,
  } as InstalledPlugin["settingsScreens"][number];
}

function installation(
  id: string,
  screens: InstalledPlugin["settingsScreens"],
  serverId = "host-a",
): InstalledPlugin {
  return { id, serverId, settingsScreens: screens } as unknown as InstalledPlugin;
}

describe("normalizePluginReplacePage", () => {
  it("accepts myna's replaceable page names", () => {
    expect(normalizePluginReplacePage("sessions")).toBe("sessions");
    expect(normalizePluginReplacePage("library")).toBe("library");
    expect(normalizePluginReplacePage("routing")).toBe("routing");
    expect(normalizePluginReplacePage("usage")).toBe("usage");
  });

  it("accepts Neolix's aliases", () => {
    expect(normalizePluginReplacePage("history")).toBe("sessions");
    expect(normalizePluginReplacePage("gateway-routing")).toBe("routing");
  });

  it("drops names that replace nothing", () => {
    expect(normalizePluginReplacePage("plugins")).toBeNull();
    expect(normalizePluginReplacePage(undefined)).toBeNull();
  });
});

describe("replacement targets", () => {
  it("maps sidebar pages to their rows", () => {
    expect(pluginReplaceSidebarTarget("sessions")).toEqual({ section: "header", id: "history" });
    expect(pluginReplaceSidebarTarget("usage")).toEqual({ section: "footer", id: "usage" });
    expect(pluginReplaceSidebarTarget("library")).toBeNull();
    expect(pluginReplaceSidebarTarget("routing")).toBeNull();
  });

  it("maps pages to settings sections", () => {
    expect(pluginReplaceSettingsSection("sessions")).toBe("sessions");
    expect(pluginReplaceSettingsSection("library")).toBe("library");
    expect(pluginReplaceSettingsSection("routing")).toBe("gateway-routing");
    expect(pluginReplaceSettingsSection("usage")).toBe("usage");
  });
});

describe("resolveSettingsSectionReplacements", () => {
  it("finds the settings screen replacing a section on this host", () => {
    const notes = installation("notes", [settingsScreen("main", "sessions")]);
    const other = installation("other", [settingsScreen("main", "sessions")], "host-b");

    const replacements = resolveSettingsSectionReplacements([notes, other], "host-a");

    expect(replacements.get("sessions")?.installation.id).toBe("notes");
    expect(replacements.get("sessions")?.screen.id).toBe("main");
  });

  it("keeps the first plugin when two replace the same section", () => {
    const first = installation("first", [settingsScreen("main", "library")]);
    const second = installation("second", [settingsScreen("main", "library")]);

    const replacements = resolveSettingsSectionReplacements([first, second], "host-a");

    expect(replacements.get("library")?.installation.id).toBe("first");
  });
});

describe("resolvePluginPageReplacements", () => {
  it("keeps the first group when several replace one page", () => {
    const replacements = resolvePluginPageReplacements([
      group("first/main", "sessions"),
      group("second/main", "sessions"),
    ]);

    expect(replacements.get("sessions")).toBe("first/main");
  });
});

describe("applyPluginPageReplacements", () => {
  it("hides the built-in and shows the plugin in its slot", () => {
    const replacement = group("notes/main", "sessions");
    const items = [builtin("history"), builtin("usage"), plugin(replacement, false)];

    const next = applyPluginPageReplacements(items, resolvePluginPageReplacements([replacement]));

    expect(next.map((item) => item.key)).toEqual(["notes/main", "history", "usage"]);
    expect(next[0]?.visible).toBe(true);
    expect(next[1]?.visible).toBe(false);
  });

  it("keeps the user's order when the plugin item comes first", () => {
    const replacement = group("notes/main", "sessions");
    const items = [plugin(replacement), builtin("history")];

    const next = applyPluginPageReplacements(items, resolvePluginPageReplacements([replacement]));

    expect(next.map((item) => item.key)).toEqual(["notes/main", "history"]);
  });

  it("leaves the sidebar as it was once the plugin is gone", () => {
    const items = [builtin("history"), builtin("usage"), plugin(group("notes/main"))];

    const next = applyPluginPageReplacements(items, resolvePluginPageReplacements([]));

    expect(next).toEqual(items);
    expect(next[0]?.visible).toBe(true);
  });

  it("leaves a second replacer in its own place", () => {
    const winner = group("first/main", "sessions");
    const other = group("second/main", "sessions");
    const items = [builtin("history"), builtin("usage"), plugin(winner), plugin(other)];

    const next = applyPluginPageReplacements(items, resolvePluginPageReplacements([winner, other]));

    expect(next.map((item) => item.key)).toEqual(["first/main", "history", "usage", "second/main"]);
  });

  it("keeps the usage row's slot in the footer", () => {
    const replacement = group("notes/main", "usage");
    const items = [builtin("history"), builtin("usage"), plugin(replacement)];

    const next = applyPluginPageReplacements(items, resolvePluginPageReplacements([replacement]));

    expect(next.map((item) => item.key)).toEqual(["history", "notes/main", "usage"]);
    expect(next[2]?.visible).toBe(false);
  });
});
