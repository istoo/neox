// FILE: useSidebarNavItems.ts
// Purpose: Resolve one sidebar section's entries against the saved order and
//          visibility, and expose the two writes the customization rows need.
// Layer: Web sidebar hook

import { useCallback, useMemo } from "react";

import { useAppSettings } from "~/appSettings";
import { useBuiltinFeatures } from "~/hooks/useBuiltinFeatures";
import { buildPluginContributionIndex } from "~/plugins/contributions";
import {
  applyPluginSidebarReplacements,
  resolvePluginPageReplacements,
} from "~/plugins/pageReplacement.logic";
import { useRunningPlugins } from "~/plugins/catalog";
import {
  moveSidebarNavItem,
  resolveSidebarNavItems,
  setSidebarNavItemVisible,
  type SidebarNavItem,
  type SidebarNavSection,
} from "~/lib/sidebarNav.model";

const PREFERENCE_FIELDS = {
  header: "sidebarNavItems",
  footer: "sidebarFooterItems",
} as const satisfies Record<SidebarNavSection, "sidebarNavItems" | "sidebarFooterItems">;

export interface SidebarNavItemsController<Section extends SidebarNavSection> {
  /** Every item in the section in display order, hidden ones included. */
  readonly items: SidebarNavItem<Section>[];
  setVisible: (key: string, visible: boolean) => void;
  move: (key: string, direction: "up" | "down") => void;
}

export function useSidebarNavItems<Section extends SidebarNavSection>(
  section: Section,
): SidebarNavItemsController<Section> {
  const plugins = useRunningPlugins();
  const { settings, updateSettings } = useAppSettings();
  const builtinFeatures = useBuiltinFeatures();
  const field = PREFERENCE_FIELDS[section];
  const preferences = settings[field];
  const pluginEntries = useMemo(
    () => buildPluginContributionIndex(plugins).sidebarItems,
    [plugins],
  );

  const resolvedItems = useMemo(
    () =>
      resolveSidebarNavItems({
        section,
        pluginEntries,
        preferences,
      }) as SidebarNavItem<Section>[],
    [pluginEntries, preferences, section],
  );

  const items = useMemo(() => {
    const resolved = applyPluginSidebarReplacements(
      resolvedItems,
      resolvePluginPageReplacements(pluginEntries),
    );
    return resolved
      .filter(
        (item) =>
          item.kind !== "builtin" || item.id !== "history" || builtinFeatures.isEnabled("sessions"),
      )
      .map((item) =>
        // Usage is owned by the Usage settings switch, not by a second copy.
        item.kind === "builtin" && item.id === "usage"
          ? {
              kind: "builtin" as const,
              key: item.key,
              id: item.id,
              visible: item.visible && settings.showRailUsage && builtinFeatures.isEnabled("usage"),
            }
          : item,
      );
  }, [builtinFeatures, pluginEntries, resolvedItems, settings.showRailUsage]);

  const setVisible = useCallback(
    (key: string, visible: boolean) => {
      if (key === "usage") {
        updateSettings({ showRailUsage: visible });
        return;
      }
      updateSettings({
        [field]: setSidebarNavItemVisible({
          items: resolvedItems,
          key,
          visible,
          previous: preferences,
        }),
      });
    },
    [field, preferences, resolvedItems, updateSettings],
  );

  const move = useCallback(
    (key: string, direction: "up" | "down") => {
      updateSettings({
        [field]: moveSidebarNavItem({
          items: resolvedItems,
          key,
          direction,
          previous: preferences,
        }),
      });
    },
    [field, preferences, resolvedItems, updateSettings],
  );

  return { items, setVisible, move };
}
