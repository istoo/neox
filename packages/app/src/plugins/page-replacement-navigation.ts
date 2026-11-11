import { useMemo } from "react";
import type { PluginReplaceablePage } from "@neolix/plugin/client";
import { useInstalledPlugins } from "./registry";
import {
  normalizePluginReplacePage,
  resolveSettingsSectionReplacements,
  type SettingsSectionReplacement,
} from "./page-replacement";
import type { HostSectionSlug } from "@/utils/host-routes";

export interface PluginPageTarget {
  serverId: string;
  pluginId: string;
  screenId: string;
}

/**
 * The screen a plugin's sidebar item opens for a replaced page, or null when no plugin replaces it.
 * `screen` on the item wins; otherwise the plugin's first screen, which is the common case for a
 * plugin that is one page.
 */
export function useReplacedPageTarget(page: PluginReplaceablePage): PluginPageTarget | null {
  const plugins = useInstalledPlugins();
  return useMemo(() => {
    for (const plugin of plugins) {
      for (const section of ["header", "footer"] as const) {
        for (const item of plugin.sidebarItems[section]) {
          if (normalizePluginReplacePage(item.replaces) !== page) continue;
          const screenId = item.screen ?? plugin.surfaces[0]?.id;
          if (screenId) {
            return { serverId: plugin.serverId, pluginId: plugin.id, screenId };
          }
        }
      }
    }
    return null;
  }, [page, plugins]);
}

/** The plugin settings screen replacing a built-in settings section on this host, or null. */
export function useSettingsSectionReplacement(
  serverId: string,
  section: HostSectionSlug,
): SettingsSectionReplacement | null {
  const plugins = useInstalledPlugins();
  return useMemo(
    () => resolveSettingsSectionReplacements(plugins, serverId).get(section) ?? null,
    [plugins, section, serverId],
  );
}
