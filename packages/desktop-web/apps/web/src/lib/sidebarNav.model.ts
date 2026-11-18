// FILE: sidebarNav.model.ts
// Purpose: The sidebar's navigation entries in display order: which built-in
//   rows and plugin entries show, and where. Mirrors the native app's
//   sidebar-nav model, over the rows this shell actually renders.
// Layer: Web sidebar logic

import type { PluginSidebarEntry } from "~/plugins/contributions";

export type SidebarNavSection = "header" | "footer";

/**
 * Each section's built-in items in their default order. The footer's fixed
 * bottom line (Help, Settings) is not part of this model.
 */
export const BUILTIN_SIDEBAR_NAV_IDS = {
  header: ["new-thread", "history"],
  footer: ["usage"],
} as const satisfies Record<SidebarNavSection, readonly string[]>;

export type BuiltinSidebarNavId<Section extends SidebarNavSection = SidebarNavSection> =
  (typeof BUILTIN_SIDEBAR_NAV_IDS)[Section][number];

/** Persisted shape. Array order is the display order. */
export interface SidebarNavPreference {
  key: string;
  visible: boolean;
}

export interface BuiltinSidebarNavItem<Section extends SidebarNavSection = SidebarNavSection> {
  kind: "builtin";
  key: BuiltinSidebarNavId<Section>;
  id: BuiltinSidebarNavId<Section>;
  visible: boolean;
}

export interface PluginSidebarNavItem {
  kind: "plugin";
  key: string;
  entry: PluginSidebarEntry;
  visible: boolean;
}

export type SidebarNavItem<Section extends SidebarNavSection = SidebarNavSection> =
  | BuiltinSidebarNavItem<Section>
  | PluginSidebarNavItem;

const BUILTIN_LABEL_KEYS: Record<string, string> = {
  "new-thread": "chat:sections_newThread",
  history: "workspace:history",
  usage: "gateway:usage",
};

export function builtinSidebarNavLabelKey(id: string): string {
  return BUILTIN_LABEL_KEYS[id] ?? id;
}

/**
 * Rows the sidebar always renders first and whose saved position cannot be
 * changed. Usage keeps its fixed place above Help and Settings.
 */
const PINNED_SIDEBAR_NAV_KEYS: ReadonlySet<string> = new Set(["new-thread", "usage"]);

export function isSidebarNavItemPinned(key: string): boolean {
  return PINNED_SIDEBAR_NAV_KEYS.has(key);
}

export function pluginSidebarNavKey(entry: Pick<PluginSidebarEntry, "pluginId" | "contribution">) {
  return `plugin:${entry.pluginId}:${entry.contribution.id}`;
}

function isBuiltinSidebarNavId<Section extends SidebarNavSection>(
  section: Section,
  key: string,
): key is BuiltinSidebarNavId<Section> {
  const ids: readonly string[] = BUILTIN_SIDEBAR_NAV_IDS[section];
  return ids.includes(key);
}

/** The plugin entries one section shows, in their manifest order. */
export function pluginEntriesForSection(
  entries: readonly PluginSidebarEntry[],
  section: SidebarNavSection,
): PluginSidebarEntry[] {
  return entries.filter((entry) => (entry.contribution.section ?? "header") === section);
}

/**
 * Saved preferences first, then built-ins this build adds, then plugin items
 * that are connected now. Entries for unavailable plugin keys are preserved by
 * `toPreferences` so a plugin disconnect never erases the user's edit.
 */
export function resolveSidebarNavItems<Section extends SidebarNavSection>(input: {
  section: Section;
  pluginEntries: readonly PluginSidebarEntry[];
  preferences: readonly SidebarNavPreference[];
}): SidebarNavItem<Section>[] {
  const builtinIds: readonly BuiltinSidebarNavId<Section>[] =
    BUILTIN_SIDEBAR_NAV_IDS[input.section];
  const entriesByKey = new Map(
    pluginEntriesForSection(input.pluginEntries, input.section).map(
      (entry) => [pluginSidebarNavKey(entry), entry] as const,
    ),
  );
  const items: SidebarNavItem<Section>[] = [];
  const placed = new Set<string>();

  for (const preference of input.preferences) {
    if (placed.has(preference.key)) continue;
    const entry = entriesByKey.get(preference.key);
    if (entry) {
      placed.add(preference.key);
      items.push({ kind: "plugin", key: preference.key, entry, visible: preference.visible });
    } else if (isBuiltinSidebarNavId(input.section, preference.key)) {
      placed.add(preference.key);
      items.push({
        kind: "builtin",
        key: preference.key,
        id: preference.key,
        visible: preference.visible,
      });
    }
  }

  for (const id of builtinIds) {
    if (placed.has(id)) continue;
    items.push({ kind: "builtin", key: id, id, visible: true });
  }
  for (const [key, entry] of entriesByKey) {
    if (placed.has(key)) continue;
    items.push({ kind: "plugin", key, entry, visible: true });
  }
  return items;
}

/**
 * Entries for keys that are not currently available (a plugin disconnected
 * right now) keep their saved position, so an unrelated edit does not erase
 * them; items this pass adds are appended.
 */
function toPreferences(
  items: readonly SidebarNavItem[],
  previous: readonly SidebarNavPreference[],
): SidebarNavPreference[] {
  const remaining = items.map(({ key, visible }) => ({ key, visible }));
  const availableKeys = new Set(remaining.map((preference) => preference.key));
  const preferences: SidebarNavPreference[] = [];
  const seenPrevious = new Set<string>();

  for (const preference of previous) {
    if (seenPrevious.has(preference.key)) continue;
    seenPrevious.add(preference.key);
    if (availableKeys.has(preference.key)) {
      const next = remaining.shift();
      if (next) preferences.push(next);
      continue;
    }
    preferences.push({ key: preference.key, visible: preference.visible });
  }
  preferences.push(...remaining);
  return preferences;
}

export function setSidebarNavItemVisible(input: {
  items: readonly SidebarNavItem[];
  key: string;
  visible: boolean;
  previous: readonly SidebarNavPreference[];
}): SidebarNavPreference[] {
  const items = input.items.map((item) =>
    item.key === input.key ? { ...item, visible: input.visible } : item,
  );
  return toPreferences(items, input.previous);
}

/**
 * Whether the row can swap places with another movable row in that direction.
 * Pinned rows never move, and a pinned neighbour does not count as a target:
 * with only New thread above it, History has nowhere to go.
 */
export function canMoveSidebarNavItem(input: {
  items: readonly SidebarNavItem[];
  key: string;
  direction: "up" | "down";
}): boolean {
  const from = input.items.findIndex((item) => item.key === input.key);
  if (from === -1 || isSidebarNavItemPinned(input.key)) return false;
  // Movable neighbours skip pinned items, so one step still moves one visual row.
  const movable = input.items
    .map((_item, index) => index)
    .filter((index) => !isSidebarNavItemPinned(input.items[index]!.key));
  const position = movable.indexOf(from);
  const target = input.direction === "up" ? position - 1 : position + 1;
  return position !== -1 && target >= 0 && target < movable.length;
}

export function moveSidebarNavItem(input: {
  items: readonly SidebarNavItem[];
  key: string;
  direction: "up" | "down";
  previous: readonly SidebarNavPreference[];
}): SidebarNavPreference[] {
  if (!canMoveSidebarNavItem(input)) {
    return toPreferences(input.items, input.previous);
  }
  const from = input.items.findIndex((item) => item.key === input.key);
  // Movable neighbours skip pinned items, so one step still moves one visual row.
  const movable = input.items
    .map((_item, index) => index)
    .filter((index) => !isSidebarNavItemPinned(input.items[index]!.key));
  const position = movable.indexOf(from);
  const target = input.direction === "up" ? position - 1 : position + 1;
  const items = [...input.items];
  const [moved] = items.splice(from, 1);
  items.splice(movable[target]!, 0, moved!);
  return toPreferences(items, input.previous);
}

/** Drops malformed or duplicate saved rows; unknown keys stay (a plugin may return). */
export function normalizeSidebarNavPreferences(
  preferences: readonly SidebarNavPreference[],
): SidebarNavPreference[] {
  const seen = new Set<string>();
  return preferences.flatMap((preference) => {
    if (typeof preference.key !== "string" || preference.key.length === 0) return [];
    if (seen.has(preference.key)) return [];
    seen.add(preference.key);
    return [{ key: preference.key, visible: preference.visible !== false }];
  });
}
