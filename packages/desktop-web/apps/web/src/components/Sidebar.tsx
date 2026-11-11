import {
  dispatchSelectedWorkspaceChatCreation,
  openWorkspacePath,
} from "../lib/hosts/workspaceCommands";
import {
  OPEN_CREATE_PROJECT_EVENT,
  type WorkspaceSidebarKeyboardEvent,
} from "../lib/hosts/workspaceFrame";
import { WorkspaceProjectItem, WorkspaceThreadRow } from "./hosts/WorkspaceProjects";
import { SidebarProjectRowContent } from "./SidebarProjectRowContent";
import {
  readAvailableWorkspaceNavigation,
  useWorkspaceSessions,
  type WorkspaceSession,
} from "../lib/hosts/workspaceSessions";
import {
  workspaceActivityRows,
  workspaceThreadKey,
  deriveWorkspaceProjectThreadRows,
  mergeSidebarProjects,
  mergeSidebarChats,
  remoteSidebarProjects,
  type WorkspaceProjectEntry,
  type WorkspaceThreadEntry,
} from "../lib/hosts/workspaceSidebar";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { executionKey } from "../lib/hosts/executionContext";
import * as Schema from "effect/Schema";
import { CATALOG_OPEN_EVENT } from "~/lib/projectCatalog/navigation";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import { checkoutKey, type CheckoutRef } from "~/lib/projectCatalog/model";
import { PR_STATE_LABEL_KEYS } from "./pullRequest/pullRequestStatePresentation";
import { THREAD_STATUS_LABEL_KEYS } from "./Sidebar.logic";
import { useProjectImportDialogStore } from "~/projectImport/projectImportDialogStore";
// FILE: Sidebar.tsx
// Purpose: Renders the project/thread sidebar, including row status, sorting, and thread actions.
// Exports: Sidebar

import {
  AddPlusIcon,
  ArchiveIcon,
  BookIcon,
  BotIcon,
  CircleCheckIcon,
  CircleQuestionIcon,
  ClockIcon,
  CodeReviewIcon,
  CopyIcon,
  GitBranchIcon,
  GlobeIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  GiftIcon,
  KanbanIcon,
  SettingsIcon,
  KeyboardIcon,
  BellIcon,
  type LucideIcon,
  NewThreadIcon,
  PencilIcon,
  PinIcon,
  PlayIcon,
  RefreshCwIcon,
  SearchIcon,
  StopFilledIcon,
  TemporaryThreadIcon,
  TerminalIcon,
  Trash2,
  TriangleAlertIcon,
  WorktreeIcon,
  XIcon,
} from "~/lib/icons";
import { createCentralIconComponent } from "~/lib/central-icons";
import {
  PR_STATE_PRESENTATION_ICONS,
  resolvePrStatePresentation,
} from "~/components/pullRequest/pullRequestStatePresentation";
import { PinStatusIcon, pinActionLabel } from "~/lib/pin";
import { THREAD_CONTEXT_MENU_ICONS } from "~/lib/contextMenuIcons";
import { useArchivedWorkspaceLedger } from "~/lib/archivedWorkspaces";
import {
  findWorkspaceForDirectory,
  neolixArchivedWorkspacesQueryKey,
  neolixWorkspaceLabelsQueryOptions,
  neolixWorkspacesQueryKey,
  neolixWorkspacesQueryOptions,
  resolveWorkspaceLabelsForDirectory,
} from "~/lib/workspaceLabels";
import {
  getActiveComposerSendThreadIds,
  subscribeComposerSends,
} from "~/lib/composerSendOwnership";
import { autoAnimate } from "@formkit/auto-animate";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  lazy,
  startTransition,
  useMemo,
  useRef,
  useSyncExternalStore,
  Suspense,
  useState,
  type DragEvent as ReactDragEvent,
  type ComponentType,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  DndContext,
  type DragCancelEvent,
  type CollisionDetection,
  PointerSensor,
  type DragStartEvent,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  type AutomationDefinition,
  MAX_PINNED_PROJECTS,
  type DesktopUpdateState,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadPullRequest,
  PROVIDER_DISPLAY_NAMES,
  ProjectId,
  SpaceId,
  ThreadId,
  type ResolvedKeybindingsConfig,
  WS_GITHUB_PROJECT_PROVISIONING_CAPABILITY,
} from "@synara/contracts";
import { isGenericChatThreadTitle } from "@synara/shared/chatThreads";
import { parseGitHubRepositoryNameWithOwnerFromPullRequestUrl } from "@synara/shared/githubRepository";
import { getDefaultModel } from "@synara/shared/model";
import { resolveThreadWorkspaceCwd } from "@synara/shared/threadEnvironment";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import {
  type SidebarThreadSortOrder,
  getProviderInstanceOptions,
  type ProviderInstanceOption,
  useAppSettings,
} from "../appSettings";
import { PluginSidebarItems } from "~/plugins/PluginSidebarItems";
import {
  isPluginAgentActionItemId,
  pluginAgentActionItems,
  runPluginAgentActionItem,
} from "~/plugins/PluginRowActions";
import { ensurePluginCatalogLoaded, readPluginCatalog } from "~/plugins/catalog";
import { usePluginCommandActions } from "~/plugins/usePluginCommandActions";
import { usePluginThemeActions } from "~/plugins/usePluginThemeActions";
import { isElectron } from "../env";
import { formatRelativeTime } from "../lib/relativeTime";
import {
  isMacNavigatorPlatform,
  newCommandId,
  newMessageId,
  newProjectId,
  newThreadId,
  randomUUID,
} from "../lib/utils";
import { isOrdinarySpaceProject } from "../lib/spaces";
import { expandProjectHomePath, joinProjectPath } from "../lib/projectPaths";
import { reconcileDeletedThreadsFromClient } from "../lib/deletedThreadClientReconciliation";
import { deleteProjectFromClient } from "../lib/projectDelete";
import { persistAppStateNow, useStore } from "../store";
import { useThreadIdsWithPendingDraft } from "../composerDraftStore";
import { getThreadFromState } from "../threadDerivation";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHints,
  spaceJumpCommandForIndex,
  spaceJumpIndexFromCommand,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
} from "../keybindings";
import {
  collectSnoozedThreadIds,
  createAllThreadsSelector,
  createProjectLastActivityAtSelector,
  createSidebarDisplayThreadsSelector,
  isSidebarThreadVisible,
} from "../storeSelectors";
import { derivePendingApprovals, derivePendingUserInputs } from "../session-logic";
import { useActivityThreads } from "../hooks/useActivityThreads";
import { useCommittedPathname } from "../hooks/useCommittedPathname";
import {
  resolveThreadPullRequestFallback,
  type ThreadPullRequest,
  useThreadPullRequests,
} from "../hooks/useThreadPullRequests";
import {
  providerComposerCapabilitiesQueryOptions,
  providerModelsQueryOptions,
} from "../lib/providerDiscoveryReactQuery";
import {
  buildThreadImportCandidates,
  filterThreadImportTargetsByCapabilities,
  type ThreadImportTarget,
} from "../lib/threadImport";
import {
  resolveCurrentProjectTargetId,
  resolveLatestProjectTargetIdWithFallback,
  resolveNewThreadTarget,
} from "../lib/projectShortcutTargets";
import { githubInboxQueryKeys, pullRequestQueryKeys } from "../lib/pullRequestReactQuery";
import { prefetchModelsForNewThread } from "../lib/providerModelPrefetch";
import { resolveProviderDiscoveryCwd } from "../lib/providerDiscovery";
import { modelQueryOptionsForProviderInstance } from "../hooks/useProviderModelCatalog";
import {
  hasReconciledServerProviderStatuses,
  serverConfigQueryOptions,
} from "../lib/serverReactQuery";
import {
  onNativeApiServerCapabilitiesChange,
  readNativeApi,
  readNativeApiServerCapability,
} from "../nativeApi";
import { isHomeChatContainerProject, prewarmHomeChatProject } from "../lib/chatProjects";
import { createGroupProject, isGroupContainerProject } from "../lib/groupProjects";
import { useProjectEnvironmentStore } from "../projectEnvironmentStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { useLatestProjectStore } from "../latestProjectStore";
import {
  resolveThreadEnvironmentPresentation,
  type ForkThreadTarget,
} from "../lib/threadEnvironment";
import { canForkThread, dispatchThreadFork, forkThreadTargetLabel } from "../lib/threadFork";
import { contextMenuGroup } from "../lib/contextMenuGroup";
import { registerThreadContextMenu, type ThreadContextMenuOptions } from "../lib/threadContextMenu";
import { gitBranchesQueryOptions } from "../lib/gitReactQuery";
import { resolveComposerSlashRootBranch } from "../composerSlashCommands";
import { dispatchThreadRename } from "../lib/threadRename";
import { quotePosixShellArgument } from "../lib/shellQuote";
import { useStableValue } from "~/hooks/useStableValue";
import { type SidebarThreadSummary, type Thread } from "../types";
import {
  useAutomationList,
  formatCadence,
  groupAutomationsByContinuedThread,
} from "../routes/-automations.shared";
import { useIsMobile } from "../hooks/useMediaQuery";
import { shouldRenderTerminalWorkspace } from "./ChatView.logic";
import { isModelPickerShortcutScopeActive } from "./chat/ComposerModelPicker.logic";
import {
  SIDEBAR_FOOTER_GLYPH_CLASS_NAME,
  sidebarFooterButtonClassName,
} from "./sidebarFooterStyles";
import { AppRailUsage } from "./AppRailUsage";
import { ProjectDisclosureChevron, ProjectSidebarIcon } from "./ProjectSidebarIcon";
import { ThreadHoverCardContent } from "./ThreadHoverCardContent";
import { ProjectHoverCardContent } from "./ProjectHoverCardContent";
import {
  SIDEBAR_HOVER_CARD_POPUP_PROPS,
  SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME,
  SIDEBAR_HOVER_CARD_TRIGGER_PROPS,
} from "./sidebarHoverCardStyles";
import {
  abbreviateHomePath,
  createProjectHoverCardAnchor,
  createThreadHoverCardAnchor,
} from "./sidebarHoverCardAnchors";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "./ui/preview-card";
import {
  type ActivityGroupMode,
  type ActivityScopeSelection,
  buildActivityViewModel,
  findNextThreadNeedingAttention,
  hasActivityNeedingAttention,
  resolveActivityPriorityTier,
} from "./SidebarActivityView.logic";
import {
  ActivityThreadRow,
  SidebarActivityView,
  SidebarSnoozedThreadsSection,
} from "./SidebarActivityView";
import { DesktopUpdateRailButton } from "./DesktopUpdateRailButton";
import { SidebarIconButton, sidebarIconButtonSlotClass } from "./SidebarIconButton";
import { OneTimeCoachmark } from "./OneTimeCoachmark";
import { SidebarPrimaryAction } from "./SidebarPrimaryAction";
import { SIDEBAR_PANEL_TITLE_CLASS_NAME } from "./SidebarPanelTitle";
import { SidebarMetaChipStack } from "./SidebarMetaChip";
import { SidebarRowHoverActions } from "./SidebarRowHoverActions";
import { SidebarSectionToolbar } from "./SidebarSectionToolbar";
import { SidebarGlyph, sidebarGlyphClass } from "./sidebarGlyphs";
import { SidebarStatusTrailingGlyph } from "./SidebarStatusTrailingGlyph";
import { ThreadArchiveActionButton } from "./ThreadArchiveActionButton";
import { ThreadPinToggleButton } from "./ThreadPinToggleButton";
import {
  SidebarThreadRowContent,
  type SidebarThreadTerminalStatus,
} from "./SidebarThreadRowContent";
import { GroupSettingsDialog } from "./chat/group/GroupSettingsDialog";
import { SidebarGroupsSurface } from "./SidebarGroupsSurface";
import {
  activateThreadWhenHydrated,
  isGroupThreadRoute,
  resolveGroupChatTargetProjectId,
} from "./SidebarGroupsSurface.logic";

import { useProjectAgentSummaries } from "./chat/project/useProjectAgentSummaries";
import { RenameDialog } from "./RenameDialog";
import { EditProjectDialog, type EditProjectValue } from "./EditProjectDialog";
import { RelocateProjectDialog } from "./RelocateProjectDialog";
import { RenameThreadDialog } from "./RenameThreadDialog";
import { UNLABELED_LABEL_FILTER } from "./SidebarWorkspaceLabelMenu";
import { SidebarDisplayOptionsMenu } from "./SidebarDisplayOptionsMenu";
import { WorkspaceLabelsDialog } from "./WorkspaceLabelsDialog";
import { SnoozeUntilDialog } from "./SnoozeUntilDialog";
import { SNOOZE_PRESETS } from "../lib/threadSnooze";
import ReleaseHistoryDialog from "./ReleaseHistoryDialog";
import { GROUPS_ON, isBetaFeatureOn } from "../betaFeatures";
import {
  NEOLIX_ACTIVITY_COACHMARK_ENABLED,
  NEOLIX_KANBAN_UI_ENABLED,
  NEOLIX_OPEN_IN_NEW_WINDOW_UI_ENABLED,
  NEOLIX_PROJECT_FOLDERS_UI_ENABLED,
  NEOLIX_PROVIDER_HANDOFF_UI_ENABLED,
  NEOLIX_PULL_REQUESTS_INBOX_ENABLED,
  NEOLIX_SNOOZE_UI_ENABLED,
  NEOLIX_SPACE_EDITING_UI_ENABLED,
} from "../neolixFeatures";
import { getWhatsNewEntries } from "../whatsNew/entries";
import { sortEntriesByVersionDesc } from "../whatsNew/logic";
import { SidebarSearchPalette, type SidebarSearchPaletteMode } from "./SidebarSearchPalette";
import { buildWorkspacePaletteActions } from "../workspacePaletteCommands";
import { useActivateThreadTab } from "../hooks/useOpenThreadTabs";
import { useOpenThreadTabsStore } from "../openThreadTabsStore";
import {
  WORKSPACE_CLOSE_ACTIVE_TAB_EVENT,
  WORKSPACE_RENAME_ACTIVE_TAB_EVENT,
  WORKSPACE_TOGGLE_PIN_PROJECT_EVENT,
} from "../workspaceTabEvents";
import { useSidebar } from "~/components/ui/sidebar";
import { useHandleNewChat } from "../hooks/useHandleNewChat";
import { useHandleNewGroupChat } from "../hooks/useHandleNewGroupChat";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useProviderStatusesForLocalConfig } from "../hooks/useProviderStatusesForLocalConfig";
import { useThreadHandoff } from "../hooks/useThreadHandoff";
import { useCreateProjectDialogStore } from "../createProjectDialogStore";
import { useFeedbackDialogStore } from "../feedbackDialogStore";
import { openExternalLink } from "~/lib/linkChips";
import {
  DESKTOP_SHELL_SETTINGS_QUERY_KEY,
  desktopShellAvailable,
  getDesktopShellSettings,
} from "./settings/desktopShellSettings";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { dockTerminalThreadId } from "../lib/dockTerminalScope";
import { randomTerminalId } from "./terminal/terminalIds";
import { toastManager } from "./ui/toast";
import {
  normalizeSidebarProjectThreadListCwd,
  persistSidebarUiState,
  readSidebarUiState,
  subscribeSidebarUiState,
} from "./Sidebar.uiState";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateAlreadyCurrentNotice,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateErrorSignature,
  isDesktopUpdateButtonDisabled,
  isDesktopUpdateInstallInFlight,
  resolveDesktopUpdateButtonAction,
  shouldRecommendManualDesktopDownload,
  shouldShowArm64IntelBuildWarning,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { StatusDot } from "./ui/status-chip";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { ShortcutKbd } from "./ui/kbd";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "./ui/sidebar";
import { useThreadSelectionStore } from "../threadSelectionStore";
import {
  excludeHiddenProjectAgentCoordinatorThreads,
  derivePinnedProjectIdsForSidebar,
  deriveSidebarProjectData,
  createSidebarThreadHoverAnchorId,
  findWorkspaceRootMatch,
  canSnoozeSidebarThread,
  mayBelongToGroup,
  getPinnedThreadsForSidebar,
  orderPinnedProjectsForSidebar,
  pullRequestRepositoryConfigFingerprint,
  getNextVisibleSidebarThreadId,
  getSidebarThreadIdsToPrewarm,
  getVisibleSidebarEntriesForPreview,
  groupSidebarThreadsByProjectId,
  mergeGroupMemberThreadsIntoProjectBuckets,
  partitionSidebarThreadsByProjectIds,
  filterSidebarThreadsBySpace,
  isLatestPinnedProjectMutation,
  isProjectsSidebarSurface,
  pruneProjectThreadListPagingForCollapsedProjects,
  recoverExistingAddProjectTarget,
  runExclusiveProjectAddition,
  runProjectProvisionWithCancellationRecovery,
  resolveSidebarRootThreadId,
  resolveSidebarThreadListPaging,
  DEBUG_FEATURE_FLAGS_MENU_STORAGE_KEY,
  resolveProjectEmptyState,
  resolveProjectStatusIndicator,
  resolveSettingsBackTarget,
  type SettingsBackTarget,
  resolveSidebarNewThreadEnvMode,
  resolveSidebarProjectRowLabel,
  resolveThreadHoverCardMetadata,
  resolveThreadProjectLabel,
  resolveThreadRowAriaLabel,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  resolveThreadStatusTrailingIndicator,
  hasUnseenCompletion,
  type SidebarDerivedProjectData,
  type SidebarActionBadge,
  type SidebarView,
  shouldShowDebugFeatureFlagsMenu,
  shouldPrunePinnedThreads,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
  resolveSidebarStatusBucket,
  resolveSidebarThreadDisplayTitle,
  SIDEBAR_STATUS_BUCKET_LABEL_KEYS,
  SIDEBAR_STATUS_BUCKET_ORDER,
  type SidebarStatusBucket,
} from "./Sidebar.logic";
import type { LastThreadRoute } from "../chatRouteRestore";
import {
  useCopyBranchNameToClipboard,
  useCopyPathToClipboard,
  useCopyThreadIdToClipboard,
} from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import {
  disclosureContentClassName,
  disclosureShellClassName,
  DISCLOSURE_INNER_CLASS,
} from "~/lib/disclosureMotion";
import { createClientPointMenuAnchor } from "~/lib/clientPointMenuAnchor";
import {
  canCreateThreadHandoff,
  canContinueThreadHandoff,
  resolveAvailableHandoffTargets,
  resolveThreadHandoffAvailability,
  resolveThreadHandoffBadgeLabel,
  type ThreadHandoffTarget,
} from "../lib/threadHandoff";
import { isTerminalFocused } from "../lib/terminalFocus";
import { beginThreadDrag, endThreadDrag } from "../lib/threadDrag";
import { useDiffRouteSearch } from "../hooks/useDiffRouteSearch";
import { type SettingsSectionId } from "../settingsNavigation";
import {
  sidebarHoverRevealHideClassName,
  SIDEBAR_HEADER_LEADING_ACTION_CLASS_NAME,
  SIDEBAR_HEADER_LEADING_ACTION_REVEAL_CLASS_NAME,
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
  SIDEBAR_NESTED_LIST_OFFSET_CLASS_NAME,
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_FOCUS_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
  SIDEBAR_ROW_SNOOZE_REMINDER_CLASS_NAME,
  SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
  SIDEBAR_SECTION_LABEL_CLASS_NAME,
} from "../sidebarRowStyles";
import { AccountFooterControl } from "./account/AccountFooterControl";
import {
  ComposerPickerMenuPopup,
  ComposerPickerMenuSubPopup,
} from "./chat/ComposerPickerMenuPopup";
import { selectSplitView, useSplitViewStore } from "../splitViewStore";
import { useRightDockStore } from "../rightDockStore";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import { useThreadActivationController } from "../hooks/useThreadActivationController";
import {
  firstLocalServerUrl,
  preferredDevServerUrl,
  useSidebarProjectRunController,
} from "../hooks/useSidebarProjectRunController";
import { useSidebarThreadActions } from "../hooks/useSidebarThreadActions";
import {
  useHeldSidebarThreadSortKeys,
  useIsPointerWithin,
} from "../hooks/useSidebarThreadOrderHold";
import { useThreadActionShortcuts } from "../hooks/useThreadActionShortcuts";
import { usePinnedProjectAgentsStore } from "../pinnedProjectAgentsStore";
import { usePinnedProjectsStore } from "../pinnedProjectsStore";
import { reconcileOptimisticPinState } from "../pinning.logic";
import { useThreadDetailPrewarm } from "../threadDetailPrewarm";
import { hasThreadDetailResumeCursor } from "../threadDetailResumeCursors";
import { retainThreadDetailSubscription } from "../threadDetailSubscriptionRetention";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import {
  areSidebarSearchThreadListsEqual,
  workspaceSidebarSearch,
  type SidebarSearchHost,
  type SidebarSearchAction,
  type SidebarSearchProject,
  type SidebarSearchThread,
} from "./SidebarSearchPalette.logic";
import { useFocusedChatContext } from "../focusedChatContext";
import { waitForRecoverableProjectInReadModel } from "../lib/projectCreateRecovery";
import {
  createOrRecoverProjectFromPath,
  PROJECT_CREATE_EXISTING_SYNC_ERROR,
} from "../lib/projectCreation";
import { useSpacesUiStore } from "../spacesUiStore";
import {
  CreateProjectDialog,
  type CreateProjectSubmitOptions,
  type CreateProjectSubmitValue,
} from "./CreateProjectDialog";
import { SpaceEditorDialog } from "./SpaceEditorDialog";
import { useSpacesController } from "./useSpacesController";
import { SpaceEmptyState } from "./SpaceEmptyState";
import { SpaceIcon } from "./SpaceIcon";
import { SpaceProjectPickerDialog } from "./SpaceProjectPickerDialog";
import { PROJECT_SPACE_DRAG_MIME, SpaceSwitcher, type SpaceActivityTone } from "./SpaceSwitcher";
import {
  SIDEBAR_CONTEXT_MENU_ICON_CLASS_NAME,
  SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME,
  SIDEBAR_CONTEXT_MENU_PANEL_CLASS_NAME,
  SidebarContextMenuIcon,
} from "./sidebarContextMenuStyles";
import {
  VOID_SPACE_KEY,
  spaceDisplayIcon,
  spaceDisplayName,
  spaceKey,
  resolveActiveSpaceId,
} from "../lib/spaceGrouping";
import { isSidechatThread } from "@synara/shared/sidechatThread";
import { t, useTranslation } from "~/i18n";

// Central glyphs for the sidebar section-header buttons (expand/collapse, sort, add).
const ExpandAllIcon = createCentralIconComponent("expand-45");
const CollapseAllIcon = createCentralIconComponent("minimize-45");
const SortFilterIcon = createCentralIconComponent("filter-2");

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const subscribeGitHubProvisioningCapability = (listener: () => void) =>
  onNativeApiServerCapabilitiesChange(listener);
const readGitHubProvisioningCapability = () =>
  readNativeApiServerCapability(WS_GITHUB_PROJECT_PROVISIONING_CAPABILITY);
const readGitHubProvisioningServerCapability = () => false;
const THREAD_PREVIEW_LIMIT = 5;
// Each "Show more" click reveals this many extra rows; "Show less" hides them again page by page.
const THREAD_PREVIEW_PAGE_SIZE = 5;
// Mouse clicks must not focus the paging buttons, or the focus ring lingers as a solid block
// after the click; they should only light up on hover/press. Keyboard focus is unaffected.
const preventFocusOnMouseDown = (event: React.MouseEvent) => {
  event.preventDefault();
};
const SIDEBAR_THREAD_SORT_LABELS: Record<SidebarThreadSortOrder, string> = {
  updated_at: "workspace:display_sortLastPrompt",
  created_at: "workspace:display_sortCreatedAt",
  manual: "workspace:display_sortManual",
};
const SIDEBAR_LIST_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;
const EMPTY_THREAD_JUMP_LABELS = new Map<string, string>();
const ADD_PROJECT_SNAPSHOT_CATCH_UP_MAX_ATTEMPTS = 6;
const ADD_PROJECT_SNAPSHOT_CATCH_UP_DELAY_MS = 50;
const GITHUB_CANCEL_RECOVERY_MAX_ATTEMPTS = 40;
const GITHUB_CANCEL_RECOVERY_DELAY_MS = 250;
/** Snap the optimistic segment selection back if the navigation never lands. */
const EMPTY_PROJECT_SIDEBAR_DATA: ReadonlyMap<ProjectId, SidebarDerivedProjectData> = new Map();
const DebugFeatureFlagsMenu = import.meta.env.DEV
  ? lazy(() =>
      import("./DebugFeatureFlagsMenu").then((module) => ({
        default: module.DebugFeatureFlagsMenu,
      })),
    )
  : null;

type ProjectContextMenuId =
  | "open-in-finder"
  | "open-in-new-window"
  | "open-in-kanban"
  | "copy-path"
  | "relocate"
  | "start-dev"
  | "stop-dev"
  | "restart-dev"
  | "open-dev-server"
  | "copy-dev-url"
  | "view-dev-terminal"
  | "rename"
  | "edit-project-agent"
  | "toggle-pin-project-agent"
  | "toggle-pin"
  | "archive-threads"
  | "delete-threads"
  | "delete";

type ProjectContextMenuState = {
  projectId: ProjectId;
  position: { x: number; y: number };
};

// Sidebar right-click menus (project rows, Space tabs) share one chrome; see
// sidebarContextMenuStyles.
const PROJECT_CONTEXT_MENU_PANEL_CLASS_NAME = SIDEBAR_CONTEXT_MENU_PANEL_CLASS_NAME;
const PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME = SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME;
const PROJECT_CONTEXT_MENU_ICON_CLASS_NAME = SIDEBAR_CONTEXT_MENU_ICON_CLASS_NAME;

// Same gap and tone as the Chats header chevron.
const PROJECT_ROW_CHEVRON_CLASS_NAME = "-ml-1 text-muted-foreground/79";

function ProjectContextMenuIcon({ icon }: { icon: LucideIcon }) {
  return <SidebarContextMenuIcon icon={icon} />;
}

type DebugFeatureFlagsWindow = Window & {
  synaraShowFeatureFlags?: () => void;
  synaraHideFeatureFlags?: () => void;
};

function readDebugFeatureFlagsMenuVisibility(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return shouldShowDebugFeatureFlagsMenu({
      isDev: import.meta.env.DEV,
      hostname: window.location.hostname,
      storageValue: window.localStorage.getItem(DEBUG_FEATURE_FLAGS_MENU_STORAGE_KEY),
    });
  } catch {
    return false;
  }
}

function threadJumpLabelMapsEqual(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left === right) {
    return true;
  }
  if (left.size !== right.size) {
    return false;
  }
  for (const [threadId, label] of left) {
    if (right.get(threadId) !== label) {
      return false;
    }
  }
  return true;
}

// Resolve the visible numbered-thread hints from the active keybinding config.
function buildThreadJumpLabelMap(input: {
  keybindings: ResolvedKeybindingsConfig;
  platform: string;
  terminalOpen: boolean;
  threadJumpCommandByThreadId: ReadonlyMap<
    string,
    NonNullable<ReturnType<typeof threadJumpCommandForIndex>>
  >;
}): ReadonlyMap<string, string> {
  if (input.threadJumpCommandByThreadId.size === 0) {
    return EMPTY_THREAD_JUMP_LABELS;
  }

  const shortcutLabelOptions = {
    platform: input.platform,
    context: {
      terminalFocus: false,
      terminalOpen: input.terminalOpen,
    },
  } as const;
  const mapping = new Map<string, string>();
  for (const [threadId, command] of input.threadJumpCommandByThreadId) {
    const label = shortcutLabelForCommand(input.keybindings, command, shortcutLabelOptions);
    if (label) {
      mapping.set(threadId, label);
    }
  }
  return mapping.size > 0 ? mapping : EMPTY_THREAD_JUMP_LABELS;
}
function WorktreeBadgeGlyph({ className }: { className?: string }) {
  return <WorktreeIcon aria-hidden="true" className={sidebarGlyphClass("meta", className)} />;
}

/** Pulsing green dot shown before a project name while a dev run is live. */
function ProjectRunIndicatorDot({ className }: { className?: string }) {
  const { t } = useTranslation();

  return (
    <StatusDot
      aria-hidden="true"
      title={t("workspace:status_devServerRunning")}
      className={cn("bg-emerald-400 motion-safe:animate-pulse", className)}
    />
  );
}

/** Meta chips fade on row hover so pin/archive actions can occupy the same slot. */
const THREAD_ROW_META_CHIP_HOVER_FADE_CLASS_NAME = cn(
  "flex shrink-0 items-center",
  sidebarHoverRevealHideClassName("thread-row"),
);

/** Status glyph slot; matches the 15px meta-chip column so trailing icons stay compact. */
function threadRowStatusSlotClassName(toneClassName?: string): string {
  return cn(
    "flex w-[15px] shrink-0 items-center justify-center leading-none tabular-nums",
    sidebarHoverRevealHideClassName("thread-row"),
    // Nudge the timestamp a hair above the meta scale while still tracking the user's
    // typography setting (the CSS var is always set; the 11px is just an SSR fallback).
    "text-[length:calc(var(--app-font-size-ui-meta,11px)+0.5px)]",
    toneClassName ?? "text-muted-foreground/38",
  );
}

function resolveWorktreeBadgeLabel(
  thread: Pick<Thread, "envMode" | "worktreePath">,
): string | null {
  return resolveThreadEnvironmentPresentation({
    envMode: thread.envMode,
    worktreePath: thread.worktreePath,
  }).worktreeBadgeLabel;
}

/** User message the coordinator receives when a thread is handed to a group. */
function groupPickupMessageText(sourceThread: Pick<Thread, "id" | "title">): string {
  return `A thread was handed to this hub for you to pick up: "${sourceThread.title ?? "Untitled thread"}" (thread id ${sourceThread.id}). Use synara_read_thread to read it and continue the work it was doing.`;
}

type ThreadMetaChip = {
  id: "automation" | "handoff" | "fork" | "worktree" | "pr" | "checks" | "services";
  tooltip: string;
  icon: ReactNode;
};

/**
 * Back-to-front order: first = behind, last = in front.
 * Priority lowest -> highest: handoff -> fork -> worktree.
 */
function resolveThreadRowMetaChips(input: {
  thread: Pick<Thread, "forkSourceThreadId" | "envMode" | "worktreePath" | "handoff">;
  includeHandoffBadge: boolean;
  /**
   * When the leading provider avatar already renders the source → target handoff
   * pair, the trailing handoff chip is a redundant double icon and is dropped.
   */
  handoffShownInAvatar?: boolean;
  /** Heartbeat automations targeting this thread; surfaced as an at-a-glance clock chip. */
  threadAutomations?: readonly AutomationDefinition[] | undefined;
}): ThreadMetaChip[] {
  const chips: ThreadMetaChip[] = [];
  const threadAutomations = input.threadAutomations;
  if (threadAutomations && threadAutomations.length > 0) {
    const anyEnabled = threadAutomations.some((automation) => automation.enabled);
    const firstAutomation = threadAutomations[0]!;
    const tooltip =
      threadAutomations.length === 1
        ? t("common:symbol9", {
            value0: firstAutomation.name,
            value1: firstAutomation.enabled
              ? formatCadence(firstAutomation.schedule)
              : t("automation:detail_paused"),
          })
        : t("workspace:automations", { value0: threadAutomations.length });
    chips.push({
      id: "automation",
      tooltip,
      icon: (
        <SidebarGlyph
          icon={ClockIcon}
          variant="meta"
          className={anyEnabled ? "text-muted-foreground/55" : "text-muted-foreground/40"}
        />
      ),
    });
  }

  const handoffBadgeLabel = resolveThreadHandoffBadgeLabel(input.thread);
  if (input.includeHandoffBadge && !input.handoffShownInAvatar && handoffBadgeLabel) {
    chips.push({
      id: "handoff",
      tooltip: handoffBadgeLabel,
      icon: (
        <SidebarGlyph icon={GitBranchIcon} variant="meta" className="text-muted-foreground/55" />
      ),
    });
  }

  if (input.thread.forkSourceThreadId) {
    chips.push({
      id: "fork",
      tooltip: t("workspace:card_forkedThread"),
      icon: (
        <SidebarGlyph
          icon={GitBranchIcon}
          variant="meta"
          className="text-emerald-600 dark:text-emerald-300/90"
        />
      ),
    });
  }

  const worktreeBadgeLabel = resolveWorktreeBadgeLabel(input.thread);
  if (worktreeBadgeLabel) {
    chips.push({
      id: "worktree",
      tooltip: worktreeBadgeLabel,
      icon: <WorktreeBadgeGlyph className="text-muted-foreground/55" />,
    });
  }

  return chips;
}

// The thread's PR state, as a plain meta chip that closes the row (the hover card's PR
// row is the clickable way to open it).
function resolveThreadRowPrChip(pr: NonNullable<ThreadPullRequest>): ThreadMetaChip {
  const presentation = resolvePrStatePresentation(pr);
  return {
    id: "pr",
    tooltip: t("workspace:symbol4", {
      value0: pr.number,
      value1: t(PR_STATE_LABEL_KEYS[presentation.label]),
      value2: pr.title,
    }),
    icon: (
      <SidebarGlyph
        icon={PR_STATE_PRESENTATION_ICONS[presentation.iconKind]}
        variant="meta"
        className={presentation.colorClass}
      />
    ),
  };
}

function terminalStatusFromThreadState(input: {
  runningTerminalIds: string[];
  terminalAttentionStatesById: Record<string, "attention" | "review">;
}): SidebarThreadTerminalStatus | null {
  const terminalAttentionStates = Object.values(input.terminalAttentionStatesById ?? {});
  if (terminalAttentionStates.includes("attention")) {
    return {
      label: "Terminal input needed",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      pulse: false,
    };
  }
  if ((input.runningTerminalIds?.length ?? 0) > 0) {
    return {
      label: "Terminal process running",
      colorClass: "text-teal-600 dark:text-teal-300/90",
      pulse: true,
    };
  }
  if (terminalAttentionStates.includes("review")) {
    return {
      label: "Terminal task completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      pulse: false,
    };
  }
  return null;
}

type SortableProjectHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

// Neox's docs live in the public-docs directory of the repository.
const SYNARA_DOCS_URL = "https://github.com/istoo/neox/tree/main/public-docs/index.md";

/** Release history is read from the product changelog, so the menu stays available. */
const HELP_MENU_RELEASE_NOTES_ENABLED = true;
const HELP_MENU_RELEASE_ENTRY_LIMIT = 3;

// Footer help menu; swapped out for the desktop-update pill while an update is
// available (see SidebarFooter).
function SidebarHelpMenu({
  onOpenShortcuts,
  inRail: inRailProp,
}: {
  onOpenShortcuts: () => void;
  /** Footer row: the trigger takes the footer button look and the menu opens to the side. */
  inRail?: boolean;
}) {
  const { t, locale } = useTranslation();

  const inRail = inRailProp ?? false;
  // Latest releases from the product changelog, localized by the interface language.
  const helpMenuReleaseEntries = useMemo(
    () =>
      sortEntriesByVersionDesc(getWhatsNewEntries(locale)).slice(0, HELP_MENU_RELEASE_ENTRY_LIMIT),
    [locale],
  );
  // `openCount` keys the dialog so each open remounts the accordion — its rows
  // capture `defaultOpen` in mount state, so a stale mount would ignore a
  // newly selected version.
  const [releaseHistory, setReleaseHistory] = useState<{
    readonly open: boolean;
    readonly version: string | null;
    readonly openCount: number;
  }>({ open: false, version: null, openCount: 0 });

  const openReleaseHistory = (version: string | null) => {
    setReleaseHistory((prev) => ({ open: true, version, openCount: prev.openCount + 1 }));
  };

  return (
    <>
      <Menu>
        <SidebarIconButton
          render={<MenuTrigger />}
          icon={CircleQuestionIcon}
          label={t("workspace:help")}
          tooltip={t("workspace:help")}
          {...(inRail
            ? {
                tooltipSide: "right" as const,
                iconClassName: SIDEBAR_FOOTER_GLYPH_CLASS_NAME,
                className: sidebarFooterButtonClassName(false),
              }
            : {})}
        />
        <ComposerPickerMenuPopup
          align="end"
          side={inRail ? "right" : "top"}
          className="w-64 min-w-64"
        >
          {HELP_MENU_RELEASE_NOTES_ENABLED ? (
            <MenuGroup>
              <div className="px-2 py-1 sm:text-ui leading-snug font-medium text-muted-foreground">
                {t("workspace:whatSNew")}
              </div>
              {helpMenuReleaseEntries.map((entry) => (
                <MenuItem
                  key={entry.version}
                  className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
                  onClick={() => openReleaseHistory(entry.version)}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {entry.features.flatMap((feature) => feature.items ?? [])[0] ??
                      entry.features[0]?.title ??
                      t("workspace:version", { value0: entry.version })}
                  </span>
                  <span className="shrink-0 text-[var(--color-text-foreground-secondary)] tabular-nums">
                    {entry.date}
                  </span>
                </MenuItem>
              ))}
              <MenuItem
                className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() => openReleaseHistory(null)}
              >
                <SidebarContextMenuIcon icon={GiftIcon} />
                <span>{t("workspace:fullChangelog")}</span>
              </MenuItem>
            </MenuGroup>
          ) : null}
          <MenuSeparator />
          <MenuGroup>
            <MenuItem className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME} onClick={onOpenShortcuts}>
              <SidebarContextMenuIcon icon={KeyboardIcon} />
              <span>{t("common:advanced_keybindings")}</span>
            </MenuItem>
            <MenuItem
              className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
              onClick={() => openExternalLink(SYNARA_DOCS_URL)}
            >
              <SidebarContextMenuIcon icon={BookIcon} />
              <span>{t("workspace:docs")}</span>
            </MenuItem>
          </MenuGroup>
        </ComposerPickerMenuPopup>
      </Menu>
      <ReleaseHistoryDialog
        key={releaseHistory.openCount}
        open={releaseHistory.open}
        onOpenChange={(open) => {
          setReleaseHistory((prev) => ({ ...prev, open }));
        }}
        defaultExpandedVersion={releaseHistory.version}
      />
    </>
  );
}

export type ThreadSortMenuProps = {
  threadSortOrder: SidebarThreadSortOrder;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  threadAttentionFirst: boolean;
  onThreadAttentionFirstChange: (attentionFirst: boolean) => void;
};

function ThreadSortMenuItems({
  threadSortOrder,
  onThreadSortOrderChange,
  threadAttentionFirst,
  onThreadAttentionFirstChange,
}: ThreadSortMenuProps) {
  const { t } = useTranslation();

  return (
    <>
      <MenuRadioGroup
        value={threadSortOrder}
        onValueChange={(value) => {
          onThreadSortOrderChange(value as SidebarThreadSortOrder);
        }}
      >
        {(
          Object.entries(SIDEBAR_THREAD_SORT_LABELS) as Array<[SidebarThreadSortOrder, string]>
        ).map(([value, label]) => (
          <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-ui leading-snug">
            {t(label)}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      {/* "Created at" is a plain creation-time list, so the toggle only applies to activity order. */}
      <MenuCheckboxItem
        variant="switch"
        checked={threadAttentionFirst}
        disabled={threadSortOrder !== "updated_at"}
        onCheckedChange={(checked) => {
          onThreadAttentionFirstChange(checked === true);
        }}
        className="min-h-7 py-1 sm:text-ui leading-snug"
      >
        {t("workspace:workingAndUnreadOnTop")}
      </MenuCheckboxItem>
    </>
  );
}

export function ChatSortMenu(props: ThreadSortMenuProps) {
  const { t } = useTranslation();

  return (
    <Menu>
      <SidebarIconButton
        render={<MenuTrigger />}
        icon={SortFilterIcon}
        label={t("workspace:sort_sortChats")}
        tooltip={t("workspace:sort_sortChats")}
        tooltipSide="top"
      />
      <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-44">
        <MenuGroup>
          <div className="px-2 py-1 sm:text-ui leading-snug font-medium text-muted-foreground">
            {t("workspace:sort_sortChats")}
          </div>
          <ThreadSortMenuItems {...props} />
        </MenuGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

/** Everything a primary nav row needs, keyed by `SidebarNavItemId` so persisted
 *  order/visibility settings can drive both the live rows and the customize card. */
type SidebarNavItemDescriptor = {
  readonly icon: ComponentType<{ className?: string }>;
  readonly iconClassName?: string;
  readonly label: string;
  readonly active: boolean;
  readonly badge: SidebarActionBadge | null;
  readonly onClick: () => void;
  readonly onMouseEnter?: () => void;
  readonly onFocus?: () => void;
};

function SortableProjectItem({
  projectId,
  disabled: disabledProp,
  children,
}: {
  projectId: string;
  disabled?: boolean;
  children: (handleProps: SortableProjectHandleProps) => React.ReactNode;
}) {
  // Default resolved in the body — see SidebarPrimaryAction.
  const disabled = disabledProp ?? false;
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: projectId, disabled });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={`group/menu-item relative rounded-md ${
        isDragging ? "z-20 opacity-80" : ""
      } ${isOver && !isDragging ? "ring-1 ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </li>
  );
}

type SortableThreadHandleProps = {
  attributes: ReturnType<typeof useSortable>["attributes"];
  listeners: ReturnType<typeof useSortable>["listeners"];
  setNodeRef: ReturnType<typeof useSortable>["setNodeRef"];
  transform: string | undefined;
  transition: string | undefined;
  isDragging: boolean;
  isOver: boolean;
};

/** One thread row in manual sort mode; the row itself is the drag activator. */
function SortableThreadItem({
  threadId,
  children,
}: {
  threadId: string;
  children: (handleProps: SortableThreadHandleProps) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({ id: threadId });
  return children({
    attributes,
    listeners,
    setNodeRef,
    transform: CSS.Translate.toString(transform),
    transition,
    isDragging,
    isOver,
  });
}

/**
 * Header Activity toggle: a bell that lights up in the accent tone while the
 * Activity view is on, with an unread dot when completions are waiting.
 */
export function SidebarActivityBellButton({
  active,
  showUnreadDot,
  shortcutLabel,
  onClick,
}: {
  active: boolean;
  showUnreadDot: boolean;
  shortcutLabel: string | null;
  onClick: () => void;
}) {
  const { t } = useTranslation();

  return (
    <OneTimeCoachmark
      storageKey="synara:activity-onboarding:v1"
      // Neox 不需要活动引导气泡：不自动弹出，悬停提示保留。
      autoOpen={NEOLIX_ACTIVITY_COACHMARK_ENABLED}
      title={t("workspace:profile_activity")}
      description={t("workspace:seeRunningTasksCompletedWorkAndAnythingThatNeeds")}
      tooltip={t("workspace:activityView", { value0: shortcutLabel ? ` (${shortcutLabel})` : "" })}
      tooltipSide="bottom"
    >
      <button
        type="button"
        aria-label={
          active ? t("workspace:switchToClassicView") : t("workspace:switchToActivityView")
        }
        aria-pressed={active}
        onClick={onClick}
        className={cn(
          "relative inline-flex shrink-0 cursor-pointer items-center justify-center transition-colors",
          sidebarIconButtonSlotClass("header"),
          SIDEBAR_ROW_FOCUS_CLASS_NAME,
          active
            ? "bg-[color-mix(in_srgb,var(--color-text-accent)_15%,transparent)] text-[var(--color-text-accent)]"
            : "sidebar-icon-button text-muted-foreground/75 hover:text-foreground",
        )}
      >
        <BellIcon className={sidebarGlyphClass("leading")} />
        {showUnreadDot ? (
          <span
            aria-hidden
            className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-[var(--color-text-accent)] ring-2 ring-[var(--sidebar-background,var(--background))]"
          />
        ) : null}
      </button>
    </OneTimeCoachmark>
  );
}

const SIDEBAR_SURFACE_PICKER_COPY: Record<SidebarView, { title: string; description: string }> = {
  threads: { title: "Neox", description: "workspace:buildDebugShip" },
  groups: { title: "common:hubs", description: "workspace:coordinatedAcrossRepos" },
};

/**
 * App-switcher style surface picker: a compact pill with the active surface
 * name that opens a menu of surfaces, each with a one-line description and a
 * check on the active entry.
 */
export function SidebarSurfacePicker({
  views,
  activeView,
  onSelectView,
  onPrewarmView,
}: {
  views: ReadonlyArray<SidebarView>;
  activeView: SidebarView;
  onSelectView: (view: SidebarView) => void;
  onPrewarmView?: (view: SidebarView) => void;
}) {
  const { t } = useTranslation();

  const activeCopy = SIDEBAR_SURFACE_PICKER_COPY[activeView];

  // With a single surface (Hubs are off in Neox) a menu would only offer the current entry:
  // show the title as plain text so the chevron doesn't invite a no-op click.
  if (views.length < 2) {
    return (
      <div className="flex h-8 min-w-0 items-center px-2.5">
        <span className={SIDEBAR_PANEL_TITLE_CLASS_NAME}>{t(activeCopy.title)}</span>
      </div>
    );
  }

  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={t("workspace:switchSidebarSurface")}
            className={cn(
              "flex h-8 min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5",
              SIDEBAR_ROW_FOCUS_CLASS_NAME,
              SIDEBAR_ROW_HOVER_CLASS_NAME,
            )}
          />
        }
      >
        <span className={SIDEBAR_PANEL_TITLE_CLASS_NAME}>{t(activeCopy.title)}</span>
        <DisclosureChevron open className="text-muted-foreground/70" />
      </MenuTrigger>
      <ComposerPickerMenuPopup
        align="start"
        side="bottom"
        className="sidebar-surface-picker-menu min-w-64"
      >
        <MenuRadioGroup
          className="flex flex-col gap-0.5"
          value={activeView}
          onValueChange={(value) => {
            const view = value as SidebarView;
            onPrewarmView?.(view);
            onSelectView(view);
          }}
        >
          {views.map((view) => {
            const copy = SIDEBAR_SURFACE_PICKER_COPY[view];
            return (
              <MenuRadioItem
                key={view}
                value={view}
                // Base UI radio items keep the menu open by default; this picker is a
                // one-shot surface switch, so selecting an entry should dismiss it.
                closeOnClick
                className="items-center rounded-[10px] data-checked:bg-[var(--color-background-button-secondary-hover)]"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-ui-lg font-medium leading-none text-foreground">
                    {t(copy.title)}
                  </span>
                  <span className="text-ui-sm leading-snug text-muted-foreground">
                    {t(copy.description)}
                  </span>
                </span>
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

export default function Sidebar() {
  const { t, formatLocale } = useTranslation();

  const githubProvisioningAvailable = useSyncExternalStore(
    subscribeGitHubProvisioningCapability,
    readGitHubProvisioningCapability,
    readGitHubProvisioningServerCapability,
  );
  const [showDebugFeatureFlagsMenu, setShowDebugFeatureFlagsMenu] = useState(
    readDebugFeatureFlagsMenuVisibility,
  );
  const projects = useStore((store) => store.projects);
  const spaces = useStore((store) => store.spaces);
  // Selection state only; the handlers and sync effects live in useSpacesController.
  const storedActiveSpaceId = useSpacesUiStore((store) => store.activeSpaceId);
  const pendingActiveSpaceId = useSpacesUiStore(
    (store) => store.pendingActiveSpace?.spaceId ?? null,
  );
  const activeSpaceId = resolveActiveSpaceId(storedActiveSpaceId, spaces, pendingActiveSpaceId);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const isMobile = useIsMobile();
  const sidebarThreadSummaryById = useStore((store) => store.sidebarThreadSummaryById);
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const markThreadVisited = useStore((store) => store.markThreadVisited);
  const markThreadUnread = useStore((store) => store.markThreadUnread);
  const toggleProject = useStore((store) => store.toggleProject);
  const setProjectExpanded = useStore((store) => store.setProjectExpanded);
  const setAllProjectsExpanded = useStore((store) => store.setAllProjectsExpanded);
  const collapseProjectsExcept = useStore((store) => store.collapseProjectsExcept);
  const reorderProjects = useStore((store) => store.reorderProjects);
  const renameProjectLocally = useStore((store) => store.renameProjectLocally);
  const setProjectAppearanceLocally = useStore((store) => store.setProjectAppearanceLocally);
  const removeDeletedProjectFromClientState = useStore(
    (store) => store.removeDeletedProjectFromClientState,
  );
  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const openChatThreadPage = useTerminalStateStore((state) => state.openChatThreadPage);
  const openTerminalThreadPage = useTerminalStateStore((state) => state.openTerminalThreadPage);
  const clearProjectDraftThreads = useComposerDraftStore((store) => store.clearProjectDraftThreads);
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const activeComposerSendThreadIds = useSyncExternalStore(
    subscribeComposerSends,
    getActiveComposerSendThreadIds,
    getActiveComposerSendThreadIds,
  );
  const temporaryThreadIds = useTemporaryThreadStore((store) => store.temporaryThreadIds);
  const persistedPinnedProjectIds = usePinnedProjectsStore((store) => store.pinnedProjectIds);
  const pinProjectLocally = usePinnedProjectsStore((store) => store.pinProject);
  const unpinProject = usePinnedProjectsStore((store) => store.unpinProject);
  const prunePinnedProjects = usePinnedProjectsStore((store) => store.prunePinnedProjects);
  const pinnedProjectAgentIds = usePinnedProjectAgentsStore((store) => store.pinnedProjectAgentIds);
  const toggleProjectAgentPinned = usePinnedProjectAgentsStore(
    (store) => store.toggleProjectAgentPinned,
  );
  const prunePinnedProjectAgents = usePinnedProjectAgentsStore(
    (store) => store.prunePinnedProjectAgents,
  );
  const homeDir = useWorkspacePathsStore((store) => store.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((store) => store.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((store) => store.studioWorkspaceRoot);
  const groupsWorkspaceRoot = useWorkspacePathsStore((store) => store.groupsWorkspaceRoot);
  const navigate = useNavigate();
  const { toggleSidebar } = useSidebar();
  const activateThreadTab = useActivateThreadTab();
  const openThreadTabIds = useOpenThreadTabsStore((store) => store.threadIds);
  const queryClient = useQueryClient();
  const pathname = useCommittedPathname();
  const isOnSettings = pathname === "/settings";
  const isOnGroupsRoute = pathname.startsWith("/hubs") || pathname.startsWith("/groups");
  const activeWorkspaceSearch = useLocation({ select: (location) => location.searchStr });
  // Lightweight read of automations so thread rows can show their attached heartbeat.
  // Shares the ["automations"] query cache with the Automations settings panel.
  const automationListQuery = useAutomationList();
  const pullRequestRepositoryConfig = useMemo(
    () => pullRequestRepositoryConfigFingerprint(projects),
    [projects],
  );
  const previousPullRequestRepositoryConfigRef = useRef(pullRequestRepositoryConfig);
  useEffect(() => {
    if (previousPullRequestRepositoryConfigRef.current === pullRequestRepositoryConfig) return;
    previousPullRequestRepositoryConfigRef.current = pullRequestRepositoryConfig;
    void queryClient.invalidateQueries({ queryKey: githubInboxQueryKeys.all });
    void queryClient.invalidateQueries({ queryKey: pullRequestQueryKeys.all });
  }, [pullRequestRepositoryConfig, queryClient]);
  const { settings: appSettings, serverSettings, updateSettings } = useAppSettings();
  // Heartbeat automations grouped by their target thread, so each thread row can show a
  // clock chip indicating an automation is attached (mirrors the Environment panel section).
  const automationsByThreadId = useMemo(
    () => groupAutomationsByContinuedThread(automationListQuery.data?.definitions ?? []),
    [automationListQuery.data],
  );
  const sidebarProviderInstances = useMemo(
    () => getProviderInstanceOptions(appSettings),
    [appSettings],
  );
  // Projects is always available; Groups and the standalone Chats footer can be hidden
  // independently from Settings.
  const chatsSectionVisible = appSettings.showChatsSection;
  const groupsSectionVisible = GROUPS_ON && appSettings.showGroupsSection;
  const { handleNewThread } = useHandleNewThread();
  const { handleNewChat } = useHandleNewChat();
  const { handleNewGroupChat } = useHandleNewGroupChat();
  const { continueThreadHandoff, createThreadHandoff } = useThreadHandoff();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const pendingThreadRowAnchorRef = useRef<{
    threadId: ThreadId;
    row: HTMLElement;
    viewport: HTMLElement;
    top: number;
    scrollTop: number;
  } | null>(null);
  useLayoutEffect(() => {
    const anchor = pendingThreadRowAnchorRef.current;
    pendingThreadRowAnchorRef.current = null;
    if (
      !anchor ||
      anchor.threadId !== routeThreadId ||
      !anchor.row.isConnected ||
      anchor.viewport.scrollTop !== anchor.scrollTop
    ) {
      return;
    }
    // Keep the activated row in place when navigation changes the rows above it.
    // Native anchoring can instead hold an earlier row; scroll bounds still apply.
    anchor.viewport.scrollTop += anchor.row.getBoundingClientRect().top - anchor.top;
  }, [routeThreadId]);
  const routeProjectId = useParams({
    strict: false,
    select: (params) =>
      typeof params.projectId === "string" ? ProjectId.makeUnsafe(params.projectId) : null,
  });
  const routeSearch = useDiffRouteSearch();
  const activeSplitView = useSplitViewStore(
    useMemo(() => selectSplitView(routeSearch.splitViewId ?? null), [routeSearch.splitViewId]),
  );
  const splitViewsById = useSplitViewStore((store) => store.splitViewsById);

  useEffect(() => {
    const api = readNativeApi();
    if (!api || !threadsHydrated || projects.length > 0) {
      return;
    }

    let cancelled = false;
    // The sidebar is the visible empty-state owner. If startup hydrated empty
    // before the desktop projection caught up, ask the lightweight shell endpoint once.
    void api.orchestration
      .getShellSnapshot()
      .then((snapshot) => {
        if (
          cancelled ||
          (snapshot.spaces.length === 0 &&
            snapshot.projects.length === 0 &&
            snapshot.threads.length === 0)
        ) {
          return;
        }
        syncServerShellSnapshot(snapshot);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [projects.length, syncServerShellSnapshot, threadsHydrated]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const canInstallConsoleCommand = shouldShowDebugFeatureFlagsMenu({
      isDev: import.meta.env.DEV,
      hostname: window.location.hostname,
      storageValue: "true",
    });
    if (!canInstallConsoleCommand) {
      return;
    }

    const debugWindow = window as DebugFeatureFlagsWindow;
    const updateVisibility = () => {
      setShowDebugFeatureFlagsMenu(readDebugFeatureFlagsMenuVisibility());
    };
    const showFeatureFlags = () => {
      window.localStorage.setItem(DEBUG_FEATURE_FLAGS_MENU_STORAGE_KEY, "true");
      updateVisibility();
    };
    const hideFeatureFlags = () => {
      window.localStorage.removeItem(DEBUG_FEATURE_FLAGS_MENU_STORAGE_KEY);
      updateVisibility();
    };

    debugWindow.synaraShowFeatureFlags = showFeatureFlags;
    debugWindow.synaraHideFeatureFlags = hideFeatureFlags;
    window.addEventListener("storage", updateVisibility);
    updateVisibility();

    return () => {
      window.removeEventListener("storage", updateVisibility);
      if (debugWindow.synaraShowFeatureFlags === showFeatureFlags) {
        delete debugWindow.synaraShowFeatureFlags;
      }
      if (debugWindow.synaraHideFeatureFlags === hideFeatureFlags) {
        delete debugWindow.synaraHideFeatureFlags;
      }
    };
  }, []);
  const setSplitFocusedPane = useSplitViewStore((store) => store.setFocusedPane);
  const openRightDockPane = useRightDockStore((store) => store.openPane);
  // Query defaults are applied after destructuring: a default inside the destructuring
  // pattern makes React Compiler bail out on the whole Sidebar component.
  const keybindingsQuery = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.keybindings,
  });
  const keybindings = keybindingsQuery.data ?? EMPTY_KEYBINDINGS;
  const serverCwdQuery = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.cwd ?? null,
  });
  const serverCwd = serverCwdQuery.data ?? null;
  const providerStatuses = useProviderStatusesForLocalConfig();
  // Workspace labels are per Neox workspace; thread rows join them by directory.
  const neolixWorkspacesQuery = useQuery(neolixWorkspacesQueryOptions());
  const neolixWorkspaceLabelsQuery = useQuery(neolixWorkspaceLabelsQueryOptions());
  // Directory -> workspace records. A directory can hold several workspace records (one per
  // session when they share a checkout), so a bare cwd is only a join key when it is unique;
  // the thread's own `neolixWorkspaceId` is authoritative otherwise.
  const neolixWorkspacesByDirectory = useMemo(() => {
    const byDirectory = new Map<
      string,
      Array<NonNullable<ReturnType<typeof findWorkspaceForDirectory>>>
    >();
    for (const workspace of neolixWorkspacesQuery.data?.workspaces ?? []) {
      const key = workspace.directory.replace(/\/+$/, "");
      const folded = key.toLowerCase();
      for (const candidate of folded === key ? [key] : [key, folded]) {
        const current = byDirectory.get(candidate);
        if (current) current.push(workspace);
        else byDirectory.set(candidate, [workspace]);
      }
    }
    return byDirectory;
  }, [neolixWorkspacesQuery.data]);
  const neolixWorkspaceById = useMemo(() => {
    const byId = new Map<string, NonNullable<ReturnType<typeof findWorkspaceForDirectory>>>();
    for (const workspace of neolixWorkspacesQuery.data?.workspaces ?? []) {
      byId.set(workspace.id, workspace);
    }
    return byId;
  }, [neolixWorkspacesQuery.data]);
  const resolveThreadWorkspaceRecord = useCallback(
    (thread: Pick<SidebarThreadSummary, "workingDirectory" | "neolixWorkspaceId">) => {
      const workspaceId = thread.neolixWorkspaceId?.trim();
      if (workspaceId) {
        const byId = neolixWorkspaceById.get(workspaceId);
        if (byId) return byId;
      }
      const directory = thread.workingDirectory?.trim();
      if (!directory) return null;
      const key = directory.replace(/\/+$/, "");
      const matches =
        neolixWorkspacesByDirectory.get(key) ?? neolixWorkspacesByDirectory.get(key.toLowerCase());
      // Several sessions can share one checkout and each owns a workspace record. Picking
      // the first would show (and rename, pin, archive) a sibling session, so leave the
      // row to its own thread title until the shell carries a workspace id.
      return matches?.length === 1 ? matches[0]! : null;
    },
    [neolixWorkspacesByDirectory, neolixWorkspaceById],
  );
  // The row label: the session's workspace title, else the thread's own title, unless the user
  // chose branch titles. The daemon titles a session's workspace from its first prompt, and the
  // bridge renames that workspace along with the thread. `name` is not used: without a title the
  // daemon derives it from the branch or folder, which would label every thread in one checkout
  // the same.
  const resolveThreadDisplayTitle = useCallback(
    (thread: Pick<SidebarThreadSummary, "title" | "branch" | "workingDirectory">) => {
      const workspace = resolveThreadWorkspaceRecord(thread);
      return resolveSidebarThreadDisplayTitle({
        threadTitle: thread.title,
        workspaceTitle: workspace?.title,
        branch: thread.branch ?? workspace?.branch ?? null,
        titleSource: appSettings.sidebarTitleSource,
      });
    },
    [appSettings.sidebarTitleSource, resolveThreadWorkspaceRecord],
  );
  // A rename starts from, and compares against, the name the row shows (branch mode aside).
  const resolveThreadRenameTitle = useCallback(
    (thread: Pick<SidebarThreadSummary, "title" | "workingDirectory" | "neolixWorkspaceId">) =>
      resolveThreadWorkspaceRecord(thread)?.title?.trim() || thread.title,
    [resolveThreadWorkspaceRecord],
  );
  const neolixWorkspaceLabelsByDirectory = useMemo(() => {
    const workspaces = neolixWorkspacesQuery.data?.workspaces ?? [];
    const definitions = neolixWorkspaceLabelsQuery.data?.labels ?? [];
    const byDirectory = new Map<string, ReturnType<typeof resolveWorkspaceLabelsForDirectory>>();
    for (const workspace of workspaces) {
      const labels = resolveWorkspaceLabelsForDirectory(
        [workspace],
        definitions,
        workspace.directory,
      );
      if (labels.length > 0) {
        const key = workspace.directory.replace(/\/+$/, "");
        if (!byDirectory.has(key)) {
          byDirectory.set(key, labels);
          const folded = key.toLowerCase();
          if (folded !== key && !byDirectory.has(folded)) byDirectory.set(folded, labels);
        }
      }
    }
    return byDirectory;
  }, [neolixWorkspaceLabelsQuery.data, neolixWorkspacesQuery.data]);
  const resolveThreadWorkspaceLabels = useCallback(
    (thread: Pick<SidebarThreadSummary, "workingDirectory" | "neolixWorkspaceId">) => {
      const workspace = resolveThreadWorkspaceRecord(thread);
      if (workspace) {
        return resolveWorkspaceLabelsForDirectory(
          [workspace],
          neolixWorkspaceLabelsQuery.data?.labels ?? [],
          workspace.directory,
        );
      }
      const directory = thread.workingDirectory?.trim();
      if (!directory) return [];
      const key = directory.replace(/\/+$/, "");
      return (
        neolixWorkspaceLabelsByDirectory.get(key) ??
        neolixWorkspaceLabelsByDirectory.get(key.toLowerCase()) ??
        []
      );
    },
    [
      neolixWorkspaceLabelsByDirectory,
      neolixWorkspaceLabelsQuery.data,
      resolveThreadWorkspaceRecord,
    ],
  );
  const workspaceLabelFilters = appSettings.sidebarLabelFilter;
  const threadMatchesWorkspaceLabelFilter = useCallback(
    (thread: Pick<SidebarThreadSummary, "workingDirectory">) => {
      if (workspaceLabelFilters.length === 0) return true;
      const labels = resolveThreadWorkspaceLabels(thread);
      if (labels.length === 0) return workspaceLabelFilters.includes(UNLABELED_LABEL_FILTER);
      return labels.some((label) =>
        workspaceLabelFilters.some((filter) => filter.toLowerCase() === label.name.toLowerCase()),
      );
    },
    [resolveThreadWorkspaceLabels, workspaceLabelFilters],
  );
  // Declared next to `keybindings` (rather than further down) because the project-row render
  // helpers above read these labels. A const declared after the closure that captures it
  // widens its inferred mutable range and makes React Compiler drop the memoization of every
  // hook that depends on it. See Sidebar.compiler.test.ts.
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.new") ??
    shortcutLabelForCommand(keybindings, "chat.newLatestProject");
  const newChatShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.newChat") ??
    shortcutLabelForCommand(keybindings, "chat.newLocal");
  const newTerminalThreadShortcutLabel = shortcutLabelForCommand(keybindings, "chat.newTerminal");
  const searchShortcutLabel =
    shortcutLabelForCommand(keybindings, "sidebar.search") ??
    (isMacNavigatorPlatform() ? t("workspace:k") : t("workspace:ctrlK"));
  const activityShortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.activity");
  const importThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "sidebar.importThread") ??
    (isMacNavigatorPlatform() ? t("workspace:i") : t("workspace:ctrlI"));
  const addProjectShortcutLabel =
    shortcutLabelForCommand(keybindings, "sidebar.addProject") ??
    (isMacNavigatorPlatform() ? t("workspace:o") : t("workspace:ctrlShiftO"));
  const usageSettingsShortcutLabel = shortcutLabelForCommand(keybindings, "settings.usage");
  const { activeProjectId: focusedProjectId } = useFocusedChatContext();
  const latestProjectId = useLatestProjectStore((state) => state.latestProjectId);
  // Shared with the composer project picker, which opens this same dialog.
  const createProjectDialogOpen = useCreateProjectDialogStore((state) => state.isOpen);
  const setCreateProjectDialogOpen = useCreateProjectDialogStore((state) => state.setOpen);
  // The open flag lives in a module store now, so it outlives this sidebar: close the
  // dialog with it, or a remounted sidebar would reopen a stale modal over everything.
  useEffect(() => () => setCreateProjectDialogOpen(false), [setCreateProjectDialogOpen]);
  useEffect(() => {
    const open = () => setCreateProjectDialogOpen(true);
    window.addEventListener(OPEN_CREATE_PROJECT_EVENT, open);
    return () => window.removeEventListener(OPEN_CREATE_PROJECT_EVENT, open);
  }, [setCreateProjectDialogOpen]);
  const [createProjectSpaceId, setCreateProjectSpaceId] = useState<SpaceId | null | undefined>();
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  const openFeedbackDialog = useFeedbackDialogStore((state) => state.openDialog);
  const [searchPaletteMode, setSearchPaletteMode] = useState<SidebarSearchPaletteMode>("search");
  const projectAdditionLockRef = useRef(false);
  const [renameDialogThreadId, setRenameDialogThreadId] = useState<ThreadId | null>(null);
  const [snoozeDialogThreadId, setSnoozeDialogThreadId] = useState<ThreadId | null>(null);
  const [labelsDialogOpen, setLabelsDialogOpen] = useState(false);
  const [archiveWorkspaceTarget, setArchiveWorkspaceTarget] = useState<{
    workspaceId: string;
    name: string;
    projectName: string;
    directory: string;
    threadId: ThreadId;
  } | null>(null);
  const [workspaceRenameTarget, setWorkspaceRenameTarget] = useState<{
    workspaceId: string;
    title: string;
  } | null>(null);
  // Archiving records the workspace in the ledger Settings › Archived lists and restores from.
  const [, setArchivedWorkspaceEntries] = useArchivedWorkspaceLedger();
  const [projectAgentDialogState, setProjectAgentDialogState] = useState<{
    projectId: ProjectId;
    mode: "onboarding" | "edit";
    /** Posted to the coordinator as its first turn once onboarding saves. */
    firstMessage?: string;
    /** The dialog opening also created the group — Cancel may offer discard. */
    discardable?: boolean;
  } | null>(null);
  // A coordinator activation scheduled from onboarding outlives the dialog: its
  // poll/timeout must not yank the user to that thread after they have moved on,
  // so keep its cancel handle and drop it on unmount and on the first navigation
  // after it was scheduled.
  const pendingCoordinatorActivationRef = useRef<{
    readonly cancel: () => void;
    readonly pathname: string;
  } | null>(null);
  useEffect(() => {
    const pending = pendingCoordinatorActivationRef.current;
    if (pending && pending.pathname !== pathname) {
      pending.cancel();
      pendingCoordinatorActivationRef.current = null;
    }
  }, [pathname]);
  useEffect(
    () => () => {
      pendingCoordinatorActivationRef.current?.cancel();
      pendingCoordinatorActivationRef.current = null;
    },
    [],
  );
  // The project stays set after close so the dialog can play its exit transition.
  const [editProjectDialog, setEditProjectDialog] = useState<{
    projectId: ProjectId;
    open: boolean;
  } | null>(null);
  const [relocateProjectDialogId, setRelocateProjectDialogId] = useState<ProjectId | null>(null);
  const [projectContextMenuState, setProjectContextMenuState] =
    useState<ProjectContextMenuState | null>(null);
  // "Show more" paging state: extra pages of THREAD_PREVIEW_PAGE_SIZE rows per project cwd.
  const [threadListExtraPagesByProjectCwd, setThreadListExtraPagesByProjectCwd] = useState<
    ReadonlyMap<string, number>
  >(() => new Map(Object.entries(readSidebarUiState().projectThreadListExtraPagesByCwd)));
  const [chatSectionExpanded, setChatSectionExpanded] = useState(
    () => readSidebarUiState().chatSectionExpanded,
  );
  const [chatThreadListExtraPages, setChatThreadListExtraPages] = useState(
    () => readSidebarUiState().chatThreadListExtraPages,
  );
  const [dismissedThreadStatusKeyByThreadId, setDismissedThreadStatusKeyByThreadId] = useState<
    Record<string, string>
  >(() => readSidebarUiState().dismissedThreadStatusKeyByThreadId);
  const [lastThreadRoute, setLastThreadRoute] = useState(
    () => readSidebarUiState().lastThreadRoute,
  );
  const [activityViewEnabled, setActivityViewEnabled] = useState(
    () => readSidebarUiState().activityViewEnabled,
  );
  // Lives here, not in SidebarActivityView, so it survives the view unmounting
  // (opening Settings swaps the sidebar surface) and reloads.
  const [activityScope, setActivityScope] = useState<ActivityScopeSelection>(
    () => readSidebarUiState().activityScope,
  );
  const [activityGroupMode, setActivityGroupMode] = useState<ActivityGroupMode>(
    () => readSidebarUiState().activityGroupMode,
  );
  const [activityVisibleThreadIds, setActivityVisibleThreadIds] = useState<readonly ThreadId[]>([]);
  const [classicSnoozedVisibleThreadIds, setClassicSnoozedVisibleThreadIds] = useState<
    readonly ThreadId[]
  >([]);
  const handleActivityVisibleThreadIdsChange = useCallback((threadIds: readonly ThreadId[]) => {
    setActivityVisibleThreadIds((current) => {
      if (
        current.length === threadIds.length &&
        current.every((threadId, index) => threadId === threadIds[index])
      ) {
        return current;
      }
      return [...threadIds];
    });
  }, []);
  // Sidebar UI state is stored as one blob. Adopt the complete external write
  // so this tab cannot persist stale paging, dismissal, or route fields over a
  // newer tab merely because the Activity toggle changed there.
  useEffect(
    () =>
      subscribeSidebarUiState((state) => {
        setChatSectionExpanded(state.chatSectionExpanded);
        setChatThreadListExtraPages(state.chatThreadListExtraPages);
        setThreadListExtraPagesByProjectCwd(
          new Map(Object.entries(state.projectThreadListExtraPagesByCwd)),
        );
        setDismissedThreadStatusKeyByThreadId(state.dismissedThreadStatusKeyByThreadId);
        setLastThreadRoute(state.lastThreadRoute);
        setActivityViewEnabled(state.activityViewEnabled);
        setActivityScope(state.activityScope);
        setActivityGroupMode(state.activityGroupMode);
      }),
    [],
  );
  // The swap unmounts one full surface and mounts the other; a transition keeps
  // the click responsive instead of blocking the main thread on large sidebars.
  const setActivityViewEnabledSmoothly = useCallback((enabled: boolean) => {
    startTransition(() => {
      setActivityViewEnabled(enabled);
    });
  }, []);
  const [optimisticActiveThreadId, setOptimisticActiveThreadId] = useState<ThreadId | null>(null);
  const lastThreadRenameTapRef = useRef<{
    threadId: ThreadId;
    timestamp: number;
  } | null>(null);
  const dragInProgressRef = useRef(false);
  const suppressThreadClickAfterDragRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const optimisticPinnedStateByProjectIdRef = useRef(new Map<ProjectId, boolean>());
  const latestPinnedMutationVersionByProjectIdRef = useRef(new Map<ProjectId, number>());
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const [installingDesktopUpdate, setInstallingDesktopUpdate] = useState(false);
  const [optimisticPinnedStateByProjectId, setOptimisticPinnedStateByProjectId] = useState<
    ReadonlyMap<ProjectId, boolean>
  >(() => new Map());
  // Dedupes the manual-download fallback toast so a single failure surfaced by
  // both the click handler and the install-watchdog push only notifies once.
  const lastDesktopUpdateErrorToastSignatureRef = useRef<string | null>(null);
  const selectedThreadIds = useThreadSelectionStore((s) => s.selectedThreadIds);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);

  // Row layout (a collapsed folder's open row, the preview cap's forced reveal)
  // follows the route, not the pointer-down optimistic id. Rebuilding the list
  // between press and release moves the row out from under the pointer, so the
  // click never fires and the thread never opens.
  const routeActiveSidebarThreadId = resolveSidebarRootThreadId(
    routeThreadId,
    sidebarThreadSummaryById,
  );
  // Hidden child routes reveal their root row without treating that root as the open chat.
  const activeSidebarThreadId = optimisticActiveThreadId ?? routeThreadId;
  // The labels dialog preselects the active thread's workspace. Hoisted out of the JSX so
  // the React Compiler never sees an optional chain nested in a conditional test block.
  const activeThreadSummary = activeSidebarThreadId
    ? sidebarThreadSummaryById[activeSidebarThreadId]
    : null;
  const activeThreadWorkspace = activeThreadSummary
    ? findWorkspaceForDirectory(
        neolixWorkspacesQuery.data?.workspaces ?? [],
        activeThreadSummary.workingDirectory,
      )
    : null;
  const createWorkspaceIdForActiveThread =
    activeThreadWorkspace?.id ?? neolixWorkspacesQuery.data?.workspaces[0]?.id ?? null;
  const visualActiveSidebarThreadId =
    pathname === "/remote" ? null : (optimisticActiveThreadId ?? routeActiveSidebarThreadId);
  const hideAutomationRunThreads = !appSettings.showAutomationRunThreads;
  const selectSidebarTreeThreads = useMemo(
    () => createSidebarDisplayThreadsSelector({ hideAutomationRunThreads }),
    [hideAutomationRunThreads],
  );
  const sidebarTreeThreads = useStore(selectSidebarTreeThreads);
  const selectProjectLastActivityAt = useMemo(() => createProjectLastActivityAtSelector(), []);
  const projectLastActivityAt = useStore(selectProjectLastActivityAt);
  const { summaryFor, summariesByProjectId, coordinatorThreadIds, membersLoaded } =
    useProjectAgentSummaries();
  // The bell and Inbox read current threads. Activity also receives snoozed rows
  // for its separate section, so badges never point at work the user set aside.
  const {
    sidebarThreads,
    displaySidebarThreads,
    groupProjectIdSet,
    groupThreads: groupSidebarThreads,
    visibleNonGroupThreads: visibleNonGroupSidebarThreads,
    activityNonGroupThreads: activityNonGroupSidebarThreads,
  } = useActivityThreads({ hideAutomationRunThreads });
  const unfilteredSidebarTreeThreads = useMemo(
    () => excludeHiddenProjectAgentCoordinatorThreads(sidebarTreeThreads, coordinatorThreadIds),
    [coordinatorThreadIds, sidebarTreeThreads],
  );
  const displaySidebarTreeThreads = useMemo(
    () =>
      workspaceLabelFilters.length === 0
        ? unfilteredSidebarTreeThreads
        : unfilteredSidebarTreeThreads.filter(threadMatchesWorkspaceLabelFilter),
    [threadMatchesWorkspaceLabelFilter, unfilteredSidebarTreeThreads, workspaceLabelFilters.length],
  );
  const { nonGroupThreads: nonGroupSidebarTreeThreads, groupThreads: groupSidebarTreeThreads } =
    useMemo(
      () =>
        partitionSidebarThreadsByProjectIds(
          displaySidebarTreeThreads,
          groupProjectIdSet,
          summariesByProjectId,
        ),
      [displaySidebarTreeThreads, groupProjectIdSet, summariesByProjectId],
    );
  const sidebarThreadsByProjectId = useMemo(
    () => groupSidebarThreadsByProjectId(displaySidebarTreeThreads),
    [displaySidebarTreeThreads],
  );
  // Manual thread order lives on this device, keyed by project id. Threads not in a
  // stored list keep their automatic (last-prompt) order after the placed ones.
  const [manualThreadOrderByProjectId, setManualThreadOrderByProjectId] = useLocalStorage(
    executionKey("sidebar-thread-order:v1"),
    {},
    Schema.Record(Schema.String, Schema.Array(Schema.String)),
  );
  const manualThreadOrderRanks = useMemo(() => {
    if (appSettings.sidebarThreadSortOrder !== "manual") return undefined;
    const ranks = new Map<string, number>();
    let next = 0;
    for (const [projectId, projectThreads] of sidebarThreadsByProjectId) {
      const automatic = sortThreadsForSidebar(projectThreads, "updated_at", {
        attentionFirst: appSettings.sidebarThreadAttentionFirst,
      });
      const remaining = new Set<string>(automatic.map((thread) => thread.id));
      for (const threadId of manualThreadOrderByProjectId[projectId] ?? []) {
        if (!remaining.delete(threadId)) continue;
        ranks.set(threadId, next);
        next += 1;
      }
      for (const thread of automatic) {
        if (!remaining.has(thread.id)) continue;
        ranks.set(thread.id, next);
        next += 1;
      }
    }
    return ranks;
  }, [
    appSettings.sidebarThreadAttentionFirst,
    appSettings.sidebarThreadSortOrder,
    manualThreadOrderByProjectId,
    sidebarThreadsByProjectId,
  ]);
  const dismissThreadStatus = useCallback(
    (threadId: ThreadId, statusKey: string | null | undefined) => {
      if (!statusKey) {
        return;
      }
      setDismissedThreadStatusKeyByThreadId((current) => {
        if (current[threadId] === statusKey) {
          return current;
        }
        return {
          ...current,
          [threadId]: statusKey,
        };
      });
    },
    [],
  );
  const clearDismissedThreadStatus = useCallback((threadId: ThreadId) => {
    setDismissedThreadStatusKeyByThreadId((current) => {
      if (!(threadId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[threadId];
      return next;
    });
  }, []);
  const handleMarkThreadUnread = useCallback(
    (threadId: ThreadId) => {
      clearDismissedThreadStatus(threadId);
      markThreadUnread(threadId);
      // Neox tracks unread on the workspace; best effort like the old UI's mark-unread.
      void readNativeApi()
        ?.neolix?.workspaces.markUnread({ threadId })
        .catch((error) => {
          console.warn("Failed to mark workspace unread", { threadId, error });
        });
    },
    [clearDismissedThreadStatus, markThreadUnread],
  );
  // The daemon has no explicit read RPC (unread is cleared when the workspace is
  // opened), so this clears the local unread/completion state only.
  const handleMarkThreadRead = useCallback(
    (threadId: ThreadId) => {
      clearDismissedThreadStatus(threadId);
      markThreadVisited(threadId);
    },
    [clearDismissedThreadStatus, markThreadVisited],
  );
  const canSnoozeThread = useCallback(
    (
      thread: Pick<
        SidebarThreadSummary,
        | "id"
        | "projectId"
        | "creationSource"
        | "sourceThreadId"
        | "parentThreadId"
        | "sidechatSourceThreadId"
        | "sidechatContext"
      >,
    ) =>
      // Neox 无 snooze 调度后端：菜单与快捷键都不提供 Snooze。
      NEOLIX_SNOOZE_UI_ENABLED &&
      canSnoozeSidebarThread({
        thread,
        groupProjectIds: groupProjectIdSet,
        summariesByProjectId,
        coordinatorThreadIds,
        membersLoaded,
      }),
    [groupProjectIdSet, summariesByProjectId, coordinatorThreadIds, membersLoaded],
  );
  const resolveThreadStatusForSidebar = useCallback(
    (thread: SidebarThreadSummary) =>
      resolveThreadStatusPill({
        thread: {
          ...thread,
          dismissedStatusKey: dismissedThreadStatusKeyByThreadId[thread.id],
        },
        hasPendingApprovals: thread.hasPendingApprovals,
        hasPendingUserInput: thread.hasPendingUserInput,
        isPreparingWorktree:
          activeComposerSendThreadIds.has(thread.id) &&
          thread.envMode === "worktree" &&
          thread.latestTurn === null &&
          thread.session === null,
      }),
    [activeComposerSendThreadIds, dismissedThreadStatusKeyByThreadId],
  );
  const resolveActivityPriorityTierForSidebar = useCallback(
    (thread: SidebarThreadSummary) =>
      resolveActivityPriorityTier(resolveThreadStatusForSidebar(thread)),
    [resolveThreadStatusForSidebar],
  );
  // Drives the dot on the header Activity bell: another chat waiting on an answer or
  // with unseen work, by Priority's tiers.
  const hasUnreadActivity = useMemo(
    () =>
      hasActivityNeedingAttention(
        visibleNonGroupSidebarThreads,
        activeSidebarThreadId,
        resolveActivityPriorityTierForSidebar,
      ),
    [activeSidebarThreadId, resolveActivityPriorityTierForSidebar, visibleNonGroupSidebarThreads],
  );

  useEffect(() => {
    if (!optimisticActiveThreadId) {
      return;
    }
    if (routeThreadId === optimisticActiveThreadId) {
      // The route caught up; drop the optimistic override on the next tick. Async
      // setState keeps this out of render, and activeSidebarThreadId already resolves
      // to the same thread via `optimistic ?? route`, so the deferral is invisible.
      const settle = window.setTimeout(() => {
        setOptimisticActiveThreadId((current) =>
          current === optimisticActiveThreadId ? null : current,
        );
      }, 0);
      return () => window.clearTimeout(settle);
    }

    const timeout = window.setTimeout(() => {
      if (pendingThreadRowAnchorRef.current?.threadId === optimisticActiveThreadId) {
        pendingThreadRowAnchorRef.current = null;
      }
      setOptimisticActiveThreadId((current) =>
        current === optimisticActiveThreadId ? null : current,
      );
    }, 1_500);
    return () => window.clearTimeout(timeout);
  }, [optimisticActiveThreadId, routeThreadId]);

  const clearThreadNotification = useCallback(
    (threadId: ThreadId) => {
      const thread = sidebarThreadSummaryById[threadId];
      if (!thread) {
        return;
      }
      const threadStatus = resolveThreadStatusForSidebar(thread);
      if (!threadStatus?.dismissible) {
        return;
      }
      if (threadStatus.label === "Completed") {
        markThreadVisited(threadId, thread.latestTurn?.completedAt ?? undefined);
        return;
      }
      if (threadStatus.label === "Reminder") {
        markThreadVisited(threadId, thread.snoozeReminderAt ?? undefined);
        return;
      }
      dismissThreadStatus(threadId, threadStatus.dismissalKey);
    },
    [
      dismissThreadStatus,
      markThreadVisited,
      resolveThreadStatusForSidebar,
      sidebarThreadSummaryById,
    ],
  );
  const routeTerminalState = routeThreadId
    ? selectThreadTerminalState(terminalStateByThreadId, routeThreadId)
    : null;
  const terminalOpen = routeTerminalState?.terminalOpen ?? false;
  const terminalWorkspaceOpen = shouldRenderTerminalWorkspace({
    presentationMode: routeTerminalState?.presentationMode ?? "drawer",
    terminalOpen,
  });
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project] as const)),
    [projects],
  );
  const filterThreadsToActiveSpace = useCallback(
    (threads: readonly SidebarThreadSummary[]) => {
      const state = useStore.getState();
      const selection = useSpacesUiStore.getState();
      return filterSidebarThreadsBySpace({
        threads,
        // A move can be confirmed between renders; navigation must use its live membership.
        projectById: new Map(state.projects.map((project) => [project.id, project])),
        spaceId: resolveActiveSpaceId(
          selection.activeSpaceId,
          state.spaces,
          selection.pendingActiveSpace?.spaceId,
        ),
        paths: { homeDir, chatWorkspaceRoot, studioWorkspaceRoot, groupsWorkspaceRoot },
      });
    },
    [chatWorkspaceRoot, groupsWorkspaceRoot, homeDir, studioWorkspaceRoot],
  );
  const {
    pinnedThreadIds,
    pinnedThreadIdSet,
    toggleThreadPinned,
    setThreadSettledWithToast,
    setThreadSnoozedUntil,
    snoozeThread,
    settledOverrideByThreadId,
    deleteThread,
    confirmAndDeleteThread,
    archiveThread,
    archiveThreadWithUndo,
    confirmAndArchiveThread,
    archiveAllThreadsInProject,
    deleteProjectThreads,
  } = useSidebarThreadActions({
    activeSplitView,
    appSettings,
    clearTerminalState,
    filterThreadsToActiveSpace,
    handleNewChat,
    projectById,
    routeSplitViewId: routeSearch.splitViewId ?? null,
    routeThreadId,
    sidebarThreads,
    sidebarTreeThreads,
    sidebarThreadSummaryById,
    threadsHydrated,
  });
  useThreadActionShortcuts({
    enabled: !isOnSettings,
    keybindings,
    routeThreadId,
    activeSplitView,
    threadById: sidebarThreadSummaryById,
    terminalStateByThreadId,
    canSnooze: canSnoozeThread,
    onArchive: confirmAndArchiveThread,
    onSnooze: setSnoozeDialogThreadId,
    onMarkUnread: handleMarkThreadUnread,
  });
  const snoozedSidebarThreads = useMemo(
    () =>
      buildActivityViewModel({
        threads: filterSidebarThreadsBySpace({
          threads: activityNonGroupSidebarThreads,
          projectById,
          spaceId: activeSpaceId,
          paths: { homeDir, chatWorkspaceRoot, studioWorkspaceRoot, groupsWorkspaceRoot },
        }),
        pinnedThreadIdSet,
      }).snoozed,
    [
      activeSpaceId,
      activityNonGroupSidebarThreads,
      chatWorkspaceRoot,
      groupsWorkspaceRoot,
      homeDir,
      pinnedThreadIdSet,
      projectById,
      studioWorkspaceRoot,
    ],
  );
  const draftThreadIdSet = useThreadIdsWithPendingDraft();
  const {
    projectRunsByProjectId,
    projectRunServerByProjectId,
    projectRunDialogProjectId,
    projectRunDialogProject,
    projectRunDialogExistingRun,
    projectRunDialogCommandDraft,
    setProjectRunDialogCommandDraft,
    projectRunDialogCommandIsValid,
    openProjectRunDialog,
    closeProjectRunDialog,
    handleConfirmProjectRun,
    handleStopProjectRun,
    handleOpenProjectRunServer,
    handleRestartProjectRun,
    handleCopyProjectRunUrl,
    handleSelectProjectRunRoute,
    devServerRouteByProjectId,
  } = useSidebarProjectRunController({
    projects,
    projectById,
    homeDir,
    chatWorkspaceRoot,
  });
  // Resolve the active thread's project for real threads AND not-yet-persisted draft threads.
  // Without the draft fallback, opening a fresh group chat (a draft at /$threadId) would drop
  // out of the Groups surface and snap the segmented picker back to Projects.
  const activeRouteProjectId = routeThreadId
    ? (sidebarThreadSummaryById[routeThreadId]?.projectId ??
      draftThreadsByThreadId[routeThreadId]?.projectId ??
      null)
    : null;
  const activeRouteProject = activeRouteProjectId
    ? (projectById.get(activeRouteProjectId) ?? null)
    : null;
  // A remote computer's Hubs routes and studio threads keep the Groups segment active.
  const workspaceSessions = useWorkspaceSessions();
  const remoteGroupActive = useMemo(() => {
    if (pathname !== "/remote") return false;
    const params = new URLSearchParams(activeWorkspaceSearch);
    const session = workspaceSessions.find(
      (entry) => entry.host.executionScope.environmentId === params.get("environment"),
    );
    const remotePath = params.get("path")?.split("?")[0];
    if (["/hubs", "/groups", "/studio"].includes(remotePath ?? "")) return true;
    const thread = session?.summary?.threads.find((entry) => `/${entry.id}` === remotePath);
    return (
      session?.summary?.projects.some(
        (project) => project.id === thread?.projectId && project.section === "studio",
      ) ?? false
    );
  }, [pathname, activeWorkspaceSearch, workspaceSessions]);
  // Use the list's validated containers and member index: a hub worker's projectId
  // points at its execution repo, which must not move its chat out of Hubs.
  const isOnGroups =
    GROUPS_ON &&
    (remoteGroupActive ||
      isOnGroupsRoute ||
      isGroupThreadRoute({
        threadId: routeThreadId,
        projectId: activeRouteProjectId,
        groupProjectIds: groupProjectIdSet,
        summariesByProjectId,
      }));
  const ordinarySpaceProjects = useMemo(
    () =>
      projects.filter((project) =>
        isOrdinarySpaceProject(project, {
          homeDir,
          chatWorkspaceRoot,
          studioWorkspaceRoot,
          groupsWorkspaceRoot,
        }),
      ),
    [chatWorkspaceRoot, groupsWorkspaceRoot, homeDir, projects, studioWorkspaceRoot],
  );

  // Only one segment's pinned threads are ever rendered at a time, so derive a single
  // memo from the already-partitioned active list instead of computing both segments'
  // pinned lists on every render (hooks can't be conditional, but the inputs can be).
  const activeSpaceNonGroupSidebarTreeThreads = useMemo(
    () =>
      filterSidebarThreadsBySpace({
        threads: nonGroupSidebarTreeThreads,
        projectById,
        spaceId: activeSpaceId,
        paths: { homeDir, chatWorkspaceRoot, studioWorkspaceRoot, groupsWorkspaceRoot },
      }),
    [
      activeSpaceId,
      chatWorkspaceRoot,
      groupsWorkspaceRoot,
      homeDir,
      nonGroupSidebarTreeThreads,
      projectById,
      studioWorkspaceRoot,
    ],
  );
  const localEnvironmentId = readExecutionContext()?.controller.environmentId ?? "local";
  const localHostLabel = readExecutionContext()?.controller.label ?? "This computer";
  const sidebarHostFilters = appSettings.sidebarHostFilters;
  const sidebarProjectFilters = appSettings.sidebarProjectFilters;
  const localHostVisible =
    sidebarHostFilters.length === 0 || sidebarHostFilters.includes(localEnvironmentId);
  const visibleWorkspaceSessions = useMemo(
    () =>
      sidebarHostFilters.length === 0
        ? workspaceSessions
        : workspaceSessions.filter((session) =>
            sidebarHostFilters.includes(session.host.executionScope.environmentId),
          ),
    [sidebarHostFilters, workspaceSessions],
  );
  const threadMatchesSidebarProjectFilter = useCallback(
    (
      thread: Pick<SidebarThreadSummary, "projectId">,
      environmentId: string = localEnvironmentId,
    ) => {
      if (sidebarProjectFilters.length === 0) return true;
      return sidebarProjectFilters.includes(
        checkoutKey({ environmentId, projectId: thread.projectId }),
      );
    },
    [localEnvironmentId, sidebarProjectFilters],
  );
  const sidebarDisplayHosts = useMemo(() => {
    const hosts: Array<{ id: string; label: string }> = [
      { id: localEnvironmentId, label: localHostLabel },
    ];
    const seen = new Set([localEnvironmentId]);
    for (const session of workspaceSessions) {
      const id = session.host.executionScope.environmentId;
      if (seen.has(id)) continue;
      seen.add(id);
      hosts.push({ id, label: session.host.hostName });
    }
    return hosts;
  }, [localEnvironmentId, localHostLabel, workspaceSessions]);
  const sidebarDisplayProjects = useMemo(() => {
    const options: Array<{ key: string; label: string }> = [];
    const seen = new Set<string>();
    for (const project of projects) {
      const key = checkoutKey({ environmentId: localEnvironmentId, projectId: project.id });
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({ key, label: project.name });
    }
    for (const entry of remoteSidebarProjects(workspaceSessions)) {
      if (seen.has(entry.key)) continue;
      seen.add(entry.key);
      options.push({ key: entry.key, label: entry.project.name });
    }
    return options;
  }, [localEnvironmentId, projects, workspaceSessions]);
  const pinnedThreads = useMemo(
    () =>
      getPinnedThreadsForSidebar(
        isOnGroups ? groupSidebarTreeThreads : activeSpaceNonGroupSidebarTreeThreads,
        pinnedThreadIds,
      ),
    [activeSpaceNonGroupSidebarTreeThreads, isOnGroups, pinnedThreadIds, groupSidebarTreeThreads],
  );
  // "Group by label" replaces the project tree with one section per label. A thread belongs to
  // the first label its checkout carries; pinned rows keep their own section above.
  const sidebarLabelGroups = useMemo(() => {
    if (appSettings.sidebarGroupBy !== "label" || !localHostVisible) return [];
    const pinnedIdSet = new Set(pinnedThreadIds);
    const threads = sortThreadsForSidebar(
      nonGroupSidebarTreeThreads.filter(
        (thread) =>
          thread.archivedAt == null &&
          thread.snoozedUntil == null &&
          thread.parentThreadId == null &&
          !pinnedIdSet.has(thread.id) &&
          threadMatchesSidebarProjectFilter(thread) &&
          isSidebarThreadVisible(thread, { hideAutomationRunThreads }),
      ),
      appSettings.sidebarThreadSortOrder,
      {
        attentionFirst: appSettings.sidebarThreadAttentionFirst,
        manualOrderRanks: manualThreadOrderRanks,
      },
    );
    const groups = new Map<
      string,
      { key: string; label: string; color: string | null; threads: SidebarThreadSummary[] }
    >();
    for (const thread of threads) {
      const definition = resolveThreadWorkspaceLabels(thread)[0] ?? null;
      const key = definition?.name.toLowerCase() ?? UNLABELED_LABEL_FILTER;
      const group = groups.get(key) ?? {
        key,
        label: definition?.name ?? t("workspace:labels_unlabeled"),
        color: definition?.color ?? null,
        threads: [],
      };
      group.threads.push(thread);
      groups.set(key, group);
    }
    return [...groups.values()].toSorted((left, right) => {
      if (left.key === UNLABELED_LABEL_FILTER) return 1;
      if (right.key === UNLABELED_LABEL_FILTER) return -1;
      return left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
    });
  }, [
    appSettings.sidebarGroupBy,
    appSettings.sidebarThreadAttentionFirst,
    appSettings.sidebarThreadSortOrder,
    hideAutomationRunThreads,
    localHostVisible,
    manualThreadOrderRanks,
    nonGroupSidebarTreeThreads,
    pinnedThreadIds,
    resolveThreadWorkspaceLabels,
    t,
    threadMatchesSidebarProjectFilter,
  ]);
  // "Group by status" mirrors the old UI's status sections: actionable first,
  // then failed, ready to review, working, and done. Pinned rows keep their section.
  const sidebarStatusGroups = useMemo(() => {
    if (appSettings.sidebarGroupBy !== "status" || !localHostVisible) return [];
    const pinnedIdSet = new Set(pinnedThreadIds);
    const threads = sortThreadsForSidebar(
      nonGroupSidebarTreeThreads.filter(
        (thread) =>
          thread.archivedAt == null &&
          thread.snoozedUntil == null &&
          thread.parentThreadId == null &&
          !pinnedIdSet.has(thread.id) &&
          threadMatchesSidebarProjectFilter(thread) &&
          isSidebarThreadVisible(thread, { hideAutomationRunThreads }),
      ),
      appSettings.sidebarThreadSortOrder,
      {
        attentionFirst: appSettings.sidebarThreadAttentionFirst,
        manualOrderRanks: manualThreadOrderRanks,
      },
    );
    const buckets = new Map<SidebarStatusBucket, SidebarThreadSummary[]>();
    for (const thread of threads) {
      const bucket = resolveSidebarStatusBucket({
        status: resolveThreadStatusForSidebar(thread),
        sessionStatus: thread.session?.status ?? null,
      });
      const rows = buckets.get(bucket) ?? [];
      rows.push(thread);
      buckets.set(bucket, rows);
    }
    return SIDEBAR_STATUS_BUCKET_ORDER.flatMap((bucket) => {
      const rows = buckets.get(bucket);
      if (!rows || rows.length === 0) return [];
      return [{ key: bucket, label: t(SIDEBAR_STATUS_BUCKET_LABEL_KEYS[bucket]), threads: rows }];
    });
  }, [
    appSettings.sidebarGroupBy,
    appSettings.sidebarThreadAttentionFirst,
    appSettings.sidebarThreadSortOrder,
    hideAutomationRunThreads,
    localHostVisible,
    manualThreadOrderRanks,
    nonGroupSidebarTreeThreads,
    pinnedThreadIds,
    resolveThreadStatusForSidebar,
    t,
    threadMatchesSidebarProjectFilter,
  ]);
  const openPrLink = useCallback(
    (event: MouseEvent<HTMLElement>, prUrl: string) => {
      event.preventDefault();
      event.stopPropagation();

      const api = readNativeApi();
      if (!api) {
        toastManager.add({
          type: "error",
          title: t("git:linkOpeningIsUnavailable"),
        });
        return;
      }

      void api.shell.openExternal(prUrl).catch((error) => {
        toastManager.add({
          type: "error",
          title: t("git:toast_unableToOpenPrLink"),
          description:
            error instanceof Error ? error.message : t("common:proposedPlan_unknownError"),
        });
      });
    },
    [t],
  );
  const projectCwdById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.cwd] as const)),
    [projects],
  );
  const projectByIdRef = useRef(projectById);
  useEffect(() => {
    projectByIdRef.current = projectById;
  }, [projectById]);
  const setOptimisticProjectPinned = useCallback((projectId: ProjectId, isPinned: boolean) => {
    optimisticPinnedStateByProjectIdRef.current.set(projectId, isPinned);
    setOptimisticPinnedStateByProjectId((current) => {
      if (current.get(projectId) === isPinned) {
        return current;
      }
      const next = new Map(current);
      next.set(projectId, isPinned);
      return next;
    });
  }, []);
  const clearOptimisticProjectPinned = useCallback((projectId: ProjectId) => {
    optimisticPinnedStateByProjectIdRef.current.delete(projectId);
    setOptimisticPinnedStateByProjectId((current) => {
      if (!current.has(projectId)) {
        return current;
      }
      const next = new Map(current);
      next.delete(projectId);
      return next;
    });
  }, []);
  const dispatchProjectPinnedState = useCallback(
    async (projectId: ProjectId, isPinned: boolean) => {
      const api = readNativeApi();
      if (!api) return;
      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId,
        isPinned,
      });
    },
    [],
  );
  const setProjectPinned = useCallback(
    async (projectId: ProjectId, isPinned: boolean) => {
      const api = readNativeApi();
      if (!api) return;
      const project = projectByIdRef.current.get(projectId);
      if (!project || project.kind !== "project") {
        return;
      }
      const requestVersion =
        (latestPinnedMutationVersionByProjectIdRef.current.get(projectId) ?? 0) + 1;
      latestPinnedMutationVersionByProjectIdRef.current.set(projectId, requestVersion);

      setOptimisticProjectPinned(projectId, isPinned);
      if (isPinned) {
        const accepted = pinProjectLocally(projectId);
        if (!accepted) {
          clearOptimisticProjectPinned(projectId);
          toastManager.add({
            type: "warning",
            title: t("workspace:toast_projectPinLimitReached"),
            description: t("workspace:youCanPinUpToProjects", {
              value0: MAX_PINNED_PROJECTS,
            }),
          });
          return;
        }
      } else {
        unpinProject(projectId);
      }

      try {
        await dispatchProjectPinnedState(projectId, isPinned);
      } catch (error) {
        if (
          !isLatestPinnedProjectMutation({
            projectId,
            requestVersion,
            latestMutationVersionByProjectId: latestPinnedMutationVersionByProjectIdRef.current,
          })
        ) {
          return;
        }

        const confirmedPinned = projectByIdRef.current.get(projectId)?.isPinned === true;
        if (confirmedPinned) {
          pinProjectLocally(projectId);
        } else {
          unpinProject(projectId);
        }
        clearOptimisticProjectPinned(projectId);
        throw error;
      }
    },
    [
      clearOptimisticProjectPinned,
      dispatchProjectPinnedState,
      pinProjectLocally,
      setOptimisticProjectPinned,
      unpinProject,
      t,
    ],
  );
  const toggleProjectPinned = useCallback(
    (projectId: ProjectId) => {
      const optimisticPinned = optimisticPinnedStateByProjectIdRef.current.get(projectId);
      const locallyPinned = usePinnedProjectsStore.getState().pinnedProjectIds.includes(projectId);
      const serverPinned = projectByIdRef.current.get(projectId)?.isPinned === true;
      const isPinned = optimisticPinned ?? (locallyPinned || serverPinned);
      void setProjectPinned(projectId, !isPinned).catch((error) => {
        console.error("Failed to update pinned project state", {
          projectId,
          error,
        });
        toastManager.add({
          type: "error",
          title: isPinned
            ? t("workspace:toast_unableToUnpinProject")
            : t("workspace:toast_unableToPinProject"),
          description: error instanceof Error ? error.message : undefined,
        });
      });
    },
    [setProjectPinned, t],
  );
  // The palette dispatches this event instead of receiving the ref-backed callback, which
  // keeps ref reads out of the render path the React Compiler analyzes.
  useEffect(() => {
    const onTogglePinProject = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: ProjectId }>).detail;
      if (detail?.projectId) toggleProjectPinned(detail.projectId);
    };
    window.addEventListener(WORKSPACE_TOGGLE_PIN_PROJECT_EVENT, onTogglePinProject);
    return () => window.removeEventListener(WORKSPACE_TOGGLE_PIN_PROJECT_EVENT, onTogglePinProject);
  }, [toggleProjectPinned]);
  useEffect(() => {
    if (optimisticPinnedStateByProjectId.size === 0) {
      return;
    }

    const serverPinnedStateByProjectId = new Map(
      projects.map((project) => [project.id, project.isPinned === true] as const),
    );
    // Reconciliation drops optimistic entries the server has confirmed while syncing
    // the mirror ref. Deferring the setState off render (async is allowed) leaves the
    // derived pinned lists unchanged, since a confirmed entry is redundant either way.
    const settle = window.setTimeout(() => {
      setOptimisticPinnedStateByProjectId((current) => {
        const reconciled = reconcileOptimisticPinState({
          optimisticPinnedStateById: current,
          serverPinnedStateById: serverPinnedStateByProjectId,
        });
        for (const projectId of reconciled.settledIds) {
          optimisticPinnedStateByProjectIdRef.current.delete(projectId);
        }
        return reconciled.optimisticPinnedStateById;
      });
    }, 0);
    return () => window.clearTimeout(settle);
  }, [optimisticPinnedStateByProjectId, projects]);
  const focusMostRecentThreadForProject = useCallback(
    (projectId: ProjectId) => {
      // Only navigate to threads the sidebar actually shows — focusing a hidden
      // automation-run thread would select a row the user can't see.
      const latestThread = sortThreadsForSidebar(
        displaySidebarThreads.filter(
          (thread) =>
            thread.projectId === projectId &&
            isSidebarThreadVisible(thread, { hideAutomationRunThreads }),
        ),
        appSettings.sidebarThreadSortOrder,
        { attentionFirst: appSettings.sidebarThreadAttentionFirst },
      )[0];
      if (!latestThread) return;

      void navigate({
        to: "/$threadId",
        params: { threadId: latestThread.id },
      });
    },
    [
      appSettings.sidebarThreadAttentionFirst,
      appSettings.sidebarThreadSortOrder,
      displaySidebarThreads,
      hideAutomationRunThreads,
      navigate,
    ],
  );

  const openOrCreateProjectThreadFromSnapshot = useCallback(
    async (projectId: ProjectId, snapshot: OrchestrationShellSnapshot): Promise<boolean> => {
      // The store may already contain events newer than this response. Rank
      // each candidate from its coherent normalized summary, including visits.
      const summaries = useStore.getState().sidebarThreadSummaryById;
      const latestThread = sortThreadsForSidebar(
        snapshot.threads
          .flatMap((thread) => {
            const summary = summaries[thread.id];
            return summary ? [summary] : [];
          })
          .filter(
            (thread) =>
              thread.projectId === projectId &&
              !thread.parentThreadId &&
              (thread.archivedAt ?? null) === null &&
              thread.snoozedUntil == null &&
              !isSidechatThread(thread),
          ),
        appSettings.sidebarThreadSortOrder,
        { attentionFirst: appSettings.sidebarThreadAttentionFirst },
      )[0];
      if (latestThread) {
        await navigate({
          to: "/$threadId",
          params: { threadId: latestThread.id },
        });
        return true;
      }

      return (await handleNewThread(projectId).catch(() => null)) !== null;
    },
    [
      appSettings.sidebarThreadAttentionFirst,
      appSettings.sidebarThreadSortOrder,
      handleNewThread,
      navigate,
    ],
  );

  const openExistingProjectFromSnapshot = useCallback(
    async (projectId: ProjectId, snapshot: OrchestrationShellSnapshot): Promise<boolean> => {
      const existingProject =
        snapshot.projects.find((candidate) => candidate.id === projectId) ?? null;
      if (!existingProject) {
        return false;
      }

      // The store may already contain events newer than this response. Rank
      // each candidate from its coherent normalized summary, including visits.
      const summaries = useStore.getState().sidebarThreadSummaryById;
      const latestThread = sortThreadsForSidebar(
        snapshot.threads
          .flatMap((thread) => {
            const summary = summaries[thread.id];
            return summary ? [summary] : [];
          })
          .filter(
            (thread) =>
              thread.projectId === projectId &&
              !thread.parentThreadId &&
              (thread.archivedAt ?? null) === null &&
              thread.snoozedUntil == null,
          ),
        appSettings.sidebarThreadSortOrder,
        { attentionFirst: appSettings.sidebarThreadAttentionFirst },
      )[0];
      if (latestThread) {
        await navigate({
          to: "/$threadId",
          params: { threadId: latestThread.id },
        });
        return true;
      }

      setProjectExpanded(projectId, true);
      return (await handleNewThread(projectId).catch(() => null)) !== null;
    },
    [
      appSettings.sidebarThreadAttentionFirst,
      appSettings.sidebarThreadSortOrder,
      handleNewThread,
      navigate,
      setProjectExpanded,
    ],
  );

  // Poll the server read model briefly after project.create so we only recover from fresh state.
  const waitForProjectInSnapshot = useCallback(
    async (
      api: NonNullable<ReturnType<typeof readNativeApi>>,
      projectId: ProjectId,
      workspaceRoot?: string,
    ): Promise<{
      project: OrchestrationShellSnapshot["projects"][number] | null;
      snapshot: OrchestrationShellSnapshot | null;
    }> =>
      waitForRecoverableProjectInReadModel({
        projectId,
        ...(workspaceRoot ? { workspaceRoot } : {}),
        loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
        maxAttempts: ADD_PROJECT_SNAPSHOT_CATCH_UP_MAX_ATTEMPTS,
        delayMs: ADD_PROJECT_SNAPSHOT_CATCH_UP_DELAY_MS,
      }),
    [],
  );

  // Cancellation can arrive while the server is committing project.create. Give
  // that durable commit and its read-model projection enough time to become
  // observable before reporting the clone as cancelled.
  const waitForCancelledGitHubProjectInSnapshot = useCallback(
    async (
      api: NonNullable<ReturnType<typeof readNativeApi>>,
      projectId: ProjectId,
      workspaceRoot?: string,
    ): Promise<{
      project: OrchestrationShellSnapshot["projects"][number] | null;
      snapshot: OrchestrationShellSnapshot | null;
    }> =>
      waitForRecoverableProjectInReadModel({
        projectId,
        ...(workspaceRoot ? { workspaceRoot } : {}),
        loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
        maxAttempts: GITHUB_CANCEL_RECOVERY_MAX_ATTEMPTS,
        delayMs: GITHUB_CANCEL_RECOVERY_DELAY_MS,
      }),
    [],
  );

  const waitForProjectWorkspaceRootInSnapshot = useCallback(
    async (
      api: NonNullable<ReturnType<typeof readNativeApi>>,
      workspaceRoot: string,
    ): Promise<{
      project: OrchestrationShellSnapshot["projects"][number] | null;
      snapshot: OrchestrationShellSnapshot | null;
    }> =>
      waitForRecoverableProjectInReadModel({
        workspaceRoot,
        loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
        maxAttempts: ADD_PROJECT_SNAPSHOT_CATCH_UP_MAX_ATTEMPTS,
        delayMs: ADD_PROJECT_SNAPSHOT_CATCH_UP_DELAY_MS,
      }),
    [],
  );

  // Keep add-project recovery on the same fresh-snapshot path for create, duplicate, and existing-project flows.
  const recoverExistingProjectFromServer = useCallback(
    async (
      api: NonNullable<ReturnType<typeof readNativeApi>>,
      projectId: ProjectId,
    ): Promise<boolean> => {
      const { project, snapshot } = await waitForProjectInSnapshot(api, projectId);
      if (snapshot) {
        syncServerShellSnapshot(snapshot);
      }
      if (!project || !snapshot) {
        return false;
      }

      return openExistingProjectFromSnapshot(project.id, snapshot);
    },
    [openExistingProjectFromSnapshot, syncServerShellSnapshot, waitForProjectInSnapshot],
  );

  const recoverExistingProjectByWorkspaceRootFromServer = useCallback(
    async (
      api: NonNullable<ReturnType<typeof readNativeApi>>,
      workspaceRoot: string,
    ): Promise<boolean> => {
      const { project, snapshot } = await waitForProjectWorkspaceRootInSnapshot(api, workspaceRoot);
      if (snapshot) {
        syncServerShellSnapshot(snapshot);
      }
      if (!project || !snapshot) {
        return false;
      }

      return openExistingProjectFromSnapshot(project.id, snapshot);
    },
    [
      openExistingProjectFromSnapshot,
      syncServerShellSnapshot,
      waitForProjectWorkspaceRootInSnapshot,
    ],
  );

  const handleOpenProjectFromSearch = useCallback(
    (projectId: string) => {
      const typedProjectId = ProjectId.makeUnsafe(projectId);
      // Match focusMostRecentThreadForProject's visibility filter: if a project's only
      // threads are hidden automation runs, fall through to creating a fresh thread
      // instead of focusing nothing.
      const hasProjectThread = sidebarThreads.some(
        (thread) =>
          thread.projectId === typedProjectId &&
          isSidebarThreadVisible(thread, { hideAutomationRunThreads }),
      );
      if (hasProjectThread) {
        focusMostRecentThreadForProject(typedProjectId);
        return;
      }

      void handleNewThread(typedProjectId);
    },
    [focusMostRecentThreadForProject, handleNewThread, hideAutomationRunThreads, sidebarThreads],
  );

  useEffect(() => {
    if (!threadsHydrated) return;
    const open = (ref: CheckoutRef | null) => {
      if (!ref || ref.environmentId !== readExecutionContext()?.execution.environmentId) return;
      if (!projects.some((project) => project.id === ref.projectId)) {
        toastManager.add({
          type: "error",
          title: t("workspace:checkoutNoLongerAvailable"),
        });
        return;
      }
      handleOpenProjectFromSearch(ref.projectId);
    };
    const listener = (event: Event) => open((event as CustomEvent<CheckoutRef>).detail);
    window.addEventListener(CATALOG_OPEN_EVENT, listener);
    return () => {
      window.removeEventListener(CATALOG_OPEN_EVENT, listener);
    };
  }, [threadsHydrated, projects, handleOpenProjectFromSearch, t]);

  // Shared resolver behind resolveBackToGroupsTarget/resolveBackToThreadsTarget (and the
  // settings-back path below) — differs only in which segment's thread list and draft ids are
  // passed in.
  const resolveBackTargetForThreads = useCallback(
    (threads: readonly SidebarThreadSummary[], extraAvailableThreadIds?: ReadonlySet<string>) => {
      const latestThread =
        sortThreadsForSidebar(threads, appSettings.sidebarThreadSortOrder, {
          attentionFirst: appSettings.sidebarThreadAttentionFirst,
        })[0] ?? null;
      const availableThreadIds = new Set<string>(threads.map((thread) => thread.id));
      if (extraAvailableThreadIds) {
        for (const threadId of extraAvailableThreadIds) {
          availableThreadIds.add(threadId);
        }
      }
      return resolveSettingsBackTarget({
        lastThreadRoute,
        availableThreadIds,
        availableSplitViewIds: new Set(
          Object.keys(splitViewsById).filter((splitViewId) => splitViewsById[splitViewId]),
        ),
        latestThreadId: latestThread?.id ?? null,
      });
    },
    [
      appSettings.sidebarThreadAttentionFirst,
      appSettings.sidebarThreadSortOrder,
      lastThreadRoute,
      splitViewsById,
    ],
  );

  // Fresh unsent chats have a route id but no persisted sidebar summary yet. Keep those draft
  // routes valid return targets — scoped to whichever segment the draft's project belongs to —
  // for both the settings back button and the segment switcher.
  const groupDraftThreadIds = useMemo(() => {
    const draftThreadIds = new Set<string>();
    for (const [threadId, draft] of Object.entries(draftThreadsByThreadId)) {
      if (groupProjectIdSet.has(draft.projectId)) {
        draftThreadIds.add(threadId);
      }
    }
    return draftThreadIds;
  }, [draftThreadsByThreadId, groupProjectIdSet]);
  const nonGroupDraftThreadIds = useMemo(() => {
    const draftThreadIds = new Set<string>();
    for (const [threadId, draft] of Object.entries(draftThreadsByThreadId)) {
      if (!groupProjectIdSet.has(draft.projectId)) {
        draftThreadIds.add(threadId);
      }
    }
    return draftThreadIds;
  }, [draftThreadsByThreadId, groupProjectIdSet]);

  // Where the Groups segment lands, resolved directly (remembered Groups route, else the latest
  // group chat) instead of bouncing through the "/hubs" splash route — that extra hop +
  // async redirect is what made the segment switch feel sluggish. Mirrors
  // resolveBackToThreadsTarget so both segments restore the thread you were last on.
  // Archived chats are excluded, matching the /hubs landing: the sidebar hides them, so
  // neither the segment switch nor settings back may resurrect one.
  const activeGroupSidebarThreads = useMemo(
    () => groupSidebarThreads.filter((thread) => (thread.archivedAt ?? null) === null),
    [groupSidebarThreads],
  );
  const resolveBackToGroupsTarget = useCallback(
    () => resolveBackTargetForThreads(activeGroupSidebarThreads, groupDraftThreadIds),
    [activeGroupSidebarThreads, resolveBackTargetForThreads, groupDraftThreadIds],
  );

  const resolveBackToThreadsTarget = useCallback(
    () => resolveBackTargetForThreads(visibleNonGroupSidebarThreads, nonGroupDraftThreadIds),
    [nonGroupDraftThreadIds, resolveBackTargetForThreads, visibleNonGroupSidebarThreads],
  );

  // Navigates to a resolved settings-back / segment-switch target. Returns whether it navigated
  // to a thread so callers can fall back to creating a fresh chat/home route otherwise.
  const navigateToBackTarget = useCallback(
    (target: SettingsBackTarget) => {
      if (target.kind !== "thread") {
        return false;
      }
      // The route swap re-renders the whole sidebar surface plus the destination
      // ChatView in one go; run it as a transition so urgent click feedback (the
      // segmented picker's optimistic thumb) paints first instead of freezing
      // until the heavy render commits.
      startTransition(() => {
        void navigate({
          to: "/$threadId",
          params: { threadId: ThreadId.makeUnsafe(target.threadId) },
          search: () => ({
            splitViewId: target.splitViewId,
          }),
        });
      });
      return true;
    },
    [navigate],
  );

  // Settings is reachable from either segment (Threads or Groups) and from routes outside the
  // sidebar entirely (see EnvironmentPanel, __root, etc.), so we can't infer "which segment was
  // active" from the route once we're already on /settings. Instead we remember the last active
  // segment continuously (mirrors the lastThreadRoute tracking below) and use that on the way
  // back. This keeps the back button from bouncing across segments when the remembered thread
  // route is stale (e.g. its thread was deleted): the segment-scoped resolver falls back to that
  // *same* segment's latest thread instead of the globally most-recent thread.
  const lastActiveSidebarSegmentRef = useRef<"groups" | "threads">("threads");
  useEffect(() => {
    if (isOnSettings) {
      return;
    }
    lastActiveSidebarSegmentRef.current = isOnGroups ? "groups" : "threads";
  }, [isOnSettings, isOnGroups]);

  // Shared Groups fallback: the /hubs index route restores the last group thread or shows
  // the Groups empty state, so landing there is the no-implicit-creation fallback.
  const openGroupChatFallback = useCallback(() => {
    void navigate({ to: "/hubs" });
  }, [navigate]);

  const handleSidebarViewChange = useCallback(
    (view: SidebarView) => {
      if (view === "groups") {
        // Remembered route first — it already treats stored group drafts as valid targets
        // (resolveBackToGroupsTarget includes groupDraftThreadIds), so switching back to Groups
        // returns to the thread you were on, not an old empty draft.
        if (navigateToBackTarget(resolveBackToGroupsTarget())) {
          return;
        }
        openGroupChatFallback();
        return;
      }

      if (navigateToBackTarget(resolveBackToThreadsTarget())) {
        return;
      }

      // Reuse the stored home-chat draft when one exists (same as the "New chat"
      // button) so switching back to the Chats view never destroys an in-progress
      // draft; only mint a fresh draft when there is nothing to resume.
      void handleNewChat();
    },
    [
      handleNewChat,
      navigateToBackTarget,
      openGroupChatFallback,
      resolveBackToGroupsTarget,
      resolveBackToThreadsTarget,
    ],
  );

  // The `/hubs` route owns the hidden-section redirect (a hidden Groups tab
  // also hides the section surface only) — the sidebar must not bounce group
  // threads opened from search, split view, or a link while the tab is hidden.
  useEffect(() => {
    // Persisted paths make homeDir truthy
    // immediately on reload, well before the first shell snapshot arrives.
    if (!threadsHydrated || !homeDir) {
      return;
    }
    prewarmHomeChatProject({ homeDir, chatWorkspaceRoot });
  }, [chatWorkspaceRoot, homeDir, threadsHydrated]);
  // Opens a fresh home-chat draft directly on the draft thread route so the first send
  // does not need a second route swap from "/" to "/$threadId".
  const handleCreateHomeChat = useCallback(async () => {
    // Reuse the stored home-chat draft thread when one exists (matching the
    // project "New thread" button), so a draft typed in a new chat survives
    // switching to another thread and back. Only mint a fresh draft when there
    // is no stored draft to resume.
    await handleNewChat();
  }, [handleNewChat]);

  const addProjectFromPath = useCallback(
    async (
      rawCwd: string,
      options: {
        name?: string;
        createIfMissing?: boolean;
        spaceId?: SpaceId | null;
        additionalFolders?: ReadonlyArray<string>;
      } = {},
    ) => {
      const cwd = rawCwd.trim();
      if (!cwd) {
        throw new Error("Project folder path is empty.");
      }
      const api = readNativeApi();
      if (!api) {
        throw new Error("The app server is unavailable.");
      }

      // The flow lives in a nested function that the exclusive lock helper merely awaits: React
      // Compiler's BuildHIR cannot lower a `throw` or a value block (`?.`, `??`, ternary,
      // conditional spread) that sits directly inside a try block, and a single one of them
      // makes the entire Sidebar bail out of compilation — silently, since `panicThreshold`
      // is unset. Nested function bodies are lowered separately and are unaffected, and the
      // catch below still sees every rejection. See Sidebar.compiler.test.ts.
      const additionalFolders = options.additionalFolders ?? [];
      const runAddProject = async () => {
        const existing = findWorkspaceRootMatch(projects, cwd, (project) => project.cwd);
        // A multi-folder project never reopens an existing one: that would drop its extra
        // folders. The create below reports the conflict instead.
        const existingRecovery = await recoverExistingAddProjectTarget({
          existingProjectId: additionalFolders.length > 0 ? undefined : existing?.id,
          workspaceRoot: cwd,
          recoverByProjectId: (projectId) => recoverExistingProjectFromServer(api, projectId),
          recoverByWorkspaceRoot: (workspaceRoot) =>
            recoverExistingProjectByWorkspaceRootFromServer(api, workspaceRoot),
        });
        if (existingRecovery === "recovered") {
          return;
        }
        if (existing) {
          // Local project state can briefly outlive a server-side project.deleted event.
          // Continue to project.create so re-adding the folder revives it instead of opening a dead shell.
        }

        const creationResult = await createOrRecoverProjectFromPath({
          api,
          workspaceRoot: cwd,
          ...(options.name ? { name: options.name } : {}),
          ...(additionalFolders.length > 0 ? { additionalFolders } : {}),
          ...(options.createIfMissing === undefined
            ? {}
            : { createIfMissing: options.createIfMissing }),
          ...(options.spaceId === undefined ? {} : { spaceId: options.spaceId }),
          defaultProvider: appSettings.defaultProvider,
          loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
          maxAttempts: ADD_PROJECT_SNAPSHOT_CATCH_UP_MAX_ATTEMPTS,
          delayMs: ADD_PROJECT_SNAPSHOT_CATCH_UP_DELAY_MS,
        });
        if (creationResult.snapshot) {
          syncServerShellSnapshot(creationResult.snapshot);
        }
        if (creationResult.project && creationResult.snapshot) {
          const recovered = creationResult.created
            ? await openOrCreateProjectThreadFromSnapshot(
                creationResult.project.id,
                creationResult.snapshot,
              )
            : await openExistingProjectFromSnapshot(
                creationResult.project.id,
                creationResult.snapshot,
              );
          if (recovered) {
            return;
          }
          if (creationResult.created) {
            // The opener's draft navigation was superseded; retrying here
            // would override the user's newer route.
            throw new Error("Project creation was superseded before its chat opened.");
          }
        }

        if (!creationResult.created) {
          const recovered = await recoverExistingProjectFromServer(api, creationResult.projectId);
          if (recovered) {
            return;
          }
          throw new Error(PROJECT_CREATE_EXISTING_SYNC_ERROR);
        }

        // The command already committed successfully at this point. If the projection
        // snapshot is just slow to catch up, continue with the local new-thread flow
        // instead of surfacing a false-negative sidebar sync error.
        setProjectExpanded(creationResult.projectId, true);
        const threadId = await handleNewThread(creationResult.projectId).catch(() => null);
        if (!threadId) {
          throw new Error("Project creation was superseded before its chat opened.");
        }
      };

      await runExclusiveProjectAddition(projectAdditionLockRef, runAddProject);
    },
    [
      appSettings.defaultProvider,
      handleNewThread,
      projects,
      recoverExistingProjectFromServer,
      recoverExistingProjectByWorkspaceRootFromServer,
      openOrCreateProjectThreadFromSnapshot,
      openExistingProjectFromSnapshot,
      setProjectExpanded,
      syncServerShellSnapshot,
    ],
  );

  const handleStartAddProject = useCallback(() => {
    setCreateProjectDialogOpen(true);
  }, [setCreateProjectDialogOpen]);

  const activeSpaceProjects = useMemo(
    () => ordinarySpaceProjects.filter((project) => (project.spaceId ?? null) === activeSpaceId),
    [activeSpaceId, ordinarySpaceProjects],
  );
  const currentProjectShortcutTargetId = useMemo(
    () => resolveCurrentProjectTargetId(activeSpaceProjects, focusedProjectId),
    [activeSpaceProjects, focusedProjectId],
  );
  const latestUsableProjectId = useMemo(
    () =>
      resolveLatestProjectTargetIdWithFallback(
        activeSpaceProjects,
        latestProjectId,
        projectLastActivityAt,
      ),
    [activeSpaceProjects, latestProjectId, projectLastActivityAt],
  );
  const primaryNewThreadTarget = useMemo(
    () =>
      resolveNewThreadTarget({
        currentProjectId: currentProjectShortcutTargetId,
        latestUsableProjectId,
      }),
    [currentProjectShortcutTargetId, latestUsableProjectId],
  );

  // Warm model discovery before ChatView mounts so new-thread composers skip
  // the "Loading models" skeleton when React Query already has a fresh cache hit.
  const prefetchModelsForProjectNewThread = useCallback(
    (projectId: ProjectId, options?: { includeDroid?: boolean }) => {
      const project = projects.find((candidate) => candidate.id === projectId);
      if (!project) {
        return;
      }

      const draftStore = useComposerDraftStore.getState();
      const draftThread = draftStore.getDraftThreadByProjectId(projectId, "chat");
      const draftComposer = draftThread
        ? (draftStore.draftsByThreadId[draftThread.threadId] ?? null)
        : null;
      prefetchModelsForNewThread(queryClient, {
        settings: appSettings,
        serverSettings: serverSettings ?? null,
        hiddenProviders: appSettings.hiddenProviders,
        draftActiveProvider: draftComposer?.activeProvider ?? null,
        stickyActiveProvider: draftStore.stickyActiveProvider,
        projectDefaultProvider: project.defaultModelSelection?.provider ?? null,
        projectCwd: project.cwd,
        draftWorktreePath: draftThread?.worktreePath ?? null,
        serverCwd,
        // Match new-thread bootstrap: preserve existing drafts and apply project
        // preferences only when creating a fresh one.
        envMode:
          draftThread?.envMode ??
          useProjectEnvironmentStore.getState().envModeByProjectId[projectId] ??
          appSettings.defaultThreadEnvMode,
        providerStatuses,
        statusesReconciled: hasReconciledServerProviderStatuses(queryClient),
        providerOrder: appSettings.providerOrder,
        includeDroid: options?.includeDroid === true,
      });
    },
    [appSettings, projects, providerStatuses, queryClient, serverCwd, serverSettings],
  );

  const prefetchModelsForPrimaryNewThread = useCallback(() => {
    if (!primaryNewThreadTarget) {
      return;
    }
    // Idle hover/focus must not spin Droid's expensive per-model ACP discovery;
    // only explicit new-thread intent (the click path below) warms Droid.
    prefetchModelsForProjectNewThread(primaryNewThreadTarget.projectId);
  }, [prefetchModelsForProjectNewThread, primaryNewThreadTarget]);

  useEffect(() => {
    if (!primaryNewThreadTarget) {
      return;
    }
    prefetchModelsForProjectNewThread(primaryNewThreadTarget.projectId);
  }, [prefetchModelsForProjectNewThread, primaryNewThreadTarget]);

  const handlePrimaryNewThread = useCallback(() => {
    if (pathname === "/remote") {
      const environmentId = new URLSearchParams(activeWorkspaceSearch).get("environment");
      const session = workspaceSessions.find(
        (entry) => entry.host.executionScope.environmentId === environmentId,
      );
      const navigation = session && readAvailableWorkspaceNavigation(session);
      if (!session || !navigation) {
        toastManager.add({
          type: "error",
          title: t("workspace:couldNotCreateChat"),
          description: t("workspace:reconnectBeforeCreatingChat"),
        });
        return;
      }
      void navigation
        .newChat(session.summary?.activeProjectId)
        .then((path) => openWorkspacePath(session, path))
        .catch((error: unknown) =>
          toastManager.add({
            type: "error",
            title: t("workspace:couldNotCreateChat"),
            description: error instanceof Error ? error.message : t("chat:tryAgain"),
          }),
        );
      return;
    }
    const liveState = useStore.getState();
    // Hydration can change between rendering this button and handling its click.
    // Wait before warming models or treating an empty snapshot as no projects.
    if (!liveState.threadsHydrated) {
      return;
    }
    const liveTarget =
      primaryNewThreadTarget &&
      liveState.projects.some((project) => project.id === primaryNewThreadTarget.projectId)
        ? primaryNewThreadTarget
        : null;
    if (liveTarget) {
      prefetchModelsForProjectNewThread(liveTarget.projectId, { includeDroid: true });
      void handleNewThread(liveTarget.projectId);
      return;
    }

    handleStartAddProject();
  }, [
    pathname,
    activeWorkspaceSearch,
    workspaceSessions,
    handleNewThread,
    handleStartAddProject,
    prefetchModelsForProjectNewThread,
    primaryNewThreadTarget,
    t,
  ]);

  const handleImportThread = useCallback(
    async (target: ThreadImportTarget, externalId: string) => {
      const api = readNativeApi();
      if (!api) {
        throw new Error("The app server is unavailable.");
      }

      if (!currentProjectShortcutTargetId) {
        throw new Error("Add a project before importing a thread.");
      }

      const activeProject = projects.find(
        (project) => project.id === currentProjectShortcutTargetId,
      );
      if (!activeProject) {
        throw new Error("The target project could not be resolved.");
      }

      const { provider, instanceId } = target;
      const providerDefaultModel = getDefaultModel(provider);
      let modelSelection =
        activeProject.defaultModelSelection?.provider === provider &&
        activeProject.defaultModelSelection.instanceId === instanceId
          ? activeProject.defaultModelSelection
          : providerDefaultModel
            ? {
                provider,
                instanceId,
                model: providerDefaultModel,
              }
            : null;
      if (!modelSelection && provider === "omp") {
        // OMP has no static default model; the imported session's own last-used
        // model wins server-side during import. The thread record still needs a
        // catalog-valid placeholder selection.
        const catalog = await queryClient
          .fetchQuery(
            providerModelsQueryOptions({
              provider: "omp",
              instanceId,
              cwd: activeProject.cwd,
            }),
          )
          .catch(() => null);
        const fallbackModel = catalog?.models[0]?.slug;
        modelSelection = fallbackModel
          ? {
              provider: "omp",
              instanceId,
              model: fallbackModel,
            }
          : null;
      }
      if (!modelSelection) {
        throw new Error(
          provider === "omp"
            ? t("workspace:noOmpModelsConfigured")
            : t("workspace:selectModelBeforeImport", {
                provider: PROVIDER_DISPLAY_NAMES[provider],
              }),
        );
      }
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const trimmedExternalId = externalId.trim();
      const suffix = trimmedExternalId.slice(-8);
      const title =
        provider === "claudeAgent"
          ? t("workspace:importedClaudeSession", { value0: suffix ? ` ${suffix}` : "" })
          : provider === "cursor"
            ? t("workspace:importedCursorSession", { value0: suffix ? ` ${suffix}` : "" })
            : provider === "droid"
              ? t("workspace:importedDroidSession", { value0: suffix ? ` ${suffix}` : "" })
              : provider === "opencode"
                ? t("workspace:importedOpenCodeSession", { value0: suffix ? ` ${suffix}` : "" })
                : provider === "omp"
                  ? t("workspace:importedOhMyPiSession", { value0: suffix ? ` ${suffix}` : "" })
                  : t("workspace:importedCodexThread", { value0: suffix ? ` ${suffix}` : "" });
      let createdThread = false;

      try {
        await api.orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId,
          projectId: activeProject.id,
          title,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          envMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
          branch: null,
          worktreePath: null,
          createdAt,
        });
        createdThread = true;

        const imported = await api.orchestration.importThread({
          threadId,
          externalId: trimmedExternalId,
        });
        // The server may assign its own id to the imported thread (Neox does); open that one
        // and drop the placeholder created above.
        if (imported.threadId !== threadId) {
          await api.orchestration
            .dispatchCommand({ type: "thread.delete", commandId: newCommandId(), threadId })
            .catch(() => undefined);
        }

        await navigate({
          to: "/$threadId",
          params: { threadId: imported.threadId },
        });
      } catch (error) {
        if (createdThread) {
          await api.orchestration
            .dispatchCommand({
              type: "thread.delete",
              commandId: newCommandId(),
              threadId,
            })
            .catch(() => undefined);
        }
        throw error;
      }
    },
    [
      appSettings.defaultThreadEnvMode,
      currentProjectShortcutTargetId,
      navigate,
      projects,
      queryClient,
      t,
    ],
  );

  const commitRename = useCallback(
    async (threadId: ThreadId, newTitle: string, originalTitle: string) => {
      const outcome = await dispatchThreadRename({
        threadId,
        newTitle,
        unchangedTitles: [originalTitle],
      }).catch((error) => {
        toastManager.add({
          type: "error",
          title: t("chat:toast_failedToRenameThread"),
          description:
            error instanceof Error ? error.message : t("common:proposedPlan_unknownError"),
        });
        return null;
      });

      if (outcome === "empty") {
        toastManager.add({
          type: "warning",
          title: t("chat:toast_threadTitleCannotBeEmpty"),
        });
      } else if (outcome === "renamed") {
        // The row shows the workspace title; refetch it even when the thread's title was already
        // the new name and no title change reaches the shell.
        void queryClient.invalidateQueries({ queryKey: neolixWorkspacesQueryKey });
      }
    },
    [queryClient, t],
  );

  const openRenameThreadDialog = useCallback(
    (threadId: ThreadId) => {
      setRenameDialogThreadId(threadId);
    },
    [setRenameDialogThreadId],
  );

  const confirmArchiveWorkspace = useCallback(async () => {
    const target = archiveWorkspaceTarget;
    if (!target) return;
    const api = readNativeApi();
    if (!api?.neolix) return;
    try {
      await api.neolix.workspaces.archive({ workspaceId: target.workspaceId });
      setArchivedWorkspaceEntries((current) => [
        ...current.filter((entry) => entry.workspaceId !== target.workspaceId),
        {
          workspaceId: target.workspaceId,
          name: target.name,
          projectName: target.projectName,
          directory: target.directory,
          archivedAt: new Date().toISOString(),
        },
      ]);
      await queryClient.invalidateQueries({ queryKey: neolixWorkspacesQueryKey });
      await queryClient.invalidateQueries({ queryKey: neolixArchivedWorkspacesQueryKey });
      setArchiveWorkspaceTarget(null);
      toastManager.add({ title: t("workspace:workspaceArchiveSuccess") });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("workspace:workspaceArchiveFailed"),
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [
    archiveWorkspaceTarget,
    queryClient,
    setArchivedWorkspaceEntries,
    setArchiveWorkspaceTarget,
    t,
  ]);

  const renameWorkspace = useCallback(
    async (title: string) => {
      if (!workspaceRenameTarget) return;
      const api = readNativeApi();
      if (!api?.neolix) return;
      await api.neolix.workspaces.setTitle({
        workspaceId: workspaceRenameTarget.workspaceId,
        title: title.trim() ? title.trim() : null,
      });
      await queryClient.invalidateQueries({ queryKey: neolixWorkspacesQueryKey });
    },
    [queryClient, workspaceRenameTarget],
  );

  const handleThreadRenamePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>, threadId: ThreadId) => {
      if (event.pointerType !== "touch" && event.pointerType !== "pen") {
        return;
      }

      const previousTap = lastThreadRenameTapRef.current;
      const currentTapTimestamp = event.timeStamp;
      if (
        previousTap &&
        previousTap.threadId === threadId &&
        currentTapTimestamp - previousTap.timestamp <= 320
      ) {
        event.preventDefault();
        event.stopPropagation();
        lastThreadRenameTapRef.current = null;
        openRenameThreadDialog(threadId);
        return;
      }

      lastThreadRenameTapRef.current = {
        threadId,
        timestamp: currentTapTimestamp,
      };
    },
    [openRenameThreadDialog],
  );

  const { prewarmThreadDetail: prewarmThreadDetailForIntent } = useThreadDetailPrewarm();

  const primeThreadActivation = useCallback(
    (event: ReactPointerEvent<HTMLElement>, threadId: ThreadId) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      prewarmThreadDetailForIntent(threadId);
      setOptimisticActiveThreadId(threadId);
    },
    [prewarmThreadDetailForIntent, setOptimisticActiveThreadId],
  );

  // Segment-switch counterpart of primeThreadActivation: hovering/clicking a
  // segment resolves the thread the switch will land on and opens its detail
  // subscription early, so the destination transcript is warm instead of popping
  // in after a subscribe round-trip once the route has already swapped.
  const prewarmSidebarViewTarget = useCallback(
    (view: SidebarView) => {
      if (view !== "groups" && view !== "threads") {
        return;
      }
      const target = view === "groups" ? resolveBackToGroupsTarget() : resolveBackToThreadsTarget();
      if (target.kind === "thread") {
        prewarmThreadDetailForIntent(ThreadId.makeUnsafe(target.threadId));
      }
    },
    [prewarmThreadDetailForIntent, resolveBackToGroupsTarget, resolveBackToThreadsTarget],
  );

  const copyThreadIdToClipboard = useCopyThreadIdToClipboard();
  const copyPathToClipboard = useCopyPathToClipboard();
  const copyBranchNameToClipboard = useCopyBranchNameToClipboard();
  const handoffThread = useCallback(
    async (thread: Thread, target: ThreadHandoffTarget) => {
      try {
        await createThreadHandoff(thread, target.provider, target.instanceId);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("chat:toast_couldNotCreateHandoffThread"),
          description:
            error instanceof Error
              ? error.message
              : t("chat:toast_couldNotCreateHandoffThreadDescription"),
        });
      }
    },
    [createThreadHandoff, t],
  );

  const continueHandoffInThread = useCallback(
    async (thread: Thread, target: ThreadHandoffTarget) => {
      try {
        await continueThreadHandoff(thread, target.provider, target.instanceId);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("chat:couldNotHandOffThisThread"),
          description:
            error instanceof Error
              ? error.message
              : t("chat:anErrorOccurredWhileHandingOffTheThread"),
        });
      }
    },
    [continueThreadHandoff, t],
  );

  const forkThread = useCallback(
    async (thread: Thread, target: ForkThreadTarget) => {
      const api = readNativeApi();
      if (!api) return;
      const projectCwd = projectCwdById.get(thread.projectId) ?? null;
      // Only a thread without its own branch needs the root checkout's branch.
      const needsRootBranch = !thread.branch && projectCwd !== null;
      // Promise chains rather than try/catch: React Compiler bails out on value
      // blocks inside a try statement, and this file has a zero-bailout budget.
      await (
        needsRootBranch
          ? queryClient
              .fetchQuery(gitBranchesQueryOptions(projectCwd))
              .then((result) => result.branches)
              .catch(() => null)
          : Promise.resolve(null)
      )
        .then((branches) =>
          dispatchThreadFork({
            api,
            sourceThread: thread,
            target,
            rootBranch: resolveComposerSlashRootBranch({
              branches,
              activeProjectCwd: projectCwd,
              activeThreadBranch: thread.branch,
            }),
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
          }),
        )
        .then(async (nextThreadId) => {
          syncServerShellSnapshot(await api.orchestration.getShellSnapshot());
          await navigate({ to: "/$threadId", params: { threadId: nextThreadId } });
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: t("workspace:couldNotForkThread"),
            description:
              error instanceof Error
                ? error.message
                : t("workspace:anErrorOccurredWhileCreatingTheForkedThread"),
          });
        });
    },
    [navigate, projectCwdById, queryClient, syncServerShellSnapshot, t],
  );

  // Posts the "pick this thread up" user message to a group's coordinator once
  // its coordinator thread exists (right after onboarding save, or immediately
  // when moving a thread into a configured group).
  const postGroupPickupMessage = useCallback(
    async (coordinatorThreadId: ThreadId, text: string): Promise<boolean> => {
      const api = readNativeApi();
      if (!api) return false;
      // Run the coordinator under its configured runtime mode — never a
      // blanket full-access turn.
      const runtimeMode =
        useStore.getState().threadShellById?.[coordinatorThreadId]?.runtimeMode ??
        "approval-required";
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: coordinatorThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text,
            attachments: [],
          },
          runtimeMode,
          interactionMode: "default",
          createdAt: new Date().toISOString(),
        });
        return true;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("workspace:couldNotNotifyTheCoordinator"),
          description:
            error instanceof Error ? error.message : t("common:proposedPlan_unknownError"),
        });
        return false;
      }
    },
    [t],
  );

  const continueThreadAsGroup = useCallback(
    async (thread: Thread) => {
      const api = readNativeApi();
      if (!api?.projectAgent) return;
      const groupId = await createGroupProject({
        title: thread.title ?? t("workspace:newHub"),
      }).catch(() => null);
      if (!groupId) {
        toastManager.add({
          type: "error",
          title: t("workspace:unableToCreateHub"),
          description: t("workspace:theHubsWorkspaceIsNotReadyYetTryAgain"),
        });
        return;
      }
      const overview = await api.projectAgent
        .linkProject({
          requestId: randomUUID(),
          projectId: groupId,
          linkedProjectId: thread.projectId,
        })
        .catch(() => null);
      if (!overview) {
        toastManager.add({
          type: "error",
          title: t("workspace:hubCreatedButTheProjectCouldNotBeLinked"),
          description: t("workspace:linkTheRepositoryFromTheHubSSettingsInstead"),
        });
      }
      setProjectAgentDialogState({
        projectId: groupId,
        mode: "onboarding",
        firstMessage: groupPickupMessageText(thread),
        discardable: true,
      });
    },
    [t, setProjectAgentDialogState],
  );
  const moveThreadToGroup = useCallback(
    async (thread: Thread, targetGroupProjectId: ProjectId) => {
      const api = readNativeApi();
      if (!api?.projectAgent) return;
      const overview = await api.projectAgent
        .linkProject({
          requestId: randomUUID(),
          projectId: targetGroupProjectId,
          linkedProjectId: thread.projectId,
        })
        .catch(() => null);
      if (!overview) {
        toastManager.add({
          type: "error",
          title: t("workspace:couldNotMoveTheThreadToTheHub"),
          description: t("workspace:theProjectMayAlreadyBeLinkedToThatHub"),
        });
        return;
      }
      const coordinatorThreadId = overview.config?.coordinatorThreadId;
      if (coordinatorThreadId) {
        await postGroupPickupMessage(coordinatorThreadId, groupPickupMessageText(thread));
      } else {
        toastManager.add({
          type: "info",
          title: t("workspace:projectLinked"),
          description: t("workspace:setUpTheHubSCoordinatorToHandThe"),
        });
      }
    },
    [postGroupPickupMessage, t],
  );

  const handleThreadContextMenu = useCallback(
    async (
      threadId: ThreadId,
      position: { x: number; y: number },
      options?: ThreadContextMenuOptions,
    ) => {
      const api = readNativeApi();
      if (!api) return;
      const thread = getThreadFromState(useStore.getState(), threadId);
      if (!thread) return;
      const extraItems = options?.extraItems ?? [];
      // Declarative plugin agent actions sit beside the built-in row actions.
      ensurePluginCatalogLoaded();
      const pluginItems = pluginAgentActionItems(readPluginCatalog().plugins);
      const allExtraItems = pluginItems.length > 0 ? [...extraItems, ...pluginItems] : extraItems;
      // Only leaf rows resolve the menu; a parent row just opens its submenu.
      const extraItemIds = new Set(
        extraItems.flatMap((item) => item.children?.map((child) => child.id) ?? [item.id]),
      );
      const threadSummary = sidebarThreadSummaryById[threadId];
      const isPinned = pinnedThreadIdSet.has(threadId);
      const hasPendingApprovals =
        threadSummary?.hasPendingApprovals ??
        derivePendingApprovals(thread.activities, thread.pendingInteractions, {
          authoritativeHasPending: thread.hasPendingApprovals,
          latestTurnId: thread.latestTurn?.turnId,
        }).length > 0;
      const hasPendingUserInput =
        threadSummary?.hasPendingUserInput ??
        derivePendingUserInputs(thread.activities, thread.pendingInteractions, {
          authoritativeHasPending: thread.hasPendingUserInput,
          latestTurnId: thread.latestTurn?.turnId,
        }).length > 0;
      const handoffAvailability = resolveThreadHandoffAvailability({
        isGroupContainer: groupProjectIdSet.has(thread.projectId),
        isCoordinatorThread: coordinatorThreadIds.has(threadId),
      });
      // Neox 的 bridge 不处理 thread.handoff.create：与 ChatView 一样由开关隐藏移交入口。
      const canHandoff =
        NEOLIX_PROVIDER_HANDOFF_UI_ENABLED &&
        handoffAvailability.providerHandoff &&
        canCreateThreadHandoff({
          thread,
          hasPendingApprovals,
          hasPendingUserInput,
        });
      const threadStatus = threadSummary ? resolveThreadStatusForSidebar(threadSummary) : null;
      // The old UI showed the workspace branch; the thread shell may have none for a
      // local checkout, so fall back to the workspace record joined by directory.
      const threadBranch =
        thread.branch?.trim() || resolveThreadWorkspaceRecord(thread)?.branch?.trim() || null;
      const canSnooze = canSnoozeThread(thread);
      const handoffTargets = canHandoff
        ? resolveAvailableHandoffTargets({
            sourceProvider: thread.modelSelection.provider,
            sourceProviderInstanceId:
              thread.session?.providerInstanceId ?? thread.modelSelection.instanceId,
            providerInstances: getProviderInstanceOptions(appSettings),
            providerStatuses,
          })
        : [];
      const continueHandoffTargets = handoffTargets.filter((target) =>
        canContinueThreadHandoff({
          sourceProvider: thread.modelSelection.provider,
          targetProvider: target.provider,
        }),
      );
      const handoffTargetById = new Map(
        handoffTargets.map((target) => [`handoff:${target.instanceId}`, target]),
      );
      const continueHandoffTargetById = new Map(
        continueHandoffTargets.map((target) => [`handoff-here:${target.instanceId}`, target]),
      );
      const handoffItems = contextMenuGroup(
        { id: "handoff", label: t("workspace:handoff"), icon: THREAD_CONTEXT_MENU_ICONS.handoff },
        [
          ...continueHandoffTargets.map((target) => ({
            id: `handoff-here:${target.instanceId}`,
            label: t("workspace:inThisThread", { value0: target.label }),
            standaloneLabel: t("workspace:handoffToInThisThread", { value0: target.label }),
            icon: THREAD_CONTEXT_MENU_ICONS.handoff,
          })),
          ...handoffTargets.map((target, index) => ({
            id: `handoff:${target.instanceId}`,
            label:
              continueHandoffTargets.length > 0
                ? t("workspace:inANewThread", { value0: target.label })
                : target.label,
            standaloneLabel: t("workspace:handoffTo", { value0: target.label }),
            icon: THREAD_CONTEXT_MENU_ICONS.handoff,
            ...(index === 0 && continueHandoffTargets.length > 0 ? { separatorBefore: true } : {}),
          })),
        ],
      );
      // Same action as `/fork`.
      const canFork = canForkThread({ thread, handoffAvailability });
      const forkItems = canFork
        ? contextMenuGroup(
            { id: "fork", label: t("workspace:fork"), icon: THREAD_CONTEXT_MENU_ICONS.fork },
            [
              {
                id: "fork:local",
                label: forkThreadTargetLabel("local", t),
                icon: THREAD_CONTEXT_MENU_ICONS.forkLocal,
              },
              {
                id: "fork:worktree",
                label: forkThreadTargetLabel("worktree", t),
                icon: THREAD_CONTEXT_MENU_ICONS.forkWorktree,
              },
            ],
          )
        : [];
      if (forkItems[0] && handoffItems.length === 0) {
        forkItems[0] = { ...forkItems[0], separatorBefore: true };
      }
      if (handoffItems[0]) {
        handoffItems[0] = { ...handoffItems[0], separatorBefore: true };
      }
      const threadWorkspacePath = resolveThreadWorkspaceCwd({
        projectCwd: projectCwdById.get(thread.projectId) ?? null,
        envMode: thread.envMode,
        worktreePath: thread.worktreePath,
      });
      // Group actions only make sense for threads in ordinary (non-group)
      // projects; group threads, workers included, already belong to a group.
      const canUseHubActions =
        GROUPS_ON &&
        !mayBelongToGroup({
          threadId,
          projectId: thread.projectId,
          creationSource: thread.creationSource,
          sourceThreadId: thread.sourceThreadId,
          groupProjectIds: groupProjectIdSet,
          summariesByProjectId,
          coordinatorThreadIds,
          membersLoaded,
        }) &&
        !thread.parentThreadId;
      // Paused and archived groups can't run a coordinator turn, so they
      // aren't move targets — the server refuses the turn either way.
      const eligibleGroups = canUseHubActions
        ? projects.filter((project) => {
            const summary = summaryFor(project.id);
            return (
              groupProjectIdSet.has(project.id) &&
              summary?.archivedAt == null &&
              summary?.pausedAt == null
            );
          })
        : [];
      const hubItems = canUseHubActions
        ? contextMenuGroup(
            {
              id: "hub",
              label: t("workspace:hub"),
              icon: THREAD_CONTEXT_MENU_ICONS.group,
              separatorBefore: true,
            },
            [
              {
                id: "continue-as-group",
                label: t("workspace:continueAsANewHub"),
                standaloneLabel: t("workspace:continueAsAHub"),
                icon: THREAD_CONTEXT_MENU_ICONS.group,
              },
              ...eligibleGroups.map((project, index) => ({
                id: `move-to-group:${project.id}`,
                label: t("workspace:moveTo", { value0: project.name }),
                icon: THREAD_CONTEXT_MENU_ICONS.group,
                separatorBefore: index === 0,
              })),
            ],
          )
        : [];
      // Labels live on the Neox workspace, so the menu reads the workspace registry once per
      // open and marks the ones already assigned to this thread's checkout.
      const neolix = api.neolix;
      const [labelCatalog, workspaceRegistry] = await Promise.all([
        neolix ? neolix.workspaces.labels().catch(() => null) : null,
        neolix ? neolix.workspaces.list().catch(() => null) : null,
      ]);
      const labelDirectory = thread.workingDirectory?.trim() || threadWorkspacePath;
      const workspaceById = thread.neolixWorkspaceId
        ? (workspaceRegistry?.workspaces.find(
            (workspace) => workspace.id === thread.neolixWorkspaceId,
          ) ?? null)
        : null;
      const directoryKey = labelDirectory?.replace(/\/+$/, "");
      const directoryMatches = directoryKey
        ? (neolixWorkspacesByDirectory.get(directoryKey) ??
          neolixWorkspacesByDirectory.get(directoryKey.toLowerCase()))
        : undefined;
      const labelWorkspace =
        workspaceById ?? (directoryMatches?.length === 1 ? directoryMatches[0]! : null);
      // A session that owns its workspace renames it with "Rename chat" (the bridge renames both),
      // so a second rename item would do the same thing. Shared or directory-matched workspaces
      // keep it.
      const ownsLabelWorkspace =
        workspaceById !== null &&
        !Object.values(useStore.getState().sidebarThreadSummaryById).some(
          (summary) =>
            summary !== undefined &&
            summary.id !== thread.id &&
            summary.neolixWorkspaceId === workspaceById.id,
        );
      const assignedLabelNames = new Set(labelWorkspace?.labels ?? []);
      const labelDeclarations = labelCatalog?.labels ?? [];
      const labelItems =
        labelDeclarations.length > 0
          ? contextMenuGroup(
              {
                id: "labels",
                label: t("workspace:contextMenu_labels"),
                icon: THREAD_CONTEXT_MENU_ICONS.label,
                separatorBefore: true,
              },
              labelDeclarations.map((declaration) => ({
                id: `label:${declaration.name}`,
                label: assignedLabelNames.has(declaration.name)
                  ? `✓ ${declaration.name}`
                  : declaration.name,
                icon: THREAD_CONTEXT_MENU_ICONS.label,
              })),
            )
          : [];
      const clicked = await api.contextMenu.show(
        [
          {
            id: "rename",
            label: t("workspace:contextMenu_renameThread"),
            icon: THREAD_CONTEXT_MENU_ICONS.rename,
          },
          {
            id: "toggle-pin",
            label: pinActionLabel(t("chat:pinTargetThread"), isPinned),
            icon: THREAD_CONTEXT_MENU_ICONS.pin,
          },
          ...(threadStatus?.dismissible
            ? [
                {
                  id: "clear-notification",
                  label: t("workspace:contextMenu_clearNotification"),
                  icon: THREAD_CONTEXT_MENU_ICONS.clearNotification,
                },
              ]
            : []),
          ...(hasUnseenCompletion(thread)
            ? [
                {
                  id: "mark-read",
                  label: t("workspace:markRead"),
                  icon: THREAD_CONTEXT_MENU_ICONS.markUnread,
                },
              ]
            : [
                {
                  id: "mark-unread",
                  label: t("workspace:markUnread"),
                  icon: THREAD_CONTEXT_MENU_ICONS.markUnread,
                },
              ]),
          ...(canSnooze
            ? [
                ...(threadSummary?.snoozedUntil != null
                  ? [
                      {
                        id: "snooze-cancel",
                        label: t("workspace:returnNow"),
                        icon: THREAD_CONTEXT_MENU_ICONS.snooze,
                        separatorBefore: true,
                      },
                    ]
                  : []),
                ...contextMenuGroup(
                  {
                    id: "snooze",
                    label:
                      threadSummary?.snoozedUntil != null
                        ? t("workspace:reschedule")
                        : t("workspace:snooze"),
                    icon: THREAD_CONTEXT_MENU_ICONS.snooze,
                    separatorBefore: threadSummary?.snoozedUntil == null,
                  },
                  [
                    ...SNOOZE_PRESETS.map((preset) => ({
                      id: preset.id,
                      label: t(preset.labelKey),
                      icon: THREAD_CONTEXT_MENU_ICONS.snooze,
                    })),
                    {
                      id: "snooze-custom",
                      label: t("workspace:pickDateTime"),
                      icon: THREAD_CONTEXT_MENU_ICONS.snooze,
                    },
                  ],
                ),
              ]
            : []),
          ...handoffItems,
          ...forkItems,
          ...labelItems,
          ...contextMenuGroup(
            {
              id: "copy",
              label: t("workspace:share_copy"),
              icon: THREAD_CONTEXT_MENU_ICONS.copy,
              separatorBefore: true,
            },
            [
              {
                id: "copy-path",
                label: t("workspace:path"),
                standaloneLabel: t("workspace:copyPath"),
                icon: THREAD_CONTEXT_MENU_ICONS.copy,
              },
              {
                id: "copy-thread-id",
                label: t("workspace:searchPalette_threadId"),
                standaloneLabel: t("workspace:copyThreadID"),
                icon: THREAD_CONTEXT_MENU_ICONS.copy,
              },
              ...(threadBranch
                ? [
                    {
                      id: "copy-branch",
                      label: t("workspace:branchName"),
                      standaloneLabel: t("workspace:copyBranchName"),
                      icon: THREAD_CONTEXT_MENU_ICONS.copy,
                    },
                  ]
                : []),
            ],
          ),
          ...(threadWorkspacePath
            ? [
                {
                  id: "open-path-in-terminal",
                  label: t("workspace:openPathInTerminal"),
                  icon: THREAD_CONTEXT_MENU_ICONS.openInTerminal,
                },
              ]
            : []),
          ...allExtraItems,
          ...(labelWorkspace && neolix
            ? [
                ...(ownsLabelWorkspace
                  ? []
                  : [
                      {
                        id: "rename-workspace",
                        label: t("workspace:workspaceRename"),
                        icon: THREAD_CONTEXT_MENU_ICONS.rename,
                        separatorBefore: true,
                      },
                    ]),
                {
                  id: "archive-workspace",
                  label: t("workspace:workspaceArchive"),
                  icon: THREAD_CONTEXT_MENU_ICONS.archive,
                  separatorBefore: ownsLabelWorkspace,
                },
              ]
            : []),
          ...hubItems,
          // Subagent threads are archived and restored through their parent
          // (thread.archive cascades); archiving one alone would strand it with
          // no sidebar or Archived-panel row to restore it from.
          ...(thread.parentThreadId
            ? []
            : [
                {
                  id: "archive",
                  // Named "Archive thread" so it reads apart from "Archive workspace" right above it.
                  label: t("common:archive_archiveThread"),
                  icon: THREAD_CONTEXT_MENU_ICONS.archive,
                  // Shares the workspace-archive group when that item sits directly above.
                  separatorBefore: !(labelWorkspace && neolix) || hubItems.length > 0,
                },
              ]),
          {
            id: "delete",
            label: t("computer:detail_delete"),
            icon: THREAD_CONTEXT_MENU_ICONS.delete,
            destructive: true,
            ...(thread.parentThreadId ? { separatorBefore: true } : {}),
          },
        ],
        position,
      );

      if (clicked !== null && isPluginAgentActionItemId(clicked)) {
        await runPluginAgentActionItem({
          plugins: readPluginCatalog().plugins,
          itemId: clicked,
          agentId: threadId,
          agentName: thread.title?.trim() || threadId,
        }).catch(() => undefined);
        return;
      }
      if (clicked !== null && extraItemIds.has(clicked)) {
        await options?.onExtraAction?.(clicked);
        return;
      }
      if (clicked === "rename") {
        openRenameThreadDialog(threadId);
        return;
      }
      if (clicked === "rename-workspace") {
        if (labelWorkspace) {
          setWorkspaceRenameTarget({
            workspaceId: labelWorkspace.id,
            title: labelWorkspace.title ?? labelWorkspace.name,
          });
        }
        return;
      }
      if (clicked === "archive-workspace") {
        if (labelWorkspace) {
          const projectName =
            projects.find((project) => project.id === thread.projectId)?.name ??
            labelWorkspace.name;
          setArchiveWorkspaceTarget({
            workspaceId: labelWorkspace.id,
            name: labelWorkspace.title ?? labelWorkspace.name,
            projectName,
            directory: labelWorkspace.directory,
            threadId,
          });
        }
        return;
      }
      if (clicked === "toggle-pin") {
        toggleThreadPinned(threadId);
        return;
      }
      if (typeof clicked === "string" && clicked.startsWith("label:")) {
        const name = clicked.slice("label:".length);
        const declaration = labelDeclarations.find((entry) => entry.name === name);
        if (declaration) {
          if (!neolix) {
            toastManager.add({
              type: "error",
              title: t("workspace:couldNotUpdateLabel"),
              description: t("workspace:workspaceLabelNotUpdated"),
            });
            return;
          }
          const targetWorkspaceId = labelWorkspace ? labelWorkspace.id : null;
          const labelInput = {
            threadId,
            ...(targetWorkspaceId ? { workspaceId: targetWorkspaceId } : {}),
            label: declaration,
            assigned: !assignedLabelNames.has(name),
          };
          try {
            await neolix.workspaces.setLabel(labelInput);
            await queryClient.invalidateQueries({ queryKey: neolixWorkspacesQueryKey });
          } catch (error) {
            toastManager.add({
              type: "error",
              title: t("workspace:couldNotUpdateLabel"),
              description:
                error instanceof Error ? error.message : t("workspace:workspaceLabelNotUpdated"),
            });
          }
        }
        return;
      }

      if (clicked === "mark-unread") {
        handleMarkThreadUnread(threadId);
        return;
      }
      if (clicked === "mark-read") {
        handleMarkThreadRead(threadId);
        return;
      }
      if (clicked === "clear-notification") {
        clearThreadNotification(threadId);
        return;
      }
      if (clicked === "snooze-cancel") {
        setThreadSnoozedUntil(threadId, null);
        return;
      }
      if (clicked === "snooze-custom") {
        setSnoozeDialogThreadId(threadId);
        return;
      }
      const snoozePreset = SNOOZE_PRESETS.find((preset) => preset.id === clicked);
      if (snoozePreset) {
        snoozeThread(threadId, snoozePreset.duration);
        return;
      }
      if (typeof clicked === "string" && clicked.startsWith("handoff-here:")) {
        const target = continueHandoffTargetById.get(clicked);
        if (target) {
          await continueHandoffInThread(thread, target);
        }
        return;
      }
      if (typeof clicked === "string" && clicked.startsWith("handoff:")) {
        const target = handoffTargetById.get(clicked);
        if (target) {
          await handoffThread(thread, target);
        }
        return;
      }
      if (clicked === "copy-path") {
        if (!threadWorkspacePath) {
          toastManager.add({
            type: "error",
            title: t("workspace:toast_pathUnavailable"),
            description: t("workspace:thisThreadDoesNotHaveAWorkspacePathTo"),
          });
          return;
        }
        copyPathToClipboard(threadWorkspacePath);
        return;
      }
      if (clicked === "open-path-in-terminal") {
        if (!threadWorkspacePath) {
          toastManager.add({
            type: "error",
            title: t("workspace:toast_pathUnavailable"),
            description: t("workspace:thisThreadDoesNotHaveAWorkspacePathTo2"),
          });
          return;
        }
        await navigate({ to: "/$threadId", params: { threadId } });
        const terminalStore = useTerminalStateStore.getState();
        const currentTerminalState = selectThreadTerminalState(
          terminalStore.terminalStateByThreadId,
          threadId,
        );

        const targetTerminalId = currentTerminalState.activeTerminalId;
        if (currentTerminalState.runningTerminalIds.includes(targetTerminalId)) {
          toastManager.add({
            type: "error",
            title: t("workspace:terminalIsBusy"),
            description: t("workspace:stopItsCommandBeforeOpeningAnotherPath"),
          });
          return;
        }
        const shouldCreateNewTerminal = !currentTerminalState.terminalOpen;

        const previousTerminalOpen = currentTerminalState.terminalOpen;
        const previousPresentationMode = currentTerminalState.presentationMode;
        const previousActiveTerminalId = currentTerminalState.activeTerminalId;

        terminalStore.setTerminalPresentationMode(threadId, "workspace");
        terminalStore.setTerminalOpen(threadId, true);
        terminalStore.setActiveTerminal(threadId, targetTerminalId);

        const cdCommand = `cd ${quotePosixShellArgument(threadWorkspacePath)}\r`;
        try {
          if (shouldCreateNewTerminal) {
            // A brand new PTY needs an explicit cwd so that the shell's first
            // prompt already shows the workspace path. The follow-up `cd` write
            // makes the navigation visible in the scrollback (it's effectively
            // a no-op since the shell is already there, but it matches the
            // user-typed-it experience).
            await api.terminal.open({
              threadId,
              terminalId: targetTerminalId,
              cwd: threadWorkspacePath,
            });
          }
          // Existing PTYs keep their launch cwd/env on reattach; writing `cd`
          // navigates in place without replacing shell state.
          await api.terminal.write({
            threadId,
            terminalId: targetTerminalId,
            data: cdCommand,
            onlyIfIdle: true,
          });
        } catch (error) {
          // Open may already have created a PTY, even if navigation or its
          // acknowledgement failed. Keep its identity available for reattach.
          terminalStore.setTerminalPresentationMode(threadId, previousPresentationMode);
          terminalStore.setTerminalOpen(threadId, previousTerminalOpen);
          if (previousActiveTerminalId) {
            terminalStore.setActiveTerminal(threadId, previousActiveTerminalId);
          }
          toastManager.add({
            type: "error",
            title: t("workspace:toast_unableToOpenTerminal"),
            description:
              error instanceof Error ? error.message : t("workspace:theTerminalCouldNotBeOpened"),
          });
        }
        return;
      }
      if (clicked === "copy-thread-id") {
        copyThreadIdToClipboard(threadId);
        return;
      }
      if (clicked === "copy-branch") {
        if (!threadBranch) return;
        copyBranchNameToClipboard(threadBranch);
        return;
      }
      if (clicked === "continue-as-group") {
        await continueThreadAsGroup(thread);
        return;
      }
      if (typeof clicked === "string" && clicked.startsWith("move-to-group:")) {
        const targetProjectId = clicked.slice("move-to-group:".length);
        const target = eligibleGroups.find((project) => project.id === targetProjectId);
        if (target) {
          await moveThreadToGroup(thread, target.id);
        }
        return;
      }
      if (clicked === "fork:local" || clicked === "fork:worktree") {
        await forkThread(thread, clicked === "fork:worktree" ? "worktree" : "local");
        return;
      }
      if (clicked === "archive") {
        await confirmAndArchiveThread(threadId);
        return;
      }
      if (clicked !== "delete") return;
      await confirmAndDeleteThread(threadId);
    },
    [
      appSettings,
      canSnoozeThread,
      confirmAndArchiveThread,
      confirmAndDeleteThread,
      coordinatorThreadIds,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      copyBranchNameToClipboard,
      clearThreadNotification,
      continueHandoffInThread,
      continueThreadAsGroup,
      forkThread,
      groupProjectIdSet,
      handoffThread,
      membersLoaded,
      moveThreadToGroup,
      neolixWorkspacesByDirectory,
      handleMarkThreadUnread,
      handleMarkThreadRead,
      navigate,
      openRenameThreadDialog,
      pinnedThreadIdSet,
      projectCwdById,
      projects,
      providerStatuses,
      queryClient,
      resolveThreadStatusForSidebar,
      resolveThreadWorkspaceRecord,
      sidebarThreadSummaryById,
      setThreadSnoozedUntil,
      snoozeThread,
      summariesByProjectId,
      summaryFor,
      toggleThreadPinned,
      t,
      setSnoozeDialogThreadId,
      setArchiveWorkspaceTarget,
      setWorkspaceRenameTarget,
    ],
  );
  // The open-thread tabs open this same menu for their thread, with their close rows added.
  useEffect(() => registerThreadContextMenu(handleThreadContextMenu), [handleThreadContextMenu]);
  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const ids = [...selectedThreadIds];
      if (ids.length === 0) return;
      const count = ids.length;

      const clicked = await api.contextMenu.show(
        [
          {
            id: "mark-unread",
            label: t("workspace:markUnread2", { value0: count }),
            icon: THREAD_CONTEXT_MENU_ICONS.markUnread,
          },
          {
            id: "archive",
            label: t("workspace:archive", { value0: count }),
            icon: THREAD_CONTEXT_MENU_ICONS.archive,
          },
          {
            id: "delete",
            label: t("workspace:delete", { value0: count }),
            icon: THREAD_CONTEXT_MENU_ICONS.delete,
            destructive: true,
          },
        ],
        position,
      );

      if (clicked === "mark-unread") {
        for (const id of ids) {
          handleMarkThreadUnread(id);
        }
        clearSelection();
        return;
      }

      if (clicked === "archive") {
        // Subagent threads follow their parent's archive cascade. Archiving one
        // directly would strand it, and archiving it after its parent in this
        // loop would fail the not-archived invariant.
        const archiveIds = ids.filter(
          (id) => (getThreadFromState(useStore.getState(), id)?.parentThreadId ?? null) === null,
        );
        if (archiveIds.length === 0) {
          removeFromSelection(ids);
          return;
        }
        if (appSettings.confirmThreadArchive) {
          const confirmed = await api.dialogs.confirm(
            [
              t("workspace:archiveThreadsCount", {
                count: archiveIds.length,
              }),
              t("workspace:confirmation_bulkArchiveDescription"),
            ].join("\n"),
            { confirmLabel: t("common:confirm_archive") },
          );
          if (!confirmed) return;
        }

        const excludedThreadIds = new Set<ThreadId>(ids);
        for (const id of archiveIds) {
          await archiveThread(id, { excludedThreadIds });
        }
        removeFromSelection(ids);
        return;
      }

      if (clicked !== "delete") return;

      if (appSettings.confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            t("workspace:deleteThreadsCount", {
              count,
            }),
            t("workspace:thisPermanentlyClearsConversationHistoryForTheseThreads"),
          ].join("\n"),
          { confirmLabel: t("common:delete"), destructive: true },
        );
        if (!confirmed) return;
      }

      const deletedIds = new Set<ThreadId>(ids);
      const successfullyDeletedIds: ThreadId[] = [];
      const runDeletes = async (): Promise<void> => {
        for (const id of ids) {
          await deleteThread(id, { deletedThreadIds: deletedIds, reconcileDeletedThread: false });
          successfullyDeletedIds.push(id);
        }
      };
      await runDeletes().finally(() => {
        if (successfullyDeletedIds.length > 0) {
          void reconcileDeletedThreadsFromClient({
            threadIds: successfullyDeletedIds,
            removeDeletedThreadFromClientState:
              useStore.getState().removeDeletedThreadFromClientState,
          });
        }
      });
      removeFromSelection(ids);
    },
    [
      appSettings.confirmThreadArchive,
      appSettings.confirmThreadDelete,
      archiveThread,
      clearSelection,
      deleteThread,
      handleMarkThreadUnread,
      removeFromSelection,
      selectedThreadIds,
      t,
    ],
  );

  const rememberLastThreadRouteNow = useCallback(
    (nextLastThreadRoute: LastThreadRoute) => {
      setLastThreadRoute(nextLastThreadRoute);
      persistSidebarUiState({
        chatSectionExpanded,
        chatThreadListExtraPages,
        projectThreadListExtraPagesByCwd: Object.fromEntries(threadListExtraPagesByProjectCwd),
        dismissedThreadStatusKeyByThreadId,
        lastThreadRoute: nextLastThreadRoute,
        activityViewEnabled,
        activityScope,
        activityGroupMode,
      });
    },
    [
      activityScope,
      activityGroupMode,
      activityViewEnabled,
      chatSectionExpanded,
      chatThreadListExtraPages,
      dismissedThreadStatusKeyByThreadId,
      threadListExtraPagesByProjectCwd,
    ],
  );
  const { activateThreadFromSidebarIntent } = useThreadActivationController({
    activeSplitView,
    clearSelection,
    navigate,
    openChatThreadPage,
    openSidechatDock: ({ sourceThreadId, sidechatThreadId }) =>
      openRightDockPane(sourceThreadId, {
        kind: "sidechat",
        threadId: sidechatThreadId,
      }),
    openTerminalThreadPage,
    prewarmThreadDetailForIntent,
    rememberLastThreadRouteNow,
    routeSplitViewId: routeSearch.splitViewId,
    routeThreadId,
    selectedThreadCount: selectedThreadIds.size,
    setOptimisticActiveThreadId,
    setSelectionAnchor,
    setSplitFocusedPane,
    sidebarThreadSummaryById,
    splitViewsById,
    terminalStateByThreadId,
  });
  // Capture at activation, after selection modifiers and before the route changes layout.
  const activateThreadRow = useCallback(
    (threadId: ThreadId, row: HTMLElement) => {
      if (suppressThreadClickAfterDragRef.current) return;
      const viewport = row.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
      pendingThreadRowAnchorRef.current =
        viewport && threadId !== routeThreadId
          ? {
              threadId,
              row,
              viewport,
              top: row.getBoundingClientRect().top,
              scrollTop: viewport.scrollTop,
            }
          : null;
      activateThreadFromSidebarIntent(threadId);
    },
    [activateThreadFromSidebarIntent, routeThreadId],
  );
  // PR chip on a thread row behaves like a link: a plain click opens the PR in the thread's
  // right dock, while cmd/ctrl/middle-click (or a non-GitHub URL) opens it on GitHub.
  const openThreadPullRequest = useCallback(
    (
      event: MouseEvent<HTMLElement>,
      thread: SidebarThreadSummary,
      pr: OrchestrationThreadPullRequest,
    ) => {
      const repository = parseGitHubRepositoryNameWithOwnerFromPullRequestUrl(pr.url);
      if (event.metaKey || event.ctrlKey || event.button === 1 || !repository) {
        openPrLink(event, pr.url);
        return;
      }
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      activateThreadFromSidebarIntent(thread.id);
      openRightDockPane(thread.id, {
        kind: "pullRequest",
        pullRequestProjectId: thread.projectId,
        pullRequestRepository: repository,
        pullRequestNumber: pr.number,
        pullRequestInitialTab: "summary",
      });
    },
    [activateThreadFromSidebarIntent, openPrLink, openRightDockPane],
  );

  const handleCloseProjectContextMenu = useCallback(() => setProjectContextMenuState(null), []);
  const {
    activeSpace,
    voidSpace,
    spaceEditorOpen,
    spaceEditorMode,
    spaceEditorInitialValue,
    spaceEditorExistingNames,
    spaceProjectPickerTarget,
    openSpaceCreator,
    openSpaceEditor,
    openVoidEditor,
    closeSpaceEditor,
    openSpaceProjectPicker,
    closeSpaceProjectPicker,
    handleSelectSpace,
    handleSelectSpaceForIncomingProject,
    handleReorderSpaces,
    handleRenameSpace,
    handleRenameVoid,
    resetVoidSpace,
    handleDeleteSpace,
    handleMoveProjectToSpace,
    handleSpaceEditorSubmit,
    handleBulkMoveProjects,
  } = useSpacesController({
    ordinarySpaceProjects,
    projectById,
    sidebarThreads: displaySidebarThreads,
    sidebarThreadSortOrder: appSettings.sidebarThreadSortOrder,
    sidebarThreadAttentionFirst: appSettings.sidebarThreadAttentionFirst,
    routeThreadId,
    routeProjectId,
    isOnKanban: pathname.startsWith("/kanban"),
    activeRouteProject,
    activeRouteProjectId,
    activateThreadFromSidebarIntent,
    onCloseProjectContextMenu: handleCloseProjectContextMenu,
  });
  const handleCreateProjectSubmit = useCallback(
    async (value: CreateProjectSubmitValue, options: CreateProjectSubmitOptions) => {
      const previousSpaceId = activeSpaceId;
      const existingProject =
        value.source === "local"
          ? findWorkspaceRootMatch(projects, value.workspaceRoot, (project) => project.cwd)
          : null;
      // Reopening an existing project must follow the Space where that project
      // actually lives. New projects use the destination selected in the dialog.
      const destinationSpaceId = existingProject
        ? (existingProject.spaceId ?? null)
        : value.spaceId;
      const runCreateProject = async () => {
        if (value.source === "github") {
          const api = readNativeApi();
          if (!api) throw new Error("The app server is unavailable.");
          await runExclusiveProjectAddition(projectAdditionLockRef, async () => {
            const openProvisionedProject = async (
              projectId: ProjectId,
              workspaceRoot: string | undefined,
              waitForProject: typeof waitForProjectInSnapshot,
            ) => {
              const { project, snapshot } = await waitForProject(api, projectId, workspaceRoot);
              if (snapshot) {
                syncServerShellSnapshot(snapshot);
              }
              if (!project || !snapshot) return false;

              handleSelectSpaceForIncomingProject(project.spaceId ?? null);
              return openExistingProjectFromSnapshot(project.id, snapshot);
            };
            const requestedProjectId = newProjectId();
            const requestedWorkspaceRoot = joinProjectPath(
              expandProjectHomePath(value.destinationParent, homeDir),
              value.directoryName,
            );
            const provision = await runProjectProvisionWithCancellationRecovery({
              signal: options.signal,
              provision: () =>
                api.projects.provisionFromGitHub(
                  {
                    operationId: value.operationId,
                    repository: value.repository,
                    destinationParent: value.destinationParent,
                    directoryName: value.directoryName,
                    commandId: newCommandId(),
                    projectId: requestedProjectId,
                    newProjectSpaceId: value.spaceId,
                    defaultModelSelection: {
                      provider: "codex",
                      model: getDefaultModel("codex"),
                    },
                    createdAt: new Date().toISOString(),
                  },
                  { signal: options.signal },
                ),
              // Cancellation can race the server's project.create commit. If that
              // commit won, recover the durable project and report success instead
              // of telling the user a registered project was cancelled.
              recoverCommittedProject: () =>
                openProvisionedProject(
                  requestedProjectId,
                  requestedWorkspaceRoot,
                  waitForCancelledGitHubProjectInSnapshot,
                ),
            });
            if (provision.status === "recovered") return;
            if (
              !(await openProvisionedProject(
                provision.result.projectId,
                undefined,
                waitForProjectInSnapshot,
              ))
            ) {
              throw new Error(
                "The GitHub project was added, but it has not synced into the sidebar yet. Try again in a moment.",
              );
            }
          });
        } else {
          handleSelectSpaceForIncomingProject(destinationSpaceId);
          await addProjectFromPath(value.workspaceRoot, {
            name: value.name,
            createIfMissing: value.createIfMissing,
            spaceId: value.spaceId,
            additionalFolders: value.additionalFolders,
          });
        }
      };

      // Keep the compiler-sensitive try block free of value/throw statements.
      // Land on the destination space before creating so the sidebar follows the
      // new project's thread instead of bouncing back to the previous space.
      try {
        await runCreateProject();
      } catch (error) {
        // Project creation is one UI transaction: a failed command must not
        // strand the sidebar in a Space unrelated to the current route.
        handleSelectSpaceForIncomingProject(previousSpaceId);
        throw error;
      }
    },
    [
      activeSpaceId,
      addProjectFromPath,
      handleSelectSpaceForIncomingProject,
      homeDir,
      openExistingProjectFromSnapshot,
      projects,
      syncServerShellSnapshot,
      waitForCancelledGitHubProjectInSnapshot,
      waitForProjectInSnapshot,
    ],
  );

  // Tab index 0 is Void, then spaces in strip order — the same mapping the
  // space.jump.N dispatch below uses, surfaced in each tab's tooltip.
  const jumpShortcutLabelForSpaceTab = useCallback(
    (tabIndex: number) => {
      const command = spaceJumpCommandForIndex(tabIndex);
      if (!command) return null;
      return shortcutLabelForCommand(keybindings, command, { platform: navigator.platform });
    },
    [keybindings],
  );
  // Opens the daemon terminal behind a running dev server in the right dock. The bridge
  // attaches to the existing PTY instead of creating a shell, so closing the pane leaves the
  // dev server running.
  const openDevServerTerminal = useCallback(
    async (projectId: ProjectId, terminalId: string, cwd: string) => {
      const api = readNativeApi();
      if (!api) return;
      const thread = Object.values(sidebarThreadSummaryById)
        .filter((candidate) => candidate.projectId === projectId && candidate.archivedAt == null)
        .toSorted((left, right) =>
          (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt),
        )[0];
      if (!thread) {
        toastManager.add({
          type: "error",
          title: t("workspace:unableToViewTheDevServerTerminal"),
          description: t("workspace:openAConversationInThisProjectFirst"),
        });
        return;
      }
      await navigate({ to: "/$threadId", params: { threadId: thread.id } });
      const dockThreadId = dockTerminalThreadId(thread.id);
      const clientTerminalId = randomTerminalId();
      const paneId = randomUUID();
      try {
        await api.terminal.open({
          threadId: dockThreadId,
          terminalId: clientTerminalId,
          cwd,
          cols: 120,
          rows: 30,
          attachToDaemonTerminalId: terminalId,
        });
        useTerminalStateStore.getState().ensureDockTerminal(dockThreadId, paneId, clientTerminalId);
        const dock = useRightDockStore.getState();
        dock.openPane(thread.id, { kind: "terminal", paneId });
        dock.setActivePane(thread.id, paneId);
        dock.setDockOpen(thread.id, true);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("workspace:unableToViewTheDevServerTerminal"),
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [navigate, sidebarThreadSummaryById, t],
  );

  const handleProjectContextMenuAction = useCallback(
    async (projectId: ProjectId, clicked: ProjectContextMenuId) => {
      setProjectContextMenuState(null);
      const api = readNativeApi();
      if (!api) return;
      const project = projectById.get(projectId);
      if (!project) return;

      if (clicked === "open-in-finder") {
        try {
          await api.shell.showInFolder(project.cwd);
        } catch (error) {
          toastManager.add({
            type: "error",
            title: t("workspace:toast_unableToOpenInFinder"),
            description:
              error instanceof Error
                ? error.message
                : t("workspace:anUnknownErrorOccurredOpeningTheFolder"),
          });
        }
        return;
      }
      if (clicked === "open-in-new-window") {
        const openNewWindow = window.neolixDesktop?.window?.openNew;
        try {
          if (openNewWindow) {
            await openNewWindow({ pendingOpenProjectPath: project.cwd });
          }
        } catch (error) {
          toastManager.add({
            type: "error",
            title: t("settings:desktop_couldNotOpenProject"),
            description: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      if (clicked === "open-in-kanban") {
        void navigate({ to: "/kanban/$projectId", params: { projectId } });
        return;
      }
      if (clicked === "copy-path") {
        copyPathToClipboard(project.cwd);
        return;
      }
      if (clicked === "start-dev") {
        openProjectRunDialog(projectId);
        return;
      }
      if (clicked === "stop-dev") {
        await handleStopProjectRun(projectId);
        return;
      }
      if (clicked === "restart-dev") {
        await handleRestartProjectRun(projectId);
        return;
      }
      if (clicked === "open-dev-server") {
        await handleOpenProjectRunServer(projectId);
        return;
      }
      if (clicked === "copy-dev-url") {
        await handleCopyProjectRunUrl(projectId);
        return;
      }
      if (clicked === "view-dev-terminal") {
        const run = projectRunsByProjectId[projectId];
        if (run?.terminalId) {
          await openDevServerTerminal(projectId, run.terminalId, run.cwd);
        }
        return;
      }
      if (clicked === "relocate") {
        setRelocateProjectDialogId(projectId);
        return;
      }
      if (clicked === "rename") {
        setEditProjectDialog({ projectId, open: true });
        return;
      }
      if (clicked === "edit-project-agent") {
        setProjectAgentDialogState({
          projectId,
          mode: summaryFor(projectId)?.configured ? "edit" : "onboarding",
        });
        return;
      }
      if (clicked === "toggle-pin") {
        toggleProjectPinned(projectId);
        return;
      }
      if (clicked === "toggle-pin-project-agent") {
        toggleProjectAgentPinned(projectId);
        return;
      }
      if (clicked === "archive-threads") {
        await archiveAllThreadsInProject(projectId);
        return;
      }
      if (clicked === "delete-threads") {
        await deleteProjectThreads(projectId);
        return;
      }
      if (clicked !== "delete") return;

      const projectThreads = excludeHiddenProjectAgentCoordinatorThreads(
        sidebarThreads.filter((thread) => thread.projectId === projectId),
        coordinatorThreadIds,
      );
      const confirmed = await api.dialogs.confirm(
        projectThreads.length > 0
          ? [
              t("workspace:removeProject", { value0: project.name }),
              t("workspace:removeProjectKeepsChats"),
            ].join("\n")
          : t("workspace:removeProject", { value0: project.name }),
        { confirmLabel: t("common:confirm_remove") },
      );
      if (!confirmed) return;

      // Nested function so the `try` body stays free of value blocks — see the comment on
      // `runAddProject` above for why React Compiler requires this shape.
      const runRemoveProject = async () => {
        // Removing a project only unlinks it, exactly like the old app: the daemon archives
        // its workspaces, while threads and files stay where they are.
        await deleteProjectFromClient({
          api: api.orchestration,
          projectId,
          removeDeletedProjectFromClientState,
        });
        clearProjectDraftThreads(projectId);
        toastManager.add({
          type: "success",
          title: t("workspace:removed", { value0: project.name }),
          description: t("workspace:projectRemoved"),
        });
      };

      try {
        await runRemoveProject();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : t("workspace:unknownErrorRemovingProject");
        console.error("Failed to remove project", { projectId, error });
        toastManager.add({
          type: "error",
          title: t("workspace:failedToRemove", { value0: project.name }),
          description: message,
        });
      }
    },
    [
      archiveAllThreadsInProject,
      clearProjectDraftThreads,
      coordinatorThreadIds,
      copyPathToClipboard,
      deleteProjectThreads,
      handleCopyProjectRunUrl,
      handleOpenProjectRunServer,
      handleRestartProjectRun,
      handleStopProjectRun,
      navigate,
      openDevServerTerminal,
      openProjectRunDialog,
      projectById,
      projectRunsByProjectId,
      removeDeletedProjectFromClientState,
      sidebarThreads,
      summaryFor,
      toggleProjectAgentPinned,
      toggleProjectPinned,
      t,
      setRelocateProjectDialogId,
      setEditProjectDialog,
      setProjectAgentDialogState,
    ],
  );

  const handleProjectContextMenu = useCallback(
    (projectId: ProjectId, position: { x: number; y: number }) => {
      if (!readNativeApi()) return;
      if (!projectById.has(projectId)) return;
      setProjectContextMenuState({ projectId, position });
    },
    [projectById],
  );

  const projectDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const projectCollisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }

    return closestCorners(args);
  }, []);

  const handleProjectDragStart = useCallback(
    (_event: DragStartEvent) => {
      if (appSettings.sidebarProjectSortOrder !== "manual") {
        return;
      }
      dragInProgressRef.current = true;
      suppressProjectClickAfterDragRef.current = true;
    },
    [appSettings.sidebarProjectSortOrder],
  );

  const handleProjectDragCancel = useCallback((_event: DragCancelEvent) => {
    dragInProgressRef.current = false;
  }, []);

  const animatedProjectListsRef = useRef(new WeakSet<HTMLElement>());
  const attachProjectListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedProjectListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedProjectListsRef.current.add(node);
  }, []);

  // The thread panel keeps a single primary action: New thread. Destinations that used to
  // live in the icon rail now live in Settings or nowhere.
  const newThreadNavDescriptor = useMemo<SidebarNavItemDescriptor>(
    () => ({
      icon: NewThreadIcon,
      iconClassName: "size-3.5",
      label: t("chat:sections_newThread"),
      active: false,
      badge: null,
      onClick: handlePrimaryNewThread,
      onMouseEnter: prefetchModelsForPrimaryNewThread,
      onFocus: prefetchModelsForPrimaryNewThread,
    }),
    [handlePrimaryNewThread, prefetchModelsForPrimaryNewThread, t],
  );

  // Rows hold still while the pointer is over the list, so opening an unread
  // chat or a chat starting work never moves the row the user is about to click.
  const [sidebarContentElement, setSidebarContentElement] = useState<HTMLDivElement | null>(null);
  const isPointerOverSidebarContent = useIsPointerWithin(sidebarContentElement);
  const sidebarThreadAttentionFirst = appSettings.sidebarThreadAttentionFirst;
  const heldSidebarThreadSortKeys = useHeldSidebarThreadSortKeys({
    threads: displaySidebarTreeThreads,
    sortOrder: appSettings.sidebarThreadSortOrder,
    attentionFirst: sidebarThreadAttentionFirst,
    hold: isPointerOverSidebarContent,
  });
  const threadSortMenuProps = useMemo<ThreadSortMenuProps>(
    () => ({
      threadSortOrder: appSettings.sidebarThreadSortOrder,
      onThreadSortOrderChange: (sortOrder) => {
        updateSettings({ sidebarThreadSortOrder: sortOrder });
      },
      threadAttentionFirst: sidebarThreadAttentionFirst,
      onThreadAttentionFirstChange: (attentionFirst) => {
        updateSettings({ sidebarThreadAttentionFirst: attentionFirst });
      },
    }),
    [appSettings.sidebarThreadSortOrder, sidebarThreadAttentionFirst, updateSettings],
  );
  const sortedSidebarThreadsByProjectId = useMemo(() => {
    const byProjectId = new Map<ProjectId, SidebarThreadSummary[]>();
    for (const [projectId, projectThreads] of sidebarThreadsByProjectId) {
      byProjectId.set(
        projectId,
        sortThreadsForSidebar(projectThreads, appSettings.sidebarThreadSortOrder, {
          attentionFirst: sidebarThreadAttentionFirst,
          heldKeys: heldSidebarThreadSortKeys,
          manualOrderRanks: manualThreadOrderRanks,
        }),
      );
    }
    return byProjectId;
  }, [
    appSettings.sidebarThreadSortOrder,
    heldSidebarThreadSortKeys,
    manualThreadOrderRanks,
    sidebarThreadAttentionFirst,
    sidebarThreadsByProjectId,
  ]);
  const handleProjectTitlePointerDownCapture = useCallback(() => {
    suppressProjectClickAfterDragRef.current = false;
  }, []);

  const handleEditProjectSave = useCallback(
    (projectId: ProjectId, next: EditProjectValue, previousLocalName: string | null) => {
      setProjectAppearanceLocally(projectId, next.appearance);
      const trimmed = next.name.trim();
      const normalizedPrevious = previousLocalName?.trim() ?? "";
      if (trimmed === normalizedPrevious) {
        return;
      }
      renameProjectLocally(projectId, trimmed.length > 0 ? trimmed : null);
    },
    [renameProjectLocally, setProjectAppearanceLocally],
  );

  const remotePinnedThreads = useMemo<WorkspaceThreadEntry[]>(() => {
    if (!isOnGroups && activeSpaceId !== null) return [];
    return visibleWorkspaceSessions.flatMap((session) => {
      const sectionByProjectId = new Map(
        session.summary?.projects.map((project) => [project.id, project.section] as const),
      );
      return (session.summary?.threads ?? []).flatMap((thread) => {
        const environmentId = session.host.executionScope.environmentId;
        const section = sectionByProjectId.get(thread.projectId);
        if (
          thread.archivedAt ||
          thread.parentThreadId ||
          !thread.isPinned ||
          !threadMatchesSidebarProjectFilter(thread, environmentId) ||
          (isOnGroups ? section !== "studio" : section === undefined || section === "studio")
        )
          return [];
        return [
          {
            key: workspaceThreadKey(environmentId, thread.id),
            thread,
            session,
          },
        ];
      });
    });
  }, [activeSpaceId, isOnGroups, threadMatchesSidebarProjectFilter, visibleWorkspaceSessions]);
  const [workspaceProjectOrder, setWorkspaceProjectOrder] = useLocalStorage(
    executionKey("sidebar-project-order:v1"),
    [] as readonly string[],
    Schema.Array(Schema.String),
  );
  const [collapsedWorkspaceProjects, setCollapsedWorkspaceProjects] = useLocalStorage(
    executionKey("sidebar-collapsed-projects:v1"),
    [] as readonly string[],
    Schema.Array(Schema.String),
  );
  const [workspaceProjectExtraPages, setWorkspaceProjectExtraPages] = useState<
    ReadonlyMap<string, number>
  >(() => new Map());
  const remoteProjects = useMemo(() => {
    const entries = remoteSidebarProjects(visibleWorkspaceSessions);
    if (sidebarProjectFilters.length === 0) return entries;
    return entries.filter((entry) => sidebarProjectFilters.includes(entry.key));
  }, [sidebarProjectFilters, visibleWorkspaceSessions]);
  const remoteGroupProjects = useMemo(() => {
    const entries = remoteSidebarProjects(visibleWorkspaceSessions, "studio");
    if (sidebarProjectFilters.length === 0) return entries;
    return entries.filter((entry) => sidebarProjectFilters.includes(entry.key));
  }, [sidebarProjectFilters, visibleWorkspaceSessions]);
  // Host and project filters narrow the tree; they never affect a route the user is on,
  // only which rows the sidebar offers.
  const visibleLocalProjects = useMemo(() => {
    if (!localHostVisible) return [];
    if (sidebarProjectFilters.length === 0) return projects;
    return projects.filter((project) =>
      sidebarProjectFilters.includes(
        checkoutKey({ environmentId: localEnvironmentId, projectId: project.id }),
      ),
    );
  }, [localEnvironmentId, localHostVisible, projects, sidebarProjectFilters]);
  const sortedProjects = useMemo(
    () =>
      sortProjectsForSidebar(
        visibleLocalProjects,
        displaySidebarThreads,
        appSettings.sidebarProjectSortOrder,
      ),
    [appSettings.sidebarProjectSortOrder, displaySidebarThreads, visibleLocalProjects],
  );
  const chatProjects = useMemo(
    () =>
      sortedProjects.filter((project) =>
        isHomeChatContainerProject(project, { homeDir, chatWorkspaceRoot }),
      ),
    [chatWorkspaceRoot, homeDir, sortedProjects],
  );
  const groupProjects = useMemo(
    () =>
      sortedProjects.filter((project) =>
        isGroupContainerProject(project, {
          homeDir,
          chatWorkspaceRoot,
          studioWorkspaceRoot,
          groupsWorkspaceRoot,
        }),
      ),
    [chatWorkspaceRoot, groupsWorkspaceRoot, homeDir, sortedProjects, studioWorkspaceRoot],
  );
  const visibleChatThreads = useMemo(() => {
    if (!chatSectionExpanded) {
      return [];
    }
    return sortThreadsForSidebar(
      chatProjects.flatMap((project) => sortedSidebarThreadsByProjectId.get(project.id) ?? []),
      appSettings.sidebarThreadSortOrder,
      {
        attentionFirst: sidebarThreadAttentionFirst,
        heldKeys: heldSidebarThreadSortKeys,
        manualOrderRanks: manualThreadOrderRanks,
      },
    );
  }, [
    appSettings.sidebarThreadSortOrder,
    chatSectionExpanded,
    chatProjects,
    heldSidebarThreadSortKeys,
    manualThreadOrderRanks,
    sidebarThreadAttentionFirst,
    sortedSidebarThreadsByProjectId,
  ]);
  const visibleChatThreadIds = useMemo(
    () => visibleChatThreads.map((thread) => thread.id),
    [visibleChatThreads],
  );
  const activeWorkspaceParams = new URLSearchParams(activeWorkspaceSearch);
  const selectedByEnvironment = useMemo(() => {
    const selected = new Map<string, ThreadId>();
    const params = new URLSearchParams(activeWorkspaceSearch);
    const environmentId = params.get("environment");
    const remotePath = params.get("path")?.split("?")[0];
    if (
      pathname === "/remote" &&
      environmentId &&
      remotePath?.startsWith("/") &&
      remotePath.length > 1
    ) {
      const hostThreads =
        workspaceSessions.find(
          (session) => session.host.executionScope.environmentId === environmentId,
        )?.summary?.threads ?? [];
      const rootId = resolveSidebarRootThreadId(
        ThreadId.makeUnsafe(remotePath.slice(1)),
        Object.fromEntries(hostThreads.map((thread) => [thread.id, thread])),
      );
      if (rootId) selected.set(environmentId, rootId);
    } else if (routeActiveSidebarThreadId) {
      // Row layout follows the route, not the pointer-down optimistic id (see above).
      selected.set(localEnvironmentId, routeActiveSidebarThreadId);
    }
    return selected;
  }, [
    activeWorkspaceSearch,
    pathname,
    routeActiveSidebarThreadId,
    localEnvironmentId,
    workspaceSessions,
  ]);
  const mergedChatRows = useMemo(
    () =>
      mergeSidebarChats({
        localEnvironmentId,
        threads: visibleChatThreads,
        sessions: visibleWorkspaceSessions,
        section: "chats",
        sortOrder: appSettings.sidebarThreadSortOrder,
        sortOptions: {
          attentionFirst: sidebarThreadAttentionFirst,
          heldKeys: heldSidebarThreadSortKeys,
          manualOrderRanks: manualThreadOrderRanks,
        },
      }).filter((entry) =>
        threadMatchesSidebarProjectFilter(
          entry.thread,
          entry.session?.host.executionScope.environmentId ?? localEnvironmentId,
        ),
      ),
    [
      localEnvironmentId,
      manualThreadOrderRanks,
      threadMatchesSidebarProjectFilter,
      visibleChatThreads,
      visibleWorkspaceSessions,
      appSettings.sidebarThreadSortOrder,
      sidebarThreadAttentionFirst,
      heldSidebarThreadSortKeys,
    ],
  );
  const visibleChatPreviewEntries = useMemo(
    () =>
      mergedChatRows.map((entry) => ({
        rowId: entry.key,
        row: {
          thread: entry.thread,
          workspaceEntry: entry,
        },
      })),
    [mergedChatRows],
  );
  const activeChatPreviewEntryIndex = visibleChatPreviewEntries.findIndex(({ row }) =>
    row.workspaceEntry.session
      ? pathname === "/remote" &&
        activeWorkspaceParams.get("environment") ===
          row.workspaceEntry.session.host.executionScope.environmentId &&
        selectedByEnvironment.get(row.workspaceEntry.session.host.executionScope.environmentId) ===
          row.thread.id
      : pathname !== "/remote" && row.thread.id === routeActiveSidebarThreadId,
  );
  const activeChatPreviewEntryId =
    activeChatPreviewEntryIndex < 0
      ? undefined
      : visibleChatPreviewEntries[activeChatPreviewEntryIndex]!.rowId;
  const chatPaging = resolveSidebarThreadListPaging({
    totalCount: visibleChatPreviewEntries.length,
    baseLimit: THREAD_PREVIEW_LIMIT,
    pageSize: THREAD_PREVIEW_PAGE_SIZE,
    requestedExtraPages: chatThreadListExtraPages,
  });
  const { visibleEntries: renderedChatEntries } = useMemo(
    () =>
      getVisibleSidebarEntriesForPreview({
        entries: visibleChatPreviewEntries,
        activeEntryId: activeChatPreviewEntryId,
        previewLimit: chatPaging.previewLimit,
      }),
    [visibleChatPreviewEntries, activeChatPreviewEntryId, chatPaging.previewLimit],
  );
  // Active-family reveal can exceed the page cap; only offer more for genuinely hidden rows.
  const canShowMoreChatThreads =
    chatPaging.canShowMore && renderedChatEntries.length < visibleChatPreviewEntries.length;
  const canShowLessChatThreads = chatPaging.canShowLess;
  const chatThreadListEffectiveExtraPages = chatPaging.effectiveExtraPages;
  const workspaceActivity = useMemo(
    () => workspaceActivityRows(visibleWorkspaceSessions),
    [visibleWorkspaceSessions],
  );
  const activitySettledOverrideByThreadId = useMemo(
    () =>
      workspaceActivity.settledOverrideByThreadId.size === 0
        ? settledOverrideByThreadId
        : new Map([...settledOverrideByThreadId, ...workspaceActivity.settledOverrideByThreadId]),
    [settledOverrideByThreadId, workspaceActivity],
  );
  const activityPinnedThreadIdSet = useMemo(
    () =>
      new Set([
        ...pinnedThreadIdSet,
        ...[...workspaceActivity.remoteById]
          .filter(([, entry]) => entry.thread.isPinned)
          .map(([id]) => id),
      ]),
    [pinnedThreadIdSet, workspaceActivity],
  );
  const activityThreads = useMemo(
    () => [
      ...activityNonGroupSidebarThreads,
      ...workspaceActivity.threads.filter((thread) =>
        isSidebarThreadVisible(thread, { hideAutomationRunThreads, includeSnoozed: true }),
      ),
    ],
    [activityNonGroupSidebarThreads, workspaceActivity, hideAutomationRunThreads],
  );
  const activityProjectById = useMemo(
    () => new Map([...projectById, ...workspaceActivity.projectById]),
    [projectById, workspaceActivity],
  );
  const workspaceActivityThreadById = useMemo(
    () => new Map(workspaceActivity.threads.map((thread) => [thread.id, thread])),
    [workspaceActivity],
  );
  // Remote tree rows share the Activity summary of the same chat for their hover card.
  const renderRemoteThreadHoverCard = (entry: WorkspaceThreadEntry) => {
    if (!entry.session) return undefined;
    const summary = workspaceActivityThreadById.get(
      ThreadId.makeUnsafe(
        `workspace:${workspaceThreadKey(entry.session.host.executionScope.environmentId, entry.thread.id)}`,
      ),
    );
    return summary
      ? (anchorId: string) => renderThreadHoverCardPopup(summary, anchorId, false)
      : undefined;
  };
  const externalActivityRows = useMemo(
    () =>
      new Map(
        [...workspaceActivity.remoteById].map(([id, entry]) => [
          id,
          {
            entry,
            hostName: entry.session!.host.hostName,
            status: entry.thread.status,
            onOpen: () => openWorkspacePath(entry.session!, `/${entry.thread.id}`),
          },
        ]),
      ),
    [workspaceActivity],
  );
  const handleWorkspaceActivityVisibleThreadIdsChange = useCallback(
    (ids: readonly ThreadId[]) => handleActivityVisibleThreadIdsChange(ids),
    [handleActivityVisibleThreadIdsChange],
  );
  const activityActiveThreadId =
    pathname === "/remote"
      ? ([...workspaceActivity.remoteById].find(
          ([, entry]) =>
            entry.session!.host.executionScope.environmentId ===
              activeWorkspaceParams.get("environment") &&
            `/${entry.thread.id}` === activeWorkspaceParams.get("path")?.split("?")[0],
        )?.[0] ?? null)
      : activeSidebarThreadId;
  const activityVisualActiveThreadId = useMemo(
    () =>
      resolveSidebarRootThreadId(activityActiveThreadId, {
        ...sidebarThreadSummaryById,
        ...Object.fromEntries(workspaceActivity.threads.map((thread) => [thread.id, thread])),
      }),
    [activityActiveThreadId, sidebarThreadSummaryById, workspaceActivity],
  );
  const allStandardProjectsBase = useMemo(
    () =>
      sortedProjects.filter((project) =>
        isOrdinarySpaceProject(project, {
          homeDir,
          chatWorkspaceRoot,
          studioWorkspaceRoot,
          groupsWorkspaceRoot,
        }),
      ),
    [chatWorkspaceRoot, groupsWorkspaceRoot, homeDir, sortedProjects, studioWorkspaceRoot],
  );
  // Hidden subagents still contribute approval/running status to their project and Space.
  const statusThreadsByProjectId = useMemo(() => {
    const snoozedIds = collectSnoozedThreadIds(displaySidebarThreads);
    return groupSidebarThreadsByProjectId(
      displaySidebarThreads.filter(
        (thread) =>
          thread.archivedAt == null &&
          !snoozedIds.has(thread.id) &&
          isSidebarThreadVisible(thread, { hideAutomationRunThreads, includeSubagents: true }),
      ),
    );
  }, [displaySidebarThreads, hideAutomationRunThreads]);
  const spaceActivityById = useMemo(() => {
    const priority: Record<SpaceActivityTone, number> = {
      attention: 3,
      running: 2,
      completed: 1,
    };
    const activity = new Map<SpaceId | null, SpaceActivityTone>();
    for (const project of allStandardProjectsBase) {
      const status = resolveProjectStatusIndicator(
        (statusThreadsByProjectId.get(project.id) ?? []).map(resolveThreadStatusForSidebar),
      );
      if (!status) continue;
      const tone: SpaceActivityTone =
        status.label === "Working" ||
        status.label === "Connecting" ||
        status.label === "In Background" ||
        status.label === "Preparing worktree"
          ? "running"
          : status.label === "Completed"
            ? "completed"
            : "attention";
      const projectSpaceId = project.spaceId ?? null;
      const current = activity.get(projectSpaceId);
      if (!current || priority[tone] > priority[current]) {
        activity.set(projectSpaceId, tone);
      }
    }
    return activity;
  }, [allStandardProjectsBase, resolveThreadStatusForSidebar, statusThreadsByProjectId]);
  const standardProjectsBase = useMemo(
    () => allStandardProjectsBase.filter((project) => (project.spaceId ?? null) === activeSpaceId),
    [activeSpaceId, allStandardProjectsBase],
  );
  const pinnedProjectIds = useMemo(
    () =>
      derivePinnedProjectIdsForSidebar({
        projects: standardProjectsBase,
        persistedPinnedProjectIds,
        optimisticPinnedStateByProjectId,
      }),
    [optimisticPinnedStateByProjectId, persistedPinnedProjectIds, standardProjectsBase],
  );
  const pinnedProjectIdSet = useMemo(() => new Set(pinnedProjectIds), [pinnedProjectIds]);
  const pinnedProjectAgentIdSet = useMemo(
    () => new Set(pinnedProjectAgentIds),
    [pinnedProjectAgentIds],
  );
  const standardProjects = useMemo(
    () => orderPinnedProjectsForSidebar(standardProjectsBase, pinnedProjectIds),
    [pinnedProjectIds, standardProjectsBase],
  );
  const workspaceProjects = useMemo(
    () =>
      mergeSidebarProjects({
        localEnvironmentId,
        projects: standardProjects.map((project) => ({
          ...project,
          isPinned: pinnedProjectIdSet.has(project.id),
        })),
        threads: sidebarThreads,
        remote: activeSpaceId === null ? remoteProjects : [],
        sortOrder: appSettings.sidebarProjectSortOrder,
        preferredOrder: workspaceProjectOrder,
      }),
    [
      localEnvironmentId,
      standardProjects,
      pinnedProjectIdSet,
      sidebarThreads,
      activeSpaceId,
      remoteProjects,
      appSettings.sidebarProjectSortOrder,
      workspaceProjectOrder,
    ],
  );
  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
      dragInProgressRef.current = false;
      if (
        appSettings.sidebarProjectSortOrder !== "manual" ||
        !event.over ||
        event.active.id === event.over.id
      )
        return;
      const keys = workspaceProjects.map((entry) => entry.key);
      const from = keys.indexOf(String(event.active.id));
      const to = keys.indexOf(String(event.over.id));
      if (from < 0 || to < 0) return;
      const [key] = keys.splice(from, 1);
      keys.splice(to, 0, key!);
      setWorkspaceProjectOrder(keys);
      const source = workspaceProjects[from]!;
      const target = workspaceProjects[to]!;
      if (!source.session && !target.session) reorderProjects(source.project.id, target.project.id);
    },
    [
      appSettings.sidebarProjectSortOrder,
      workspaceProjects,
      setWorkspaceProjectOrder,
      reorderProjects,
    ],
  );
  const handleThreadDragStart = useCallback((_event: DragStartEvent) => {
    dragInProgressRef.current = true;
    suppressThreadClickAfterDragRef.current = true;
  }, []);
  const handleThreadDragCancel = useCallback((_event: DragCancelEvent) => {
    dragInProgressRef.current = false;
    suppressThreadClickAfterDragRef.current = false;
  }, []);
  const handleThreadDragEnd = useCallback(
    (projectId: ProjectId, orderedThreadIds: readonly ThreadId[], event: DragEndEvent) => {
      dragInProgressRef.current = false;
      // A click follows the pointer-up that ended a drag; swallow that one.
      window.setTimeout(() => {
        suppressThreadClickAfterDragRef.current = false;
      }, 0);
      if (!event.over || event.active.id === event.over.id) return;
      const ids = orderedThreadIds.map(String);
      const from = ids.indexOf(String(event.active.id));
      const to = ids.indexOf(String(event.over.id));
      if (from < 0 || to < 0) return;
      const [threadId] = ids.splice(from, 1);
      ids.splice(to, 0, threadId!);
      const projectKey = String(projectId);
      setManualThreadOrderByProjectId((current) => ({
        ...current,
        [projectKey]: ids,
      }));
    },
    [setManualThreadOrderByProjectId],
  );
  const toggleWorkspaceProject = (key: string) =>
    setCollapsedWorkspaceProjects((previous) =>
      previous.includes(key) ? previous.filter((item) => item !== key) : [...previous, key],
    );
  const projectEmptyState = resolveProjectEmptyState({
    projectCount: workspaceProjects.length,
    shouldShowProjectPathEntry: createProjectDialogOpen,
    threadsHydrated,
  });
  const standardProjectSidebarDataById = useMemo<ReadonlyMap<ProjectId, SidebarDerivedProjectData>>(
    () =>
      deriveSidebarProjectData({
        projects: standardProjects,
        sortedSidebarThreadsByProjectId,
        pinnedThreadIds,
        threadListExtraPagesByProjectCwd,
        normalizeProjectCwd: normalizeSidebarProjectThreadListCwd,
        activeSidebarThreadId: routeActiveSidebarThreadId ?? undefined,
        previewLimit: THREAD_PREVIEW_LIMIT,
        previewPageSize: THREAD_PREVIEW_PAGE_SIZE,
        statusThreadsByProjectId,
        resolveThreadStatus: resolveThreadStatusForSidebar,
      }),
    [
      routeActiveSidebarThreadId,
      threadListExtraPagesByProjectCwd,
      pinnedThreadIds,
      sortedSidebarThreadsByProjectId,
      standardProjects,
      resolveThreadStatusForSidebar,
      statusThreadsByProjectId,
    ],
  );
  const handleCreateGroupChat = useCallback(
    async (groupProjectId?: ProjectId) => {
      const targetProjectId =
        groupProjectId ??
        resolveGroupChatTargetProjectId({
          activeProject: activeRouteProject,
          groupProjects,
        });
      if (!targetProjectId) {
        void navigate({ to: "/hubs" });
        return;
      }
      await handleNewGroupChat(targetProjectId, { fresh: true });
    },
    [activeRouteProject, groupProjects, handleNewGroupChat, navigate],
  );

  const handleCreatePaletteChat = useCallback(async () => {
    try {
      if (
        await dispatchSelectedWorkspaceChatCreation(
          "chat.newChat",
          `${pathname}${activeWorkspaceSearch}`,
        )
      )
        return;
      if (isOnGroups) await handleCreateGroupChat();
      else await handleCreateHomeChat();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("workspace:couldNotCreateChat"),
        description: error instanceof Error ? error.message : t("chat:tryAgain"),
      });
    }
  }, [pathname, activeWorkspaceSearch, isOnGroups, handleCreateGroupChat, handleCreateHomeChat, t]);

  const sidebarThreadSortOrder = appSettings.sidebarThreadSortOrder;
  const groupMemberThreadIdsByProjectId = useMemo(() => {
    const memberThreadIdsByProjectId = new Map<ProjectId, ReadonlySet<ThreadId>>();
    for (const project of groupProjects) {
      const memberIds = summariesByProjectId.get(project.id)?.memberThreadIds;
      if (memberIds && memberIds.length > 0) {
        memberThreadIdsByProjectId.set(project.id, new Set(memberIds));
      }
    }
    return memberThreadIdsByProjectId;
  }, [groupProjects, summariesByProjectId]);
  const groupScopedStatusThreadsByProjectId = useMemo(() => {
    if (!isOnGroups) return statusThreadsByProjectId;
    const statusThreads = [...statusThreadsByProjectId.values()].flat();
    return mergeGroupMemberThreadsIntoProjectBuckets({
      sortedSidebarThreadsByProjectId: statusThreadsByProjectId,
      threads: statusThreads,
      memberThreadIdsByProjectId: groupMemberThreadIdsByProjectId,
      includeSubagentDescendants: true,
      sortThreads: (threads) => threads,
    });
  }, [groupMemberThreadIdsByProjectId, isOnGroups, statusThreadsByProjectId]);
  const groupScopedSortedSidebarThreadsByProjectId = useMemo(() => {
    if (!isOnGroups) return sortedSidebarThreadsByProjectId;
    return mergeGroupMemberThreadsIntoProjectBuckets({
      sortedSidebarThreadsByProjectId,
      threads: displaySidebarTreeThreads,
      memberThreadIdsByProjectId: groupMemberThreadIdsByProjectId,
      sortThreads: (threads) =>
        sortThreadsForSidebar(threads, sidebarThreadSortOrder, {
          attentionFirst: sidebarThreadAttentionFirst,
          heldKeys: heldSidebarThreadSortKeys,
          manualOrderRanks: manualThreadOrderRanks,
        }),
    });
  }, [
    displaySidebarTreeThreads,
    groupMemberThreadIdsByProjectId,
    heldSidebarThreadSortKeys,
    isOnGroups,
    manualThreadOrderRanks,
    sidebarThreadAttentionFirst,
    sidebarThreadSortOrder,
    sortedSidebarThreadsByProjectId,
  ]);
  const groupProjectSidebarDataById = useMemo<
    ReadonlyMap<ProjectId, SidebarDerivedProjectData>
  >(() => {
    // Off-Groups this map is unused (surfaceProjectSidebarDataById picks the
    // standard one), so skip the derivation instead of recomputing it on every
    // Projects-side store change.
    if (!isOnGroups) {
      return EMPTY_PROJECT_SIDEBAR_DATA;
    }
    return deriveSidebarProjectData({
      projects: groupProjects,
      sortedSidebarThreadsByProjectId: groupScopedSortedSidebarThreadsByProjectId,
      pinnedThreadIds,
      threadListExtraPagesByProjectCwd,
      normalizeProjectCwd: normalizeSidebarProjectThreadListCwd,
      activeSidebarThreadId: routeActiveSidebarThreadId ?? undefined,
      previewLimit: THREAD_PREVIEW_LIMIT,
      previewPageSize: THREAD_PREVIEW_PAGE_SIZE,
      statusThreadsByProjectId: groupScopedStatusThreadsByProjectId,
      resolveThreadStatus: resolveThreadStatusForSidebar,
    });
  }, [
    routeActiveSidebarThreadId,
    isOnGroups,
    threadListExtraPagesByProjectCwd,
    pinnedThreadIds,
    groupScopedSortedSidebarThreadsByProjectId,
    groupProjects,
    resolveThreadStatusForSidebar,
    groupScopedStatusThreadsByProjectId,
  ]);
  const surfaceProjectSidebarDataById = isOnGroups
    ? groupProjectSidebarDataById
    : standardProjectSidebarDataById;
  const allProjectsExpanded = useMemo(
    () =>
      workspaceProjects.length > 0 &&
      workspaceProjects.every((entry) =>
        entry.session
          ? !collapsedWorkspaceProjects.includes(entry.key)
          : projectById.get(entry.project.id)?.expanded,
      ),
    [workspaceProjects, collapsedWorkspaceProjects, projectById],
  );
  // Reset per-project preview paging when a folder closes so reopening starts at five rows again.
  useEffect(() => {
    const settle = window.setTimeout(() => {
      setThreadListExtraPagesByProjectCwd((current) =>
        pruneProjectThreadListPagingForCollapsedProjects({
          threadListExtraPagesByProjectCwd: current,
          projects: standardProjects,
          normalizeProjectCwd: normalizeSidebarProjectThreadListCwd,
        }),
      );
    }, 0);
    return () => window.clearTimeout(settle);
  }, [standardProjects]);

  useEffect(() => {
    if (!shouldPrunePinnedThreads({ threadsHydrated })) {
      return;
    }
    prunePinnedProjects(allStandardProjectsBase.map((project) => project.id));
    prunePinnedProjectAgents(projects.map((project) => project.id));
  }, [
    allStandardProjectsBase,
    projects,
    prunePinnedProjectAgents,
    prunePinnedProjects,
    threadsHydrated,
  ]);

  useEffect(() => {
    const retainedThreadIds = new Set(sidebarThreads.map((thread) => thread.id));
    const settle = window.setTimeout(() => {
      setDismissedThreadStatusKeyByThreadId((current) => {
        const nextEntries = Object.entries(current).filter(([threadId]) =>
          retainedThreadIds.has(ThreadId.makeUnsafe(threadId)),
        );
        if (nextEntries.length === Object.keys(current).length) {
          return current;
        }
        return Object.fromEntries(nextEntries);
      });
    }, 0);
    return () => window.clearTimeout(settle);
  }, [sidebarThreads]);

  useEffect(() => {
    persistSidebarUiState({
      chatSectionExpanded,
      chatThreadListExtraPages,
      projectThreadListExtraPagesByCwd: Object.fromEntries(threadListExtraPagesByProjectCwd),
      dismissedThreadStatusKeyByThreadId,
      lastThreadRoute,
      activityViewEnabled,
      activityScope,
      activityGroupMode,
    });
  }, [
    activityScope,
    activityGroupMode,
    activityViewEnabled,
    chatSectionExpanded,
    chatThreadListExtraPages,
    dismissedThreadStatusKeyByThreadId,
    threadListExtraPagesByProjectCwd,
    lastThreadRoute,
  ]);

  useEffect(() => {
    if (isOnSettings || routeThreadId === null) {
      return;
    }

    const nextLastThreadRoute = {
      threadId: routeThreadId,
      ...(routeSearch.splitViewId ? { splitViewId: routeSearch.splitViewId } : {}),
    };
    const settle = window.setTimeout(() => {
      setLastThreadRoute((current) => {
        if (
          current?.threadId === nextLastThreadRoute.threadId &&
          current?.splitViewId === nextLastThreadRoute.splitViewId
        ) {
          return current;
        }
        return nextLastThreadRoute;
      });
    }, 0);
    return () => window.clearTimeout(settle);
  }, [isOnSettings, routeSearch.splitViewId, routeThreadId]);

  const handleThreadClick = useCallback(
    (
      event: MouseEvent<HTMLElement>,
      threadId: ThreadId,
      orderedProjectThreadIds: readonly ThreadId[],
    ) => {
      const isMac = isMacNavigatorPlatform();
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const isShiftClick = event.shiftKey;

      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadId);
        return;
      }

      if (isShiftClick) {
        event.preventDefault();
        rangeSelectTo(threadId, orderedProjectThreadIds);
        return;
      }

      activateThreadRow(threadId, event.currentTarget);
    },
    [activateThreadRow, rangeSelectTo, toggleThreadSelection],
  );

  const workspaceProjectThreadData = useMemo(
    () =>
      new Map(
        [...workspaceProjects, ...remoteGroupProjects].flatMap((entry) =>
          entry.session
            ? [
                [
                  entry.key,
                  deriveWorkspaceProjectThreadRows({
                    entry,
                    sortOrder: appSettings.sidebarThreadSortOrder,
                    activeThreadId: selectedByEnvironment.get(
                      entry.session.host.executionScope.environmentId,
                    ),
                    extraPages: workspaceProjectExtraPages.get(entry.key) ?? 0,
                  }),
                ] as const,
              ]
            : [],
        ),
      ),
    [
      workspaceProjects,
      remoteGroupProjects,
      appSettings.sidebarThreadSortOrder,
      selectedByEnvironment,
      workspaceProjectExtraPages,
    ],
  );
  const visibleWorkspaceThreads = useMemo(() => {
    const rows = new Map<
      string,
      { threadId: ThreadId; session: WorkspaceThreadEntry["session"] }
    >();
    const add = (threadId: ThreadId, session: WorkspaceThreadEntry["session"]) => {
      // Cached disconnected rows stay visible, but shortcuts must never activate them.
      if (session && (session.error || session.summary?.state !== "open" || !session.navigation))
        return;
      rows.set(
        workspaceThreadKey(
          session?.host.executionScope.environmentId ?? localEnvironmentId,
          threadId,
        ),
        { threadId, session },
      );
    };
    if (activityViewEnabled && !isOnGroups) {
      const localActivityThreadIds = new Set(
        activityNonGroupSidebarThreads.map((thread) => thread.id),
      );
      for (const id of activityVisibleThreadIds) {
        const remote = workspaceActivity.remoteById.get(id);
        if (remote) add(remote.thread.id, remote.session);
        else if (localActivityThreadIds.has(id)) add(id, null);
      }
      return rows;
    }
    for (const thread of pinnedThreads) add(thread.id, null);
    for (const entry of remotePinnedThreads) add(entry.thread.id, entry.session);
    if (isOnGroups) {
      for (const entry of remoteGroupProjects) {
        if (collapsedWorkspaceProjects.includes(entry.key)) continue;
        for (const child of workspaceProjectThreadData.get(entry.key)?.visibleEntries ?? [])
          add(child.row.thread.id, entry.session);
      }
      for (const project of groupProjects) {
        const data = groupProjectSidebarDataById.get(project.id);
        if (!data) continue;
        if (!project.expanded) {
          if (data.activeEntryId) add(data.activeEntryId, null);
        } else {
          for (const entry of data.visibleEntries) add(entry.rowId, null);
        }
      }
      return rows;
    }
    for (const entry of workspaceProjects) {
      if (entry.session) {
        if (collapsedWorkspaceProjects.includes(entry.key)) continue;
        for (const child of workspaceProjectThreadData.get(entry.key)?.visibleEntries ?? [])
          add(child.row.thread.id, entry.session);
      } else {
        const data = standardProjectSidebarDataById.get(entry.project.id);
        if (!data) continue;
        if (!projectById.get(entry.project.id)?.expanded) {
          if (data.activeEntryId) add(data.activeEntryId, null);
        } else {
          for (const child of data.visibleEntries) add(child.rowId, null);
        }
      }
    }
    for (const threadId of classicSnoozedVisibleThreadIds) add(threadId, null);
    if (chatsSectionVisible && chatSectionExpanded) {
      for (const entry of renderedChatEntries)
        add(entry.row.thread.id, entry.row.workspaceEntry.session);
    }
    return rows;
  }, [
    localEnvironmentId,
    classicSnoozedVisibleThreadIds,
    activityViewEnabled,
    isOnGroups,
    activityVisibleThreadIds,
    activityNonGroupSidebarThreads,
    workspaceActivity,
    pinnedThreads,
    remotePinnedThreads,
    groupProjectSidebarDataById,
    groupProjects,
    remoteGroupProjects,
    workspaceProjects,
    collapsedWorkspaceProjects,
    workspaceProjectThreadData,
    standardProjectSidebarDataById,
    projectById,
    chatsSectionVisible,
    chatSectionExpanded,
    renderedChatEntries,
  ]);
  const visibleWorkspaceThreadKeys = useMemo(
    () => [...visibleWorkspaceThreads.keys()],
    [visibleWorkspaceThreads],
  );
  const activeWorkspaceThreadKey =
    pathname === "/remote"
      ? (() => {
          const environmentId = activeWorkspaceParams.get("environment");
          const threadId = environmentId ? selectedByEnvironment.get(environmentId) : undefined;
          return environmentId && threadId
            ? workspaceThreadKey(environmentId, threadId)
            : undefined;
        })()
      : visualActiveSidebarThreadId
        ? workspaceThreadKey(localEnvironmentId, visualActiveSidebarThreadId)
        : undefined;
  const activateWorkspaceThread = useCallback(
    (key: string) => {
      const target = visibleWorkspaceThreads.get(key);
      if (!target) return;
      if (target.session) openWorkspacePath(target.session, `/${target.threadId}`);
      else activateThreadFromSidebarIntent(target.threadId);
    },
    [visibleWorkspaceThreads, activateThreadFromSidebarIntent],
  );
  // Only local IDs enter local detail subscriptions and git/PR queries.
  const visibleSidebarThreadIds = useMemo(
    () =>
      [...visibleWorkspaceThreads.values()]
        .filter((entry) => !entry.session)
        .map((entry) => entry.threadId),
    [visibleWorkspaceThreads],
  );
  const visibleSidebarThreadIdSet = useMemo(
    () =>
      new Set(
        activityViewEnabled && !isOnGroups
          ? visibleSidebarThreadIds
          : [...visibleSidebarThreadIds, ...visibleChatThreadIds],
      ),
    [activityViewEnabled, isOnGroups, visibleChatThreadIds, visibleSidebarThreadIds],
  );
  const visibleSidebarThreads = useMemo(
    () => sidebarThreads.filter((thread) => visibleSidebarThreadIdSet.has(thread.id)),
    [sidebarThreads, visibleSidebarThreadIdSet],
  );
  // PR badges only render on visible rows, so keep git/PR query setup off hidden project history.
  const prByThreadId = useThreadPullRequests({
    threads: visibleSidebarThreads,
    projectCwdById,
  });
  const isManualProjectSorting = appSettings.sidebarProjectSortOrder === "manual";
  const threadJumpCommandByThreadId = useMemo(() => {
    const mapping = new Map<string, NonNullable<ReturnType<typeof threadJumpCommandForIndex>>>();
    for (const [visibleThreadIndex, threadId] of visibleWorkspaceThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(visibleThreadIndex);
      if (!jumpCommand) {
        break;
      }
      mapping.set(threadId, jumpCommand);
    }

    return mapping;
  }, [visibleWorkspaceThreadKeys]);
  const threadJumpThreadIds = useMemo(
    () => [...threadJumpCommandByThreadId.keys()],
    [threadJumpCommandByThreadId],
  );
  const getCurrentSidebarShortcutContext = useCallback(
    () => ({
      terminalFocus: isTerminalFocused(),
      terminalOpen,
      terminalWorkspaceOpen,
    }),
    [terminalOpen, terminalWorkspaceOpen],
  );
  const [threadJumpLabelByThreadId, setThreadJumpLabelByThreadId] =
    useState<ReadonlyMap<string, string>>(EMPTY_THREAD_JUMP_LABELS);
  const threadJumpLabelsRef = useRef<ReadonlyMap<string, string>>(EMPTY_THREAD_JUMP_LABELS);
  useEffect(() => {
    threadJumpLabelsRef.current = threadJumpLabelByThreadId;
  }, [threadJumpLabelByThreadId]);
  const [showThreadJumpHints, setShowThreadJumpHints] = useState(false);
  const showThreadJumpHintsRef = useRef(false);
  useEffect(() => {
    showThreadJumpHintsRef.current = showThreadJumpHints;
  }, [showThreadJumpHints]);
  const visibleThreadJumpLabelByKey = showThreadJumpHints
    ? threadJumpLabelByThreadId
    : EMPTY_THREAD_JUMP_LABELS;
  const visibleThreadJumpLabelByThreadId = useMemo(
    () =>
      new Map(
        [...visibleWorkspaceThreads].flatMap(([key, target]) => {
          const label = visibleThreadJumpLabelByKey.get(key);
          return !target.session && label ? [[target.threadId, label] as const] : [];
        }),
      ),
    [visibleWorkspaceThreads, visibleThreadJumpLabelByKey],
  );
  const activityThreadJumpLabelByThreadId = useMemo(
    () =>
      new Map(
        activityThreads.flatMap((thread) => {
          const remote = workspaceActivity.remoteById.get(thread.id);
          const key = workspaceThreadKey(
            remote?.session?.host.executionScope.environmentId ?? localEnvironmentId,
            remote?.thread.id ?? thread.id,
          );
          const label = visibleThreadJumpLabelByKey.get(key);
          return label ? [[thread.id, label] as const] : [];
        }),
      ),
    [activityThreads, localEnvironmentId, visibleThreadJumpLabelByKey, workspaceActivity],
  );

  useEffect(() => {
    const threadIdsToPrewarm = getSidebarThreadIdsToPrewarm({
      visibleThreadIds: visibleSidebarThreadIds,
      activeThreadId: activeSidebarThreadId,
    });
    // Retaining a thread without cached detail would open a full-history
    // snapshot stream speculatively; only cursor-resumable threads are cheap
    // enough to keep warm from scroll position alone.
    const releaseCallbacks = threadIdsToPrewarm
      .filter((threadId) => hasThreadDetailResumeCursor(threadId))
      .map((threadId) => retainThreadDetailSubscription(threadId));

    return () => {
      for (const release of releaseCallbacks) {
        release();
      }
    };
  }, [activeSidebarThreadId, visibleSidebarThreadIds]);

  // Pinned rows share the thread-container label rule (project name, or
  // "Synara" for project-less chats) with the hover cards and Activity rows.
  function resolvePinnedThreadProjectLabel(projectId: ProjectId): string {
    return resolveThreadProjectLabel(projectById.get(projectId));
  }

  // Keep hover actions in the same trailing slot used by the timestamp they replace.
  function renderThreadArchiveAction(threadId: ThreadId, toneClassName: string) {
    return (
      <ThreadArchiveActionButton
        threadId={threadId}
        toneClassName={toneClassName}
        onArchive={() => void archiveThreadWithUndo(threadId)}
      />
    );
  }

  function renderThreadHoverActions(input: {
    threadId: ThreadId;
    toneClassName: string;
    isPinned: boolean;
    includePinToggle?: boolean;
  }) {
    const includePinToggle = input.includePinToggle !== false;

    return (
      <SidebarRowHoverActions threadId={input.threadId}>
        <div className="pointer-events-auto inline-flex items-center gap-2">
          {includePinToggle ? (
            <ThreadPinToggleButton
              pinned={input.isPinned}
              presentation="inline"
              toneClassName={input.toneClassName}
              onToggle={(event) => {
                event.preventDefault();
                event.stopPropagation();
                toggleThreadPinned(input.threadId);
              }}
            />
          ) : null}
          {renderThreadArchiveAction(input.threadId, input.toneClassName)}
        </div>
      </SidebarRowHoverActions>
    );
  }

  // Optional row facts from the Neox workspace record. They reuse the existing chip
  // primitive so a configured row still looks like the rest of the sidebar.
  function resolveThreadWorkspaceFieldChips(thread: SidebarThreadSummary): ThreadMetaChip[] {
    const workspace = resolveThreadWorkspaceRecord(thread);
    if (!workspace) return [];
    const rowItems = appSettings.sidebarRowItems;
    const chips: ThreadMetaChip[] = [];
    if (rowItems.checks && workspace.checksStatus && workspace.checksStatus !== "none") {
      const checks = workspace.checksStatus;
      chips.push({
        id: "checks",
        tooltip:
          checks === "success"
            ? t("workspace:display_checksPassed")
            : checks === "failure"
              ? t("workspace:display_checksFailed")
              : t("workspace:display_checksPending"),
        icon:
          checks === "success" ? (
            <SidebarGlyph
              icon={CircleCheckIcon}
              variant="meta"
              className="text-emerald-600 dark:text-emerald-300/90"
            />
          ) : checks === "failure" ? (
            <SidebarGlyph
              icon={TriangleAlertIcon}
              variant="meta"
              className="text-rose-600 dark:text-rose-300/90"
            />
          ) : (
            <SidebarGlyph
              icon={ClockIcon}
              variant="meta"
              className="text-amber-600 dark:text-amber-300/90"
            />
          ),
      });
    }
    const serviceCount = workspace.runningServiceCount ?? 0;
    if (rowItems.services && serviceCount > 0) {
      chips.push({
        id: "services",
        tooltip: t("workspace:display_runningServices", { value0: serviceCount }),
        icon: (
          <SidebarGlyph
            icon={GlobeIcon}
            variant="meta"
            className="text-teal-600 dark:text-teal-300/90"
          />
        ),
      });
    }
    return chips;
  }

  function renderThreadRowMetaFields(
    thread: SidebarThreadSummary,
    workspace: ReturnType<typeof resolveThreadWorkspaceRecord>,
  ): ReactNode {
    const rowItems = appSettings.sidebarRowItems;
    const items: ReactElement[] = [];
    const branch = thread.branch ?? workspace?.branch ?? null;
    if (rowItems.branch && branch) {
      items.push(
        <span key="branch" className="inline-flex min-w-0 items-center gap-1">
          <SidebarGlyph icon={GitBranchIcon} variant="meta" className="size-3 shrink-0" />
          <span className="truncate">{branch}</span>
        </span>,
      );
    }
    if (rowItems.project) {
      const projectName = projectById.get(thread.projectId)?.name;
      if (projectName) {
        items.push(
          <span key="project" className="truncate">
            {projectName}
          </span>,
        );
      }
    }
    if (rowItems.services && (workspace?.runningServiceCount ?? 0) > 0) {
      items.push(
        <span key="services" className="inline-flex items-center gap-1">
          <SidebarGlyph icon={GlobeIcon} variant="meta" className="size-3 shrink-0" />
          {workspace?.runningServiceCount}
        </span>,
      );
    }
    if (items.length === 0) return null;
    return items.flatMap((item, index) =>
      index === 0
        ? [item]
        : [
            // Keyed by the field it precedes so hiding one field never re-keys the others.
            <span key={`sep-${item.key}`} aria-hidden className="text-muted-foreground/30">
              ·
            </span>,
            item,
          ],
    );
  }

  function renderThreadRowTrailingMeta(
    thread: SidebarThreadSummary,
    workspace: ReturnType<typeof resolveThreadWorkspaceRecord>,
  ): ReactNode {
    if (appSettings.sidebarThreadTrailing === "time") {
      return (
        <span className="shrink-0 text-ui-xs tabular-nums text-muted-foreground/45">
          {formatRelativeTime(thread.updatedAt ?? thread.createdAt, undefined, formatLocale)}
        </span>
      );
    }
    if (appSettings.sidebarThreadTrailing === "diff") {
      const diff = workspace?.diffStat;
      if (!diff || (diff.additions === 0 && diff.deletions === 0)) return null;
      return (
        <span className="shrink-0 text-ui-xs tabular-nums text-muted-foreground/55">
          <span className="text-emerald-600/80 dark:text-emerald-300/80">+{diff.additions}</span>{" "}
          <span className="text-rose-600/80 dark:text-rose-300/80">−{diff.deletions}</span>
        </span>
      );
    }
    return null;
  }

  function renderThreadRowTrailingCluster(input: {
    threadJumpLabel: string | null;
    rightMetaChips: ThreadMetaChip[];
    prChip: ThreadMetaChip | null;
    trailingMeta?: ReactNode;
    threadStatus: ReturnType<typeof resolveThreadStatusForSidebar>;
    timestampToneClassName?: string;
    hoverActions: ReactNode;
  }) {
    // The jump shortcut owns the slot while it is visible; otherwise the shared
    // rule decides which status glyph shows here.
    const trailingStatus = resolveThreadStatusTrailingIndicator({
      status: input.threadStatus,
      slotOccupied: Boolean(input.threadJumpLabel),
    });
    return (
      <div className="relative flex min-w-0 items-center justify-end gap-2 group-hover/thread-row:min-w-12 group-focus-within/thread-row:min-w-12">
        {input.trailingMeta ? (
          <div className={cn("shrink-0", THREAD_ROW_META_CHIP_HOVER_FADE_CLASS_NAME)}>
            {input.trailingMeta}
          </div>
        ) : null}
        {input.rightMetaChips.length > 0 ? (
          <div className={cn("shrink-0", THREAD_ROW_META_CHIP_HOVER_FADE_CLASS_NAME)}>
            <SidebarMetaChipStack chips={input.rightMetaChips} />
          </div>
        ) : null}
        {input.threadJumpLabel ? (
          <ShortcutKbd
            shortcutLabel={input.threadJumpLabel}
            title={input.threadJumpLabel}
            groupClassName={cn(THREAD_ROW_META_CHIP_HOVER_FADE_CLASS_NAME, "shrink")}
          />
        ) : null}
        {trailingStatus ? (
          // The relative time now lives in the row hover card, so the trailing
          // slot only carries the live status/loader glyph; when idle it
          // collapses and the hover action icons sit flush at the end.
          <span
            title={trailingStatus.label}
            className={threadRowStatusSlotClassName(input.timestampToneClassName)}
          >
            <SidebarStatusTrailingGlyph status={trailingStatus} />
          </span>
        ) : null}
        {input.prChip ? (
          <div className={cn("shrink-0", THREAD_ROW_META_CHIP_HOVER_FADE_CLASS_NAME)}>
            <SidebarMetaChipStack chips={[input.prChip]} />
          </div>
        ) : null}
        {input.hoverActions}
      </div>
    );
  }

  // Section header (label + hover-revealed toolbar) shared by the Threads and Groups surfaces,
  // so spacing/typography stay in lockstep; only the label and toolbar contents vary.
  function renderListSectionHeader(label: string, toolbar: ReactNode) {
    return (
      <div className="group/project-header relative my-1">
        <div
          className={cn(
            "flex h-7 w-full min-w-0 items-center px-2 py-0.5 pr-[4.75rem]",
            SIDEBAR_SECTION_LABEL_CLASS_NAME,
          )}
        >
          <span className="truncate">{label}</span>
        </div>
        <SidebarSectionToolbar placement="overlay" revealOnHover>
          {toolbar}
        </SidebarSectionToolbar>
      </div>
    );
  }
  // Identical "Pinned" header + rows block shared by the Threads and Groups surfaces.
  // `pinnedThreads` is already the surface-appropriate list, so a single helper keeps both in sync.
  function renderPinnedThreadsSection() {
    if (pinnedThreads.length === 0 && remotePinnedThreads.length === 0) {
      return null;
    }
    return (
      <div className="mb-3">
        <div className="my-1 flex items-center justify-between px-2 py-1">
          <span className={SIDEBAR_SECTION_LABEL_CLASS_NAME}>{t("common:app_pinned")}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          {pinnedThreads.map((thread) => renderPinnedThreadRow(thread))}
          {remotePinnedThreads.map((entry) => (
            <WorkspaceThreadRow
              key={entry.key}
              entry={entry}
              topLevel
              threadJumpLabel={visibleThreadJumpLabelByKey.get(entry.key) ?? null}
              renderHoverCard={renderRemoteThreadHoverCard(entry)}
            />
          ))}
        </div>
      </div>
    );
  }

  function renderSnoozedThreadRow(thread: SidebarThreadSummary) {
    return (
      <ActivityThreadRow
        key={thread.id}
        thread={thread}
        project={projectById.get(thread.projectId)}
        isActive={visualActiveSidebarThreadId === thread.id}
        isOpen={activeSidebarThreadId === thread.id}
        isSettled={false}
        isPinned={pinnedThreadIdSet.has(thread.id)}
        threadJumpLabel={visibleThreadJumpLabelByThreadId.get(thread.id) ?? null}
        hasPendingDraft={draftThreadIdSet.has(thread.id)}
        pr={
          prByThreadId.has(thread.id)
            ? (prByThreadId.get(thread.id) ?? null)
            : resolveThreadPullRequestFallback({
                branch: thread.branch,
                hasDedicatedWorktree: thread.worktreePath !== null,
                lastKnownPr: thread.lastKnownPr ?? null,
              })
        }
        status={resolveThreadStatusForSidebar(thread)}
        onOpen={() => activateThreadFromSidebarIntent(thread.id)}
        onOpenPullRequest={(event, pr) => openThreadPullRequest(event, thread, pr)}
        onSetSettled={(settled) => setThreadSettledWithToast(thread.id, settled)}
        onReturnSnoozed={() => setThreadSnoozedUntil(thread.id, null)}
        onTogglePinned={() => toggleThreadPinned(thread.id)}
        onArchive={() => void archiveThreadWithUndo(thread.id)}
        onRename={openRenameThreadDialog}
        onRenamePointerUp={handleThreadRenamePointerUp}
        onContextMenu={(threadId, position) => {
          void handleThreadContextMenu(threadId, position);
        }}
        renderHoverCard={(anchorId) =>
          renderThreadHoverCardPopup(thread, anchorId, activeSidebarThreadId === thread.id)
        }
      />
    );
  }

  // Shared rich hover card for thread/chat rows. Worktree metadata is resolved
  // once here so pinned and nested rows stay visually and semantically identical.
  function renderThreadHoverCardPopup(
    thread: SidebarThreadSummary,
    hoverAnchorId: string,
    isActive: boolean,
  ) {
    // Activity lists chats from connected computers too; they carry the host's
    // project, status and name instead of this computer's.
    const remote = externalActivityRows.get(thread.id);
    const hoverProject = activityProjectById.get(thread.projectId) ?? null;
    const hoverMetadata = resolveThreadHoverCardMetadata({
      thread,
      project: hoverProject,
    });
    const hoverStatus = resolveThreadStatusTrailingIndicator({
      status: remote ? remote.status : resolveThreadStatusForSidebar(thread),
      isActive,
    });
    return (
      <TooltipPopup
        {...SIDEBAR_HOVER_CARD_POPUP_PROPS}
        // Zero the viewport's px-2 py-1 inset so the card's own padding matches
        // the project PreviewCard (which has no viewport). The var also drives
        // the viewport width calc, so setting it to 0 keeps the content full-width.
        viewportClassName="[--viewport-inline-padding:0px] py-0"
        anchor={createThreadHoverCardAnchor(hoverAnchorId)}
        className={cn(SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME, "whitespace-normal leading-tight")}
      >
        <ThreadHoverCardContent
          threadId={thread.id}
          title={thread.title}
          timeLabel={formatRelativeTime(
            thread.updatedAt ?? thread.createdAt,
            undefined,
            formatLocale,
          )}
          projectName={hoverMetadata.projectName}
          // A remote path means nothing here: keep the plain folder glyph.
          projectCwd={remote ? null : hoverMetadata.projectCwd}
          projectAppearance={hoverProject?.appearance ?? null}
          sourceProjectName={hoverMetadata.sourceProjectName}
          branch={hoverMetadata.branch}
          worktreeName={hoverMetadata.worktreeName}
          pullRequest={prByThreadId.get(thread.id) ?? null}
          onOpenPullRequest={openPrLink}
          model={thread.modelSelection}
          modelCatalogQueryOptions={modelQueryOptionsForProviderInstance({
            provider: thread.modelSelection.provider,
            instanceId: thread.modelSelection.instanceId ?? thread.modelSelection.provider,
            settings: appSettings,
            enabled: false,
            cwd: resolveProviderDiscoveryCwd({
              activeThreadWorktreePath: thread.worktreePath,
              activeProjectCwd: hoverProject?.cwd ?? null,
              serverCwd,
            }),
          })}
          status={hoverStatus}
          hostName={remote?.hostName ?? null}
        />
      </TooltipPopup>
    );
  }

  // Interactive hover card for project/folder rows: name + pin toggle, chat
  // count, path, and an "Edit project" action. Rendered inside a PreviewCard so
  // its controls stay reachable when the pointer moves into the card.
  function renderProjectHoverCardPopup(
    project: (typeof sortedProjects)[number],
    chatCount: number,
  ) {
    return (
      <PreviewCardPopup
        {...SIDEBAR_HOVER_CARD_POPUP_PROPS}
        anchor={createProjectHoverCardAnchor(project.id)}
        className={SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME}
      >
        <ProjectHoverCardContent
          name={project.name}
          cwd={project.cwd}
          appearance={project.appearance ?? null}
          isPinned={pinnedProjectIdSet.has(project.id)}
          chatCount={chatCount}
          path={abbreviateHomePath(project.cwd, homeDir)}
          onTogglePin={() => toggleProjectPinned(project.id)}
          onEditProject={() => void handleProjectContextMenuAction(project.id, "rename")}
        />
      </PreviewCardPopup>
    );
  }

  function renderPinnedThreadRow(thread: SidebarThreadSummary) {
    const threadTerminalState = selectThreadTerminalState(terminalStateByThreadId, thread.id);
    const threadEntryPoint = threadTerminalState.entryPoint;
    const terminalStatus = terminalStatusFromThreadState({
      runningTerminalIds: threadTerminalState.runningTerminalIds,
      terminalAttentionStatesById: threadTerminalState.terminalAttentionStatesById,
    });
    const terminalCount = threadTerminalState.terminalIds.length;
    const isActive = visualActiveSidebarThreadId === thread.id;
    const projectLabel = resolvePinnedThreadProjectLabel(thread.projectId);
    const rightMetaChips = [
      ...resolveThreadRowMetaChips({
        thread,
        includeHandoffBadge: true,
        handoffShownInAvatar:
          threadEntryPoint !== "terminal" &&
          !isGenericChatThreadTitle(thread.title) &&
          Boolean(thread.handoff?.sourceProvider),
        threadAutomations: automationsByThreadId.get(thread.id),
      }),
      ...resolveThreadWorkspaceFieldChips(thread),
    ];
    const threadWorkspace = resolveThreadWorkspaceRecord(thread);
    const displayTitle = resolveThreadDisplayTitle(thread);
    const threadStatus = resolveThreadStatusForSidebar(thread);
    const pr = prByThreadId.get(thread.id) ?? null;
    const prChip = !thread.forkSourceThreadId && pr ? resolveThreadRowPrChip(pr) : null;
    const threadJumpLabel = visibleThreadJumpLabelByThreadId.get(thread.id) ?? null;
    const hoverAnchorId = createSidebarThreadHoverAnchorId({
      scope: "pinned",
      threadId: thread.id,
    });
    return (
      <Tooltip key={thread.id}>
        <TooltipTrigger
          {...SIDEBAR_HOVER_CARD_TRIGGER_PROPS}
          render={
            <div
              data-thread-hover-anchor={hoverAnchorId}
              className="group/thread-row relative w-full"
            />
          }
        >
          <div
            role="button"
            tabIndex={0}
            data-thread-item
            aria-label={resolveThreadRowAriaLabel({ ...thread, title: displayTitle })}
            aria-description={prChip?.tooltip}
            className={cn(
              SIDEBAR_HEADER_ROW_CLASS_NAME,
              // Metadata and shortcut hints occupy their actual width in the flex row.
              "relative gap-1.5 pr-2 transition-colors",
              isActive
                ? SIDEBAR_ROW_ACTIVE_CLASS_NAME
                : cn(
                    SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
                    SIDEBAR_ROW_HOVER_CLASS_NAME,
                    threadStatus?.label === "Reminder" && SIDEBAR_ROW_SNOOZE_REMINDER_CLASS_NAME,
                  ),
            )}
            onPointerDown={(event) => primeThreadActivation(event, thread.id)}
            onClick={(event) => activateThreadRow(thread.id, event.currentTarget)}
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openRenameThreadDialog(thread.id);
            }}
            onPointerUp={(event) => handleThreadRenamePointerUp(event, thread.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                activateThreadRow(thread.id, event.currentTarget);
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              void handleThreadContextMenu(thread.id, {
                x: event.clientX,
                y: event.clientY,
              });
            }}
          >
            <SidebarThreadRowContent
              thread={thread}
              terminalEntryPoint={threadEntryPoint === "terminal"}
              terminalStatus={terminalStatus}
              terminalCount={terminalCount}
              isActive={isActive}
              variant="pinned"
              pendingStatusColorClass={
                threadStatus?.label === "Pending Approval" ? threadStatus.colorClass : null
              }
              workspaceLabels={
                appSettings.sidebarRowItems.labels
                  ? resolveThreadWorkspaceLabels(thread)
                  : undefined
              }
              title={displayTitle}
              meta={renderThreadRowMetaFields(thread, threadWorkspace)}
              suffix={
                projectLabel ? (
                  // While shortcut hints show, the project name yields width before the title.
                  <span
                    className={cn(
                      "min-w-0 max-w-[40%] truncate text-right text-ui-meta text-muted-foreground/38",
                      threadJumpLabel ? "shrink-[2]" : "shrink-0",
                    )}
                  >
                    {projectLabel}
                  </span>
                ) : null
              }
            />
            <div className="flex min-w-0 items-center">
              {renderThreadRowTrailingCluster({
                threadJumpLabel,
                rightMetaChips,
                prChip,
                trailingMeta: renderThreadRowTrailingMeta(thread, threadWorkspace),
                threadStatus,
                timestampToneClassName: "text-muted-foreground/38",
                hoverActions: renderThreadHoverActions({
                  threadId: thread.id,
                  toneClassName: "text-muted-foreground/42",
                  isPinned: true,
                }),
              })}
            </div>
          </div>
        </TooltipTrigger>
        {renderThreadHoverCardPopup(thread, hoverAnchorId, activeSidebarThreadId === thread.id)}
      </Tooltip>
    );
  }

  function renderThreadRow(
    thread: SidebarThreadSummary,
    orderedProjectThreadIds: readonly ThreadId[],
    // Chat rows sit directly under the "Chats" header (no project nesting), so
    // their top-level rows align flush like pinned rows instead of the indented
    // column used for project-nested threads.
    topLevel = false,
    // A group member thread dispatched into a linked repo shows where it runs —
    // same small-label treatment as pinned rows' project name.
    projectContextLabel?: string,
    sortable?: SortableThreadHandleProps | undefined,
  ) {
    const threadTerminalState = selectThreadTerminalState(terminalStateByThreadId, thread.id);
    const threadEntryPoint = threadTerminalState.entryPoint;
    const isActive = visualActiveSidebarThreadId === thread.id;
    const isPinned = pinnedThreadIdSet.has(thread.id);
    const isSelected = selectedThreadIds.has(thread.id);
    const isHighlighted = isActive || isSelected;
    const threadStatus = resolveThreadStatusForSidebar(thread);
    const pr = prByThreadId.get(thread.id) ?? null;
    const terminalStatus = terminalStatusFromThreadState({
      runningTerminalIds: threadTerminalState.runningTerminalIds,
      terminalAttentionStatesById: threadTerminalState.terminalAttentionStatesById,
    });
    const terminalCount = threadTerminalState.terminalIds.length;
    const isTemporaryThread =
      temporaryThreadIds[thread.id] === true ||
      draftThreadsByThreadId[thread.id]?.isTemporary === true;
    const secondaryMetaClass = isHighlighted
      ? "text-foreground/54 dark:text-foreground/64"
      : "text-muted-foreground/34";
    const threadWorkspace = resolveThreadWorkspaceRecord(thread);
    const displayTitle = resolveThreadDisplayTitle(thread);
    const rightMetaChips = [
      ...resolveThreadRowMetaChips({
        thread,
        includeHandoffBadge: !isTemporaryThread,
        handoffShownInAvatar:
          threadEntryPoint !== "terminal" &&
          !isGenericChatThreadTitle(thread.title) &&
          Boolean(thread.handoff?.sourceProvider),
        threadAutomations: automationsByThreadId.get(thread.id),
      }),
      ...resolveThreadWorkspaceFieldChips(thread),
    ];
    const prChip = !thread.forkSourceThreadId && pr ? resolveThreadRowPrChip(pr) : null;
    const threadJumpLabel = visibleThreadJumpLabelByThreadId.get(thread.id) ?? null;
    const hoverAnchorId = createSidebarThreadHoverAnchorId({
      scope: topLevel ? "chat" : "project",
      threadId: thread.id,
    });

    const rowButton = (
      <SidebarMenuSubButton
        render={<div role="button" tabIndex={0} />}
        data-thread-entry-point={threadEntryPoint}
        size="sm"
        isActive={isActive}
        aria-label={resolveThreadRowAriaLabel({ ...thread, title: displayTitle })}
        aria-description={prChip?.tooltip}
        className={cn(
          resolveThreadRowClassName({
            isActive,
            isSelected,
            isSnoozeReminder: threadStatus?.label === "Reminder",
          }),
          topLevel ? "pl-2" : null,
          "pr-2",
          sortable ? "cursor-grab active:cursor-grabbing" : null,
        )}
        {...(sortable ? sortable.attributes : {})}
        draggable={!sortable}
        onDragStart={sortable ? undefined : (event) => beginThreadDrag(event, thread.id)}
        onDragEnd={sortable ? undefined : endThreadDrag}
        onClick={(event) => {
          handleThreadClick(event, thread.id, orderedProjectThreadIds);
        }}
        onPointerDown={(event) => primeThreadActivation(event, thread.id)}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openRenameThreadDialog(thread.id);
        }}
        onPointerUp={(event) => handleThreadRenamePointerUp(event, thread.id)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          activateThreadRow(thread.id, event.currentTarget);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          // A right-click inside an active multi-selection acts on the whole
          // selection; anywhere else it drops the selection and targets the row.
          if (selectedThreadIds.size > 0 && selectedThreadIds.has(thread.id)) {
            void handleMultiSelectContextMenu({
              x: event.clientX,
              y: event.clientY,
            });
            return;
          }
          if (selectedThreadIds.size > 0) {
            clearSelection();
          }
          void handleThreadContextMenu(thread.id, {
            x: event.clientX,
            y: event.clientY,
          });
        }}
      >
        <SidebarThreadRowContent
          thread={thread}
          terminalEntryPoint={threadEntryPoint === "terminal"}
          terminalStatus={terminalStatus}
          terminalCount={terminalCount}
          isActive={isActive}
          variant="standard"
          pendingStatusColorClass={
            threadStatus?.label === "Pending Approval" ? threadStatus.colorClass : null
          }
          workspaceLabels={
            appSettings.sidebarRowItems.labels ? resolveThreadWorkspaceLabels(thread) : undefined
          }
          title={displayTitle}
          meta={renderThreadRowMetaFields(thread, threadWorkspace)}
          suffix={
            isTemporaryThread ? (
              <div className="ml-auto flex shrink-0 items-center gap-1.5 pr-1">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="inline-flex shrink-0 items-center text-muted-foreground/55">
                        <TemporaryThreadIcon />
                      </span>
                    }
                  />
                  <TooltipPopup side="top">{t("chat:temporaryChat_ariaLabel")}</TooltipPopup>
                </Tooltip>
              </div>
            ) : projectContextLabel ? (
              <span className="min-w-0 max-w-[40%] shrink truncate pl-1 pr-1 text-ui-meta text-muted-foreground/38">
                {projectContextLabel}
              </span>
            ) : undefined
          }
        />
        <div className="flex min-w-0 items-center">
          {renderThreadRowTrailingCluster({
            threadJumpLabel,
            rightMetaChips,
            prChip,
            trailingMeta: renderThreadRowTrailingMeta(thread, threadWorkspace),
            threadStatus,
            timestampToneClassName: secondaryMetaClass,
            hoverActions: renderThreadHoverActions({
              threadId: thread.id,
              toneClassName: secondaryMetaClass,
              isPinned,
            }),
          })}
        </div>
      </SidebarMenuSubButton>
    );

    return (
      <SidebarMenuSubItem
        key={thread.id}
        ref={sortable ? sortable.setNodeRef : undefined}
        style={
          sortable ? { transform: sortable.transform, transition: sortable.transition } : undefined
        }
        data-thread-hover-anchor={hoverAnchorId}
        className={cn(
          "group/thread-row w-full",
          sortable?.isDragging ? "z-20 opacity-80" : null,
          sortable?.isOver && !sortable.isDragging ? "ring-1 ring-primary/40" : null,
        )}
        {...(sortable ? sortable.listeners : {})}
        data-thread-item
      >
        {sortable ? (
          rowButton
        ) : (
          <Tooltip>
            <TooltipTrigger {...SIDEBAR_HOVER_CARD_TRIGGER_PROPS} render={rowButton} />
            {renderThreadHoverCardPopup(thread, hoverAnchorId, activeSidebarThreadId === thread.id)}
          </Tooltip>
        )}
      </SidebarMenuSubItem>
    );
  }

  // Inbox / new terminal thread / new thread for one project. Shared by the tree's
  // hover toolbar and the rail layout's Spaces drill-in header.
  function renderProjectThreadActions(project: (typeof sortedProjects)[number]) {
    return (
      <>
        {/* Neox 无 GitHub inbox 后端：项目行的 Code review 入口一并隐藏。 */}
        {NEOLIX_PULL_REQUESTS_INBOX_ENABLED ? (
          <SidebarIconButton
            icon={CodeReviewIcon}
            label={t("workspace:openCodeReviewFor", { value0: project.name })}
            tooltip={t("workspace:codeReview")}
            tooltipSide="top"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              // Opens the in-app inbox scoped to this project for this visit (the URL
              // override leaves the saved project filter alone) instead of leaving for GitHub.
              void navigate({ to: "/pull-requests", search: { projectId: project.id } });
            }}
          />
        ) : null}
        <SidebarIconButton
          icon={TerminalIcon}
          label={t("workspace:createNewTerminalThreadIn", { value0: project.name })}
          tooltip={
            newTerminalThreadShortcutLabel
              ? t("workspace:newTerminalThread", { value0: newTerminalThreadShortcutLabel })
              : t("workspace:sections_newTerminalThread")
          }
          tooltipSide="top"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void handleNewThread(project.id, { entryPoint: "terminal" });
          }}
        />
        <SidebarIconButton
          icon={NewThreadIcon}
          label={t("workspace:createNewThreadIn", { value0: project.name })}
          tooltip={
            newThreadShortcutLabel
              ? t("workspace:newThread", { value0: String(newThreadShortcutLabel) })
              : t("chat:sections_newThread")
          }
          tooltipSide="top"
          data-testid="new-thread-button"
          onMouseEnter={() => {
            prefetchModelsForProjectNewThread(project.id);
          }}
          onFocus={() => {
            prefetchModelsForProjectNewThread(project.id);
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            prefetchModelsForProjectNewThread(project.id, { includeDroid: true });
            void handleNewThread(project.id);
          }}
        />
      </>
    );
  }

  // A project's thread rows plus its show more/less paging. Shared by the tree's folder
  // disclosure and the rail layout's Spaces drill-in.
  function renderProjectThreadList(
    project: (typeof sortedProjects)[number],
    projectSidebarData: SidebarDerivedProjectData,
  ) {
    const {
      orderedProjectThreadIds,
      visibleEntries,
      threadListExtraPages,
      canShowMoreThreads,
      canShowLessThreads,
    } = projectSidebarData;
    const canSortThreads =
      appSettings.sidebarThreadSortOrder === "manual" && appSettings.sidebarGroupBy === "project";
    // debt: manual sorting owns the pointer gesture on a row, so HTML5 drag
    // (thread → composer mention) is unavailable while it is on. Restore it with
    // a dedicated drag handle if drag-to-mention becomes a common path.
    return (
      <>
        {canSortThreads ? (
          <DndContext
            sensors={projectDnDSensors}
            collisionDetection={projectCollisionDetection}
            modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
            onDragStart={handleThreadDragStart}
            onDragEnd={(event) => {
              handleThreadDragEnd(project.id, orderedProjectThreadIds, event);
            }}
            onDragCancel={handleThreadDragCancel}
          >
            <SortableContext
              items={visibleEntries.map((entry) => entry.thread.id)}
              strategy={verticalListSortingStrategy}
            >
              {visibleEntries.map((entry) => (
                <SortableThreadItem key={entry.thread.id} threadId={entry.thread.id}>
                  {(handleProps) =>
                    renderThreadRow(
                      entry.thread,
                      orderedProjectThreadIds,
                      false,
                      undefined,
                      handleProps,
                    )
                  }
                </SortableThreadItem>
              ))}
            </SortableContext>
          </DndContext>
        ) : (
          visibleEntries.map((entry) => renderThreadRow(entry.thread, orderedProjectThreadIds))
        )}

        {(canShowMoreThreads || canShowLessThreads) && (
          <SidebarMenuSubItem className="w-full">
            <div className="flex w-full items-center gap-1">
              {canShowMoreThreads && (
                <SidebarMenuSubButton
                  render={<button type="button" />}
                  data-thread-selection-safe
                  size="sm"
                  className="h-7 flex-1 translate-x-0 justify-start rounded-lg pr-2 pl-8 text-left text-ui text-muted-foreground/79 hover:bg-transparent hover:text-foreground active:bg-transparent active:text-foreground"
                  onMouseDown={preventFocusOnMouseDown}
                  onClick={() => {
                    showMoreThreadsForProject(project.cwd, threadListExtraPages);
                  }}
                >
                  <span>{t("workspace:timeline_showMore")}</span>
                </SidebarMenuSubButton>
              )}
              {canShowLessThreads && (
                <SidebarMenuSubButton
                  render={<button type="button" />}
                  data-thread-selection-safe
                  size="sm"
                  className={cn(
                    "h-7 translate-x-0 justify-start rounded-lg text-left text-ui text-muted-foreground/79 hover:bg-transparent hover:text-foreground active:bg-transparent active:text-foreground",
                    // Keep the left indent when "Show less" is the only affordance left.
                    canShowMoreThreads ? "w-auto flex-none px-2" : "flex-1 pr-2 pl-8",
                  )}
                  onMouseDown={preventFocusOnMouseDown}
                  onClick={() => {
                    showLessThreadsForProject(project.cwd, threadListExtraPages);
                  }}
                >
                  <span>{t("workspace:timeline_showLess")}</span>
                </SidebarMenuSubButton>
              )}
            </div>
          </SidebarMenuSubItem>
        )}
      </>
    );
  }

  // A project reads as "running" when Synara tracks a run for it or when a local server
  // (possibly started outside Synara) is attributed by cwd. Shared by the tree's project
  // header and the rail layout's Spaces rows.
  function isSidebarProjectRunning(projectId: ProjectId): boolean {
    return (
      (projectRunsByProjectId[projectId] ?? null) !== null ||
      (projectRunServerByProjectId.get(projectId) ?? null) !== null
    );
  }

  function renderProjectItem(
    project: (typeof sortedProjects)[number],
    dragHandleProps: SortableProjectHandleProps | null,
  ) {
    const isProjectPinned = pinnedProjectIdSet.has(project.id);
    const projectSidebarData = surfaceProjectSidebarDataById.get(project.id);
    if (!projectSidebarData) {
      return null;
    }
    const { allProjectThreadCount, projectStatus } = projectSidebarData;
    const projectFolderIconClassName = isProjectPinned
      ? "opacity-0"
      : sidebarHoverRevealHideClassName("project-header");
    const isProjectRunning = isSidebarProjectRunning(project.id);
    const collapsedProjectStatus = project.expanded ? null : projectStatus;
    // The "open dev server" affordance now lives in the project context menu, so
    // the hover toolbar always reserves space for the three thread actions. The
    // reserve lives on the *name* container (not the button) so only the truncating
    // name yields to the overlay toolbar; the trailing run dot stays put and fades
    // in place instead of sliding left. Focus is read from the group because the
    // name container itself is not focusable — the row's button is.
    const projectToolbarReserveClassName =
      "group-hover/project-header:pr-[4.75rem] project-header-focus:pr-[4.75rem]";
    // Configured display name only — folder identity lives in the hover card (#1000).
    const projectRowLabel = resolveSidebarProjectRowLabel(project);

    return (
      <div className="group/collapsible">
        <PreviewCard>
          <PreviewCardTrigger
            {...SIDEBAR_HOVER_CARD_TRIGGER_PROPS}
            render={
              <div
                className="group/project-header relative"
                data-project-hover-anchor={project.id}
              />
            }
          >
            <SidebarMenuButton
              ref={isManualProjectSorting ? dragHandleProps?.setActivatorNodeRef : undefined}
              size="sm"
              className={cn(
                SIDEBAR_HEADER_ROW_CLASS_NAME,
                "hover:bg-[var(--sidebar-accent)] group-hover/project-header:bg-[var(--sidebar-accent)] group-hover/project-header:text-[var(--sidebar-accent-foreground)]",
                isManualProjectSorting ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
              )}
              {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.attributes : {})}
              {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.listeners : {})}
              {...(!isManualProjectSorting && spaces.length > 0
                ? {
                    // Native drag-to-file: drop the row on a space tab to move the
                    // project. Manual sort mode is excluded because dnd-kit owns the
                    // drag gesture there for reordering.
                    draggable: true,
                    onDragStart: (event: ReactDragEvent<HTMLButtonElement>) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData(
                        PROJECT_SPACE_DRAG_MIME,
                        JSON.stringify({ projectId: project.id }),
                      );
                    },
                  }
                : {})}
              onPointerDownCapture={handleProjectTitlePointerDownCapture}
              onClick={(event) => handleProjectTitleClick(event, project.id)}
              onKeyDown={(event) => handleProjectTitleKeyDown(event, project.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                void handleProjectContextMenu(project.id, {
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
            >
              <SidebarProjectRowContent
                icon={
                  <ProjectSidebarIcon
                    cwd={project.cwd}
                    expanded={project.expanded}
                    appearance={project.appearance}
                  />
                }
                label={projectRowLabel}
                labelAccessory={
                  isProjectPinned ? (
                    <DisclosureChevron
                      open={project.expanded}
                      className={PROJECT_ROW_CHEVRON_CLASS_NAME}
                    />
                  ) : (
                    <ProjectDisclosureChevron
                      cwd={project.cwd}
                      expanded={project.expanded}
                      appearance={project.appearance}
                      className={PROJECT_ROW_CHEVRON_CLASS_NAME}
                    />
                  )
                }
                iconClassName={projectFolderIconClassName}
                reserveClassName={projectToolbarReserveClassName}
                trailing={
                  project.rootMissing ? (
                    // A moved or deleted folder cannot run anything; say so before a send fails.
                    <span
                      role="img"
                      aria-label={t("workspace:projectFolderMissing")}
                      title={t("workspace:projectFolderMissingHint")}
                      data-project-root-missing="true"
                      className={cn(
                        "ml-auto flex shrink-0 items-center self-center text-warning",
                        // The hover toolbar takes this slot; the hover card still names the path.
                        sidebarHoverRevealHideClassName("project-header"),
                      )}
                    >
                      <TriangleAlertIcon className="size-3.5" />
                    </span>
                  ) : isProjectRunning || collapsedProjectStatus ? (
                    <span
                      aria-label={
                        collapsedProjectStatus
                          ? t("workspace:projectStatus", {
                              value0: t(THREAD_STATUS_LABEL_KEYS[collapsedProjectStatus.label]),
                            })
                          : undefined
                      }
                      title={
                        collapsedProjectStatus
                          ? t(THREAD_STATUS_LABEL_KEYS[collapsedProjectStatus.label])
                          : undefined
                      }
                      className={cn(
                        "ml-auto flex min-w-[1.625rem] shrink-0 items-center justify-end gap-2 self-center",
                        sidebarHoverRevealHideClassName("project-header"),
                      )}
                    >
                      {isProjectRunning ? <ProjectRunIndicatorDot /> : null}
                      {collapsedProjectStatus ? (
                        <SidebarStatusTrailingGlyph status={collapsedProjectStatus} />
                      ) : null}
                    </span>
                  ) : null
                }
              />
            </SidebarMenuButton>
            <button
              type="button"
              aria-label={pinActionLabel(project.name, isProjectPinned)}
              aria-pressed={isProjectPinned}
              title={pinActionLabel(project.name, isProjectPinned)}
              className={cn(
                SIDEBAR_HEADER_LEADING_ACTION_CLASS_NAME,
                SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
                isProjectPinned
                  ? "pointer-events-auto opacity-100"
                  : SIDEBAR_HEADER_LEADING_ACTION_REVEAL_CLASS_NAME,
              )}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                toggleProjectPinned(project.id);
              }}
            >
              <PinStatusIcon pinned={isProjectPinned} className="size-3.5" />
            </button>
            <SidebarSectionToolbar placement="overlay" revealOnHover>
              {renderProjectThreadActions(project)}
            </SidebarSectionToolbar>
          </PreviewCardTrigger>
          {renderProjectHoverCardPopup(project, allProjectThreadCount)}
        </PreviewCard>

        <div
          className={cn(
            disclosureShellClassName(project.expanded),
            SIDEBAR_NESTED_LIST_OFFSET_CLASS_NAME,
          )}
        >
          <div className={DISCLOSURE_INNER_CLASS}>
            <SidebarMenuSub
              className={cn(
                "mx-0 my-0 w-full translate-x-0 border-l-0 px-0 py-0",
                SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
                disclosureContentClassName(project.expanded),
              )}
            >
              {renderProjectThreadList(project, projectSidebarData)}
            </SidebarMenuSub>
          </div>
        </div>
      </div>
    );
  }

  // The label-grouped replacement for the project tree. Sections are flat by design: a label
  // spans projects, so nesting rows under a project again would negate the grouping.
  function renderLabelGroupedList() {
    if (sidebarLabelGroups.length === 0) {
      return (
        <p className="px-2 py-3 text-ui text-muted-foreground/58">
          {t("workspace:labels_noMatches")}
        </p>
      );
    }
    return (
      <SidebarMenu data-testid="workspace-label-group-list" className="gap-3">
        {sidebarLabelGroups.map((group) => {
          const threadIds = group.threads.map((thread) => thread.id);
          return (
            <SidebarMenuItem key={group.key} className="rounded-md">
              {renderListSectionHeader(group.label, null)}
              <SidebarMenuSub className="mx-0 my-0 w-full translate-x-0 border-l-0 px-0 py-0">
                {group.threads.map((thread) =>
                  renderThreadRow(thread, threadIds, true, projectById.get(thread.projectId)?.name),
                )}
              </SidebarMenuSub>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    );
  }

  // Status-grouped replacement for the project tree, same flat section shape as labels.
  function renderStatusGroupedList() {
    if (sidebarStatusGroups.length === 0) {
      return (
        <p className="px-2 py-3 text-ui text-muted-foreground/58">
          {t("workspace:display_noThreads")}
        </p>
      );
    }
    return (
      <SidebarMenu data-testid="workspace-status-group-list" className="gap-3">
        {sidebarStatusGroups.map((group) => {
          const threadIds = group.threads.map((thread) => thread.id);
          return (
            <SidebarMenuItem key={group.key} className="rounded-md">
              {renderListSectionHeader(group.label, null)}
              <SidebarMenuSub className="mx-0 my-0 w-full translate-x-0 border-l-0 px-0 py-0">
                {group.threads.map((thread) =>
                  renderThreadRow(thread, threadIds, true, projectById.get(thread.projectId)?.name),
                )}
              </SidebarMenuSub>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    );
  }

  function renderWorkspaceProject(
    entry: WorkspaceProjectEntry,
    dragHandleProps: SortableProjectHandleProps | null,
  ) {
    if (!entry.session) {
      const project = projectById.get(entry.project.id);
      return project ? renderProjectItem(project, dragHandleProps) : null;
    }
    return (
      <WorkspaceProjectItem
        entry={entry}
        renderThreadHoverCard={renderRemoteThreadHoverCard}
        expanded={!collapsedWorkspaceProjects.includes(entry.key)}
        onToggle={() => {
          if (dragInProgressRef.current) return;
          if (suppressProjectClickAfterDragRef.current) {
            suppressProjectClickAfterDragRef.current = false;
            return;
          }
          clearSelection();
          toggleWorkspaceProject(entry.key);
        }}
        threadSortOrder={appSettings.sidebarThreadSortOrder}
        extraPages={workspaceProjectExtraPages.get(entry.key) ?? 0}
        onExtraPagesChange={(extraPages) =>
          setWorkspaceProjectExtraPages((current) => new Map(current).set(entry.key, extraPages))
        }
        threadJumpLabels={visibleThreadJumpLabelByKey}
        dragHandleProps={dragHandleProps}
        manualSorting={isManualProjectSorting}
      />
    );
  }

  const handleProjectTitleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (dragInProgressRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (suppressProjectClickAfterDragRef.current) {
        // Consume the synthetic click emitted after a drag release.
        suppressProjectClickAfterDragRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      toggleProject(projectId);
    },
    [clearSelection, selectedThreadIds.size, toggleProject],
  );

  const handleProjectTitleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (dragInProgressRef.current) {
        return;
      }
      toggleProject(projectId);
    },
    [toggleProject],
  );

  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (selectedThreadIds.size === 0) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      clearSelection();
    };

    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [clearSelection, selectedThreadIds.size]);

  // Reads the latest threads at key time without re-subscribing the shortcut listener on
  // every thread update. Same threads and tiers as the bell's dot, so the chord goes where
  // the dot points.
  const openNextThreadNeedingAttention = useEffectEvent(() => {
    const nextThreadId = findNextThreadNeedingAttention(
      visibleNonGroupSidebarThreads,
      activeSidebarThreadId,
      resolveActivityPriorityTierForSidebar,
    );
    if (nextThreadId) activateThreadFromSidebarIntent(nextThreadId);
  });

  useEffect(() => {
    const clearThreadJumpHints = () => {
      setThreadJumpLabelByThreadId((current) =>
        current === EMPTY_THREAD_JUMP_LABELS ? current : EMPTY_THREAD_JUMP_LABELS,
      );
      setShowThreadJumpHints(false);
    };
    const shouldIgnoreThreadJumpHintUpdate = (event: KeyboardEvent) =>
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      event.key !== "Meta" &&
      event.key !== "Control" &&
      event.key !== "Alt" &&
      event.key !== "Shift" &&
      !showThreadJumpHintsRef.current &&
      threadJumpLabelsRef.current === EMPTY_THREAD_JUMP_LABELS;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      const shortcutContext =
        (event as WorkspaceSidebarKeyboardEvent).workspaceShortcutContext ??
        getCurrentSidebarShortcutContext();
      if (!shouldIgnoreThreadJumpHintUpdate(event)) {
        const shouldShowHints = shouldShowThreadJumpHints(event, keybindings, {
          platform: navigator.platform,
          context: shortcutContext,
        });
        if (!shouldShowHints) {
          if (
            showThreadJumpHintsRef.current ||
            threadJumpLabelsRef.current !== EMPTY_THREAD_JUMP_LABELS
          ) {
            clearThreadJumpHints();
          }
        } else {
          setThreadJumpLabelByThreadId((current) => {
            const nextLabelMap = buildThreadJumpLabelMap({
              keybindings,
              platform: navigator.platform,
              terminalOpen: shortcutContext.terminalOpen,
              threadJumpCommandByThreadId,
            });
            return threadJumpLabelMapsEqual(current, nextLabelMap) ? current : nextLabelMap;
          });
          setShowThreadJumpHints(true);
        }
      }

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (command === "sidebar.search") {
        event.preventDefault();
        event.stopPropagation();
        setSearchPaletteMode("search");
        setSearchPaletteOpen((prev) => !prev || searchPaletteMode !== "search");
        return;
      }
      if (command === "sidebar.activity") {
        event.preventDefault();
        event.stopPropagation();
        const shouldOpenActivity = isOnSettings || isOnGroups || !activityViewEnabled;
        setActivityViewEnabledSmoothly(shouldOpenActivity);
        if (shouldOpenActivity && (isOnSettings || isOnGroups)) {
          handleSidebarViewChange("threads");
        }
        return;
      }
      if (command === "sidebar.addProject") {
        event.preventDefault();
        event.stopPropagation();
        setCreateProjectDialogOpen(true);
        return;
      }
      if (command === "sidebar.importThread") {
        event.preventDefault();
        event.stopPropagation();
        setSearchPaletteMode("import");
        setSearchPaletteOpen((prev) => !prev || searchPaletteMode !== "import");
        return;
      }
      if (command === "settings.usage") {
        event.preventDefault();
        event.stopPropagation();
        void navigate({
          to: "/settings",
          search: { section: "usage" },
        });
        return;
      }
      if (command === "space.previous" || command === "space.next") {
        if (!isProjectsSidebarSurface({ isOnSettings, isOnGroups })) return;
        event.preventDefault();
        event.stopPropagation();
        const orderedSpaceIds: ReadonlyArray<SpaceId | null> = [
          null,
          ...spaces.map((space) => space.id),
        ];
        const currentIndex = Math.max(0, orderedSpaceIds.indexOf(activeSpaceId));
        const offset = command === "space.previous" ? -1 : 1;
        const nextIndex = (currentIndex + offset + orderedSpaceIds.length) % orderedSpaceIds.length;
        handleSelectSpace(orderedSpaceIds[nextIndex] ?? null);
        return;
      }
      const spaceJumpIndex = spaceJumpIndexFromCommand(command ?? "");
      if (spaceJumpIndex !== null) {
        if (!isProjectsSidebarSurface({ isOnSettings, isOnGroups })) return;
        // Index 0 is Void, then spaces in strip order — the chord addresses what you see.
        const orderedSpaceIds: ReadonlyArray<SpaceId | null> = [
          null,
          ...spaces.map((space) => space.id),
        ];
        if (spaceJumpIndex >= orderedSpaceIds.length) return;
        event.preventDefault();
        event.stopPropagation();
        const targetSpaceId = orderedSpaceIds[spaceJumpIndex] ?? null;
        if (targetSpaceId !== activeSpaceId) {
          handleSelectSpace(targetSpaceId);
        }
        return;
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex !== null) {
        // The open model picker addresses its rows with the same mod+digit chord.
        if (isModelPickerShortcutScopeActive()) return;
        event.preventDefault();
        event.stopPropagation();
        const threadJumpTargetId = threadJumpThreadIds[jumpIndex];
        if (threadJumpTargetId) {
          activateWorkspaceThread(threadJumpTargetId);
        }
        return;
      }
      if (command === "chat.attention.next") {
        event.preventDefault();
        event.stopPropagation();
        openNextThreadNeedingAttention();
        return;
      }
      if (command !== "chat.visible.next" && command !== "chat.visible.previous") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const nextThreadId = getNextVisibleSidebarThreadId({
        visibleThreadIds: visibleWorkspaceThreadKeys,
        activeThreadId: activeWorkspaceThreadKey,
        direction: command === "chat.visible.previous" ? "backward" : "forward",
      });
      if (nextThreadId && nextThreadId !== activeWorkspaceThreadKey) {
        activateWorkspaceThread(nextThreadId);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (shouldIgnoreThreadJumpHintUpdate(event)) {
        return;
      }
      const shortcutContext =
        (event as WorkspaceSidebarKeyboardEvent).workspaceShortcutContext ??
        getCurrentSidebarShortcutContext();
      const shouldShowHints = shouldShowThreadJumpHints(event, keybindings, {
        platform: navigator.platform,
        context: shortcutContext,
      });
      if (!shouldShowHints) {
        clearThreadJumpHints();
        return;
      }
      setThreadJumpLabelByThreadId((current) => {
        const nextLabelMap = buildThreadJumpLabelMap({
          keybindings,
          platform: navigator.platform,
          terminalOpen: shortcutContext.terminalOpen,
          threadJumpCommandByThreadId,
        });
        return threadJumpLabelMapsEqual(current, nextLabelMap) ? current : nextLabelMap;
      });
      setShowThreadJumpHints(true);
    };
    const onWindowBlur = () => {
      clearThreadJumpHints();
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [
    activateThreadFromSidebarIntent,
    activeSidebarThreadId,
    visualActiveSidebarThreadId,
    activeSpaceId,
    activityViewEnabled,
    handleSelectSpace,
    handleSidebarViewChange,
    keybindings,
    getCurrentSidebarShortcutContext,
    homeDir,
    isOnSettings,
    isOnGroups,
    navigate,
    searchPaletteMode,
    setActivityViewEnabledSmoothly,
    setCreateProjectDialogOpen,
    spaces,
    threadJumpCommandByThreadId,
    threadJumpThreadIds,
    visibleWorkspaceThreadKeys,
    activeWorkspaceThreadKey,
    activateWorkspaceThread,
  ]);

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setDesktopUpdateState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        setDesktopUpdateState(nextState);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  // Single entry point for update error toasts. Attaches the manual-download
  // fallback (copy link + "Download manually") whenever a release URL is known,
  // and dedupes by error signature so the same failure is not toasted twice.
  const surfaceDesktopUpdateError = useCallback(
    (input: { title: string; description: string; state: DesktopUpdateState | null }) => {
      const signature = getDesktopUpdateErrorSignature(input.state) ?? `adhoc:${input.description}`;
      if (lastDesktopUpdateErrorToastSignatureRef.current === signature) {
        return;
      }
      lastDesktopUpdateErrorToastSignatureRef.current = signature;
      const releaseUrl = input.state?.releaseUrl ?? null;
      const recommendManualDownload = shouldRecommendManualDesktopDownload(input.state);
      const fallbackProps = releaseUrl
        ? {
            data: { copyText: releaseUrl },
            actionProps: {
              children: t("workspace:downloadManually"),
              onClick: () => {
                void window.desktopBridge?.openExternal(releaseUrl);
              },
            },
          }
        : {};
      toastManager.add({
        type: "error",
        title: recommendManualDownload ? t("workspace:downloadTheUpdateManually") : input.title,
        description: recommendManualDownload
          ? t("workspace:automaticInstallationHasFailedTimesDownloadManuallyToFinish", {
              value0: input.state?.installFailureCount ?? 0,
              value1: input.state?.availableVersion ?? t("workspace:theUpdate"),
            })
          : input.description,
        ...fallbackProps,
      });
    },
    [t],
  );

  // The install watchdog (and any background-pushed failure) flips the update
  // state to a download/install error without going through a click handler, so
  // the fallback must also be surfaced reactively here. Dedup keeps it from
  // doubling up with the click-handler toast for user-initiated failures.
  useEffect(() => {
    if (!getDesktopUpdateErrorSignature(desktopUpdateState)) {
      // Returning to any non-error state (new download, success, up-to-date)
      // clears the dedup key so the next distinct failure notifies again.
      lastDesktopUpdateErrorToastSignatureRef.current = null;
      return;
    }
    if (!desktopUpdateState?.releaseUrl) {
      return;
    }
    surfaceDesktopUpdateError({
      title:
        desktopUpdateState.errorContext === "install"
          ? t("workspace:couldnTFinishUpdating")
          : t("workspace:couldnTDownloadTheUpdate"),
      description:
        desktopUpdateState.message ?? t("workspace:theInAppUpdateCouldNotCompleteYouCan"),
      state: desktopUpdateState,
    });
  }, [desktopUpdateState, surfaceDesktopUpdateError, t]);

  // Install failures deliberately preserve "downloaded" so the same artifact
  // can be retried. Watch the error as well as the status to release the latch.
  useEffect(() => {
    if (
      desktopUpdateState?.status !== "downloaded" ||
      desktopUpdateState.errorContext === "install"
    ) {
      setInstallingDesktopUpdate(false);
    }
  }, [desktopUpdateState?.status, desktopUpdateState?.errorContext]);

  // The desktop preload exposes the Neox updater when Electron runs the web UI;
  // plain browsers keep the rail entry hidden.
  const desktopShellSettingsQuery = useQuery({
    queryKey: DESKTOP_SHELL_SETTINGS_QUERY_KEY,
    queryFn: getDesktopShellSettings,
    enabled: isElectron && desktopShellAvailable(),
    staleTime: 60_000,
  });
  const hideDesktopUpdatePill = desktopShellSettingsQuery.data?.noUpdatePill === true;
  const desktopUpdatesEnabled =
    isElectron &&
    typeof window.desktopBridge?.getUpdateState === "function" &&
    typeof window.desktopBridge?.onUpdateState === "function";
  const showDesktopUpdateButton =
    desktopUpdatesEnabled &&
    isElectron &&
    !hideDesktopUpdatePill &&
    shouldShowDesktopUpdateButton(desktopUpdateState);
  const isBetaDesktopFlavor = desktopUpdateState?.flavor === "beta";

  const desktopUpdateButtonDisabled =
    isDesktopUpdateButtonDisabled(desktopUpdateState) || installingDesktopUpdate;
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const searchPaletteProjects = useMemo<SidebarSearchProject[]>(
    () =>
      projects.map((project) => ({
        id: project.id,
        name: project.name,
        remoteName: project.remoteName,
        folderName: project.folderName,
        localName: project.localName,
        appearance: project.appearance ?? null,
        cwd: project.cwd,
        // Containers (Chats, Groups) are reachable from every Space, so they search as "Global".
        spaceName: isOrdinarySpaceProject(project, {
          homeDir,
          chatWorkspaceRoot,
          studioWorkspaceRoot,
        })
          ? spaceDisplayName(project.spaceId, spaces, voidSpace, t)
          : "Global",
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      })),
    [chatWorkspaceRoot, homeDir, projects, spaces, studioWorkspaceRoot, voidSpace, t],
  );
  const searchPaletteActions = useMemo<SidebarSearchAction[]>(
    () => [
      {
        id: "new-chat",
        // Shares the shortcut sheet's labels so the two "new" commands stay distinguishable
        // ("choose a project first" vs "in the current project") in every language.
        label: t("shortcuts:chatNewChatLabel"),
        description: t("workspace:openTheNewChatLandingScreen"),
        keywords: ["chat", "new", "home"],
        shortcutLabel: newChatShortcutLabel,
      },
      {
        id: "new-thread",
        label: t("shortcuts:chatNewLabel"),
        description: t("workspace:startAFreshThreadInTheCurrentOrMost"),
        keywords: ["thread", "new", "project"],
        shortcutLabel: newThreadShortcutLabel,
      },
      {
        id: "add-project",
        label: t("workspace:sections_addProject"),
        description: t("workspace:searchPalette_addProjectDescription"),
        keywords: ["folder", "repo", "repository", "open"],
        shortcutLabel: addProjectShortcutLabel,
        run: handleStartAddProject,
      },
      {
        id: "import-projects",
        label: t("workspace:importProjectsFrom"),
        description: t("workspace:bringCodexAndClaudeCodeProjectsAndConversationsInto"),
        keywords: ["import", "projects", "codex", "claude", "conversations", "folders"],
      },
      {
        id: "import-thread",
        label: t("workspace:importThreadFrom"),
        description: t("workspace:searchPalette_importThreadDescription"),
        keywords: [
          "import",
          "resume",
          "thread",
          "session",
          "codex",
          "claude",
          "cursor",
          "opencode",
        ],
        shortcutLabel: importThreadShortcutLabel,
      },
      {
        id: "settings",
        label: t("workspace:toast_settings"),
        description: t("workspace:searchPalette_settingsDescription"),
        keywords: ["preferences", "config"],
      },
      {
        id: "usage-settings",
        label: t("workspace:searchPalette_usageSettings"),
        description: t("workspace:searchPalette_usageSettingsDescription"),
        keywords: ["usage", "limits", "credits", "quota", "providers"],
        shortcutLabel: usageSettingsShortcutLabel,
      },
      // Space jumps ride the palette so keyboard users can reach any space by name
      // without learning the previous/next-space chords.
      ...(spaces.length > 0
        ? [
            {
              id: "switch-space-void",
              label: t("workspace:switchTo", { value0: voidSpace.name }),
              description: t("workspace:jumpToUnassignedProjects"),
              // "void" stays a keyword after a rename: it is what the palette answered to
              // before, and it is still the only word for this group in the docs.
              keywords: ["space", "switch", "void", "unassigned", voidSpace.name],
              requiresQuery: true,
              run: () => handleSelectSpace(null),
              icon: ({ className }: { className?: string }) => (
                <SpaceIcon icon={voidSpace.icon} className={className} />
              ),
            } satisfies SidebarSearchAction,
          ]
        : []),
      ...spaces.map(
        (space) =>
          ({
            id: `switch-space-${space.id}`,
            label: t("workspace:switchTo", { value0: space.name }),
            description: t("workspace:jumpToThisSpaceAndRestoreItsLastContext"),
            keywords: ["space", "switch", space.name],
            requiresQuery: true,
            run: () => handleSelectSpace(space.id),
            icon: ({ className }: { className?: string }) => (
              <SpaceIcon icon={space.icon} className={className} />
            ),
          }) satisfies SidebarSearchAction,
      ),
      // Neox 无 Space 元数据后端：命令面板不提供新建 Space。
      ...(NEOLIX_SPACE_EDITING_UI_ENABLED
        ? [
            {
              id: "new-space",
              label: t("workspace:newSpace"),
              description: t("workspace:groupProjectsIntoAFocusedWorkContext"),
              keywords: ["space", "create", "new", "group", "workspace"],
              run: () => openSpaceCreator(),
              icon: AddPlusIcon,
            } satisfies SidebarSearchAction,
          ]
        : []),
    ],
    [
      addProjectShortcutLabel,
      handleSelectSpace,
      handleStartAddProject,
      importThreadShortcutLabel,
      newChatShortcutLabel,
      newThreadShortcutLabel,
      openSpaceCreator,
      spaces,
      usageSettingsShortcutLabel,
      voidSpace,
      t,
    ],
  );

  // Current-workspace commands for the palette: panels, tabs, split panes, pin and
  // layout toggles. Rebuilt from the same stores/handlers the UI already uses, so a
  // palette row can never drift from what the button next to it does.
  const workspacePaletteActions = useMemo<SidebarSearchAction[]>(
    () =>
      buildWorkspacePaletteActions({
        activeThreadId: activeSidebarThreadId,
        activeProjectId: activeRouteProjectId,
        isProjectPinned:
          activeRouteProjectId !== null && pinnedProjectIdSet.has(activeRouteProjectId),
        openThreadTabIds,
        onTogglePinProject: (projectId) => {
          window.dispatchEvent(
            new CustomEvent(WORKSPACE_TOGGLE_PIN_PROJECT_EVENT, { detail: { projectId } }),
          );
        },
        onToggleLeftSidebar: toggleSidebar,
        onActivateThreadTab: (threadId) => {
          void activateThreadTab(threadId);
        },
        onRenameActiveThread: () => {
          window.dispatchEvent(new Event(WORKSPACE_RENAME_ACTIVE_TAB_EVENT));
        },
        onCloseActiveThreadTab: () => {
          window.dispatchEvent(new Event(WORKSPACE_CLOSE_ACTIVE_TAB_EVENT));
        },
        onOpenSplitView: (splitViewId, threadId) => {
          void navigate({
            to: "/$threadId",
            params: { threadId },
            search: (previous) => ({ ...previous, splitViewId }),
          });
        },
      }),
    [
      activeRouteProjectId,
      activeSidebarThreadId,
      activateThreadTab,
      navigate,
      openThreadTabIds,
      pinnedProjectIdSet,
      toggleSidebar,
    ],
  );

  const handleDesktopUpdateButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (desktopUpdateButtonDisabled || desktopUpdateButtonAction === "none") return;

    if (desktopUpdateButtonAction === "open-release") {
      if (desktopUpdateState.releaseUrl) {
        void bridge.openExternal(desktopUpdateState.releaseUrl);
      }
      return;
    }

    // Keep the sidebar action as the single visible entry point for manual checks.
    if (desktopUpdateButtonAction === "check") {
      void bridge
        .checkForUpdates()
        .then((nextState) => {
          setInstallingDesktopUpdate(false);
          setDesktopUpdateState(nextState);
          if (resolveDesktopUpdateButtonAction(nextState) === "open-release") {
            const releaseUrl = nextState.releaseUrl ?? "";
            toastManager.add({
              type: "info",
              title: t("settings:updateAvailable"),
              description: getDesktopUpdateButtonTooltip(nextState),
              data: { copyText: releaseUrl },
              actionProps: {
                children: t("workspace:downloadManually"),
                onClick: () => {
                  void bridge.openExternal(releaseUrl);
                },
              },
            });
            return;
          }
          if (nextState.status === "available") {
            toastManager.add({
              type: "info",
              title: t("workspace:desktopUpdate_preparingUpdate"),
              description: t("workspace:synaraIsPreparingVersionInTheBackground", {
                value0: nextState.availableVersion ?? t("chat:available2"),
              }),
            });
            return;
          }

          if (nextState.status === "downloading") {
            toastManager.add({
              type: "info",
              title: t("workspace:desktopUpdate_preparingUpdate"),
              description: t("workspace:desktopUpdate_downloadingUpdateDescription"),
            });
            return;
          }

          if (nextState.status === "downloaded") {
            toastManager.add({
              type: "success",
              title: t("workspace:desktopUpdate_updateReady"),
              description: t("workspace:clickUpdateWhenYouReReadyToRestartAnd"),
            });
            return;
          }

          if (nextState.status === "up-to-date") {
            toastManager.add({
              type: "info",
              title: t("workspace:youReUpToDate"),
              description: t("workspace:synaraIsAlreadyTheNewestVersion", {
                value0: nextState.currentVersion,
              }),
            });
            return;
          }

          if (nextState.status === "error") {
            surfaceDesktopUpdateError({
              title: t("workspace:desktopUpdate_couldNotCheckForUpdates"),
              description: nextState.message ?? t("workspace:desktopUpdate_unexpectedError"),
              state: nextState,
            });
          }
        })
        .catch((error) => {
          surfaceDesktopUpdateError({
            title: t("workspace:desktopUpdate_couldNotCheckForUpdates"),
            description:
              error instanceof Error ? error.message : t("workspace:desktopUpdate_unexpectedError"),
            state: desktopUpdateState,
          });
        });
      return;
    }

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          setInstallingDesktopUpdate(false);
          setDesktopUpdateState(result.state);
          if (result.completed) {
            toastManager.add({
              type: "success",
              title: t("workspace:desktopUpdate_updateReady"),
              description: t("workspace:clickUpdateWhenYouReReadyToRestartAnd"),
            });
          }
          const alreadyCurrentNotice = getDesktopUpdateAlreadyCurrentNotice(result);
          if (alreadyCurrentNotice) {
            toastManager.add({
              type: "info",
              title: t("git:providerUpdates_unchanged"),
              description: alreadyCurrentNotice,
            });
            return;
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          surfaceDesktopUpdateError({
            title: t("workspace:desktopUpdate_couldNotDownloadUpdate"),
            description: actionError,
            state: result.state,
          });
        })
        .catch((error) => {
          surfaceDesktopUpdateError({
            title: t("workspace:couldNotStartUpdateDownload"),
            description:
              error instanceof Error ? error.message : t("workspace:desktopUpdate_unexpectedError"),
            state: desktopUpdateState,
          });
        });
      return;
    }

    if (desktopUpdateButtonAction === "install") {
      setInstallingDesktopUpdate(true);
      persistAppStateNow();
      void bridge
        .installUpdate()
        .then((result) => {
          setDesktopUpdateState(result.state);
          if (!isDesktopUpdateInstallInFlight(result)) {
            setInstallingDesktopUpdate(false);
          }
          const alreadyCurrentNotice = getDesktopUpdateAlreadyCurrentNotice(result);
          if (alreadyCurrentNotice) {
            toastManager.add({
              type: "info",
              title: t("git:providerUpdates_unchanged"),
              description: alreadyCurrentNotice,
            });
            return;
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          surfaceDesktopUpdateError({
            title: t("workspace:desktopUpdate_couldNotInstallUpdate"),
            description: actionError,
            state: result.state,
          });
        })
        .catch((error) => {
          setInstallingDesktopUpdate(false);
          surfaceDesktopUpdateError({
            title: t("workspace:desktopUpdate_couldNotInstallUpdate"),
            description:
              error instanceof Error ? error.message : t("workspace:desktopUpdate_unexpectedError"),
            state: desktopUpdateState,
          });
        });
    }
  }, [
    desktopUpdateButtonAction,
    desktopUpdateButtonDisabled,
    desktopUpdateState,
    surfaceDesktopUpdateError,
    t,
  ]);

  // Both handlers step from the *effective* (clamped) page count reported by the derived
  // project data, so stale/oversized stored paging self-heals on the very next click.
  const setThreadListExtraPagesForProject = useCallback(
    (projectCwd: string, nextExtraPages: number) => {
      const cwdKey = normalizeSidebarProjectThreadListCwd(projectCwd);
      if (cwdKey.length === 0) return;
      setThreadListExtraPagesByProjectCwd((current) => {
        const clampedExtraPages = Math.max(0, nextExtraPages);
        if ((current.get(cwdKey) ?? 0) === clampedExtraPages) return current;
        const next = new Map(current);
        if (clampedExtraPages === 0) {
          next.delete(cwdKey);
        } else {
          next.set(cwdKey, clampedExtraPages);
        }
        return next;
      });
    },
    [],
  );

  const showMoreThreadsForProject = useCallback(
    (projectCwd: string, currentExtraPages: number) => {
      setThreadListExtraPagesForProject(projectCwd, currentExtraPages + 1);
    },
    [setThreadListExtraPagesForProject],
  );

  const showLessThreadsForProject = useCallback(
    (projectCwd: string, currentExtraPages: number) => {
      setThreadListExtraPagesForProject(projectCwd, currentExtraPages - 1);
    },
    [setThreadListExtraPagesForProject],
  );

  const handleToggleProjects = useCallback(() => {
    if (allProjectsExpanded) {
      collapseProjectsExcept(focusedProjectId);
      setCollapsedWorkspaceProjects(remoteProjects.map((entry) => entry.key));
      return;
    }
    setAllProjectsExpanded(true);
    setCollapsedWorkspaceProjects([]);
  }, [
    allProjectsExpanded,
    collapseProjectsExcept,
    focusedProjectId,
    setAllProjectsExpanded,
    remoteProjects,
    setCollapsedWorkspaceProjects,
  ]);

  const betaBadge = isBetaDesktopFlavor ? (
    <span
      aria-label="Neox Beta"
      className="inline-flex shrink-0 items-center rounded-full bg-[var(--beta-pill)] px-1.5 py-0.5 text-ui-xs font-semibold leading-none text-[var(--beta-pill-ink)]"
    >
      {t("workspace:beta")}
    </span>
  ) : null;

  const sidebarHelpMenuProps = {
    onOpenShortcuts: () => void navigate({ to: "/settings", search: { section: "shortcuts" } }),
  };
  // Navigation destinations moved out of the rail; the panel keeps only New thread.
  const pluginCommandActions = usePluginCommandActions();
  const pluginThemeActions = usePluginThemeActions();
  // Switching activity / Groups replays the surface enter animation.
  const sidebarSurfaceKey = isOnGroups ? "groups" : activityViewEnabled ? "activity" : "threads";
  const relocateProjectDialogProject = relocateProjectDialogId
    ? (projectById.get(relocateProjectDialogId) ?? null)
    : null;
  const editProjectDialogProject = editProjectDialog
    ? (projectById.get(editProjectDialog.projectId) ?? null)
    : null;
  const projectAgentDialogProject = projectAgentDialogState
    ? (projectById.get(projectAgentDialogState.projectId) ?? null)
    : null;
  const projectContextMenuProject = projectContextMenuState
    ? (projectById.get(projectContextMenuState.projectId) ?? null)
    : null;
  const projectContextMenuThreads = useMemo(
    () =>
      projectContextMenuState
        ? displaySidebarThreads.filter(
            (thread) => thread.projectId === projectContextMenuState.projectId,
          )
        : [],
    [displaySidebarThreads, projectContextMenuState],
  );
  const projectContextMenuAnchor = useMemo(
    () =>
      projectContextMenuState
        ? createClientPointMenuAnchor(projectContextMenuState.position)
        : null,
    [projectContextMenuState],
  );
  const projectContextMenuHasAnyThreads = projectContextMenuThreads.length > 0;
  const projectContextMenuHasArchivableThreads = projectContextMenuThreads.some(
    (thread) => thread.archivedAt == null,
  );
  const projectContextMenuIsPinned = projectContextMenuProject
    ? pinnedProjectIdSet.has(projectContextMenuProject.id)
    : false;
  const projectContextMenuIsRunning = projectContextMenuProject
    ? Boolean(projectRunsByProjectId[projectContextMenuProject.id])
    : false;
  const projectContextMenuRun = projectContextMenuProject
    ? (projectRunsByProjectId[projectContextMenuProject.id] ?? null)
    : null;
  const projectContextMenuServer = projectContextMenuProject
    ? (projectRunServerByProjectId.get(projectContextMenuProject.id) ?? null)
    : null;
  const projectContextMenuUrlRoutes = projectContextMenuRun?.urls ?? [];
  const projectContextMenuHasOpenServer =
    (projectContextMenuRun !== null &&
      preferredDevServerUrl(
        projectContextMenuRun,
        projectContextMenuProject
          ? devServerRouteByProjectId[projectContextMenuProject.id]
          : undefined,
      ) !== null) ||
    (projectContextMenuServer !== null && firstLocalServerUrl(projectContextMenuServer) !== null);
  const projectContextMenuCanViewTerminal = Boolean(projectContextMenuRun?.terminalId);

  return (
    <>
      <div className={isMobile ? "flex min-h-0 min-w-0 flex-1 flex-col" : "contents"}>
        {/* Title row and primary actions stay put; only the list below them scrolls. */}
        <div data-sidebar="header-fixed" className="shrink-0 font-system-ui">
          <div
            // The panel has no header above it, so the title row gets breathing room from
            // the panel's top edge. pt-1.5 puts the title's cap height as far from the top
            // edge as its first letter is from the side.
            className="flex items-center gap-1 pt-1.5 pb-1 pr-2.5 pl-1.5"
          >
            <SidebarSurfacePicker
              views={["threads", ...(groupsSectionVisible ? (["groups"] as const) : [])]}
              activeView={isOnGroups ? "groups" : "threads"}
              onSelectView={handleSidebarViewChange}
              onPrewarmView={prewarmSidebarViewTarget}
            />
            <div className="ml-auto flex items-center gap-1.5">
              <SidebarIconButton
                icon={SearchIcon}
                label={t("workspace:primaryActions_search")}
                glyph="leading"
                size="header"
                tooltip={
                  searchShortcutLabel
                    ? t("workspace:search", { value0: searchShortcutLabel })
                    : t("workspace:primaryActions_search")
                }
                tooltipSide="bottom"
                onClick={() => {
                  setSearchPaletteOpen(true);
                }}
              />
              {!isOnGroups ? (
                <SidebarActivityBellButton
                  active={activityViewEnabled}
                  showUnreadDot={hasUnreadActivity}
                  shortcutLabel={activityShortcutLabel}
                  onClick={() => setActivityViewEnabledSmoothly(!activityViewEnabled)}
                />
              ) : null}
              {betaBadge}
            </div>
          </div>
          {/* Primary sidebar actions stay limited to features we currently ship. */}
          {!isOnGroups ? (
            <SidebarGroup className="px-1.5 pt-1 pb-1.5">
              <SidebarMenu className="gap-0.5">
                <SidebarPrimaryAction
                  icon={newThreadNavDescriptor.icon}
                  {...(newThreadNavDescriptor.iconClassName
                    ? { iconClassName: newThreadNavDescriptor.iconClassName }
                    : {})}
                  label={newThreadNavDescriptor.label}
                  active={newThreadNavDescriptor.active}
                  badge={newThreadNavDescriptor.badge}
                  onClick={newThreadNavDescriptor.onClick}
                  {...(newThreadNavDescriptor.onMouseEnter
                    ? { onMouseEnter: newThreadNavDescriptor.onMouseEnter }
                    : {})}
                  {...(newThreadNavDescriptor.onFocus
                    ? { onFocus: newThreadNavDescriptor.onFocus }
                    : {})}
                />
                <PluginSidebarItems section="header" />
                <PluginSidebarItems section="footer" />
              </SidebarMenu>
            </SidebarGroup>
          ) : null}
        </div>
        <SidebarContent ref={setSidebarContentElement} className="gap-0 font-system-ui">
          {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
            <SidebarGroup className="px-2 pt-2 pb-0">
              <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8">
                <TriangleAlertIcon />
                <AlertTitle>{t("workspace:arm_intelBuildTitle")}</AlertTitle>
                <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
                {desktopUpdateButtonAction !== "none" ? (
                  <AlertAction>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={desktopUpdateButtonDisabled}
                      onClick={handleDesktopUpdateButtonClick}
                    >
                      {desktopUpdateButtonAction === "download"
                        ? t("workspace:arm_preparingBuild")
                        : desktopUpdateButtonAction === "install"
                          ? t("workspace:arm_updateBuild")
                          : desktopUpdateButtonAction === "open-release"
                            ? t("workspace:downloadManually")
                            : t("workspace:arm_checkForUpdate")}
                    </Button>
                  </AlertAction>
                ) : null}
              </Alert>
            </SidebarGroup>
          ) : null}
          {/* The keyed content remounts with a short enter animation while the picker
                stays mounted so its thumb can glide between Projects and Groups. */}
          <div key={sidebarSurfaceKey} className="sidebar-surface-enter">
            {isOnGroups ? (
              <SidebarGroupsSurface
                groupProjects={groupProjects}
                remoteProjects={remoteGroupProjects.map((entry) => (
                  <SidebarMenuItem key={entry.key}>
                    {renderWorkspaceProject(entry, null)}
                  </SidebarMenuItem>
                ))}
                projectSidebarDataById={groupProjectSidebarDataById}
                threadsHydrated={threadsHydrated}
                visualActiveThreadId={visualActiveSidebarThreadId}
                threadSortMenuProps={threadSortMenuProps}
                renderThreadRow={renderThreadRow}
                renderListSectionHeader={renderListSectionHeader}
                renderPinnedThreadsSection={renderPinnedThreadsSection}
                onOpenThread={activateThreadFromSidebarIntent}
                onOpenGroupSettings={(projectId, mode, options) => {
                  setProjectAgentDialogState({ projectId, mode, ...options });
                }}
                onProjectContextMenu={handleProjectContextMenu}
              />
            ) : activityViewEnabled ? (
              <SidebarGroup className="px-1.5 py-1.5">
                <SidebarActivityView
                  threads={activityThreads}
                  projectById={activityProjectById}
                  externalRows={externalActivityRows}
                  activeThreadId={activityActiveThreadId}
                  pinnedThreadIdSet={activityPinnedThreadIdSet}
                  visualActiveThreadId={activityVisualActiveThreadId}
                  settledOverrideByThreadId={activitySettledOverrideByThreadId}
                  threadsHydrated={threadsHydrated}
                  scopeSelection={activityScope}
                  onScopeSelectionChange={setActivityScope}
                  groupMode={activityGroupMode}
                  onChangeGroupMode={setActivityGroupMode}
                  resolveThreadStatus={resolveThreadStatusForSidebar}
                  onOpenThread={activateThreadFromSidebarIntent}
                  onOpenThreadPullRequest={openThreadPullRequest}
                  onSetThreadSettled={setThreadSettledWithToast}
                  onReturnSnoozedThread={(threadId) => setThreadSnoozedUntil(threadId, null)}
                  onToggleThreadPinned={toggleThreadPinned}
                  onArchiveThread={(threadId) => void archiveThreadWithUndo(threadId)}
                  onMarkThreadRead={markThreadVisited}
                  onRenameThread={openRenameThreadDialog}
                  onThreadRenamePointerUp={handleThreadRenamePointerUp}
                  onThreadContextMenu={(threadId, position) => {
                    void handleThreadContextMenu(threadId, position);
                  }}
                  onProjectContextMenu={handleProjectContextMenu}
                  prByThreadId={prByThreadId}
                  threadJumpLabelByThreadId={activityThreadJumpLabelByThreadId}
                  onVisibleThreadIdsChange={handleWorkspaceActivityVisibleThreadIdsChange}
                  renderThreadHoverCard={(thread, anchorId) =>
                    renderThreadHoverCardPopup(
                      thread,
                      anchorId,
                      activityActiveThreadId === thread.id,
                    )
                  }
                  onCreateChat={handlePrimaryNewThread}
                  onAddProject={handleStartAddProject}
                />
              </SidebarGroup>
            ) : (
              <SidebarGroup className="px-1.5 py-1.5">
                <SpaceSwitcher
                  spaces={spaces}
                  activeSpaceId={activeSpaceId}
                  activityBySpaceId={spaceActivityById}
                  voidSpace={voidSpace}
                  onSelect={handleSelectSpace}
                  onCreate={() => openSpaceCreator()}
                  onEdit={(space) => openSpaceEditor(space.id)}
                  onDelete={(space) => void handleDeleteSpace(space.id)}
                  onReorder={handleReorderSpaces}
                  onRenameSpace={(space, name) => void handleRenameSpace(space, name)}
                  onEditVoid={openVoidEditor}
                  onRenameVoid={handleRenameVoid}
                  onResetVoid={resetVoidSpace}
                  onDropProject={(projectId, spaceId) =>
                    void handleMoveProjectToSpace(projectId, spaceId)
                  }
                  jumpShortcutLabelForTab={jumpShortcutLabelForSpaceTab}
                />
                {renderPinnedThreadsSection()}
                {renderListSectionHeader(
                  appSettings.sidebarGroupBy === "label"
                    ? t("workspace:labels_groupByLabel")
                    : appSettings.sidebarGroupBy === "status"
                      ? t("workspace:display_groupStatus")
                      : t("workspace:sections_projects"),
                  <>
                    {workspaceProjects.length > 0 ? (
                      <SidebarIconButton
                        icon={allProjectsExpanded ? CollapseAllIcon : ExpandAllIcon}
                        label={
                          allProjectsExpanded
                            ? focusedProjectId
                              ? t("workspace:collapseAllProjectsExceptTheActiveProject")
                              : t("workspace:collapse_collapseAllProjects")
                            : t("workspace:collapse_expandAllProjects")
                        }
                        className="disabled:cursor-default disabled:opacity-45"
                        onClick={handleToggleProjects}
                        tooltip={
                          allProjectsExpanded
                            ? focusedProjectId
                              ? t("workspace:collapseAllProjectsExceptTheActiveChatSProject")
                              : t("workspace:collapse_collapseAllProjects")
                            : t("workspace:collapse_expandAllProjects")
                        }
                        tooltipSide="bottom"
                      />
                    ) : null}
                    <SidebarDisplayOptionsMenu
                      groupBy={appSettings.sidebarGroupBy}
                      onGroupByChange={(next) => updateSettings({ sidebarGroupBy: next })}
                      threadSortOrder={threadSortMenuProps.threadSortOrder}
                      onThreadSortOrderChange={threadSortMenuProps.onThreadSortOrderChange}
                      threadAttentionFirst={threadSortMenuProps.threadAttentionFirst}
                      onThreadAttentionFirstChange={
                        threadSortMenuProps.onThreadAttentionFirstChange
                      }
                      projectSortOrder={appSettings.sidebarProjectSortOrder}
                      onProjectSortOrderChange={(sortOrder) => {
                        updateSettings({ sidebarProjectSortOrder: sortOrder });
                      }}
                      titleSource={appSettings.sidebarTitleSource}
                      onTitleSourceChange={(next) => updateSettings({ sidebarTitleSource: next })}
                      rowItems={appSettings.sidebarRowItems}
                      onToggleRowItem={(item) =>
                        updateSettings({
                          sidebarRowItems: {
                            ...appSettings.sidebarRowItems,
                            [item]: !appSettings.sidebarRowItems[item],
                          },
                        })
                      }
                      trailing={appSettings.sidebarThreadTrailing}
                      onTrailingChange={(next) => updateSettings({ sidebarThreadTrailing: next })}
                      labels={neolixWorkspaceLabelsQuery.data?.labels ?? []}
                      selectedLabels={appSettings.sidebarLabelFilter}
                      onToggleLabel={(name) => {
                        const current = appSettings.sidebarLabelFilter;
                        const exists = current.some(
                          (entry) => entry.toLowerCase() === name.toLowerCase(),
                        );
                        updateSettings({
                          sidebarLabelFilter: exists
                            ? current.filter((entry) => entry.toLowerCase() !== name.toLowerCase())
                            : [...current, name],
                        });
                      }}
                      onClearLabelFilter={() => updateSettings({ sidebarLabelFilter: [] })}
                      onManageLabels={() => setLabelsDialogOpen(true)}
                      hosts={sidebarDisplayHosts}
                      hostFilters={appSettings.sidebarHostFilters}
                      onToggleHost={(id) => {
                        const current = appSettings.sidebarHostFilters;
                        updateSettings({
                          sidebarHostFilters: current.includes(id)
                            ? current.filter((entry) => entry !== id)
                            : [...current, id],
                        });
                      }}
                      onClearHostFilters={() => updateSettings({ sidebarHostFilters: [] })}
                      projects={sidebarDisplayProjects}
                      projectFilters={appSettings.sidebarProjectFilters}
                      onToggleProject={(key) => {
                        const current = appSettings.sidebarProjectFilters;
                        updateSettings({
                          sidebarProjectFilters: current.includes(key)
                            ? current.filter((entry) => entry !== key)
                            : [...current, key],
                        });
                      }}
                      onClearProjectFilters={() => updateSettings({ sidebarProjectFilters: [] })}
                    />
                    <SidebarIconButton
                      icon={AddPlusIcon}
                      label={t("workspace:sections_addProject")}
                      onClick={handleStartAddProject}
                      tooltip={t("workspace:sections_addProject")}
                      tooltipSide="right"
                    />
                  </>,
                )}

                {appSettings.sidebarGroupBy === "status" ? (
                  renderStatusGroupedList()
                ) : appSettings.sidebarGroupBy === "label" ? (
                  renderLabelGroupedList()
                ) : isManualProjectSorting ? (
                  <DndContext
                    sensors={projectDnDSensors}
                    collisionDetection={projectCollisionDetection}
                    modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
                    onDragStart={handleProjectDragStart}
                    onDragEnd={handleProjectDragEnd}
                    onDragCancel={handleProjectDragCancel}
                  >
                    <SidebarMenu data-testid="workspace-project-list" className="gap-3">
                      <SortableContext
                        items={workspaceProjects.map((entry) => entry.key)}
                        strategy={verticalListSortingStrategy}
                      >
                        {workspaceProjects.map((entry) => (
                          <SortableProjectItem key={entry.key} projectId={entry.key}>
                            {(dragHandleProps) => renderWorkspaceProject(entry, dragHandleProps)}
                          </SortableProjectItem>
                        ))}
                      </SortableContext>
                    </SidebarMenu>
                  </DndContext>
                ) : (
                  <SidebarMenu
                    data-testid="workspace-project-list"
                    ref={attachProjectListAutoAnimateRef}
                    className="gap-3"
                  >
                    {workspaceProjects.map((entry) => (
                      <SidebarMenuItem key={entry.key} className="rounded-md">
                        {renderWorkspaceProject(entry, null)}
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                )}

                {projectEmptyState === "loading" && (
                  <div
                    className="space-y-2 px-2 pt-4"
                    aria-live="polite"
                    aria-label={t("workspace:emptyStates_loadingProjectsAriaLabel")}
                  >
                    <div className="text-center text-ui text-muted-foreground/58">
                      {t("workspace:emptyStates_loadingProjects")}
                    </div>
                    <div className="mx-auto grid w-full max-w-42 gap-1.5 opacity-70">
                      <div className="h-2 rounded-full bg-muted/55 animate-pulse" />
                      <div className="mx-auto h-2 w-4/5 rounded-full bg-muted/40 animate-pulse" />
                      <div className="mx-auto h-2 w-3/5 rounded-full bg-muted/30 animate-pulse" />
                    </div>
                  </div>
                )}

                {projectEmptyState === "empty" && (
                  <SpaceEmptyState
                    space={activeSpace}
                    hasProjectsElsewhere={allStandardProjectsBase.length > 0}
                    onMoveProjects={() => {
                      if (activeSpace) openSpaceProjectPicker(activeSpace.id);
                    }}
                  />
                )}
              </SidebarGroup>
            )}
          </div>
          {!isOnSettings &&
          !isOnGroups &&
          !activityViewEnabled &&
          NEOLIX_SNOOZE_UI_ENABLED &&
          snoozedSidebarThreads.length > 0 ? (
            <SidebarGroup className="px-1.5 pt-1 pb-2">
              <SidebarSnoozedThreadsSection
                threads={snoozedSidebarThreads}
                renderThreadRow={renderSnoozedThreadRow}
                onVisibleThreadIdsChange={setClassicSnoozedVisibleThreadIds}
              />
            </SidebarGroup>
          ) : null}
          {!isOnSettings && !isOnGroups && !activityViewEnabled && chatsSectionVisible ? (
            // sidebar-surface-enter: mounts on the Groups -> Projects switch, so it
            // animates in step with the keyed surface wrapper above.
            <SidebarGroup className="sidebar-surface-enter px-1.5 pt-1 pb-2">
              <div className="group/collapsible">
                <div className="group/project-header relative">
                  <SidebarMenuButton
                    size="sm"
                    aria-expanded={chatSectionExpanded}
                    className={cn(
                      SIDEBAR_HEADER_ROW_CLASS_NAME,
                      SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
                      SIDEBAR_ROW_HOVER_CLASS_NAME,
                      "cursor-pointer",
                    )}
                    onClick={() => setChatSectionExpanded((current) => !current)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      setChatSectionExpanded((current) => !current);
                    }}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
                      <span className="truncate font-system-ui text-ui font-normal text-muted-foreground/79">
                        {t("workspace:general_chats")}
                      </span>
                      <DisclosureChevron
                        open={chatSectionExpanded}
                        className="text-muted-foreground/79"
                      />
                    </div>
                  </SidebarMenuButton>
                  <SidebarSectionToolbar placement="overlay" revealOnHover>
                    <ChatSortMenu {...threadSortMenuProps} />
                    <SidebarIconButton
                      icon={NewThreadIcon}
                      label={t("workspace:newChatHome_openNewChatHome")}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void handleCreateHomeChat();
                      }}
                      tooltip={
                        newChatShortcutLabel
                          ? t("workspace:newChat", { value0: newChatShortcutLabel })
                          : t("workspace:sections_newChat")
                      }
                      tooltipSide="top"
                    />
                  </SidebarSectionToolbar>
                </div>

                <div className={cn(disclosureShellClassName(chatSectionExpanded), "pt-1")}>
                  <div className={DISCLOSURE_INNER_CLASS}>
                    <SidebarMenu
                      className={cn("gap-1", disclosureContentClassName(chatSectionExpanded))}
                    >
                      {mergedChatRows.length > 0 ? (
                        renderedChatEntries.map((entry) =>
                          entry.row.workspaceEntry.session ? (
                            <SidebarMenuItem key={entry.rowId}>
                              <WorkspaceThreadRow
                                entry={entry.row.workspaceEntry}
                                threadJumpLabel={
                                  visibleThreadJumpLabelByKey.get(entry.rowId) ?? null
                                }
                                topLevel
                                renderHoverCard={renderRemoteThreadHoverCard(
                                  entry.row.workspaceEntry,
                                )}
                              />
                            </SidebarMenuItem>
                          ) : (
                            renderThreadRow(entry.row.thread, visibleChatThreadIds, true)
                          ),
                        )
                      ) : (
                        <div className="px-2 py-2 text-ui text-muted-foreground/48">
                          {t("workspace:emptyStates_noChats")}
                        </div>
                      )}
                      {canShowMoreChatThreads || canShowLessChatThreads ? (
                        <SidebarMenuItem className="w-full">
                          <div className="flex w-full items-center gap-1">
                            {canShowMoreChatThreads ? (
                              <SidebarMenuButton
                                size="sm"
                                className="h-7 flex-1 justify-start rounded-lg pr-2 pl-8 text-left text-ui font-normal text-muted-foreground/79 hover:bg-transparent hover:text-foreground active:bg-transparent active:text-foreground"
                                onMouseDown={preventFocusOnMouseDown}
                                onClick={() =>
                                  setChatThreadListExtraPages(chatThreadListEffectiveExtraPages + 1)
                                }
                              >
                                <span>{t("workspace:timeline_showMore")}</span>
                              </SidebarMenuButton>
                            ) : null}
                            {canShowLessChatThreads ? (
                              <SidebarMenuButton
                                size="sm"
                                className={cn(
                                  "h-7 justify-start rounded-lg text-left text-ui font-normal text-muted-foreground/79 hover:bg-transparent hover:text-foreground active:bg-transparent active:text-foreground",
                                  // Keep the left indent when "Show less" is the only affordance left.
                                  canShowMoreChatThreads
                                    ? "w-auto flex-none px-2"
                                    : "flex-1 pr-2 pl-8",
                                )}
                                onMouseDown={preventFocusOnMouseDown}
                                onClick={() =>
                                  setChatThreadListExtraPages(
                                    Math.max(0, chatThreadListEffectiveExtraPages - 1),
                                  )
                                }
                              >
                                <span>{t("workspace:timeline_showLess")}</span>
                              </SidebarMenuButton>
                            ) : null}
                          </div>
                        </SidebarMenuItem>
                      ) : null}
                    </SidebarMenu>
                  </div>
                </div>
              </div>
            </SidebarGroup>
          ) : null}
        </SidebarContent>

        <SidebarFooter className="gap-1 border-sidebar-border border-t-0 p-2 pt-0 font-system-ui">
          <div className="flex items-center gap-1">
            <SidebarIconButton
              icon={SettingsIcon}
              label={t("workspace:toast_settings")}
              tooltip={t("workspace:toast_settings")}
              tooltipSide="top"
              size="lg"
              iconClassName={SIDEBAR_FOOTER_GLYPH_CLASS_NAME}
              className={sidebarFooterButtonClassName(false)}
              onClick={() => void navigate({ to: "/settings" })}
            />
            {appSettings.showRailUsage ? (
              <AppRailUsage
                onOpenUsageSettings={() => {
                  void navigate({ to: "/settings", search: { section: "usage" } });
                }}
              />
            ) : null}
            <SidebarHelpMenu inRail {...sidebarHelpMenuProps} />
            <div className="ms-auto flex items-center gap-1">
              {showDesktopUpdateButton && desktopUpdateState ? (
                <DesktopUpdateRailButton
                  state={desktopUpdateState}
                  installing={installingDesktopUpdate}
                  onClick={handleDesktopUpdateButtonClick}
                />
              ) : null}
              <AccountFooterControl />
            </div>
          </div>
          {DebugFeatureFlagsMenu && showDebugFeatureFlagsMenu && !isOnSettings ? (
            <Suspense fallback={null}>
              <DebugFeatureFlagsMenu />
            </Suspense>
          ) : null}
        </SidebarFooter>
      </div>

      <CreateProjectDialog
        open={createProjectDialogOpen}
        githubProvisioningAvailable={githubProvisioningAvailable}
        spaces={spaces}
        activeSpaceId={createProjectSpaceId === undefined ? activeSpaceId : createProjectSpaceId}
        defaultCloneParent={homeDir ?? "~"}
        onOpenChange={(open) => {
          setCreateProjectDialogOpen(open);
          if (!open) setCreateProjectSpaceId(undefined);
        }}
        onSubmit={handleCreateProjectSubmit}
      />

      <SpaceEditorDialog
        open={spaceEditorOpen}
        mode={spaceEditorMode}
        {...(spaceEditorInitialValue ? { initialValue: spaceEditorInitialValue } : {})}
        existingNames={spaceEditorExistingNames}
        onOpenChange={(open) => {
          if (!open) closeSpaceEditor();
        }}
        onSubmit={handleSpaceEditorSubmit}
      />

      <SpaceProjectPickerDialog
        open={spaceProjectPickerTarget !== null}
        targetSpace={spaceProjectPickerTarget}
        projects={allStandardProjectsBase}
        spaces={spaces}
        onOpenChange={(open) => {
          if (!open) closeSpaceProjectPicker();
        }}
        onSubmit={(projectIds) => {
          if (!spaceProjectPickerTarget) return;
          return handleBulkMoveProjects(projectIds, spaceProjectPickerTarget.id);
        }}
      />

      {projectContextMenuState && projectContextMenuProject && projectContextMenuAnchor ? (
        <Menu
          keepOpenOnSubmenuInteraction
          open
          onOpenChange={(open) => {
            if (!open) {
              setProjectContextMenuState(null);
            }
          }}
        >
          <ComposerPickerMenuPopup
            anchor={projectContextMenuAnchor}
            align="start"
            side="bottom"
            sideOffset={0}
            className={PROJECT_CONTEXT_MENU_PANEL_CLASS_NAME}
          >
            <MenuGroup>
              <MenuItem
                className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() =>
                  void handleProjectContextMenuAction(
                    projectContextMenuState.projectId,
                    "open-in-finder",
                  )
                }
              >
                <ProjectContextMenuIcon icon={FolderOpenIcon} />
                <span>{t("workspace:project_openInFinder")}</span>
              </MenuItem>
              {NEOLIX_OPEN_IN_NEW_WINDOW_UI_ENABLED ? (
                <MenuItem
                  className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                  onClick={() =>
                    void handleProjectContextMenuAction(
                      projectContextMenuState.projectId,
                      "open-in-new-window",
                    )
                  }
                >
                  <ProjectContextMenuIcon icon={ExternalLinkIcon} />
                  <span>{t("workspace:project_openInNewWindow")}</span>
                </MenuItem>
              ) : null}
              {NEOLIX_KANBAN_UI_ENABLED ? (
                <MenuItem
                  className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                  onClick={() =>
                    void handleProjectContextMenuAction(
                      projectContextMenuState.projectId,
                      "open-in-kanban",
                    )
                  }
                >
                  <ProjectContextMenuIcon icon={KanbanIcon} />
                  <span>{t("workspace:project_openInKanban")}</span>
                </MenuItem>
              ) : null}
              <MenuItem
                className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() =>
                  void handleProjectContextMenuAction(
                    projectContextMenuState.projectId,
                    "copy-path",
                  )
                }
              >
                <ProjectContextMenuIcon icon={CopyIcon} />
                <span>{t("workspace:copyPath")}</span>
              </MenuItem>
              <MenuSeparator />
              {projectContextMenuIsRunning ? (
                <MenuItem
                  className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                  onClick={() =>
                    void handleProjectContextMenuAction(
                      projectContextMenuState.projectId,
                      "stop-dev",
                    )
                  }
                >
                  <ProjectContextMenuIcon icon={StopFilledIcon} />
                  <span>{t("workspace:project_stopDev")}</span>
                </MenuItem>
              ) : (
                <MenuItem
                  className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                  onClick={() =>
                    void handleProjectContextMenuAction(
                      projectContextMenuState.projectId,
                      "start-dev",
                    )
                  }
                >
                  <ProjectContextMenuIcon icon={PlayIcon} />
                  <span>{t("workspace:runDialog_startDev")}</span>
                </MenuItem>
              )}
              {projectContextMenuIsRunning ? (
                <MenuItem
                  className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                  onClick={() =>
                    void handleProjectContextMenuAction(
                      projectContextMenuState.projectId,
                      "restart-dev",
                    )
                  }
                >
                  <ProjectContextMenuIcon icon={RefreshCwIcon} />
                  <span>{t("workspace:project_restartDev")}</span>
                </MenuItem>
              ) : null}
              {projectContextMenuHasOpenServer ? (
                <MenuItem
                  className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                  onClick={() =>
                    void handleProjectContextMenuAction(
                      projectContextMenuState.projectId,
                      "open-dev-server",
                    )
                  }
                >
                  <ProjectContextMenuIcon icon={ExternalLinkIcon} />
                  <span>{t("workspace:project_openDevServer")}</span>
                </MenuItem>
              ) : null}
              {projectContextMenuHasOpenServer ? (
                <MenuItem
                  className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                  onClick={() =>
                    void handleProjectContextMenuAction(
                      projectContextMenuState.projectId,
                      "copy-dev-url",
                    )
                  }
                >
                  <ProjectContextMenuIcon icon={CopyIcon} />
                  <span>{t("workspace:project_copyDevUrl")}</span>
                </MenuItem>
              ) : null}
              {projectContextMenuCanViewTerminal ? (
                <MenuItem
                  className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                  onClick={() =>
                    void handleProjectContextMenuAction(
                      projectContextMenuState.projectId,
                      "view-dev-terminal",
                    )
                  }
                >
                  <ProjectContextMenuIcon icon={TerminalIcon} />
                  <span>{t("workspace:project_viewDevTerminal")}</span>
                </MenuItem>
              ) : null}
              {projectContextMenuUrlRoutes.length > 1 ? (
                <MenuSub keepOpenOnFocusOut>
                  <MenuSubTrigger className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}>
                    <ProjectContextMenuIcon icon={GlobeIcon} />
                    <span>{t("workspace:project_devRoute")}</span>
                  </MenuSubTrigger>
                  <ComposerPickerMenuSubPopup className="min-w-56">
                    <MenuRadioGroup
                      value={
                        (projectContextMenuProject
                          ? devServerRouteByProjectId[projectContextMenuProject.id]
                          : undefined) ??
                        projectContextMenuUrlRoutes[0]?.kind ??
                        "direct"
                      }
                      onValueChange={(value) => {
                        if (!projectContextMenuProject) return;
                        handleSelectProjectRunRoute(
                          projectContextMenuProject.id,
                          value as "public" | "neolix" | "direct",
                        );
                      }}
                    >
                      {projectContextMenuUrlRoutes.map((route) => (
                        <MenuRadioItem key={route.kind} value={route.kind}>
                          <span className="min-w-0 truncate">
                            {t(
                              route.kind === "public"
                                ? "workspace:project_devRoutePublic"
                                : route.kind === "neolix"
                                  ? "workspace:project_devRouteNeolix"
                                  : "workspace:project_devRouteDirect",
                            )}
                          </span>
                          <span className="ms-auto min-w-0 truncate text-ui-sm text-muted-foreground">
                            {route.label}
                          </span>
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </ComposerPickerMenuSubPopup>
                </MenuSub>
              ) : null}
              <MenuSub keepOpenOnFocusOut>
                <MenuSubTrigger className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}>
                  {/* The glyph is the project's current space, so the row doubles as a
                      read-out of where it lives today. It wears the same secondary tone
                      as every other leading glyph in this menu. */}
                  <span className={PROJECT_CONTEXT_MENU_ICON_CLASS_NAME}>
                    <SpaceIcon
                      icon={spaceDisplayIcon(projectContextMenuProject.spaceId, spaces, voidSpace)}
                    />
                  </span>
                  <span>{t("workspace:moveToSpace")}</span>
                </MenuSubTrigger>
                <ComposerPickerMenuSubPopup className="min-w-48">
                  <MenuRadioGroup
                    value={spaceKey(projectContextMenuProject.spaceId ?? null)}
                    onValueChange={(value) => {
                      void handleMoveProjectToSpace(
                        projectContextMenuProject.id,
                        value === VOID_SPACE_KEY ? null : SpaceId.makeUnsafe(value),
                      );
                    }}
                  >
                    <MenuRadioItem value={VOID_SPACE_KEY}>
                      <SpaceIcon icon={voidSpace.icon} className="size-3.5" />
                      <span className="min-w-0 truncate">{voidSpace.name}</span>
                    </MenuRadioItem>
                    {spaces.map((space) => (
                      <MenuRadioItem key={space.id} value={space.id}>
                        <SpaceIcon icon={space.icon} className="size-3.5" />
                        <span className="min-w-0 truncate">{space.name}</span>
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                  {/* Neox 无 Space 元数据后端：项目菜单不提供新建 Space。 */}
                  {NEOLIX_SPACE_EDITING_UI_ENABLED ? (
                    <>
                      <MenuSeparator />
                      <MenuItem
                        className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                        onClick={() => {
                          const projectId = projectContextMenuProject.id;
                          setProjectContextMenuState(null);
                          openSpaceCreator(projectId);
                        }}
                      >
                        <span className={PROJECT_CONTEXT_MENU_ICON_CLASS_NAME}>
                          <AddPlusIcon />
                        </span>
                        <span>{t("workspace:newSpace2")}</span>
                      </MenuItem>
                    </>
                  ) : null}
                </ComposerPickerMenuSubPopup>
              </MenuSub>
              <MenuSeparator />
              <MenuItem
                className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() =>
                  void handleProjectContextMenuAction(projectContextMenuState.projectId, "rename")
                }
              >
                <ProjectContextMenuIcon icon={PencilIcon} />
                <span>{t("workspace:editProject")}</span>
              </MenuItem>
              {isGroupContainerProject(projectContextMenuProject, {
                homeDir,
                chatWorkspaceRoot,
                studioWorkspaceRoot,
                groupsWorkspaceRoot,
              }) && summaryFor(projectContextMenuState.projectId)?.configured ? (
                <>
                  <MenuItem
                    className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                    onClick={() =>
                      void handleProjectContextMenuAction(
                        projectContextMenuState.projectId,
                        "edit-project-agent",
                      )
                    }
                  >
                    <ProjectContextMenuIcon icon={BotIcon} />
                    <span>{t("workspace:editCoordinator")}</span>
                  </MenuItem>
                  <MenuItem
                    className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                    onClick={() =>
                      void handleProjectContextMenuAction(
                        projectContextMenuState.projectId,
                        "toggle-pin-project-agent",
                      )
                    }
                  >
                    <ProjectContextMenuIcon icon={PinIcon} />
                    <span>
                      {pinActionLabel(
                        t("chat:pinTargetCoordinator"),
                        pinnedProjectAgentIdSet.has(projectContextMenuState.projectId),
                      )}
                    </span>
                  </MenuItem>
                </>
              ) : null}
              {NEOLIX_PROJECT_FOLDERS_UI_ENABLED ? (
                <MenuItem
                  className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                  onClick={() =>
                    void handleProjectContextMenuAction(
                      projectContextMenuState.projectId,
                      "relocate",
                    )
                  }
                >
                  <ProjectContextMenuIcon icon={FolderOpenIcon} />
                  <span>{t("workspace:changeProjectPath2")}</span>
                </MenuItem>
              ) : null}
              <MenuItem
                className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() =>
                  void handleProjectContextMenuAction(
                    projectContextMenuState.projectId,
                    "toggle-pin",
                  )
                }
              >
                <ProjectContextMenuIcon icon={PinIcon} />
                <span>
                  {pinActionLabel(t("chat:pinTargetProject"), projectContextMenuIsPinned)}
                </span>
              </MenuItem>
              {projectContextMenuHasArchivableThreads || projectContextMenuHasAnyThreads ? (
                <MenuSeparator />
              ) : null}
              {projectContextMenuHasArchivableThreads ? (
                <MenuItem
                  className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                  onClick={() =>
                    void handleProjectContextMenuAction(
                      projectContextMenuState.projectId,
                      "archive-threads",
                    )
                  }
                >
                  <ProjectContextMenuIcon icon={ArchiveIcon} />
                  <span>{t("workspace:project_archiveThreads")}</span>
                </MenuItem>
              ) : null}
              {projectContextMenuHasAnyThreads ? (
                <MenuItem
                  className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                  onClick={() =>
                    void handleProjectContextMenuAction(
                      projectContextMenuState.projectId,
                      "delete-threads",
                    )
                  }
                >
                  <ProjectContextMenuIcon icon={Trash2} />
                  <span>{t("workspace:project_deleteThreads")}</span>
                </MenuItem>
              ) : null}
              <MenuSeparator />
              <MenuItem
                className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() =>
                  void handleProjectContextMenuAction(projectContextMenuState.projectId, "delete")
                }
              >
                <ProjectContextMenuIcon icon={XIcon} />
                <span>{t("workspace:edit_remove")}</span>
              </MenuItem>
            </MenuGroup>
          </ComposerPickerMenuPopup>
        </Menu>
      ) : null}

      <Dialog
        open={projectRunDialogProjectId !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeProjectRunDialog();
          }
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <PlayIcon className="size-4 text-emerald-500" />
              {t("workspace:runDialog_startDev")}
            </DialogTitle>
            <DialogDescription>
              {projectRunDialogProject ? projectRunDialogProject.name : t("chat:detail_project")}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-2">
            <label
              htmlFor="project-run-command-input"
              className="block text-ui-xs font-medium text-[var(--color-text-foreground-secondary)]"
            >
              {t("workspace:scripts_command")}
            </label>
            <Input
              id="project-run-command-input"
              autoFocus
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              placeholder={t("workspace:runDialog_commandPlaceholder")}
              value={projectRunDialogCommandDraft}
              aria-invalid={projectRunDialogCommandIsValid ? undefined : true}
              onChange={(event) => setProjectRunDialogCommandDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleConfirmProjectRun();
                }
              }}
            />
            {projectRunDialogCommandIsValid ? null : (
              <p className="text-ui-sm text-destructive">{t("workspace:runDialog_enterCommand")}</p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeProjectRunDialog}>
              {t("common:form_cancel")}
            </Button>
            <Button
              onClick={handleConfirmProjectRun}
              disabled={!projectRunDialogCommandIsValid || Boolean(projectRunDialogExistingRun)}
            >
              <PlayIcon className="size-4" />
              {t("workspace:runDialog_run")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <SnoozeUntilDialog
        open={snoozeDialogThreadId !== null}
        currentSnoozedUntil={
          snoozeDialogThreadId
            ? (sidebarThreadSummaryById[snoozeDialogThreadId]?.snoozedUntil ?? null)
            : null
        }
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setSnoozeDialogThreadId(null);
        }}
        onSnooze={(deadline) => {
          if (snoozeDialogThreadId !== null) snoozeThread(snoozeDialogThreadId, deadline);
        }}
      />
      <RenameThreadDialog
        open={renameDialogThreadId !== null}
        currentTitle={(() => {
          const target =
            renameDialogThreadId === null
              ? undefined
              : sidebarThreadSummaryById[renameDialogThreadId];
          return target ? resolveThreadRenameTitle(target) : "";
        })()}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setRenameDialogThreadId(null);
        }}
        onSave={(newTitle) => {
          if (renameDialogThreadId === null) return;
          const target = sidebarThreadSummaryById[renameDialogThreadId];
          if (!target) return;
          void commitRename(target.id, newTitle, resolveThreadRenameTitle(target));
        }}
      />

      <RenameDialog
        open={workspaceRenameTarget !== null}
        title={t("workspace:workspaceRenameTitle")}
        description={t("workspace:workspaceRenameDescription")}
        initialValue={workspaceRenameTarget?.title ?? ""}
        allowEmpty
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setWorkspaceRenameTarget(null);
        }}
        onSave={async (next) => {
          await renameWorkspace(next);
          setWorkspaceRenameTarget(null);
        }}
      />

      <WorkspaceLabelsDialog
        open={labelsDialogOpen}
        onOpenChange={setLabelsDialogOpen}
        createWorkspaceId={createWorkspaceIdForActiveThread}
      />

      <AlertDialog
        open={archiveWorkspaceTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setArchiveWorkspaceTarget(null);
        }}
      >
        <AlertDialogPopup className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("workspace:workspaceArchiveTitle", {
                value0: archiveWorkspaceTarget?.name ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("workspace:workspaceArchiveDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setArchiveWorkspaceTarget(null)}>
              {t("common:form_cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void confirmArchiveWorkspace()}>
              {t("workspace:workspaceArchiveConfirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      {relocateProjectDialogProject ? (
        <RelocateProjectDialog
          projectId={relocateProjectDialogProject.id}
          workspaceRoot={relocateProjectDialogProject.cwd}
          onOpenChange={(open) => {
            if (!open) setRelocateProjectDialogId(null);
          }}
        />
      ) : null}

      {editProjectDialogProject ? (
        <EditProjectDialog
          open={editProjectDialog?.open ?? false}
          cwd={editProjectDialogProject.cwd}
          folderName={editProjectDialogProject.folderName}
          initialValue={{
            name: editProjectDialogProject.localName ?? "",
            appearance: editProjectDialogProject.appearance ?? null,
          }}
          onOpenChange={(nextOpen) => {
            if (!nextOpen)
              setEditProjectDialog((current) => current && { ...current, open: false });
          }}
          onSave={(next) =>
            handleEditProjectSave(
              editProjectDialogProject.id,
              next,
              editProjectDialogProject.localName,
            )
          }
        />
      ) : null}

      {projectAgentDialogProject ? (
        <GroupSettingsDialog
          key={projectAgentDialogProject.id}
          open={projectAgentDialogState !== null}
          mode={projectAgentDialogState?.mode ?? "onboarding"}
          projectId={projectAgentDialogProject.id}
          projectName={projectAgentDialogProject.name}
          workspacePath={projectAgentDialogProject.cwd}
          defaultModelSelection={projectAgentDialogProject.defaultModelSelection ?? null}
          allowDiscard={projectAgentDialogState?.discardable === true}
          onOpenChange={(open) => {
            if (!open) {
              setProjectAgentDialogState(null);
            }
          }}
          onSaved={(overview) => {
            if (projectAgentDialogState?.mode !== "onboarding") return;
            const coordinatorThreadId = overview.config?.coordinatorThreadId;
            const firstMessage = projectAgentDialogState.firstMessage;
            if (coordinatorThreadId && firstMessage) {
              void postGroupPickupMessage(coordinatorThreadId, firstMessage);
            }
            if (coordinatorThreadId) {
              pendingCoordinatorActivationRef.current?.cancel();
              pendingCoordinatorActivationRef.current = {
                pathname,
                cancel: activateThreadWhenHydrated({
                  hasThread: () =>
                    useStore.getState().sidebarThreadSummaryById[coordinatorThreadId] !== undefined,
                  subscribe: (listener) => useStore.subscribe(listener),
                  // The sidebar intent path resolves against the summary map captured at
                  // render time; a thread created by this dialog hydrates later, so wait
                  // for its row and then open it directly.
                  activate: () => {
                    prewarmThreadDetailForIntent(coordinatorThreadId);
                    setOptimisticActiveThreadId(coordinatorThreadId);
                    setSelectionAnchor(coordinatorThreadId);
                    openChatThreadPage(coordinatorThreadId);
                    rememberLastThreadRouteNow({ threadId: coordinatorThreadId });
                    void navigate({
                      to: "/$threadId",
                      params: { threadId: coordinatorThreadId },
                      search: (previous) => ({ ...previous, splitViewId: undefined }),
                    });
                  },
                }),
              };
            }
          }}
        />
      ) : null}

      {searchPaletteOpen ? (
        <SidebarSearchPaletteController
          open={searchPaletteOpen}
          mode={searchPaletteMode}
          onModeChange={setSearchPaletteMode}
          onOpenChange={(open) => {
            setSearchPaletteOpen(open);
            if (!open) {
              setSearchPaletteMode("search");
            }
          }}
          actions={[
            ...searchPaletteActions,
            ...workspacePaletteActions,
            ...pluginCommandActions,
            ...pluginThemeActions,
          ]}
          projects={searchPaletteProjects}
          projectById={projectById}
          onCreateChat={() => void handleCreatePaletteChat()}
          onCreateThread={handlePrimaryNewThread}
          onAddProjectPath={addProjectFromPath}
          homeDir={homeDir}
          onOpenSettings={(section, options) => {
            void navigate({
              to: "/settings",
              search: (previous) => ({
                ...previous,
                section: section === "general" ? undefined : section,
                target: options?.target,
              }),
            });
          }}
          onOpenFeedback={() => openFeedbackDialog()}
          onOpenUsageSettings={() => {
            void navigate({
              to: "/settings",
              search: { section: "usage" },
            });
          }}
          onOpenProject={(projectId, host, session) => {
            if (!host) {
              handleOpenProjectFromSearch(projectId);
              return;
            }
            const navigation = session && readAvailableWorkspaceNavigation(session);
            if (
              !session ||
              !navigation ||
              !session.summary?.projects.some((project) => project.id === projectId)
            )
              return;
            void navigation
              .openProject(projectId)
              .then((path) => openWorkspacePath(session, path))
              .catch((error: unknown) => {
                toastManager.add({
                  type: "error",
                  title: t("workspace:couldNotOpenProject"),
                  description:
                    error instanceof Error
                      ? error.message
                      : t("workspace:tryAgainAfterReconnecting"),
                });
              });
          }}
          providerInstances={sidebarProviderInstances}
          onImportThread={handleImportThread}
          onOpenThread={(threadId, host, session) => {
            if (!host) {
              activateThreadFromSidebarIntent(ThreadId.makeUnsafe(threadId));
              return;
            }
            if (
              session?.summary?.threads.some(
                (thread) => thread.id === threadId && !thread.archivedAt,
              )
            )
              openWorkspacePath(session, `/${threadId}`);
          }}
        />
      ) : null}
    </>
  );
}

// Message text projections keyed by the thread's message array, which the
// store keeps reference-stable while that thread's messages are unchanged.
const searchPaletteMessagesByThreadMessages = new WeakMap<
  Thread["messages"],
  SidebarSearchThread["messages"]
>();

function searchPaletteMessagesFor(thread: Thread): SidebarSearchThread["messages"] {
  const cached = searchPaletteMessagesByThreadMessages.get(thread.messages);
  if (cached) {
    return cached;
  }
  const projected = thread.messages.map((message) => ({ text: message.text }));
  searchPaletteMessagesByThreadMessages.set(thread.messages, projected);
  return projected;
}

function SidebarSearchPaletteController(props: {
  open: boolean;
  mode: SidebarSearchPaletteMode;
  onModeChange: (mode: SidebarSearchPaletteMode) => void;
  onOpenChange: (open: boolean) => void;
  actions: readonly SidebarSearchAction[];
  projects: readonly SidebarSearchProject[];
  projectById: ReadonlyMap<ProjectId, { name: string; remoteName: string }>;
  onCreateChat: () => void;
  onCreateThread: () => void;
  onAddProjectPath: (path: string, options?: { createIfMissing?: boolean }) => Promise<void>;
  homeDir: string | null;
  onOpenSettings: (section?: SettingsSectionId, options?: { target?: string }) => void;
  onOpenFeedback: () => void;
  onOpenUsageSettings: () => void;
  onOpenProject: (projectId: string, host?: SidebarSearchHost, session?: WorkspaceSession) => void;
  providerInstances: readonly ProviderInstanceOption[];
  onImportThread: (target: ThreadImportTarget, externalId: string) => Promise<void>;
  onOpenThread: (threadId: string, host?: SidebarSearchHost, session?: WorkspaceSession) => void;
}) {
  const sessions = useWorkspaceSessions();
  const remoteSearch = useMemo(() => {
    const search = workspaceSidebarSearch(sessions);
    const sessionBySearchHost = new Map<SidebarSearchHost, WorkspaceSession>();
    for (const result of [...search.projects, ...search.threads]) {
      if (!result.host) continue;
      const session = sessions.find(
        (entry) => entry.host.executionScope.environmentId === result.host!.environmentId,
      );
      if (session) sessionBySearchHost.set(result.host, session);
    }
    return { ...search, sessionBySearchHost };
  }, [sessions]);
  const searchProjects = useMemo(
    () => [...props.projects, ...remoteSearch.projects],
    [props.projects, remoteSearch.projects],
  );
  const selectAllThreads = useMemo(() => createAllThreadsSelector(), []);
  // Search keeps automation-run threads as an intent-driven escape hatch, while
  // structurally nested side chats stay out of standalone thread results.
  const selectSidebarDisplayThreads = useMemo(
    () => createSidebarDisplayThreadsSelector({ includeSnoozed: true }),
    [],
  );
  const importCandidates = useMemo(
    () => buildThreadImportCandidates(props.providerInstances),
    [props.providerInstances],
  );
  const importProviderCapabilityQueries = useQueries({
    queries: importCandidates.map((target) =>
      providerComposerCapabilitiesQueryOptions(target.provider, target.instanceId),
    ),
  });
  const threads = useStore(selectAllThreads);
  const sidebarDisplayThreads = useStore(selectSidebarDisplayThreads);
  const importTargets = filterThreadImportTargetsByCapabilities(
    importCandidates,
    importProviderCapabilityQueries.map((query) => query.data),
  ).filter((target) => isBetaFeatureOn(target.provider));
  // `threads` is rebuilt on every streamed store flush, so this projection is
  // cheap by construction (message text is cached per thread-messages array
  // below) and its result keeps the previous identity while nothing the
  // palette shows has changed, sparing the palette a full rescore per token.
  const rebuiltSearchPaletteThreads = useMemo<SidebarSearchThread[]>(() => {
    const threadById = new Map(threads.map((thread) => [thread.id, thread] as const));
    const searchProjectById = new Map(
      props.projects.map((project) => [project.id, project] as const),
    );
    return sidebarDisplayThreads.flatMap((threadSummary) => {
      const thread = threadById.get(threadSummary.id);
      if (!thread) {
        return [];
      }

      return [
        {
          id: thread.id,
          title: thread.title,
          projectId: thread.projectId,
          projectName: props.projectById.get(thread.projectId)?.name ?? "Unknown project",
          projectRemoteName:
            props.projectById.get(thread.projectId)?.remoteName ?? "Unknown project",
          spaceName: searchProjectById.get(thread.projectId)?.spaceName ?? "Global",
          provider: thread.modelSelection.provider,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          messages: searchPaletteMessagesFor(thread),
        },
      ];
    });
  }, [props.projectById, props.projects, sidebarDisplayThreads, threads]);
  const searchPaletteThreadData = useStableValue(
    {
      threads: [...rebuiltSearchPaletteThreads, ...remoteSearch.threads],
      sessionBySearchHost: remoteSearch.sessionBySearchHost,
    },
    (previous, next) =>
      areSidebarSearchThreadListsEqual(previous.threads, next.threads) &&
      previous.threads.every((thread, index) => {
        const previousSession = thread.host
          ? previous.sessionBySearchHost.get(thread.host)
          : undefined;
        const nextHost = next.threads[index]?.host;
        const nextSession = nextHost ? next.sessionBySearchHost.get(nextHost) : undefined;
        if (!previousSession || !nextSession) return previousSession === nextSession;
        return (
          previousSession.host === nextSession.host &&
          previousSession.navigation === nextSession.navigation
        );
      }),
  );

  return (
    <SidebarSearchPalette
      open={props.open}
      mode={props.mode}
      onModeChange={props.onModeChange}
      onOpenChange={props.onOpenChange}
      actions={props.actions}
      projects={searchProjects}
      threads={searchPaletteThreadData.threads}
      onCreateChat={props.onCreateChat}
      onCreateThread={props.onCreateThread}
      onAddProjectPath={props.onAddProjectPath}
      homeDir={props.homeDir}
      onOpenSettings={props.onOpenSettings}
      onOpenFeedback={props.onOpenFeedback}
      onOpenUsageSettings={props.onOpenUsageSettings}
      onOpenProject={(id, host) => {
        if (!host) {
          props.onOpenProject(id);
          return;
        }
        const session = remoteSearch.sessionBySearchHost.get(host);
        if (session && readAvailableWorkspaceNavigation(session))
          props.onOpenProject(id, host, session);
      }}
      importTargets={importTargets}
      onImportThread={props.onImportThread}
      onImportProjects={(providers) => useProjectImportDialogStore.getState().openDialog(providers)}
      onOpenThread={(id, host) => {
        if (!host) {
          props.onOpenThread(id);
          return;
        }
        const session = searchPaletteThreadData.sessionBySearchHost.get(host);
        if (session && readAvailableWorkspaceNavigation(session))
          props.onOpenThread(id, host, session);
      }}
    />
  );
}
