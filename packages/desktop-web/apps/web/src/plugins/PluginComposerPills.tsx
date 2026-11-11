// FILE: PluginComposerPills.tsx
// Purpose: Renders manifest composer pills in the composer's trailing control cluster.
// Layer: Web plugin host
// Exports: PluginComposerPills

import { useMemo } from "react";

import { Button } from "~/components/ui/button";

import { useRunningPlugins } from "./catalog";
import { buildPluginContributionIndex } from "./contributions";
import { PluginGlyph } from "./PluginGlyph";
import { runDeclaredPluginAction } from "./usePluginCommandActions";

export function PluginComposerPills({ compact }: { readonly compact?: boolean }) {
  const plugins = useRunningPlugins();
  const pills = useMemo(() => buildPluginContributionIndex(plugins).composerPills, [plugins]);
  if (pills.length === 0) return null;
  return (
    <>
      {pills.map((entry) => (
        <Button
          key={`${entry.pluginId}:${entry.contribution.id}`}
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0 whitespace-nowrap px-2 text-ui-sm font-normal"
          title={entry.contribution.title}
          aria-label={entry.contribution.title}
          onClick={() => {
            void runDeclaredPluginAction(entry.pluginId, entry.contribution.action);
          }}
        >
          <PluginGlyph name={entry.contribution.icon} />
          <span className={compact ? "sr-only" : "sr-only sm:not-sr-only"}>
            {entry.contribution.title}
          </span>
        </Button>
      ))}
    </>
  );
}
