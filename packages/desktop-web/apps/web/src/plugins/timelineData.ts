// FILE: timelineData.ts
// Purpose: Pure parser for the bridge's `plugin.item` activity payload, shared by the work-log
//          derivation and the timeline card without importing React.
// Layer: Web plugin host
// Exports: PluginTimelineItemData, readPluginTimelineItem

export interface PluginTimelineItemData {
  readonly kind: string;
  readonly version: number;
  readonly data: unknown;
}

/** Reads the bridge's `plugin.item` activity payload; null for any other activity. */
export function readPluginTimelineItem(payload: unknown): PluginTimelineItemData | null {
  if (typeof payload !== "object" || payload === null) return null;
  const item = (payload as { pluginItem?: unknown }).pluginItem;
  if (typeof item !== "object" || item === null) return null;
  const record = item as Record<string, unknown>;
  if (typeof record.kind !== "string") return null;
  return {
    kind: record.kind,
    version: typeof record.version === "number" ? record.version : 1,
    data: record.data,
  };
}
