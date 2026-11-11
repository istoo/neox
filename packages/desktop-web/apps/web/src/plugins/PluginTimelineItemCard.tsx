// FILE: PluginTimelineItemCard.tsx
// Purpose: Renders an activity emitted by a plugin timeline item. Declarations without a view use
//          an activity card; declarations with a view run in the sandboxed view host with the item
//          data in its context.
// Layer: Web plugin host
// Exports: PluginTimelineItemCard; re-exports the parser from timelineData

import { useMemo } from "react";

import { cn } from "~/lib/utils";

import { useRunningPlugins } from "./catalog";
import { buildPluginContributionIndex } from "./contributions";
import { PluginViewHost } from "./PluginViewHost";
import type { PluginTimelineItemData } from "./timelineData";

export { readPluginTimelineItem, type PluginTimelineItemData } from "./timelineData";

const TONE_CLASS: Record<string, string> = {
  info: "border-border/60 bg-muted/30",
  success: "border-success/40 bg-success/10",
  warning: "border-warning/40 bg-warning/10",
  danger: "border-destructive/40 bg-destructive/10",
};

export function PluginTimelineItemCard({
  item,
  className,
}: {
  readonly item: PluginTimelineItemData;
  readonly className?: string;
}) {
  const plugins = useRunningPlugins();
  const entry = useMemo(
    () =>
      buildPluginContributionIndex(plugins).timelineItems.find(
        (candidate) =>
          candidate.contribution.kind === item.kind &&
          candidate.contribution.version === item.version,
      ),
    [item.kind, item.version, plugins],
  );
  if (!entry) return null;
  if (entry.contribution.view) {
    const plugin = plugins.find((candidate) => candidate.id === entry.pluginId);
    if (!plugin) return null;
    return (
      <PluginViewHost
        plugin={plugin}
        viewId={entry.contribution.view}
        data={item.data}
        minHeight={200}
        className={className}
      />
    );
  }
  return (
    <div
      className={cn(
        "rounded-xl border px-3 py-2 text-ui-sm",
        TONE_CLASS[entry.contribution.tone ?? "info"],
        className,
      )}
    >
      <div className="font-medium text-foreground">{entry.contribution.title}</div>
      {item.data === undefined || item.data === null ? null : (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-ui-meta text-muted-foreground">
          {JSON.stringify(item.data, null, 2)}
        </pre>
      )}
    </div>
  );
}
