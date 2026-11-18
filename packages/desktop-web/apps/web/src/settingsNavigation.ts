// FILE: settingsNavigation.ts
// Purpose: Share the settings topic taxonomy between the main sidebar and the settings screen.
// Layer: Route/UI support
// Exports: section ids, nav items, and search normalization helper

import { isBetaFeatureOn } from "~/betaFeatures";
import { isElectron } from "~/env";
import { KEYBINDINGS_ICON_NAME } from "~/lib/icons";

export const SETTINGS_SECTION_IDS = [
  "general",
  "desktop",
  "profile",
  "appearance",
  "notifications",
  "behavior",
  "appsnap",
  "computer",
  "shortcuts",
  "worktrees",
  "archived",
  "models",
  "gateway",
  "providers",
  "agent-connect",
  "agent-profiles",
  "skills",
  "plugins",
  "scheduled-tasks",
  "usage",
  "connectors",
  "integrations",
  "connections",
  "advanced",
  "host",
  "network",
  "privacy",
  "observability",
  "diagnostics",
  "sync",
  "quota",
  "terminals",
  "voice",
  "sessions",
  "library-instructions",
  "library-hooks",
  "library-subagents",
  "library-rtk",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];
export type SettingsNavGroupId = "personal" | "integrations" | "coding" | "system" | "archived";

/**
 * Deep-link scroll targets inside settings panels. Each id is shared by its DOM owner and callers
 * that navigate with `?target=…`; the settings route resolves every target after the active panel
 * mounts.
 */
export const SETTINGS_TARGETS = {
  providerUpdates: "provider-updates",
  providerInstalls: "provider-installs",
  environmentPanel: "environment-panel",
} as const;

export type SettingsNavItem = {
  id: SettingsSectionId;
  group: SettingsNavGroupId;
  label: string;
  description: string;
  /** Basename of a SVG under `/central-icons-reversed`. */
  icon: string;
  eyebrow: string;
  /**
   * Maturity label shown beside the section name, in the sidebar and on the
   * panel's own heading. Absent for a settled feature; one source so the two
   * places can never disagree about what is still in beta.
   */
  badge?: string;
};

// Keep English source keys here: callers translate at render time, while section/row ids stay stable.
export const SETTINGS_NAV_GROUPS: ReadonlyArray<{
  id: SettingsNavGroupId;
  label: string;
}> = [
  { id: "personal", label: "settings:personal" },
  { id: "integrations", label: "common:integrations" },
  { id: "coding", label: "settings:coding" },
  { id: "system", label: "common:themeOptions_system" },
  { id: "archived", label: "workspace:archived_archivedRelative" },
] as const;

/** Sections that exist only where their Beta-only feature is on. */
const SETTINGS_SECTION_BETA_FEATURES: Partial<Record<SettingsSectionId, string>> = {};

/**
 * Neox has no Synara account, computer-use, or AppSnap backend, so those settings
 * sections stay hidden from nav, search and deep links.
 */
const UNSUPPORTED_SETTINGS_SECTIONS: ReadonlySet<SettingsSectionId> = new Set([
  "profile",
  "computer",
  "appsnap",
]);

/** False for a Beta-only section on Stable: no nav entry, search result, or deep link. */
export function isSettingsSectionAvailable(
  section: SettingsSectionId,
  isOn: (feature: string) => boolean = isBetaFeatureOn,
): boolean {
  // The desktop section configures the shell; a browser has nothing to show.
  if (section === "desktop") return isElectron;
  if (UNSUPPORTED_SETTINGS_SECTIONS.has(section)) return false;
  const feature = SETTINGS_SECTION_BETA_FEATURES[section];
  return feature === undefined || isOn(feature);
}

const ALL_SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = [
  {
    id: "general",
    group: "personal",
    label: "settings:nav_general",
    description: "settings:chooseDefaultsForNewChatsNavigationAndTheEnvironment",
    icon: "settings-gear-4",
    eyebrow: "Workflow defaults",
  },
  {
    id: "profile",
    group: "personal",
    label: "computer:nav_profile",
    description: "settings:nav_profileDescription",
    icon: "user",
    eyebrow: "Your stats",
  },
  {
    id: "appearance",
    group: "personal",
    label: "common:nav_appearance",
    description: "settings:customizeTheThemeTypographyDensityAndTimeFormat",
    icon: "color-palette",
    eyebrow: "Visual language",
  },
  {
    id: "notifications",
    group: "personal",
    label: "settings:nav_notifications",
    description: "settings:chooseHowSynaraTellsYouWhenWorkFinishesOr",
    icon: "bell",
    eyebrow: "Alerts",
  },
  {
    id: "behavior",
    group: "personal",
    label: "settings:chatBehavior",
    description: "settings:controlLiveResponsesFollowUpsReviewDefaultsAndSafety",
    icon: "settings-slider-hor",
    eyebrow: "Interaction rules",
  },
  {
    id: "shortcuts",
    group: "personal",
    label: "common:advanced_keybindings",
    description: "settings:changeAddOrRemoveTheShortcutForEverySynara",
    icon: KEYBINDINGS_ICON_NAME,
    eyebrow: "Key bindings",
  },
  {
    id: "usage",
    group: "personal",
    label: "settings:usageLimits",
    description: "settings:seeRemainingQuotaAndCreditsForEverySignedIn",
    icon: "gauge",
    eyebrow: "Provider limits",
  },
  {
    id: "appsnap",
    group: "integrations",
    label: "settings:appSnap",
    description: "settings:captureAnotherAppSFrontmostWindowDirectlyIntoA",
    icon: "screen-capture",
    eyebrow: "Screen capture",
  },
  {
    id: "computer",
    group: "integrations",
    label: "settings:computerUse",
    description: "settings:letAgentsSeeAndControlThisComputerSDesktop",
    icon: "computer-use",
    eyebrow: "Desktop control",
    badge: "workspace:beta",
  },
  {
    id: "connectors",
    group: "integrations",
    label: "settings:connectors",
    description: "settings:connectorsDescription",
    icon: "connectors-1",
    eyebrow: "Remote MCP servers",
  },
  {
    id: "integrations",
    group: "integrations",
    label: "settings:mCPConnections",
    description: "settings:giveCodexClaudeAndOtherLocalAgentsScopedAccess",
    icon: "plugin-1",
    eyebrow: "External agents",
  },
  {
    id: "connections",
    group: "integrations",
    label: "settings:connections_title",
    description: "settings:hostNav_connectionsDescription",
    // Remote access means paired devices; "network" keeps the globe.
    icon: "devices",
    eyebrow: "Remote access",
  },
  {
    id: "desktop",
    group: "system",
    label: "settings:nav_desktop",
    description: "settings:nav_desktopDescription",
    icon: "layout-window",
    eyebrow: "Desktop shell",
  },
  {
    id: "host",
    group: "system",
    label: "settings:host_sectionHost",
    description: "settings:hostNav_hostDescription",
    icon: "server",
    eyebrow: "This computer",
  },
  {
    id: "network",
    group: "system",
    label: "settings:hostNav_network",
    description: "settings:hostNav_networkDescription",
    icon: "globe",
    eyebrow: "Connectivity",
  },
  {
    id: "privacy",
    group: "system",
    label: "settings:hostNav_privacy",
    description: "settings:hostNav_privacyDescription",
    icon: "shield",
    eyebrow: "Data access",
  },
  {
    id: "observability",
    group: "system",
    label: "settings:hostNav_observability",
    description: "settings:hostNav_observabilityDescription",
    icon: "live-activity",
    eyebrow: "Diagnostics",
  },
  {
    id: "diagnostics",
    group: "system",
    label: "settings:hostNav_diagnostics",
    description: "settings:hostNav_diagnosticsDescription",
    icon: "clipboard-2",
    eyebrow: "Diagnostics",
  },
  {
    id: "sync",
    group: "system",
    label: "settings:hostNav_sync",
    description: "settings:hostNav_syncDescription",
    icon: "cloud-sync",
    eyebrow: "Continuity",
  },
  {
    id: "quota",
    group: "personal",
    label: "settings:hostNav_quota",
    description: "settings:hostNav_quotaDescription",
    // Distinct from "usage" (gauge) right above it: the remaining allowance it watches.
    icon: "battery-medium",
    eyebrow: "Allowances",
  },
  {
    id: "terminals",
    group: "coding",
    label: "settings:host_terminalProfiles",
    description: "settings:hostNav_terminalsDescription",
    icon: "code-large",
    eyebrow: "Terminals",
  },
  {
    id: "voice",
    group: "personal",
    label: "settings:hostNav_voice",
    description: "settings:hostNav_voiceDescription",
    icon: "microphone",
    eyebrow: "Speech",
  },
  {
    id: "sessions",
    group: "system",
    label: "settings:hostData_sessions",
    description: "settings:hostData_sessionHistoryDescription",
    icon: "history",
    eyebrow: "History",
  },
  {
    id: "providers",
    group: "coding",
    label: "settings:agentProviders",
    description: "settings:chooseVisibleCodingAgentsAndManageTheirInstalledCLI",
    icon: "puzzle",
    eyebrow: "Coding agents",
  },
  {
    id: "agent-connect",
    group: "coding",
    label: "settings:navTab_agentConnect",
    description: "settings:agentConnect_intro",
    icon: "puzzle",
    eyebrow: "Coding agents",
  },
  {
    id: "agent-profiles",
    group: "coding",
    label: "settings:agentProfiles_nav",
    description: "settings:agentProfiles_navDescription",
    icon: "bookmark",
    eyebrow: "Saved setups",
  },
  {
    id: "models",
    group: "coding",
    label: "settings:modelsWriting",
    description: "settings:chooseTheSourceControlWritingStyleGitWritingModel",
    icon: "brain",
    eyebrow: "Model configuration",
  },
  {
    id: "skills",
    group: "coding",
    label: "settings:nav_skillsEyebrow",
    description: "settings:reviewReusableWorkflowsDiscoveredAcrossAllConfiguredProviders",
    icon: "building-blocks",
    eyebrow: "Reusable workflows",
  },
  {
    id: "plugins",
    group: "coding",
    label: "settings:nav_plugins",
    description: "settings:nav_pluginsDescription",
    icon: "plugin-1",
    eyebrow: "Extensions",
  },
  {
    id: "scheduled-tasks",
    group: "coding",
    label: "settings:nav_scheduledTasks",
    description: "settings:nav_scheduledTasksDescription",
    icon: "clock",
    eyebrow: "Automation",
  },
  {
    id: "worktrees",
    group: "coding",
    label: "onboarding:managedWorktrees",
    description: "settings:reviewAndCleanUpIsolatedWorkspacesCreatedBySynara",
    icon: "branch-simple",
    eyebrow: "Workspace management",
  },
  {
    id: "advanced",
    group: "system",
    label: "settings:nav_advancedEyebrow",
    description: "settings:manageSessionsRecoveryToolsLowLevelKeybindingsAndVersion",
    icon: "toolbox",
    eyebrow: "System tools",
  },
  {
    id: "archived",
    group: "archived",
    label: "settings:archivedThreads",
    description: "settings:findAndRestoreThreadsYouPreviouslyArchived",
    icon: "archive",
    eyebrow: "Thread management",
  },
  {
    id: "library-instructions",
    group: "coding",
    label: "settings:library_nav_instructions",
    description: "settings:library_nav_instructionsDescription",
    icon: "code-lines",
    eyebrow: "Library",
  },
  {
    id: "library-hooks",
    group: "coding",
    label: "settings:library_nav_hooks",
    description: "settings:library_nav_hooksDescription",
    icon: "chain-link-2",
    eyebrow: "Library",
  },
  {
    id: "library-subagents",
    group: "coding",
    label: "settings:library_nav_subagents",
    description: "settings:library_nav_subagentsDescription",
    icon: "agents",
    eyebrow: "Library",
  },
  {
    id: "library-rtk",
    group: "coding",
    label: "settings:library_nav_rtk",
    description: "settings:library_nav_rtkDescription",
    icon: "lightning-bolt",
    eyebrow: "Library",
  },
  {
    id: "gateway",
    group: "coding",
    label: "gateway:nav_models",
    description: "gateway:nav_modelsDescription",
    icon: "ai-tokens",
    eyebrow: "Model gateway",
  },
] as const;

export const SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = ALL_SETTINGS_NAV_ITEMS.filter(
  (item) => isSettingsSectionAvailable(item.id),
);

// ── Pages ─────────────────────────────────────────────────────────────────
// The sidebar lists pages; a page shows its sections as tabs. Section ids stay the unit of
// deep links (`?section=`), search results and row anchors, so grouping sections into pages
// never breaks a link: any section id opens its page on that tab.

export type SettingsPageGroupId = "personal" | "agents" | "coding" | "system";

export type SettingsPageTab = {
  section: SettingsSectionId;
  /** Tab label when the section's own nav label would be ambiguous inside the page. */
  label?: string;
};

export type SettingsPage = {
  id: string;
  group: SettingsPageGroupId;
  label: string;
  /** Basename of a SVG under `/central-icons-reversed`. */
  icon: string;
  tabs: readonly SettingsPageTab[];
};

export const SETTINGS_PAGE_GROUPS: ReadonlyArray<{ id: SettingsPageGroupId; label: string }> = [
  { id: "personal", label: "settings:personal" },
  { id: "agents", label: "settings:navGroup_agents" },
  { id: "coding", label: "settings:coding" },
  { id: "system", label: "common:themeOptions_system" },
];

const ALL_SETTINGS_PAGES: readonly SettingsPage[] = [
  {
    id: "general",
    group: "personal",
    label: "settings:nav_general",
    icon: "settings-gear-4",
    tabs: [{ section: "general" }, { section: "notifications" }, { section: "desktop" }],
  },
  {
    id: "appearance",
    group: "personal",
    label: "common:nav_appearance",
    icon: "color-palette",
    tabs: [{ section: "appearance" }],
  },
  {
    id: "chat",
    group: "personal",
    label: "settings:navPage_chat",
    icon: "settings-slider-hor",
    tabs: [{ section: "behavior" }, { section: "voice" }],
  },
  {
    id: "shortcuts",
    group: "personal",
    label: "common:advanced_keybindings",
    icon: KEYBINDINGS_ICON_NAME,
    tabs: [{ section: "shortcuts" }],
  },
  {
    id: "agents",
    group: "agents",
    label: "settings:navPage_agents",
    icon: "puzzle",
    tabs: [
      { section: "providers", label: "settings:navTab_providers" },
      { section: "agent-connect", label: "settings:navTab_agentConnect" },
      { section: "agent-profiles", label: "settings:navTab_profiles" },
    ],
  },
  {
    id: "models",
    group: "agents",
    label: "gateway:nav_models",
    icon: "ai-tokens",
    tabs: [
      { section: "gateway", label: "settings:navTab_gateway" },
      { section: "models", label: "settings:navTab_writingModels" },
    ],
  },
  {
    id: "usage",
    group: "agents",
    label: "settings:navPage_usage",
    icon: "gauge",
    tabs: [
      { section: "usage", label: "settings:navTab_usage" },
      { section: "quota", label: "settings:navTab_quota" },
    ],
  },
  {
    id: "mcp",
    group: "agents",
    label: "settings:navPage_mcp",
    icon: "connectors-1",
    tabs: [
      { section: "connectors", label: "settings:navTab_mcpServers" },
      { section: "integrations", label: "settings:navTab_mcpBuiltIn" },
    ],
  },
  {
    id: "skills",
    group: "agents",
    label: "settings:navPage_skills",
    icon: "building-blocks",
    tabs: [
      { section: "skills", label: "settings:navTab_skills" },
      { section: "plugins" },
      { section: "library-instructions" },
      { section: "library-subagents" },
      { section: "library-hooks" },
      { section: "library-rtk" },
    ],
  },
  {
    id: "workspace",
    group: "coding",
    label: "settings:navPage_workspace",
    icon: "branch-simple",
    tabs: [
      { section: "worktrees", label: "settings:navTab_worktrees" },
      { section: "terminals", label: "settings:navTab_terminals" },
    ],
  },
  {
    id: "scheduled-tasks",
    group: "coding",
    label: "settings:nav_scheduledTasks",
    icon: "clock",
    tabs: [{ section: "scheduled-tasks" }],
  },
  {
    id: "connections",
    group: "system",
    label: "settings:navPage_connections",
    icon: "devices",
    tabs: [{ section: "connections", label: "settings:navTab_remote" }, { section: "network" }],
  },
  {
    id: "data",
    group: "system",
    label: "settings:navPage_data",
    icon: "shield",
    tabs: [
      { section: "privacy" },
      { section: "sessions", label: "settings:navTab_sessionHistory" },
      { section: "sync" },
      { section: "archived" },
    ],
  },
  {
    id: "host",
    group: "system",
    label: "settings:navPage_host",
    icon: "server",
    tabs: [
      { section: "host" },
      { section: "diagnostics" },
      { section: "observability" },
      { section: "advanced" },
    ],
  },
];

/** Pages with at least one available tab, each listing only its available tabs. */
export const SETTINGS_PAGES: readonly SettingsPage[] = ALL_SETTINGS_PAGES.flatMap((page) => {
  const tabs = page.tabs.filter((tab) => isSettingsSectionAvailable(tab.section));
  return tabs.length > 0
    ? [{ id: page.id, group: page.group, label: page.label, icon: page.icon, tabs }]
    : [];
});

/** The page that shows `section` as a tab; every available section belongs to exactly one. */
export function settingsPageForSection(section: SettingsSectionId): SettingsPage {
  return (
    SETTINGS_PAGES.find((page) => page.tabs.some((tab) => tab.section === section)) ??
    SETTINGS_PAGES[0]!
  );
}

/**
 * The same pages with sections a built-in feature switched off removed. A page
 * whose every tab is hidden disappears, so its nav row goes with it.
 */
export function settingsPagesWithoutSections(
  hiddenSections: ReadonlySet<string>,
): readonly SettingsPage[] {
  if (hiddenSections.size === 0) return SETTINGS_PAGES;
  return SETTINGS_PAGES.flatMap((page) => {
    const tabs = page.tabs.filter((tab) => !hiddenSections.has(tab.section));
    return tabs.length > 0 ? [{ ...page, tabs }] : [];
  });
}

/** The page that shows `section` in a pages list produced by `settingsPagesWithoutSections`. */
export function settingsPageForSectionIn(
  pages: readonly SettingsPage[],
  section: SettingsSectionId,
): SettingsPage {
  return (
    pages.find((page) => page.tabs.some((tab) => tab.section === section)) ??
    pages[0] ??
    SETTINGS_PAGES[0]!
  );
}

export function settingsTabLabel(page: SettingsPage, section: SettingsSectionId): string {
  const tab = page.tabs.find((entry) => entry.section === section);
  return tab?.label ?? ALL_SETTINGS_NAV_ITEMS.find((item) => item.id === section)?.label ?? section;
}

/**
 * Stable DOM id for a settings row, derived from its (string) title. Shared by the row that
 * renders the anchor and by the search index that deep-links to it via `?target=…`, so the
 * two can't drift. Panels stay mounted and render null while inactive, so the slug only needs
 * to be unique within a section.
 */
export function settingRowAnchorId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `setting-${slug}`;
}

/** Retired section ids that still arrive in saved links; each opens the section that replaced it. */
const RETIRED_SETTINGS_SECTIONS: Readonly<Record<string, SettingsSectionId>> = {
  // Connectors and the Library MCP list showed the same servers; one list remains.
  "library-mcp": "connectors",
};

export function normalizeSettingsSection(value: unknown): SettingsSectionId {
  if (typeof value !== "string") {
    return "general";
  }
  const id = Object.hasOwn(RETIRED_SETTINGS_SECTIONS, value)
    ? RETIRED_SETTINGS_SECTIONS[value]!
    : value;
  return (
    SETTINGS_SECTION_IDS.find(
      (candidate) => candidate === id && isSettingsSectionAvailable(candidate),
    ) ?? "general"
  );
}

// Settings is a modal over the app, so closing it returns to the route that was on screen
// before it opened. The chat layout records that route on every non-settings navigation;
// opening /settings directly (no recorded route) falls back to Home.
let lastNonSettingsHref: string | null = null;

export function rememberNonSettingsLocation(href: string): void {
  if (href.startsWith("/settings")) return;
  lastNonSettingsHref = href;
}

export function resolveSettingsReturnLocation(): string {
  const href = lastNonSettingsHref;
  return href && !href.startsWith("/settings") ? href : "/";
}
