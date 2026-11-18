/**
 * Neolix plugin management.
 *
 * The Synara fork's provider plugin discovery (`provider.listPlugins`) mirrors Codex's own
 * marketplace and cannot drive Neolix's plugin host. These RPCs expose the daemon's plugin
 * catalog instead: installed plugins, the plugin market, and the lifecycle actions the old
 * React Native settings page offered.
 */
import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas";

const PluginId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const NeolixPluginStatus = Schema.Literals(["running", "disabled", "failed"]);
export type NeolixPluginStatus = typeof NeolixPluginStatus.Type;

export const NeolixPluginNpmInstallation = Schema.Struct({
  packageName: Schema.String,
  requestedSpec: Schema.String,
  version: Schema.String,
  integrity: Schema.String,
});
export type NeolixPluginNpmInstallation = typeof NeolixPluginNpmInstallation.Type;

export const NeolixPluginSourceIdentity = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("directory"), path: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("git"),
    remote: Schema.String,
    pluginPath: Schema.String,
    registry: Schema.optional(Schema.Struct({ url: Schema.String, id: Schema.String })),
  }),
  Schema.Struct({
    kind: Schema.Literal("npm"),
    packageName: Schema.String,
    pluginPath: Schema.String,
    registry: Schema.optional(Schema.Struct({ url: Schema.String, id: Schema.String })),
  }),
]);
export type NeolixPluginSourceIdentity = typeof NeolixPluginSourceIdentity.Type;

export const NeolixPluginInstallation = Schema.Struct({
  identity: NeolixPluginSourceIdentity,
  currentRevision: Schema.optional(Schema.String),
});
export type NeolixPluginInstallation = typeof NeolixPluginInstallation.Type;

const ContributionId = Schema.String;
const ContributionTitle = Schema.String;

export const NeolixPluginContributionAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("pluginRpc"),
    method: Schema.String,
    input: Schema.optional(Schema.Json),
  }),
  Schema.Struct({
    kind: Schema.Literal("openView"),
    view: ContributionId,
    params: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
]);
export type NeolixPluginContributionAction = typeof NeolixPluginContributionAction.Type;

export const NeolixPluginCommand = Schema.Struct({
  id: ContributionId,
  title: ContributionTitle,
  icon: Schema.optional(Schema.String),
  keywords: Schema.optional(Schema.Array(Schema.String)),
  context: Schema.Literals(["global", "workspace", "agent"]),
  action: NeolixPluginContributionAction,
});
export type NeolixPluginCommand = typeof NeolixPluginCommand.Type;

export const NeolixPluginSlashCommand = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  argumentHint: Schema.optional(Schema.String),
  context: Schema.Literals(["workspace", "agent"]),
  action: NeolixPluginContributionAction,
});
export type NeolixPluginSlashCommand = typeof NeolixPluginSlashCommand.Type;

export const NeolixPluginReplaceablePage = Schema.Literals([
  "sessions",
  "library",
  "routing",
  "usage",
]);
export type NeolixPluginReplaceablePage = typeof NeolixPluginReplaceablePage.Type;

export const NeolixPluginSidebarItem = Schema.Struct({
  id: ContributionId,
  title: ContributionTitle,
  icon: Schema.optional(Schema.String),
  section: Schema.optional(Schema.Literals(["header", "footer"])),
  order: Schema.optional(Schema.Int),
  /** Takes this built-in page's place while the plugin is installed. */
  replaces: Schema.optional(NeolixPluginReplaceablePage),
  view: ContributionId,
});
export type NeolixPluginSidebarItem = typeof NeolixPluginSidebarItem.Type;

/** A built-in page a plugin's panel joins: Agents, Usage, Settings > Plugins, or a provider editor. */
export const NeolixPluginPanelSlot = Schema.Literals(["agents", "usage", "settings", "provider"]);
export type NeolixPluginPanelSlot = typeof NeolixPluginPanelSlot.Type;

export const NeolixPluginPanel = Schema.Struct({
  id: ContributionId,
  slot: NeolixPluginPanelSlot,
  title: Schema.optional(ContributionTitle),
  height: Schema.optional(Schema.Int),
  view: ContributionId,
});
export type NeolixPluginPanel = typeof NeolixPluginPanel.Type;

export const NeolixPluginComposerPill = Schema.Struct({
  id: ContributionId,
  title: ContributionTitle,
  icon: Schema.optional(Schema.String),
  context: Schema.Literals(["workspace", "agent"]),
  action: NeolixPluginContributionAction,
});
export type NeolixPluginComposerPill = typeof NeolixPluginComposerPill.Type;

export const NeolixPluginAttachmentSource = Schema.Struct({
  id: ContributionId,
  title: ContributionTitle,
  icon: Schema.optional(Schema.String),
  search: Schema.Struct({
    method: Schema.String,
    input: Schema.optional(Schema.Json),
  }),
  pick: Schema.optional(Schema.Struct({ template: Schema.String })),
});
export type NeolixPluginAttachmentSource = typeof NeolixPluginAttachmentSource.Type;

export const NeolixPluginTheme = Schema.Struct({
  id: ContributionId,
  name: ContributionTitle,
  appearance: Schema.Literals(["light", "dark"]),
  colors: Schema.Struct({
    background: Schema.String,
    foreground: Schema.String,
    raised: Schema.String,
    control: Schema.String,
    border: Schema.String,
    accent: Schema.optional(Schema.String),
    mutedForeground: Schema.String,
    ring: Schema.String,
  }),
});
export type NeolixPluginTheme = typeof NeolixPluginTheme.Type;

export const NeolixPluginTimelineItem = Schema.Struct({
  kind: Schema.String,
  version: Schema.Int,
  title: ContributionTitle,
  tone: Schema.optional(Schema.Literals(["info", "success", "warning", "danger"])),
  view: Schema.optional(ContributionId),
});
export type NeolixPluginTimelineItem = typeof NeolixPluginTimelineItem.Type;

export const NeolixPluginPanelLocation = Schema.Literals(["workspace", "explorer"]);
export type NeolixPluginPanelLocation = typeof NeolixPluginPanelLocation.Type;

/**
 * A workspace or agent panel, declared in `neox-plugin.json` with a sandboxed web view as its
 * body. The React Native host registers these from client code; a declarative manifest entry is
 * how a non-RN host renders the same surface without running the client bundle.
 */
export const NeolixPluginWorkspacePanel = Schema.Struct({
  id: ContributionId,
  title: ContributionTitle,
  icon: Schema.optional(Schema.String),
  /** "workspace" panels get the workspace id params; "agent" panels also get the agent id. */
  context: Schema.optional(Schema.Literals(["workspace", "agent"])),
  locations: Schema.optional(Schema.Array(NeolixPluginPanelLocation)),
  view: ContributionId,
});
export type NeolixPluginWorkspacePanel = typeof NeolixPluginWorkspacePanel.Type;

export const NeolixPluginFileSelector = Schema.Struct({
  extensions: Schema.Array(Schema.String),
  filenames: Schema.optional(Schema.Array(Schema.String)),
});
export type NeolixPluginFileSelector = typeof NeolixPluginFileSelector.Type;

/** A plugin view that can replace the built-in body of a file tab. */
export const NeolixPluginFilePanel = Schema.Struct({
  id: ContributionId,
  title: ContributionTitle,
  icon: Schema.optional(Schema.String),
  files: NeolixPluginFileSelector,
  view: ContributionId,
});
export type NeolixPluginFilePanel = typeof NeolixPluginFilePanel.Type;

export const NeolixPluginProviderAction = Schema.Struct({
  id: ContributionId,
  title: ContributionTitle,
  icon: Schema.optional(Schema.String),
  action: NeolixPluginContributionAction,
});
export type NeolixPluginProviderAction = typeof NeolixPluginProviderAction.Type;

export const NeolixPluginProviderPanel = Schema.Struct({
  id: ContributionId,
  title: ContributionTitle,
  icon: Schema.optional(Schema.String),
  view: ContributionId,
});
export type NeolixPluginProviderPanel = typeof NeolixPluginProviderPanel.Type;

export const NeolixPluginAgentAction = Schema.Struct({
  id: ContributionId,
  title: ContributionTitle,
  icon: Schema.optional(Schema.String),
  action: NeolixPluginContributionAction,
});
export type NeolixPluginAgentAction = typeof NeolixPluginAgentAction.Type;

export const NeolixPluginContributions = Schema.Struct({
  commands: Schema.optional(Schema.Array(NeolixPluginCommand)),
  slashCommands: Schema.optional(Schema.Array(NeolixPluginSlashCommand)),
  sidebarItems: Schema.optional(Schema.Array(NeolixPluginSidebarItem)),
  panels: Schema.optional(Schema.Array(NeolixPluginPanel)),
  composerPills: Schema.optional(Schema.Array(NeolixPluginComposerPill)),
  attachmentSources: Schema.optional(Schema.Array(NeolixPluginAttachmentSource)),
  themes: Schema.optional(Schema.Array(NeolixPluginTheme)),
  timelineItems: Schema.optional(Schema.Array(NeolixPluginTimelineItem)),
  workspacePanels: Schema.optional(Schema.Array(NeolixPluginWorkspacePanel)),
  filePanels: Schema.optional(Schema.Array(NeolixPluginFilePanel)),
  providerActions: Schema.optional(Schema.Array(NeolixPluginProviderAction)),
  providerPanels: Schema.optional(Schema.Array(NeolixPluginProviderPanel)),
  agentActions: Schema.optional(Schema.Array(NeolixPluginAgentAction)),
});
export type NeolixPluginContributions = typeof NeolixPluginContributions.Type;

/**
 * The subset of contributions a non-RN host reads from the manifest. The daemon's protocol
 * schema drops these keys, so the bridge decodes the manifest directly (see `pluginsRpc.ts`).
 */
export const NeolixPluginManifestContributions = Schema.Struct({
  workspacePanels: Schema.optional(Schema.Array(NeolixPluginWorkspacePanel)),
  filePanels: Schema.optional(Schema.Array(NeolixPluginFilePanel)),
  providerActions: Schema.optional(Schema.Array(NeolixPluginProviderAction)),
  providerPanels: Schema.optional(Schema.Array(NeolixPluginProviderPanel)),
  agentActions: Schema.optional(Schema.Array(NeolixPluginAgentAction)),
});
export type NeolixPluginManifestContributions = typeof NeolixPluginManifestContributions.Type;

export const NeolixPluginWebView = Schema.Struct({
  id: ContributionId,
  title: ContributionTitle,
  entry: Schema.String,
  permissions: Schema.optional(Schema.Array(Schema.Literals(["rpc", "navigate", "resize"]))),
  rpcs: Schema.optional(Schema.Array(Schema.String)),
});
export type NeolixPluginWebView = typeof NeolixPluginWebView.Type;

export const NeolixPluginWeb = Schema.Struct({
  views: Schema.Array(NeolixPluginWebView),
});
export type NeolixPluginWeb = typeof NeolixPluginWeb.Type;

/**
 * One field of a plugin-declared settings screen. Synara's settings shell renders these
 * with its own controls; the values live in the plugin's `settings.<settingsId>` store on
 * the daemon. The daemon's React Native plugins describe screens in client code, which the
 * web cannot render, so the screen is declared as data in the plugin manifest instead.
 */
export const NeolixPluginSettingsField = Schema.Struct({
  key: Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)),
  label: Schema.String,
  description: Schema.optional(Schema.String),
  type: Schema.Literals(["text", "number", "boolean", "select", "json"]),
  placeholder: Schema.optional(Schema.String),
  options: Schema.optional(
    Schema.Array(Schema.Struct({ label: Schema.String, value: Schema.String })),
  ),
  default: Schema.optional(Schema.Json),
});
export type NeolixPluginSettingsField = typeof NeolixPluginSettingsField.Type;

export const NeolixPluginSettingsScreen = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/)),
  title: Schema.String,
  icon: Schema.optional(Schema.String),
  /** The `settings.<id>` RPC namespace the form reads and writes. */
  settingsId: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]*$/)),
  fields: Schema.Array(NeolixPluginSettingsField),
});
export type NeolixPluginSettingsScreen = typeof NeolixPluginSettingsScreen.Type;

/**
 * A host-scoped settings definition the running plugin registered with `server.registerSettings`.
 * Its `schema` is draft-07 JSON Schema, the source a web host renders its own form from. It sits
 * beside manifest `settingsScreens`: the daemon owns the values, the manifest owns presentation.
 */
export const NeolixPluginSettingDefinition = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]*$/)),
  title: Schema.optional(Schema.String),
  schema: Schema.optional(Schema.Json),
});
export type NeolixPluginSettingDefinition = typeof NeolixPluginSettingDefinition.Type;

export const NeolixPlugin = Schema.Struct({
  id: PluginId,
  name: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  media: Schema.optional(Schema.Array(Schema.String)),
  description: Schema.optional(Schema.String),
  providers: Schema.optional(Schema.Array(Schema.String)),
  strategies: Schema.optional(Schema.Array(Schema.String)),
  path: Schema.String,
  enabled: Schema.Boolean,
  status: NeolixPluginStatus,
  source: Schema.optional(Schema.Literals(["directory", "git"])),
  npm: Schema.optional(NeolixPluginNpmInstallation),
  installation: Schema.optional(NeolixPluginInstallation),
  remote: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  commit: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  contributions: Schema.optional(NeolixPluginContributions),
  web: Schema.optional(NeolixPluginWeb),
  /** Data-driven settings forms this plugin declares in its manifest. */
  settingsScreens: Schema.optional(Schema.Array(NeolixPluginSettingsScreen)),
  /** Settings the running plugin registered, exposed by the daemon for schema-driven forms. */
  settings: Schema.optional(Schema.Array(NeolixPluginSettingDefinition)),
});
export type NeolixPlugin = typeof NeolixPlugin.Type;

export const NeolixPluginLogEntry = Schema.Struct({
  sequence: NonNegativeInt,
  timestamp: Schema.String,
  stream: Schema.Literals(["stdout", "stderr"]),
  message: Schema.String,
});
export type NeolixPluginLogEntry = typeof NeolixPluginLogEntry.Type;

export const NeolixPluginMarketCategory = Schema.Struct({
  slug: Schema.String,
  label: Schema.String,
  description: Schema.optional(Schema.String),
});
export type NeolixPluginMarketCategory = typeof NeolixPluginMarketCategory.Type;

export const NeolixPluginArtifact = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("npm"),
    package: Schema.String,
    version: Schema.String,
    resolved: Schema.String,
    integrity: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("git"),
    remote: Schema.String,
    commit: Schema.String,
    pluginPath: Schema.optional(Schema.String),
  }),
]);
export type NeolixPluginArtifact = typeof NeolixPluginArtifact.Type;

export const NeolixPluginListing = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  translations: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        name: Schema.optional(Schema.String),
        description: Schema.optional(Schema.String),
      }),
    ),
  ),
  license: Schema.optional(Schema.String),
  categories: Schema.Array(Schema.String),
  author: Schema.Struct({
    github: Schema.String,
    name: Schema.optional(Schema.String),
    npm: Schema.optional(Schema.String),
  }),
  repository: Schema.Struct({
    url: Schema.String,
    commit: Schema.optional(Schema.String),
  }),
  artifact: NeolixPluginArtifact,
  replaces: Schema.optional(Schema.Array(Schema.String)),
  icon: Schema.optional(Schema.String),
  media: Schema.Array(Schema.String),
  submittedAt: Schema.String,
  reviewedAt: Schema.String,
  updatedAt: Schema.String,
  publishedAt: Schema.String,
  installs: Schema.optional(NonNegativeInt),
});
export type NeolixPluginListing = typeof NeolixPluginListing.Type;

export const NeolixPluginMarket = Schema.Struct({
  registry: Schema.Struct({ name: Schema.String, url: Schema.String }),
  categories: Schema.Array(NeolixPluginMarketCategory),
  plugins: Schema.Array(NeolixPluginListing),
  weeklyDownloads: Schema.optional(Schema.Record(Schema.String, NonNegativeInt)),
});
export type NeolixPluginMarket = typeof NeolixPluginMarket.Type;

export const NeolixPluginMarketHit = Schema.Struct({
  package: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  weeklyDownloads: Schema.optional(NonNegativeInt),
  publisher: Schema.optional(Schema.String),
});
export type NeolixPluginMarketHit = typeof NeolixPluginMarketHit.Type;

export const NeolixPluginsListInput = Schema.Struct({});
export const NeolixPluginsListResult = Schema.Struct({
  plugins: Schema.Array(NeolixPlugin),
  /** Absent on older hosts; false means plugin execution is globally off. */
  pluginsEnabled: Schema.optional(Schema.Boolean),
});
export type NeolixPluginsListResult = typeof NeolixPluginsListResult.Type;

export const NeolixPluginsBuiltinResult = Schema.Struct({
  plugins: Schema.Array(Schema.String),
});
export type NeolixPluginsBuiltinResult = typeof NeolixPluginsBuiltinResult.Type;

export const NeolixPluginsMarketResult = NeolixPluginMarket;
export type NeolixPluginsMarketResult = typeof NeolixPluginsMarketResult.Type;

export const NeolixPluginsSearchMarketInput = Schema.Struct({
  query: TrimmedNonEmptyString,
  mirror: Schema.optional(Schema.Boolean),
});
export type NeolixPluginsSearchMarketInput = typeof NeolixPluginsSearchMarketInput.Type;
export const NeolixPluginsSearchMarketResult = Schema.Struct({
  hits: Schema.Array(NeolixPluginMarketHit),
});
export type NeolixPluginsSearchMarketResult = typeof NeolixPluginsSearchMarketResult.Type;

export const NeolixPluginsInstallInput = Schema.Struct({
  source: TrimmedNonEmptyString,
  id: Schema.optional(PluginId),
  ref: Schema.optional(Schema.String),
});
export type NeolixPluginsInstallInput = typeof NeolixPluginsInstallInput.Type;

/** Where the daemon should read a plugin's README from. */
export const NeolixPluginReadmeSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("registry"), id: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("npm"), package: TrimmedNonEmptyString }),
  Schema.Struct({
    kind: Schema.Literal("github"),
    remote: TrimmedNonEmptyString,
    ref: Schema.optional(Schema.String),
  }),
]);
export type NeolixPluginReadmeSource = typeof NeolixPluginReadmeSource.Type;

export const NeolixPluginsReadmeInput = Schema.Struct({
  source: NeolixPluginReadmeSource,
  /** Language tag for a registry translation; English is the fallback. */
  locale: Schema.optional(Schema.String),
});
export type NeolixPluginsReadmeInput = typeof NeolixPluginsReadmeInput.Type;

export const NeolixPluginsReadmeResult = Schema.Struct({
  markdown: Schema.String,
});
export type NeolixPluginsReadmeResult = typeof NeolixPluginsReadmeResult.Type;

export const NeolixPluginActionResult = Schema.Struct({
  plugin: NeolixPlugin,
});
export type NeolixPluginActionResult = typeof NeolixPluginActionResult.Type;

export const NeolixPluginsIdInput = Schema.Struct({
  pluginId: PluginId,
});
export type NeolixPluginsIdInput = typeof NeolixPluginsIdInput.Type;

export const NeolixPluginsRemoveResult = Schema.Struct({});
export type NeolixPluginsRemoveResult = typeof NeolixPluginsRemoveResult.Type;

export const NeolixPluginsInvokeInput = Schema.Struct({
  pluginId: PluginId,
  method: TrimmedNonEmptyString,
  input: Schema.optional(Schema.Json),
});
export type NeolixPluginsInvokeInput = typeof NeolixPluginsInvokeInput.Type;

const PluginSettingsId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]*$/));

export const NeolixPluginSettingsReadInput = Schema.Struct({
  pluginId: PluginId,
  settingsId: PluginSettingsId,
});
export type NeolixPluginSettingsReadInput = typeof NeolixPluginSettingsReadInput.Type;

export const NeolixPluginSettingsReadResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ready"),
    revision: Schema.String,
    values: Schema.Json,
  }),
  Schema.Struct({
    status: Schema.Literal("invalid"),
    revision: Schema.String,
    error: Schema.String,
  }),
]);
export type NeolixPluginSettingsReadResult = typeof NeolixPluginSettingsReadResult.Type;

export const NeolixPluginSettingsWriteInput = Schema.Struct({
  pluginId: PluginId,
  settingsId: PluginSettingsId,
  revision: Schema.String,
  values: Schema.Json,
});
export type NeolixPluginSettingsWriteInput = typeof NeolixPluginSettingsWriteInput.Type;

export const NeolixPluginSettingsResetInput = Schema.Struct({
  pluginId: PluginId,
  settingsId: PluginSettingsId,
  revision: Schema.String,
});
export type NeolixPluginSettingsResetInput = typeof NeolixPluginSettingsResetInput.Type;

export const NeolixPluginSettingsWriteResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("saved"),
    revision: Schema.String,
    values: Schema.Json,
  }),
  Schema.Struct({
    status: Schema.Literal("conflict"),
    error: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("invalid"),
    error: Schema.String,
  }),
]);
export type NeolixPluginSettingsWriteResult = typeof NeolixPluginSettingsWriteResult.Type;

export const NeolixPluginsInvokeResult = Schema.Struct({
  output: Schema.Json,
});
export type NeolixPluginsInvokeResult = typeof NeolixPluginsInvokeResult.Type;

export const NeolixPluginsWebAssetInput = Schema.Struct({
  pluginId: PluginId,
  path: TrimmedNonEmptyString,
});
export type NeolixPluginsWebAssetInput = typeof NeolixPluginsWebAssetInput.Type;

export const NeolixPluginsWebAssetResult = Schema.Struct({
  pluginId: PluginId,
  path: Schema.String,
  contentType: Schema.Literals([
    "text/html",
    "text/css",
    "text/javascript",
    "application/json",
    "image/svg+xml",
    "image/png",
    "image/jpeg",
    "font/woff2",
  ]),
  encoding: Schema.Literals(["utf8", "base64"]),
  content: Schema.String,
});
export type NeolixPluginsWebAssetResult = typeof NeolixPluginsWebAssetResult.Type;
