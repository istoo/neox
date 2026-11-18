// FILE: pageReplacement.logic.ts
// Purpose: Resolve the built-in page a plugin sidebar entry takes over, and move that entry
//          into the built-in row's slot. Mirrors the native app's page-replacement semantics:
//          the built-in keeps its slot but hides, and removing the plugin brings it back.
// Layer: Web plugin host logic

import type { NeolixPluginReplaceablePage } from "@synara/contracts";

import {
  pluginSidebarNavKey,
  type SidebarNavItem,
  type SidebarNavSection,
} from "~/lib/sidebarNav.model";

import type { PluginSidebarEntry } from "./contributions";

export type PluginReplaceablePage = NeolixPluginReplaceablePage;

const REPLACEABLE_PAGES: ReadonlySet<string> = new Set<PluginReplaceablePage>([
  "sessions",
  "library",
  "routing",
  "usage",
]);

export interface PluginSidebarReplaceTarget {
  readonly section: SidebarNavSection;
  /** The built-in nav row the plugin takes the place of. */
  readonly id: "history" | "usage";
  readonly page: PluginReplaceablePage;
}

/**
 * Only `sessions` and `usage` have sidebar rows. `library` and `routing` were settings-section
 * replacements in the native app, and declarative desktop-web contributions have no settings
 * screen equivalent, so a sidebar entry cannot claim them.
 */
const SIDEBAR_TARGETS: readonly PluginSidebarReplaceTarget[] = [
  { page: "sessions", section: "header", id: "history" },
  { page: "usage", section: "footer", id: "usage" },
];

/** The replaceable page a contribution names, or null when it names nothing replaceable. */
export function normalizePluginReplaceablePage(value: unknown): PluginReplaceablePage | null {
  return typeof value === "string" && REPLACEABLE_PAGES.has(value)
    ? (value as PluginReplaceablePage)
    : null;
}

/** The sidebar row a page replaces, or null when it has no row. */
export function pluginSidebarReplaceTarget(
  page: PluginReplaceablePage,
): PluginSidebarReplaceTarget | null {
  return SIDEBAR_TARGETS.find((target) => target.page === page) ?? null;
}

function targetForSidebarId(id: string): PluginSidebarReplaceTarget | null {
  return SIDEBAR_TARGETS.find((target) => target.id === id) ?? null;
}

function sectionOf(entry: PluginSidebarEntry): SidebarNavSection {
  return entry.contribution.section ?? "header";
}

/**
 * The plugin entry replacing each sidebar page, first declaration wins so two installed plugins
 * cannot both claim one row. An item registered in the wrong section is ignored, matching the
 * native host.
 */
export function resolvePluginPageReplacements(
  entries: readonly PluginSidebarEntry[],
): Map<PluginReplaceablePage, PluginSidebarEntry> {
  const replacements = new Map<PluginReplaceablePage, PluginSidebarEntry>();
  for (const entry of entries) {
    const page = normalizePluginReplaceablePage(entry.contribution.replaces);
    if (!page) continue;
    const target = pluginSidebarReplaceTarget(page);
    if (!target || sectionOf(entry) !== target.section) continue;
    if (!replacements.has(page)) replacements.set(page, entry);
  }
  return replacements;
}

/** The entry that replaced a page, for route redirects; null when no entry claims it. */
export function replacedPluginPage(
  entries: readonly PluginSidebarEntry[],
  page: PluginReplaceablePage,
): PluginSidebarEntry | null {
  const target = pluginSidebarReplaceTarget(page);
  if (!target) return null;
  for (const entry of entries) {
    if (normalizePluginReplaceablePage(entry.contribution.replaces) !== page) continue;
    if (sectionOf(entry) !== target.section) continue;
    return entry;
  }
  return null;
}

/**
 * The sidebar section with the built-in row hidden and its replacer in the same slot. The
 * built-in keeps its position (and its preference entry) so deleting the plugin restores it.
 */
export function applyPluginSidebarReplacements<Section extends SidebarNavSection>(
  items: readonly SidebarNavItem<Section>[],
  replacements: ReadonlyMap<PluginReplaceablePage, PluginSidebarEntry>,
): SidebarNavItem<Section>[] {
  if (replacements.size === 0) return [...items];
  const replacedKeys = new Set(
    [...replacements.values()].map((entry) => pluginSidebarNavKey(entry)),
  );

  const slots = new Map<PluginReplaceablePage, number>();
  items.forEach((item, index) => {
    if (item.kind !== "builtin") return;
    const target = targetForSidebarId(item.id);
    if (target && replacements.has(target.page)) slots.set(target.page, index);
  });
  if (slots.size === 0) return [...items];

  const placed = new Map<number, SidebarNavItem<Section>>();
  for (const item of items) {
    if (item.kind !== "plugin" || !replacedKeys.has(item.key)) continue;
    const page = normalizePluginReplaceablePage(item.entry.contribution.replaces);
    if (!page) continue;
    const slot = slots.get(page);
    if (slot !== undefined) placed.set(slot, { ...item, visible: true });
  }
  if (placed.size === 0) return [...items];

  const next: SidebarNavItem<Section>[] = [];
  items.forEach((item, index) => {
    const target = item.kind === "builtin" ? targetForSidebarId(item.id) : null;
    const replacement = placed.get(index);
    if (replacement) next.push(replacement);
    if (target && replacements.has(target.page)) {
      next.push({ ...item, visible: false });
      return;
    }
    if (item.kind === "plugin" && replacedKeys.has(item.key)) return;
    next.push(item);
  });
  return next;
}
