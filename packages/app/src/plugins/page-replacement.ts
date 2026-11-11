import type { PluginReplaceablePage } from "@neolix/plugin/client";
import type { InstalledPlugin } from "./types";
import type { PluginSidebarGroup } from "./sidebar-groups";
import type { SidebarNavItem } from "@/sidebar-nav/model";
import type { HostSectionSlug } from "@/utils/host-routes";

const ALIASES: Record<string, PluginReplaceablePage> = {
  history: "sessions",
  "gateway-routing": "routing",
};

const REPLACEABLE_PAGES: ReadonlySet<string> = new Set<PluginReplaceablePage>([
  "sessions",
  "library",
  "routing",
  "usage",
]);

/**
 * The Neolix page a plugin's `replaces` names, or null when it names nothing replaceable. Accepts
 * myna's page names and Neolix's aliases (`history`, `gateway-routing`).
 */
export function normalizePluginReplacePage(value: unknown): PluginReplaceablePage | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (REPLACEABLE_PAGES.has(trimmed)) return trimmed as PluginReplaceablePage;
  return ALIASES[trimmed] ?? null;
}

export interface PluginSidebarReplaceTarget {
  section: "header" | "footer";
  /** The built-in sidebar item the plugin takes the place of. */
  id: "history" | "usage";
}

const SIDEBAR_TARGETS: Partial<Record<PluginReplaceablePage, PluginSidebarReplaceTarget>> = {
  sessions: { section: "header", id: "history" },
  usage: { section: "footer", id: "usage" },
};

/** The sidebar row a page replaces, or null when the page is only a settings section. */
export function pluginReplaceSidebarTarget(
  page: PluginReplaceablePage,
): PluginSidebarReplaceTarget | null {
  return SIDEBAR_TARGETS[page] ?? null;
}

const SETTINGS_SECTIONS: Record<PluginReplaceablePage, HostSectionSlug> = {
  sessions: "sessions",
  library: "library",
  routing: "gateway-routing",
  usage: "usage",
};

/** The settings section a page replaces. */
export function pluginReplaceSettingsSection(page: PluginReplaceablePage): HostSectionSlug {
  return SETTINGS_SECTIONS[page];
}

export interface SettingsSectionReplacement {
  installation: InstalledPlugin;
  screen: InstalledPlugin["settingsScreens"][number];
}

/**
 * The plugin settings screen replacing each built-in settings section on a host. The first
 * declaration wins, so two installed plugins cannot both claim one section. Nothing is persisted:
 * removing the plugin drops its screen and the built-in section shows again.
 */
export function resolveSettingsSectionReplacements(
  installations: readonly InstalledPlugin[],
  serverId: string,
): Map<HostSectionSlug, SettingsSectionReplacement> {
  const replacements = new Map<HostSectionSlug, SettingsSectionReplacement>();
  for (const installation of installations) {
    if (installation.serverId !== serverId) continue;
    for (const screen of installation.settingsScreens) {
      const page = normalizePluginReplacePage(screen.replaces);
      if (!page) continue;
      const section = SETTINGS_SECTIONS[page];
      if (!replacements.has(section)) replacements.set(section, { installation, screen });
    }
  }
  return replacements;
}

/**
 * The plugin group replacing each built-in sidebar page. A page named by several groups keeps the
 * first, so one installed plugin never hides another's declaration. Removing the plugin drops its
 * group and the built-in shows again: nothing about the replacement is persisted.
 */
export function resolvePluginPageReplacements(
  groups: readonly PluginSidebarGroup[],
): Map<PluginReplaceablePage, string> {
  const replacements = new Map<PluginReplaceablePage, string>();
  for (const group of groups) {
    if (group.replaces && !replacements.has(group.replaces)) {
      replacements.set(group.replaces, group.key);
    }
  }
  return replacements;
}

/**
 * The sidebar's built-in pages hidden by a plugin, with each replacement group in its place.
 * `items` keeps the user's order; a replaced built-in keeps its slot but hides, and the plugin
 * group moves from wherever preferences put it to that slot, visible.
 */
export function applyPluginPageReplacements<Section extends "header" | "footer">(
  items: readonly SidebarNavItem<Section>[],
  replacements: ReadonlyMap<PluginReplaceablePage, string>,
): SidebarNavItem<Section>[] {
  if (replacements.size === 0) return [...items];
  const replacedKeys = new Set(replacements.values());
  const slots = new Map<string, number>();
  items.forEach((item, index) => {
    const page = item.kind === "builtin" ? sidebarPage(item.id) : null;
    if (page && replacements.has(page)) slots.set(page, index);
  });
  if (slots.size === 0) return [...items];

  const placed = new Map<number, SidebarNavItem<Section>>();
  for (const item of items) {
    if (item.kind !== "plugin" || !replacedKeys.has(item.key)) continue;
    const replacement = resolveReplacementSlot(item.group.replaces, slots);
    if (replacement !== undefined) placed.set(replacement, { ...item, visible: true });
  }
  if (placed.size === 0) return [...items];

  const next: SidebarNavItem<Section>[] = [];
  items.forEach((item, index) => {
    const page = item.kind === "builtin" ? sidebarPage(item.id) : null;
    const replaced = page !== null && replacements.has(page);
    const replacement = placed.get(index);
    if (replacement) next.push(replacement);
    // The built-in keeps its slot and its preference entry, hidden: a user turning the plugin off
    // again finds the page where it was.
    if (replaced) {
      next.push({ ...item, visible: false });
      return;
    }
    if (item.kind === "plugin" && replacedKeys.has(item.key)) return;
    next.push(item);
  });
  return next;
}

/** The page whose sidebar row is this built-in id, when a plugin can replace it. */
function sidebarPage(id: string): PluginReplaceablePage | null {
  for (const page of REPLACEABLE_PAGES) {
    if (SIDEBAR_TARGETS[page as PluginReplaceablePage]?.id === id) {
      return page as PluginReplaceablePage;
    }
  }
  return null;
}

function resolveReplacementSlot(
  page: PluginReplaceablePage | undefined,
  slots: ReadonlyMap<string, number>,
): number | undefined {
  return page ? slots.get(page) : undefined;
}
