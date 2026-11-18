// FILE: PluginSlotPanels.tsx
// Purpose: Render a plugin's declarative panels inside one of the host's built-in pages. The
//          body is the same sandboxed web view a sidebar page uses; a provider-editor panel also
//          receives the provider's id and name as its frame context.
// Layer: Web plugin host
// Exports: PluginSlotPanels

import type { NeolixPluginPanelSlot } from "@synara/contracts";
import { useMemo } from "react";

import { cn } from "~/lib/utils";

import { useRunningPlugins } from "./catalog";
import { buildPluginContributionIndex } from "./contributions";
import { PluginViewHost } from "./PluginViewHost";
import { slotPanelEntries, slotPanelHeight, slotPanelParams } from "./pluginSlotPanels.logic";

export function PluginSlotPanels(props: {
  readonly slot: NeolixPluginPanelSlot;
  /** The provider whose editor hosts a `provider` panel. */
  readonly provider?: { readonly id: string; readonly name: string } | undefined;
  readonly className?: string | undefined;
}) {
  const plugins = useRunningPlugins();
  const entries = useMemo(
    () => slotPanelEntries(buildPluginContributionIndex(plugins).panels, props.slot),
    [plugins, props.slot],
  );
  if (entries.length === 0) return null;
  const params = slotPanelParams(props.slot, props.provider);

  return (
    <div className={cn("space-y-3", props.className)}>
      {entries.map((entry) => {
        const plugin = plugins.find((candidate) => candidate.id === entry.pluginId);
        if (!plugin) return null;
        const title = entry.contribution.title?.trim() || entry.pluginName;
        return (
          <div key={`${entry.pluginId}:${entry.contribution.id}`} className="space-y-1">
            <div className="text-ui-sm font-medium text-foreground">{title}</div>
            <PluginViewHost
              plugin={plugin}
              viewId={entry.contribution.view}
              params={params}
              minHeight={slotPanelHeight(entry.contribution)}
            />
          </div>
        );
      })}
    </div>
  );
}
