import type { PluginText } from "@neolix/plugin/client";
import type { NeolixApi } from "@neolix/client";
import type { QueryClient } from "@tanstack/react-query";
import type { PluginRequirements } from "@neolix/protocol/messages";
import type {
  PluginAttachmentSourceContribution as SDKPluginAttachmentSourceContribution,
  PluginCleanup,
  PluginThemeContribution as SDKPluginThemeContribution,
} from "@neolix/plugin";
import type {
  PluginFilePanelContribution as SDKPluginFilePanelContribution,
  PluginCommandCenterItemContribution as SDKPluginCommandCenterItemContribution,
  PluginClientSlashCommandContribution as SDKPluginClientSlashCommandContribution,
  PluginProviderRowActionContribution as SDKPluginProviderRowActionContribution,
  PluginProviderPanelContribution as SDKPluginProviderPanelContribution,
  PluginAgentRowActionContribution as SDKPluginAgentRowActionContribution,
  PluginComposerPillContribution as SDKPluginComposerPillContribution,
  PluginSidebarContribution as SDKPluginSidebarContribution,
  PluginSidebarItemContribution as SDKPluginSidebarItemContribution,
  PluginScreenContribution as SDKPluginScreenContribution,
  PluginSettingsScreenContribution as SDKPluginSettingsScreenContribution,
  PluginTimelineRendererContribution,
  PluginTimelineTransformerContribution,
  PluginPanelLocation,
  PluginWorkspacePanelContribution as SDKPluginWorkspacePanelContribution,
} from "@neolix/plugin/client";

type PluginFilePanelContribution = SDKPluginFilePanelContribution<PluginText>;
type PluginAttachmentSourceContribution = SDKPluginAttachmentSourceContribution<PluginText>;
type PluginThemeContribution = SDKPluginThemeContribution<PluginText>;
type PluginCommandCenterItemContribution = SDKPluginCommandCenterItemContribution<PluginText>;
type PluginProviderRowActionContribution = SDKPluginProviderRowActionContribution<PluginText>;
type PluginProviderPanelContribution = SDKPluginProviderPanelContribution<PluginText>;
type PluginAgentRowActionContribution = SDKPluginAgentRowActionContribution<PluginText>;
type PluginClientSlashCommandContribution = SDKPluginClientSlashCommandContribution<PluginText>;
type PluginComposerPillContribution = SDKPluginComposerPillContribution<PluginText>;
type PluginSidebarContribution = SDKPluginSidebarContribution<PluginText>;
type PluginSidebarItemContribution = SDKPluginSidebarItemContribution<PluginText>;
type PluginScreenContribution = SDKPluginScreenContribution<PluginText>;
type PluginSettingsScreenContribution = SDKPluginSettingsScreenContribution<PluginText>;
type WorkspacePanelInput = SDKPluginWorkspacePanelContribution<PluginText>;
type PluginWorkspacePanelContribution =
  | (Extract<WorkspacePanelInput, { context?: "workspace" }> & { context: "workspace" })
  | Extract<WorkspacePanelInput, { context: "agent" }>;

export type PluginSidebarSection = "header" | "footer";

export type EvaluatedPluginWorkspacePanelContribution = PluginWorkspacePanelContribution & {
  locations: readonly PluginPanelLocation[];
};

export interface EvaluatedPlugin {
  id: string;
  cleanup: PluginCleanup;
  surfaces: PluginScreenContribution[];
  settingsScreens: PluginSettingsScreenContribution[];
  sidebarItems: Record<PluginSidebarSection, PluginSidebarItemContribution[]>;
  // COMPAT(pluginSidebarAliases): added in v0.11.0, remove after 2027-03-29
  /** `addSidebarItem` registrations, so `/plugin/<id>/sidebar/<item>` routes keep resolving. */
  legacySidebarItems: PluginSidebarContribution[];
  filePanels: PluginFilePanelContribution[];
  workspacePanels: EvaluatedPluginWorkspacePanelContribution[];
  commandCenterItems: PluginCommandCenterItemContribution[];
  providerActions: PluginProviderRowActionContribution[];
  providerPanels: PluginProviderPanelContribution[];
  agentActions: PluginAgentRowActionContribution[];
  clientSlashCommands: PluginClientSlashCommandContribution[];
  attachmentSources: PluginAttachmentSourceContribution[];
  themes: PluginThemeContribution[];
  timelineTransformers: PluginTimelineTransformerContribution[];
  timelineRenderers: PluginTimelineRendererContribution[];
}

export interface InstalledPlugin extends EvaluatedPlugin {
  lifetime: AbortController;
  /** Immutable presentation locale, refreshed without replacing the installation lifetime. */
  locale: string;
  i18n: import("@neolix/plugin/client/host").PluginTranslationRuntime;
  /** The plugin's one Neolix client, `useNeolix()` in every surface; disposed at teardown. */
  neolix: NeolixApi;
  /** Calls one of the plugin's server RPC methods on its host. */
  invoke(method: string, input: unknown): Promise<unknown>;
  /** Subscribes to one of the plugin's server subscriptions; released with the lifetime. */
  subscribe: import("@neolix/plugin/client/host").PluginSubscribe;
  serverId: string;
  requirements?: PluginRequirements;
  clientBundle: string;
  queryClient: QueryClient;
}

export type {
  PluginFilePanelContribution,
  PluginAttachmentSourceContribution,
  PluginCommandCenterItemContribution,
  PluginProviderRowActionContribution,
  PluginProviderPanelContribution,
  PluginAgentRowActionContribution,
  PluginClientSlashCommandContribution,
  PluginComposerPillContribution,
  PluginSidebarContribution,
  PluginSidebarItemContribution,
  PluginScreenContribution,
  PluginSettingsScreenContribution,
  PluginThemeContribution,
  PluginTimelineRendererContribution,
  PluginTimelineTransformerContribution,
  PluginWorkspacePanelContribution,
};
