// FILE: GitActionsControl.tsx
// Purpose: Render the chat-header git action control, commit dialog, and action toasts.
// Layer: Header action control
// Depends on: git React Query hooks, native shell bridges, and shared picker/menu primitives.

import { DEFAULT_GIT_TEXT_GENERATION_MODEL } from "@synara/contracts";
import type {
  GitActionProgressEvent,
  GitActionProgressPhase,
  GitRunStackedActionResult,
  GitStackedAction,
  GitStatusResult,
  ModelSelection,
  ThreadId,
} from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import { ChevronDownIcon, InfoIcon } from "~/lib/icons";
import { Input } from "~/components/ui/input";
import {
  buildGitActionProgressStages,
  buildGitActionFailureToast,
  buildMenuItems,
  type GitDialogContext,
  type GitActionMenuItem,
  type GitGlyphName,
  type GitQuickAction,
  type DefaultBranchConfirmableAction,
  requiresFeatureBranchForDefaultBranchAction,
  requiresDefaultBranchConfirmation,
  resolveGitMenuActionDisabledReason,
  resolveLiveThreadBranchUpdate,
  resolveDefaultCreateBranchName,
  resolveDefaultBranchActionDialogCopy,
  resolveCreatePrActionAvailability,
  resolveCreatePrBaseBranch,
  resolveCreatePrDialogRuntimeStatus,
  resolveCreatePrExecution,
  resolveQuickAction,
  resolvePullActionAvailability,
  resolvePullAndPushAvailability,
  type PullAndPushDisabledReason,
  resolvePromotedPullPresentation,
  summarizeGitResult,
} from "./GitActionsControl.logic";
import { GIT_ACTION_ICON_CLASS, GitActionGlyph } from "./gitActionGlyphs";
import { GitCommitDialog, type GitCommitDialogSubmission } from "./GitCommitDialog";
import {
  GitCreatePrDialog,
  type GitCreatePrDialogBrowserRequest,
  type GitCreatePrDialogSubmission,
} from "./GitCreatePrDialog";
import { getProviderStartOptions, useAppSettings } from "~/appSettings";
import { formatClockDuration } from "~/session-logic";
import { Button } from "~/components/ui/button";
import { ButtonGroup, ButtonGroupSeparator } from "~/components/ui/button-group";
import {
  ChatHeaderButton,
  ChatHeaderIconButton,
  ChatHeaderSplitDivider,
  ChatHeaderSplitGroup,
  CHAT_HEADER_CONTROL_CLASS_NAME,
  CHAT_HEADER_ICON_CONTROL_CLASS_NAME,
  CHAT_HEADER_ICON_STRENGTH_CLASS_NAME,
  CHAT_HEADER_SPLIT_LEADING_CLASS_NAME,
  CHAT_HEADER_SPLIT_TRAILING_CLASS_NAME,
} from "./chat/chatHeaderControls";
import {
  ENVIRONMENT_ROW_CLASS_NAME,
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentRow,
  EnvironmentRowBody,
  EnvironmentRowChevron,
} from "./chat/environment/EnvironmentRow";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { toastManager, reportToastIssue } from "~/components/ui/toast";
import { diagnosticIssueReason } from "~/lib/rendererErrorDiagnostics";
import { openInPreferredEditor } from "~/editorPreferences";
import {
  gitBranchesQueryOptions,
  gitInitMutationOptions,
  gitMergeFromBaseMutationOptions,
  gitMergeLocallyMutationOptions,
  gitMutationKeys,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
  gitStatusQueryOptions,
  invalidateGitQueries,
  isGitExpensiveReadCapacityError,
  refreshGitActionAvailability,
} from "~/lib/gitReactQuery";
import { cn, newCommandId, randomUUID } from "~/lib/utils";
import { resolvePathLinkTarget } from "~/terminal-links";
import { readNativeApi } from "~/nativeApi";
import { createThreadGitActionsMetadataSelector } from "~/storeSelectors";
import { useStore } from "~/store";
import { useGitCommandPaletteStore } from "~/gitCommandPaletteStore";
import { useTranslation, t } from "~/i18n";

interface GitActionsControlProps {
  gitCwd: string | null;
  activeThreadId: ThreadId | null;
  hideQuickActionLabel?: boolean;
  // `header` renders the split quick-action button; `panel` collapses git actions into
  // an Environment row + dropdown, promoting Pull as the primary row when behind upstream.
  variant?: "header" | "panel";
  // `always` (default) keeps the control mounted. `pull-available` hides the header
  // control unless Pull is the current action or a pull is already running — used
  // next to Hand off / New thread while Environment owns the rest of git actions.
  visibleWhen?: "always" | "pull-available";
  // Lets a parent capture "run commit & push for this instance's repo" so a global
  // keyboard shortcut can trigger it without duplicating the action logic. Called with
  // `null` on unmount/dependency change so a stale trigger never lingers.
  onRegisterCommitAndPushTrigger?: ((trigger: (() => void) | null) => void) | undefined;
}

interface PendingDefaultBranchAction {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  commitMessage?: string;
  forcePushOnlyProgress: boolean;
  onConfirmed?: () => void;
  filePaths?: string[];
}

type GitActionToastId = ReturnType<typeof toastManager.add>;

interface ActiveGitActionProgress {
  toastId: GitActionToastId;
  actionId: string;
  title: string;
  phaseStartedAtMs: number | null;
  hookStartedAtMs: number | null;
  hookName: string | null;
  lastOutputLine: string | null;
  currentPhaseLabel: string | null;
  phase: GitActionProgressPhase | null;
  failure?: Extract<GitActionProgressEvent, { kind: "action_failed" }>;
}

interface RunGitActionWithToastInput {
  action: GitStackedAction;
  commitMessage?: string;
  forcePushOnlyProgress?: boolean;
  onConfirmed?: () => void;
  skipDefaultBranchPrompt?: boolean;
  statusOverride?: GitStatusResult | null;
  featureBranch?: boolean;
  isDefaultBranchOverride?: boolean;
  progressToastId?: GitActionToastId;
  filePaths?: string[];
  prTitle?: string;
  prBody?: string;
  prDraft?: boolean;
  allowDirtyWorkingTree?: boolean;
  afterSuccess?: (result: GitRunStackedActionResult) => void;
}

type RunGitActionWithToast = (input: RunGitActionWithToastInput) => Promise<void>;

// Per-instance runtime state lives in a module keyed store: the React Compiler
// rejects any component callback that touches a ref once it is reachable from
// render-built structures (the picker menu rows), and this keeps the same
// identity and semantics as the refs it replaces.
interface GitActionRuntimeState {
  progress: ActiveGitActionProgress | null;
  rerun: RunGitActionWithToast | null;
}

const gitActionRuntimeStates = new Map<string, GitActionRuntimeState>();

function gitActionRuntimeState(key: string): GitActionRuntimeState {
  let state = gitActionRuntimeStates.get(key);
  if (!state) {
    state = { progress: null, rerun: null };
    gitActionRuntimeStates.set(key, state);
  }
  return state;
}

function disposeGitActionRuntimeState(key: string): void {
  gitActionRuntimeStates.delete(key);
}

function getActiveGitActionProgress(key: string): ActiveGitActionProgress | null {
  // Reads never create an entry: an action that settles after unmount must not
  // resurrect the state its unmount disposed.
  return gitActionRuntimeStates.get(key)?.progress ?? null;
}

function setActiveGitActionProgress(key: string, progress: ActiveGitActionProgress): void {
  gitActionRuntimeState(key).progress = progress;
}

function clearActiveGitActionProgress(key: string, progress: ActiveGitActionProgress): void {
  const state = gitActionRuntimeStates.get(key);
  if (state?.progress === progress) state.progress = null;
}

function getGitActionRerun(key: string): RunGitActionWithToast | null {
  return gitActionRuntimeStates.get(key)?.rerun ?? null;
}

function setGitActionRerun(key: string, rerun: RunGitActionWithToast): void {
  gitActionRuntimeState(key).rerun = rerun;
}

function resolveExistingOpenPrUrl(actionStatus: GitStatusResult | null): string | undefined {
  return actionStatus?.pr?.state === "open" ? actionStatus.pr.url : undefined;
}

function resolveResultPrUrl(
  result: GitRunStackedActionResult,
  existingOpenPrUrl: string | undefined,
): string | null | undefined {
  return result.pr.url ?? existingOpenPrUrl;
}

function shouldOfferPushCtaFor(
  action: GitStackedAction,
  result: GitRunStackedActionResult,
): boolean {
  return action === "commit" && result.commit.status === "created";
}

function shouldOfferOpenPrCtaFor(
  action: GitStackedAction,
  prUrl: string | null | undefined,
  actionIsDefaultBranch: boolean,
  result: GitRunStackedActionResult,
): boolean {
  return (
    (action === "push" ||
      action === "create_pr" ||
      action === "commit_push" ||
      action === "commit_push_pr") &&
    !!prUrl &&
    (!actionIsDefaultBranch ||
      result.pr.status === "created" ||
      result.pr.status === "opened_existing")
  );
}

function resolvePostPushStatus(
  actionStatus: GitStatusResult | null,
  result: GitRunStackedActionResult,
): GitStatusResult | null {
  return actionStatus
    ? {
        ...actionStatus,
        hasUpstream: true,
        upstreamBranch:
          actionStatus.upstreamBranch ??
          (!actionStatus.hasUpstream ? (result.push.branch ?? actionStatus.branch) : null),
        aheadCount: 0,
      }
    : null;
}

function shouldOfferCreatePrCtaFor(
  action: GitStackedAction,
  prUrl: string | null | undefined,
  actionIsDefaultBranch: boolean,
  result: GitRunStackedActionResult,
  postPushStatus: GitStatusResult | null,
  hasOriginRemote: boolean,
  defaultBranchName: string | null,
): boolean {
  return (
    (action === "push" || action === "commit_push") &&
    !prUrl &&
    result.push.status === "pushed" &&
    !actionIsDefaultBranch &&
    resolveCreatePrExecution({
      gitStatus: postPushStatus,
      isBusy: false,
      isDefaultBranch: actionIsDefaultBranch,
      hasOriginRemote,
      defaultBranchName,
    }).kind === "run_action"
  );
}

// Overrides captured when the Create PR dialog opens from a surface with a
// pre-resolved git status (e.g. the post-push toast CTA); null means "open
// against the live status".
interface CreatePrDialogState {
  statusOverride: GitStatusResult | null;
  statusOverrideSource: GitStatusResult | null;
  isDefaultBranchOverride: boolean | null;
}

interface GitPickerMenuItem {
  id:
    | "push"
    | "pr"
    | "sync"
    | "pull_and_push"
    | "commit"
    | "commit_push"
    | "merge_locally"
    | "update_from_base"
    | "create_branch";
  label: string;
  disabled: boolean;
  disabledReason: string | null;
  icon: GitGlyphName;
  onSelect: () => void;
}

// Keep "/" literal in branch names; GitHub compare URLs expect it unescaped.
function encodeBranchForCompareUrl(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function formatElapsedDescription(startedAtMs: number | null): string | undefined {
  if (startedAtMs === null) {
    return undefined;
  }
  return t("git:runningFor", { value0: formatClockDuration(Date.now() - startedAtMs) });
}

function resolveProgressDescription(progress: ActiveGitActionProgress): string | undefined {
  if (progress.lastOutputLine) {
    return progress.lastOutputLine;
  }
  return formatElapsedDescription(progress.hookStartedAtMs ?? progress.phaseStartedAtMs);
}

// Map a header quick action onto its shared glyph name; null falls back to a hint icon.
// Every push-family action collapses to "push" so the button matches the picker rows.
function resolveGitQuickActionGlyph(quickAction: GitQuickAction): GitGlyphName | null {
  if (quickAction.kind === "open_pr") return "view_pr";
  if (quickAction.kind === "run_pull") return "sync";
  if (quickAction.kind === "create_branch") return "branch";
  if (quickAction.kind === "run_action") {
    return quickAction.action === "commit" ? "commit" : "push";
  }
  if (quickAction.label === "Commit") return "commit";
  return null;
}

function GitQuickActionIcon({ quickAction }: { quickAction: GitQuickAction }) {
  const name = resolveGitQuickActionGlyph(quickAction);
  if (name) return <GitActionGlyph name={name} />;
  return <InfoIcon className={GIT_ACTION_ICON_CLASS} />;
}

function pullAndPushUnavailableLabel(reason: PullAndPushDisabledReason): string {
  const labels: Record<PullAndPushDisabledReason, string> = {
    busy: t("git:pullAndPushBusy"),
    status_unavailable: t("git:pullAndPushStatusUnavailable"),
    detached_head: t("git:pullAndPushDetachedHead"),
    no_remote: t("git:pullAndPushNoRemote"),
    no_upstream: t("git:pullAndPushNoUpstream"),
    dirty_worktree: t("git:pullAndPushDirtyWorktree"),
    already_in_sync: t("git:pullAndPushAlreadyInSync"),
    diverged: t("git:pullAndPushDiverged"),
  };
  return labels[reason];
}

// The commit-and-push behavior moves between menu items with git state: on a feature
// branch with pending changes it is the `commit_push` item, while on the default branch
// (or with ahead-only commits) it lives under the `push` item. Both the panel row's
// enabled state and the global shortcut resolve their target through this one rule.
function findRunnableCommitPushMenuItem(items: GitActionMenuItem[]): GitActionMenuItem | null {
  return (
    items.find((item) => (item.id === "commit_push" || item.id === "push") && !item.disabled) ??
    null
  );
}

function GitPickerMenuRow({ item }: { item: GitPickerMenuItem }) {
  return (
    <MenuItem disabled={item.disabled} onClick={item.onSelect}>
      <span className="inline-flex shrink-0 items-center [&>svg]:size-3.5">
        <GitActionGlyph name={item.icon} />
      </span>
      <span>{item.label}</span>
    </MenuItem>
  );
}

export default function GitActionsControl({
  gitCwd,
  activeThreadId,
  hideQuickActionLabel: hideQuickActionLabelProp,
  variant: variantProp,
  visibleWhen: visibleWhenProp,
  onRegisterCommitAndPushTrigger,
}: GitActionsControlProps) {
  const { t } = useTranslation();

  const hideQuickActionLabel = hideQuickActionLabelProp ?? false;
  const variant = variantProp ?? "header";
  const visibleWhen = visibleWhenProp ?? "always";
  const isPanel = variant === "panel";
  const createBranchNameFieldId = useId();
  const { settings } = useAppSettings();
  const providerOptions = useMemo(
    () =>
      getProviderStartOptions(
        settings,
        settings.textGenerationProviderInstanceId ?? settings.textGenerationProvider ?? "codex",
      ),
    [settings],
  );
  const gitTextGenerationModelSelection = useMemo(
    (): ModelSelection => ({
      provider: settings.textGenerationProvider ?? "codex",
      instanceId:
        settings.textGenerationProviderInstanceId ?? settings.textGenerationProvider ?? "codex",
      model: settings.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL,
    }),
    [
      settings.textGenerationModel,
      settings.textGenerationProvider,
      settings.textGenerationProviderInstanceId,
    ],
  );
  // Shell-only slice: the full derived Thread gets a new reference on every
  // streamed delta, which re-rendered this always-mounted control per token.
  const activeThread = useStore(
    useMemo(() => createThreadGitActionsMetadataSelector(activeThreadId), [activeThreadId]),
  );
  const setThreadWorkspaceAction = useStore((store) => store.setThreadWorkspace);
  const threadToastData = useMemo(
    () => (activeThreadId ? { threadId: activeThreadId } : undefined),
    [activeThreadId],
  );
  const queryClient = useQueryClient();
  const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);
  const [pendingDefaultBranchAction, setPendingDefaultBranchAction] =
    useState<PendingDefaultBranchAction | null>(null);
  const [isCreateBranchDialogOpen, setIsCreateBranchDialogOpen] = useState(false);
  const [createBranchName, setCreateBranchName] = useState("");
  const [createPrDialog, setCreatePrDialog] = useState<CreatePrDialogState | null>(null);
  const gitActionRuntimeKey = useId();

  const updateActiveProgressToast = useCallback(() => {
    const progress = getActiveGitActionProgress(gitActionRuntimeKey);
    if (!progress) {
      return;
    }
    toastManager.update(progress.toastId, {
      type: "loading",
      title: progress.title,
      description: resolveProgressDescription(progress),
      timeout: 0,
      data: threadToastData,
    });
  }, [gitActionRuntimeKey, threadToastData]);

  const { data: branchListData, isSuccess: branchListReady } = useQuery(
    gitBranchesQueryOptions(gitCwd),
  );
  const branchList = branchListData ?? null;
  // Default to true while loading so we don't flash init controls.
  const isRepo = branchList?.isRepo ?? true;
  const hasOriginRemote = branchList?.hasOriginRemote ?? false;
  const currentBranch = branchList?.branches.find((branch) => branch.current)?.name ?? null;
  // Only poll status after branch discovery confirms a repo — avoids non-repo
  // cwds feeding a permanent "Refreshing git status..." invalidation loop.
  const {
    data: gitStatusData,
    error: gitStatusError,
    isFetching: isGitStatusFetching,
  } = useQuery(gitStatusQueryOptions(gitCwd, branchListReady && branchList?.isRepo === true));
  const gitStatus = gitStatusData ?? null;
  const isGitStatusRefreshDelayed = isGitExpensiveReadCapacityError(gitStatusError);
  const requestGitActionAvailabilityRefresh = useCallback(() => {
    if (!gitCwd) return;
    void refreshGitActionAvailability(queryClient, gitCwd).catch(() => undefined);
  }, [gitCwd, queryClient]);
  const liveThreadBranchUpdate = useMemo(
    () =>
      resolveLiveThreadBranchUpdate({
        threadBranch: currentBranch,
        gitStatus,
      }),
    [currentBranch, gitStatus],
  );
  const isGitStatusOutOfSync = liveThreadBranchUpdate !== null;

  useEffect(() => {
    if (!isGitStatusOutOfSync) return;
    requestGitActionAvailabilityRefresh();
  }, [isGitStatusOutOfSync, requestGitActionAvailabilityRefresh]);

  const gitStatusForActions = isGitStatusOutOfSync ? null : gitStatus;

  const initMutation = useMutation(gitInitMutationOptions({ cwd: gitCwd, queryClient }));

  const runImmediateGitActionMutation = useMutation(
    gitRunStackedActionMutationOptions({
      cwd: gitCwd,
      queryClient,
      codexHomePath: settings.codexHomePath || null,
      model: settings.textGenerationModel ?? null,
      modelSelection: gitTextGenerationModelSelection,
      ...(providerOptions ? { providerOptions } : {}),
    }),
  );
  const pullMutation = useMutation(gitPullMutationOptions({ cwd: gitCwd, queryClient }));
  const mergeLocallyMutation = useMutation(
    gitMergeLocallyMutationOptions({ cwd: gitCwd, queryClient }),
  );
  const mergeFromBaseMutation = useMutation(
    gitMergeFromBaseMutationOptions({ cwd: gitCwd, queryClient }),
  );
  const persistThreadPr = useCallback(
    async (pr: {
      number: number;
      title: string;
      url: string;
      baseBranch: string;
      headBranch: string;
      state: "open" | "closed" | "merged";
      isDraft?: boolean;
      mergeability?: "mergeable" | "conflicting" | "unknown";
      additions?: number | null;
      deletions?: number | null;
      changedFiles?: number | null;
    }) => {
      if (!activeThreadId) {
        return;
      }
      const api = readNativeApi();
      if (!api) {
        return;
      }
      await api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: activeThreadId,
        lastKnownPr: pr,
      });
    },
    [activeThreadId],
  );

  const mutationCache = queryClient.getMutationCache();
  const isRunStackedActionRunning = useSyncExternalStore(
    (onStoreChange) => mutationCache.subscribe(onStoreChange),
    () =>
      mutationCache.findAll({
        mutationKey: gitMutationKeys.runStackedAction(gitCwd),
        status: "pending",
      }).length > 0,
  );
  const isPullRunning = useSyncExternalStore(
    (onStoreChange) => mutationCache.subscribe(onStoreChange),
    () =>
      mutationCache.findAll({
        mutationKey: gitMutationKeys.pull(gitCwd),
        status: "pending",
      }).length > 0,
  );
  const isGitActionRunning = isRunStackedActionRunning || isPullRunning;
  const isDefaultBranch = useMemo(() => {
    const branchName = gitStatusForActions?.branch;
    if (!branchName) return false;
    const current = branchList?.branches.find((branch) => branch.name === branchName);
    return current?.isDefault ?? (branchName === "main" || branchName === "master");
  }, [branchList?.branches, gitStatusForActions?.branch]);
  const defaultBranchName = useMemo(
    () => branchList?.branches.find((branch) => !branch.isRemote && branch.isDefault)?.name ?? null,
    [branchList?.branches],
  );
  const currentBranchName =
    gitStatusForActions?.branch ?? currentBranch ?? activeThread?.branch ?? null;
  const existingBranchNames = useMemo(
    () => (branchList?.branches ?? []).map((branch) => branch.name),
    [branchList?.branches],
  );
  const branchNames = useMemo(
    () => new Set(existingBranchNames.map((branchName) => branchName.toLowerCase())),
    [existingBranchNames],
  );
  const suggestedCreateBranchName = useMemo(
    () =>
      resolveDefaultCreateBranchName(
        existingBranchNames,
        activeThread?.associatedWorktreeBranch ?? activeThread?.title,
      ),
    [activeThread?.associatedWorktreeBranch, activeThread?.title, existingBranchNames],
  );

  const quickAction = resolveQuickAction(
    gitStatusForActions,
    isGitActionRunning,
    isDefaultBranch,
    hasOriginRemote,
    // Neox cannot create a branch in place, so the quick action never offers it.
    false,
    defaultBranchName,
  );
  const gitActionMenuItems = buildMenuItems(
    gitStatusForActions,
    isGitActionRunning,
    hasOriginRemote,
    isDefaultBranch,
    defaultBranchName,
  );
  const quickActionDisabledReason = quickAction.disabled
    ? (quickAction.hint ?? t("git:actionUnavailable"))
    : null;
  const pendingDefaultBranchActionCopy = pendingDefaultBranchAction
    ? resolveDefaultBranchActionDialogCopy({
        action: pendingDefaultBranchAction.action,
        branchName: pendingDefaultBranchAction.branchName,
        includesCommit: pendingDefaultBranchAction.includesCommit,
      })
    : null;
  useEffect(() => {
    const api = readNativeApi();
    if (!api) {
      return;
    }

    const applyProgressEvent = (event: GitActionProgressEvent) => {
      const progress = getActiveGitActionProgress(gitActionRuntimeKey);
      if (!progress) {
        return;
      }
      if (gitCwd && event.cwd !== gitCwd) {
        return;
      }
      if (progress.actionId !== event.actionId) {
        return;
      }

      const now = Date.now();
      switch (event.kind) {
        case "action_started":
          progress.phaseStartedAtMs = now;
          progress.hookStartedAtMs = null;
          progress.hookName = null;
          progress.lastOutputLine = null;
          break;
        case "phase_started":
          progress.phase = event.phase;
          progress.title = event.label;
          progress.currentPhaseLabel = event.label;
          progress.phaseStartedAtMs = now;
          progress.hookStartedAtMs = null;
          progress.hookName = null;
          progress.lastOutputLine = null;
          break;
        case "hook_started":
          progress.title = t("git:runningHook", { hook: event.hookName });
          progress.hookName = event.hookName;
          progress.hookStartedAtMs = now;
          progress.lastOutputLine = null;
          break;
        case "hook_output":
          progress.lastOutputLine = event.text;
          break;
        case "hook_finished":
          progress.title = progress.currentPhaseLabel ?? "Committing...";
          progress.hookName = null;
          progress.hookStartedAtMs = null;
          progress.lastOutputLine = null;
          break;
        case "action_finished":
          // The terminal stream response owns the final toast so success is rendered once.
          // Its server-side status refresh is detached, keeping this event-to-response gap short.
          return;
        case "action_failed":
          progress.failure = event;
          return;
      }

      updateActiveProgressToast();
    };

    return api.git.onActionProgress(applyProgressEvent);
  }, [gitActionRuntimeKey, gitCwd, updateActiveProgressToast]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!getActiveGitActionProgress(gitActionRuntimeKey)) {
        return;
      }
      updateActiveProgressToast();
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [gitActionRuntimeKey, updateActiveProgressToast]);

  const openExistingPr = useCallback(async () => {
    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: t("git:linkOpeningIsUnavailable"),
        data: threadToastData,
      });
      return;
    }
    const prUrl = gitStatusForActions?.pr?.state === "open" ? gitStatusForActions.pr.url : null;
    if (!prUrl) {
      toastManager.add({
        type: "error",
        title: t("git:noOpenPRFound"),
        data: threadToastData,
      });
      return;
    }
    void api.shell.openExternal(prUrl).catch((err) => {
      toastManager.add({
        type: "error",
        title: t("git:toast_unableToOpenPrLink"),
        description: err instanceof Error ? err.message : t("common:proposedPlan_unknownError"),
        data: threadToastData,
      });
    });
  }, [gitStatusForActions, threadToastData, t]);

  // Single entry point for every "Create PR" surface: opens the PR dialog when a
  // PR can be created, opens the existing PR when one is already open, and
  // explains unavailability otherwise.
  const openCreatePrDialog = useCallback(
    (input?: {
      statusOverride?: GitStatusResult | null;
      statusOverrideSource?: GitStatusResult | null;
      isDefaultBranchOverride?: boolean;
    }) => {
      const execution = resolveCreatePrExecution({
        gitStatus: input?.statusOverride ?? gitStatusForActions,
        isBusy: isGitActionRunning,
        isDefaultBranch: input?.isDefaultBranchOverride ?? isDefaultBranch,
        hasOriginRemote,
        defaultBranchName,
      });
      if (execution.kind === "open_pr") {
        void openExistingPr();
        return;
      }
      if (execution.kind === "unavailable") {
        toastManager.add({
          type: "info",
          title: t("git:createPRUnavailable"),
          description: execution.hint,
          data: threadToastData,
        });
        return;
      }
      setCreatePrDialog({
        statusOverride: input?.statusOverride ?? null,
        statusOverrideSource: input?.statusOverrideSource ?? null,
        isDefaultBranchOverride: input?.isDefaultBranchOverride ?? null,
      });
    },
    [
      defaultBranchName,
      gitStatusForActions,
      hasOriginRemote,
      isDefaultBranch,
      isGitActionRunning,
      openExistingPr,
      threadToastData,
      t,
    ],
  );

  const openComparePage = useCallback(
    async (headBranch: string | null, baseBranch: string) => {
      const api = readNativeApi();
      if (!api || !gitCwd || !headBranch) {
        toastManager.add({
          type: "error",
          title: t("git:unableToOpenComparePage2"),
          data: threadToastData,
        });
        return;
      }
      try {
        const repoResult = await api.git.githubRepository({ cwd: gitCwd });
        const repository = repoResult.repository;
        let repoUrl: string | null | undefined = null;
        if (repository) repoUrl = repository.url;
        if (!repoUrl) {
          toastManager.add({
            type: "error",
            title: t("git:unableToOpenComparePage"),
            description: t("git:noGitHubRepositoryDetectedForThisProject"),
            data: threadToastData,
          });
          return;
        }
        await api.shell.openExternal(
          `${repoUrl}/compare/${encodeBranchForCompareUrl(baseBranch)}...${encodeBranchForCompareUrl(headBranch)}?expand=1`,
        );
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("git:unableToOpenComparePage"),
          description:
            error instanceof Error ? error.message : t("common:proposedPlan_unknownError"),
          data: threadToastData,
        });
      }
    },
    [gitCwd, threadToastData, t],
  );

  const runSyncWithRemote = useCallback(() => {
    const promise = pullMutation.mutateAsync();
    toastManager.promise(promise, {
      loading: { title: t("git:syncingWithRemote"), data: threadToastData },
      success: (result) => ({
        title:
          result.status === "pulled" ? t("git:remoteSynced") : t("git:providerUpdates_unchanged"),
        description:
          result.status === "pulled"
            ? t("git:updatedFrom", {
                value0: result.branch,
                value1: result.upstreamBranch ?? t("git:upstream"),
              })
            : t("git:isAlreadySynchronized", { value0: result.branch }),
        data: threadToastData,
      }),
      error: (err) => ({
        title: t("git:syncFailed"),
        description: err instanceof Error ? err.message : t("common:proposedPlan_unknownError"),
        data: threadToastData,
      }),
    });
    void promise.catch(() => undefined);
  }, [pullMutation, threadToastData, t]);

  const runMergeLocally = useCallback(() => {
    const baseRef = defaultBranchName?.trim();
    if (!baseRef) {
      toastManager.add({
        type: "error",
        title: t("git:baseBranchUnavailable"),
        data: threadToastData,
      });
      return;
    }
    const promise = mergeLocallyMutation.mutateAsync({ baseRef });
    toastManager.promise(promise, {
      loading: { title: t("git:mergeLocallyPending"), data: threadToastData },
      success: { title: t("git:mergeLocallySuccess"), data: threadToastData },
      error: (err) => ({
        title: t("git:mergeLocallyFailed"),
        description: err instanceof Error ? err.message : t("common:proposedPlan_unknownError"),
        data: threadToastData,
      }),
    });
    void promise.catch(() => undefined);
  }, [defaultBranchName, mergeLocallyMutation, threadToastData, t]);

  const runMergeFromBase = useCallback(() => {
    const baseRef = defaultBranchName?.trim();
    if (!baseRef) {
      toastManager.add({
        type: "error",
        title: t("git:baseBranchUnavailable"),
        data: threadToastData,
      });
      return;
    }
    const promise = mergeFromBaseMutation.mutateAsync({ baseRef });
    toastManager.promise(promise, {
      loading: {
        title: t("git:updateFromBasePending"),
        data: threadToastData,
      },
      success: {
        title: t("git:updateFromBaseSuccess"),
        description: t("git:updateFromBaseSuccessDescription", { value0: baseRef }),
        data: threadToastData,
      },
      error: (err) => ({
        title: t("git:updateFromBaseFailed", { value0: baseRef }),
        description: err instanceof Error ? err.message : t("common:proposedPlan_unknownError"),
        data: threadToastData,
      }),
    });
    void promise.catch(() => undefined);
  }, [defaultBranchName, mergeFromBaseMutation, threadToastData, t]);

  // The action's own toast offers a follow-up push CTA that re-runs it. The
  // runtime store reaches the same callback instance without the callback
  // referring to its own declaration, which the React Compiler rejects.
  const runGitActionWithToast = useCallback(
    async ({
      action,
      commitMessage,
      forcePushOnlyProgress: forcePushOnlyProgressProp,
      onConfirmed,
      skipDefaultBranchPrompt: skipDefaultBranchPromptProp,
      statusOverride,
      featureBranch: featureBranchProp,
      isDefaultBranchOverride,
      progressToastId,
      filePaths,
      prTitle,
      prBody,
      prDraft,
      allowDirtyWorkingTree,
      afterSuccess,
    }: RunGitActionWithToastInput) => {
      const self = getGitActionRerun(gitActionRuntimeKey);
      const forcePushOnlyProgress = forcePushOnlyProgressProp ?? false;
      const skipDefaultBranchPrompt = skipDefaultBranchPromptProp ?? false;
      const featureBranch = featureBranchProp ?? false;
      const actionStatus = statusOverride ?? gitStatusForActions;
      const actionBranch = actionStatus?.branch ?? null;
      const actionIsDefaultBranch =
        isDefaultBranchOverride ?? (featureBranch ? false : isDefaultBranch);
      const includesCommit =
        !forcePushOnlyProgress &&
        action !== "push" &&
        action !== "create_pr" &&
        (action === "commit" || !!actionStatus?.hasWorkingTreeChanges);
      const shouldPushBeforePr =
        action === "create_pr" &&
        (!actionStatus?.hasUpstream || (actionStatus?.aheadCount ?? 0) > 0);
      if (
        !skipDefaultBranchPrompt &&
        requiresDefaultBranchConfirmation(action, actionIsDefaultBranch) &&
        actionBranch
      ) {
        setPendingDefaultBranchAction({
          action,
          branchName: actionBranch,
          includesCommit,
          ...(commitMessage ? { commitMessage } : {}),
          forcePushOnlyProgress,
          ...(onConfirmed ? { onConfirmed } : {}),
          ...(filePaths ? { filePaths } : {}),
        });
        return;
      }
      if (action === "create_pr" && !featureBranch && !allowDirtyWorkingTree) {
        const createPrAvailability = resolveCreatePrActionAvailability({
          gitStatus: actionStatus,
          isDefaultBranch: actionIsDefaultBranch,
          hasOriginRemote,
          defaultBranchName,
        });
        if (!createPrAvailability.canRun) {
          toastManager.add({
            type: "info",
            title: t("git:createPRUnavailable"),
            description: createPrAvailability.hint ?? t("git:noBranchChangesToIncludeInAPR"),
            data: threadToastData,
          });
          return;
        }
      }
      onConfirmed?.();

      const progressStages = buildGitActionProgressStages({
        action,
        hasCustomCommitMessage: !!commitMessage?.trim(),
        hasWorkingTreeChanges: !!actionStatus?.hasWorkingTreeChanges,
        forcePushOnly: forcePushOnlyProgress,
        featureBranch,
        shouldPushBeforePr,
      });
      const actionId = randomUUID();
      const diagnosticStartedAt = performance.now();
      const resolvedProgressToastId =
        progressToastId ??
        toastManager.add({
          type: "loading",
          title: progressStages[0] ?? t("git:runningGitAction"),
          description: t("git:waitingForGit"),
          timeout: 0,
          data: threadToastData,
        });

      const actionProgress: ActiveGitActionProgress = {
        toastId: resolvedProgressToastId,
        actionId,
        title: progressStages[0] ?? t("git:runningGitAction"),
        phaseStartedAtMs: null,
        hookStartedAtMs: null,
        hookName: null,
        lastOutputLine: null,
        currentPhaseLabel: progressStages[0] ?? t("git:runningGitAction"),
        phase: null,
      };
      setActiveGitActionProgress(gitActionRuntimeKey, actionProgress);

      if (progressToastId) {
        toastManager.update(progressToastId, {
          type: "loading",
          title: progressStages[0] ?? t("git:runningGitAction"),
          description: t("git:waitingForGit"),
          timeout: 0,
          data: threadToastData,
        });
      }

      const promise = runImmediateGitActionMutation.mutateAsync({
        actionId,
        action,
        ...(commitMessage ? { commitMessage } : {}),
        ...(featureBranch ? { featureBranch } : {}),
        ...(filePaths ? { filePaths } : {}),
        ...(prTitle ? { prTitle } : {}),
        ...(prBody ? { prBody } : {}),
        ...(prDraft ? { prDraft } : {}),
        ...(allowDirtyWorkingTree ? { allowDirtyWorkingTree } : {}),
      });

      try {
        const result = await promise;
        clearActiveGitActionProgress(gitActionRuntimeKey, actionProgress);
        const resultToast = summarizeGitResult(result);
        let persistedPr: Parameters<typeof persistThreadPr>[0] | null = null;
        let resultPrCreated = false;
        if (result.pr.status === "created") resultPrCreated = true;
        else if (result.pr.status === "opened_existing") resultPrCreated = true;
        if (resultPrCreated) {
          const pr = result.pr;
          if (pr.number) {
            if (pr.title) {
              if (pr.url) {
                if (pr.baseBranch) {
                  if (pr.headBranch) {
                    persistedPr = {
                      number: pr.number,
                      title: pr.title,
                      url: pr.url,
                      baseBranch: pr.baseBranch,
                      headBranch: pr.headBranch,
                      state: "open" as const,
                    };
                  }
                }
              }
            }
          }
        } else if (actionStatus) {
          const pr = actionStatus.pr;
          if (pr) {
            if (pr.state === "open") persistedPr = pr;
          }
        }
        if (persistedPr) {
          void persistThreadPr(persistedPr).catch(() => undefined);
        }

        const existingOpenPrUrl = resolveExistingOpenPrUrl(actionStatus);
        const prUrl = resolveResultPrUrl(result, existingOpenPrUrl);
        const shouldOfferPushCta = shouldOfferPushCtaFor(action, result);
        const shouldOfferOpenPrCta = shouldOfferOpenPrCtaFor(
          action,
          prUrl,
          actionIsDefaultBranch,
          result,
        );
        const postPushStatus = resolvePostPushStatus(actionStatus, result);
        const shouldOfferCreatePrCta = shouldOfferCreatePrCtaFor(
          action,
          prUrl,
          actionIsDefaultBranch,
          result,
          postPushStatus,
          hasOriginRemote,
          defaultBranchName,
        );
        const closeResultToast = () => {
          toastManager.close(resolvedProgressToastId);
        };

        const successToast = {
          type: "success" as const,
          title: resultToast.title,
          description: resultToast.description,
          timeout: 0,
          data: {
            ...threadToastData,
            dismissAfterVisibleMs: 10_000,
          },
        };
        if (shouldOfferPushCta) {
          toastManager.update(resolvedProgressToastId, {
            ...successToast,
            actionProps: {
              children: t("git:push"),
              onClick: () => {
                if (!self) return;
                void self({
                  action: "push",
                  onConfirmed: closeResultToast,
                  statusOverride: actionStatus,
                  isDefaultBranchOverride: actionIsDefaultBranch,
                });
              },
            },
          });
        } else if (shouldOfferOpenPrCta) {
          toastManager.update(resolvedProgressToastId, {
            ...successToast,
            actionProps: {
              children: t("git:viewPR"),
              onClick: () => {
                const api = readNativeApi();
                if (!api) return;
                if (!prUrl) return;
                closeResultToast();
                void api.shell.openExternal(prUrl);
              },
            },
          });
        } else if (shouldOfferCreatePrCta) {
          toastManager.update(resolvedProgressToastId, {
            ...successToast,
            actionProps: {
              children: t("git:createPR"),
              onClick: () => {
                closeResultToast();
                openCreatePrDialog({
                  statusOverride: postPushStatus,
                  statusOverrideSource: actionStatus,
                  isDefaultBranchOverride: actionIsDefaultBranch,
                });
              },
            },
          });
        } else {
          toastManager.update(resolvedProgressToastId, successToast);
        }
        if (afterSuccess) afterSuccess(result);
      } catch (err) {
        clearActiveGitActionProgress(gitActionRuntimeKey, actionProgress);
        const failureToast = buildGitActionFailureToast({
          message:
            actionProgress.failure?.message ??
            (err instanceof Error ? err.message : t("common:proposedPlan_unknownError")),
          phase: actionProgress.failure?.phase ?? actionProgress.phase,
          threadId: activeThreadId,
        });
        toastManager.update(resolvedProgressToastId, failureToast);
        reportToastIssue(
          resolvedProgressToastId,
          {
            code: `git.${actionProgress.failure?.phase ?? actionProgress.phase ?? "request"}.failed`,
            reason: diagnosticIssueReason(actionProgress.failure?.message ?? err),
            durationMs: performance.now() - diagnosticStartedAt,
          },
          failureToast.data,
        );
      }
    },
    [
      activeThreadId,
      defaultBranchName,
      gitActionRuntimeKey,
      gitStatusForActions,
      hasOriginRemote,
      isDefaultBranch,
      openCreatePrDialog,
      persistThreadPr,
      runImmediateGitActionMutation,
      threadToastData,
      t,
    ],
  );
  useEffect(() => {
    setGitActionRerun(gitActionRuntimeKey, runGitActionWithToast);
  }, [gitActionRuntimeKey, runGitActionWithToast]);
  useEffect(() => {
    return () => disposeGitActionRuntimeState(gitActionRuntimeKey);
  }, [gitActionRuntimeKey]);

  // Pull first; only push once the pull succeeded, so a failed pull never turns into a
  // misleading push error. The push half owns its own progress toast and default-branch prompt.
  const runPullAndPush = useCallback(() => {
    const pullToastId = toastManager.add({
      type: "loading",
      title: t("git:pullAndPush"),
      description: t("git:pullAndPushPulling"),
      timeout: 0,
      data: threadToastData,
    });
    void (async () => {
      try {
        await pullMutation.mutateAsync();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : t("common:proposedPlan_unknownError");
        toastManager.update(pullToastId, {
          type: "error",
          title: t("git:pullAndPushPullFailed"),
          description: /divergent branches|reconcile divergent/i.test(message)
            ? t("git:pullAndPushDiverged")
            : message,
          data: threadToastData,
        });
        return;
      }
      toastManager.close(pullToastId);
      void runGitActionWithToast({ action: "push" });
    })();
  }, [pullMutation, runGitActionWithToast, threadToastData, t]);

  const createPrDialogRuntimeStatus = useMemo(
    () =>
      resolveCreatePrDialogRuntimeStatus({
        liveGitStatus: gitStatusForActions,
        statusOverride: createPrDialog?.statusOverride ?? null,
        statusOverrideSource: createPrDialog?.statusOverrideSource ?? null,
        isDefaultBranch,
        isDefaultBranchOverride: createPrDialog?.isDefaultBranchOverride ?? null,
      }),
    [createPrDialog, gitStatusForActions, isDefaultBranch],
  );

  const handleCreatePrDialogSubmit = useCallback(
    (submission: GitCreatePrDialogSubmission) => {
      setCreatePrDialog(null);
      const actionStatus = createPrDialogRuntimeStatus.gitStatus;
      const actionIsDefaultBranch = createPrDialogRuntimeStatus.isDefaultBranch;
      const excludesDirtyChanges =
        !submission.includeLocalChanges && actionStatus?.hasWorkingTreeChanges === true;
      void runGitActionWithToast({
        action: submission.action,
        ...(createPrDialogRuntimeStatus.statusOverride
          ? { statusOverride: createPrDialogRuntimeStatus.statusOverride }
          : {}),
        isDefaultBranchOverride: actionIsDefaultBranch,
        ...(actionIsDefaultBranch ? { featureBranch: true } : {}),
        skipDefaultBranchPrompt: true,
        ...(submission.title ? { prTitle: submission.title } : {}),
        ...(submission.body ? { prBody: submission.body } : {}),
        ...(submission.draft ? { prDraft: true } : {}),
        ...(excludesDirtyChanges ? { allowDirtyWorkingTree: true } : {}),
      });
    },
    [createPrDialogRuntimeStatus, runGitActionWithToast],
  );

  const handleCreatePrDialogBrowser = useCallback(
    (request: GitCreatePrDialogBrowserRequest) => {
      setCreatePrDialog(null);
      const actionStatus = createPrDialogRuntimeStatus.gitStatus;
      const actionIsDefaultBranch = createPrDialogRuntimeStatus.isDefaultBranch;
      const preparation = request.preparation;
      if (preparation.kind === "open_pr") {
        void openExistingPr();
        return;
      }
      if (preparation.kind === "unavailable") {
        toastManager.add({
          type: "info",
          title: t("git:createPRUnavailable"),
          description: preparation.hint,
          data: threadToastData,
        });
        return;
      }
      if (preparation.kind === "open_compare") {
        void openComparePage(
          actionStatus?.branch ?? null,
          resolveCreatePrBaseBranch(actionStatus, defaultBranchName),
        );
        return;
      }
      const excludesDirtyChanges =
        !request.includeLocalChanges && actionStatus?.hasWorkingTreeChanges === true;
      void runGitActionWithToast({
        action: preparation.action,
        ...(createPrDialogRuntimeStatus.statusOverride
          ? { statusOverride: createPrDialogRuntimeStatus.statusOverride }
          : {}),
        isDefaultBranchOverride: actionIsDefaultBranch,
        ...(actionIsDefaultBranch ? { featureBranch: true } : {}),
        skipDefaultBranchPrompt: true,
        ...(excludesDirtyChanges ? { allowDirtyWorkingTree: true } : {}),
        afterSuccess: (result) => {
          void openComparePage(
            result.push.branch ?? result.branch.name ?? actionStatus?.branch ?? null,
            resolveCreatePrBaseBranch(actionStatus, defaultBranchName),
          );
        },
      });
    },
    [
      createPrDialogRuntimeStatus,
      defaultBranchName,
      openComparePage,
      openExistingPr,
      runGitActionWithToast,
      threadToastData,
      t,
    ],
  );

  const createPrDialogContext = useMemo<GitDialogContext>(
    () => ({
      gitStatus: createPrDialogRuntimeStatus.gitStatus,
      isBusy: isGitActionRunning,
      isDefaultBranch: createPrDialogRuntimeStatus.isDefaultBranch,
      hasOriginRemote,
      defaultBranchName,
    }),
    [createPrDialogRuntimeStatus, defaultBranchName, hasOriginRemote, isGitActionRunning],
  );

  // The Commit dialog always resolves against live status — unlike Create PR it is never
  // opened from a surface carrying a post-push snapshot.
  const commitDialogContext = useMemo<GitDialogContext>(
    () => ({
      gitStatus: gitStatusForActions,
      isBusy: isGitActionRunning,
      isDefaultBranch,
      hasOriginRemote,
      defaultBranchName,
    }),
    [defaultBranchName, gitStatusForActions, hasOriginRemote, isDefaultBranch, isGitActionRunning],
  );

  const continuePendingDefaultBranchAction = useCallback(() => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, forcePushOnlyProgress, onConfirmed, filePaths } =
      pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      forcePushOnlyProgress,
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      ...(requiresFeatureBranchForDefaultBranchAction(action) ? { featureBranch: true } : {}),
      skipDefaultBranchPrompt: true,
    });
  }, [pendingDefaultBranchAction, runGitActionWithToast]);

  const checkoutFeatureBranchAndContinuePendingAction = useCallback(() => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, forcePushOnlyProgress, onConfirmed, filePaths } =
      pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      forcePushOnlyProgress,
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      featureBranch: true,
      skipDefaultBranchPrompt: true,
    });
  }, [pendingDefaultBranchAction, runGitActionWithToast]);

  const handleCommitDialogSubmit = useCallback(
    (submission: GitCommitDialogSubmission) => {
      setIsCommitDialogOpen(false);
      // Create PR owns its own authoring dialog (title/description/draft), so the
      // commit dialog hands off instead of dispatching a PR chain itself.
      if (submission.action === "create_pr") {
        openCreatePrDialog();
        return;
      }
      void runGitActionWithToast({
        action: submission.action,
        ...(submission.message ? { commitMessage: submission.message } : {}),
        ...(submission.filePaths ? { filePaths: submission.filePaths } : {}),
        ...(submission.featureBranch ? { featureBranch: true, skipDefaultBranchPrompt: true } : {}),
      });
    },
    [openCreatePrDialog, runGitActionWithToast],
  );

  const openCreateBranchDialog = useCallback(() => {
    setCreateBranchName(suggestedCreateBranchName);
    setIsCreateBranchDialogOpen(true);
  }, [suggestedCreateBranchName]);

  const runQuickAction = useCallback(() => {
    if (quickAction.kind === "open_pr") {
      void openExistingPr();
      return;
    }
    if (quickAction.kind === "run_pull") {
      runSyncWithRemote();
      return;
    }
    if (quickAction.kind === "create_branch") {
      openCreateBranchDialog();
      return;
    }
    if (quickAction.kind === "show_hint") {
      toastManager.add({
        type: "info",
        title: quickAction.label,
        description: quickAction.hint,
        data: threadToastData,
      });
      return;
    }
    if (quickAction.action) {
      // PR-creating quick actions go through the Create PR dialog so the user
      // can review title/description/draft before the chain runs.
      if (quickAction.action === "create_pr" || quickAction.action === "commit_push_pr") {
        openCreatePrDialog();
        return;
      }
      void runGitActionWithToast({ action: quickAction.action });
    }
  }, [
    openCreateBranchDialog,
    openCreatePrDialog,
    openExistingPr,
    quickAction,
    runGitActionWithToast,
    runSyncWithRemote,
    threadToastData,
  ]);

  const openCommitDialog = useCallback(() => {
    setIsCommitDialogOpen(true);
  }, []);

  const normalizedCurrentBranchName = currentBranchName?.trim().toLowerCase() ?? "";
  const normalizedCreateBranchName = createBranchName.trim().toLowerCase();
  const createBranchNameConflicts =
    normalizedCreateBranchName.length > 0 &&
    normalizedCreateBranchName !== normalizedCurrentBranchName &&
    branchNames.has(normalizedCreateBranchName);

  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const createAndCheckoutBranch = useCallback(
    async (branchName: string) => {
      const api = readNativeApi();
      if (!api || !gitCwd) return;

      const trimmedName = branchName.trim();
      if (!trimmedName) return;

      setIsCreateBranchDialogOpen(false);
      setCreateBranchName("");

      if (trimmedName.toLowerCase() === normalizedCurrentBranchName) {
        if (activeThreadId) {
          void api.orchestration
            .dispatchCommand({
              type: "thread.meta.update",
              commandId: newCommandId(),
              threadId: activeThreadId,
              createBranchFlowCompleted: true,
            })
            .catch(() => {
              setThreadWorkspaceAction(activeThreadId, {
                createBranchFlowCompleted: false,
              });
            });
          setThreadWorkspaceAction(activeThreadId, {
            createBranchFlowCompleted: true,
          });
        }
        toastManager.add({
          type: "success",
          title: t("git:keeping", { value0: trimmedName }),
          description: t("git:branchNameConfirmed"),
          data: threadToastData,
        });
        return;
      }

      const toastId = toastManager.add({
        type: "loading",
        title: t("git:creatingBranch"),
        timeout: 0,
        data: threadToastData,
      });

      try {
        await api.git.createBranch({ cwd: gitCwd, branch: trimmedName, publish: hasOriginRemote });
        await api.git.checkout({ cwd: gitCwd, branch: trimmedName });
        if (activeThreadId) {
          void api.orchestration
            .dispatchCommand({
              type: "thread.meta.update",
              commandId: newCommandId(),
              threadId: activeThreadId,
              branch: trimmedName,
              worktreePath: activeThreadWorktreePath,
              associatedWorktreeBranch: trimmedName,
              associatedWorktreeRef: trimmedName,
              createBranchFlowCompleted: true,
            })
            .catch(() => {
              setThreadWorkspaceAction(activeThreadId, {
                createBranchFlowCompleted: false,
              });
            });
          setThreadWorkspaceAction(activeThreadId, {
            branch: trimmedName,
            associatedWorktreeBranch: trimmedName,
            associatedWorktreeRef: trimmedName,
            createBranchFlowCompleted: true,
          });
        }
        await invalidateGitQueries(queryClient);

        toastManager.update(toastId, {
          type: "success",
          title: t("git:switchedTo", { value0: trimmedName }),
          description: t("git:branchCreatedAndCheckedOut"),
          data: threadToastData,
        });
      } catch (error) {
        toastManager.update(toastId, {
          type: "error",
          title: t("git:failedToCreateBranch"),
          description:
            error instanceof Error ? error.message : t("common:proposedPlan_unknownError"),
          data: threadToastData,
        });
      }
    },
    [
      activeThreadId,
      activeThreadWorktreePath,
      gitCwd,
      hasOriginRemote,
      normalizedCurrentBranchName,
      queryClient,
      setThreadWorkspaceAction,
      threadToastData,
      t,
    ],
  );

  const openDialogForMenuItem = useCallback(
    (item: GitActionMenuItem) => {
      if (item.disabled) return;
      if (item.kind === "open_pr") {
        void openExistingPr();
        return;
      }
      if (item.dialogAction === "push") {
        void runGitActionWithToast({ action: "push" });
        return;
      }
      if (item.dialogAction === "commit_push") {
        void runGitActionWithToast({ action: "commit_push" });
        return;
      }
      if (item.dialogAction === "create_pr") {
        openCreatePrDialog();
        return;
      }
      openCommitDialog();
    },
    [openCommitDialog, openCreatePrDialog, openExistingPr, runGitActionWithToast],
  );

  // Publish the same menu rows to the command palette. The palette then runs this
  // control's dialog flows, so git state is resolved in exactly one place.
  const setGitPaletteCommands = useGitCommandPaletteStore((store) => store.setCommands);
  const clearGitPaletteCommands = useGitCommandPaletteStore((store) => store.clearCommands);
  useEffect(() => {
    if (!activeThreadId || !gitCwd) return;
    // Disabled rows are environment state ("nothing to commit", "no upstream"), not
    // commands. Publishing them would put a dead row in the palette.
    const runnable = gitActionMenuItems.filter((item) => !item.disabled);
    setGitPaletteCommands(
      activeThreadId,
      runnable.map((item) => ({
        id: item.id,
        label: item.label,
        disabled: item.disabled,
        run: () => openDialogForMenuItem(item),
      })),
    );
    return () => clearGitPaletteCommands(activeThreadId);
  }, [
    activeThreadId,
    gitCwd,
    gitActionMenuItems,
    openDialogForMenuItem,
    setGitPaletteCommands,
    clearGitPaletteCommands,
  ]);

  useEffect(() => {
    if (!onRegisterCommitAndPushTrigger) return;
    // Pull-only header instances must not steal the Environment panel's commit &
    // push shortcut registration, including while they are hidden.
    if (visibleWhen === "pull-available") return;
    const target = findRunnableCommitPushMenuItem(gitActionMenuItems);
    if (!target) {
      onRegisterCommitAndPushTrigger(null);
      return;
    }
    onRegisterCommitAndPushTrigger(() => openDialogForMenuItem(target));
    return () => onRegisterCommitAndPushTrigger(null);
  }, [gitActionMenuItems, onRegisterCommitAndPushTrigger, openDialogForMenuItem, visibleWhen]);

  const gitPickerMenuItems = useMemo<GitPickerMenuItem[]>(() => {
    const commitMenuItem = gitActionMenuItems.find((item) => item.id === "commit");
    const commitPushMenuItem = gitActionMenuItems.find((item) => item.id === "commit_push");
    const pushMenuItem = gitActionMenuItems.find((item) => item.id === "push");
    const prMenuItem = gitActionMenuItems.find((item) => item.id === "pr");
    const pullAvailability = resolvePullActionAvailability({
      gitStatus: gitStatusForActions,
      isBusy: isGitActionRunning,
    });
    const pullAndPushAvailability = resolvePullAndPushAvailability({
      gitStatus: gitStatusForActions,
      isBusy: isGitActionRunning,
      hasOriginRemote,
    });

    const mergeLocallyDisabled =
      isGitActionRunning || !gitStatusForActions?.branch || !defaultBranchName || isDefaultBranch;
    return [
      ...(commitMenuItem
        ? [
            {
              id: "commit" as const,
              label: commitMenuItem.label,
              disabled: commitMenuItem.disabled,
              disabledReason: resolveGitMenuActionDisabledReason({
                item: commitMenuItem,
                gitStatus: gitStatusForActions,
                isBusy: isGitActionRunning,
                hasOriginRemote,
                isDefaultBranch,
                defaultBranchName,
              }),
              icon: "commit" as const,
              onSelect: () => openDialogForMenuItem(commitMenuItem),
            },
          ]
        : []),
      ...(commitPushMenuItem
        ? [
            {
              id: "commit_push" as const,
              label: commitPushMenuItem.label,
              disabled: commitPushMenuItem.disabled,
              disabledReason: resolveGitMenuActionDisabledReason({
                item: commitPushMenuItem,
                gitStatus: gitStatusForActions,
                isBusy: isGitActionRunning,
                hasOriginRemote,
                isDefaultBranch,
                defaultBranchName,
              }),
              icon: "push" as const,
              onSelect: () => openDialogForMenuItem(commitPushMenuItem),
            },
          ]
        : []),
      {
        id: "sync" as const,
        label: t("git:pull"),
        disabled: !pullAvailability.canRun,
        disabledReason: pullAvailability.hint,
        icon: "sync" as const,
        onSelect: runSyncWithRemote,
      },
      {
        id: "pull_and_push" as const,
        label: t("git:pullAndPush"),
        disabled: !pullAndPushAvailability.canRun,
        disabledReason: pullAndPushAvailability.reason
          ? pullAndPushUnavailableLabel(pullAndPushAvailability.reason)
          : null,
        icon: "sync" as const,
        onSelect: runPullAndPush,
      },
      ...(pushMenuItem
        ? [
            {
              id: "push" as const,
              label: pushMenuItem.label,
              disabled: pushMenuItem.disabled,
              disabledReason: resolveGitMenuActionDisabledReason({
                item: pushMenuItem,
                gitStatus: gitStatusForActions,
                isBusy: isGitActionRunning,
                hasOriginRemote,
                isDefaultBranch,
                defaultBranchName,
              }),
              icon: "push" as const,
              onSelect: () => openDialogForMenuItem(pushMenuItem),
            },
          ]
        : []),
      ...(prMenuItem
        ? [
            {
              id: "pr" as const,
              label: prMenuItem.label,
              disabled: prMenuItem.disabled,
              disabledReason: resolveGitMenuActionDisabledReason({
                item: prMenuItem,
                gitStatus: gitStatusForActions,
                isBusy: isGitActionRunning,
                hasOriginRemote,
                isDefaultBranch,
                defaultBranchName,
              }),
              icon: (prMenuItem.kind === "open_pr" ? "view_pr" : "pr") as "view_pr" | "pr",
              onSelect: () => openDialogForMenuItem(prMenuItem),
            },
          ]
        : []),
      ...(!isDefaultBranch
        ? [
            {
              id: "merge_locally" as const,
              label: t("git:mergeLocally"),
              disabled: mergeLocallyDisabled,
              disabledReason: mergeLocallyDisabled
                ? isGitActionRunning
                  ? t("git:pullAndPushBusy")
                  : !defaultBranchName
                    ? t("git:baseBranchUnavailable")
                    : t("git:pullAndPushStatusUnavailable")
                : null,
              icon: "branch" as const,
              onSelect: runMergeLocally,
            },
            {
              id: "update_from_base" as const,
              label: t("git:updateFromBase", { value0: defaultBranchName ?? "base" }),
              disabled: mergeLocallyDisabled,
              disabledReason: mergeLocallyDisabled
                ? isGitActionRunning
                  ? t("git:pullAndPushBusy")
                  : !defaultBranchName
                    ? t("git:baseBranchUnavailable")
                    : t("git:pullAndPushStatusUnavailable")
                : null,
              icon: "sync" as const,
              onSelect: runMergeFromBase,
            },
          ]
        : []),
    ];
  }, [
    defaultBranchName,
    gitActionMenuItems,
    gitStatusForActions,
    hasOriginRemote,
    isDefaultBranch,
    isGitActionRunning,
    openDialogForMenuItem,
    runMergeFromBase,
    runMergeLocally,
    runPullAndPush,
    runSyncWithRemote,
    t,
  ]);

  const openChangedFileInEditor = useCallback(
    (filePath: string) => {
      const api = readNativeApi();
      if (!api || !gitCwd) {
        toastManager.add({
          type: "error",
          title: t("git:editorOpeningIsUnavailable"),
          data: threadToastData,
        });
        return;
      }
      const target = resolvePathLinkTarget(filePath, gitCwd);
      void openInPreferredEditor(api, target).catch((error) => {
        toastManager.add({
          type: "error",
          title: t("git:unableToOpenFile"),
          description:
            error instanceof Error ? error.message : t("common:proposedPlan_unknownError"),
          data: threadToastData,
        });
      });
    },
    [gitCwd, threadToastData, t],
  );

  if (!gitCwd) return null;

  const promotedPull = resolvePromotedPullPresentation({
    quickAction,
    isPullRunning,
  });
  const showPromotedPullAction = promotedPull !== null;
  if (visibleWhen === "pull-available") {
    if (!promotedPull) return null;
    // Pull-only chrome: Environment already owns commit/push/PR dialogs, so this
    // instance must not mount a second copy of them beside the panel control.
    if (hideQuickActionLabel) {
      return (
        <ChatHeaderIconButton
          type="button"
          tone="surface"
          label={promotedPull.label}
          title={promotedPull.label}
          disabled={isGitActionRunning}
          onClick={runSyncWithRemote}
        >
          <GitActionGlyph name="sync" />
        </ChatHeaderIconButton>
      );
    }
    return (
      <ChatHeaderButton
        type="button"
        tone="outline"
        className={hideQuickActionLabel ? "gap-1" : "gap-1.5"}
        aria-label={promotedPull.label}
        title={promotedPull.label}
        disabled={isGitActionRunning}
        onClick={runSyncWithRemote}
      >
        <GitActionGlyph name="sync" />
        {!hideQuickActionLabel ? (
          <span className="truncate font-normal">{promotedPull.label}</span>
        ) : null}
      </ChatHeaderButton>
    );
  }

  const runnableCommitPushMenuItem = findRunnableCommitPushMenuItem(gitActionMenuItems);

  // Shared dropdown body — the picker rows plus the contextual git-status warnings.
  // Rendered identically by the header split button and the panel "Commit and Push" row.
  const gitMenuContent = (
    <>
      <MenuGroup>
        <MenuGroupLabel>{t("git:gitActions")}</MenuGroupLabel>
        {gitPickerMenuItems.map((item) => {
          const menuRow = <GitPickerMenuRow item={item} />;
          if (item.disabled && item.disabledReason) {
            return (
              <Popover key={item.id}>
                <PopoverTrigger
                  openOnHover
                  nativeButton={false}
                  render={<span className="block cursor-not-allowed" />}
                >
                  {menuRow}
                </PopoverTrigger>
                <PopoverPopup tooltipStyle side="left" align="center">
                  {item.disabledReason}
                </PopoverPopup>
              </Popover>
            );
          }
          return <GitPickerMenuRow key={item.id} item={item} />;
        })}
      </MenuGroup>
      {(gitStatusForActions?.branch === null ||
        (gitStatusForActions &&
          gitStatusForActions.branch !== null &&
          !gitStatusForActions.hasWorkingTreeChanges &&
          gitStatusForActions.behindCount > 0 &&
          gitStatusForActions.aheadCount === 0) ||
        isGitStatusOutOfSync ||
        gitStatusError) && <MenuSeparator className="mx-3 mt-2" />}
      {gitStatusForActions?.branch === null && (
        <p className="px-3 py-1.5 text-ui leading-snug text-warning">
          {t("git:detachedHEADCreateAndCheckoutABranchToEnable")}
        </p>
      )}
      {gitStatusForActions &&
        gitStatusForActions.branch !== null &&
        !gitStatusForActions.hasWorkingTreeChanges &&
        gitStatusForActions.behindCount > 0 &&
        gitStatusForActions.aheadCount === 0 && (
          <p className="px-3 py-1.5 text-ui leading-snug text-warning">
            {t("git:behindUpstreamPullRebaseFirst")}
          </p>
        )}
      {isGitStatusOutOfSync && (
        <p className="px-3 py-1.5 text-ui leading-snug text-muted-foreground">
          {t("git:refreshingGitStatus")}
        </p>
      )}
      {isGitStatusRefreshDelayed && !isGitStatusOutOfSync && (
        <p className="px-3 py-1.5 text-ui leading-snug text-muted-foreground">
          {isGitStatusFetching ? t("git:refreshingGitStatus") : t("git:gitStatusRefreshDelayed")}
        </p>
      )}
      {gitStatusError && !isGitStatusRefreshDelayed && (
        <p className="px-3 py-1.5 text-ui leading-snug text-destructive">
          {gitStatusError instanceof Error
            ? gitStatusError.message
            : t("git:gitStatusRefreshFailed")}
        </p>
      )}
    </>
  );

  // The git action dialogs are identical across surfaces; only the trigger differs.
  const gitActionDialogs = (
    <>
      <GitCreatePrDialog
        open={createPrDialog !== null}
        onOpenChange={(open) => {
          if (!open) setCreatePrDialog(null);
        }}
        context={createPrDialogContext}
        onSubmit={handleCreatePrDialogSubmit}
        onOpenInBrowser={handleCreatePrDialogBrowser}
      />

      <GitCommitDialog
        open={isCommitDialogOpen}
        onOpenChange={(open) => {
          if (!open) setIsCommitDialogOpen(false);
        }}
        context={commitDialogContext}
        onSubmit={handleCommitDialogSubmit}
        onOpenFile={openChangedFileInEditor}
      />

      <Dialog
        open={pendingDefaultBranchAction !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDefaultBranchAction(null);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {pendingDefaultBranchActionCopy?.title ?? t("git:runActionOnDefaultBranch")}
            </DialogTitle>
            <DialogDescription>{pendingDefaultBranchActionCopy?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              shape="capsule"
              onClick={() => setPendingDefaultBranchAction(null)}
            >
              {t("git:abort")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              shape="capsule"
              onClick={continuePendingDefaultBranchAction}
            >
              {pendingDefaultBranchAction &&
              requiresFeatureBranchForDefaultBranchAction(pendingDefaultBranchAction.action)
                ? t("git:createFeatureBranchContinue")
                : (pendingDefaultBranchActionCopy?.continueLabel ?? t("git:continue"))}
            </Button>
            {pendingDefaultBranchAction &&
            !requiresFeatureBranchForDefaultBranchAction(pendingDefaultBranchAction.action) ? (
              <Button
                size="sm"
                shape="capsule"
                onClick={checkoutFeatureBranchAndContinuePendingAction}
              >
                {t("git:checkoutFeatureBranchContinue")}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={isCreateBranchDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsCreateBranchDialogOpen(false);
            setCreateBranchName("");
          }
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("common:createBranch")}</DialogTitle>
            <DialogDescription>{t("git:createAndSwitchToABranchFromTheCurrent")}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                const trimmedName = createBranchName.trim();
                if (!trimmedName || createBranchNameConflicts) {
                  return;
                }
                void createAndCheckoutBranch(trimmedName);
              }}
            >
              <div className="space-y-1.5">
                <label
                  className="block font-medium text-ui leading-snug"
                  htmlFor={createBranchNameFieldId}
                >
                  {t("common:branchName")}
                </label>
                <Input
                  autoFocus
                  id={createBranchNameFieldId}
                  placeholder={t("common:featureMyChange")}
                  value={createBranchName}
                  onChange={(event) => setCreateBranchName(event.target.value)}
                />
              </div>
              {createBranchNameConflicts ? (
                <p className="text-destructive text-ui leading-snug">
                  {t("common:aBranchWithThisNameAlreadyExists")}
                </p>
              ) : null}
              <DialogFooter variant="bare">
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => {
                    setIsCreateBranchDialogOpen(false);
                    setCreateBranchName("");
                  }}
                >
                  {t("common:form_cancel")}
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={createBranchName.trim().length === 0 || createBranchNameConflicts}
                >
                  {t("common:createBranch")}
                </Button>
              </DialogFooter>
            </form>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );

  if (isPanel) {
    const showPanelPullRow = showPromotedPullAction;
    const panelPrimaryLabel = showPanelPullRow
      ? (promotedPull?.label ?? t("git:pull"))
      : (runnableCommitPushMenuItem?.label ?? t("git:commitAndPush"));
    const panelGitActionsMenu = (
      <Menu
        onOpenChange={(open) => {
          if (open) requestGitActionAvailabilityRefresh();
        }}
      >
        <MenuTrigger
          render={
            <button
              type="button"
              className={cn(
                ENVIRONMENT_ROW_CLASS_NAME,
                showPanelPullRow && "w-auto shrink-0 px-1.5",
              )}
              aria-label={showPanelPullRow ? t("git:gitActionOptions") : panelPrimaryLabel}
              title={t("git:gitActions")}
            />
          }
        >
          {showPanelPullRow ? (
            <EnvironmentRowChevron />
          ) : (
            <EnvironmentRowBody
              icon={<GitActionGlyph name="push" className={ENVIRONMENT_ROW_ICON_CLASS_NAME} />}
              label={panelPrimaryLabel}
              trailing={<EnvironmentRowChevron />}
            />
          )}
        </MenuTrigger>
        <ComposerPickerMenuPopup align="start" side="bottom" className="w-60 min-w-60">
          {gitMenuContent}
        </ComposerPickerMenuPopup>
      </Menu>
    );

    return (
      <>
        {!isRepo ? (
          <EnvironmentRow
            icon={<GitActionGlyph name="branch" className={ENVIRONMENT_ROW_ICON_CLASS_NAME} />}
            label={initMutation.isPending ? t("git:initializing") : t("git:initializeGit")}
            disabled={initMutation.isPending}
            onClick={() => initMutation.mutate()}
          />
        ) : showPanelPullRow ? (
          <div className="flex w-full items-center">
            <button
              type="button"
              className={cn(ENVIRONMENT_ROW_CLASS_NAME, "min-w-0 flex-1")}
              aria-label={panelPrimaryLabel}
              title={panelPrimaryLabel}
              disabled={isGitActionRunning}
              onClick={runSyncWithRemote}
            >
              <EnvironmentRowBody
                icon={<GitActionGlyph name="sync" className={ENVIRONMENT_ROW_ICON_CLASS_NAME} />}
                label={panelPrimaryLabel}
              />
            </button>
            {panelGitActionsMenu}
          </div>
        ) : (
          panelGitActionsMenu
        )}
        {gitActionDialogs}
      </>
    );
  }

  // The diff toolbar's icon-only Git control is a capsule, like the groups around it; the chat
  // header keeps the flat-edged split button.
  const GitSplitGroup = hideQuickActionLabel ? ButtonGroup : ChatHeaderSplitGroup;
  const GitSplitDivider = hideQuickActionLabel ? ButtonGroupSeparator : ChatHeaderSplitDivider;
  const splitVariant = hideQuickActionLabel ? "ghost" : "chrome-outline";
  const splitLeadingClass = hideQuickActionLabel ? undefined : CHAT_HEADER_SPLIT_LEADING_CLASS_NAME;
  const splitTrailingClass = hideQuickActionLabel
    ? undefined
    : CHAT_HEADER_SPLIT_TRAILING_CLASS_NAME;

  return (
    <>
      {!isRepo ? (
        <Button
          variant="chrome-outline"
          size="xs"
          className={cn(CHAT_HEADER_CONTROL_CLASS_NAME, CHAT_HEADER_ICON_STRENGTH_CLASS_NAME)}
          disabled={initMutation.isPending}
          onClick={() => initMutation.mutate()}
        >
          {initMutation.isPending ? t("git:initializing") : t("git:initializeGit")}
        </Button>
      ) : (
        <GitSplitGroup label={t("git:gitActions")}>
          {promotedPull ? (
            <Button
              variant={splitVariant}
              size={hideQuickActionLabel ? "icon-xs" : "xs"}
              className={cn(
                hideQuickActionLabel ? undefined : CHAT_HEADER_CONTROL_CLASS_NAME,
                CHAT_HEADER_ICON_STRENGTH_CLASS_NAME,
                splitLeadingClass,
              )}
              disabled={isGitActionRunning}
              aria-label={promotedPull.label}
              title={promotedPull.label}
              onClick={runSyncWithRemote}
            >
              <GitActionGlyph name="sync" />
              {!hideQuickActionLabel ? (
                <span className="font-normal">{promotedPull.label}</span>
              ) : null}
            </Button>
          ) : quickActionDisabledReason ? (
            <Popover>
              <PopoverTrigger
                openOnHover
                render={
                  <Button
                    aria-label={quickAction.label}
                    aria-disabled="true"
                    className={cn(
                      hideQuickActionLabel ? undefined : CHAT_HEADER_CONTROL_CLASS_NAME,
                      CHAT_HEADER_ICON_STRENGTH_CLASS_NAME,
                      splitLeadingClass,
                      "cursor-not-allowed opacity-64",
                    )}
                    size={hideQuickActionLabel ? "icon-xs" : "xs"}
                    variant={splitVariant}
                    title={quickAction.label}
                  />
                }
              >
                <GitQuickActionIcon quickAction={quickAction} />
                {!hideQuickActionLabel ? (
                  <span className="font-normal">{quickAction.label}</span>
                ) : null}
              </PopoverTrigger>
              <PopoverPopup tooltipStyle side="bottom" align="start">
                {quickActionDisabledReason}
              </PopoverPopup>
            </Popover>
          ) : (
            <Button
              variant={splitVariant}
              size={hideQuickActionLabel ? "icon-xs" : "xs"}
              className={cn(
                hideQuickActionLabel ? undefined : CHAT_HEADER_CONTROL_CLASS_NAME,
                CHAT_HEADER_ICON_STRENGTH_CLASS_NAME,
                splitLeadingClass,
              )}
              disabled={isGitActionRunning || quickAction.disabled}
              aria-label={quickAction.label}
              title={quickAction.label}
              onClick={runQuickAction}
            >
              <GitQuickActionIcon quickAction={quickAction} />
              {!hideQuickActionLabel ? (
                <span className="font-normal">{quickAction.label}</span>
              ) : null}
            </Button>
          )}
          <GitSplitDivider />
          <Menu
            onOpenChange={(open) => {
              if (open) requestGitActionAvailabilityRefresh();
            }}
          >
            <MenuTrigger
              render={
                <Button
                  aria-label={t("git:gitActionOptions")}
                  size="icon-xs"
                  variant={splitVariant}
                  className={cn(
                    hideQuickActionLabel ? undefined : CHAT_HEADER_ICON_CONTROL_CLASS_NAME,
                    CHAT_HEADER_ICON_STRENGTH_CLASS_NAME,
                    splitTrailingClass,
                  )}
                />
              }
              disabled={isGitActionRunning}
            >
              <ChevronDownIcon aria-hidden="true" className="size-3.5" />
            </MenuTrigger>
            <ComposerPickerMenuPopup align="end" side="bottom" className="w-50 min-w-50">
              {gitMenuContent}
            </ComposerPickerMenuPopup>
          </Menu>
        </GitSplitGroup>
      )}

      {gitActionDialogs}
    </>
  );
}
