// FILE: pluginPanels.logic.ts
// Purpose: Pure helpers for declarative workspace/file panel contributions: selector keys, file
//          matching, and the association lookup shared by the file pane and Settings > Files.
// Layer: Web plugin host
// Exports: selector key helpers, file matcher, and panel resolution

import type { NeolixPluginFilePanel } from "@synara/contracts";

import type { PluginFilePanelEntry } from "./contributions";

export function pluginPanelKey(pluginId: string, panelId: string): string {
  return `plugin:${pluginId}:${panelId}`;
}

export interface ParsedPluginPanelKey {
  readonly pluginId: string;
  readonly panelId: string;
}

export function parsePluginPanelKey(key: string): ParsedPluginPanelKey | null {
  if (!key.startsWith("plugin:")) return null;
  const rest = key.slice("plugin:".length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) return null;
  return { pluginId: rest.slice(0, separator), panelId: rest.slice(separator + 1) };
}

export function fileBasename(path: string): string {
  return path.trim().split(/[\\/]/).pop() ?? "";
}

export function fileExtension(path: string): string {
  const name = fileBasename(path);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** `ext:<lowercase extension>` or `name:<exact basename>`, matching the native host's keys. */
export function filePanelSelectorKeys(panel: NeolixPluginFilePanel): readonly string[] {
  return [
    ...panel.files.extensions.map((extension) => `ext:${extension.toLowerCase()}`),
    ...(panel.files.filenames ?? []).map((filename) => `name:${filename}`),
  ];
}

export function filePanelMatchesPath(panel: NeolixPluginFilePanel, path: string): boolean {
  const name = fileBasename(path);
  if (panel.files.filenames?.includes(name)) return true;
  const extension = fileExtension(path);
  return panel.files.extensions.some((entry) => entry.toLowerCase() === extension);
}

/** The panel a path resolves to: a remembered association wins, otherwise the first claim. */
export function resolveFilePanelEntry(input: {
  readonly path: string;
  readonly panels: readonly PluginFilePanelEntry[];
  readonly associations: Readonly<Record<string, string>>;
}): PluginFilePanelEntry | null {
  const matching = input.panels.filter((entry) =>
    filePanelMatchesPath(entry.contribution, input.path),
  );
  if (matching.length === 0) return null;
  const name = fileBasename(input.path);
  const matchedFilename = matching.some((entry) =>
    entry.contribution.files.filenames?.includes(name),
  );
  const selectorKey = matchedFilename ? `name:${name}` : `ext:${fileExtension(input.path)}`;
  const remembered = input.associations[selectorKey];
  if (remembered === "builtin") return null;
  const associated = matching.find(
    (entry) => pluginPanelKey(entry.pluginId, entry.contribution.id) === remembered,
  );
  return associated ?? matching[0] ?? null;
}

/** Selector keys that appear in at least one plugin file panel, for the settings rows. */
export function filePanelSettingsRows(panels: readonly PluginFilePanelEntry[]): {
  readonly selectorKey: string;
  readonly candidates: readonly PluginFilePanelEntry[];
}[] {
  const keys = new Set<string>();
  for (const entry of panels) {
    for (const key of filePanelSelectorKeys(entry.contribution)) keys.add(key);
  }
  return [...keys]
    .toSorted((left, right) => {
      const leftKind = left.startsWith("ext:") ? 0 : 1;
      const rightKind = right.startsWith("ext:") ? 0 : 1;
      if (leftKind !== rightKind) return leftKind - rightKind;
      return left.localeCompare(right);
    })
    .map((selectorKey) => ({
      selectorKey,
      candidates: panels.filter((entry) =>
        filePanelSelectorKeys(entry.contribution).includes(selectorKey),
      ),
    }));
}

export function filePanelSelectorLabel(selectorKey: string): string {
  if (selectorKey.startsWith("ext:")) return `.${selectorKey.slice("ext:".length)}`;
  if (selectorKey.startsWith("name:")) return selectorKey.slice("name:".length);
  return selectorKey;
}
