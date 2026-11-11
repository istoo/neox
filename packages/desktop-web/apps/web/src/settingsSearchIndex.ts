// FILE: settingsSearchIndex.ts
// Purpose: Declarative, searchable index of settings rows/sections so the sidebar can
//          surface matches by title/description the same way the editor file search does.
// Layer: Route/UI support
// Exports: entry type, the index, section label lookup, and the ranking helper

import { GROUPS_ON } from "~/betaFeatures";
import { isElectron } from "~/env";
import {
  getNavigatorPlatform,
  isLinuxPlatform,
  isMacPlatform,
  isWindowsPlatform,
} from "~/lib/utils";
import { rankProviderDiscoveryItems } from "~/lib/providerDiscovery";
import {
  NEOLIX_DEVICE_UI_ENABLED,
  NEOLIX_KEEP_AWAKE_UI_ENABLED,
  NEOLIX_PINNED_MESSAGES_UI_ENABLED,
  NEOLIX_FEATURE_TOUR_ENABLED,
  NEOLIX_PROVIDER_CLI_UPDATES_ENABLED,
  NEOLIX_RESET_CREDITS_UI_ENABLED,
  NEOLIX_SIDECHAT_UI_ENABLED,
  NEOLIX_USAGE_LIMIT_RECOVERY_UI_ENABLED,
} from "~/neolixFeatures";
import { i18n, t } from "~/i18n";
import {
  isSettingsSectionAvailable,
  SETTINGS_NAV_ITEMS,
  settingsPageForSection,
  settingsTabLabel,
  type SettingsSectionId,
} from "./settingsNavigation";

/**
 * One searchable settings result. `title` is a stable catalog key; `target` is an explicit DOM anchor,
 * independent of the translated heading; `target: null` marks panel-only or conditional rows.
 */
export interface SettingsSearchEntry {
  id: string;
  section: SettingsSectionId;
  title: string;
  keywords: string;
  target?: string | null;
  /**
   * Whether this row exists on the machine the user is actually looking at.
   * Omitted means "always". A search result for a row the panel does not render
   * is a dead end: it scrolls to an anchor that is not there, and it tells the
   * user Synara has a setting it does not.
   */
  applies?: (context: SettingsSearchContext) => boolean;
}

/**
 * What the index needs to know about this server to decide which rows exist.
 * Deliberately a handful of booleans rather than the status objects themselves —
 * the index answers "does this row render", not "what does it say".
 */
export interface SettingsSearchContext {
  /**
   * The desktop backend drives the screen the user is already looking at, so
   * the preview describes the same visible desktop. True only once the status
   * is known.
   */
  readonly computerBackendIsVisibleDesktop: boolean;
}

const DEFAULT_SETTINGS_SEARCH_CONTEXT: SettingsSearchContext = {
  computerBackendIsVisibleDesktop: false,
};

/** DOM id a result deep-links to, or null for panel-level entries with no anchored row. */
export function settingsSearchEntryTarget(entry: SettingsSearchEntry): string | null {
  return entry.target ?? null;
}

// Mirrors row titles/descriptions rendered in settings panels. Panels stay mounted but render
// null while inactive, so the sidebar cannot read every row at runtime; keep this list in sync
// when rows are added, renamed, hidden conditionally, or represented as panel-level results.
export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  // ── General ────────────────────────────────────────────────────────────────
  {
    target: "setting-language",
    id: "general:language",
    section: "general",
    title: "common:general_languageAria",
    keywords: "settings:chooseTheLanguageUsedByTheInterfaceSystemEnglish",
  },
  {
    target: "setting-default-provider",
    id: "general:default-provider",
    section: "general",
    title: "settings:changed_defaultProvider",
    keywords: "settings:chooseTheProviderUsedForNewChatsAgentCodex",
  },
  {
    target: "setting-new-threads",
    id: "general:new-threads",
    section: "general",
    title: "settings:general_newThreads",
    keywords: "settings:pickTheDefaultWorkspaceModeForNewlyCreatedDraft2",
  },
  {
    target: "setting-delete-worktree-on-archive",
    id: "general:delete-worktree-on-archive",
    section: "general",
    title: "settings:deleteWorktreeOnArchive",
    keywords: "settings:afterArchiveSUndoPeriodRemoveACleanWorktree2",
  },
  {
    target: "setting-move-sent-messages-to-top",
    id: "general:move-sent-messages-to-top",
    section: "general",
    title: "settings:moveSentMessagesToTop",
    keywords: "settings:moveEachSentMessageToTheTopOfThe2",
  },
  {
    target: "setting-thread-tabs",
    id: "general:thread-tabs",
    section: "general",
    title: "settings:threadTabs",
    keywords: "settings:showOpenThreadsAsTabsInTheChatHeader3",
  },
  {
    target: "setting-welcome-tour",
    id: "general:welcome-tour",
    section: "general",
    title: "settings:welcomeTour",
    keywords: "settings:replayTheFirstRunSetupFeatureTourProviderSelection2",
  },
  {
    target: "setting-project-order",
    id: "general:project-order",
    section: "general",
    title: "settings:general_projectOrder",
    keywords: "settings:controlsHowProjectsAreArrangedInTheMainSidebar2",
  },
  {
    target: "setting-thread-order",
    id: "general:thread-order",
    section: "general",
    title: "settings:general_threadOrder",
    keywords: "settings:controlsHowThreadsAreArrangedInsideEachProjectIn2",
  },
  {
    target: "setting-working-and-unread-on-top",
    id: "general:thread-attention-first",
    section: "general",
    title: "workspace:workingAndUnreadOnTop",
    keywords: "settings:withRecentlyActiveOrderMoveWorkingAndUnreadThreads",
  },
  {
    target: "setting-chats",
    id: "general:chats-section",
    section: "general",
    title: "workspace:general_chats",
    keywords: "settings:showTheStandaloneChatsListInTheSidebarFooter2",
  },
  {
    target: "setting-hubs",
    id: "general:groups-section",
    section: "general",
    title: "common:hubs",
    keywords: "settings:showTheHubsTabInTheSidebarSwitcherSidebar",
    // Neox 无 Hubs/Groups 后端：该行只在 GROUPS_ON 时渲染。
    applies: () => GROUPS_ON,
  },
  {
    target: "setting-automation-runs",
    id: "general:automation-run-threads",
    section: "general",
    title: "settings:automationRuns",
    keywords: "settings:showTheThreadEachStandaloneAutomationRunCreatesIn",
  },
  {
    target: "setting-open-by-default",
    id: "general:environment-default-open",
    section: "general",
    title: "settings:openByDefault",
    keywords: "settings:openTheChatEnvironmentPanelAutomaticallyOnNormalThreads",
  },
  {
    target: "setting-subagents",
    id: "general:environment-subagents",
    section: "general",
    title: "chat:subagents",
    keywords: "settings:showACompactSummaryOfTheChatSSubagents2",
  },
  {
    target: "setting-usage",
    id: "general:environment-usage",
    section: "general",
    title: "chat:general_usage",
    keywords: "settings:showTheProviderUsageRowInTheChatEnvironment",
  },
  {
    target: "setting-repository",
    id: "general:environment-repository",
    section: "general",
    title: "git:general_repository",
    keywords: "settings:showTheGitHubRepositoryLinkInTheChatEnvironment",
  },
  {
    target: "setting-pull-request",
    id: "general:environment-pull-request",
    section: "general",
    title: "git:general_environmentPullRequest",
    keywords: "settings:showTheOpenPullRequestCIChecksAndReview",
  },
  {
    target: "setting-editor",
    id: "general:environment-editor",
    section: "general",
    title: "chat:general_editor",
    keywords: "settings:showTheEditorSectionInAppEditorViewAnd",
  },
  {
    target: "setting-recap",
    id: "general:environment-recap",
    section: "general",
    title: "chat:recap_label",
    keywords: "settings:showTheAutoGeneratedChatRecapInTheEnvironment",
  },
  {
    target: "setting-pinned-messages",
    id: "general:environment-pinned",
    section: "general",
    title: "settings:general_pinnedMessages",
    keywords: "settings:showThePinnedMessagesChecklistInTheEnvironmentPanel",
    // Neox 无置顶消息后端：该设置行不存在。
    applies: () => NEOLIX_PINNED_MESSAGES_UI_ENABLED,
  },
  {
    target: "setting-project-instructions",
    id: "general:environment-instructions",
    section: "general",
    title: "workspace:general_projectInstructions",
    keywords: "settings:showProjectLevelInstructionsInTheEnvironmentPanel",
  },
  {
    target: "setting-notepad",
    id: "general:environment-notepad",
    section: "general",
    title: "chat:general_notepad",
    keywords: "settings:showThePerThreadNotepadInTheEnvironmentPanel",
  },
  {
    target: "setting-actions",
    id: "general:environment-actions",
    section: "general",
    title: "workspace:actions",
    keywords: "settings:environmentActionsDescription",
  },
  {
    target: "setting-project-actions",
    id: "general:chat-project-actions",
    section: "general",
    title: "workspace:projectActions",
    keywords: "settings:headerActionsDescription",
  },
  {
    target: "setting-session-terminal",
    id: "general:session-terminal",
    section: "general",
    title: "settings:sessionTerminal",
    keywords: "settings:sessionTerminalDescription",
  },
  {
    target: "setting-colorblind",
    id: "general:colorblind-mode",
    section: "general",
    title: "settings:colorblindMode",
    keywords: "settings:colorblindModeDescription",
  },
  {
    target: "setting-reduce-motion",
    id: "general:reduce-motion",
    section: "general",
    title: "settings:reduceMotion",
    keywords: "settings:reduceMotionDescription",
  },
  {
    target: "setting-loading-animation",
    id: "general:loading-animation",
    section: "general",
    title: "settings:loadingAnimation",
    keywords: "settings:loadingAnimationDescription",
  },

  // ── Desktop (Electron only) ──────────────────────────────────────────────────
  {
    target: "setting-desktop-ui-mode",
    id: "desktop:ui-mode",
    section: "desktop",
    title: "settings:desktop_uiMode",
    keywords: "standard classic legacy renderer interface switch restart",
  },
  {
    target: "setting-prevent-sleep",
    id: "desktop:prevent-sleep",
    section: "desktop",
    title: "settings:desktop_preventSleep",
    keywords: "sleep awake power caffeinate display agents working",
  },
  {
    target: "setting-launch-at-login",
    id: "desktop:launch-at-login",
    section: "desktop",
    title: "settings:desktop_launchAtLogin",
    keywords: "login item autostart start sign in boot",
  },
  {
    target: "setting-dock-visible",
    id: "desktop:dock-visible",
    section: "desktop",
    title: "settings:desktop_dockVisible",
    keywords: "dock macos icon hide show",
    // Dock visibility only exists on macOS.
    applies: () => isMacPlatform(getNavigatorPlatform()),
  },
  {
    target: "setting-confirm-quit",
    id: "desktop:confirm-quit",
    section: "desktop",
    title: "settings:desktop_confirmQuit",
    keywords: "quit confirm close app warning",
  },
  {
    target: "setting-lightweight-mode",
    id: "desktop:lightweight-mode",
    section: "desktop",
    title: "settings:desktop_lightweightMode",
    keywords: "memory window close hide renderer",
  },
  {
    target: "setting-keep-daemon-running",
    id: "desktop:keep-daemon-running",
    section: "desktop",
    title: "settings:desktop_keepRunningAfterQuit",
    keywords: "daemon quit background agents keep running server",
  },
  {
    target: "setting-tray-click",
    id: "desktop:tray-click",
    section: "desktop",
    title: "settings:desktop_trayClick",
    keywords: "tray menu bar click window panel quick",
  },
  {
    target: "setting-panel-shortcut",
    id: "desktop:panel-shortcut",
    section: "desktop",
    title: "settings:desktop_panelShortcut",
    keywords: "global shortcut hotkey open panel keyboard",
  },
  {
    target: "setting-update-release-channel",
    id: "desktop:release-channel",
    section: "desktop",
    title: "settings:desktop_releaseChannel",
    keywords: "update stable beta channel release version",
  },
  {
    target: "setting-update-auto-check",
    id: "desktop:auto-check",
    section: "desktop",
    title: "settings:desktop_autoCheck",
    keywords: "update automatic check background interval",
  },
  {
    target: "setting-update-mirror",
    id: "desktop:update-mirror",
    section: "desktop",
    title: "settings:desktop_updateMirror",
    keywords: "update mirror download github proxy url",
  },
  {
    target: "setting-tray-usages",
    id: "desktop:tray-usages",
    section: "desktop",
    title: "settings:desktop_trayUsages",
    keywords: "menu bar allowances quota tray usage today week",
  },
  {
    id: "desktop:omarchy-widget",
    section: "desktop",
    title: "settings:desktop_omarchyWidget",
    keywords: "omarchy bar widget linux hyprland",
    // The row exists only on an Omarchy host; the section stays the target.
    target: null,
    applies: () => isLinuxPlatform(getNavigatorPlatform()),
  },
  {
    target: "setting-command-line-tool",
    id: "desktop:cli",
    section: "desktop",
    title: "settings:desktop_cli",
    keywords: "command line install path terminal neolix cli",
  },

  // ── Appearance ───────────────────────────────────────────────────────────────
  {
    target: "setting-ascii-background",
    id: "appearance:ascii-background",
    section: "appearance",
    title: "settings:asciiBackground",
    keywords: "settings:asciiBackgroundSearch",
  },
  {
    target: "setting-theme",
    id: "appearance:theme",
    section: "appearance",
    title: "onboarding:changed_theme",
    keywords: "settings:chooseHowSynaraLooksAcrossTheAppDarkLight",
  },
  {
    target: "setting-named-theme",
    id: "appearance:named-theme",
    section: "appearance",
    title: "settings:namedTheme",
    keywords: "settings:namedThemeDescription",
  },
  {
    target: "setting-ui-font",
    id: "appearance:interface-font",
    section: "appearance",
    title: "settings:interfaceFont",
    keywords: "settings:interfaceFontDescription",
  },
  {
    target: "setting-ui-font-size",
    id: "appearance:interface-font-size",
    section: "appearance",
    title: "settings:interfaceFontSize",
    keywords: "settings:interfaceFontSizeDescription",
  },
  {
    target: "setting-code-font",
    id: "appearance:code-font",
    section: "appearance",
    title: "settings:codeFont",
    keywords: "settings:codeFontDescription",
  },
  {
    target: "setting-code-font-size",
    id: "appearance:code-font-size",
    section: "appearance",
    title: "settings:codeFontSize",
    keywords: "settings:codeFontSizeDescription",
  },
  {
    target: "setting-chat-width-custom",
    id: "appearance:chat-width-custom",
    section: "appearance",
    title: "settings:chatWidthCustom",
    keywords: "settings:chatWidthCustomDescription",
  },
  {
    target: "setting-vim-keybindings",
    id: "appearance:vim-keybindings",
    section: "appearance",
    title: "settings:vimKeybindings",
    keywords: "settings:vimKeybindingsDescription",
  },
  {
    id: "appearance:app-icon",
    section: "appearance",
    title: "settings:appIcon",
    keywords: "settings:chooseTheIconSynaraUsesInTheDockOr2",
    target: null,
    // 应用图标只由 Electron 壳渲染。
    applies: () => isElectron,
  },
  {
    id: "appearance:custom-title-bar",
    section: "appearance",
    title: "settings:useCustomTitleBar",
    keywords: "settings:framelessWindowSystemTitleBarWindowsLinuxCaptionControls",
    target: null,
    // 与外观页 supportsCustomTitleBarSetting 同一判定。
    applies: () => {
      const platform = getNavigatorPlatform();
      return isElectron && (isWindowsPlatform(platform) || isLinuxPlatform(platform));
    },
  },
  {
    target: "setting-use-system-ui-font",
    id: "appearance:system-ui-font",
    section: "appearance",
    title: "settings:useSystemUIFont",
    keywords: "settings:useTheOperatingSystemInterfaceFontThroughoutSynara",
  },
  {
    target: "setting-ui-density",
    id: "appearance:ui-density",
    section: "appearance",
    title: "settings:changed_uiDensity",
    keywords: "settings:controlSpacingInTheSidebarComposerChatGuttersAnd2",
  },
  {
    target: "setting-chat-width",
    id: "appearance:chat-width",
    section: "appearance",
    title: "settings:chatWidth",
    keywords: "settings:controlHowWideTheChatColumnGrowsSoTables",
  },
  {
    target: "setting-base-font-size",
    id: "appearance:base-font-size",
    section: "appearance",
    title: "settings:changed_baseFontSize",
    keywords: "settings:adjustTheAppTextBaseInPixelsChatAnd",
  },
  {
    target: "setting-terminal-font-size",
    id: "appearance:terminal-font-size",
    section: "appearance",
    title: "settings:changed_terminalFontSize",
    keywords: "settings:adjustTerminalTextIndependentlyFromTheAppAndChat",
  },
  {
    target: "setting-terminal-font",
    id: "appearance:terminal-font",
    section: "appearance",
    title: "settings:changed_terminalFont",
    keywords: "settings:typeAnyMonospaceFontInstalledOnThisDeviceE",
  },
  {
    id: "appearance:font-smoothing",
    section: "appearance",
    title: "settings:changed_fontSmoothing",
    keywords: "settings:useMacOSStyleAntialiasingForLighterCrisperTextRendering",
    target: null,
    // The row only renders on macOS.
    applies: () => isMacPlatform(getNavigatorPlatform()),
  },
  {
    target: "setting-time-format",
    id: "appearance:time-format",
    section: "appearance",
    title: "settings:changed_timeFormat",
    keywords: "settings:systemDefaultFollowsYourBrowserOrOSClockPreference2",
  },

  // ── Notifications ─────────────────────────────────────────────────────────────
  {
    target: "setting-activity-toasts",
    id: "notifications:activity-toasts",
    section: "notifications",
    title: "settings:changed_activityToasts",
    keywords: "settings:showAnInAppToastWhenAChatOr2",
  },
  {
    target: "setting-desktop-notifications",
    id: "notifications:desktop-notifications",
    section: "notifications",
    title: "settings:changed_desktopNotifications",
    keywords: "settings:showAnOSNotificationWhenAChatOrManaged2",
  },
  {
    target: "setting-wait-for-subagents",
    id: "notifications:wait-for-subagents",
    section: "notifications",
    title: "settings:waitForSubagents",
    keywords: "settings:alertOnceTheAgentAndAllOfItsBackground2",
  },

  // ── AppSnap ───────────────────────────────────────────────────────────────────
  {
    target: "setting-enable-appsnap",
    id: "appsnap:enable",
    section: "appsnap",
    title: "settings:enableAppSnap",
    keywords: "settings:captureTheFrontmostMacOSAppWindowWithAConfigurable",
  },
  {
    target: "setting-shortcut",
    id: "appsnap:shortcut",
    section: "appsnap",
    title: "settings:shortcut",
    keywords: "settings:pressTheLeftAndRightOptionKeysAtThe",
  },
  {
    target: "setting-destination",
    id: "appsnap:destination",
    section: "appsnap",
    title: "git:destination",
    keywords: "settings:snapsJoinTheTaskYouInteractedWithInThe",
  },
  {
    target: "setting-capture-sound",
    id: "appsnap:capture-sound",
    section: "appsnap",
    title: "settings:captureSound",
    keywords: "settings:playAShortShutterCueWhenAWindowIs2",
  },
  {
    id: "appsnap:permissions",
    section: "appsnap",
    title: "settings:permissionStatus",
    keywords: "settings:inputMonitoringAndScreenRecordingPermissionsForAppSnapIn",
    // Renders only in the macOS desktop app, so no stable anchor on other platforms.
    target: null,
  },

  // ── Computer use ──────────────────────────────────────────────────────────────
  {
    id: "computer:status",
    section: "computer",
    title: "settings:computerStatus",
    keywords: "settings:whetherAgentsCanSeeAndControlThisComputerS",
    // The status row is conditional and its title is dynamic (Ready /
    // Reconnecting / Unavailable), so link to the section rather than an
    // anchored row.
    target: null,
  },
  {
    target: "setting-preview",
    id: "computer:open-automatically",
    section: "computer",
    title: "workspace:settings_gitToastPreview",
    keywords: "settings:showTheInChatComputerPreviewTheFirstTime",
    applies: () => true,
  },
  {
    target: "setting-computer-control",
    id: "computer:how-agents-use-the-desktop",
    section: "computer",
    title: "settings:computerControl",
    keywords: "settings:letTheAgentUseTheDesktopInAnyChat2",
  },
  {
    target: "setting-cursor-colors",
    id: "computer:cursor-colors",
    section: "computer",
    title: "settings:cursorColors",
    keywords: "settings:theAgentPointerSColorsStockMonochromeByDefault",
  },
  {
    id: "computer:always-allowed",
    section: "computer",
    title: "settings:alwaysAllowed",
    keywords: "settings:durablePerAppAlwaysAllowGrantsFromComputerApprovals",
    target: null,
  },

  // ── Behavior ──────────────────────────────────────────────────────────────────
  {
    target: "setting-side-chat-expiry",
    id: "behavior:sidechat-expiry",
    section: "behavior",
    title: "settings:sideChatExpiry",
    keywords: "settings:expireASideChatAfterItSitsIdleFor",
    // Neox 无 side chat 后端：该设置行不存在。
    applies: () => NEOLIX_SIDECHAT_UI_ENABLED,
  },
  {
    target: "setting-follow-up-behavior",
    id: "behavior:follow-up-behavior",
    section: "behavior",
    title: "settings:followUpBehavior",
    keywords: "settings:chooseWhetherMessagesSentDuringAnActiveTurnWait",
  },
  {
    target: "setting-enter-while-dictating",
    id: "behavior:enter-while-dictating",
    section: "behavior",
    title: "settings:enterWhileDictating",
    keywords: "settings:chooseWhatEnterDoesWhileAVoiceNoteIs2",
  },
  {
    target: "setting-assistant-output",
    id: "behavior:assistant-output",
    section: "behavior",
    title: "settings:changed_assistantOutput",
    keywords: "settings:showTokenByTokenOutputWhileAResponseIs2",
  },
  {
    target: "setting-fold-finished-turns",
    id: "behavior:fold-finished-turns",
    section: "behavior",
    title: "settings:foldFinishedTurns",
    keywords: "settings:hideAFinishedTurnSToolCallsAndIntermediate",
  },
  {
    target: "setting-effort-slider",
    id: "behavior:effort-slider",
    section: "behavior",
    title: "settings:effortSlider",
    keywords: "settings:showReasoningEffortAsASliderInTheComposer",
  },
  {
    target: "setting-automatically-open-simulator",
    id: "behavior:auto-open-simulator",
    section: "behavior",
    title: "settings:automaticallyOpenSimulator",
    keywords: "settings:disableAutomaticIOSSimulatorDevicePaneOpeningUseSimulator",
    // Neox 无 device 后端：该设置行不存在。
    applies: () => NEOLIX_DEVICE_UI_ENABLED,
  },
  {
    target: "setting-open-pull-requests-and-issues",
    id: "behavior:github-link-destination",
    section: "behavior",
    title: "settings:openPullRequestsAndIssues",
    keywords: "settings:chooseWhereGitHubLinksInChatsOpenBuiltIn",
  },
  {
    target: "setting-pull-request-diff-colors",
    id: "behavior:pull-request-diff-colors",
    section: "behavior",
    title: "settings:pullRequestDiffColors",
    keywords: "settings:showAdditionsInGreenAndDeletionsInRedIn2",
  },
  {
    target: "setting-include-fork-upstreams",
    id: "behavior:include-fork-upstreams",
    section: "behavior",
    title: "settings:includeForkUpstreams",
    keywords: "settings:alsoListPullRequestsAndIssuesFromEachProject2",
  },
  {
    target: "setting-diff-layout",
    id: "behavior:diff-layout",
    section: "behavior",
    title: "settings:diffLayout",
    keywords: "settings:defaultStackedSplitReviewPanelSideBySideUnified",
  },
  {
    target: "setting-diff-line-wrapping",
    id: "behavior:diff-line-wrapping",
    section: "behavior",
    title: "settings:changed_diffLineWrapping",
    keywords: "settings:setTheDefaultWrapStateWhenTheDiffPanel",
  },
  {
    target: "setting-delete-confirmation",
    id: "behavior:delete-confirmation",
    section: "behavior",
    title: "settings:changed_deleteConfirmation",
    keywords: "settings:askBeforeDeletingAThreadAndItsChatHistory2",
  },
  {
    target: "setting-archive-confirmation",
    id: "behavior:archive-confirmation",
    section: "behavior",
    title: "settings:changed_archiveConfirmation",
    keywords: "settings:askBeforeArchivingAThreadSafetyConfirm",
  },
  {
    target: "setting-terminal-close-confirmation",
    id: "behavior:terminal-close-confirmation",
    section: "behavior",
    title: "settings:changed_terminalCloseConfirmation",
    keywords: "settings:askBeforeClosingATerminalTabAndClearingIts2",
  },
  {
    id: "behavior:keep-computer-awake",
    section: "behavior",
    title: "common:keepComputerAwake",
    keywords: "settings:caffeinateSleepMacOSPreventSleepKeepAwakeAgentWorking",
    // Row only renders on macOS with caffeinate available.
    target: null,
    // Neox 无 keep-awake 服务：该设置行不存在。
    applies: () => NEOLIX_KEEP_AWAKE_UI_ENABLED,
  },

  // ── Keybindings ───────────────────────────────────────────────────────────────
  {
    id: "shortcuts:keyboard-shortcuts",
    section: "shortcuts",
    title: "common:advanced_keybindings",
    keywords: "settings:everyKeyboardShortcutAvailableInSynaraChangeAddRemove",
    target: null,
  },

  // ── Worktrees ─────────────────────────────────────────────────────────────────
  {
    id: "worktrees:managed-worktrees",
    section: "worktrees",
    title: "onboarding:managedWorktrees",
    keywords: "settings:reviewAndCleanUpTheWorktreesCreatedBySynara",
    target: null,
  },

  // ── Archived ──────────────────────────────────────────────────────────────────
  {
    id: "archived:archived-threads",
    section: "archived",
    title: "settings:archivedThreads",
    keywords: "settings:viewAndRestoreArchivedThreadsUnarchiveHistory",
    target: null,
  },

  // ── Models ────────────────────────────────────────────────────────────────────
  {
    target: "setting-source-control-writing-style",
    id: "models:source-control-writing-style",
    section: "models",
    title: "settings:sourceControlWritingStyle",
    keywords: "settings:repositoryConventionsConventionalCommitsCustomInstructionsCommitMessagesPR",
  },
  {
    target: "setting-git-writing-model",
    id: "models:git-writing-model",
    section: "models",
    title: "settings:changed_gitWritingModel",
    keywords: "settings:usedForGeneratedCommitMessagesPRTitlesAndBranch",
  },
  {
    target: "setting-saved-model-slugs",
    id: "models:saved-model-slugs",
    section: "models",
    title: "settings:models_savedModelSlugs",
    keywords: "settings:addCustomModelSlugsForSupportedProvidersCustomModel",
  },

  // ── Providers ─────────────────────────────────────────────────────────────────
  {
    target: "setting-resume-after-usage-limits",
    id: "providers:usage-limit-recovery",
    section: "providers",
    title: "settings:resumeAfterUsageLimits",
    keywords: "settings:resumeAfterUsageLimitsDescription",
    // Neox 无 usage-limit 自动恢复后端：该设置行不存在。
    applies: () => NEOLIX_USAGE_LIMIT_RECOVERY_UI_ENABLED,
  },
  {
    target: "setting-keep-synara-responsive",
    id: "providers:cpu-priority",
    section: "providers",
    title: "settings:keepSynaraResponsive",
    keywords: "settings:lowerAgentCPUSchedulingPriorityPerformanceLoadNiceResponsiveness",
  },
  {
    target: "setting-automatic-cli-update-checks",
    id: "providers:automatic-cli-update-checks",
    section: "providers",
    title: "settings:providerUpdates_automaticCliUpdateChecks",
    keywords: "settings:checkCodexClaudeAndOtherProviderCLIsForNewer2",
    applies: () => NEOLIX_PROVIDER_CLI_UPDATES_ENABLED,
  },
  {
    target: "setting-enabled-providers",
    id: "providers:enabled-providers",
    section: "providers",
    title: "settings:enabledProviders",
    keywords: "settings:allowBackgroundChecksAndNewTurnsEnablingAProvider",
  },
  {
    target: "setting-available-clis",
    id: "providers:available-clis",
    section: "providers",
    title: "settings:availableCLIs",
    keywords: "settings:showOrHideInstalledProvidersInThePickerAnd",
  },
  {
    target: "setting-provider-updates",
    id: "providers:provider-updates",
    section: "providers",
    title: "settings:providerUpdates_providerUpdates",
    keywords: "settings:updateInstalledProviderToolsThatSynaraCanSafelyUpdate",
    applies: () => NEOLIX_PROVIDER_CLI_UPDATES_ENABLED,
  },
  {
    target: "setting-installed-clis",
    id: "providers:installed-clis",
    section: "providers",
    title: "settings:providers_installedClis",
    keywords: "settings:reviewProviderVersionsAndUpdateToolsBinaryOverridesPath",
  },

  // ── Skills ────────────────────────────────────────────────────────────────────
  {
    id: "skills:skills",
    section: "skills",
    title: "common:plugin_skillsSection",
    keywords: "settings:everySkillFoundAcrossProvidersWithTogglesToControl",
    target: null,
  },

  // ── Usage ─────────────────────────────────────────────────────────────────────
  {
    id: "usage:usage",
    section: "usage",
    title: "settings:usageAndBilling",
    keywords: "settings:remainingQuotaAndCreditsForEachSignedInProvider",
    target: null,
  },

  {
    id: "usage:sidebar-rings",
    section: "usage",
    title: "settings:sidebarUsageRings",
    keywords: "settings:chooseUpToTwoProviderAccountsForUsageRings",
    target: "setting-usage-ring",
  },
  {
    target: "setting-usage-details-default",
    id: "usage:details-default",
    section: "usage",
    title: "settings:showDetailsByDefault",
    keywords: "settings:openTheDetailsBelowTheLimitsWhenOffThey",
  },
  {
    target: "setting-usage-banked-resets",
    id: "usage:banked-resets",
    section: "usage",
    title: "common:bankedResets",
    keywords: "settings:includeCodexBankedResetsInTheDetails",
    applies: () => NEOLIX_RESET_CREDITS_UI_ENABLED,
  },
  {
    target: "setting-usage-credits-tokens",
    id: "usage:credits-and-tokens",
    section: "usage",
    title: "settings:creditsAndTokenTotals",
    keywords: "settings:includeCreditBalancesAndRecentTokenTotals24h7d",
  },

  // ── Advanced ──────────────────────────────────────────────────────────────────
  {
    target: "setting-keybindings",
    id: "advanced:keybindings",
    section: "advanced",
    title: "common:advanced_keybindings",
    keywords: "settings:openThePersistedKeybindingsJsonFileToEditAdvanced2",
  },
  {
    target: "setting-recovery-tools",
    id: "advanced:recovery-tools",
    section: "advanced",
    title: "settings:advanced_recoveryTools",
    keywords: "settings:advanced_recoveryToolsDescription",
  },
  {
    id: "connectors:catalog",
    section: "connectors",
    title: "settings:connectors",
    keywords: "settings:connectorsSearch",
    target: null,
    applies: () => isSettingsSectionAvailable("connectors"),
  },
  {
    target: "setting-external-mcp-integrations",
    id: "integrations:external-mcp",
    section: "integrations",
    title: "settings:externalMCPIntegrations",
    keywords: "settings:pairCodexClaudeAndOtherLocalMCPClientsWith",
  },
  // ── Connections ───────────────────────────────────────────────────────
  {
    id: "connections:this-computer",
    section: "connections",
    title: "settings:hostNav_searchControlThisComputer",
    keywords:
      "Devices that can control this Mac or computer. allow connections add iphone ipad qr code pairing approve revoke access trusted devices",
    target: null,
  },
  {
    id: "connections:keep-awake",
    section: "connections",
    title: "settings:hostNav_searchKeepAwake",
    keywords:
      "Keep the Mac awake while plugged in and remote access is on. prevent sleep power battery",
    target: null,
    // Neox 无 keep-awake 服务：该设置行不存在。
    applies: () => NEOLIX_KEEP_AWAKE_UI_ENABLED,
  },
  {
    id: "connections:other-computers",
    section: "connections",
    title: "settings:hostNav_searchControlOtherDevices",
    keywords:
      "Computers you can control from this one. host server laptop connect open remote relay back to this computer disconnect forget pairing code share workspace discoverable",
    target: null,
  },
  {
    id: "connections:ssh",
    section: "connections",
    title: "SSH",
    keywords:
      "Link a headless machine with a short code, or forward the SSH port. device code link approve vps cli browserless",
    target: null,
  },
  {
    id: "connections:advanced",
    section: "connections",
    title: "settings:hostNav_searchAccountDevices",
    keywords:
      "Advanced: devices signed in to your account, active sessions, and unlinking this machine. revoke sign out lost stolen last used end session unlink",
    target: null,
  },
  {
    target: "setting-version",
    id: "advanced:version",
    section: "advanced",
    title: "settings:advanced_version",
    keywords: "settings:currentApplicationVersionAbout",
  },
  {
    target: "setting-what-s-new-since-0-9-2",
    id: "advanced:feature-tour",
    section: "advanced",
    title: "settings:whatSNewSince092",
    keywords: "settings:replayFeatureTourRedesignedWorkspaceProviderAccountsCodeReview",
    applies: () => NEOLIX_FEATURE_TOUR_ENABLED,
  },
  // ── Neox host settings ──────────────────────────────────────────────────
  {
    id: "host:daemon",
    section: "host",
    title: "settings:host_sectionHost",
    keywords:
      "daemon restart update version pid listen server id auto archive terminal hooks idle runtime resume system prompt",
    target: null,
  },
  {
    target: "setting-host-restart",
    id: "host:restart-daemon",
    section: "host",
    title: "settings:host_restartDaemon",
    keywords: "settings:host_restartDaemonDescription",
  },
  {
    target: "setting-host-update",
    id: "host:update-daemon",
    section: "host",
    title: "settings:host_updateDaemon",
    keywords: "settings:host_updateDaemonDescription",
  },
  {
    target: "setting-host-append-system-prompt",
    id: "host:append-system-prompt",
    section: "host",
    title: "settings:host_appendSystemPrompt",
    keywords: "settings:host_appendSystemPromptDescription",
  },
  {
    id: "network:sharing",
    section: "network",
    title: "settings:hostNav_network",
    keywords: "share on local network lan port listen addresses reachable remote",
    target: null,
  },
  {
    target: "setting-network-port",
    id: "network:port",
    section: "network",
    title: "settings:host_port",
    keywords: "settings:host_portDescription",
  },
  {
    target: "setting-network-allow-ips",
    id: "network:allow-ips",
    section: "network",
    title: "settings:host_allowIPs",
    keywords: "settings:host_allowIPsDescription",
  },
  {
    target: "setting-network-github-token",
    id: "network:github-token",
    section: "network",
    title: "settings:host_githubToken",
    keywords: "settings:host_githubTokenDescription",
  },
  {
    target: "setting-network-page-key",
    id: "network:page-key",
    section: "network",
    title: "settings:host_pageNewKey",
    keywords: "访问密钥 access key browser page link 浏览器访问",
  },
  {
    id: "privacy:reads",
    section: "privacy",
    title: "settings:hostNav_privacy",
    keywords: "session reads history provider sessions telemetry usage sharing",
    target: null,
  },
  {
    target: "setting-privacy-subscription-accounts",
    id: "privacy:subscription-accounts",
    section: "privacy",
    title: "settings:host_subscriptionAccounts",
    keywords: "settings:host_subscriptionAccountsDescription",
  },
  {
    target: "setting-privacy-read-sessions",
    id: "privacy:read-sessions",
    section: "privacy",
    title: "settings:host_readAgentSessions",
    keywords: "settings:host_readAgentSessionsDescription",
  },
  {
    id: "observability:otel",
    section: "observability",
    title: "settings:hostNav_observability",
    keywords: "opentelemetry otel trace export collector endpoint spans metrics bodies",
    target: null,
  },
  {
    target: "setting-observability-export-traces",
    id: "observability:export-traces",
    section: "observability",
    title: "settings:host_exportTraces",
    keywords: "settings:host_exportTracesDescription",
  },
  {
    target: "setting-observability-collector-endpoint",
    id: "observability:collector-endpoint",
    section: "observability",
    title: "settings:host_collectorEndpoint",
    keywords: "settings:host_collectorEndpointDescription",
  },
  {
    id: "diagnostics:host",
    section: "diagnostics",
    title: "settings:hostNav_diagnostics",
    keywords: "diagnostics log path daemon config folder report sandbox app logs updater",
    target: null,
  },
  {
    id: "sync:backup",
    section: "sync",
    title: "settings:hostNav_sync",
    keywords: "sync webdav s3 github remote restore backups automatic interval passphrase",
    target: null,
  },
  {
    target: "setting-sync-auto-backups",
    id: "sync:auto-backups",
    section: "sync",
    title: "settings:hostData_autoBackups",
    keywords: "settings:hostData_autoSummary",
  },
  {
    target: "setting-sync-include-signins",
    id: "sync:include-sign-ins",
    section: "sync",
    title: "settings:hostData_includeSignIns",
    keywords: "访问密钥 access key credentials sign-ins subscription",
  },
  {
    id: "quota:alerts",
    section: "quota",
    title: "settings:hostNav_quota",
    keywords: "usage allowance alerts threshold balance notify provider quota",
    target: null,
  },
  {
    target: "setting-quota-read-usage",
    id: "quota:read-provider-usage",
    section: "quota",
    title: "settings:host_readProviderUsage",
    keywords: "settings:host_readProviderUsageDescription",
  },
  {
    target: "setting-quota-window-alert",
    id: "quota:window-alert",
    section: "quota",
    title: "settings:host_notifyWindowUsed",
    keywords: "settings:host_notifyWindowUsedDescription",
  },
  {
    target: "setting-quota-balance-alert",
    id: "quota:balance-alert",
    section: "quota",
    title: "settings:host_notifyBalance",
    keywords: "settings:host_notifyBalanceDescription",
  },
  {
    target: "setting-quota-reset-reminder",
    id: "quota:reset-reminder",
    section: "quota",
    title: "settings:host_resetReminder",
    keywords: "settings:host_resetReminderDescription",
  },
  {
    id: "terminals:profiles",
    section: "terminals",
    title: "settings:host_terminalProfiles",
    keywords: "terminal profile command args custom shell launch",
    target: null,
  },
  {
    id: "voice:speech",
    section: "voice",
    title: "settings:hostNav_voice",
    keywords: "dictation voice mode speech stt tts local models download",
    target: null,
  },
  {
    id: "sessions:history",
    section: "sessions",
    title: "settings:hostData_sessions",
    keywords: "external sessions provider history search resume open in terminal",
    target: null,
  },
  {
    target: "setting-sessions-search",
    id: "sessions:search",
    section: "sessions",
    title: "settings:hostData_search",
    keywords: "settings:hostData_searchDescription",
  },
  {
    target: "setting-sessions-agent",
    id: "sessions:agent-filter",
    section: "sessions",
    title: "settings:hostData_agentLabel",
    keywords: "settings:hostData_agentDescription",
  },
  {
    id: "library-instructions:shared",
    section: "library-instructions",
    title: "settings:library_nav_instructions",
    keywords: "library instructions shared rules agents guidance AGENTS.md CLAUDE.md",
    target: null,
  },
  {
    id: "connectors:servers",
    section: "connectors",
    title: "settings:library_nav_mcp",
    keywords: "library mcp servers stdio http sse oauth market discover import backups hub",
    target: null,
  },
  {
    id: "library-hooks:list",
    section: "library-hooks",
    title: "settings:library_nav_hooks",
    keywords: "library hooks lifecycle turn tool prompt session command matcher",
    target: null,
  },
  {
    id: "library-subagents:list",
    section: "library-subagents",
    title: "settings:library_nav_subagents",
    keywords: "library subagents prompts skills mcp agents delegation",
    target: null,
  },
  {
    id: "library-rtk:status",
    section: "library-rtk",
    title: "settings:library_nav_rtk",
    keywords: "library rtk token killer install upgrade savings agents",
    target: null,
  },
  {
    id: "gateway:overview",
    section: "gateway",
    title: "gateway:tab_overview",
    keywords: "model gateway providers routing keys usage allowances masking budget",
    target: null,
  },
  {
    id: "gateway:providers",
    section: "gateway",
    title: "gateway:tab_providers",
    keywords: "gateway model sources providers accounts api key base url test detect import",
    target: null,
  },
  {
    id: "gateway:routing",
    section: "gateway",
    title: "gateway:tab_routing",
    keywords: "gateway routing groups members strategy weights history trace",
    target: null,
  },
  {
    id: "gateway:keys",
    section: "gateway",
    title: "gateway:tab_keys",
    keywords: "gateway keys access limits budget oidc read only expires",
    target: null,
  },
  {
    id: "gateway:usage",
    section: "gateway",
    title: "gateway:tab_usage",
    keywords: "gateway usage requests sessions context cost tokens csv check in tune",
    target: null,
  },
  {
    id: "gateway:allowances",
    section: "gateway",
    title: "gateway:tab_allowances",
    keywords: "gateway quota allowances 5h 7d warm reset spend windows",
    target: null,
  },
  {
    id: "gateway:advanced",
    section: "gateway",
    title: "gateway:tab_advanced",
    keywords: "gateway budget proxy search middleware aliases json subscriptions codex",
    target: null,
  },
  {
    id: "gateway:masking",
    section: "gateway",
    title: "gateway:tab_masking",
    keywords: "gateway masking redaction secrets personal allow words records preview",
    target: null,
  },
  {
    id: "plugins:browser",
    section: "plugins",
    title: "settings:nav_plugins",
    keywords: "plugins extensions market install enable disable builtin registry npm git folder",
    target: null,
  },
  {
    id: "scheduled-tasks:list",
    section: "scheduled-tasks",
    title: "settings:nav_scheduledTasks",
    keywords: "scheduled tasks automations schedule create new run pause cadence",
    target: null,
  },
  {
    id: "agent-profiles",
    section: "agent-profiles",
    title: "settings:agentProfiles_nav",
    keywords: "agent profiles saved setups provider model mode reasoning notes preset",
    target: null,
  },
] as const;

const SETTINGS_SECTION_LABEL_BY_ID = new Map<SettingsSectionId, string>(
  SETTINGS_NAV_ITEMS.map((item) => [item.id, item.label]),
);

const SETTINGS_SECTION_DESCRIPTION_BY_ID = new Map<SettingsSectionId, string>(
  SETTINGS_NAV_ITEMS.map((item) => [item.id, item.description]),
);

/** Where a row lives as the sidebar names it: "Page › Tab", or just the page for one tab. */
export function settingsSectionLabel(section: SettingsSectionId): string {
  const page = settingsPageForSection(section);
  if (!page.tabs.some((tab) => tab.section === section)) {
    const label = SETTINGS_SECTION_LABEL_BY_ID.get(section);
    return label === undefined ? section : t(label);
  }
  if (page.tabs.length === 1) return t(page.label);
  return `${t(page.label)} › ${t(settingsTabLabel(page, section))}`;
}

/**
 * Subsequence matching turns 1-3 character Latin queries into noise (`Vim` matches
 * `arCHIVE CONFIRMation`, `PR` matches most copy). For those, require an exact,
 * prefix, word-boundary, or phrase hit.
 */
function allowsFuzzySettingsMatch(query: string): boolean {
  const trimmed = query.trim();
  return !(trimmed.length > 0 && trimmed.length <= 3 && /^[a-z0-9]+$/i.test(trimmed));
}

/**
 * Fuzzy-rank settings rows for the sidebar search. Title carries the strongest intent;
 * the description/synonym keywords and the owning section label match more loosely so a
 * query like "appearance" or "wrap" still surfaces the right rows.
 */
export function rankSettingsSearchEntries(
  query: string,
  limit: number,
  context: SettingsSearchContext | undefined = DEFAULT_SETTINGS_SEARCH_CONTEXT,
): readonly SettingsSearchEntry[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const resolvedContext = context ?? DEFAULT_SETTINGS_SEARCH_CONTEXT;
  const available = SETTINGS_SEARCH_ENTRIES.filter(
    // Neox 隐藏了没有后端的设置分区，其搜索行也必须一起消失。
    (entry) =>
      isSettingsSectionAvailable(entry.section) && (entry.applies?.(resolvedContext) ?? true),
  );
  const ranked = rankProviderDiscoveryItems(
    available,
    trimmed,
    (entry) => [
      { value: i18n.t(entry.title, { lng: "en" }) },
      { value: i18n.t(entry.title, { lng: i18n.language, defaultValue: entry.title }) },
      { value: i18n.t(entry.keywords, { lng: "en" }), weight: 200 },
      {
        value: i18n.t(entry.keywords, { lng: i18n.language, defaultValue: entry.keywords }),
        weight: 200,
      },
      {
        value: i18n.t(SETTINGS_SECTION_LABEL_BY_ID.get(entry.section) ?? entry.section, {
          lng: "en",
        }),
        weight: 400,
      },
      {
        value: i18n.t(SETTINGS_SECTION_LABEL_BY_ID.get(entry.section) ?? entry.section, {
          lng: i18n.language,
        }),
        weight: 400,
      },
      // Chinese (and any other non-English) queries need the translated section copy:
      // keywords are English-only, so "网关" must find the gateway section by its
      // "本机网关的…" description.
      {
        value: i18n.t(SETTINGS_SECTION_DESCRIPTION_BY_ID.get(entry.section) ?? "", {
          lng: "en",
        }),
        weight: 400,
      },
      {
        value: i18n.t(SETTINGS_SECTION_DESCRIPTION_BY_ID.get(entry.section) ?? "", {
          lng: i18n.language,
          defaultValue: "",
        }),
        weight: 400,
      },
      // The sidebar names pages and tabs, so their labels must find the rows too.
      {
        value: i18n.t(settingsPageForSection(entry.section).label, { lng: "en" }),
        weight: 400,
      },
      {
        value: i18n.t(settingsPageForSection(entry.section).label, { lng: i18n.language }),
        weight: 400,
      },
      {
        value: i18n.t(settingsTabLabel(settingsPageForSection(entry.section), entry.section), {
          lng: i18n.language,
        }),
        weight: 400,
      },
    ],
    { allowFuzzy: allowsFuzzySettingsMatch(trimmed) },
  );
  return ranked.slice(0, limit);
}
