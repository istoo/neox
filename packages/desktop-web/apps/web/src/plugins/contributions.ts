// FILE: contributions.ts
// Purpose: Flatten declarative manifest contributions into host-renderable entries and expose the
//          plugin RPC call every host surface uses.
// Layer: Web plugin host
// Exports: contribution index types, builders, view lookup, and the RPC bridge.

import type {
  NeolixPlugin,
  NeolixPluginAgentAction,
  NeolixPluginAttachmentSource,
  NeolixPluginCommand,
  NeolixPluginComposerPill,
  NeolixPluginContributions,
  NeolixPluginFilePanel,
  NeolixPluginPanel,
  NeolixPluginProviderAction,
  NeolixPluginProviderPanel,
  NeolixPluginSidebarItem,
  NeolixPluginSlashCommand,
  NeolixPluginTheme,
  NeolixPluginTimelineItem,
  NeolixPluginWebView,
  NeolixPluginWorkspacePanel,
  NeolixPluginsInvokeInput,
} from "@synara/contracts";

import { readNativeApi } from "~/nativeApi";

export interface PluginCommandEntry {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly contribution: NeolixPluginCommand;
}

export interface PluginSlashCommandEntry {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly contribution: NeolixPluginSlashCommand;
}

export interface PluginSidebarEntry {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly contribution: NeolixPluginSidebarItem;
}

export interface PluginPanelEntry {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly contribution: NeolixPluginPanel;
}

export interface PluginComposerPillEntry {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly contribution: NeolixPluginComposerPill;
}

export interface PluginAttachmentSourceEntry {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly contribution: NeolixPluginAttachmentSource;
}

export interface PluginThemeEntry {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly contribution: NeolixPluginTheme;
}

export interface PluginTimelineEntry {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly contribution: NeolixPluginTimelineItem;
}

export interface PluginWorkspacePanelEntry {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly contribution: NeolixPluginWorkspacePanel;
}

export interface PluginFilePanelEntry {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly contribution: NeolixPluginFilePanel;
}

export interface PluginProviderActionEntry {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly contribution: NeolixPluginProviderAction;
}

export interface PluginProviderPanelEntry {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly contribution: NeolixPluginProviderPanel;
}

export interface PluginAgentActionEntry {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly contribution: NeolixPluginAgentAction;
}

export interface PluginContributionIndex {
  readonly commands: readonly PluginCommandEntry[];
  readonly slashCommands: readonly PluginSlashCommandEntry[];
  readonly sidebarItems: readonly PluginSidebarEntry[];
  readonly panels: readonly PluginPanelEntry[];
  readonly composerPills: readonly PluginComposerPillEntry[];
  readonly attachmentSources: readonly PluginAttachmentSourceEntry[];
  readonly themes: readonly PluginThemeEntry[];
  readonly timelineItems: readonly PluginTimelineEntry[];
  readonly workspacePanels: readonly PluginWorkspacePanelEntry[];
  readonly filePanels: readonly PluginFilePanelEntry[];
  readonly providerActions: readonly PluginProviderActionEntry[];
  readonly providerPanels: readonly PluginProviderPanelEntry[];
  readonly agentActions: readonly PluginAgentActionEntry[];
}

const EMPTY_INDEX: PluginContributionIndex = {
  commands: [],
  slashCommands: [],
  sidebarItems: [],
  panels: [],
  composerPills: [],
  attachmentSources: [],
  themes: [],
  timelineItems: [],
  workspacePanels: [],
  filePanels: [],
  providerActions: [],
  providerPanels: [],
  agentActions: [],
};

function pluginLabel(plugin: NeolixPlugin): string {
  return plugin.name?.trim() || plugin.id;
}

function contributionsOf(plugin: NeolixPlugin): NeolixPluginContributions | undefined {
  return plugin.contributions;
}

/** Stable order: plugin ID, then the order field (sidebar only), then contribution ID. */
export function buildPluginContributionIndex(
  plugins: readonly NeolixPlugin[],
): PluginContributionIndex {
  const commands: PluginCommandEntry[] = [];
  const slashCommands: PluginSlashCommandEntry[] = [];
  const sidebarItems: PluginSidebarEntry[] = [];
  const panels: PluginPanelEntry[] = [];
  const composerPills: PluginComposerPillEntry[] = [];
  const attachmentSources: PluginAttachmentSourceEntry[] = [];
  const themes: PluginThemeEntry[] = [];
  const timelineItems: PluginTimelineEntry[] = [];
  const workspacePanels: PluginWorkspacePanelEntry[] = [];
  const filePanels: PluginFilePanelEntry[] = [];
  const providerActions: PluginProviderActionEntry[] = [];
  const providerPanels: PluginProviderPanelEntry[] = [];
  const agentActions: PluginAgentActionEntry[] = [];
  const sorted = [...plugins].toSorted((left, right) => left.id.localeCompare(right.id));
  for (const plugin of sorted) {
    const contributions = contributionsOf(plugin);
    if (!contributions) continue;
    const pluginName = pluginLabel(plugin);
    for (const contribution of contributions.commands ?? [])
      commands.push({ pluginId: plugin.id, pluginName, contribution });
    for (const contribution of contributions.slashCommands ?? [])
      slashCommands.push({ pluginId: plugin.id, pluginName, contribution });
    for (const contribution of contributions.sidebarItems ?? [])
      sidebarItems.push({ pluginId: plugin.id, pluginName, contribution });
    for (const contribution of contributions.panels ?? [])
      panels.push({ pluginId: plugin.id, pluginName, contribution });
    for (const contribution of contributions.composerPills ?? [])
      composerPills.push({ pluginId: plugin.id, pluginName, contribution });
    for (const contribution of contributions.attachmentSources ?? [])
      attachmentSources.push({ pluginId: plugin.id, pluginName, contribution });
    for (const contribution of contributions.themes ?? [])
      themes.push({ pluginId: plugin.id, pluginName, contribution });
    for (const contribution of contributions.timelineItems ?? [])
      timelineItems.push({ pluginId: plugin.id, pluginName, contribution });
    for (const contribution of contributions.workspacePanels ?? [])
      workspacePanels.push({ pluginId: plugin.id, pluginName, contribution });
    for (const contribution of contributions.filePanels ?? [])
      filePanels.push({ pluginId: plugin.id, pluginName, contribution });
    for (const contribution of contributions.providerActions ?? [])
      providerActions.push({ pluginId: plugin.id, pluginName, contribution });
    for (const contribution of contributions.providerPanels ?? [])
      providerPanels.push({ pluginId: plugin.id, pluginName, contribution });
    for (const contribution of contributions.agentActions ?? [])
      agentActions.push({ pluginId: plugin.id, pluginName, contribution });
  }
  sidebarItems.sort((left, right) => {
    const order = (left.contribution.order ?? 0) - (right.contribution.order ?? 0);
    if (order !== 0) return order;
    const byPlugin = left.pluginId.localeCompare(right.pluginId);
    return byPlugin !== 0 ? byPlugin : left.contribution.id.localeCompare(right.contribution.id);
  });
  return {
    commands,
    slashCommands,
    sidebarItems,
    panels,
    composerPills,
    attachmentSources,
    themes,
    timelineItems,
    workspacePanels,
    filePanels,
    providerActions,
    providerPanels,
    agentActions,
  };
}

export function emptyPluginContributionIndex(): PluginContributionIndex {
  return EMPTY_INDEX;
}

export function findPluginWebView(
  plugin: NeolixPlugin | undefined,
  viewId: string,
): NeolixPluginWebView | undefined {
  return plugin?.web?.views.find((view) => view.id === viewId);
}

/** Calls one declared plugin server RPC through the bridge. */
export async function invokePluginRpc(
  pluginId: string,
  method: string,
  input?: unknown,
): Promise<unknown> {
  const api = readNativeApi();
  if (!api?.neolix?.plugins) throw new Error("Plugin RPC is unavailable.");
  const result = await api.neolix.plugins.invoke({
    pluginId,
    method,
    input: input as NonNullable<NeolixPluginsInvokeInput["input"]> | undefined,
  });
  return result.output;
}

/** Executes a declarative action; returns the RPC output when there is one. */
export async function runPluginAction(
  pluginId: string,
  action: {
    readonly kind: "pluginRpc" | "openView";
    readonly method?: string | undefined;
    readonly input?: unknown;
    readonly view?: string | undefined;
    readonly params?: Readonly<Record<string, string>> | undefined;
  },
  openView: (pluginId: string, viewId: string, params?: Readonly<Record<string, string>>) => void,
): Promise<unknown> {
  if (action.kind === "openView" && action.view) {
    openView(pluginId, action.view, action.params);
    return undefined;
  }
  if (action.kind === "pluginRpc" && action.method)
    return invokePluginRpc(pluginId, action.method, action.input);
  return undefined;
}
