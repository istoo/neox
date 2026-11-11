// FILE: usePluginCommandActions.ts
// Purpose: Contributes manifest commands to the sidebar search palette (the app's Command Center).
// Layer: Web plugin host
// Exports: usePluginCommandActions, runDeclaredPluginAction

import { useMemo, type ComponentType } from "react";

import { toastManager } from "~/components/ui/toast";
import { t } from "~/i18n";
import type { SidebarSearchAction } from "~/components/SidebarSearchPalette.logic";

import { useRunningPlugins } from "./catalog";
import { buildPluginContributionIndex, runPluginAction } from "./contributions";
import { PluginGlyph } from "./PluginGlyph";
import { openPluginView } from "./viewStore";

const glyphCache = new Map<string, ComponentType<{ className?: string }>>();

function glyphFor(name: string | undefined): ComponentType<{ className?: string }> {
  const key = name ?? "__plugin__";
  const cached = glyphCache.get(key);
  if (cached) return cached;
  const Glyph = ({ className }: { className?: string }) => (
    <PluginGlyph name={name} className={className} />
  );
  glyphCache.set(key, Glyph);
  return Glyph;
}

/** Runs one declared action and surfaces failures as a toast instead of an unhandled rejection. */
export async function runDeclaredPluginAction(
  pluginId: string,
  action: Parameters<typeof runPluginAction>[1],
): Promise<void> {
  try {
    await runPluginAction(pluginId, action, (targetPluginId, viewId, params) =>
      openPluginView({ pluginId: targetPluginId, viewId, params }),
    );
  } catch (error) {
    toastManager.add({
      type: "error",
      title: t("common:pluginCommandFailed"),
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

export function usePluginCommandActions(): SidebarSearchAction[] {
  const plugins = useRunningPlugins();
  return useMemo(
    () =>
      buildPluginContributionIndex(plugins).commands.map((entry) => ({
        id: `plugin:${entry.pluginId}:${entry.contribution.id}`,
        label: entry.contribution.title,
        description: entry.pluginName,
        keywords: ["plugin", entry.pluginName, ...(entry.contribution.keywords ?? [])],
        metaLabel: entry.pluginName,
        icon: glyphFor(entry.contribution.icon),
        run: () => {
          void runDeclaredPluginAction(entry.pluginId, entry.contribution.action);
        },
      })),
    [plugins],
  );
}
