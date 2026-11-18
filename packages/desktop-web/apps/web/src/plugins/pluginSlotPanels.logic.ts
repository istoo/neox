// FILE: pluginSlotPanels.logic.ts
// Purpose: Pure helpers for panels a plugin puts inside a built-in page: slot filtering, the
//          provider context a provider-editor panel receives, and its initial height.
// Layer: Web plugin host
// Exports: slotPanelEntries, slotPanelParams, slotPanelHeight

import type { NeolixPluginPanel, NeolixPluginPanelSlot } from "@synara/contracts";

import type { PluginPanelEntry } from "./contributions";

export const PLUGIN_PANEL_DEFAULT_HEIGHT = 240;
export const PLUGIN_PANEL_MIN_HEIGHT = 160;
export const PLUGIN_PANEL_MAX_HEIGHT = 2400;

/** Panels that belong to one slot, in the index's stable plugin-then-id order. */
export function slotPanelEntries(
  entries: readonly PluginPanelEntry[],
  slot: NeolixPluginPanelSlot,
): readonly PluginPanelEntry[] {
  return entries.filter((entry) => entry.contribution.slot === slot);
}

/**
 * The params the view receives as its frame context. Only the provider slot has a target: myna
 * tells a provider-editor panel `{ provider: { id, name } }`, which the bridge builds from these
 * two params.
 */
export function slotPanelParams(
  slot: NeolixPluginPanelSlot,
  provider: { readonly id: string; readonly name: string } | undefined,
): Record<string, string> | undefined {
  if (slot !== "provider" || !provider) return undefined;
  return { providerId: provider.id, providerName: provider.name };
}

/** A declared height clamped to the frame's negotiable range, or the default. */
export function slotPanelHeight(panel: NeolixPluginPanel): number {
  const height = panel.height;
  if (height === undefined) return PLUGIN_PANEL_DEFAULT_HEIGHT;
  return Math.min(PLUGIN_PANEL_MAX_HEIGHT, Math.max(PLUGIN_PANEL_MIN_HEIGHT, Math.round(height)));
}
